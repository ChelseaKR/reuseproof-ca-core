import { describe, expect, it } from 'vitest';

import {
  bindCsvMeasurementGovernance,
  createCsvMeasurementMapping,
  evaluateDailyNumericAggregate,
  hashCsvMeasurementMapping,
  normalizeCsvMeasurements,
  reconcileCsvMeasurementSources,
  type CsvAdapterSourceContract,
  type CsvMeasurementMapping,
  type CsvMeasurementNormalizationInput,
  type DailyNumericAggregateInput,
  type PlausibilityPolicy,
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

describe('governed sentinel and plausibility policy (#51)', () => {
  const aggregatePolicy = {
    schemaVersion: 'daily-aggregate-policy/v1',
    policyId: 'daily-policy-1',
    version: '1',
    contractId: 'contract-1',
    method: 'minimum',
    decimalPlaces: 2,
    roundingMode: 'half_away_from_zero',
    timeZone: 'UTC',
    authorizationId: 'profile-1',
  };

  function plausibilityPolicyInput(
    overrides: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      schemaVersion: 'plausibility-policy/v1',
      policyId: 'plausibility-1',
      version: '1',
      sentinelLiterals: ['-9999', 'ERR', ''],
      plausibleRanges: [
        {
          parameterCode: 'flow.treated.daily_avg',
          canonicalUnit: 'canonical-unit',
          minimum: '0',
          maximum: '10',
        },
      ],
      authorizationId: 'plausibility-review-1',
      ...overrides,
    };
  }

  function dailyMinimum(result: ReturnType<typeof normalizeCsvMeasurements>): string | undefined {
    const aggregate = evaluateDailyNumericAggregate({
      coverageEvaluation: {
        contract: requiredContractInput(),
        reportRange: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' },
        lifecycleState: 'in_service',
        observations: result.observations,
        scheduledNonoperations: [],
      },
      numericObservations: result.numericObservations,
      conversionRules: [ruleInput()],
      policy: aggregatePolicy,
    } as unknown as DailyNumericAggregateInput);
    return aggregate.values[0]?.value;
  }

  // The defect, stated as a measurement. The conversion rule halves the source value, so a
  // vendor's -9999 fault marker reaches the daily minimum as -4999.50 -- a treatment plant
  // reporting a negative flow, published as the day's lowest reading.
  const faultSource = [
    header,
    'a,2026-01-01T00:05:00.000Z,2,source-unit',
    'b,2026-01-01T00:35:00.000Z,-9999,source-unit',
  ].join('\n');

  it('publishes a vendor fault marker as the daily minimum when no policy governs the series', () => {
    const result = normalizeCsvMeasurements(normalizationInput(faultSource));

    expect(result.plausibilityPolicyHash).toBeNull();
    expect(result.acceptedObservationCount).toBe(2);
    expect(dailyMinimum(result)).toBe('-4999.50');
  });

  it('quarantines the same marker as sensor_sentinel once a policy governs the series', () => {
    const result = normalizeCsvMeasurements(
      normalizationInput(faultSource, { plausibilityPolicy: plausibilityPolicyInput() }),
    );

    expect(result.plausibilityPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.acceptedObservationCount).toBe(1);
    expect(
      result.outcomes
        .filter((outcome) => outcome.kind === 'quarantine')
        .map(({ reason }) => reason),
    ).toEqual(['sensor_sentinel']);
    // Quarantined, not dropped: the row is still an observation a reader can count.
    expect(result.observations).toHaveLength(2);
    expect(result.observations.filter((o) => o.qualityState === 'quarantined')).toHaveLength(1);
    expect(dailyMinimum(result)).toBe('1.00');
  });

  it('names a non-numeric fault marker as a sentinel rather than as a malformed value', () => {
    const source = [
      header,
      'a,2026-01-01T00:05:00.000Z,2,source-unit',
      'b,2026-01-01T00:35:00.000Z,ERR,source-unit',
    ].join('\n');

    const ungoverned = normalizeCsvMeasurements(normalizationInput(source));
    const governed = normalizeCsvMeasurements(
      normalizationInput(source, { plausibilityPolicy: plausibilityPolicyInput() }),
    );

    // Both refuse the row. Only the governed one says the vendor wrote exactly what its
    // documentation says a faulting sensor writes, rather than that the file was malformed.
    expect(
      ungoverned.outcomes.filter((o) => o.kind === 'quarantine').map(({ reason }) => reason),
    ).toEqual(['malformed_value']);
    expect(
      governed.outcomes.filter((o) => o.kind === 'quarantine').map(({ reason }) => reason),
    ).toEqual(['sensor_sentinel']);
  });

  it('compares a plausible bound in the canonical unit, not in the source unit', () => {
    // The rule converts source -> canonical by halving, and the approved maximum is 10 canonical
    // units. A source value of 20 is therefore exactly on the bound. Comparing the source value
    // against the same number would refuse it, which is the mistake this fixture exists to catch:
    // 20 is twice the bound as written, and exactly the bound as measured.
    const source = [header, 'a,2026-01-01T00:05:00.000Z,20,source-unit'].join('\n');
    const result = normalizeCsvMeasurements(
      normalizationInput(source, { plausibilityPolicy: plausibilityPolicyInput() }),
    );

    expect(result.acceptedObservationCount).toBe(1);
  });

  it.each([
    ['20', 'accepted', null],
    ['0', 'accepted', null],
    ['20.0000000000000000001', 'quarantine', 'out_of_plausible_range'],
    ['-0.0000000000000000001', 'quarantine', 'out_of_plausible_range'],
    ['30', 'quarantine', 'out_of_plausible_range'],
  ])('decides %s in exact decimal, inclusive at both bounds', (value, kind, reason) => {
    // The two long values differ from a bound in the eighteenth decimal place. Read as a double,
    // 20.0000000000000000001 is exactly 20 and -0.0000000000000000001 is exactly -0, so both
    // would sit on an inclusive bound and be published as readings.
    const source = [header, `a,2026-01-01T00:05:00.000Z,${value},source-unit`].join('\n');
    const result = normalizeCsvMeasurements(
      normalizationInput(source, { plausibilityPolicy: plausibilityPolicyInput() }),
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.kind).toBe(kind);
    expect(result.outcomes[0]?.kind === 'quarantine' ? result.outcomes[0].reason : null).toBe(
      reason,
    );
  });

  it('never moves a row from quarantined to accepted, whatever the policy says', () => {
    // The safety property that makes a policy safe to introduce: binding one can refuse readings
    // and can rename a refusal, and can never turn a refused row into a published measurement.
    const source = [
      header,
      'a,2026-01-01T00:05:00.000Z,2,source-unit',
      'b,2026-01-01T00:35:00.000Z,-9999,source-unit',
      'c,2026-01-01T00:45:00.000Z,bad,source-unit',
      'd,bad-time,3,source-unit',
      'e,2026-01-01T02:00:00.000Z,5,source-unit',
      'f,2026-01-01T00:15:00.000Z,5,unknown-unit',
    ].join('\n');
    const ungoverned = normalizeCsvMeasurements(normalizationInput(source));
    const governed = normalizeCsvMeasurements(
      normalizationInput(source, { plausibilityPolicy: plausibilityPolicyInput() }),
    );

    expect(governed.outcomes).toHaveLength(ungoverned.outcomes.length);
    for (const [index, before] of ungoverned.outcomes.entries()) {
      const after = governed.outcomes[index];
      expect(after?.rowFingerprint).toBe(before.rowFingerprint);
      if (before.kind === 'quarantine') {
        expect(after?.kind).toBe('quarantine');
      }
    }
    expect(governed.acceptedObservationCount).toBeLessThanOrEqual(
      ungoverned.acceptedObservationCount,
    );
  });

  it('refuses a policy that could decide nothing about this series', () => {
    // No sentinel literals, and a range for a parameter this contract does not report. Accepting
    // it would put an approved policy id and hash into the receipt with nothing behind them.
    expect(() =>
      normalizeCsvMeasurements(
        normalizationInput(faultSource, {
          plausibilityPolicy: plausibilityPolicyInput({
            sentinelLiterals: [],
            plausibleRanges: [
              { parameterCode: 'ph', canonicalUnit: 'su', minimum: '0', maximum: '14' },
            ],
          }),
        }),
      ),
    ).toThrow('declares no sentinel literals and no plausible range for parameter');
  });

  it('refuses a range declared for the right parameter in the wrong canonical unit', () => {
    expect(() =>
      normalizeCsvMeasurements(
        normalizationInput(faultSource, {
          plausibilityPolicy: plausibilityPolicyInput({
            sentinelLiterals: [],
            plausibleRanges: [
              {
                parameterCode: 'flow.treated.daily_avg',
                canonicalUnit: 'not-the-canonical-unit',
                minimum: '0',
                maximum: '10',
              },
            ],
          }),
        }),
      ),
    ).toThrow('no plausible range for parameter');
  });

  it('carries the policy into the governance binding and moves its hash with a bound', () => {
    const base = {
      csvContract: csvContractInput() as unknown as CsvAdapterSourceContract,
      mapping: mappingInput() as unknown as CsvMeasurementMapping,
      requiredSeriesContract: requiredContractInput() as unknown as RequiredSeriesContract,
      conversionRules: [ruleInput() as unknown as UnitConversionRule],
    };
    const ungoverned = bindCsvMeasurementGovernance(base);
    const governed = bindCsvMeasurementGovernance({
      ...base,
      plausibilityPolicy: plausibilityPolicyInput() as unknown as PlausibilityPolicy,
    });
    const widened = bindCsvMeasurementGovernance({
      ...base,
      plausibilityPolicy: plausibilityPolicyInput({
        plausibleRanges: [
          {
            parameterCode: 'flow.treated.daily_avg',
            canonicalUnit: 'canonical-unit',
            minimum: '0',
            maximum: '11',
          },
        ],
      }) as unknown as PlausibilityPolicy,
    });

    expect(ungoverned.plausibilityPolicyHash).toBeNull();
    expect(governed.plausibilityPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(widened.plausibilityPolicyHash).not.toBe(governed.plausibilityPolicyHash);
    // Two policies differing only in a bound must give the whole governance set two identities,
    // or a receipt could not tell which rule produced the numbers it carries.
    expect(widened.governanceHash).not.toBe(governed.governanceHash);
    expect(governed.governanceHash).not.toBe(ungoverned.governanceHash);
  });

  it('refuses to reconcile two sources judged by different plausibility policies', () => {
    const sources = [
      normalizationInput([header, 'a,2026-01-01T00:05:00.000Z,2,source-unit'].join('\n'), {
        plausibilityPolicy: plausibilityPolicyInput(),
      }),
      normalizationInput([header, 'b,2026-01-01T00:35:00.000Z,4,source-unit'].join('\n'), {
        plausibilityPolicy: plausibilityPolicyInput({ policyId: 'plausibility-2' }),
      }),
    ];

    expect(() => reconcileCsvMeasurementSources({ sources })).toThrow(
      'must share identical governed contracts',
    );
  });

  it('carries one policy through reconciliation when both sources share it', () => {
    const policy = plausibilityPolicyInput();
    const result = reconcileCsvMeasurementSources({
      sources: [
        normalizationInput([header, 'a,2026-01-01T00:05:00.000Z,2,source-unit'].join('\n'), {
          plausibilityPolicy: policy,
        }),
        normalizationInput([header, 'b,2026-01-01T00:35:00.000Z,-9999,source-unit'].join('\n'), {
          plausibilityPolicy: policy,
        }),
      ],
    });

    expect(result.plausibilityPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.acceptedIdentityCount).toBe(1);
    expect(
      result.outcomes.filter((o) => o.kind === 'quarantine').map(({ reason }) => reason),
    ).toEqual(['sensor_sentinel']);
  });
});
