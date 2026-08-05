/** Deterministic CSV-row normalization into coverage and numeric preimages. */

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import {
  createCsvAdapterSourceContract,
  hashCsvAdapterSourceContract,
  ingestCsvSource,
  type CsvAdapterSourceContract,
  type CsvIngestionResult,
  type CsvSourceRejectionReason,
} from './csv-ingestion.js';
import {
  MAX_CONVERSION_RULES,
  createNumericObservationValue,
  createUnitConversionRule,
  type NumericObservationValue,
  type UnitConversionRule,
} from './numeric-aggregation.js';
import {
  createObservation,
  createRequiredSeriesContract,
  deepFreeze,
  hashRequiredSeriesContract,
  instantMilliseconds,
  type Observation,
  type QuarantineReason,
  type RequiredSeriesContract,
} from './model.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export type CsvMeasurementUnitMapping =
  | {
      readonly kind: 'column';
      readonly field: string;
    }
  | {
      readonly kind: 'constant';
      readonly value: string;
    };

/** Transport-field mapping only; requiredness and reporting semantics remain in the series contract. */
export interface CsvMeasurementMapping {
  readonly schemaVersion: 'csv-measurement-mapping/v1';
  readonly mappingVersionId: string;
  readonly csvContractId: string;
  readonly csvContractVersion: string;
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly observedAtField: string;
  readonly valueField: string;
  readonly unit: CsvMeasurementUnitMapping;
  readonly timestampFormat: 'fixed_millisecond_utc';
  readonly authorizationId: string;
}

interface CsvMeasurementLocator {
  readonly recordNumber: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly rowFingerprint: string;
  readonly identityHash: string;
}

export type CsvMeasurementNormalizationOutcome =
  | (CsvMeasurementLocator & {
      readonly kind: 'accepted';
      readonly observationId: string;
    })
  | (CsvMeasurementLocator & {
      readonly kind: 'quarantine';
      readonly reason: QuarantineReason;
      readonly observationId: string | null;
    });

export interface CsvMeasurementNormalizationResult {
  readonly schemaVersion: 'csv-measurement-normalization-result/v1';
  readonly sourceDisposition: CsvIngestionResult['sourceDisposition'];
  readonly sourceRejectionReason: CsvSourceRejectionReason | null;
  readonly routing: CsvIngestionResult;
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly requiredSeriesContractHash: string;
  readonly mappingHash: string;
  readonly conversionRuleSetHash: string;
  readonly normalizationCandidateCount: number;
  readonly acceptedObservationCount: number;
  readonly quarantinedCandidateCount: number;
  readonly outcomes: readonly CsvMeasurementNormalizationOutcome[];
  readonly observations: readonly Observation[];
  readonly numericObservations: readonly NumericObservationValue[];
  readonly normalizationHash: string;
}

export interface CsvMeasurementNormalizationInput {
  readonly csvContract: CsvAdapterSourceContract;
  readonly sourceBytes: Uint8Array;
  readonly mapping: CsvMeasurementMapping;
  readonly requiredSeriesContract: RequiredSeriesContract;
  readonly conversionRules: readonly UnitConversionRule[];
}

export interface CsvMeasurementGovernanceInput {
  readonly csvContract: CsvAdapterSourceContract;
  readonly mapping: CsvMeasurementMapping;
  readonly requiredSeriesContract: RequiredSeriesContract;
  readonly conversionRules: readonly UnitConversionRule[];
}

export interface CsvMeasurementGovernanceBinding {
  readonly schemaVersion: 'csv-measurement-governance-binding/v1';
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly requiredSeriesContractHash: string;
  readonly csvContractHash: string;
  readonly mappingHash: string;
  readonly conversionRuleSetHash: string;
  readonly governanceHash: string;
}

