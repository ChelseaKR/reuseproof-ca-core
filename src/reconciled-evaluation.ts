/** Deterministic multi-series CSV evidence evaluation through receipt and frozen draft. */

import { canonicalJson, compareCodeUnits, sha256 } from './domain/canonical.js';
import {
  createCsvAdapterSourceContract,
  type CsvAdapterSourceContract,
} from './domain/csv-ingestion.js';
import {
  bindCsvMeasurementGovernance,
  createCsvMeasurementMapping,
  type CsvMeasurementMapping,
  type CsvMeasurementGovernanceBinding,
  type CsvMeasurementNormalizationInput,
} from './domain/csv-normalization.js';
import {
  reconcileCsvMeasurementSources,
  type CsvMeasurementReconciliationResult,
} from './domain/csv-reconciliation.js';
import {
  evaluateCoverage,
  type CoverageEvaluationInput,
  type CoverageSummary,
} from './domain/coverage.js';
import { createLifecycleTimeline, type LifecycleTimeline } from './domain/lifecycle.js';
import {
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  deepFreeze,
  hashRequiredSeriesContract,
  lifecycleStates,
  type LifecycleState,
  type RequiredSeriesContract,
  type ScheduledNonoperation,
  type TimeRange,
} from './domain/model.js';
import {
  createDailyAggregatePolicy,
  createUnitConversionRule,
  evaluateDailyNumericAggregate,
  type DailyAggregatePolicy,
  type DailyNumericAggregate,
  type NumericObservationValue,
  type UnitConversionRule,
} from './domain/numeric-aggregation.js';
import { evaluateCoverageReadiness, type CoverageReadinessReport } from './domain/readiness.js';
import {
  createUnsignedReceipt,
  type NamedHash,
  type PinnedVersion,
  type UnsignedReceipt,
} from './domain/receipt.js';
import { createReportTimeBasis, type ReportTimeBasis } from './domain/time.js';
import {
  inspectUint8Array,
  requireStrictArray,
  requireStrictRecord,
  type InspectedUint8Array,
} from './domain/validation.js';
import { freezeReport, type FrozenReport } from './report-lifecycle.js';

export const MAX_RECONCILED_EVALUATION_SERIES = 64;
export const MAX_RECONCILED_EVALUATION_SOURCES = 64;
export const MAX_RECONCILED_EVALUATION_SOURCE_BYTES = 64 * 1024 * 1024;

export interface ReconciledCsvSeriesInput {
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly csvContract: CsvAdapterSourceContract;
  readonly mapping: CsvMeasurementMapping;
  readonly conversionRules: readonly UnitConversionRule[];
  readonly aggregatePolicy: DailyAggregatePolicy;
  readonly sourceObjects: readonly Uint8Array[];
}

interface ReconciledCsvEvidenceInputBase {
  readonly contracts: readonly RequiredSeriesContract[];
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly scheduledNonoperations: readonly ScheduledNonoperation[];
  readonly series: readonly ReconciledCsvSeriesInput[];
}

export type ReconciledCsvEvidenceInput = ReconciledCsvEvidenceInputBase &
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

export interface ReconciledDailyAggregateEvaluation {
  readonly aggregatePolicyHash: string;
  readonly aggregateHash: string;
  readonly aggregate: DailyNumericAggregate;
  readonly evaluationHash: string;
}

export type ReconciledCsvSourceEvaluation =
  | {
      readonly kind: 'reconciled';
      readonly governance: CsvMeasurementGovernanceBinding;
      readonly result: CsvMeasurementReconciliationResult;
      readonly operationalHash: string;
    }
  | {
      readonly kind: 'no_source_objects';
      readonly governance: CsvMeasurementGovernanceBinding;
      readonly result: null;
      readonly operationalHash: string;
    };

export interface ReconciledCsvSeriesEvaluation {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly governingContractHash: string;
  readonly evidenceSetHash: string;
  readonly reconciliation: ReconciledCsvSourceEvaluation;
  readonly coverageEvaluationInput: CoverageEvaluationInput;
  readonly coverageSummary: CoverageSummary;
  readonly dailyAggregate: ReconciledDailyAggregateEvaluation;
}

