/** Runtime reconstruction for the exact report-safe content projection. */

import { canonicalJson, compareCodeUnits } from './domain/canonical.js';
import type { CoverageRatio } from './domain/coverage.js';
import { createTimeRange, deepFreeze } from './domain/model.js';
import type {
  AggregateSourceSetCoverage,
  CoverageReadinessReport,
  ReadinessState,
  RequiredSeriesReadiness,
} from './domain/readiness.js';
import { createReportTimeBasis } from './domain/time.js';
import {
  requireIanaTimeZone,
  requireStrictArray,
  requireStrictRecord,
} from './domain/validation.js';
import type {
  ReportContentProjection,
  ReportRequiredSeries,
  ReportSeriesMetadata,
} from './report-render.js';

const RECEIPT_CLAIM_VALUE = 'evidence assembled' as const;
const ARTIFACT_STATUS_VALUE = 'Draft—not submitted; human review required' as const;
const REPORT_LIMITATION_VALUE =
  'not a compliance, safety, water-quality, engineering, laboratory-quality, legal-sufficiency, regulatory-filing, or approval determination' as const;
const READINESS_LIMITATION_VALUE =
  'not a compliance, safety, water-quality, engineering, or filing determination' as const;

function requireSafeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
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

function requireReadinessState(value: unknown, label: string): ReadinessState {
  if (value !== 'ready' && value !== 'blocked' && value !== 'not_applicable') {
    throw new TypeError(`${label} must be ready, blocked, or not_applicable`);
  }
  return value;
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
  const measured = requireStrictRecord(record, ['state', 'numerator', 'denominator'], [], label);
  const denominator = requireCount(measured.denominator, `${label}.denominator`);
  if (denominator === 0) {
    throw new RangeError(`${label}.denominator must be positive when measured`);
  }
  return {
    state: 'measured',
    numerator: requireCount(measured.numerator, `${label}.numerator`),
    denominator,
  };
}

function normalizeSingleton<const Value extends string>(
  value: unknown,
  expected: Value,
  label: string,
): readonly [Value] {
  const values = requireStrictArray(value, label);
  if (values.length !== 1 || values[0] !== expected) {
    throw new TypeError(`${label} must contain exactly the required limitation`);
  }
  return [expected];
}

function normalizeSortedUniqueTexts(
  value: unknown,
  label: string,
  allowEmpty = true,
): readonly string[] {
  const values = requireStrictArray(value, label).map((item, index) =>
    requireSafeText(item, `${label}[${index.toString()}]`),
  );
  if (!allowEmpty && values.length === 0) {
    throw new RangeError(`${label} cannot be empty`);
  }
  const sorted = [...values].sort(compareCodeUnits);
  if (new Set(values).size !== values.length || canonicalJson(values) !== canonicalJson(sorted)) {
    throw new RangeError(`${label} must be unique and deterministically sorted`);
  }
  return values;
}

