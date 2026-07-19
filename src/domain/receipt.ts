/** Deterministic unsigned evidence manifest built after canonical report rendering. */

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import {
  createObservation,
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  deepFreeze,
  hashRequiredSeriesContract,
  hashRequiredSeriesContractSet,
  lifecycleStates,
  type RequiredSeriesContract,
  type TimeRange,
} from './model.js';
import {
  hashCoverageEvaluationInputSet,
  hashCoverageSummarySet,
  type CoverageEvaluationInput,
  type CoverageSummary,
} from './coverage.js';
import { normalizeCoverageSummary } from './coverage-validation.js';
import {
  CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS,
  evaluateCoverageReadiness,
  REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
  type AggregateSourceSetCoverage,
  type CoverageReadinessReport,
  type RequiredSeriesReadiness,
} from './readiness.js';
import { createLifecycleTimeline } from './lifecycle.js';
import { createReportTimeBasis } from './time.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';
import {
  ARTIFACT_STATUS,
  createRenderManifest,
  NON_DETERMINATION_LIMITATION,
  RECEIPT_CLAIM,
  renderReportArtifacts,
  type RenderArtifact,
  type RenderManifestItem,
  type ReportContentProjection,
  type ReportRequiredSeries,
  type ReportSeriesMetadata,
} from '../report-render.js';
import {
  normalizeCoverageReadinessReport,
  normalizeReportContentProjection,
} from '../report-schema.js';

export type {
  RenderArtifact,
  RenderManifestItem,
  ReportContentProjection,
  ReportRequiredSeries,
  ReportSeriesMetadata,
} from '../report-render.js';

export interface NamedHash {
  readonly logicalName: string;
  readonly sha256: string;
}

export interface PinnedVersion {
  readonly name: string;
  readonly value: string;
}

export interface EvidenceManifest {
  readonly schemaVersion: 'evidence-manifest/v1';
  readonly sourceHashes: readonly NamedHash[];
  readonly pinnedVersions: readonly PinnedVersion[];
  readonly governingContractSetHash: string;
  readonly evaluationInputSetHash: string;
  readonly coverageSummarySetHash: string;
  readonly requiredSeriesVersions: readonly {
    readonly contractId: string;
    readonly contractVersion: string;
  }[];
  readonly counts: {
    readonly accepted: number;
    readonly duplicate: number;
    readonly gap: number;
    readonly quarantine: number;
  };
}

export interface ReceiptCorePayload {
  readonly schemaVersion: 'receipt-core/v2';
  readonly claim: typeof RECEIPT_CLAIM;
  readonly unsigned: true;
  readonly submittable: false;
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportPeriod: TimeRange;
  readonly evidenceManifest: EvidenceManifest;
  readonly reportContentHash: string;
  readonly renderManifest: readonly RenderManifestItem[];
  readonly supersededCoreHashes: readonly string[];
  readonly limitations: readonly [typeof NON_DETERMINATION_LIMITATION];
}

export interface UnsignedReceipt {
  readonly unsigned: true;
  readonly submittable: false;
  readonly claim: typeof RECEIPT_CLAIM;
  /** Internal preimages required to prove exported metadata and semantic evaluation bindings. */
  readonly governingContracts: readonly RequiredSeriesContract[];
  readonly normalizedEvaluationInputs: readonly CoverageEvaluationInput[];
  readonly coverageSummaries: readonly CoverageSummary[];
  readonly reportContentProjection: ReportContentProjection;
  readonly canonicalReportContent: string;
  readonly reportContentHash: string;
  readonly renderArtifacts: readonly RenderArtifact[];
  readonly renderManifest: readonly RenderManifestItem[];
  readonly core: ReceiptCorePayload;
  readonly canonicalCore: string;
  readonly coreHash: string;
  readonly receiptId: string;
}

export interface ReceiptInput {
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportPeriod: TimeRange;
  readonly contracts: readonly RequiredSeriesContract[];
  readonly coverageEvaluationInputs: readonly CoverageEvaluationInput[];
  readonly coverageSummaries: readonly CoverageSummary[];
  readonly coverageReadiness?: CoverageReadinessReport;
  readonly sourceHashes: readonly NamedHash[];
  readonly pinnedVersions: readonly PinnedVersion[];
  readonly supersededCoreHashes?: readonly string[];
}

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

