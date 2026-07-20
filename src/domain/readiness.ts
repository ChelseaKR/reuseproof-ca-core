/** Non-waivable data-coverage preflight derived only from required contracts. */

import { canonicalJson, compareCodeUnits } from './canonical.js';
import {
  evaluateCoverage,
  hashCoverageEvaluationInputSet,
  hashCoverageSummarySet,
  type CoverageEvaluationInput,
  type CoverageRatio,
  type CoverageSummary,
} from './coverage.js';
import { normalizeCoverageSummary } from './coverage-validation.js';
import {
  createRequiredSeriesContract,
  deepFreeze,
  hashRequiredSeriesContract,
  hashRequiredSeriesContractSet,
  type RequiredSeriesContract,
  type TimeRange,
} from './model.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export const REQUIRED_SERIES_THRESHOLD_BASIS_POINTS = 9_500;
export const CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS = 9_000;

export type ReadinessState = 'ready' | 'blocked' | 'not_applicable';

export interface RequiredSeriesReadiness {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly state: ReadinessState;
  readonly acceptedCount: number;
  readonly expectedCount: number;
  readonly thresholdBasisPoints: 9500;
  readonly reasons: readonly 'required_series_below_95_percent'[];
}

export interface AggregateSourceSetCoverage {
  readonly aggregateId: string;
  readonly sourceContractIds: readonly string[];
  readonly state: ReadinessState;
  readonly acceptedSourceIntervalPairs: number;
  readonly expectedSourceIntervalPairs: number;
  readonly thresholdBasisPoints: 9000;
  readonly coverage: CoverageRatio;
  readonly reasons: readonly 'critical_aggregate_below_90_percent'[];
}

export interface CoverageReadinessReport {
  readonly schemaVersion: 'coverage-readiness/v1';
  readonly claim: 'data coverage preflight only';
  readonly governingContractSetHash: string;
  readonly evaluationInputSetHash: string;
  readonly coverageSummarySetHash: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportRange: TimeRange;
  readonly state: ReadinessState;
  readonly requiredSeries: readonly RequiredSeriesReadiness[];
  readonly criticalAggregates: readonly AggregateSourceSetCoverage[];
  readonly limitations: readonly [
    'not a compliance, safety, water-quality, engineering, or filing determination',
  ];
}

export interface CoverageReadinessInput {
  readonly contracts: readonly RequiredSeriesContract[];
  readonly coverageEvaluationInputs: readonly CoverageEvaluationInput[];
  readonly coverageSummaries: readonly CoverageSummary[];
}

function thresholdPasses(numerator: number, denominator: number, basisPoints: number): boolean {
  return BigInt(numerator) * 10_000n >= BigInt(denominator) * BigInt(basisPoints);
}