function normalizeSeriesMetadata(value: unknown, index: number): ReportSeriesMetadata {
  const label = `reportContent.seriesMetadata[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    [
      'contractId',
      'contractVersion',
      'governingContractHash',
      'processCode',
      'parameterCode',
      'statistic',
      'canonicalUnit',
      'sourceTimeZone',
      'criticality',
      'aggregateMembership',
    ],
    [],
    label,
  );
  if (record.criticality !== 'required' && record.criticality !== 'report_critical') {
    throw new TypeError(`${label}.criticality must be required or report_critical`);
  }
  return {
    contractId: requireSafeText(record.contractId, `${label}.contractId`),
    contractVersion: requireSafeText(record.contractVersion, `${label}.contractVersion`),
    governingContractHash: requireDigest(
      record.governingContractHash,
      `${label}.governingContractHash`,
    ),
    processCode: requireSafeText(record.processCode, `${label}.processCode`),
    parameterCode: requireSafeText(record.parameterCode, `${label}.parameterCode`),
    statistic: requireSafeText(record.statistic, `${label}.statistic`),
    canonicalUnit: requireSafeText(record.canonicalUnit, `${label}.canonicalUnit`),
    sourceTimeZone: requireIanaTimeZone(record.sourceTimeZone, `${label}.sourceTimeZone`),
    criticality: record.criticality,
    aggregateMembership: normalizeSortedUniqueTexts(
      record.aggregateMembership,
      `${label}.aggregateMembership`,
    ),
  };
}

function normalizeRequiredSeries(value: unknown, index: number): ReportRequiredSeries {
  const label = `reportContent.requiredSeries[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    [
      'contractId',
      'contractVersion',
      'governingContractHash',
      'reportTimeBasis',
      'expectedCount',
      'acceptedCount',
      'gapCount',
      'duplicateCount',
      'quarantineCount',
      'coverage',
    ],
    [],
    label,
  );
  const expectedCount = requireCount(record.expectedCount, `${label}.expectedCount`);
  const acceptedCount = requireCount(record.acceptedCount, `${label}.acceptedCount`);
  const gapCount = requireCount(record.gapCount, `${label}.gapCount`);
  const coverage = normalizeCoverageRatio(record.coverage, `${label}.coverage`);
  if (
    addCounts(acceptedCount, gapCount, `${label}.acceptedCount + gapCount`) !== expectedCount ||
    (expectedCount === 0 && coverage.state !== 'not_applicable') ||
    (expectedCount > 0 &&
      (coverage.state !== 'measured' ||
        coverage.numerator !== acceptedCount ||
        coverage.denominator !== expectedCount))
  ) {
    throw new RangeError(`${label} has inconsistent coverage accounting`);
  }
  return {
    contractId: requireSafeText(record.contractId, `${label}.contractId`),
    contractVersion: requireSafeText(record.contractVersion, `${label}.contractVersion`),
    governingContractHash: requireDigest(
      record.governingContractHash,
      `${label}.governingContractHash`,
    ),
    reportTimeBasis: createReportTimeBasis(record.reportTimeBasis),
    expectedCount,
    acceptedCount,
    gapCount,
    duplicateCount: requireCount(record.duplicateCount, `${label}.duplicateCount`),
    quarantineCount: requireCount(record.quarantineCount, `${label}.quarantineCount`),
    coverage,
  };
}

function requireSortedSeries(
  values: readonly { readonly contractId: string; readonly contractVersion: string }[],
  label: string,
): void {
  if (values.length === 0) {
    throw new RangeError(`${label} cannot be empty`);
  }
  const sorted = [...values].sort(
    (left, right) =>
      compareCodeUnits(left.contractId, right.contractId) ||
      compareCodeUnits(left.contractVersion, right.contractVersion),
  );
  const keys = values.map(
    ({ contractId, contractVersion }) => `${contractId}\u0000${contractVersion}`,
  );
  const contractIds = values.map(({ contractId }) => contractId);
  if (
    new Set(keys).size !== keys.length ||
    new Set(contractIds).size !== contractIds.length ||
    canonicalJson(values) !== canonicalJson(sorted)
  ) {
    throw new RangeError(`${label} must have unique contract IDs in deterministic order`);
  }
}

function thresholdPasses(numerator: number, denominator: number, basisPoints: number): boolean {
  return BigInt(numerator) * 10_000n >= BigInt(denominator) * BigInt(basisPoints);
}

