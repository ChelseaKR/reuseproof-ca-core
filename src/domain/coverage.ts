/** Deterministic half-open denominator and observation-routing engine. */

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import { normalizeCoverageSummary } from './coverage-validation.js';
import {
  createLifecycleTimeline,
  type LifecycleBasis,
  type LifecycleTimeline,
} from './lifecycle.js';
import {
  createObservation,
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  deepFreeze,
  hashRequiredSeriesContract,
  instantMilliseconds,
  lifecycleStates,
  type LifecycleState,
  type Observation,
  type QuarantineReason,
  type RequiredSeriesContract,
  type ScheduledNonoperation,
  type TimeRange,
} from './model.js';
import { createReportTimeBasis, type ReportTimeBasis } from './time.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export interface ExpectedInterval extends TimeRange {
  readonly intervalId: string;
  readonly lifecycleState: LifecycleState;
  readonly lifecycleEventId: string | null;
  readonly lifecycleEvidenceId: string | null;
}

export interface ExcludedInterval extends ExpectedInterval {
  readonly nonoperationId: string;
  readonly evidenceId: string;
}

export interface LifecycleExcludedInterval extends ExpectedInterval {
  readonly reason: 'lifecycle_state_ineligible';
}

export type CoverageOutcome =
  | {
      readonly kind: 'accepted';
      readonly intervalId: string;
      readonly observationId: string;
      readonly sourceFingerprint: string;
    }
  | {
      readonly kind: 'duplicate';
      readonly intervalId: string;
      readonly observationId: string;
      readonly reason: 'extra_accepted_observation' | 'replayed_fingerprint' | 'superseded';
    }
  | {
      readonly kind: 'quarantine';
      readonly observationId: string;
      readonly reason: QuarantineReason | 'contract_mismatch' | 'outside_expected_range';
    }
  | {
      readonly kind: 'gap';
      readonly intervalId: string;
      readonly reason: 'no_final_accepted_observation';
    }
  | {
      readonly kind: 'excluded';
      readonly intervalId: string;
      readonly observationId: string;
      readonly reason: 'authorized_scheduled_nonoperation' | 'lifecycle_state_ineligible';
    };

export type CoverageRatio =
  | { readonly state: 'not_applicable' }
  | { readonly state: 'measured'; readonly numerator: number; readonly denominator: number };

export interface CoverageSummary {
  readonly schemaVersion: 'coverage-summary/v2';
  readonly contractId: string;
  readonly contractVersion: string;
  readonly governingContractHash: string;
  readonly evaluationInputHash: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly lifecycleBasis: LifecycleBasis;
  readonly expectedIntervals: readonly ExpectedInterval[];
  readonly excludedIntervals: readonly ExcludedInterval[];
  readonly lifecycleExcludedIntervals: readonly LifecycleExcludedInterval[];
  readonly expectedCount: number;
  readonly acceptedCount: number;
  readonly gapCount: number;
  readonly duplicateCount: number;
  readonly quarantineCount: number;
  readonly coverage: CoverageRatio;
  readonly outcomes: readonly CoverageOutcome[];
}

interface CoverageEvaluationBase {
  readonly contract: RequiredSeriesContract;
  readonly reportRange: TimeRange;
  readonly reportTimeBasis?: ReportTimeBasis;
  readonly observations: readonly Observation[];
  readonly scheduledNonoperations: readonly ScheduledNonoperation[];
}

export type CoverageEvaluationInput = CoverageEvaluationBase &
  (
    | {
        readonly lifecycleState: LifecycleState;
        readonly lifecycleTimeline?: never;
      }
    | {
        readonly lifecycleTimeline: LifecycleTimeline;
        readonly lifecycleState?: never;
      }
  );

type NormalizedCoverageEvaluationInput = CoverageEvaluationInput & {
  readonly reportTimeBasis: ReportTimeBasis;
};

