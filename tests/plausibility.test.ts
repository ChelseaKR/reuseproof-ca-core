import { describe, expect, it } from 'vitest';

import {
  MAX_PLAUSIBLE_RANGES,
  MAX_SENTINEL_LITERALS,
  MAX_SENTINEL_LITERAL_LENGTH,
  applicablePlausibleRange,
  createPlausibilityPolicy,
  hashPlausibilityPolicy,
  isSentinelLiteral,
  type PlausibilityPolicy,
} from '../src/index.js';

function policyInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
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

describe('plausibility policy boundary', () => {
  it('strictly reconstructs, orders, freezes and content-addresses a policy', () => {
    const policy = createPlausibilityPolicy(policyInput());
    // Same policy, every list in a different caller order. A caller's incidental ordering must
    // not give one approved policy two identities.
    const shuffled = createPlausibilityPolicy(
      policyInput({
        sentinelLiterals: ['ERR', '', '-9999'],
        plausibleRanges: [
          {
            parameterCode: 'flow.treated.daily_avg',
            canonicalUnit: 'canonical-unit',
            minimum: '0',
            maximum: '10',
          },
        ],
      }),
    );

    expect(policy.sentinelLiterals).toEqual(['', '-9999', 'ERR']);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.sentinelLiterals)).toBe(true);
    expect(Object.isFrozen(policy.plausibleRanges)).toBe(true);
    expect(Object.isFrozen(policy.plausibleRanges[0])).toBe(true);
    expect(hashPlausibilityPolicy(shuffled)).toBe(hashPlausibilityPolicy(policy));
    expect(hashPlausibilityPolicy(policy)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('orders ranges by parameter and then by unit', () => {
    const policy = createPlausibilityPolicy(
      policyInput({
        plausibleRanges: [
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: '0', maximum: '14' },
          { parameterCode: 'flow', canonicalUnit: 'mgd', minimum: '0', maximum: '5' },
          { parameterCode: 'flow', canonicalUnit: 'gpm', minimum: '0', maximum: '5' },
        ],
      }),
    );

    expect(
      policy.plausibleRanges.map(({ parameterCode, canonicalUnit }) => [
        parameterCode,
        canonicalUnit,
      ]),
    ).toEqual([
      ['flow', 'gpm'],
      ['flow', 'mgd'],
      ['ph', 'su'],
    ]);
  });

  it('gives two policies differing only in a bound different hashes', () => {
    const policy = createPlausibilityPolicy(policyInput());
    const widened = createPlausibilityPolicy(
      policyInput({
        plausibleRanges: [
          {
            parameterCode: 'flow.treated.daily_avg',
            canonicalUnit: 'canonical-unit',
            minimum: '0',
            maximum: '10.000001',
          },
        ],
      }),
    );

    expect(hashPlausibilityPolicy(widened)).not.toBe(hashPlausibilityPolicy(policy));
  });

  it('accepts an empty string as a sentinel literal', () => {
    // Everywhere else in this codebase an empty string is a missing field. Here it is one of the
    // commonest ways a vendor writes "this sensor produced nothing", so the policy has to be able
    // to name it. A reconstructor that refused it would leave the most frequent fault expression
    // reaching the accepted set through the malformed-value path.
    const policy = createPlausibilityPolicy(
      policyInput({ sentinelLiterals: [''], plausibleRanges: [] }),
    );

    expect(policy.sentinelLiterals).toEqual(['']);
    expect(isSentinelLiteral(policy, '')).toBe(true);
    expect(isSentinelLiteral(policy, ' ')).toBe(false);
  });

  it('compares sentinel literals exactly, without trimming or folding', () => {
    const policy = createPlausibilityPolicy(policyInput());

    expect(isSentinelLiteral(policy, '-9999')).toBe(true);
    expect(isSentinelLiteral(policy, ' -9999')).toBe(false);
    expect(isSentinelLiteral(policy, '-9999.0')).toBe(false);
    expect(isSentinelLiteral(policy, 'err')).toBe(false);
  });

  it('reports no applicable range rather than a permissive one', () => {
    const policy = createPlausibilityPolicy(policyInput());

    expect(applicablePlausibleRange(policy, 'flow.treated.daily_avg', 'canonical-unit')).toEqual({
      parameterCode: 'flow.treated.daily_avg',
      canonicalUnit: 'canonical-unit',
      minimum: '0',
      maximum: '10',
    });
    // The same parameter in another unit is a different rule, and this policy does not state it.
    expect(applicablePlausibleRange(policy, 'flow.treated.daily_avg', 'other-unit')).toBeNull();
    expect(applicablePlausibleRange(policy, 'ph', 'canonical-unit')).toBeNull();
  });

  it('refuses a policy that would enforce nothing at all', () => {
    expect(() =>
      createPlausibilityPolicy(policyInput({ sentinelLiterals: [], plausibleRanges: [] })),
    ).toThrow('at least one sentinel literal or one plausible range');
  });

  it.each([
    [{ schemaVersion: 'plausibility-policy/v2' }, 'plausibility-policy/v1'],
    [{ policyId: '' }, 'non-empty string'],
    [{ version: '  ' }, 'non-empty string'],
    [{ authorizationId: '' }, 'non-empty string'],
    [{ extra: true }, 'unsupported keys'],
    [{ sentinelLiterals: '-9999' }, 'must be an array'],
    [{ sentinelLiterals: [9999] }, 'must be a string'],
    [{ sentinelLiterals: ['-9999', '-9999'] }, 'must not repeat'],
    [{ sentinelLiterals: ['x'.repeat(MAX_SENTINEL_LITERAL_LENGTH + 1)] }, 'character limit'],
    [
      {
        sentinelLiterals: Array.from(
          { length: MAX_SENTINEL_LITERALS + 1 },
          (_, i) => `s${i.toString()}`,
        ),
      },
      'at most 64 sentinel literals',
    ],
    [{ plausibleRanges: {} }, 'must be an array'],
    [
      {
        plausibleRanges: [
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: '14', maximum: '0' },
        ],
      },
      'must not exceed',
    ],
    [
      {
        plausibleRanges: [
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: 'low', maximum: '14' },
        ],
      },
      'plain base-10 decimal string',
    ],
    [
      { plausibleRanges: [{ parameterCode: 'ph', canonicalUnit: 'su', minimum: '0' }] },
      'missing required keys',
    ],
    [
      {
        plausibleRanges: [{ parameterCode: '', canonicalUnit: 'su', minimum: '0', maximum: '14' }],
      },
      'non-empty string',
    ],
    [
      {
        plausibleRanges: [
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: '0', maximum: '14' },
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: '1', maximum: '13' },
        ],
      },
      'at most one range per parameter and unit',
    ],
    [
      {
        plausibleRanges: Array.from({ length: MAX_PLAUSIBLE_RANGES + 1 }, (_, i) => ({
          parameterCode: `p${i.toString()}`,
          canonicalUnit: 'su',
          minimum: '0',
          maximum: '1',
        })),
      },
      'at most 256 plausible ranges',
    ],
  ])('rejects an unsafe policy %#', (overrides, message) => {
    expect(() => createPlausibilityPolicy(policyInput(overrides))).toThrow(message);
  });

  it('accepts a bound equal to its own opposite, which is a single admissible value', () => {
    const policy = createPlausibilityPolicy(
      policyInput({
        plausibleRanges: [
          { parameterCode: 'ph', canonicalUnit: 'su', minimum: '7.0', maximum: '7' },
        ],
      }),
    );

    // 7.0 and 7 are the same number, so this is a range of exactly one value rather than an
    // inverted one. Comparing the strings instead of the decimals would refuse it.
    expect(policy.plausibleRanges[0]).toMatchObject({ minimum: '7.0', maximum: '7' });
  });

  it('re-hashes a reconstructed policy identically to the object it was built from', () => {
    const policy: PlausibilityPolicy = createPlausibilityPolicy(policyInput());

    expect(hashPlausibilityPolicy(createPlausibilityPolicy(policy))).toBe(
      hashPlausibilityPolicy(policy),
    );
  });
});