interface NormalizedCsvMeasurementGovernance {
  readonly csvContract: CsvAdapterSourceContract;
  readonly mapping: CsvMeasurementMapping;
  readonly requiredContract: RequiredSeriesContract;
  readonly rules: readonly UnitConversionRule[];
  readonly binding: CsvMeasurementGovernanceBinding;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function createUnitMapping(value: unknown): CsvMeasurementUnitMapping {
  const label = 'csvMeasurementMapping.unit';
  const record = requireStrictRecord(value, ['kind'], ['field', 'value'], label);
  if (record.kind === 'column') {
    const exact = requireStrictRecord(record, ['kind', 'field'], [], label);
    return deepFreeze({
      kind: 'column',
      field: requiredString(exact, 'field', label),
    });
  }
  if (record.kind === 'constant') {
    const exact = requireStrictRecord(record, ['kind', 'value'], [], label);
    return deepFreeze({
      kind: 'constant',
      value: requiredString(exact, 'value', label),
    });
  }
  throw new TypeError(`${label}.kind must be column or constant`);
}

/** Strictly reconstruct an authorized transport-field mapping. */
export function createCsvMeasurementMapping(value: unknown): CsvMeasurementMapping {
  const label = 'csvMeasurementMapping';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'mappingVersionId',
      'csvContractId',
      'csvContractVersion',
      'requiredSeriesContractId',
      'requiredSeriesContractVersion',
      'observedAtField',
      'valueField',
      'unit',
      'timestampFormat',
      'authorizationId',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'csv-measurement-mapping/v1') {
    throw new TypeError(`${label}.schemaVersion must be csv-measurement-mapping/v1`);
  }
  if (record.timestampFormat !== 'fixed_millisecond_utc') {
    throw new TypeError(`${label}.timestampFormat must be fixed_millisecond_utc`);
  }
  const observedAtField = requiredString(record, 'observedAtField', label);
  const valueField = requiredString(record, 'valueField', label);
  const unit = createUnitMapping(record.unit);
  const fieldRoles = [observedAtField, valueField, ...(unit.kind === 'column' ? [unit.field] : [])];
  if (new Set(fieldRoles).size !== fieldRoles.length) {
    throw new RangeError(`${label} field roles must reference distinct columns`);
  }
  return deepFreeze({
    schemaVersion: 'csv-measurement-mapping/v1',
    mappingVersionId: requiredString(record, 'mappingVersionId', label),
    csvContractId: requiredString(record, 'csvContractId', label),
    csvContractVersion: requiredString(record, 'csvContractVersion', label),
    requiredSeriesContractId: requiredString(record, 'requiredSeriesContractId', label),
    requiredSeriesContractVersion: requiredString(record, 'requiredSeriesContractVersion', label),
    observedAtField,
    valueField,
    unit,
    timestampFormat: 'fixed_millisecond_utc',
    authorizationId: requiredString(record, 'authorizationId', label),
  });
}

/** Content-address the complete normalized CSV measurement mapping. */
export function hashCsvMeasurementMapping(mapping: CsvMeasurementMapping): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'csv-measurement-mapping-binding/v1',
      mapping: createCsvMeasurementMapping(mapping),
    }),
  );
}

function validateMappingBindings(
  csvContract: CsvAdapterSourceContract,
  mapping: CsvMeasurementMapping,
  requiredContract: RequiredSeriesContract,
): void {
  if (
    mapping.mappingVersionId !== csvContract.mappingVersionId ||
    mapping.csvContractId !== csvContract.contractId ||
    mapping.csvContractVersion !== csvContract.version
  ) {
    throw new RangeError('CSV measurement mapping does not match its adapter/source contract');
  }
  if (
    mapping.requiredSeriesContractId !== requiredContract.contractId ||
    mapping.requiredSeriesContractVersion !== requiredContract.version
  ) {
    throw new RangeError('CSV measurement mapping does not match its required-series contract');
  }
  if (
    csvContract.tenantId !== requiredContract.tenantId ||
    csvContract.systemId !== requiredContract.systemId
  ) {
    throw new RangeError(
      'CSV and required-series contracts must have identical tenant/system scope',
    );
  }
  if (
    instantMilliseconds(csvContract.effectiveRange.start) >=
      instantMilliseconds(requiredContract.effectiveRange.end) ||
    instantMilliseconds(requiredContract.effectiveRange.start) >=
      instantMilliseconds(csvContract.effectiveRange.end)
  ) {
    throw new RangeError('CSV and required-series contract effective ranges must overlap');
  }
  if (mapping.authorizationId !== csvContract.approvals.jurisdictionMappingReviewId) {
    throw new RangeError('CSV measurement mapping authorization does not match contract review');
  }
  const columnNames = new Set(csvContract.columns.map(({ sourceName }) => sourceName));
  const mappedFields = [
    mapping.observedAtField,
    mapping.valueField,
    ...(mapping.unit.kind === 'column' ? [mapping.unit.field] : []),
  ];
  if (mappedFields.some((field) => !columnNames.has(field))) {
    throw new RangeError('CSV measurement mapping fields must reference declared source columns');
  }
  if (!csvContract.identityFields.includes(mapping.observedAtField)) {
    throw new RangeError(
      'CSV reconciliation requires the mapped observed-at field in source identityFields',
    );
  }
}