export interface ReconciledCsvEvidenceResult {
  readonly schemaVersion: 'reconciled-csv-evidence-evaluation/v1';
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly series: readonly ReconciledCsvSeriesEvaluation[];
  readonly coverageReadiness: CoverageReadinessReport;
  readonly receipt: UnsignedReceipt;
  readonly frozenReport: FrozenReport;
  readonly evaluationHash: string;
}

interface NormalizedSeriesInput {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly csvContract: CsvAdapterSourceContract;
  readonly mapping: CsvMeasurementMapping;
  readonly conversionRules: readonly UnitConversionRule[];
  readonly aggregatePolicy: DailyAggregatePolicy;
  readonly sourceObjects: readonly Uint8Array[];
}

interface NormalizedEvidenceInput {
  readonly contracts: readonly RequiredSeriesContract[];
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly scheduledNonoperations: readonly ScheduledNonoperation[];
  readonly series: readonly NormalizedSeriesInput[];
  readonly lifecycle:
    | { readonly kind: 'resolved_state'; readonly state: LifecycleState }
    | { readonly kind: 'effective_timeline'; readonly timeline: LifecycleTimeline };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function contractKey(contractId: string, contractVersion: string): string {
  return `${contractId}\u0000${contractVersion}`;
}

function displayContractKey(contractId: string, contractVersion: string): string {
  const escapeComponent = (value: string): string =>
    value.replaceAll('%', '%25').replaceAll('@', '%40');
  return `${escapeComponent(contractId)}@${escapeComponent(contractVersion)}`;
}

function normalizeContracts(value: unknown): readonly RequiredSeriesContract[] {
  const contracts = requireStrictArray(value, 'reconciled evidence contracts')
    .map(createRequiredSeriesContract)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.version, right.version),
    );
  if (contracts.length === 0 || contracts.length > MAX_RECONCILED_EVALUATION_SERIES) {
    throw new RangeError(
      `reconciled evidence requires 1 through ${MAX_RECONCILED_EVALUATION_SERIES.toString()} required-series contracts`,
    );
  }
  const keys = contracts.map(({ contractId, version }) => contractKey(contractId, version));
  if (new Set(keys).size !== keys.length) {
    throw new RangeError('reconciled evidence contract ID/version pairs must be unique');
  }
  const ids = contracts.map(({ contractId }) => contractId);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError('reconciled evidence contract IDs must be unique');
  }
  const first = contracts[0];
  /* v8 ignore next -- the non-empty bound above guarantees a first contract. */
  if (first === undefined) {
    throw new RangeError('reconciled evidence requires a governing contract');
  }
  if (
    contracts.some(
      ({ tenantId, systemId }) => tenantId !== first.tenantId || systemId !== first.systemId,
    )
  ) {
    throw new RangeError('reconciled evidence contracts must share tenant/system scope');
  }
  return contracts;
}