function addCounts(left: number, right: number, label: string): number {
  const total = left + right;
  /* v8 ignore next -- normalized summaries are backed by dense arrays capped at 200k intervals; retain this defensive invariant for future streaming implementations. */
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${label} exceeds the safe-integer limit`);
  }
  return total;
}

function seriesReadiness(summary: CoverageSummary): RequiredSeriesReadiness {
  if (summary.expectedCount === 0) {
    return deepFreeze({
      contractId: summary.contractId,
      contractVersion: summary.contractVersion,
      state: 'not_applicable',
      acceptedCount: 0,
      expectedCount: 0,
      thresholdBasisPoints: REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
      reasons: [],
    });
  }
  const reasons: RequiredSeriesReadiness['reasons'][number][] = [];
  if (
    !thresholdPasses(
      summary.acceptedCount,
      summary.expectedCount,
      REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
    )
  ) {
    reasons.push('required_series_below_95_percent');
  }
  return deepFreeze({
    contractId: summary.contractId,
    contractVersion: summary.contractVersion,
    state: reasons.length === 0 ? 'ready' : 'blocked',
    acceptedCount: summary.acceptedCount,
    expectedCount: summary.expectedCount,
    thresholdBasisPoints: REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
    reasons,
  });
}

function requiredSummary(
  summaries: ReadonlyMap<string, CoverageSummary>,
  contractId: string,
): CoverageSummary {
  const summary = summaries.get(contractId);
  /* v8 ignore next -- the public boundary proves an exact summary set before aggregate membership is derived from that same contract set. */
  if (summary === undefined) {
    throw new Error(`normalized readiness invariant is missing contract ${contractId}`);
  }
  return summary;
}

function aggregateCoverage(
  aggregateId: string,
  contracts: readonly RequiredSeriesContract[],
  summaries: ReadonlyMap<string, CoverageSummary>,
): AggregateSourceSetCoverage {
  const members = contracts
    .filter(({ aggregateMembership }) => aggregateMembership.includes(aggregateId))
    .sort((left, right) => compareCodeUnits(left.contractId, right.contractId));
  const memberSummaries = members.map((contract) => {
    // Construction already proved exactly one normalized summary per required contract.
    return requiredSummary(summaries, contract.contractId);
  });
  const expectedSourceIntervalPairs = memberSummaries.reduce(
    (total, summary) =>
      addCounts(total, summary.expectedCount, `${aggregateId}.expectedSourceIntervalPairs`),
    0,
  );
  const acceptedSourceIntervalPairs = memberSummaries.reduce(
    (total, summary) =>
      addCounts(total, summary.acceptedCount, `${aggregateId}.acceptedSourceIntervalPairs`),
    0,
  );
  if (expectedSourceIntervalPairs === 0) {
    return deepFreeze({
      aggregateId,
      sourceContractIds: members.map(({ contractId }) => contractId),
      state: 'not_applicable',
      acceptedSourceIntervalPairs: 0,
      expectedSourceIntervalPairs: 0,
      thresholdBasisPoints: CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS,
      coverage: { state: 'not_applicable' },
      reasons: [],
    });
  }
  const reasons: AggregateSourceSetCoverage['reasons'][number][] = [];
  if (
    !thresholdPasses(
      acceptedSourceIntervalPairs,
      expectedSourceIntervalPairs,
      CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS,
    )
  ) {
    reasons.push('critical_aggregate_below_90_percent');
  }
  return deepFreeze({
    aggregateId,
    sourceContractIds: members.map(({ contractId }) => contractId),
    state: reasons.length === 0 ? 'ready' : 'blocked',
    acceptedSourceIntervalPairs,
    expectedSourceIntervalPairs,
    thresholdBasisPoints: CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS,
    coverage: {
      state: 'measured',
      numerator: acceptedSourceIntervalPairs,
      denominator: expectedSourceIntervalPairs,
    },
    reasons,
  });
}

/** Evaluate data completeness only; mappings and attestations are intentionally absent. */
export function evaluateCoverageReadiness(input: CoverageReadinessInput): CoverageReadinessReport {
  const strictInput = requireStrictRecord(
    input,
    ['contracts', 'coverageEvaluationInputs', 'coverageSummaries'],
    [],
    'coverage readiness input',
  );
  const inputContracts = requireStrictArray(
    strictInput.contracts,
    'coverage readiness contracts',
  ).map(createRequiredSeriesContract);
  const inputFirst = inputContracts[0];
  if (inputFirst === undefined) {
    throw new TypeError('coverage readiness requires at least one required-series contract');
  }
  const contracts = [...inputContracts].sort((left, right) =>
    compareCodeUnits(left.contractId, right.contractId),
  );
  const contractIds = contracts.map(({ contractId }) => contractId);
  if (new Set(contractIds).size !== contractIds.length) {
    throw new RangeError('coverage readiness contracts must have unique IDs');
  }

  const summaryByContract = new Map<string, CoverageSummary>();
  const suppliedSummaries = requireStrictArray(
    strictInput.coverageSummaries,
    'coverage readiness summaries',
  ).map(normalizeCoverageSummary);
  for (const summary of suppliedSummaries) {
    if (summaryByContract.has(summary.contractId)) {
      throw new RangeError('coverage readiness summaries must have unique contract IDs');
    }
    summaryByContract.set(summary.contractId, summary);
  }
  if (summaryByContract.size !== contracts.length) {
    throw new RangeError('coverage readiness requires exactly one summary per required contract');
  }

  const recomputedByContract = new Map<string, CoverageSummary>();
  const evaluationValues = requireStrictArray(
    strictInput.coverageEvaluationInputs,
    'coverage readiness evaluations',
  );
  for (const evaluation of evaluationValues) {
    const recomputed = evaluateCoverage(evaluation as CoverageEvaluationInput);
    if (recomputedByContract.has(recomputed.contractId)) {
      throw new RangeError('coverage readiness evaluations must have unique contract IDs');
    }
    recomputedByContract.set(recomputed.contractId, recomputed);
  }
  if (recomputedByContract.size !== contracts.length) {
    throw new RangeError(
      'coverage readiness requires exactly one evaluation per required contract',
    );
  }

  const first = inputFirst;
  const firstSummary = summaryByContract.get(first.contractId);
  if (firstSummary === undefined) {
    throw new RangeError(`coverage readiness is missing contract ${first.contractId}`);
  }
  const verifiedEvaluations = contracts.map((contract) => {
    const summary = summaryByContract.get(contract.contractId);
    if (summary === undefined) {
      throw new RangeError(`coverage readiness is missing contract ${contract.contractId}`);
    }
    if (
      summary.contractVersion !== contract.version ||
      summary.tenantId !== contract.tenantId ||
      summary.systemId !== contract.systemId
    ) {
      throw new RangeError(`coverage summary ${summary.contractId} does not match its contract`);
    }
    const governingContractHash = hashRequiredSeriesContract(contract);
    if (summary.governingContractHash !== governingContractHash) {
      throw new RangeError(
        `coverage summary ${summary.contractId} does not match its governing contract content`,
      );
    }
    const recomputed = recomputedByContract.get(contract.contractId);
    if (recomputed === undefined) {
      throw new RangeError(`coverage readiness is missing evaluation ${contract.contractId}`);
    }
    if (recomputed.governingContractHash !== governingContractHash) {
      throw new RangeError(
        `coverage evaluation ${contract.contractId} does not match its governing contract content`,
      );
    }
    if (contract.tenantId !== first.tenantId || contract.systemId !== first.systemId) {
      throw new RangeError('coverage readiness contracts must share one tenant and system');
    }
    return { summary, recomputed };
  });
  const summaries = verifiedEvaluations.map(({ summary }) => summary);
  const reportRange = firstSummary.reportRange;
  const reportTimeBasis = firstSummary.reportTimeBasis;
  for (const summary of summaries) {
    if (
      summary.reportRange.start !== reportRange.start ||
      summary.reportRange.end !== reportRange.end ||
      canonicalJson(summary.reportTimeBasis) !== canonicalJson(reportTimeBasis)
    ) {
      throw new RangeError('coverage readiness summaries must share one report time basis');
    }
  }
  for (const { summary, recomputed } of verifiedEvaluations) {
    if (canonicalJson(recomputed) !== canonicalJson(summary)) {
      throw new RangeError(
        `coverage summary ${summary.contractId} does not match its exact evaluation input`,
      );
    }
  }
  const requiredSeries = summaries.map(seriesReadiness);
  const criticalAggregateIds = [
    ...new Set(
      contracts
        .filter(({ criticality }) => criticality === 'report_critical')
        .flatMap(({ aggregateMembership }) => aggregateMembership),
    ),
  ].sort(compareCodeUnits);
  const criticalAggregates = criticalAggregateIds.map((aggregateId) =>
    aggregateCoverage(aggregateId, contracts, summaryByContract),
  );
  const allGates = [...requiredSeries, ...criticalAggregates];
  const state: ReadinessState = allGates.some((gate) => gate.state === 'blocked')
    ? 'blocked'
    : allGates.every((gate) => gate.state === 'not_applicable')
      ? 'not_applicable'
      : 'ready';
  return deepFreeze({
    schemaVersion: 'coverage-readiness/v1',
    claim: 'data coverage preflight only',
    governingContractSetHash: hashRequiredSeriesContractSet(contracts),
    evaluationInputSetHash: hashCoverageEvaluationInputSet(summaries),
    coverageSummarySetHash: hashCoverageSummarySet(summaries),
    tenantId: first.tenantId,
    systemId: first.systemId,
    reportRange: deepFreeze({ ...reportRange }),
    state,
    requiredSeries,
    criticalAggregates,
    limitations: ['not a compliance, safety, water-quality, engineering, or filing determination'],
  });
}
