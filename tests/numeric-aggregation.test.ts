import { describe, expect, it } from 'vitest';

import {
  createDailyAggregatePolicy,
  createNumericObservationValue,
  createUnitConversionRule,
  evaluateDailyNumericAggregate,
  type CoverageEvaluationInput,
  type DailyAggregateMethod,
  type DailyNumericAggregateInput,
} from '../src/index.js';
import { contractInput, observationInput } from './helpers.js';

function coverageEvaluation(
  observations: readonly Record<string, unknown>[] = [
    observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
    observationInput('observation-2', '2026-01-01T00:35:00.000Z'),
  ],
  contractOverrides: Readonly<Record<string, unknown>> = {},
): CoverageEvaluationInput {
  return {
    contract: contractInput({
      effectiveRange: {
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T01:00:00.000Z',
      },
      cadenceMinutes: 30,
      timezone: 'UTC',
      canonicalUnit: 'canonical-unit',
      ...contractOverrides,
    }) as unknown as CoverageEvaluationInput['contract'],
    reportRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    lifecycleState: 'in_service',
    observations: observations as unknown as CoverageEvaluationInput['observations'],
    scheduledNonoperations: [],
  };
}

function numericObservation(
  observationId: string,
  observedAt: string,
  sourceValue: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    observationId,
    contractId: 'contract-1',
    observedAt,
    sourceFingerprint: `fingerprint-${observationId}`,
    sourceValue,
    sourceUnit: 'source-unit',
    conversionRuleId: 'conversion-1',
    conversionRuleVersion: '1',
    ...overrides,
  };
}

function conversionRule(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
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
    authorizationId: 'unit-dictionary-v1',
    ...overrides,
  };
}

function policy(
  method: DailyAggregateMethod = 'mean',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'daily-aggregate-policy/v1',
    policyId: 'daily-policy-1',
    version: '1',
    contractId: 'contract-1',
    method,
    decimalPlaces: 2,
    roundingMode: 'half_away_from_zero',
    timeZone: 'UTC',
    authorizationId: 'profile-v1',
    ...overrides,
  };
}

function aggregateInput(
  overrides: Readonly<Record<string, unknown>> = {},
): DailyNumericAggregateInput {
  return {
    coverageEvaluation: coverageEvaluation(),
    numericObservations: [
      numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2'),
      numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '4'),
    ],
    conversionRules: [conversionRule()],
    policy: policy(),
    ...overrides,
  } as unknown as DailyNumericAggregateInput;
}

describe('numeric aggregation schema boundaries', () => {
  it('deeply freezes strict conversion rules, policies, and numeric values', () => {
    const rule = createUnitConversionRule(conversionRule());
    const aggregatePolicy = createDailyAggregatePolicy(policy());
    const numeric = createNumericObservationValue(
      numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '1.25'),
    );

    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule.effectiveRange)).toBe(true);
    expect(Object.isFrozen(aggregatePolicy)).toBe(true);
    expect(Object.isFrozen(numeric)).toBe(true);
  });

  it.each([
    [{ ...conversionRule(), schemaVersion: 'unit-conversion-rule/v2' }, 'schemaVersion'],
    [{ ...conversionRule(), sourceOffset: '1e3' }, 'sourceOffset'],
    [{ ...conversionRule(), sourceOffset: '-0' }, 'negative zero'],
    [{ ...conversionRule(), sourceOffset: '1'.repeat(65) }, 'digit limit'],
    [{ ...conversionRule(), multiplierNumerator: '0' }, 'multiplierNumerator'],
    [{ ...conversionRule(), multiplierNumerator: '-1' }, 'multiplierNumerator'],
    [{ ...conversionRule(), multiplierNumerator: '1'.repeat(65) }, 'multiplier exceeds'],
    [{ ...conversionRule(), multiplierDenominator: '0' }, 'multiplierDenominator'],
    [{ ...conversionRule(), multiplierDenominator: '01' }, 'multiplierDenominator'],
    [{ ...conversionRule(), multiplierDenominator: '1'.repeat(65) }, 'multiplier exceeds'],
    [{ ...conversionRule(), ruleId: '' }, 'non-empty string'],
    [{ ...conversionRule(), surprise: true }, 'unsupported keys'],
  ])('rejects an invalid conversion rule %#', (value, message) => {
    expect(() => createUnitConversionRule(value)).toThrow(message);
  });

  it.each([
    [{ ...policy(), schemaVersion: 'daily-aggregate-policy/v2' }, 'schemaVersion'],
    [{ ...policy(), method: 'median' }, 'method'],
    [{ ...policy(), decimalPlaces: -1 }, 'decimalPlaces'],
    [{ ...policy(), decimalPlaces: 13 }, 'decimalPlaces'],
    [{ ...policy(), decimalPlaces: 1.5 }, 'decimalPlaces'],
    [{ ...policy(), roundingMode: 'bankers' }, 'roundingMode'],
    [{ ...policy(), timeZone: '+00:00' }, 'IANA'],
    [{ ...policy(), extra: true }, 'unsupported keys'],
  ])('rejects an invalid aggregate policy %#', (value, message) => {
    expect(() => createDailyAggregatePolicy(value)).toThrow(message);
  });

  it.each([
    [numericObservation('observation-1', 'bad-time', '1'), 'observedAt'],
    [numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '.5'), 'sourceValue'],
    [numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '-0.0'), 'negative zero'],
    [
      numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '1'.repeat(65)),
      'digit limit',
    ],
    [
      { ...numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '1'), extra: true },
      'unsupported keys',
    ],
  ])('rejects an invalid numeric observation %#', (value, message) => {
    expect(() => createNumericObservationValue(value)).toThrow(message);
  });
});