function requireLifecycleState(value: unknown, label: string) {
  if (typeof value !== 'string' || !(lifecycleStates as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a supported lifecycle state`);
  }
  return value as (typeof lifecycleStates)[number];
}

function normalizeCoverageEvaluationInput(value: unknown, index: number): CoverageEvaluationInput {
  const label = `receipt.normalizedEvaluationInputs[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    ['contract', 'reportRange', 'observations', 'scheduledNonoperations'],
    ['reportTimeBasis', 'lifecycleState', 'lifecycleTimeline'],
    label,
  );
  const hasResolvedState = Object.hasOwn(record, 'lifecycleState');
  const hasTimeline = Object.hasOwn(record, 'lifecycleTimeline');
  if (hasResolvedState === hasTimeline) {
    throw new TypeError(`${label} requires exactly one lifecycle state or timeline`);
  }
  const observations = requireArray(record.observations, `${label}.observations`)
    .map(createObservation)
    .sort(
      (left, right) =>
        compareCodeUnits(left.observedAt, right.observedAt) ||
        compareCodeUnits(left.sourceFingerprint, right.sourceFingerprint) ||
        compareCodeUnits(left.observationId, right.observationId),
    );
  const scheduledNonoperations = requireArray(
    record.scheduledNonoperations,
    `${label}.scheduledNonoperations`,
  )
    .map(createScheduledNonoperation)
    .sort((left, right) => compareCodeUnits(left.nonoperationId, right.nonoperationId));
  const base = {
    contract: createRequiredSeriesContract(record.contract),
    reportRange: createTimeRange(record.reportRange, `${label}.reportRange`),
    reportTimeBasis: createReportTimeBasis(
      Object.hasOwn(record, 'reportTimeBasis') ? record.reportTimeBasis : { kind: 'utc' },
    ),
    observations,
    scheduledNonoperations,
  };
  return hasResolvedState
    ? deepFreeze({
        ...base,
        lifecycleState: requireLifecycleState(record.lifecycleState, `${label}.lifecycleState`),
      })
    : deepFreeze({
        ...base,
        lifecycleTimeline: createLifecycleTimeline(record.lifecycleTimeline),
      });
}

function normalizeCoverageEvaluationInputSet(value: unknown): readonly CoverageEvaluationInput[] {
  return requireArray(value, 'receipt.normalizedEvaluationInputs')
    .map(normalizeCoverageEvaluationInput)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contract.contractId, right.contract.contractId) ||
        compareCodeUnits(left.contract.version, right.contract.version),
    );
}

function createReportRequiredSeries(summary: CoverageSummary): ReportRequiredSeries {
  return {
    contractId: summary.contractId,
    contractVersion: summary.contractVersion,
    governingContractHash: summary.governingContractHash,
    reportTimeBasis: summary.reportTimeBasis,
    expectedCount: summary.expectedCount,
    acceptedCount: summary.acceptedCount,
    gapCount: summary.gapCount,
    duplicateCount: summary.duplicateCount,
    quarantineCount: summary.quarantineCount,
    coverage: summary.coverage,
  };
}

function createReportRequiredSeriesSet(
  summaries: readonly CoverageSummary[],
): readonly ReportRequiredSeries[] {
  return summaries
    .map(createReportRequiredSeries)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.contractVersion, right.contractVersion),
    );
}

function normalizeGoverningContracts(
  value: unknown,
  summaries: readonly CoverageSummary[],
  tenantId: string,
  systemId: string,
): readonly RequiredSeriesContract[] {
  const contracts = requireArray(value, 'receipt.governingContracts')
    .map((contract) => createRequiredSeriesContract(contract))
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.version, right.version),
    );
  if (contracts.length !== summaries.length) {
    throw new RangeError(
      'receipt governing contracts require exactly one item per required series',
    );
  }
  const contractKeys = contracts.map(({ contractId, version }) => `${contractId}\u0000${version}`);
  if (new Set(contractKeys).size !== contractKeys.length) {
    throw new RangeError('receipt governing contract ID/version pairs must be unique');
  }
  for (const summary of summaries) {
    const contract = contracts.find(
      ({ contractId, version }) =>
        contractId === summary.contractId && version === summary.contractVersion,
    );
    if (contract === undefined) {
      throw new RangeError(
        'receipt governing contract preimages do not match required-series scope and hashes',
      );
    }
    if (
      contract.tenantId !== tenantId ||
      contract.systemId !== systemId ||
      hashRequiredSeriesContract(contract) !== summary.governingContractHash
    ) {
      throw new RangeError(
        'receipt governing contract preimages do not match required-series scope and hashes',
      );
    }
  }
  return contracts;
}

function requireIntervalClassesMatchGoverningContracts(
  summaries: readonly CoverageSummary[],
  contracts: readonly RequiredSeriesContract[],
): void {
  for (const summary of summaries) {
    const contract = contracts.find(
      ({ contractId, version }) =>
        contractId === summary.contractId && version === summary.contractVersion,
    );
    if (contract === undefined) {
      throw new RangeError(`required series ${summary.contractId} has no governing contract`);
    }
    const eligibleStates = new Set(contract.eligibleLifecycleStates);
    if (
      [...summary.expectedIntervals, ...summary.excludedIntervals].some(
        ({ lifecycleState }) => !eligibleStates.has(lifecycleState),
      ) ||
      summary.lifecycleExcludedIntervals.some(({ lifecycleState }) =>
        eligibleStates.has(lifecycleState),
      )
    ) {
      throw new RangeError(
        `required series ${summary.contractId} interval class contradicts its governing lifecycle eligibility`,
      );
    }
  }
}

