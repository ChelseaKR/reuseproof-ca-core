/** Strict runtime reconstruction for deterministic coverage-summary boundaries. */

import { canonicalJson, compareCodeUnits } from './canonical.js';
import type {
  CoverageOutcome,
  CoverageRatio,
  CoverageSummary,
  ExcludedInterval,
  ExpectedInterval,
  LifecycleExcludedInterval,
} from './coverage.js';
import type { LifecycleBasis } from './lifecycle.js';
import { createTimeRange, lifecycleStates, type TimeRange } from './model.js';
import { createReportTimeBasis } from './time.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

function requireSafeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  return requireStrictArray(value, label);
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function addCounts(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${label} exceeds the safe-integer limit`);
  }
  return total;
}

function requireNullableSafeText(value: unknown, label: string): string | null {
  return value === null ? null : requireSafeText(value, label);
}

function requireLifecycleState(value: unknown, label: string) {
  if (typeof value !== 'string' || !(lifecycleStates as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a supported lifecycle state`);
  }
  return value as (typeof lifecycleStates)[number];
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function normalizeExpectedInterval(value: unknown, label: string): ExpectedInterval {
  const record = requireStrictRecord(
    value,
    ['intervalId', 'start', 'end', 'lifecycleState', 'lifecycleEventId', 'lifecycleEvidenceId'],
    [],
    label,
  );
  const range = createTimeRange({ start: record.start, end: record.end }, label);
  const intervalId = requireSafeText(record.intervalId, `${label}.intervalId`);
  if (intervalId !== `${range.start}/${range.end}`) {
    throw new RangeError(`${label}.intervalId must match its exact half-open range`);
  }
  return {
    intervalId,
    start: range.start,
    end: range.end,
    lifecycleState: requireLifecycleState(record.lifecycleState, `${label}.lifecycleState`),
    lifecycleEventId: requireNullableSafeText(record.lifecycleEventId, `${label}.lifecycleEventId`),
    lifecycleEvidenceId: requireNullableSafeText(
      record.lifecycleEvidenceId,
      `${label}.lifecycleEvidenceId`,
    ),
  };
}

function normalizeExcludedInterval(value: unknown, label: string): ExcludedInterval {
  const record = requireStrictRecord(
    value,
    [
      'intervalId',
      'start',
      'end',
      'lifecycleState',
      'lifecycleEventId',
      'lifecycleEvidenceId',
      'nonoperationId',
      'evidenceId',
    ],
    [],
    label,
  );
  const base = normalizeExpectedInterval(
    {
      intervalId: record.intervalId,
      start: record.start,
      end: record.end,
      lifecycleState: record.lifecycleState,
      lifecycleEventId: record.lifecycleEventId,
      lifecycleEvidenceId: record.lifecycleEvidenceId,
    },
    label,
  );
  return {
    ...base,
    nonoperationId: requireSafeText(record.nonoperationId, `${label}.nonoperationId`),
    evidenceId: requireSafeText(record.evidenceId, `${label}.evidenceId`),
  };
}

function normalizeLifecycleExcludedInterval(
  value: unknown,
  label: string,
): LifecycleExcludedInterval {
  const record = requireStrictRecord(
    value,
    [
      'intervalId',
      'start',
      'end',
      'lifecycleState',
      'lifecycleEventId',
      'lifecycleEvidenceId',
      'reason',
    ],
    [],
    label,
  );
  if (record.reason !== 'lifecycle_state_ineligible') {
    throw new TypeError(`${label}.reason must be lifecycle_state_ineligible`);
  }
  const base = normalizeExpectedInterval(
    {
      intervalId: record.intervalId,
      start: record.start,
      end: record.end,
      lifecycleState: record.lifecycleState,
      lifecycleEventId: record.lifecycleEventId,
      lifecycleEvidenceId: record.lifecycleEvidenceId,
    },
    label,
  );
  return { ...base, reason: 'lifecycle_state_ineligible' };
}

function compareIntervals(left: ExpectedInterval, right: ExpectedInterval): number {
  return (
    compareCodeUnits(left.start, right.start) ||
    compareCodeUnits(left.end, right.end) ||
    compareCodeUnits(left.intervalId, right.intervalId)
  );
}