function normalizeSeries(value: unknown): readonly NormalizedSeriesInput[] {
  const items = requireStrictArray(value, 'reconciled evidence series');
  if (items.length === 0 || items.length > MAX_RECONCILED_EVALUATION_SERIES) {
    throw new RangeError(
      `reconciled evidence requires 1 through ${MAX_RECONCILED_EVALUATION_SERIES.toString()} series bundles`,
    );
  }
  const normalized = items.map(
    (
      item,
      index,
    ): Omit<NormalizedSeriesInput, 'sourceObjects'> & {
      readonly sourceObjects: readonly InspectedUint8Array[];
    } => {
      const label = `reconciled evidence series[${index.toString()}]`;
      const record = requireStrictRecord(
        item,
        [
          'requiredSeriesContractId',
          'requiredSeriesContractVersion',
          'csvContract',
          'mapping',
          'conversionRules',
          'aggregatePolicy',
          'sourceObjects',
        ],
        [],
        label,
      );
      const sourceObjects = requireStrictArray(record.sourceObjects, `${label}.sourceObjects`);
      const exactSources = sourceObjects.map((source, sourceIndex) =>
        inspectUint8Array(source, `${label}.sourceObjects[${sourceIndex.toString()}]`),
      );
      return {
        contractId: requiredText(
          record.requiredSeriesContractId,
          `${label}.requiredSeriesContractId`,
        ),
        contractVersion: requiredText(
          record.requiredSeriesContractVersion,
          `${label}.requiredSeriesContractVersion`,
        ),
        csvContract: createCsvAdapterSourceContract(record.csvContract),
        mapping: createCsvMeasurementMapping(record.mapping),
        conversionRules: requireStrictArray(record.conversionRules, `${label}.conversionRules`)
          .map(createUnitConversionRule)
          .sort(
            (left, right) =>
              compareCodeUnits(left.ruleId, right.ruleId) ||
              compareCodeUnits(left.version, right.version),
          ),
        aggregatePolicy: createDailyAggregatePolicy(record.aggregatePolicy),
        sourceObjects: exactSources,
      };
    },
  );
  const totalSources = normalized.reduce((count, item) => count + item.sourceObjects.length, 0);
  if (!Number.isSafeInteger(totalSources) || totalSources > MAX_RECONCILED_EVALUATION_SOURCES) {
    throw new RangeError(
      `reconciled evidence exceeds the ${MAX_RECONCILED_EVALUATION_SOURCES.toString()}-source evaluation limit`,
    );
  }
  const totalSourceBytes = normalized.reduce(
    (total, item) =>
      item.sourceObjects.reduce((seriesTotal, source) => seriesTotal + source.byteLength, total),
    0,
  );
  if (
    !Number.isSafeInteger(totalSourceBytes) ||
    totalSourceBytes > MAX_RECONCILED_EVALUATION_SOURCE_BYTES
  ) {
    throw new RangeError(
      `reconciled evidence exceeds the ${MAX_RECONCILED_EVALUATION_SOURCE_BYTES.toString()}-byte evaluation limit`,
    );
  }
  return normalized
    .map((item) => ({
      ...item,
      sourceObjects: item.sourceObjects.map(({ bytes }) => new Uint8Array(bytes)),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.contractVersion, right.contractVersion),
    );
}

function normalizeLifecycle(
  record: Record<string, unknown>,
  tenantId: string,
  systemId: string,
): NormalizedEvidenceInput['lifecycle'] {
  const hasState = Object.hasOwn(record, 'lifecycleState');
  const hasTimeline = Object.hasOwn(record, 'lifecycleTimeline');
  if (hasState === hasTimeline) {
    throw new TypeError('reconciled evidence requires exactly one lifecycle state or timeline');
  }
  if (hasTimeline) {
    const timeline = createLifecycleTimeline(record.lifecycleTimeline);
    if (timeline.tenantId !== tenantId || timeline.systemId !== systemId) {
      throw new RangeError('reconciled evidence lifecycle timeline scope does not match');
    }
    return { kind: 'effective_timeline', timeline };
  }
  if (
    typeof record.lifecycleState !== 'string' ||
    !(lifecycleStates as readonly string[]).includes(record.lifecycleState)
  ) {
    throw new TypeError('reconciled evidence lifecycle state must be supported');
  }
  return {
    kind: 'resolved_state',
    state: record.lifecycleState as LifecycleState,
  };
}

function normalizeEvidenceInput(value: unknown): NormalizedEvidenceInput {
  const record = requireStrictRecord(
    value,
    ['contracts', 'reportRange', 'reportTimeBasis', 'scheduledNonoperations', 'series'],
    ['lifecycleState', 'lifecycleTimeline'],
    'reconciled evidence input',
  );
  const contracts = normalizeContracts(record.contracts);
  const first = contracts[0];
  /* v8 ignore next -- normalizeContracts enforces a non-empty set. */
  if (first === undefined) {
    throw new RangeError('reconciled evidence requires a governing contract');
  }
  const series = normalizeSeries(record.series);
  const contractKeys = contracts.map(({ contractId, version }) => contractKey(contractId, version));
  const seriesKeys = series.map(({ contractId, contractVersion }) =>
    contractKey(contractId, contractVersion),
  );
  if (
    new Set(seriesKeys).size !== seriesKeys.length ||
    canonicalJson(seriesKeys) !== canonicalJson(contractKeys)
  ) {
    throw new RangeError(
      'reconciled evidence requires exactly one series bundle per governing contract',
    );
  }
  const scheduledNonoperations = requireStrictArray(
    record.scheduledNonoperations,
    'reconciled evidence scheduledNonoperations',
  )
    .map(createScheduledNonoperation)
    .sort((left, right) => compareCodeUnits(left.nonoperationId, right.nonoperationId));
  const nonoperationIds = scheduledNonoperations.map(({ nonoperationId }) => nonoperationId);
  if (new Set(nonoperationIds).size !== nonoperationIds.length) {
    throw new RangeError('reconciled evidence scheduled nonoperation IDs must be unique');
  }
  const knownContractIds = new Set(contracts.map(({ contractId }) => contractId));
  const unknownNonoperation = scheduledNonoperations.find(
    ({ contractId }) => !knownContractIds.has(contractId),
  );
  if (unknownNonoperation !== undefined) {
    throw new RangeError(
      `scheduled nonoperation ${unknownNonoperation.nonoperationId} references an unknown required contract`,
    );
  }
  return {
    contracts,
    reportRange: createTimeRange(record.reportRange, 'reconciled evidence reportRange'),
    reportTimeBasis: createReportTimeBasis(record.reportTimeBasis),
    scheduledNonoperations,
    series,
    lifecycle: normalizeLifecycle(record, first.tenantId, first.systemId),
  };
}

function hashEvidenceSet(reconciliation: ReconciledCsvSourceEvaluation): string {
  const sources = (reconciliation.result?.sources ?? []).map(
    ({ submissionCount: _submissionCount, ...source }) => source,
  );
  return sha256(
    canonicalJson({
      schemaVersion: 'reconciled-csv-evidence-set-binding/v1',
      governance: reconciliation.governance,
      sources,
      outcomes: reconciliation.result?.outcomes ?? [],
      observations: reconciliation.result?.observations ?? [],
      numericObservations: reconciliation.result?.numericObservations ?? [],
    }),
  );
}

function aggregatePolicyHash(policy: DailyAggregatePolicy): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'daily-aggregate-policy-binding/v1',
      policy,
    }),
  );
}