function createReportSeriesMetadata(
  contracts: readonly RequiredSeriesContract[],
): readonly ReportSeriesMetadata[] {
  const values = contracts.map((contract) => {
    return {
      contractId: contract.contractId,
      contractVersion: contract.version,
      governingContractHash: hashRequiredSeriesContract(contract),
      processCode: contract.processCode,
      parameterCode: contract.parameterCode,
      statistic: contract.statistic,
      canonicalUnit: contract.canonicalUnit,
      sourceTimeZone: contract.timezone,
      criticality: contract.criticality,
      aggregateMembership: [...contract.aggregateMembership].sort(compareCodeUnits),
    };
  });
  return values.sort((left, right) => compareCodeUnits(left.contractId, right.contractId));
}

function thresholdPasses(numerator: number, denominator: number, basisPoints: number): boolean {
  return BigInt(numerator) * 10_000n >= BigInt(denominator) * BigInt(basisPoints);
}

function expectedSeriesReadiness(summary: CoverageSummary): RequiredSeriesReadiness {
  if (summary.expectedCount === 0) {
    return {
      contractId: summary.contractId,
      contractVersion: summary.contractVersion,
      state: 'not_applicable',
      acceptedCount: 0,
      expectedCount: 0,
      thresholdBasisPoints: REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
      reasons: [],
    };
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
  return {
    contractId: summary.contractId,
    contractVersion: summary.contractVersion,
    state: reasons.length === 0 ? 'ready' : 'blocked',
    acceptedCount: summary.acceptedCount,
    expectedCount: summary.expectedCount,
    thresholdBasisPoints: REQUIRED_SERIES_THRESHOLD_BASIS_POINTS,
    reasons,
  };
}

function expectedAggregateReadiness(
  aggregateId: string,
  metadata: readonly ReportSeriesMetadata[],
  summaries: readonly CoverageSummary[],
): AggregateSourceSetCoverage {
  const members = metadata.filter(({ aggregateMembership }) =>
    aggregateMembership.includes(aggregateId),
  );
  const memberContractIds = new Set(members.map(({ contractId }) => contractId));
  const memberSummaries = summaries.filter(({ contractId }) => memberContractIds.has(contractId));
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
    return {
      aggregateId,
      sourceContractIds: members.map(({ contractId }) => contractId),
      state: 'not_applicable',
      acceptedSourceIntervalPairs: 0,
      expectedSourceIntervalPairs: 0,
      thresholdBasisPoints: CRITICAL_AGGREGATE_THRESHOLD_BASIS_POINTS,
      coverage: { state: 'not_applicable' },
      reasons: [],
    };
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
  return {
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
  };
}

const READINESS_LIMITATION =
  'not a compliance, safety, water-quality, engineering, or filing determination' as const;

function validateCoverageReadinessProjection(
  value: unknown,
  tenantId: string,
  systemId: string,
  reportPeriod: TimeRange,
  summaries: readonly CoverageSummary[],
  metadata: readonly ReportSeriesMetadata[],
  governingContracts: readonly RequiredSeriesContract[],
): CoverageReadinessReport {
  const normalized = normalizeCoverageReadinessReport(value);
  const requiredSeries = summaries.map(expectedSeriesReadiness);
  const criticalAggregateIds = [
    ...new Set(
      metadata
        .filter(({ criticality }) => criticality === 'report_critical')
        .flatMap(({ aggregateMembership }) => aggregateMembership),
    ),
  ].sort(compareCodeUnits);
  const criticalAggregates = criticalAggregateIds.map((aggregateId) =>
    expectedAggregateReadiness(aggregateId, metadata, summaries),
  );
  const allGates = [...requiredSeries, ...criticalAggregates];
  const state = allGates.some((gate) => gate.state === 'blocked')
    ? 'blocked'
    : allGates.every((gate) => gate.state === 'not_applicable')
      ? 'not_applicable'
      : 'ready';
  const expected: CoverageReadinessReport = {
    schemaVersion: 'coverage-readiness/v1',
    claim: 'data coverage preflight only',
    governingContractSetHash: hashRequiredSeriesContractSet(governingContracts),
    evaluationInputSetHash: hashCoverageEvaluationInputSet(summaries),
    coverageSummarySetHash: hashCoverageSummarySet(summaries),
    tenantId,
    systemId,
    reportRange: reportPeriod,
    state,
    requiredSeries,
    criticalAggregates,
    limitations: [READINESS_LIMITATION],
  };
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw new RangeError(
      'coverage readiness is not the exact semantic result of the frozen required series',
    );
  }
  return expected;
}

function requireUniqueNames(values: readonly { readonly name: string }[], label: string): void {
  const names = values.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new TypeError(`${label} names must be unique`);
  }
}

function validateNamedHashes(value: unknown, requireCanonicalOrder = false): readonly NamedHash[] {
  const renamed = requireArray(value, 'source hashes').map((item, index) => {
    const record = requireStrictRecord(
      item,
      ['logicalName', 'sha256'],
      [],
      `sourceHashes[${index.toString()}]`,
    );
    const logicalName = requireSafeText(record.logicalName, 'source hash logical name');
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new TypeError('source hashes require lowercase SHA-256 hex');
    }
    return {
      name: logicalName,
      logicalName,
      sha256: record.sha256,
    };
  });
  requireUniqueNames(renamed, 'source hash');
  const inputOrder = renamed.map(({ logicalName, sha256: digest }) => ({
    logicalName,
    sha256: digest,
  }));
  const sorted = [...inputOrder].sort((left, right) =>
    compareCodeUnits(left.logicalName, right.logicalName),
  );
  if (requireCanonicalOrder && canonicalJson(inputOrder) !== canonicalJson(sorted)) {
    throw new RangeError('source hashes must use canonical logical-name order');
  }
  return sorted.map(({ logicalName, sha256: digest }) => ({ logicalName, sha256: digest }));
}