function normalizeRules(
  value: unknown,
  requiredContract: RequiredSeriesContract,
  mapping: CsvMeasurementMapping,
): readonly UnitConversionRule[] {
  const rules = requireStrictArray(value, 'csvMeasurementNormalization.conversionRules')
    .map(createUnitConversionRule)
    .sort(
      (left, right) =>
        compareCodeUnits(left.ruleId, right.ruleId) ||
        compareCodeUnits(left.version, right.version),
    );
  if (rules.length === 0 || rules.length > MAX_CONVERSION_RULES) {
    throw new RangeError(
      `CSV measurement normalization requires 1 through ${MAX_CONVERSION_RULES.toString()} conversion rules`,
    );
  }
  const keys = rules.map(({ ruleId, version }) => `${ruleId}\u0000${version}`);
  if (new Set(keys).size !== keys.length) {
    throw new RangeError('CSV measurement conversion rule ID/version pairs must be unique');
  }
  if (
    rules.some(
      ({ parameterCode, canonicalUnit }) =>
        parameterCode !== requiredContract.parameterCode ||
        canonicalUnit !== requiredContract.canonicalUnit,
    )
  ) {
    throw new RangeError('CSV measurement conversion rules do not match the required series');
  }
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    const left = rules[leftIndex];
    /* v8 ignore next -- strict dense-array reconstruction guarantees indexed rules exist. */
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const right = rules[rightIndex];
      /* v8 ignore next -- strict dense-array reconstruction guarantees indexed rules exist. */
      if (right === undefined) {
        continue;
      }
      if (
        left.sourceUnit === right.sourceUnit &&
        instantMilliseconds(left.effectiveRange.start) <
          instantMilliseconds(right.effectiveRange.end) &&
        instantMilliseconds(right.effectiveRange.start) <
          instantMilliseconds(left.effectiveRange.end)
      ) {
        throw new RangeError('CSV measurement conversion rules cannot overlap for one source unit');
      }
    }
  }
  const constantUnit = mapping.unit.kind === 'constant' ? mapping.unit.value : null;
  if (constantUnit !== null && !rules.some(({ sourceUnit }) => sourceUnit === constantUnit)) {
    throw new RangeError('CSV measurement constant unit has no governed conversion rule');
  }
  return deepFreeze(rules);
}

function conversionRuleSetHash(rules: readonly UnitConversionRule[]): string {
  return sha256(canonicalJson({ schemaVersion: 'unit-conversion-rule-set-binding/v1', rules }));
}

function normalizeCsvMeasurementGovernance(
  input: CsvMeasurementGovernanceInput,
): NormalizedCsvMeasurementGovernance {
  const outer = requireStrictRecord(
    input,
    ['csvContract', 'mapping', 'requiredSeriesContract', 'conversionRules'],
    [],
    'csvMeasurementGovernance',
  );
  const csvContract = createCsvAdapterSourceContract(outer.csvContract);
  const mapping = createCsvMeasurementMapping(outer.mapping);
  const requiredContract = createRequiredSeriesContract(outer.requiredSeriesContract);
  validateMappingBindings(csvContract, mapping, requiredContract);
  const rules = normalizeRules(outer.conversionRules, requiredContract, mapping);
  const base = {
    schemaVersion: 'csv-measurement-governance-binding/v1' as const,
    requiredSeriesContractId: requiredContract.contractId,
    requiredSeriesContractVersion: requiredContract.version,
    requiredSeriesContractHash: hashRequiredSeriesContract(requiredContract),
    csvContractHash: hashCsvAdapterSourceContract(csvContract),
    mappingHash: hashCsvMeasurementMapping(mapping),
    conversionRuleSetHash: conversionRuleSetHash(rules),
  };
  return deepFreeze({
    csvContract,
    mapping,
    requiredContract,
    rules,
    binding: {
      ...base,
      governanceHash: sha256(
        canonicalJson({
          schemaVersion: 'csv-measurement-governance-set-binding/v1',
          governance: base,
        }),
      ),
    },
  });
}