describe('evaluateDailyNumericAggregate', () => {
  it.each([
    ['sum', '3.00'],
    ['mean', '1.50'],
    ['minimum', '1.00'],
    ['maximum', '2.00'],
  ] as const)('computes an exact governed %s', (method, expected) => {
    const result = evaluateDailyNumericAggregate(
      aggregateInput({ policy: policy(method) as unknown as DailyNumericAggregateInput['policy'] }),
    );

    expect(result.values).toEqual([
      {
        civilDate: '2026-01-01',
        value: expected,
        canonicalUnit: 'canonical-unit',
        acceptedObservationCount: 2,
        observationIds: ['observation-1', 'observation-2'],
      },
    ]);
    expect(result.method).toBe(method);
    expect(result.governingContractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.numericSourceSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
  });

  it('applies source offset before the rational multiplier and rounds half away from zero', () => {
    const positive = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '33'),
        ],
        conversionRules: [
          conversionRule({
            sourceOffset: '-32',
            multiplierNumerator: '5',
            multiplierDenominator: '9',
          }),
        ],
        policy: policy('mean', {
          decimalPlaces: 1,
        }) as unknown as DailyNumericAggregateInput['policy'],
      }),
    );
    const negative = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '-1.25'),
        ],
        conversionRules: [conversionRule({ multiplierDenominator: '1' })],
        policy: policy('mean', {
          decimalPlaces: 1,
        }) as unknown as DailyNumericAggregateInput['policy'],
      }),
    );

    expect(positive.values[0]?.value).toBe('0.6');
    expect(negative.values[0]?.value).toBe('-1.3');
  });

  it('canonicalizes zero and supports zero decimal places', () => {
    const result = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '0.1'),
        ],
        policy: policy('mean', {
          decimalPlaces: 0,
        }) as unknown as DailyNumericAggregateInput['policy'],
      }),
    );
    expect(result.values[0]?.value).toBe('0');

    const fixedZero = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '0')],
      }),
    );
    const integer = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '5')],
        policy: policy('mean', {
          decimalPlaces: 0,
        }) as unknown as DailyNumericAggregateInput['policy'],
      }),
    );
    expect(fixedZero.values[0]?.value).toBe('0.00');
    expect(integer.values[0]?.value).toBe('3');
  });

  it('selects extrema correctly for descending and equal converted values', () => {
    const descending = aggregateInput({
      numericObservations: [
        numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '4'),
        numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '2'),
      ],
    });
    const equal = aggregateInput({
      numericObservations: [
        numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2'),
        numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '2'),
      ],
    });
    expect(
      evaluateDailyNumericAggregate({
        ...descending,
        policy: createDailyAggregatePolicy(policy('minimum')),
      }).values[0]?.value,
    ).toBe('1.00');
    expect(
      evaluateDailyNumericAggregate({
        ...descending,
        policy: createDailyAggregatePolicy(policy('maximum')),
      }).values[0]?.value,
    ).toBe('2.00');
    expect(
      evaluateDailyNumericAggregate({
        ...equal,
        policy: createDailyAggregatePolicy(policy('minimum')),
      }).values[0]?.value,
    ).toBe('1.00');
  });

  it('buckets accepted winners by the contract civil day across UTC midnight offsets', () => {
    const observations = [
      observationInput('observation-1', '2026-01-01T07:45:00.000Z'),
      observationInput('observation-2', '2026-01-01T08:15:00.000Z'),
    ];
    const result = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: {
          ...coverageEvaluation(observations, {
            effectiveRange: {
              start: '2026-01-01T07:30:00.000Z',
              end: '2026-01-01T08:30:00.000Z',
            },
            timezone: 'America/Los_Angeles',
          }),
          reportRange: {
            start: '2026-01-01T07:30:00.000Z',
            end: '2026-01-01T08:30:00.000Z',
          },
        },
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T07:45:00.000Z', '2'),
          numericObservation('observation-2', '2026-01-01T08:15:00.000Z', '4'),
        ],
        policy: policy('sum', {
          timeZone: 'America/Los_Angeles',
        }) as unknown as DailyNumericAggregateInput['policy'],
      }),
    );

    expect(result.values.map(({ civilDate, value }) => ({ civilDate, value }))).toEqual([
      { civilDate: '2025-12-31', value: '1.00' },
      { civilDate: '2026-01-01', value: '2.00' },
    ]);
  });

  it('excludes duplicate, quarantined, superseded, and gap outcomes from the numeric source set', () => {
    const observations = [
      observationInput('winner', '2026-01-01T00:05:00.000Z'),
      observationInput('duplicate', '2026-01-01T00:06:00.000Z'),
      observationInput('superseded', '2026-01-01T00:35:00.000Z', { supersededBy: 'later' }),
      observationInput('quarantine', '2026-01-01T00:36:00.000Z', {
        qualityState: 'quarantined',
        quarantineReason: 'malformed_value',
      }),
    ];
    const result = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation(observations),
        numericObservations: [numericObservation('winner', '2026-01-01T00:05:00.000Z', '8')],
      }),
    );

    expect(result.values[0]?.observationIds).toEqual(['winner']);
    expect(result.values[0]?.value).toBe('4.00');
  });

  it('emits an empty aggregate when coverage has no accepted winners', () => {
    const result = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([]),
        numericObservations: [],
        conversionRules: [],
      }),
    );
    expect(result.values).toEqual([]);
  });

  it('is deterministic across source, rule, and observation ordering', () => {
    const first = evaluateDailyNumericAggregate(aggregateInput());
    const reversed = evaluateDailyNumericAggregate(
      aggregateInput({
        coverageEvaluation: coverageEvaluation([
          observationInput('observation-2', '2026-01-01T00:35:00.000Z'),
          observationInput('observation-1', '2026-01-01T00:05:00.000Z'),
        ]),
        numericObservations: [
          numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '4'),
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2'),
        ],
      }),
    );
    expect(reversed).toEqual(first);
  });

  it.each([
    [{ policy: policy('mean', { contractId: 'other' }) }, 'policy contract'],
    [{ policy: policy('mean', { timeZone: 'America/Los_Angeles' }) }, 'time zone'],
    [{ numericObservations: [] }, 'exactly match'],
    [
      {
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2'),
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2'),
        ],
      },
      'IDs must be unique',
    ],
    [{ conversionRules: [conversionRule(), conversionRule()] }, 'pairs must be unique'],
    [
      {
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2', {
            sourceFingerprint: 'tampered',
          }),
          numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '4'),
        ],
      },
      'identity does not match',
    ],
    [
      {
        numericObservations: [
          numericObservation('observation-1', '2026-01-01T00:05:00.000Z', '2', {
            conversionRuleId: 'missing',
          }),
          numericObservation('observation-2', '2026-01-01T00:35:00.000Z', '4'),
        ],
      },
      'exactly match rules pinned',
    ],
    [
      {
        conversionRules: [conversionRule(), conversionRule({ ruleId: 'unused', version: '2' })],
      },
      'exactly match rules pinned',
    ],
    [{ conversionRules: [conversionRule({ parameterCode: 'other' })] }, 'not applicable'],
    [{ conversionRules: [conversionRule({ sourceUnit: 'other' })] }, 'not applicable'],
    [{ conversionRules: [conversionRule({ canonicalUnit: 'other' })] }, 'not applicable'],
    [
      {
        conversionRules: [
          conversionRule({
            effectiveRange: {
              start: '2026-01-01T00:06:00.000Z',
              end: '2027-01-01T00:00:00.000Z',
            },
          }),
        ],
      },
      'not applicable',
    ],
    [
      {
        conversionRules: [
          conversionRule({
            effectiveRange: {
              start: '2025-01-01T00:00:00.000Z',
              end: '2026-01-01T00:05:00.000Z',
            },
          }),
        ],
      },
      'not applicable',
    ],
  ])('fails closed for inconsistent aggregate evidence %#', (overrides, message) => {
    expect(() => evaluateDailyNumericAggregate(aggregateInput(overrides))).toThrow(message);
  });

  it('rejects unexpected outer input fields and malformed coverage preimages', () => {
    expect(() =>
      evaluateDailyNumericAggregate({ ...aggregateInput(), extra: true } as never),
    ).toThrow('unsupported keys');
    expect(() =>
      evaluateDailyNumericAggregate(
        aggregateInput({ coverageEvaluation: { ...coverageEvaluation(), extra: true } }),
      ),
    ).toThrow('unsupported keys');
  });

  it('bounds the conversion-rule set before exact rational work', () => {
    const rules = Array.from({ length: 257 }, (_, index) =>
      conversionRule({ ruleId: `conversion-${index.toString().padStart(3, '0')}` }),
    );
    expect(() => evaluateDailyNumericAggregate(aggregateInput({ conversionRules: rules }))).toThrow(
      '256-rule safety limit',
    );
  });
});