function aggregateResultHash(aggregate: DailyNumericAggregate): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'daily-numeric-aggregate-result-binding/v1',
      aggregate,
    }),
  );
}

function acceptedNumericPreimages(
  reconciliation: ReconciledCsvSourceEvaluation,
  coverageSummary: CoverageSummary,
): readonly NumericObservationValue[] {
  const acceptedIds = new Set(
    coverageSummary.outcomes.flatMap((outcome) =>
      outcome.kind === 'accepted' ? [outcome.observationId] : [],
    ),
  );
  return (reconciliation.result?.numericObservations ?? []).filter(({ observationId }) =>
    acceptedIds.has(observationId),
  );
}

function referencedRules(
  numericObservations: readonly NumericObservationValue[],
  conversionRules: readonly UnitConversionRule[],
): readonly UnitConversionRule[] {
  const keys = new Set(
    numericObservations.map(
      ({ conversionRuleId, conversionRuleVersion }) =>
        `${conversionRuleId}\u0000${conversionRuleVersion}`,
    ),
  );
  const rules = conversionRules.filter(({ ruleId, version }) =>
    keys.has(`${ruleId}\u0000${version}`),
  );
  /* v8 ignore next -- normalization emits only references from its reconstructed rule set. */
  if (rules.length !== keys.size) {
    throw new RangeError('reconciled evidence numeric preimage has no governed rule');
  }
  return rules;
}