/** Validate and content-address source-independent measurement governance before data arrives. */
export function bindCsvMeasurementGovernance(
  input: CsvMeasurementGovernanceInput,
): CsvMeasurementGovernanceBinding {
  return normalizeCsvMeasurementGovernance(input).binding;
}

function observationId(
  rowFingerprint: string,
  requiredSeriesContractHash: string,
  mappingHash: string,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'csv-measurement-observation-identity/v1',
      rowFingerprint,
      requiredSeriesContractHash,
      mappingHash,
    }),
  );
}

function applicableRule(
  rules: readonly UnitConversionRule[],
  sourceUnit: string,
  observedMilliseconds: number,
): UnitConversionRule | undefined {
  return rules.find(
    (rule) =>
      rule.sourceUnit === sourceUnit &&
      instantMilliseconds(rule.effectiveRange.start) <= observedMilliseconds &&
      observedMilliseconds < instantMilliseconds(rule.effectiveRange.end),
  );
}

function withNormalizationHash(
  result: Omit<CsvMeasurementNormalizationResult, 'normalizationHash'>,
): CsvMeasurementNormalizationResult {
  return deepFreeze({
    ...result,
    normalizationHash: sha256(
      canonicalJson({
        schemaVersion: 'csv-measurement-normalization-binding/v1',
        result,
      }),
    ),
  });
}

/**
 * Route exact source bytes, then normalize every routing-accepted row exactly once.
 * Timestamp, range, unit, and numeric ambiguity quarantine rather than being repaired.
 */