function normalizeRequiredReadiness(value: unknown, index: number): RequiredSeriesReadiness {
  const label = `reportContent.coverageReadiness.requiredSeries[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    [
      'contractId',
      'contractVersion',
      'state',
      'acceptedCount',
      'expectedCount',
      'thresholdBasisPoints',
      'reasons',
    ],
    [],
    label,
  );
  const acceptedCount = requireCount(record.acceptedCount, `${label}.acceptedCount`);
  const expectedCount = requireCount(record.expectedCount, `${label}.expectedCount`);
  if (acceptedCount > expectedCount) {
    throw new RangeError(`${label}.acceptedCount cannot exceed expectedCount`);
  }
  if (record.thresholdBasisPoints !== 9_500) {
    throw new RangeError(`${label}.thresholdBasisPoints must be 9500`);
  }
  const reasons = requireStrictArray(record.reasons, `${label}.reasons`).map((reason) => {
    if (reason !== 'required_series_below_95_percent') {
      throw new TypeError(`${label}.reasons contains an unsupported reason`);
    }
    return 'required_series_below_95_percent' as const;
  });
  if (new Set(reasons).size !== reasons.length) {
    throw new RangeError(`${label}.reasons must be unique`);
  }
  const state = requireReadinessState(record.state, `${label}.state`);
  const blocked = expectedCount > 0 && !thresholdPasses(acceptedCount, expectedCount, 9_500);
  const expectedState: ReadinessState =
    expectedCount === 0 ? 'not_applicable' : blocked ? 'blocked' : 'ready';
  const expectedReasons = blocked ? ['required_series_below_95_percent'] : [];
  if (
    state !== expectedState ||
    canonicalJson(reasons) !== canonicalJson(expectedReasons) ||
    (expectedCount === 0 && acceptedCount !== 0)
  ) {
    throw new RangeError(`${label} has inconsistent readiness accounting`);
  }
  return {
    contractId: requireSafeText(record.contractId, `${label}.contractId`),
    contractVersion: requireSafeText(record.contractVersion, `${label}.contractVersion`),
    state,
    acceptedCount,
    expectedCount,
    thresholdBasisPoints: 9_500,
    reasons,
  };
}

function normalizeAggregateReadiness(value: unknown, index: number): AggregateSourceSetCoverage {
  const label = `reportContent.coverageReadiness.criticalAggregates[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    [
      'aggregateId',
      'sourceContractIds',
      'state',
      'acceptedSourceIntervalPairs',
      'expectedSourceIntervalPairs',
      'thresholdBasisPoints',
      'coverage',
      'reasons',
    ],
    [],
    label,
  );
  const accepted = requireCount(
    record.acceptedSourceIntervalPairs,
    `${label}.acceptedSourceIntervalPairs`,
  );
  const expected = requireCount(
    record.expectedSourceIntervalPairs,
    `${label}.expectedSourceIntervalPairs`,
  );
  if (accepted > expected) {
    throw new RangeError(`${label}.acceptedSourceIntervalPairs cannot exceed expected`);
  }
  if (record.thresholdBasisPoints !== 9_000) {
    throw new RangeError(`${label}.thresholdBasisPoints must be 9000`);
  }
  const coverage = normalizeCoverageRatio(record.coverage, `${label}.coverage`);
  const reasons = requireStrictArray(record.reasons, `${label}.reasons`).map((reason) => {
    if (reason !== 'critical_aggregate_below_90_percent') {
      throw new TypeError(`${label}.reasons contains an unsupported reason`);
    }
    return 'critical_aggregate_below_90_percent' as const;
  });
  if (new Set(reasons).size !== reasons.length) {
    throw new RangeError(`${label}.reasons must be unique`);
  }
  const state = requireReadinessState(record.state, `${label}.state`);
  const blocked = expected > 0 && !thresholdPasses(accepted, expected, 9_000);
  const expectedState: ReadinessState =
    expected === 0 ? 'not_applicable' : blocked ? 'blocked' : 'ready';
  const expectedReasons = blocked ? ['critical_aggregate_below_90_percent'] : [];
  if (
    state !== expectedState ||
    canonicalJson(reasons) !== canonicalJson(expectedReasons) ||
    (expected === 0 && (accepted !== 0 || coverage.state !== 'not_applicable')) ||
    (expected > 0 &&
      (coverage.state !== 'measured' ||
        coverage.numerator !== accepted ||
        coverage.denominator !== expected))
  ) {
    throw new RangeError(`${label} has inconsistent aggregate accounting`);
  }
  return {
    aggregateId: requireSafeText(record.aggregateId, `${label}.aggregateId`),
    sourceContractIds: normalizeSortedUniqueTexts(
      record.sourceContractIds,
      `${label}.sourceContractIds`,
      false,
    ),
    state,
    acceptedSourceIntervalPairs: accepted,
    expectedSourceIntervalPairs: expected,
    thresholdBasisPoints: 9_000,
    coverage,
    reasons,
  };
}