function evaluateDailyAggregate(
  coverageEvaluation: CoverageEvaluationInput,
  coverageSummary: CoverageSummary,
  reconciliation: ReconciledCsvSourceEvaluation,
  conversionRules: readonly UnitConversionRule[],
  policy: DailyAggregatePolicy,
): ReconciledDailyAggregateEvaluation {
  const policyHash = aggregatePolicyHash(policy);
  const numericObservations = acceptedNumericPreimages(reconciliation, coverageSummary);
  const aggregate = evaluateDailyNumericAggregate({
    coverageEvaluation,
    numericObservations,
    conversionRules: referencedRules(numericObservations, conversionRules),
    policy,
  });
  const aggregateHash = aggregateResultHash(aggregate);
  return deepFreeze({
    aggregatePolicyHash: policyHash,
    aggregateHash,
    aggregate,
    evaluationHash: sha256(
      canonicalJson({
        schemaVersion: 'reconciled-daily-aggregate-evaluation-binding/v1',
        state: 'evaluated',
        aggregatePolicyHash: policyHash,
        aggregateHash,
      }),
    ),
  });
}

function coverageInput(
  normalized: NormalizedEvidenceInput,
  contract: RequiredSeriesContract,
  observations: CsvMeasurementReconciliationResult['observations'],
): CoverageEvaluationInput {
  const base = {
    contract,
    reportRange: normalized.reportRange,
    reportTimeBasis: normalized.reportTimeBasis,
    observations,
    scheduledNonoperations: normalized.scheduledNonoperations.filter(
      ({ contractId }) => contractId === contract.contractId,
    ),
  };
  return normalized.lifecycle.kind === 'effective_timeline'
    ? { ...base, lifecycleTimeline: normalized.lifecycle.timeline }
    : { ...base, lifecycleState: normalized.lifecycle.state };
}

function sourceHashes(series: readonly ReconciledCsvSeriesEvaluation[]): readonly NamedHash[] {
  const governance: NamedHash[] = series.flatMap((item) => {
    const key = displayContractKey(item.contractId, item.contractVersion);
    return [
      {
        logicalName: `governance:required-series-contract:${key}`,
        sha256: item.governingContractHash,
      },
      {
        logicalName: `governance:csv-source-contract:${key}`,
        sha256: item.reconciliation.governance.csvContractHash,
      },
      {
        logicalName: `governance:csv-measurement-mapping:${key}`,
        sha256: item.reconciliation.governance.mappingHash,
      },
      {
        logicalName: `governance:csv-normalization-rule-set:${key}`,
        sha256: item.reconciliation.governance.conversionRuleSetHash,
      },
      {
        logicalName: `governance:daily-aggregate-policy:${key}`,
        sha256: item.dailyAggregate.aggregatePolicyHash,
      },
    ];
  });
  const lengths = new Map<string, number>();
  for (const item of series) {
    for (const source of item.reconciliation.result?.sources ?? []) {
      const prior = lengths.get(source.sourceObjectHash);
      if (prior !== undefined && prior !== source.sourceByteLength) {
        throw new RangeError('reconciled source hash has inconsistent byte lengths');
      }
      lengths.set(source.sourceObjectHash, source.sourceByteLength);
    }
  }
  return [
    ...governance,
    ...[...lengths.keys()].sort(compareCodeUnits).map((digest) => ({
      logicalName: `csv-source-object:${digest}`,
      sha256: digest,
    })),
  ];
}

function lifecyclePin(lifecycle: NormalizedEvidenceInput['lifecycle']): PinnedVersion {
  return lifecycle.kind === 'effective_timeline'
    ? {
        name: `lifecycle-timeline:${lifecycle.timeline.version}`,
        value: sha256(canonicalJson(lifecycle.timeline)),
      }
    : {
        name: 'lifecycle-basis',
        value: `resolved-state:${lifecycle.state}`,
      };
}

