import { describe, expect, it } from 'vitest';

import {
  createCsvMeasurementMapping,
  evaluateDailyNumericAggregate,
  hashCsvMeasurementMapping,
  normalizeCsvMeasurements,
  type CsvAdapterSourceContract,
  type CsvMeasurementMapping,
  type CsvMeasurementNormalizationInput,
  type DailyNumericAggregateInput,
  type RequiredSeriesContract,
  type UnitConversionRule,
} from '../src/index.js';
import { contractInput } from './helpers.js';

function csvContractInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'csv-adapter-source-contract/v1',
    contractId: 'csv-contract-1',
    version: '1',
    adapterId: 'generic-csv',
    mappingVersionId: 'measurement-mapping-1',
    sourceSchemaVersion: 'synthetic-v1',
    tenantId: 'tenant-1',
    systemId: 'system-1',
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    transport: { kind: 'customer_pushed_csv', encoding: 'utf-8', delimiter: ',' },
    columns: [
      { sourceName: 'id', requiredInSourceRow: true },
      { sourceName: 'observed_at', requiredInSourceRow: true },
      { sourceName: 'value', requiredInSourceRow: true },
      { sourceName: 'unit', requiredInSourceRow: true },
    ],
    identityFields: ['id', 'observed_at'],
    informationalDeliveryCadence: 'nominally every 30 minutes',
    approvals: {
      vendorOperatorReviewId: 'vendor-review-1',
      jurisdictionMappingReviewId: 'mapping-review-1',
      securityReviewId: 'security-review-1',
    },
    limits: { maxBytes: 10_000, maxRecords: 100, maxFieldBytes: 100 },
    ...overrides,
  };
}

function requiredContractInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return contractInput({
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    cadenceMinutes: 30,
    timezone: 'UTC',
    canonicalUnit: 'canonical-unit',
    ...overrides,
  });
}

function mappingInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'csv-measurement-mapping/v1',
    mappingVersionId: 'measurement-mapping-1',
    csvContractId: 'csv-contract-1',
    csvContractVersion: '1',
    requiredSeriesContractId: 'contract-1',
    requiredSeriesContractVersion: '1',
    observedAtField: 'observed_at',
    valueField: 'value',
    unit: { kind: 'column', field: 'unit' },
    timestampFormat: 'fixed_millisecond_utc',
    authorizationId: 'mapping-review-1',
    ...overrides,
  };
}

function ruleInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'unit-conversion-rule/v1',
    ruleId: 'conversion-1',
    version: '1',
    parameterCode: 'flow.treated.daily_avg',
    sourceUnit: 'source-unit',
    canonicalUnit: 'canonical-unit',
    sourceOffset: '0',
    multiplierNumerator: '1',
    multiplierDenominator: '2',
    effectiveRange: {
      start: '2025-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    },
    authorizationId: 'unit-dictionary-1',
    ...overrides,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function normalizationInput(
  source: string,
  overrides: Readonly<Record<string, unknown>> = {},
): CsvMeasurementNormalizationInput {
  return {
    csvContract: csvContractInput() as unknown as CsvAdapterSourceContract,
    sourceBytes: bytes(source),
    mapping: mappingInput() as unknown as CsvMeasurementMapping,
    requiredSeriesContract: requiredContractInput() as unknown as RequiredSeriesContract,
    conversionRules: [ruleInput() as unknown as UnitConversionRule],
    ...overrides,
  };
}

const header = 'id,observed_at,value,unit';

describe('CSV measurement mapping boundary', () => {
  it('strictly reconstructs, freezes, and content-addresses the mapping', () => {
    const mapping = createCsvMeasurementMapping(mappingInput());
    const replay = createCsvMeasurementMapping({ ...mappingInput(), unit: { ...mapping.unit } });

    expect(Object.isFrozen(mapping)).toBe(true);
    expect(Object.isFrozen(mapping.unit)).toBe(true);
    expect(hashCsvMeasurementMapping(replay)).toBe(hashCsvMeasurementMapping(mapping));
  });

  it.each([
    [{ schemaVersion: 'csv-measurement-mapping/v2' }, 'schemaVersion'],
    [{ timestampFormat: 'vendor_local' }, 'timestampFormat'],
    [{ observedAtField: '' }, 'non-empty string'],
    [{ valueField: 'observed_at' }, 'distinct columns'],
    [{ unit: { kind: 'column', field: 'value' } }, 'distinct columns'],
    [{ unit: { kind: 'constant', value: '' } }, 'non-empty string'],
    [{ unit: { kind: 'guess', value: 'source-unit' } }, 'column or constant'],
    [{ unit: { kind: 'column', field: 'unit', value: 'extra' } }, 'unsupported keys'],
    [{ extra: true }, 'unsupported keys'],
  ])('rejects an unsafe mapping %#', (overrides, message) => {
    expect(() => createCsvMeasurementMapping(mappingInput(overrides))).toThrow(message);
  });
});

describe('normalizeCsvMeasurements', () => {
  it('accounts for every routing candidate and preserves typed fail-closed quarantines', () => {
    const source = [
      header,
      'a,2026-01-01T00:05:00.000Z,2,source-unit',
      'a,2026-01-01T00:05:00.000Z,9,source-unit',
      'b,2026-01-01T00:35:00.000Z,4,source-unit',
      'c,2026-01-01T00:45:00.000Z,bad,source-unit',
      'd,bad-time,3,source-unit',
      'e,2026-01-01T02:00:00.000Z,5,source-unit',
      'f,2026-01-01T00:15:00.000Z,5,unknown-unit',
    ].join('\n');
    const result = normalizeCsvMeasurements(normalizationInput(source));

    expect(result.routing).toMatchObject({
      sourceDisposition: 'routed',
      receivedRecordCount: 7,
      acceptedCount: 6,
      duplicateCount: 1,
      quarantineCount: 0,
    });
    expect(result).toMatchObject({
      sourceDisposition: 'routed',
      sourceRejectionReason: null,
      normalizationCandidateCount: 6,
      acceptedObservationCount: 2,
      quarantinedCandidateCount: 4,
    });
    expect(result.outcomes.map(({ kind }) => kind)).toEqual([
      'accepted',
      'accepted',
      'quarantine',
      'quarantine',
      'quarantine',
      'quarantine',
    ]);
    expect(
      result.outcomes
        .filter((outcome) => outcome.kind === 'quarantine')
        .map(({ reason, observationId }) => [reason, observationId === null]),
    ).toEqual([
      ['malformed_value', false],
      ['ambiguous_timestamp', true],
      ['unmapped_value', false],
      ['impossible_unit', false],
    ]);
    expect(result.observations).toHaveLength(5);
    expect(result.numericObservations).toHaveLength(2);
    expect(result.numericObservations[0]).toMatchObject({
      sourceValue: '2',
      sourceUnit: 'source-unit',
      conversionRuleId: 'conversion-1',
      conversionRuleVersion: '1',
    });
    expect(result.requiredSeriesContractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mappingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.conversionRuleSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.normalizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outcomes)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.numericObservations)).toBe(true);
  });

  it('feeds the exact accepted observations and numeric preimages into aggregation', () => {
    const source = [
      header,
      'a,2026-01-01T00:05:00.000Z,2,source-unit',
      'b,2026-01-01T00:35:00.000Z,4,source-unit',
    ].join('\n');
    const requiredSeriesContract = requiredContractInput();
    const conversionRules = [ruleInput()];
    const result = normalizeCsvMeasurements(
      normalizationInput(source, {
        requiredSeriesContract: requiredSeriesContract as unknown as RequiredSeriesContract,
        conversionRules: conversionRules as unknown as UnitConversionRule[],
      }),
    );
    const aggregate = evaluateDailyNumericAggregate({
      coverageEvaluation: {
        contract: requiredSeriesContract,
        reportRange: {
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-01-01T01:00:00.000Z',
        },
        lifecycleState: 'in_service',
        observations: result.observations,
        scheduledNonoperations: [],
      },
      numericObservations: result.numericObservations,
      conversionRules,
      policy: {
        schemaVersion: 'daily-aggregate-policy/v1',
        policyId: 'daily-policy-1',
        version: '1',
        contractId: 'contract-1',
        method: 'mean',
        decimalPlaces: 2,
        roundingMode: 'half_away_from_zero',
        timeZone: 'UTC',
        authorizationId: 'profile-1',
      },
    } as unknown as DailyNumericAggregateInput);

    expect(aggregate.values).toEqual([
      {
        civilDate: '2026-01-01',
        value: '1.50',
        canonicalUnit: 'canonical-unit',
        acceptedObservationCount: 2,
        observationIds: result.numericObservations.map(({ observationId }) => observationId),
      },
    ]);
    expect(aggregate.conversionRuleSetHash).toBe(result.conversionRuleSetHash);
  });

  it('supports a constant governed unit and adjacent effective rule versions', () => {
    const contract = csvContractInput({
      columns: [
        { sourceName: 'id', requiredInSourceRow: true },
        { sourceName: 'observed_at', requiredInSourceRow: true },
        { sourceName: 'value', requiredInSourceRow: true },
      ],
      identityFields: ['id', 'observed_at'],
    });
    const mapping = mappingInput({ unit: { kind: 'constant', value: 'source-unit' } });
    const rules = [
      ruleInput({
        effectiveRange: {
          start: '2025-01-01T00:00:00.000Z',
          end: '2026-01-01T00:30:00.000Z',
        },
      }),
      ruleInput({
        ruleId: 'conversion-2',
        version: '2',
        multiplierNumerator: '2',
        effectiveRange: {
          start: '2026-01-01T00:30:00.000Z',
          end: '2027-01-01T00:00:00.000Z',
        },
      }),
    ];
    const source = [
      'id,observed_at,value',
      'a,2026-01-01T00:05:00.000Z,2',
      'b,2026-01-01T00:35:00.000Z,4',
    ].join('\n');
    const result = normalizeCsvMeasurements(
      normalizationInput(source, {
        csvContract: contract as unknown as CsvAdapterSourceContract,
        mapping: mapping as unknown as CsvMeasurementMapping,
        conversionRules: rules as unknown as UnitConversionRule[],
      }),
    );

    expect(result.numericObservations.map(({ conversionRuleId }) => conversionRuleId)).toEqual([
      'conversion-1',
      'conversion-2',
    ]);
  });

  it('returns a hash-bound empty normalization when source routing rejects the file', () => {
    const input = normalizationInput(`${header}\na,2026-01-01T00:05:00.000Z,2,source-unit`, {
      csvContract: csvContractInput({
        limits: { maxBytes: 20, maxRecords: 100, maxFieldBytes: 100 },
      }) as unknown as CsvAdapterSourceContract,
    });
    const first = normalizeCsvMeasurements(input);
    const replay = normalizeCsvMeasurements({
      ...input,
      sourceBytes: Uint8Array.from(input.sourceBytes),
    });

    expect(first).toMatchObject({
      sourceDisposition: 'rejected_before_persistence',
      sourceRejectionReason: 'byte_limit_exceeded',
      normalizationCandidateCount: 0,
      acceptedObservationCount: 0,
      quarantinedCandidateCount: 0,
      outcomes: [],
      observations: [],
      numericObservations: [],
    });
    expect(replay).toEqual(first);
  });

  it.each([
    [{ mapping: mappingInput({ mappingVersionId: 'wrong' }) }, 'adapter/source contract'],
    [
      { mapping: mappingInput({ requiredSeriesContractVersion: 'wrong' }) },
      'required-series contract',
    ],
    [
      { requiredSeriesContract: requiredContractInput({ tenantId: 'other' }) },
      'tenant/system scope',
    ],
    [
      {
        requiredSeriesContract: requiredContractInput({
          effectiveRange: {
            start: '2027-01-01T00:00:00.000Z',
            end: '2027-01-01T01:00:00.000Z',
          },
        }),
      },
      'effective ranges must overlap',
    ],
    [{ mapping: mappingInput({ authorizationId: 'unreviewed' }) }, 'authorization'],
    [{ mapping: mappingInput({ observedAtField: 'missing' }) }, 'declared source columns'],
    [
      { conversionRules: [ruleInput({ parameterCode: 'other' })] },
      'do not match the required series',
    ],
    [{ conversionRules: [] }, 'requires 1 through'],
    [{ conversionRules: [ruleInput(), ruleInput()] }, 'ID/version pairs must be unique'],
    [
      {
        conversionRules: [ruleInput(), ruleInput({ ruleId: 'overlap', version: '2' })],
      },
      'cannot overlap',
    ],
    [
      {
        mapping: mappingInput({ unit: { kind: 'constant', value: 'unknown' } }),
      },
      'constant unit has no governed',
    ],
  ])('rejects inconsistent governance input %#', (overrides, message) => {
    const normalizedOverrides = Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        key === 'mapping'
          ? (value as unknown as CsvMeasurementMapping)
          : key === 'requiredSeriesContract'
            ? (value as unknown as RequiredSeriesContract)
            : key === 'conversionRules'
              ? (value as unknown as UnitConversionRule[])
              : value,
      ]),
    );
    expect(() =>
      normalizeCsvMeasurements(
        normalizationInput(
          `${header}\na,2026-01-01T00:05:00.000Z,2,source-unit`,
          normalizedOverrides,
        ),
      ),
    ).toThrow(message);
  });

  it('rejects unsafe outer input and non-byte sources', () => {
    const valid = normalizationInput(`${header}\na,2026-01-01T00:05:00.000Z,2,source-unit`);
    expect(() => normalizeCsvMeasurements({ ...valid, extra: true } as never)).toThrow(
      'unsupported keys',
    );
    expect(() => normalizeCsvMeasurements({ ...valid, sourceBytes: 'csv' } as never)).toThrow(
      'Uint8Array',
    );
  });
});