function validatePinnedVersions(
  value: unknown,
  requireCanonicalOrder = false,
): readonly PinnedVersion[] {
  const validated = requireArray(value, 'pinned versions').map((item, index) => {
    const record = requireStrictRecord(
      item,
      ['name', 'value'],
      [],
      `pinnedVersions[${index.toString()}]`,
    );
    return {
      name: requireSafeText(record.name, 'pinned version name'),
      value: requireSafeText(record.value, 'pinned version value'),
    };
  });
  requireUniqueNames(validated, 'pinned version');
  const sorted = [...validated].sort((left, right) => compareCodeUnits(left.name, right.name));
  if (requireCanonicalOrder && canonicalJson(validated) !== canonicalJson(sorted)) {
    throw new RangeError('pinned versions must use canonical name order');
  }
  return sorted;
}

function validateDigestSet(
  value: unknown,
  label: string,
  requireCanonicalOrder = false,
): readonly string[] {
  const values = requireArray(value, label).map((item) => {
    if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) {
      throw new TypeError(`${label} must contain only lowercase SHA-256 hex`);
    }
    return item;
  });
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  const sorted = [...values].sort(compareCodeUnits);
  if (requireCanonicalOrder && canonicalJson(values) !== canonicalJson(sorted)) {
    throw new RangeError(`${label} must use canonical digest order`);
  }
  return sorted;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

const receiptMediaTypes = ['application/json', 'text/csv', 'text/html'] as const;
const receiptArtifactFilenames = [
  'coverage-report.csv',
  'coverage-report.html',
  'coverage-report.json',
] as const;

function normalizeRenderManifestItems(
  value: unknown,
  label: string,
): readonly RenderManifestItem[] {
  return requireArray(value, label).map((item, index) => {
    const itemLabel = `${label}[${index.toString()}]`;
    const record = requireStrictRecord(
      item,
      ['mediaType', 'logicalFilename', 'byteLength', 'sha256'],
      [],
      itemLabel,
    );
    if (
      typeof record.mediaType !== 'string' ||
      !(receiptMediaTypes as readonly string[]).includes(record.mediaType)
    ) {
      throw new TypeError(`${itemLabel}.mediaType is not supported`);
    }
    if (
      typeof record.logicalFilename !== 'string' ||
      !(receiptArtifactFilenames as readonly string[]).includes(record.logicalFilename)
    ) {
      throw new TypeError(`${itemLabel}.logicalFilename is not supported`);
    }
    return {
      mediaType: record.mediaType as RenderManifestItem['mediaType'],
      logicalFilename: record.logicalFilename as RenderManifestItem['logicalFilename'],
      byteLength: requireCount(record.byteLength, `${itemLabel}.byteLength`),
      sha256: requireDigest(record.sha256, `${itemLabel}.sha256`),
    };
  });
}

function normalizeRenderArtifacts(value: unknown): readonly RenderArtifact[] {
  return requireArray(value, 'receipt.renderArtifacts').map((item, index) => {
    const label = `receipt.renderArtifacts[${index.toString()}]`;
    const record = requireStrictRecord(
      item,
      ['mediaType', 'logicalFilename', 'utf8Text'],
      [],
      label,
    );
    if (
      typeof record.mediaType !== 'string' ||
      !(receiptMediaTypes as readonly string[]).includes(record.mediaType)
    ) {
      throw new TypeError(`${label}.mediaType is not supported`);
    }
    if (
      typeof record.logicalFilename !== 'string' ||
      !(receiptArtifactFilenames as readonly string[]).includes(record.logicalFilename)
    ) {
      throw new TypeError(`${label}.logicalFilename is not supported`);
    }
    if (typeof record.utf8Text !== 'string') {
      throw new TypeError(`${label}.utf8Text must be text`);
    }
    return {
      mediaType: record.mediaType as RenderArtifact['mediaType'],
      logicalFilename: record.logicalFilename as RenderArtifact['logicalFilename'],
      utf8Text: record.utf8Text,
    };
  });
}

function normalizeEvidenceCounts(value: unknown): EvidenceManifest['counts'] {
  const record = requireStrictRecord(
    value,
    ['accepted', 'duplicate', 'gap', 'quarantine'],
    [],
    'receipt.core.evidenceManifest.counts',
  );
  return {
    accepted: requireCount(record.accepted, 'receipt evidence accepted count'),
    duplicate: requireCount(record.duplicate, 'receipt evidence duplicate count'),
    gap: requireCount(record.gap, 'receipt evidence gap count'),
    quarantine: requireCount(record.quarantine, 'receipt evidence quarantine count'),
  };
}