function pinnedVersions(
  normalized: NormalizedEvidenceInput,
  series: readonly ReconciledCsvSeriesEvaluation[],
): readonly PinnedVersion[] {
  return [
    lifecyclePin(normalized.lifecycle),
    {
      name: 'report-time-basis',
      value: sha256(canonicalJson(normalized.reportTimeBasis)),
    },
    ...series.flatMap((item) => {
      const key = displayContractKey(item.contractId, item.contractVersion);
      return [
        {
          name: `required-series-contract:${key}`,
          value: item.governingContractHash,
        },
        {
          name: `csv-source-contract:${key}`,
          value: item.reconciliation.governance.csvContractHash,
        },
        {
          name: `csv-measurement-mapping:${key}`,
          value: item.reconciliation.governance.mappingHash,
        },
        {
          name: `csv-normalization-rule-set:${key}`,
          value: item.reconciliation.governance.conversionRuleSetHash,
        },
        {
          name: `reconciled-evidence-set:${key}`,
          value: item.evidenceSetHash,
        },
        {
          name: `daily-aggregate-evaluation:${key}`,
          value: item.dailyAggregate.evaluationHash,
        },
      ];
    }),
  ];
}

/**
 * Rerun exact CSV sources and derive every downstream observation, hash, aggregate, and receipt.
 * Required-series contracts remain an independent set and require exactly one source bundle each.
 */
export function evaluateReconciledCsvEvidence(
  input: ReconciledCsvEvidenceInput,
): ReconciledCsvEvidenceResult {
  const normalized = normalizeEvidenceInput(input);
  const contractsByKey = new Map(
    normalized.contracts.map((contract) => [
      contractKey(contract.contractId, contract.version),
      contract,
    ]),
  );
  const series = normalized.series.map((item): ReconciledCsvSeriesEvaluation => {
    const contract = contractsByKey.get(contractKey(item.contractId, item.contractVersion));
    /* v8 ignore next -- the exact contract/series bijection is checked before evaluation. */
    if (contract === undefined) {
      throw new RangeError('reconciled evidence series has no governing contract');
    }
    const sources: readonly CsvMeasurementNormalizationInput[] = item.sourceObjects.map(
      (sourceBytes) => ({
        csvContract: item.csvContract,
        sourceBytes,
        mapping: item.mapping,
        requiredSeriesContract: contract,
        conversionRules: item.conversionRules,
      }),
    );
    const governance = bindCsvMeasurementGovernance({
      csvContract: item.csvContract,
      mapping: item.mapping,
      requiredSeriesContract: contract,
      conversionRules: item.conversionRules,
    });
    const reconciliation: ReconciledCsvSourceEvaluation =
      sources.length === 0
        ? deepFreeze({
            kind: 'no_source_objects',
            governance,
            result: null,
            operationalHash: sha256(
              canonicalJson({
                schemaVersion: 'reconciled-csv-no-source-operational-binding/v1',
                governance,
              }),
            ),
          })
        : (() => {
            const result = reconcileCsvMeasurementSources({ sources });
            return deepFreeze({
              kind: 'reconciled' as const,
              governance,
              result,
              operationalHash: result.reconciliationHash,
            });
          })();
    const governingContractHash = hashRequiredSeriesContract(contract);
    if (
      reconciliation.governance.requiredSeriesContractId !== contract.contractId ||
      reconciliation.governance.requiredSeriesContractVersion !== contract.version ||
      reconciliation.governance.requiredSeriesContractHash !== governingContractHash ||
      (reconciliation.result !== null &&
        (reconciliation.result.requiredSeriesContractId !== contract.contractId ||
          reconciliation.result.requiredSeriesContractVersion !== contract.version ||
          reconciliation.result.requiredSeriesContractHash !== governingContractHash ||
          reconciliation.result.csvContractHash !== reconciliation.governance.csvContractHash ||
          reconciliation.result.mappingHash !== reconciliation.governance.mappingHash ||
          reconciliation.result.conversionRuleSetHash !==
            reconciliation.governance.conversionRuleSetHash))
    ) {
      throw new RangeError(
        'reconciled evidence result does not match its independent governing contract',
      );
    }
    const evaluationInput = coverageInput(
      normalized,
      contract,
      reconciliation.result?.observations ?? [],
    );
    const coverageSummary = evaluateCoverage(evaluationInput);
    return deepFreeze({
      contractId: contract.contractId,
      contractVersion: contract.version,
      governingContractHash,
      evidenceSetHash: hashEvidenceSet(reconciliation),
      reconciliation,
      coverageEvaluationInput: evaluationInput,
      coverageSummary,
      dailyAggregate: evaluateDailyAggregate(
        evaluationInput,
        coverageSummary,
        reconciliation,
        item.conversionRules,
        item.aggregatePolicy,
      ),
    });
  });
  const coverageEvaluationInputs = series.map(
    ({ coverageEvaluationInput }) => coverageEvaluationInput,
  );
  const coverageSummaries = series.map(({ coverageSummary }) => coverageSummary);
  const coverageReadiness = evaluateCoverageReadiness({
    contracts: normalized.contracts,
    coverageEvaluationInputs,
    coverageSummaries,
  });
  const first = normalized.contracts[0];
  /* v8 ignore next -- normalized contracts are non-empty. */
  if (first === undefined) {
    throw new RangeError('reconciled evidence requires a governing contract');
  }
  const receipt = createUnsignedReceipt({
    tenantId: first.tenantId,
    systemId: first.systemId,
    reportPeriod: normalized.reportRange,
    contracts: normalized.contracts,
    coverageEvaluationInputs,
    coverageSummaries,
    coverageReadiness,
    sourceHashes: sourceHashes(series),
    pinnedVersions: pinnedVersions(normalized, series),
  });
  const frozenReport = freezeReport({ receipt, reportVersion: 1 });
  const result = deepFreeze({
    schemaVersion: 'reconciled-csv-evidence-evaluation/v1' as const,
    tenantId: first.tenantId,
    systemId: first.systemId,
    reportRange: normalized.reportRange,
    reportTimeBasis: normalized.reportTimeBasis,
    series,
    coverageReadiness,
    receipt,
    frozenReport,
  });
  return deepFreeze({
    ...result,
    evaluationHash: sha256(
      canonicalJson({
        schemaVersion: 'reconciled-csv-evidence-evaluation-binding/v1',
        result,
      }),
    ),
  });
}