export function normalizeCoverageReadinessReport(value: unknown): CoverageReadinessReport {
  const label = 'reportContent.coverageReadiness';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'claim',
      'governingContractSetHash',
      'evaluationInputSetHash',
      'coverageSummarySetHash',
      'tenantId',
      'systemId',
      'reportRange',
      'state',
      'requiredSeries',
      'criticalAggregates',
      'limitations',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'coverage-readiness/v1') {
    throw new TypeError(`${label}.schemaVersion must be coverage-readiness/v1`);
  }
  if (record.claim !== 'data coverage preflight only') {
    throw new TypeError(`${label}.claim must be data coverage preflight only`);
  }
  const requiredSeries = requireStrictArray(record.requiredSeries, `${label}.requiredSeries`).map(
    normalizeRequiredReadiness,
  );
  requireSortedSeries(requiredSeries, `${label}.requiredSeries`);
  const criticalAggregates = requireStrictArray(
    record.criticalAggregates,
    `${label}.criticalAggregates`,
  ).map(normalizeAggregateReadiness);
  const sortedAggregates = [...criticalAggregates].sort((left, right) =>
    compareCodeUnits(left.aggregateId, right.aggregateId),
  );
  if (
    new Set(criticalAggregates.map(({ aggregateId }) => aggregateId)).size !==
      criticalAggregates.length ||
    canonicalJson(criticalAggregates) !== canonicalJson(sortedAggregates)
  ) {
    throw new RangeError(`${label}.criticalAggregates must be unique and sorted`);
  }
  const allGates = [...requiredSeries, ...criticalAggregates];
  const expectedState: ReadinessState = allGates.some(({ state }) => state === 'blocked')
    ? 'blocked'
    : allGates.every(({ state }) => state === 'not_applicable')
      ? 'not_applicable'
      : 'ready';
  const state = requireReadinessState(record.state, `${label}.state`);
  if (state !== expectedState) {
    throw new RangeError(`${label}.state does not match its gates`);
  }
  return {
    schemaVersion: 'coverage-readiness/v1',
    claim: 'data coverage preflight only',
    governingContractSetHash: requireDigest(
      record.governingContractSetHash,
      `${label}.governingContractSetHash`,
    ),
    evaluationInputSetHash: requireDigest(
      record.evaluationInputSetHash,
      `${label}.evaluationInputSetHash`,
    ),
    coverageSummarySetHash: requireDigest(
      record.coverageSummarySetHash,
      `${label}.coverageSummarySetHash`,
    ),
    tenantId: requireSafeText(record.tenantId, `${label}.tenantId`),
    systemId: requireSafeText(record.systemId, `${label}.systemId`),
    reportRange: createTimeRange(record.reportRange, `${label}.reportRange`),
    state,
    requiredSeries,
    criticalAggregates,
    limitations: normalizeSingleton(
      record.limitations,
      READINESS_LIMITATION_VALUE,
      `${label}.limitations`,
    ),
  };
}