function requireSortedUniqueIntervals(intervals: readonly ExpectedInterval[], label: string): void {
  const ids = intervals.map(({ intervalId }) => intervalId);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError(`${label} interval IDs must be unique`);
  }
  if (canonicalJson(intervals) !== canonicalJson([...intervals].sort(compareIntervals))) {
    throw new RangeError(`${label} intervals must use deterministic range order`);
  }
}

function requireValidIntervalPartition(
  expectedIntervals: readonly ExpectedInterval[],
  excludedIntervals: readonly ExcludedInterval[],
  lifecycleExcludedIntervals: readonly LifecycleExcludedInterval[],
  reportRange: TimeRange,
  lifecycleBasis: LifecycleBasis,
  label: string,
): void {
  const intervals = [
    ...expectedIntervals,
    ...excludedIntervals,
    ...lifecycleExcludedIntervals,
  ].sort(compareIntervals);
  const lifecycleEventBindings = new Map<
    string,
    { readonly state: ExpectedInterval['lifecycleState']; readonly evidenceId: string }
  >();
  const closedLifecycleEventIds = new Set<string>();
  let previousLifecycleEventId: string | undefined;
  let previous: ExpectedInterval | undefined;
  for (const interval of intervals) {
    if (
      compareCodeUnits(interval.start, reportRange.start) < 0 ||
      compareCodeUnits(interval.end, reportRange.end) > 0
    ) {
      throw new RangeError(`${label} interval falls outside the report range`);
    }
    if (previous !== undefined && compareCodeUnits(previous.end, interval.start) > 0) {
      throw new RangeError(`${label} interval classifications cannot overlap`);
    }
    if (previous !== undefined && previous.end !== interval.start) {
      throw new RangeError(`${label} interval classifications must form one contiguous partition`);
    }
    if (lifecycleBasis.kind === 'resolved_state') {
      if (
        interval.lifecycleState !== lifecycleBasis.state ||
        interval.lifecycleEventId !== null ||
        interval.lifecycleEvidenceId !== null
      ) {
        throw new RangeError(`${label} interval does not match its resolved lifecycle basis`);
      }
    } else {
      const eventId = interval.lifecycleEventId;
      const evidenceId = interval.lifecycleEvidenceId;
      if (eventId === null || evidenceId === null) {
        throw new RangeError(`${label} timeline interval requires lifecycle provenance`);
      }
      const existingBinding = lifecycleEventBindings.get(eventId);
      if (
        existingBinding !== undefined &&
        (existingBinding.state !== interval.lifecycleState ||
          existingBinding.evidenceId !== evidenceId)
      ) {
        throw new RangeError(
          `${label} lifecycle event ID must map to one state and evidence reference`,
        );
      }
      lifecycleEventBindings.set(eventId, { state: interval.lifecycleState, evidenceId });
      if (previousLifecycleEventId !== undefined && previousLifecycleEventId !== eventId) {
        closedLifecycleEventIds.add(previousLifecycleEventId);
      }
      if (closedLifecycleEventIds.has(eventId)) {
        throw new RangeError(`${label} lifecycle event intervals must be contiguous`);
      }
      previousLifecycleEventId = eventId;
    }
    previous = interval;
  }
}

function normalizeCoverageRatio(value: unknown, label: string): CoverageRatio {
  const record = requireStrictRecord(value, ['state'], ['numerator', 'denominator'], label);
  if (record.state === 'not_applicable') {
    requireStrictRecord(record, ['state'], [], label);
    return { state: 'not_applicable' };
  }
  if (record.state !== 'measured') {
    throw new TypeError(`${label}.state must be measured or not_applicable`);
  }
  requireStrictRecord(record, ['state', 'numerator', 'denominator'], [], label);
  return {
    state: 'measured',
    numerator: requireCount(record.numerator, `${label}.numerator`),
    denominator: requireCount(record.denominator, `${label}.denominator`),
  };
}