function normalizeRequiredSeriesVersions(
  value: unknown,
): EvidenceManifest['requiredSeriesVersions'] {
  return requireArray(value, 'receipt.core.evidenceManifest.requiredSeriesVersions').map(
    (item, index) => {
      const label = `receipt.core.evidenceManifest.requiredSeriesVersions[${index.toString()}]`;
      const record = requireStrictRecord(item, ['contractId', 'contractVersion'], [], label);
      return {
        contractId: requireSafeText(record.contractId, `${label}.contractId`),
        contractVersion: requireSafeText(record.contractVersion, `${label}.contractVersion`),
      };
    },
  );
}

function normalizeEvidenceManifest(value: unknown): EvidenceManifest {
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'sourceHashes',
      'pinnedVersions',
      'governingContractSetHash',
      'evaluationInputSetHash',
      'coverageSummarySetHash',
      'requiredSeriesVersions',
      'counts',
    ],
    [],
    'receipt.core.evidenceManifest',
  );
  return {
    schemaVersion: requireSafeText(
      record.schemaVersion,
      'receipt.core.evidenceManifest.schemaVersion',
    ) as EvidenceManifest['schemaVersion'],
    sourceHashes: validateNamedHashes(record.sourceHashes, true),
    pinnedVersions: validatePinnedVersions(record.pinnedVersions, true),
    governingContractSetHash: requireDigest(
      record.governingContractSetHash,
      'governing contract set hash',
    ),
    evaluationInputSetHash: requireDigest(
      record.evaluationInputSetHash,
      'evaluation input set hash',
    ),
    coverageSummarySetHash: requireDigest(
      record.coverageSummarySetHash,
      'coverage summary set hash',
    ),
    requiredSeriesVersions: normalizeRequiredSeriesVersions(record.requiredSeriesVersions),
    counts: normalizeEvidenceCounts(record.counts),
  };
}

interface ParsedReceiptCore {
  readonly core: ReceiptCorePayload;
  readonly evidenceManifest: EvidenceManifest;
  readonly renderManifest: readonly RenderManifestItem[];
}

function parseReceiptCore(value: unknown): ParsedReceiptCore {
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'claim',
      'unsigned',
      'submittable',
      'tenantId',
      'systemId',
      'reportPeriod',
      'evidenceManifest',
      'reportContentHash',
      'renderManifest',
      'supersededCoreHashes',
      'limitations',
    ],
    [],
    'receipt.core',
  );
  const reportPeriod = createTimeRange(record.reportPeriod, 'receipt.core.reportPeriod');
  const supersededCoreHashes = validateDigestSet(
    record.supersededCoreHashes,
    'superseded core hashes',
    true,
  );
  const limitations = requireArray(record.limitations, 'receipt.core.limitations').map(
    (limitation, index) =>
      requireSafeText(limitation, `receipt.core.limitations[${index.toString()}]`),
  );
  const evidenceManifest = normalizeEvidenceManifest(record.evidenceManifest);
  const renderManifest = normalizeRenderManifestItems(
    record.renderManifest,
    'receipt.core.renderManifest',
  );
  if (typeof record.unsigned !== 'boolean' || typeof record.submittable !== 'boolean') {
    throw new TypeError('receipt core boundary flags must be boolean');
  }
  const core = {
    schemaVersion: requireSafeText(record.schemaVersion, 'receipt.core.schemaVersion'),
    claim: requireSafeText(record.claim, 'receipt.core.claim'),
    unsigned: record.unsigned,
    submittable: record.submittable,
    tenantId: requireSafeText(record.tenantId, 'receipt.core.tenantId'),
    systemId: requireSafeText(record.systemId, 'receipt.core.systemId'),
    reportPeriod,
    evidenceManifest,
    reportContentHash: requireDigest(record.reportContentHash, 'receipt.core.reportContentHash'),
    renderManifest,
    supersededCoreHashes,
    limitations,
  } as unknown as ReceiptCorePayload;
  return {
    core,
    evidenceManifest,
    renderManifest,
  };
}

function requireConsistentScope(
  summaries: readonly CoverageSummary[],
  tenantId: string,
  systemId: string,
  reportPeriod: TimeRange,
): void {
  for (const summary of summaries) {
    requireSafeText(summary.contractId, 'coverage summary contract ID');
    requireSafeText(summary.contractVersion, 'coverage summary contract version');
    if (summary.tenantId !== tenantId || summary.systemId !== systemId) {
      throw new RangeError('coverage summary scope does not match receipt scope');
    }
    if (
      summary.reportRange.start !== reportPeriod.start ||
      summary.reportRange.end !== reportPeriod.end
    ) {
      throw new RangeError('coverage summary report range does not match receipt period');
    }
  }
}

function totalCount(summaries: readonly CoverageSummary[], key: keyof CoverageSummary): number {
  let total = 0;
  for (const summary of summaries) {
    const value = summary[key] as number;
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`receipt ${key} total exceeds the safe-integer limit`);
    }
  }
  return total;
}