/** Bound the current in-memory evaluator until interval streaming is implemented. */
export const MAX_EXPECTED_INTERVALS = 200_000;

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function intervalId(start: number, end: number): string {
  return `${iso(start)}/${iso(end)}`;
}

interface CadenceInterval extends TimeRange {
  readonly intervalId: string;
}

interface CoverageIntervals {
  readonly expected: readonly ExpectedInterval[];
  readonly lifecycleExcluded: readonly LifecycleExcludedInterval[];
  readonly lifecycleBasis: LifecycleBasis;
}

function compareObservations(left: Observation, right: Observation): number {
  return (
    compareCodeUnits(left.observedAt, right.observedAt) ||
    compareCodeUnits(left.sourceFingerprint, right.sourceFingerprint) ||
    compareCodeUnits(left.observationId, right.observationId)
  );
}

function compareOutcomes(left: CoverageOutcome, right: CoverageOutcome): number {
  const leftInterval = 'intervalId' in left ? left.intervalId : '';
  const rightInterval = 'intervalId' in right ? right.intervalId : '';
  const leftObservation = 'observationId' in left ? left.observationId : '';
  const rightObservation = 'observationId' in right ? right.observationId : '';
  return (
    compareCodeUnits(leftInterval, rightInterval) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(leftObservation, rightObservation)
  );
}

function normalizeCoverageEvaluationInput(value: unknown): NormalizedCoverageEvaluationInput {
  const label = 'coverage evaluation input';
  const record = requireStrictRecord(
    value,
    ['contract', 'reportRange', 'observations', 'scheduledNonoperations'],
    ['reportTimeBasis', 'lifecycleState', 'lifecycleTimeline'],
    label,
  );
  const hasLifecycleState = Object.hasOwn(record, 'lifecycleState');
  const hasLifecycleTimeline = Object.hasOwn(record, 'lifecycleTimeline');
  if (hasLifecycleState === hasLifecycleTimeline) {
    throw new TypeError(`${label} requires exactly one lifecycle state or timeline`);
  }
  const contract = createRequiredSeriesContract(record.contract);
  const reportRange = createTimeRange(record.reportRange, 'coverage.reportRange');
  const reportTimeBasis = createReportTimeBasis(
    Object.hasOwn(record, 'reportTimeBasis') ? record.reportTimeBasis : { kind: 'utc' },
  );
  const observations = requireStrictArray(record.observations, `${label}.observations`).map(
    createObservation,
  );
  const scheduledNonoperations = requireStrictArray(
    record.scheduledNonoperations,
    `${label}.scheduledNonoperations`,
  ).map(createScheduledNonoperation);
  const base = {
    contract,
    reportRange,
    reportTimeBasis,
    observations,
    scheduledNonoperations,
  };
  if (hasLifecycleTimeline) {
    return deepFreeze({
      ...base,
      lifecycleTimeline: createLifecycleTimeline(record.lifecycleTimeline),
    });
  }
  if (
    typeof record.lifecycleState !== 'string' ||
    !(lifecycleStates as readonly string[]).includes(record.lifecycleState)
  ) {
    throw new TypeError('lifecycle state must be supported');
  }
  return deepFreeze({
    ...base,
    lifecycleState: record.lifecycleState as LifecycleState,
  });
}

function hashCoverageEvaluationInput(
  input: CoverageEvaluationInput,
  reportRange: TimeRange,
  reportTimeBasis: ReportTimeBasis,
): string {
  const lifecycle = Object.hasOwn(input, 'lifecycleTimeline')
    ? { kind: 'effective_timeline' as const, timeline: input.lifecycleTimeline }
    : { kind: 'resolved_state' as const, state: input.lifecycleState };
  return sha256(
    canonicalJson({
      schemaVersion: 'coverage-evaluation-input-binding/v1',
      contract: input.contract,
      reportRange,
      reportTimeBasis,
      lifecycle,
      observations: [...input.observations].sort(compareObservations),
      scheduledNonoperations: [...input.scheduledNonoperations].sort((left, right) =>
        compareCodeUnits(left.nonoperationId, right.nonoperationId),
      ),
    }),
  );
}

