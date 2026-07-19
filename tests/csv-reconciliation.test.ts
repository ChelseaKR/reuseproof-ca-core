import { describe, expect, it } from 'vitest';

import {
  evaluateCoverage,
  reconcileCsvMeasurementSources,
  type CsvAdapterSourceContract,
  type CsvMeasurementMapping,
  type CsvMeasurementNormalizationInput,
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

function requiredContractInput(): Record<string, unknown> {
  return contractInput({
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    cadenceMinutes: 30,
    timezone: 'UTC',
    canonicalUnit: 'canonical-unit',
  });
}

function mappingInput(): Record<string, unknown> {
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
  };
}

function ruleInput(): Record<string, unknown> {
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
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sourceInput(
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
const acceptedRow = 'a,2026-01-01T00:05:00.000Z,2,source-unit';

describe('reconcileCsvMeasurementSources', () => {
  it('deduplicates exact source resubmissions before candidate reconciliation', () => {
    const source = sourceInput(`${header}\n${acceptedRow}`);
    const result = reconcileCsvMeasurementSources({ sources: [source, source] });

    expect(result).toMatchObject({
      submittedSourceCount: 2,
      uniqueSourceCount: 1,
      duplicateSourceSubmissionCount: 1,
      submittedCandidateCount: 2,
      uniqueSourceCandidateCount: 1,
      acceptedIdentityCount: 1,
      quarantinedIdentityCount: 0,
      semanticReplayCandidateCount: 0,
    });
    expect(result.sources[0]?.submissionCount).toBe(2);
    expect(result.observations).toHaveLength(1);
    expect(result.numericObservations).toHaveLength(1);
  });

  it('collapses byte-distinct semantic replays independent of source order', () => {
    const left = sourceInput(`${header}\n${acceptedRow}`);
    const right = sourceInput(`${header}\n${acceptedRow}\n`);
    const first = reconcileCsvMeasurementSources({ sources: [left, right] });
    const replay = reconcileCsvMeasurementSources({ sources: [right, left] });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      uniqueSourceCount: 2,
      uniqueSourceCandidateCount: 2,
      acceptedIdentityCount: 1,
      semanticReplayCandidateCount: 1,
      conflictingIdentityCount: 0,
    });
    expect(first.outcomes[0]).toMatchObject({
      kind: 'accepted',
      replayCandidates: [{ normalizationKind: 'accepted' }],
    });
    expect(first.reconciliationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.outcomes)).toBe(true);
  });

  it('replaces conflicting accepted duplicates with one explicit downstream quarantine', () => {
    const left = sourceInput(`${header}\n${acceptedRow}`);
    const right = sourceInput(`${header}\na,2026-01-01T00:05:00.000Z,3,source-unit\n`);
    const result = reconcileCsvMeasurementSources({ sources: [left, right] });

    expect(result).toMatchObject({
      acceptedIdentityCount: 0,
      quarantinedIdentityCount: 1,
      conflictingIdentityCount: 1,
      semanticReplayCandidateCount: 0,
      numericObservations: [],
    });
    expect(result.outcomes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'conflicting_duplicate',
      candidates: [{ normalizationKind: 'accepted' }, { normalizationKind: 'accepted' }],
    });
    expect(result.observations).toEqual([
      expect.objectContaining({
        qualityState: 'quarantined',
        quarantineReason: 'conflicting_duplicate',
      }),
    ]);

    const coverage = evaluateCoverage({
      contract: requiredContractInput() as unknown as RequiredSeriesContract,
      reportRange: {
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T01:00:00.000Z',
      },
      lifecycleState: 'in_service',
      observations: result.observations,
      scheduledNonoperations: [],
    });
    expect(coverage).toMatchObject({ acceptedCount: 0, quarantineCount: 1, gapCount: 2 });
  });

  it('preserves non-conflicting normalization quarantines, including timestamp ambiguity', () => {
    const source = sourceInput(
      [
        header,
        acceptedRow,
        'b,bad-time,4,source-unit',
        'c,2026-01-01T00:35:00.000Z,bad,source-unit',
      ].join('\n'),
    );
    const result = reconcileCsvMeasurementSources({ sources: [source] });

    expect(result).toMatchObject({
      acceptedIdentityCount: 1,
      quarantinedIdentityCount: 2,
      conflictingIdentityCount: 0,
    });
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      'accepted',
      'quarantine',
      'quarantine',
    ]);
    expect(
      result.outcomes
        .filter((outcome) => outcome.kind === 'quarantine')
        .map(({ reason, observationId }) => [reason, observationId === null])
        .sort(),
    ).toEqual([
      ['ambiguous_timestamp', true],
      ['malformed_value', false],
    ]);
    expect(result.observations).toHaveLength(2);
    expect(result.numericObservations).toHaveLength(1);
  });

  it('records rejected unique sources without manufacturing candidates', () => {
    const contract = csvContractInput({
      limits: { maxBytes: 30, maxRecords: 100, maxFieldBytes: 100 },
    });
    const source = sourceInput(`${header}\n${acceptedRow}`, {
      csvContract: contract as unknown as CsvAdapterSourceContract,
    });
    const result = reconcileCsvMeasurementSources({ sources: [source] });

    expect(result).toMatchObject({
      rejectedSourceCount: 1,
      uniqueSourceCandidateCount: 0,
      acceptedIdentityCount: 0,
      quarantinedIdentityCount: 0,
      observations: [],
      numericObservations: [],
    });
  });

  it('keeps a conflicting invalid timestamp explicit even when no observation can be built', () => {
    const left = sourceInput(`${header}\na,bad-time,2,source-unit`);
    const right = sourceInput(`${header}\na,bad-time,3,source-unit\n`);
    const result = reconcileCsvMeasurementSources({ sources: [left, right] });

    expect(result.outcomes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'conflicting_duplicate',
      observationId: null,
    });
    expect(result).toMatchObject({
      quarantinedIdentityCount: 1,
      conflictingIdentityCount: 1,
      observations: [],
      numericObservations: [],
    });
  });

  it('rejects absent timestamp identity, mixed governance, unsafe shape, and unsafe bounds', () => {
    const valid = sourceInput(`${header}\n${acceptedRow}`);
    const missingTimestampIdentity = sourceInput(`${header}\n${acceptedRow}`, {
      csvContract: csvContractInput({
        identityFields: ['id'],
      }) as unknown as CsvAdapterSourceContract,
    });
    expect(() => reconcileCsvMeasurementSources({ sources: [missingTimestampIdentity] })).toThrow(
      'observed-at field in source identityFields',
    );

    const differentContract = sourceInput(`${header}\n${acceptedRow}\n`, {
      csvContract: csvContractInput({
        informationalDeliveryCadence: 'nominally hourly',
      }) as unknown as CsvAdapterSourceContract,
    });
    expect(() => reconcileCsvMeasurementSources({ sources: [valid, differentContract] })).toThrow(
      'identical governed contracts',
    );

    expect(() =>
      reconcileCsvMeasurementSources({ sources: [valid], extra: true } as never),
    ).toThrow('unsupported keys');
    expect(() => reconcileCsvMeasurementSources({ sources: [] })).toThrow('1 through 64');
    expect(() =>
      reconcileCsvMeasurementSources({ sources: Array.from({ length: 65 }, () => valid) }),
    ).toThrow('1 through 64');
  });
});