function normalizeLifecycleBasis(value: unknown, label: string): LifecycleBasis {
  const record = requireStrictRecord(value, ['kind'], ['state', 'timelineVersion'], label);
  if (record.kind === 'resolved_state') {
    requireStrictRecord(record, ['kind', 'state'], [], label);
    return {
      kind: 'resolved_state',
      state: requireLifecycleState(record.state, `${label}.state`),
    };
  }
  if (record.kind !== 'effective_timeline') {
    throw new TypeError(`${label}.kind must be resolved_state or effective_timeline`);
  }
  requireStrictRecord(record, ['kind', 'timelineVersion'], [], label);
  return {
    kind: 'effective_timeline',
    timelineVersion: requireSafeText(record.timelineVersion, `${label}.timelineVersion`),
  };
}

const duplicateReasons = [
  'extra_accepted_observation',
  'replayed_fingerprint',
  'superseded',
] as const;
const quarantineReasons = [
  'ambiguous_timestamp',
  'conflicting_duplicate',
  'impossible_unit',
  'malformed_value',
  'unmapped_value',
  'contract_mismatch',
  'outside_expected_range',
] as const;
const excludedReasons = [
  'authorized_scheduled_nonoperation',
  'lifecycle_state_ineligible',
] as const;

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${label} is not supported`);
  }
  return value as T;
}

function normalizeCoverageOutcome(value: unknown, label: string): CoverageOutcome {
  const base = requireStrictRecord(
    value,
    ['kind'],
    ['intervalId', 'observationId', 'sourceFingerprint', 'reason'],
    label,
  );
  switch (base.kind) {
    case 'accepted': {
      const record = requireStrictRecord(
        base,
        ['kind', 'intervalId', 'observationId', 'sourceFingerprint'],
        [],
        label,
      );
      return {
        kind: 'accepted',
        intervalId: requireSafeText(record.intervalId, `${label}.intervalId`),
        observationId: requireSafeText(record.observationId, `${label}.observationId`),
        sourceFingerprint: requireSafeText(record.sourceFingerprint, `${label}.sourceFingerprint`),
      };
    }
    case 'duplicate': {
      const record = requireStrictRecord(
        base,
        ['kind', 'intervalId', 'observationId', 'reason'],
        [],
        label,
      );
      return {
        kind: 'duplicate',
        intervalId: requireSafeText(record.intervalId, `${label}.intervalId`),
        observationId: requireSafeText(record.observationId, `${label}.observationId`),
        reason: requireEnum(record.reason, duplicateReasons, `${label}.reason`),
      };
    }
    case 'quarantine': {
      const record = requireStrictRecord(base, ['kind', 'observationId', 'reason'], [], label);
      return {
        kind: 'quarantine',
        observationId: requireSafeText(record.observationId, `${label}.observationId`),
        reason: requireEnum(record.reason, quarantineReasons, `${label}.reason`),
      };
    }
    case 'gap': {
      const record = requireStrictRecord(base, ['kind', 'intervalId', 'reason'], [], label);
      if (record.reason !== 'no_final_accepted_observation') {
        throw new TypeError(`${label}.reason must be no_final_accepted_observation`);
      }
      return {
        kind: 'gap',
        intervalId: requireSafeText(record.intervalId, `${label}.intervalId`),
        reason: 'no_final_accepted_observation',
      };
    }
    case 'excluded': {
      const record = requireStrictRecord(
        base,
        ['kind', 'intervalId', 'observationId', 'reason'],
        [],
        label,
      );
      return {
        kind: 'excluded',
        intervalId: requireSafeText(record.intervalId, `${label}.intervalId`),
        observationId: requireSafeText(record.observationId, `${label}.observationId`),
        reason: requireEnum(record.reason, excludedReasons, `${label}.reason`),
      };
    }
    default:
      throw new TypeError(`${label}.kind is not supported`);
  }
}

function compareCoverageOutcomes(left: CoverageOutcome, right: CoverageOutcome): number {
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

export function normalizeCoverageSummary(value: unknown, index: number): CoverageSummary {
  const label = `coverageSummaries[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'contractId',
      'contractVersion',
      'governingContractHash',
      'evaluationInputHash',
      'tenantId',
      'systemId',
      'reportRange',
      'reportTimeBasis',
      'lifecycleBasis',
      'expectedIntervals',
      'excludedIntervals',
      'lifecycleExcludedIntervals',
      'expectedCount',
      'acceptedCount',
      'gapCount',
      'duplicateCount',
      'quarantineCount',
      'coverage',
      'outcomes',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'coverage-summary/v2') {
    throw new TypeError(`${label}.schemaVersion must be coverage-summary/v2`);
  }
  const reportRange = createTimeRange(record.reportRange, `${label}.reportRange`);
  const reportTimeBasis = createReportTimeBasis(record.reportTimeBasis);
  if (
    reportTimeBasis.kind === 'civil' &&
    (reportTimeBasis.start.resolvedAt !== reportRange.start ||
      reportTimeBasis.end.resolvedAt !== reportRange.end)
  ) {
    throw new RangeError(`${label}.reportTimeBasis does not match its report range`);
  }
  const expectedIntervals = requireArray(
    record.expectedIntervals,
    `${label}.expectedIntervals`,
  ).map((interval, intervalIndex) =>
    normalizeExpectedInterval(interval, `${label}.expectedIntervals[${intervalIndex.toString()}]`),
  );
  const excludedIntervals = requireArray(
    record.excludedIntervals,
    `${label}.excludedIntervals`,
  ).map((interval, intervalIndex) =>
    normalizeExcludedInterval(interval, `${label}.excludedIntervals[${intervalIndex.toString()}]`),
  );
  const lifecycleExcludedIntervals = requireArray(
    record.lifecycleExcludedIntervals,
    `${label}.lifecycleExcludedIntervals`,
  ).map((interval, intervalIndex) =>
    normalizeLifecycleExcludedInterval(
      interval,
      `${label}.lifecycleExcludedIntervals[${intervalIndex.toString()}]`,
    ),
  );
  requireSortedUniqueIntervals(expectedIntervals, `${label}.expectedIntervals`);
  requireSortedUniqueIntervals(excludedIntervals, `${label}.excludedIntervals`);
  requireSortedUniqueIntervals(lifecycleExcludedIntervals, `${label}.lifecycleExcludedIntervals`);
  const lifecycleBasis = normalizeLifecycleBasis(record.lifecycleBasis, `${label}.lifecycleBasis`);
  const allIntervalIds = [
    ...expectedIntervals,
    ...excludedIntervals,
    ...lifecycleExcludedIntervals,
  ].map(({ intervalId }) => intervalId);
  if (new Set(allIntervalIds).size !== allIntervalIds.length) {
    throw new RangeError(`${label} interval classifications must be disjoint`);
  }
  requireValidIntervalPartition(
    expectedIntervals,
    excludedIntervals,
    lifecycleExcludedIntervals,
    reportRange,
    lifecycleBasis,
    label,
  );
  const outcomes = requireArray(record.outcomes, `${label}.outcomes`).map((outcome, outcomeIndex) =>
    normalizeCoverageOutcome(outcome, `${label}.outcomes[${outcomeIndex.toString()}]`),
  );
  if (canonicalJson(outcomes) !== canonicalJson([...outcomes].sort(compareCoverageOutcomes))) {
    throw new RangeError(`${label}.outcomes must use deterministic order`);
  }
  const observationIds = outcomes.flatMap((outcome) =>
    'observationId' in outcome ? [outcome.observationId] : [],
  );
  if (new Set(observationIds).size !== observationIds.length) {
    throw new RangeError(`${label}.outcomes must route each observation exactly once`);
  }
  const expectedIds = new Set(expectedIntervals.map(({ intervalId }) => intervalId));
  const excludedIds = new Set(excludedIntervals.map(({ intervalId }) => intervalId));
  const lifecycleExcludedIds = new Set(
    lifecycleExcludedIntervals.map(({ intervalId }) => intervalId),
  );
  const candidateIds = new Set(allIntervalIds);
  const terminalCounts = new Map<string, number>();
  const acceptedIntervalIds = new Set<string>();
  const acceptedFingerprints = new Set<string>();
  for (const outcome of outcomes) {
    if ('intervalId' in outcome && !candidateIds.has(outcome.intervalId)) {
      throw new RangeError(`${label}.outcomes reference an unknown interval`);
    }
    if (outcome.kind === 'accepted' || outcome.kind === 'gap') {
      if (!expectedIds.has(outcome.intervalId)) {
        throw new RangeError(
          `${label}.outcomes place an accepted/gap result outside the denominator`,
        );
      }
      terminalCounts.set(outcome.intervalId, (terminalCounts.get(outcome.intervalId) ?? 0) + 1);
    }
    if (outcome.kind === 'accepted') {
      acceptedIntervalIds.add(outcome.intervalId);
      if (acceptedFingerprints.has(outcome.sourceFingerprint)) {
        throw new RangeError(`${label}.outcomes cannot accept a replayed source fingerprint`);
      }
      acceptedFingerprints.add(outcome.sourceFingerprint);
    }
    if (
      outcome.kind === 'excluded' &&
      ((outcome.reason === 'authorized_scheduled_nonoperation' &&
        !excludedIds.has(outcome.intervalId)) ||
        (outcome.reason === 'lifecycle_state_ineligible' &&
          !lifecycleExcludedIds.has(outcome.intervalId)))
    ) {
      throw new RangeError(`${label}.outcomes exclusion reason does not match its interval class`);
    }
  }
  if (expectedIntervals.some(({ intervalId }) => terminalCounts.get(intervalId) !== 1)) {
    throw new RangeError(
      `${label}.outcomes require exactly one accepted or gap result per interval`,
    );
  }
  if (
    outcomes.some(
      (outcome) =>
        outcome.kind === 'duplicate' &&
        outcome.reason === 'extra_accepted_observation' &&
        !acceptedIntervalIds.has(outcome.intervalId),
    )
  ) {
    throw new RangeError(
      `${label}.outcomes extra accepted observations require an accepted interval winner`,
    );
  }
  const expectedCount = requireCount(record.expectedCount, `${label}.expectedCount`);
  const acceptedCount = requireCount(record.acceptedCount, `${label}.acceptedCount`);
  const gapCount = requireCount(record.gapCount, `${label}.gapCount`);
  const duplicateCount = requireCount(record.duplicateCount, `${label}.duplicateCount`);
  const quarantineCount = requireCount(record.quarantineCount, `${label}.quarantineCount`);
  const acceptedOutcomes = outcomes.filter(({ kind }) => kind === 'accepted').length;
  const gapOutcomes = outcomes.filter(({ kind }) => kind === 'gap').length;
  const duplicateOutcomes = outcomes.filter(({ kind }) => kind === 'duplicate').length;
  const quarantineOutcomes = outcomes.filter(({ kind }) => kind === 'quarantine').length;
  if (
    expectedIntervals.length !== expectedCount ||
    acceptedOutcomes !== acceptedCount ||
    gapOutcomes !== gapCount ||
    duplicateOutcomes !== duplicateCount ||
    quarantineOutcomes !== quarantineCount ||
    addCounts(acceptedCount, gapCount, `${label}.acceptedCount + gapCount`) !== expectedCount
  ) {
    throw new RangeError(`${label} has inconsistent coverage accounting`);
  }
  const coverage = normalizeCoverageRatio(record.coverage, `${label}.coverage`);
  if (
    (expectedCount === 0 && coverage.state !== 'not_applicable') ||
    (expectedCount > 0 &&
      (coverage.state !== 'measured' ||
        coverage.numerator !== acceptedCount ||
        coverage.denominator !== expectedCount))
  ) {
    throw new RangeError(`${label} has an inconsistent ratio`);
  }
  return {
    schemaVersion: 'coverage-summary/v2',
    contractId: requireSafeText(record.contractId, `${label}.contractId`),
    contractVersion: requireSafeText(record.contractVersion, `${label}.contractVersion`),
    governingContractHash: requireDigest(
      record.governingContractHash,
      `${label}.governingContractHash`,
    ),
    evaluationInputHash: requireDigest(record.evaluationInputHash, `${label}.evaluationInputHash`),
    tenantId: requireSafeText(record.tenantId, `${label}.tenantId`),
    systemId: requireSafeText(record.systemId, `${label}.systemId`),
    reportRange,
    reportTimeBasis,
    lifecycleBasis,
    expectedIntervals,
    excludedIntervals,
    lifecycleExcludedIntervals,
    expectedCount,
    acceptedCount,
    gapCount,
    duplicateCount,
    quarantineCount,
    coverage,
    outcomes,
  };
}