function normalizeCoverageSummarySet(value: unknown): readonly CoverageSummary[] {
  const normalized = requireStrictArray(value, 'coverage summary set').map(
    normalizeCoverageSummary,
  );
  const keys = normalized.map(
    ({ contractId, contractVersion }) => `${contractId}\u0000${contractVersion}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new RangeError('coverage summary set contract/version pairs must be unique');
  }
  return normalized.sort(
    (left, right) =>
      compareCodeUnits(left.contractId, right.contractId) ||
      compareCodeUnits(left.contractVersion, right.contractVersion),
  );
}

/** Content-address complete strictly reconstructed summaries independently of caller ordering. */
export function hashCoverageSummarySet(summaries: readonly CoverageSummary[]): string {
  const ordered = normalizeCoverageSummarySet(summaries);
  return sha256(
    canonicalJson({
      schemaVersion: 'coverage-summary-set-binding/v1',
      summaries: ordered,
    }),
  );
}

/** Content-address the exact normalized inputs that produced a summary set. */
export function hashCoverageEvaluationInputSet(summaries: readonly CoverageSummary[]): string {
  const evaluations = normalizeCoverageSummarySet(summaries).map(
    ({ contractId, contractVersion, governingContractHash, evaluationInputHash }) => ({
      contractId,
      contractVersion,
      governingContractHash,
      evaluationInputHash,
    }),
  );
  return sha256(
    canonicalJson({
      schemaVersion: 'coverage-evaluation-input-set-binding/v1',
      evaluations,
    }),
  );
}

function buildCadenceIntervals(
  contract: RequiredSeriesContract,
  reportRange: TimeRange,
): readonly CadenceInterval[] {
  const validatedReportRange = createTimeRange(reportRange, 'reportRange');
  const start = Math.max(
    instantMilliseconds(contract.effectiveRange.start),
    instantMilliseconds(validatedReportRange.start),
  );
  const end = Math.min(
    instantMilliseconds(contract.effectiveRange.end),
    instantMilliseconds(validatedReportRange.end),
  );
  if (start >= end) {
    return deepFreeze([]);
  }
  const cadenceMilliseconds = contract.cadenceMinutes * 60_000;
  const intervalCount = Math.ceil((end - start) / cadenceMilliseconds);
  if (!Number.isSafeInteger(intervalCount) || intervalCount > MAX_EXPECTED_INTERVALS) {
    throw new RangeError(
      `coverage evaluation exceeds the ${MAX_EXPECTED_INTERVALS.toString()}-interval safety limit`,
    );
  }
  const intervals: CadenceInterval[] = [];
  for (let cursor = start; cursor < end; cursor += cadenceMilliseconds) {
    const intervalEnd = Math.min(cursor + cadenceMilliseconds, end);
    intervals.push({
      intervalId: intervalId(cursor, intervalEnd),
      start: iso(cursor),
      end: iso(intervalEnd),
    });
  }
  return deepFreeze(intervals);
}

/** Tile the half-open intersection for an already resolved lifecycle state. */
export function buildExpectedIntervals(
  contract: RequiredSeriesContract,
  reportRange: TimeRange,
  lifecycleState: LifecycleState,
): readonly ExpectedInterval[] {
  const normalizedContract = createRequiredSeriesContract(contract);
  const normalizedReportRange = createTimeRange(reportRange, 'reportRange');
  if (!(lifecycleStates as readonly string[]).includes(lifecycleState)) {
    throw new TypeError('lifecycle state must be supported');
  }
  if (!normalizedContract.eligibleLifecycleStates.includes(lifecycleState)) {
    return deepFreeze([]);
  }
  return deepFreeze(
    buildCadenceIntervals(normalizedContract, normalizedReportRange).map((interval) => ({
      ...interval,
      lifecycleState,
      lifecycleEventId: null,
      lifecycleEvidenceId: null,
    })),
  );
}

function buildTimelineIntervals(
  contract: RequiredSeriesContract,
  reportRange: TimeRange,
  timeline: LifecycleTimeline,
): CoverageIntervals {
  if (timeline.tenantId !== contract.tenantId || timeline.systemId !== contract.systemId) {
    throw new RangeError('lifecycle timeline scope does not match required-series contract');
  }
  const expected: ExpectedInterval[] = [];
  const lifecycleExcluded: LifecycleExcludedInterval[] = [];
  const cadenceIntervals = buildCadenceIntervals(contract, reportRange);
  let periodIndex = 0;
  let segmentCount = 0;
  for (const cadenceInterval of cadenceIntervals) {
    const cadenceStart = instantMilliseconds(cadenceInterval.start);
    const cadenceEnd = instantMilliseconds(cadenceInterval.end);
    let candidate = timeline.periods[periodIndex];
    while (
      candidate !== undefined &&
      instantMilliseconds(candidate.effectiveRange.end) <= cadenceStart
    ) {
      periodIndex += 1;
      candidate = timeline.periods[periodIndex];
    }
    let cursor = cadenceStart;
    while (cursor < cadenceEnd) {
      const period = timeline.periods[periodIndex];
      if (
        period === undefined ||
        instantMilliseconds(period.effectiveRange.start) > cursor ||
        instantMilliseconds(period.effectiveRange.end) <= cursor
      ) {
        throw new RangeError(
          `lifecycle timeline does not cover ${intervalId(cursor, cadenceEnd)}; denominator evaluation stopped`,
        );
      }
      const end = Math.min(cadenceEnd, instantMilliseconds(period.effectiveRange.end));
      segmentCount += 1;
      if (segmentCount > MAX_EXPECTED_INTERVALS) {
        throw new RangeError(
          `coverage evaluation exceeds the ${MAX_EXPECTED_INTERVALS.toString()}-interval safety limit after lifecycle boundaries`,
        );
      }
      const interval: ExpectedInterval = {
        intervalId: intervalId(cursor, end),
        start: iso(cursor),
        end: iso(end),
        lifecycleState: period.state,
        lifecycleEventId: period.lifecycleEventId,
        lifecycleEvidenceId: period.evidenceId,
      };
      if (contract.eligibleLifecycleStates.includes(period.state)) {
        expected.push(interval);
      } else {
        lifecycleExcluded.push({ ...interval, reason: 'lifecycle_state_ineligible' });
      }
      cursor = end;
      if (cursor >= instantMilliseconds(period.effectiveRange.end)) {
        periodIndex += 1;
      }
    }
  }
  return deepFreeze({
    expected,
    lifecycleExcluded,
    lifecycleBasis: {
      kind: 'effective_timeline',
      timelineVersion: timeline.version,
    },
  });
}

function buildCoverageIntervals(
  input: CoverageEvaluationInput,
  reportRange: TimeRange,
): CoverageIntervals {
  if (Object.hasOwn(input, 'lifecycleTimeline')) {
    const lifecycleTimeline = input.lifecycleTimeline;
    if (lifecycleTimeline === undefined) {
      throw new TypeError('coverage evaluation lifecycle timeline must be present');
    }
    return buildTimelineIntervals(input.contract, reportRange, lifecycleTimeline);
  }
  const lifecycleState = input.lifecycleState;
  if (
    lifecycleState === undefined ||
    !(lifecycleStates as readonly string[]).includes(lifecycleState)
  ) {
    throw new TypeError('lifecycle state must be supported');
  }
  const intervals = buildCadenceIntervals(input.contract, reportRange).map((interval) => ({
    ...interval,
    lifecycleState,
    lifecycleEventId: null,
    lifecycleEvidenceId: null,
  }));
  const basis: LifecycleBasis = {
    kind: 'resolved_state',
    state: lifecycleState,
  };
  if (input.contract.eligibleLifecycleStates.includes(lifecycleState)) {
    return deepFreeze({ expected: intervals, lifecycleExcluded: [], lifecycleBasis: basis });
  }
  return deepFreeze({
    expected: [],
    lifecycleExcluded: intervals.map((interval) => ({
      ...interval,
      reason: 'lifecycle_state_ineligible' as const,
    })),
    lifecycleBasis: basis,
  });
}

/** A scheduled nonoperation with its bounds parsed once, in `nonoperationId` order. */
interface IndexedNonoperation {
  readonly nonoperation: ScheduledNonoperation;
  readonly authorizedAt: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Sort and parse the nonoperation list once for the whole evaluation.
 *
 * `applicableNonoperation` used to copy and re-sort this list, and re-parse three RFC 3339 strings
 * per candidate, once per expected interval. The order is `nonoperationId` either way, so the
 * selected nonoperation is unchanged (#42).
 */
function indexNonoperations(
  nonoperations: readonly ScheduledNonoperation[],
): readonly IndexedNonoperation[] {
  return [...nonoperations]
    .sort((left, right) => compareCodeUnits(left.nonoperationId, right.nonoperationId))
    .map((nonoperation) => ({
      nonoperation,
      authorizedAt: instantMilliseconds(nonoperation.authorizedAt),
      start: instantMilliseconds(nonoperation.range.start),
      end: instantMilliseconds(nonoperation.range.end),
    }));
}

function applicableNonoperation(
  contractId: string,
  interval: ExpectedInterval,
  nonoperations: readonly IndexedNonoperation[],
): ScheduledNonoperation | undefined {
  const intervalStart = instantMilliseconds(interval.start);
  const intervalEnd = instantMilliseconds(interval.end);
  return nonoperations.find(
    (candidate) =>
      candidate.nonoperation.contractId === contractId &&
      candidate.authorizedAt <= intervalStart &&
      candidate.start <= intervalStart &&
      candidate.end >= intervalEnd,
  )?.nonoperation;
}

/**
 * The candidate intervals with their bounds parsed once, for binary search.
 *
 * Resolving an observation to its interval was a linear scan of the whole interval list, run once
 * per observation, with `instantMilliseconds` re-parsing both bounds of every interval it rejected
 * — an ISO regex, a `Date.parse` and a `toISOString` round-trip each time. That made the join
 * O(observations x intervals): 8,000 observations against 8,000 intervals took 72 seconds, and
 * `MAX_EXPECTED_INTERVALS` permits 200,000 (#42).
 *
 * `starts` and `ends` are typed arrays so the search reads plain numbers with no per-element
 * undefined check to widen the branch surface.
 */
interface IntervalIndex {
  readonly intervals: readonly ExpectedInterval[];
  readonly starts: Float64Array;
  readonly ends: Float64Array;
}

function indexIntervals(intervals: readonly ExpectedInterval[]): IntervalIndex {
  const starts = new Float64Array(intervals.length);
  const ends = new Float64Array(intervals.length);
  let position = 0;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    const start = instantMilliseconds(interval.start);
    // The binary search below relies on this: the coverage intervals tile their range, so sorted
    // by start they are also disjoint and ascending, and at most one can contain a given instant.
    // Both builders produce that shape — `buildCadenceIntervals` walks a cursor forward, and
    // `buildTimelineIntervals` only subdivides those cadence intervals at lifecycle boundaries —
    // so this cannot fire today. It is checked rather than assumed because a future builder that
    // broke the invariant would otherwise silently change which interval an observation lands in.
    /* v8 ignore next 3 -- unreachable: coverage intervals tile their range and cannot overlap. */
    if (start < previousEnd) {
      throw new RangeError('coverage intervals must not overlap');
    }
    const end = instantMilliseconds(interval.end);
    starts[position] = start;
    ends[position] = end;
    previousEnd = end;
    position += 1;
  }
  return { intervals, starts, ends };
}

/**
 * Read one parsed bound out of the parallel arrays.
 *
 * `noUncheckedIndexedAccess` widens every indexed read to `| undefined`, and the binary search
 * below only ever forms in-range indices. `Number` keeps that widening out of the search without
 * adding a guard that no input could take — an unreachable guard would sit in the branch coverage
 * floor asserting nothing.
 */
function boundAt(series: Float64Array, position: number): number {
  return Number(series[position]);
}

function containingInterval(
  observedAt: string,
  index: IntervalIndex,
): ExpectedInterval | undefined {
  const instant = instantMilliseconds(observedAt);
  // The last interval starting at or before `instant` is the only one that can contain it.
  let low = 0;
  let high = index.starts.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (boundAt(index.starts, middle) <= instant) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (match < 0 || instant >= boundAt(index.ends, match)) {
    return undefined;
  }
  return index.intervals[match];
}

/** Evaluate exactly one required series without consulting its vendor mapping. */
export function evaluateCoverage(input: CoverageEvaluationInput): CoverageSummary {
  const evaluation = normalizeCoverageEvaluationInput(input);
  const observationIds = evaluation.observations.map(({ observationId }) => observationId);
  if (new Set(observationIds).size !== observationIds.length) {
    throw new RangeError('observation IDs must be unique within a required series evaluation');
  }
  const nonoperationIds = evaluation.scheduledNonoperations.map(
    ({ nonoperationId }) => nonoperationId,
  );
  if (new Set(nonoperationIds).size !== nonoperationIds.length) {
    throw new RangeError('scheduled nonoperation IDs must be unique');
  }
  const reportRange = evaluation.reportRange;
  const reportTimeBasis = evaluation.reportTimeBasis;
  if (reportTimeBasis.kind === 'civil') {
    if (reportTimeBasis.timeZone !== evaluation.contract.timezone) {
      throw new RangeError('civil report time zone does not match required-series contract');
    }
    if (
      reportTimeBasis.start.resolvedAt !== reportRange.start ||
      reportTimeBasis.end.resolvedAt !== reportRange.end
    ) {
      throw new RangeError('civil report time basis does not match resolved report range');
    }
  }
  const coverageIntervals = buildCoverageIntervals(evaluation, reportRange);
  const lifecycleExcludedById = new Map(
    coverageIntervals.lifecycleExcluded.map((interval) => [interval.intervalId, interval]),
  );
  const excludedById = new Map<string, ExcludedInterval>();
  const expectedIntervals: ExpectedInterval[] = [];
  // Sorted and parsed once, not once per expected interval (#42).
  const indexedNonoperations = indexNonoperations(evaluation.scheduledNonoperations);
  for (const interval of coverageIntervals.expected) {
    const nonoperation = applicableNonoperation(
      evaluation.contract.contractId,
      interval,
      indexedNonoperations,
    );
    if (nonoperation === undefined) {
      expectedIntervals.push(interval);
    } else {
      excludedById.set(interval.intervalId, {
        ...interval,
        nonoperationId: nonoperation.nonoperationId,
        evidenceId: nonoperation.evidenceId,
      });
    }
  }
  const candidateIntervals = indexIntervals(
    [...coverageIntervals.expected, ...coverageIntervals.lifecycleExcluded].sort((left, right) =>
      compareCodeUnits(left.start, right.start),
    ),
  );

  const finalAcceptedByInterval = new Map<string, Observation[]>();
  const seenFinalFingerprints = new Set<string>();
  const outcomes: CoverageOutcome[] = [];
  for (const observation of [...evaluation.observations].sort(compareObservations)) {
    if (observation.contractId !== evaluation.contract.contractId) {
      outcomes.push({
        kind: 'quarantine',
        observationId: observation.observationId,
        reason: 'contract_mismatch',
      });
      continue;
    }
    if (observation.qualityState === 'quarantined') {
      outcomes.push({
        kind: 'quarantine',
        observationId: observation.observationId,
        reason: observation.quarantineReason,
      });
      continue;
    }
    const interval = containingInterval(observation.observedAt, candidateIntervals);
    if (interval === undefined) {
      outcomes.push({
        kind: 'quarantine',
        observationId: observation.observationId,
        reason: 'outside_expected_range',
      });
      continue;
    }
    if (observation.supersededBy !== undefined) {
      outcomes.push({
        kind: 'duplicate',
        intervalId: interval.intervalId,
        observationId: observation.observationId,
        reason: 'superseded',
      });
      continue;
    }
    if (seenFinalFingerprints.has(observation.sourceFingerprint)) {
      outcomes.push({
        kind: 'duplicate',
        intervalId: interval.intervalId,
        observationId: observation.observationId,
        reason: 'replayed_fingerprint',
      });
      continue;
    }
    seenFinalFingerprints.add(observation.sourceFingerprint);
    if (lifecycleExcludedById.has(interval.intervalId)) {
      outcomes.push({
        kind: 'excluded',
        intervalId: interval.intervalId,
        observationId: observation.observationId,
        reason: 'lifecycle_state_ineligible',
      });
      continue;
    }
    if (excludedById.has(interval.intervalId)) {
      outcomes.push({
        kind: 'excluded',
        intervalId: interval.intervalId,
        observationId: observation.observationId,
        reason: 'authorized_scheduled_nonoperation',
      });
      continue;
    }
    const observations = finalAcceptedByInterval.get(interval.intervalId) ?? [];
    observations.push(observation);
    finalAcceptedByInterval.set(interval.intervalId, observations);
  }

  let acceptedCount = 0;
  let gapCount = 0;
  for (const interval of expectedIntervals) {
    const accepted = (finalAcceptedByInterval.get(interval.intervalId) ?? []).sort(
      compareObservations,
    );
    const winner = accepted[0];
    if (winner === undefined) {
      gapCount += 1;
      outcomes.push({
        kind: 'gap',
        intervalId: interval.intervalId,
        reason: 'no_final_accepted_observation',
      });
      continue;
    }
    acceptedCount += 1;
    outcomes.push({
      kind: 'accepted',
      intervalId: interval.intervalId,
      observationId: winner.observationId,
      sourceFingerprint: winner.sourceFingerprint,
    });
    for (const duplicate of accepted.slice(1)) {
      outcomes.push({
        kind: 'duplicate',
        intervalId: interval.intervalId,
        observationId: duplicate.observationId,
        reason: 'extra_accepted_observation',
      });
    }
  }

  const expectedCount = expectedIntervals.length;
  const sortedOutcomes = outcomes.sort(compareOutcomes);
  const summary: CoverageSummary = {
    schemaVersion: 'coverage-summary/v2',
    contractId: evaluation.contract.contractId,
    contractVersion: evaluation.contract.version,
    governingContractHash: hashRequiredSeriesContract(evaluation.contract),
    evaluationInputHash: hashCoverageEvaluationInput(evaluation, reportRange, reportTimeBasis),
    tenantId: evaluation.contract.tenantId,
    systemId: evaluation.contract.systemId,
    reportRange,
    reportTimeBasis,
    lifecycleBasis: coverageIntervals.lifecycleBasis,
    expectedIntervals: deepFreeze(expectedIntervals),
    excludedIntervals: deepFreeze([...excludedById.values()]),
    lifecycleExcludedIntervals: coverageIntervals.lifecycleExcluded,
    expectedCount,
    acceptedCount,
    gapCount,
    duplicateCount: sortedOutcomes.filter(({ kind }) => kind === 'duplicate').length,
    quarantineCount: sortedOutcomes.filter(({ kind }) => kind === 'quarantine').length,
    coverage:
      expectedCount === 0
        ? { state: 'not_applicable' }
        : { state: 'measured', numerator: acceptedCount, denominator: expectedCount },
    outcomes: sortedOutcomes,
  };
  return deepFreeze(summary);
}