function requireReplayMatch(actual: unknown, expected: unknown, label: string): void {
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(actual, 'length');
      if (
        lengthDescriptor !== undefined &&
        'value' in lengthDescriptor &&
        lengthDescriptor.value !== expected.length
      ) {
        throw new RangeError(`${label} length does not match the exact evidence replay`);
      }
    }
    const actualItems = requireStrictArray(actual, label);
    if (actualItems.length !== expected.length) {
      throw new RangeError(`${label} length does not match the exact evidence replay`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      requireReplayMatch(actualItems[index], expected[index], `${label}[${index.toString()}]`);
    }
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    const expectedRecord = expected as Record<string, unknown>;
    const keys = Object.keys(expectedRecord);
    const actualRecord = requireStrictRecord(actual, keys, [], label);
    for (const key of keys) {
      requireReplayMatch(actualRecord[key], expectedRecord[key], `${label}.${key}`);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    throw new RangeError(`${label} does not match the exact evidence replay`);
  }
}

/**
 * Recompute the complete v1 result from exact inputs and reject any supplied-result divergence.
 *
 * The returned value is the replayed, deeply frozen canonical result, never the caller's object.
 */
export function validateReconciledCsvEvidenceIntegrity(
  result: ReconciledCsvEvidenceResult,
  input: ReconciledCsvEvidenceInput,
): ReconciledCsvEvidenceResult {
  const replayed = evaluateReconciledCsvEvidence(input);
  requireReplayMatch(result, replayed, 'reconciled evidence result');
  return replayed;
}