/** Build content, render bytes, and then a non-circular unsigned receipt core. */
export function createUnsignedReceipt(input: ReceiptInput): UnsignedReceipt {
  const receiptInput = requireStrictRecord(
    input,
    [
      'tenantId',
      'systemId',
      'reportPeriod',
      'contracts',
      'coverageEvaluationInputs',
      'coverageSummaries',
      'sourceHashes',
      'pinnedVersions',
    ],
    ['coverageReadiness', 'supersededCoreHashes'],
    'receipt input',
  ) as unknown as ReceiptInput;
  const tenantId = requireSafeText(receiptInput.tenantId, 'receipt tenant ID');
  const systemId = requireSafeText(receiptInput.systemId, 'receipt system ID');
  const reportPeriod = createTimeRange(receiptInput.reportPeriod, 'receipt.reportPeriod');
  const sourceHashes = validateNamedHashes(receiptInput.sourceHashes);
  const pinnedVersions = validatePinnedVersions(receiptInput.pinnedVersions);
  const supersededCoreHashes = validateDigestSet(
    Object.hasOwn(receiptInput, 'supersededCoreHashes') ? receiptInput.supersededCoreHashes : [],
    'superseded core hashes',
  );
  const summaries = requireArray(receiptInput.coverageSummaries, 'receipt coverageSummaries')
    .map(normalizeCoverageSummary)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.contractVersion, right.contractVersion),
    );
  if (summaries.length === 0) {
    throw new TypeError('receipt requires at least one coverage summary');
  }
  if (sourceHashes.length === 0) {
    throw new TypeError('receipt requires at least one source hash');
  }
  if (pinnedVersions.length === 0) {
    throw new TypeError('receipt requires at least one pinned version');
  }
  const summaryKeys = summaries.map(
    ({ contractId, contractVersion }) => `${contractId}\u0000${contractVersion}`,
  );
  if (new Set(summaryKeys).size !== summaryKeys.length) {
    throw new TypeError('receipt coverage summary contract/version pairs must be unique');
  }
  requireConsistentScope(summaries, tenantId, systemId, reportPeriod);
  const governingContracts = normalizeGoverningContracts(
    receiptInput.contracts,
    summaries,
    tenantId,
    systemId,
  );
  requireIntervalClassesMatchGoverningContracts(summaries, governingContracts);
  const normalizedEvaluationInputs = normalizeCoverageEvaluationInputSet(
    receiptInput.coverageEvaluationInputs,
  );
  const recomputedReadiness = evaluateCoverageReadiness({
    contracts: governingContracts,
    coverageEvaluationInputs: normalizedEvaluationInputs,
    coverageSummaries: summaries,
  });
  const seriesMetadata = createReportSeriesMetadata(governingContracts);
  const coverageReadiness = validateCoverageReadinessProjection(
    Object.hasOwn(receiptInput, 'coverageReadiness')
      ? receiptInput.coverageReadiness
      : recomputedReadiness,
    tenantId,
    systemId,
    reportPeriod,
    summaries,
    seriesMetadata,
    governingContracts,
  );
  const reportRequiredSeries = createReportRequiredSeriesSet(summaries);
  const projection: ReportContentProjection = deepFreeze({
    schemaVersion: 'report-content-projection/v3',
    claim: RECEIPT_CLAIM,
    artifactStatus: ARTIFACT_STATUS,
    unsigned: true,
    submittable: false,
    tenantId,
    systemId,
    reportPeriod,
    seriesMetadata,
    requiredSeries: reportRequiredSeries,
    coverageReadiness,
    limitations: [NON_DETERMINATION_LIMITATION],
  });
  const canonicalReportContent = canonicalJson(projection);
  const reportContentHash = sha256(canonicalReportContent);
  const renderArtifacts = deepFreeze(renderReportArtifacts(projection, reportContentHash));
  const renderManifest = deepFreeze(createRenderManifest(renderArtifacts));
  const evidenceManifest: EvidenceManifest = deepFreeze({
    schemaVersion: 'evidence-manifest/v1',
    sourceHashes,
    pinnedVersions,
    governingContractSetHash: coverageReadiness.governingContractSetHash,
    evaluationInputSetHash: coverageReadiness.evaluationInputSetHash,
    coverageSummarySetHash: coverageReadiness.coverageSummarySetHash,
    requiredSeriesVersions: summaries.map(({ contractId, contractVersion }) => ({
      contractId,
      contractVersion,
    })),
    counts: {
      accepted: totalCount(summaries, 'acceptedCount'),
      duplicate: totalCount(summaries, 'duplicateCount'),
      gap: totalCount(summaries, 'gapCount'),
      quarantine: totalCount(summaries, 'quarantineCount'),
    },
  });
  const core: ReceiptCorePayload = deepFreeze({
    schemaVersion: 'receipt-core/v2',
    claim: RECEIPT_CLAIM,
    unsigned: true,
    submittable: false,
    tenantId,
    systemId,
    reportPeriod,
    evidenceManifest,
    reportContentHash,
    renderManifest,
    supersededCoreHashes,
    limitations: [NON_DETERMINATION_LIMITATION],
  });
  const canonicalCore = canonicalJson(core);
  const coreHash = sha256(canonicalCore);
  return deepFreeze({
    unsigned: true,
    submittable: false,
    claim: RECEIPT_CLAIM,
    governingContracts,
    normalizedEvaluationInputs,
    coverageSummaries: summaries,
    reportContentProjection: projection,
    canonicalReportContent,
    reportContentHash,
    renderArtifacts,
    renderManifest,
    core,
    canonicalCore,
    coreHash,
    receiptId: `rp1-${coreHash}`,
  });
}