export function normalizeCsvMeasurements(
  input: CsvMeasurementNormalizationInput,
): CsvMeasurementNormalizationResult {
  const outer = requireStrictRecord(
    input,
    ['csvContract', 'sourceBytes', 'mapping', 'requiredSeriesContract', 'conversionRules'],
    [],
    'csvMeasurementNormalization',
  );
  const governance = normalizeCsvMeasurementGovernance({
    csvContract: outer.csvContract as CsvAdapterSourceContract,
    mapping: outer.mapping as CsvMeasurementMapping,
    requiredSeriesContract: outer.requiredSeriesContract as RequiredSeriesContract,
    conversionRules: outer.conversionRules as readonly UnitConversionRule[],
  });
  const { csvContract, mapping, requiredContract, rules } = governance;
  if (!(outer.sourceBytes instanceof Uint8Array)) {
    throw new TypeError('csvMeasurementNormalization.sourceBytes must be a Uint8Array');
  }
  const routing = ingestCsvSource(csvContract, outer.sourceBytes);
  const requiredSeriesContractHash = governance.binding.requiredSeriesContractHash;
  const mappingHash = governance.binding.mappingHash;
  const ruleSetHash = governance.binding.conversionRuleSetHash;
  const base = {
    schemaVersion: 'csv-measurement-normalization-result/v1' as const,
    sourceDisposition: routing.sourceDisposition,
    sourceRejectionReason: routing.reason,
    routing,
    requiredSeriesContractId: requiredContract.contractId,
    requiredSeriesContractVersion: requiredContract.version,
    requiredSeriesContractHash,
    mappingHash,
    conversionRuleSetHash: ruleSetHash,
  };
  if (routing.sourceDisposition !== 'routed') {
    return withNormalizationHash({
      ...base,
      normalizationCandidateCount: 0,
      acceptedObservationCount: 0,
      quarantinedCandidateCount: 0,
      outcomes: [],
      observations: [],
      numericObservations: [],
    });
  }

  const outcomes: CsvMeasurementNormalizationOutcome[] = [];
  const observations: Observation[] = [];
  const numericObservations: NumericObservationValue[] = [];
  for (const row of routing.outcomes) {
    if (row.kind !== 'accepted') {
      continue;
    }
    const locator = {
      recordNumber: row.recordNumber,
      startLine: row.startLine,
      endLine: row.endLine,
      rowFingerprint: row.rowFingerprint,
      identityHash: row.identityHash,
    };
    const id = observationId(row.rowFingerprint, requiredSeriesContractHash, mappingHash);
    const observedAt = row.values[mapping.observedAtField];
    let observedMilliseconds: number;
    try {
      observedMilliseconds = instantMilliseconds(observedAt ?? '', 'CSV measurement observedAt');
    } catch {
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        reason: 'ambiguous_timestamp',
        observationId: null,
      });
      continue;
    }

    let quarantineReason: QuarantineReason | null = null;
    if (
      observedMilliseconds < instantMilliseconds(csvContract.effectiveRange.start) ||
      observedMilliseconds >= instantMilliseconds(csvContract.effectiveRange.end) ||
      observedMilliseconds < instantMilliseconds(requiredContract.effectiveRange.start) ||
      observedMilliseconds >= instantMilliseconds(requiredContract.effectiveRange.end)
    ) {
      quarantineReason = 'unmapped_value';
    }
    const sourceUnit =
      mapping.unit.kind === 'constant'
        ? mapping.unit.value
        : (row.values[mapping.unit.field] ?? '');
    const rule =
      quarantineReason === null
        ? applicableRule(rules, sourceUnit, observedMilliseconds)
        : undefined;
    if (quarantineReason === null && rule === undefined) {
      quarantineReason = 'impossible_unit';
    }

    let numeric: NumericObservationValue | null = null;
    if (quarantineReason === null && rule !== undefined) {
      try {
        numeric = createNumericObservationValue({
          observationId: id,
          contractId: requiredContract.contractId,
          observedAt,
          sourceFingerprint: row.rowFingerprint,
          sourceValue: row.values[mapping.valueField] ?? '',
          sourceUnit,
          conversionRuleId: rule.ruleId,
          conversionRuleVersion: rule.version,
        });
      } catch (error) {
        /* v8 ignore next -- constructed identity/rule fields are validated before this call. */
        if (!(error instanceof TypeError || error instanceof RangeError)) {
          throw error;
        }
        quarantineReason = 'malformed_value';
      }
    }

    if (quarantineReason !== null) {
      const observation = createObservation({
        observationId: id,
        contractId: requiredContract.contractId,
        observedAt,
        sourceFingerprint: row.rowFingerprint,
        qualityState: 'quarantined',
        quarantineReason,
      });
      observations.push(observation);
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        reason: quarantineReason,
        observationId: id,
      });
      continue;
    }

    /* v8 ignore next -- a null numeric value always sets malformed_value above. */
    if (numeric === null) {
      throw new RangeError('CSV measurement numeric normalization invariant failed');
    }
    const observation = createObservation({
      observationId: id,
      contractId: requiredContract.contractId,
      observedAt,
      sourceFingerprint: row.rowFingerprint,
      qualityState: 'accepted',
    });
    observations.push(observation);
    numericObservations.push(numeric);
    outcomes.push({ kind: 'accepted', ...locator, observationId: id });
  }

  const acceptedObservationCount = numericObservations.length;
  const quarantinedCandidateCount = outcomes.length - acceptedObservationCount;
  /* v8 ignore next -- the loop visits every routing-accepted row exactly once. */
  if (outcomes.length !== routing.acceptedCount) {
    throw new RangeError('CSV measurement normalization did not account for every candidate row');
  }
  return withNormalizationHash({
    ...base,
    normalizationCandidateCount: routing.acceptedCount,
    acceptedObservationCount,
    quarantinedCandidateCount,
    outcomes,
    observations,
    numericObservations,
  });
}