/** Reconstruct the exact safe projection before hashing or rendering caller data. */
export function normalizeReportContentProjection(value: unknown): ReportContentProjection {
  const label = 'reportContent';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'claim',
      'artifactStatus',
      'unsigned',
      'submittable',
      'tenantId',
      'systemId',
      'reportPeriod',
      'seriesMetadata',
      'requiredSeries',
      'coverageReadiness',
      'limitations',
    ],
    [],
    label,
  );
  if (
    record.schemaVersion !== 'report-content-projection/v3' ||
    record.claim !== RECEIPT_CLAIM_VALUE ||
    record.artifactStatus !== ARTIFACT_STATUS_VALUE ||
    record.unsigned !== true ||
    record.submittable !== false
  ) {
    throw new TypeError(`${label} has an invalid report boundary`);
  }
  const tenantId = requireSafeText(record.tenantId, `${label}.tenantId`);
  const systemId = requireSafeText(record.systemId, `${label}.systemId`);
  const reportPeriod = createTimeRange(record.reportPeriod, `${label}.reportPeriod`);
  const seriesMetadata = requireStrictArray(record.seriesMetadata, `${label}.seriesMetadata`).map(
    normalizeSeriesMetadata,
  );
  requireSortedSeries(seriesMetadata, `${label}.seriesMetadata`);
  const requiredSeries = requireStrictArray(record.requiredSeries, `${label}.requiredSeries`).map(
    normalizeRequiredSeries,
  );
  requireSortedSeries(requiredSeries, `${label}.requiredSeries`);
  if (seriesMetadata.length !== requiredSeries.length) {
    throw new RangeError(`${label} requires one metadata item per required series`);
  }
  for (const summary of requiredSeries) {
    const metadata = seriesMetadata.find(
      (candidate) =>
        candidate.contractId === summary.contractId &&
        candidate.contractVersion === summary.contractVersion,
    );
    if (metadata === undefined) {
      throw new RangeError(`${label} required series do not match immutable metadata`);
    }
    if (
      metadata.governingContractHash !== summary.governingContractHash ||
      (summary.reportTimeBasis.kind === 'civil' &&
        summary.reportTimeBasis.timeZone !== metadata.sourceTimeZone)
    ) {
      throw new RangeError(`${label} required series do not match immutable metadata`);
    }
  }
  const firstTimeBasis = requiredSeries[0]?.reportTimeBasis;
  if (
    firstTimeBasis === undefined ||
    requiredSeries.some(
      ({ reportTimeBasis }) => canonicalJson(reportTimeBasis) !== canonicalJson(firstTimeBasis),
    )
  ) {
    throw new RangeError(`${label} required series must share one report time basis`);
  }
  const coverageReadiness = normalizeCoverageReadinessReport(record.coverageReadiness);
  if (
    coverageReadiness.tenantId !== tenantId ||
    coverageReadiness.systemId !== systemId ||
    coverageReadiness.reportRange.start !== reportPeriod.start ||
    coverageReadiness.reportRange.end !== reportPeriod.end ||
    coverageReadiness.requiredSeries.length !== requiredSeries.length
  ) {
    throw new RangeError(`${label} readiness scope does not match report scope`);
  }
  for (const summary of requiredSeries) {
    const gate = coverageReadiness.requiredSeries.find(
      (candidate) =>
        candidate.contractId === summary.contractId &&
        candidate.contractVersion === summary.contractVersion,
    );
    if (gate === undefined) {
      throw new RangeError(`${label} readiness gates do not match required-series coverage`);
    }
    if (
      gate.acceptedCount !== summary.acceptedCount ||
      gate.expectedCount !== summary.expectedCount
    ) {
      throw new RangeError(`${label} readiness gates do not match required-series coverage`);
    }
  }
  const expectedAggregateIds = [
    ...new Set(
      seriesMetadata
        .filter(({ criticality }) => criticality === 'report_critical')
        .flatMap(({ aggregateMembership }) => aggregateMembership),
    ),
  ].sort(compareCodeUnits);
  if (
    canonicalJson(coverageReadiness.criticalAggregates.map(({ aggregateId }) => aggregateId)) !==
    canonicalJson(expectedAggregateIds)
  ) {
    throw new RangeError(`${label} critical aggregate gates do not match immutable metadata`);
  }
  for (const aggregate of coverageReadiness.criticalAggregates) {
    const expectedSources = seriesMetadata
      .filter(({ aggregateMembership }) => aggregateMembership.includes(aggregate.aggregateId))
      .map(({ contractId }) => contractId)
      .sort(compareCodeUnits);
    const sourceSet = new Set(expectedSources);
    const memberSeries = requiredSeries.filter(({ contractId }) => sourceSet.has(contractId));
    const expectedPairs = memberSeries.reduce(
      (total, summary) =>
        addCounts(total, summary.expectedCount, `${aggregate.aggregateId}.expected pairs`),
      0,
    );
    const acceptedPairs = memberSeries.reduce(
      (total, summary) =>
        addCounts(total, summary.acceptedCount, `${aggregate.aggregateId}.accepted pairs`),
      0,
    );
    if (
      canonicalJson(aggregate.sourceContractIds) !== canonicalJson(expectedSources) ||
      aggregate.expectedSourceIntervalPairs !== expectedPairs ||
      aggregate.acceptedSourceIntervalPairs !== acceptedPairs
    ) {
      throw new RangeError(`${label} critical aggregate source set does not match metadata`);
    }
  }
  return deepFreeze({
    schemaVersion: 'report-content-projection/v3',
    claim: RECEIPT_CLAIM_VALUE,
    artifactStatus: ARTIFACT_STATUS_VALUE,
    unsigned: true,
    submittable: false,
    tenantId,
    systemId,
    reportPeriod,
    seriesMetadata,
    requiredSeries,
    coverageReadiness,
    limitations: normalizeSingleton(
      record.limitations,
      REPORT_LIMITATION_VALUE,
      `${label}.limitations`,
    ),
  });
}