/** Recheck all content/render/core links before a receipt crosses an output boundary. */
export function validateUnsignedReceiptIntegrity(receipt: UnsignedReceipt): UnsignedReceipt {
  const strictReceipt = requireStrictRecord(
    receipt,
    [
      'unsigned',
      'submittable',
      'claim',
      'governingContracts',
      'normalizedEvaluationInputs',
      'coverageSummaries',
      'reportContentProjection',
      'canonicalReportContent',
      'reportContentHash',
      'renderArtifacts',
      'renderManifest',
      'core',
      'canonicalCore',
      'coreHash',
      'receiptId',
    ],
    [],
    'unsigned receipt',
  ) as unknown as UnsignedReceipt;
  const parsedCore = parseReceiptCore(strictReceipt.core);
  const core = parsedCore.core;
  const receiptRenderArtifacts = normalizeRenderArtifacts(strictReceipt.renderArtifacts);
  const receiptRenderManifest = normalizeRenderManifestItems(
    strictReceipt.renderManifest,
    'receipt.renderManifest',
  );
  const receiptBoundary: {
    readonly unsigned: boolean;
    readonly submittable: boolean;
    readonly claim: string;
  } = strictReceipt;
  const projection = normalizeReportContentProjection(strictReceipt.reportContentProjection);
  const projectionBoundary: {
    readonly schemaVersion: string;
    readonly claim: string;
    readonly artifactStatus: string;
    readonly unsigned: boolean;
    readonly submittable: boolean;
  } = projection;
  const tenantId = requireSafeText(projection.tenantId, 'receipt tenant ID');
  const systemId = requireSafeText(projection.systemId, 'receipt system ID');
  const reportPeriod = createTimeRange(projection.reportPeriod, 'receipt.reportPeriod');
  const reportRequiredSeries = projection.requiredSeries;
  const coverageSummaries = requireArray(
    strictReceipt.coverageSummaries,
    'receipt.coverageSummaries',
  );
  if (coverageSummaries.length === 0) {
    throw new RangeError('unsigned receipt requires at least one internal coverage summary');
  }
  const summaries = coverageSummaries
    .map(normalizeCoverageSummary)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.contractVersion, right.contractVersion),
    );
  const counts = {
    accepted: totalCount(summaries, 'acceptedCount'),
    duplicate: totalCount(summaries, 'duplicateCount'),
    gap: totalCount(summaries, 'gapCount'),
    quarantine: totalCount(summaries, 'quarantineCount'),
  };
  const summaryKeys = summaries.map(
    ({ contractId, contractVersion }) => `${contractId}\u0000${contractVersion}`,
  );
  if (new Set(summaryKeys).size !== summaryKeys.length) {
    throw new RangeError('unsigned receipt internal coverage summaries must be unique');
  }
  const contractIds = summaries.map(({ contractId }) => contractId);
  if (new Set(contractIds).size !== contractIds.length) {
    throw new RangeError('unsigned receipt internal coverage contract IDs must be unique');
  }
  const firstReportTimeBasis = summaries[0]?.reportTimeBasis;
  for (const summary of summaries) {
    if (
      summary.tenantId !== tenantId ||
      summary.systemId !== systemId ||
      summary.reportRange.start !== reportPeriod.start ||
      summary.reportRange.end !== reportPeriod.end
    ) {
      throw new RangeError('unsigned receipt coverage summary scope does not match report scope');
    }
    if (
      firstReportTimeBasis === undefined ||
      canonicalJson(summary.reportTimeBasis) !== canonicalJson(firstReportTimeBasis)
    ) {
      throw new RangeError('unsigned receipt coverage summaries must share one report time basis');
    }
  }
  const derivedReportRequiredSeries = createReportRequiredSeriesSet(summaries);
  if (canonicalJson(reportRequiredSeries) !== canonicalJson(derivedReportRequiredSeries)) {
    throw new RangeError(
      'unsigned receipt report-safe required series do not match internal coverage summaries',
    );
  }
  const governingContracts = normalizeGoverningContracts(
    strictReceipt.governingContracts,
    summaries,
    tenantId,
    systemId,
  );
  requireIntervalClassesMatchGoverningContracts(summaries, governingContracts);
  const normalizedEvaluationInputs = normalizeCoverageEvaluationInputSet(
    strictReceipt.normalizedEvaluationInputs,
  );
  evaluateCoverageReadiness({
    contracts: governingContracts,
    coverageEvaluationInputs: normalizedEvaluationInputs,
    coverageSummaries: summaries,
  });
  const seriesMetadata = projection.seriesMetadata;
  if (
    canonicalJson(seriesMetadata) !== canonicalJson(createReportSeriesMetadata(governingContracts))
  ) {
    throw new RangeError(
      'unsigned receipt series metadata is not derived from governing contracts',
    );
  }
  const coverageReadiness = validateCoverageReadinessProjection(
    projection.coverageReadiness,
    tenantId,
    systemId,
    reportPeriod,
    summaries,
    seriesMetadata,
    governingContracts,
  );
  const expectedProjection: ReportContentProjection = {
    schemaVersion: 'report-content-projection/v3',
    claim: RECEIPT_CLAIM,
    artifactStatus: ARTIFACT_STATUS,
    unsigned: true,
    submittable: false,
    tenantId,
    systemId,
    reportPeriod,
    seriesMetadata,
    requiredSeries: derivedReportRequiredSeries,
    coverageReadiness,
    limitations: [NON_DETERMINATION_LIMITATION],
  };
  if (
    projectionBoundary.schemaVersion !== 'report-content-projection/v3' ||
    projectionBoundary.claim !== RECEIPT_CLAIM ||
    projectionBoundary.artifactStatus !== ARTIFACT_STATUS ||
    !projectionBoundary.unsigned ||
    projectionBoundary.submittable ||
    canonicalJson(projection) !== canonicalJson(expectedProjection)
  ) {
    throw new RangeError('unsigned receipt projection boundary is invalid');
  }
  const canonicalReportContent = canonicalJson(projection);
  const reportContentHash = sha256(canonicalReportContent);
  const renderArtifacts = renderReportArtifacts(projection, reportContentHash);
  const renderManifest = createRenderManifest(renderArtifacts);
  if (
    !receiptBoundary.unsigned ||
    receiptBoundary.submittable ||
    receiptBoundary.claim !== RECEIPT_CLAIM ||
    strictReceipt.canonicalReportContent !== canonicalReportContent ||
    strictReceipt.reportContentHash !== reportContentHash ||
    canonicalJson(receiptRenderArtifacts) !== canonicalJson(renderArtifacts) ||
    canonicalJson(receiptRenderManifest) !== canonicalJson(renderManifest)
  ) {
    throw new RangeError('unsigned receipt content or render integrity check failed');
  }
  const canonicalCore = canonicalJson(core);
  const coreHash = sha256(canonicalCore);
  const coreBoundary: {
    readonly unsigned: boolean;
    readonly submittable: boolean;
    readonly claim: string;
  } = core;
  if (
    parsedCore.evidenceManifest.sourceHashes.length === 0 ||
    parsedCore.evidenceManifest.pinnedVersions.length === 0
  ) {
    throw new RangeError('unsigned receipt evidence manifest cannot be empty');
  }
  const expectedEvidenceManifest: EvidenceManifest = {
    schemaVersion: 'evidence-manifest/v1',
    sourceHashes: parsedCore.evidenceManifest.sourceHashes,
    pinnedVersions: parsedCore.evidenceManifest.pinnedVersions,
    governingContractSetHash: requireDigest(
      coverageReadiness.governingContractSetHash,
      'governing contract set hash',
    ),
    evaluationInputSetHash: requireDigest(
      coverageReadiness.evaluationInputSetHash,
      'evaluation input set hash',
    ),
    coverageSummarySetHash: requireDigest(
      coverageReadiness.coverageSummarySetHash,
      'coverage summary set hash',
    ),
    requiredSeriesVersions: summaries.map(({ contractId, contractVersion }) => ({
      contractId,
      contractVersion,
    })),
    counts,
  };
  const expectedCore: ReceiptCorePayload = {
    schemaVersion: 'receipt-core/v2',
    claim: RECEIPT_CLAIM,
    unsigned: true,
    submittable: false,
    tenantId,
    systemId,
    reportPeriod,
    evidenceManifest: expectedEvidenceManifest,
    reportContentHash,
    renderManifest,
    supersededCoreHashes: validateDigestSet(core.supersededCoreHashes, 'superseded core hashes'),
    limitations: [NON_DETERMINATION_LIMITATION],
  };
  if (
    strictReceipt.canonicalCore !== canonicalCore ||
    strictReceipt.coreHash !== coreHash ||
    strictReceipt.receiptId !== `rp1-${coreHash}` ||
    core.reportContentHash !== reportContentHash ||
    canonicalJson(parsedCore.renderManifest) !== canonicalJson(renderManifest) ||
    !coreBoundary.unsigned ||
    coreBoundary.submittable ||
    coreBoundary.claim !== RECEIPT_CLAIM ||
    canonicalCore !== canonicalJson(expectedCore)
  ) {
    throw new RangeError('unsigned receipt core integrity check failed');
  }
  return deepFreeze({
    unsigned: true,
    submittable: false,
    claim: RECEIPT_CLAIM,
    governingContracts,
    normalizedEvaluationInputs,
    coverageSummaries: summaries,
    reportContentProjection: projection,
    canonicalReportContent,
    reportContentHash,
    renderArtifacts,
    renderManifest,
    core: expectedCore,
    canonicalCore,
    coreHash,
    receiptId: `rp1-${coreHash}`,
  });
}
