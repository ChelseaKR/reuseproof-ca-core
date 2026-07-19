/** Fixed-threshold, denominator-independent data readiness tests. */

import { describe, expect, it } from 'vitest';

import {
  createObservation,
  createRequiredSeriesContract,
  createTimeRange,
  evaluateCoverage,
  evaluateCoverageReadiness,
  type CoverageEvaluationInput,
  type CoverageSummary,
  type LifecycleState,
  type RequiredSeriesContract,
} from '../src/index.js';
import { contractInput, observationInput } from './helpers.js';

const reportHour = createTimeRange({
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T01:00:00.000Z',
});

function contract(
  contractId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): RequiredSeriesContract {
  return createRequiredSeriesContract(
    contractInput({
      contractId,
      parameterCode: `synthetic.${contractId}`,
      cadenceMinutes: 3,
      aggregateMembership: [],
      ...overrides,
    }),
  );
}

function coverage(
  requiredContract: RequiredSeriesContract,
  accepted: number,
  lifecycleState: LifecycleState = 'in_service',
): CoverageSummary {
  const observations = Array.from({ length: accepted }, (_, index) => {
    const observedAt = new Date(
      Date.parse(reportHour.start) + index * requiredContract.cadenceMinutes * 60_000,
    ).toISOString();
    return createObservation(
      observationInput(`${requiredContract.contractId}-${index.toString()}`, observedAt, {
        contractId: requiredContract.contractId,
      }),
    );
  });
  const input: CoverageEvaluationInput = {
    contract: requiredContract,
    reportRange: reportHour,
    lifecycleState,
    observations,
    scheduledNonoperations: [],
  };
  evaluationByContract.set(requiredContract.contractId, input);
  return evaluateCoverage(input);
}

const evaluationByContract = new Map<string, CoverageEvaluationInput>();

function readiness(
  contracts: readonly RequiredSeriesContract[],
  summaries: readonly CoverageSummary[],
  coverageEvaluationInputs: readonly CoverageEvaluationInput[] = contracts.flatMap((item) => {
    const evaluation = evaluationByContract.get(item.contractId);
    return evaluation === undefined ? [] : [evaluation];
  }),
) {
  return evaluateCoverageReadiness({
    contracts,
    coverageEvaluationInputs,
    coverageSummaries: summaries,
  });
}

describe('required-series readiness', () => {
  it('passes exactly 95% and blocks anything below the fixed non-waivable threshold', () => {
    const requiredContract = contract('series-a');
    const exact = readiness([requiredContract], [coverage(requiredContract, 19)]);
    const below = readiness([requiredContract], [coverage(requiredContract, 18)]);

    expect(exact.state).toBe('ready');
    expect(exact.requiredSeries[0]).toEqual({
      contractId: 'series-a',
      contractVersion: '1',
      state: 'ready',
      acceptedCount: 19,
      expectedCount: 20,
      thresholdBasisPoints: 9500,
      reasons: [],
    });
    expect(below.state).toBe('blocked');
    expect(below.requiredSeries[0]).toMatchObject({
      state: 'blocked',
      reasons: ['required_series_below_95_percent'],
    });
    expect(below.claim).toBe('data coverage preflight only');
    expect(below.limitations[0]).toContain('not a compliance');
  });

  it('returns N/A rather than a misleading percentage when lifecycle creates no denominator', () => {
    const critical = contract('critical', {
      criticality: 'report_critical',
      aggregateMembership: ['shared-total'],
    });
    const member = contract('member', { aggregateMembership: ['shared-total'] });
    const report = readiness(
      [critical, member],
      [coverage(critical, 0, 'suspended'), coverage(member, 0, 'suspended')],
    );

    expect(report.state).toBe('not_applicable');
    expect(report.requiredSeries.every(({ state }) => state === 'not_applicable')).toBe(true);
    expect(report.criticalAggregates[0]).toEqual({
      aggregateId: 'shared-total',
      sourceContractIds: ['critical', 'member'],
      state: 'not_applicable',
      acceptedSourceIntervalPairs: 0,
      expectedSourceIntervalPairs: 0,
      thresholdBasisPoints: 9000,
      coverage: { state: 'not_applicable' },
      reasons: [],
    });
  });
});

describe('critical aggregate source-set readiness', () => {
  it('derives the complete source set from contracts and passes exactly 90% source/interval pairs', () => {
    const critical = contract('critical', {
      criticality: 'report_critical',
      aggregateMembership: ['shared-total'],
    });
    const requiredMember = contract('required-member', {
      aggregateMembership: ['shared-total'],
    });
    const unrelated = contract('unrelated', {
      aggregateMembership: ['not-declared-critical'],
    });
    const report = readiness(
      [unrelated, requiredMember, critical],
      [coverage(requiredMember, 16), coverage(critical, 20), coverage(unrelated, 20)],
    );

    expect(report.criticalAggregates).toHaveLength(1);
    expect(report.criticalAggregates[0]).toEqual({
      aggregateId: 'shared-total',
      sourceContractIds: ['critical', 'required-member'],
      state: 'ready',
      acceptedSourceIntervalPairs: 36,
      expectedSourceIntervalPairs: 40,
      thresholdBasisPoints: 9000,
      coverage: { state: 'measured', numerator: 36, denominator: 40 },
      reasons: [],
    });
    // The member's separate 80% series gate still blocks the overall preflight.
    expect(report.state).toBe('blocked');
  });

  it('blocks below 90% without accepting a mapping or attestation override input', () => {
    const critical = contract('critical', {
      criticality: 'report_critical',
      aggregateMembership: ['shared-total'],
    });
    const requiredMember = contract('required-member', {
      aggregateMembership: ['shared-total'],
    });
    const report = readiness(
      [critical, requiredMember],
      [coverage(critical, 20), coverage(requiredMember, 15)],
    );

    expect(report.criticalAggregates[0]).toMatchObject({
      state: 'blocked',
      acceptedSourceIntervalPairs: 35,
      expectedSourceIntervalPairs: 40,
      reasons: ['critical_aggregate_below_90_percent'],
    });
  });

  it('is deterministic under contract and summary input reordering', () => {
    const first = contract('z-series');
    const second = contract('a-series');
    const firstSummary = coverage(first, 20);
    const secondSummary = coverage(second, 20);

    expect(readiness([first, second], [firstSummary, secondSummary])).toEqual(
      readiness([second, first], [secondSummary, firstSummary]),
    );
  });
});

describe('readiness input integrity', () => {
  it('strictly snapshots every public readiness boundary without invoking caller getters', () => {
    const requiredContract = contract('strict-boundary');
    const summary = coverage(requiredContract, 20);
    const evaluation = evaluationByContract.get(requiredContract.contractId);
    if (evaluation === undefined) throw new Error('test setup did not retain the evaluation');
    const input = {
      contracts: [requiredContract],
      coverageEvaluationInputs: [evaluation],
      coverageSummaries: [summary],
    };
    const expected = evaluateCoverageReadiness(input);

    expect(() => evaluateCoverageReadiness({ ...input, unsupported: true } as never)).toThrow(
      'unsupported keys',
    );
    expect(() =>
      evaluateCoverageReadiness({
        ...input,
        contracts: [{ ...requiredContract, unsupported: true } as never],
      }),
    ).toThrow('unsupported keys');
    expect(() =>
      evaluateCoverageReadiness({
        ...input,
        coverageEvaluationInputs: [{ ...evaluation, unsupported: true } as never],
      }),
    ).toThrow('unsupported keys');
    expect(() =>
      evaluateCoverageReadiness({
        ...input,
        coverageSummaries: [{ ...summary, unsupported: true } as never],
      }),
    ).toThrow('unsupported keys');

    for (const key of ['contracts', 'coverageEvaluationInputs', 'coverageSummaries'] as const) {
      const attacked = structuredClone(input) as unknown as Record<string, unknown>;
      const values = attacked[key] as unknown[];
      const first = values[0];
      if (first === undefined) throw new Error(`${key} must be non-empty`);
      let getterReads = 0;
      Object.defineProperty(values, '0', {
        enumerable: true,
        configurable: true,
        get: () => {
          getterReads += 1;
          return first;
        },
      });
      expect(() => evaluateCoverageReadiness(attacked as never)).toThrow(
        'enumerable data property',
      );
      expect(getterReads).toBe(0);
    }

    const counter = { reads: 0 };
    const unread = <T extends object>(value: T): T =>
      new Proxy(value, {
        get: () => {
          counter.reads += 1;
          throw new Error('readiness must not read caller Proxy properties');
        },
      });
    const proxied = structuredClone(input) as unknown as Record<string, unknown>;
    const proxiedContracts = proxied.contracts as object[];
    const proxiedEvaluations = proxied.coverageEvaluationInputs as Record<string, unknown>[];
    const proxiedSummaries = proxied.coverageSummaries as Record<string, unknown>[];
    const evaluationRecord = proxiedEvaluations[0];
    const summaryRecord = proxiedSummaries[0];
    if (evaluationRecord === undefined || summaryRecord === undefined) {
      throw new Error('readiness fixture must be non-empty');
    }
    evaluationRecord.contract = unread(evaluationRecord.contract as Record<string, unknown>);
    proxiedEvaluations[0] = unread(evaluationRecord);
    summaryRecord.outcomes = unread(summaryRecord.outcomes as unknown[]);
    proxiedSummaries[0] = unread(summaryRecord);
    const proxiedContract = proxiedContracts[0];
    if (proxiedContract === undefined) throw new Error('readiness contract must be present');
    proxiedContracts[0] = unread(proxiedContract);
    proxied.contracts = unread(proxiedContracts);
    proxied.coverageEvaluationInputs = unread(proxiedEvaluations);
    proxied.coverageSummaries = unread(proxiedSummaries);

    expect(evaluateCoverageReadiness(unread(proxied) as never)).toEqual(expected);
    expect(counter.reads).toBe(0);
  });

  it('rejects missing, duplicate, or invented contract-summary identity', () => {
    const first = contract('first');
    const firstSummary = coverage(first, 20);

    expect(() => readiness([], [])).toThrow('at least one');
    expect(() => readiness([first, first], [firstSummary])).toThrow('unique IDs');
    expect(() => readiness([first], [firstSummary, firstSummary])).toThrow('unique contract IDs');
    expect(() => readiness([first], [])).toThrow('exactly one summary');
    expect(() => readiness([first], [firstSummary], [])).toThrow('exactly one evaluation');
    const firstEvaluation = evaluationByContract.get(first.contractId);
    if (firstEvaluation === undefined) {
      throw new Error('test setup did not retain the first evaluation');
    }
    expect(() => readiness([first], [firstSummary], [firstEvaluation, firstEvaluation])).toThrow(
      'evaluations must have unique contract IDs',
    );
    expect(() => readiness([first], [{ ...firstSummary, contractId: 'invented' }])).toThrow(
      'missing contract first',
    );

    const second = contract('second');
    const secondSummary = coverage(second, 20);
    const secondEvaluation = evaluationByContract.get(second.contractId);
    if (secondEvaluation === undefined) {
      throw new Error('test setup did not retain the second evaluation');
    }
    expect(() =>
      readiness(
        [first, second],
        [firstSummary, { ...secondSummary, contractId: 'invented' }],
        [firstEvaluation, secondEvaluation],
      ),
    ).toThrow('missing contract second');

    const invented = contract('invented');
    coverage(invented, 20);
    const inventedEvaluation = evaluationByContract.get(invented.contractId);
    if (inventedEvaluation === undefined) {
      throw new Error('test setup did not retain the invented evaluation');
    }
    expect(() =>
      readiness(
        [first, second],
        [firstSummary, secondSummary],
        [firstEvaluation, inventedEvaluation],
      ),
    ).toThrow('missing evaluation second');
  });

  it.each([
    ['contract version', { contractVersion: 'other' }, 'does not match'],
    ['summary tenant', { tenantId: 'other' }, 'does not match'],
    ['summary system', { systemId: 'other' }, 'does not match'],
  ])('rejects %s drift', (_label, overrides, message) => {
    const requiredContract = contract('first');
    expect(() =>
      readiness([requiredContract], [{ ...coverage(requiredContract, 20), ...overrides }]),
    ).toThrow(message);
  });

  it.each([
    ['cadence', { cadenceMinutes: 60 }],
    [
      'effective range',
      {
        effectiveRange: {
          start: reportHour.start,
          end: '2026-01-01T00:30:00.000Z',
        },
      },
    ],
    ['time zone', { timezone: 'UTC' }],
  ])('rejects a same-identity %s contract substitution', (_label, rogueOverrides) => {
    const governed = contract('governed');
    const rogue = contract('governed', rogueOverrides);
    const rogueSummary = coverage(rogue, 1);
    const rogueEvaluation = evaluationByContract.get(rogue.contractId);
    if (rogueEvaluation === undefined) {
      throw new Error('test setup did not retain the rogue evaluation');
    }

    expect(() => readiness([governed], [rogueSummary], [rogueEvaluation])).toThrow(
      'governing contract content',
    );
  });

  it('rejects a lifecycle substitution even when contract identity and scope are unchanged', () => {
    const governed = contract('governed');
    coverage(governed, 20, 'in_service');
    const governedEvaluation = evaluationByContract.get(governed.contractId);
    if (governedEvaluation === undefined) {
      throw new Error('test setup did not retain the governed evaluation');
    }
    const substitutedSummary = coverage(governed, 0, 'suspended');

    expect(() => readiness([governed], [substitutedSummary], [governedEvaluation])).toThrow(
      'exact evaluation input',
    );
  });

  it('rejects an evaluation whose same-identity contract differs from the verified summary contract', () => {
    const governed = contract('governed');
    const governedSummary = coverage(governed, 20);
    const rogue = contract('governed', { cadenceMinutes: 60 });
    coverage(rogue, 1);
    const rogueEvaluation = evaluationByContract.get(rogue.contractId);
    if (rogueEvaluation === undefined) {
      throw new Error('test setup did not retain the rogue evaluation');
    }

    expect(() => readiness([governed], [governedSummary], [rogueEvaluation])).toThrow(
      'coverage evaluation governed does not match its governing contract content',
    );
  });

  it('requires all contracts and summaries to share one system and report-time basis', () => {
    const first = contract('first');
    const secondTenant = contract('second', { tenantId: 'other' });
    expect(() =>
      readiness([first, secondTenant], [coverage(first, 20), coverage(secondTenant, 20)]),
    ).toThrow('share one tenant and system');

    const second = contract('second');
    const secondSummary = coverage(second, 20);
    expect(() =>
      readiness(
        [first, second],
        [
          coverage(first, 20),
          {
            ...secondSummary,
            reportRange: {
              start: reportHour.start,
              end: '2026-01-01T00:30:00.000Z',
            },
          },
        ],
      ),
    ).toThrow('outside the report range');
    expect(() =>
      readiness(
        [first, second],
        [
          coverage(first, 20),
          {
            ...secondSummary,
            reportTimeBasis: {
              kind: 'civil',
              timeZone: 'UTC',
              start: {
                localDateTime: '2026-01-01T00:00:00.000',
                disambiguation: 'reject',
                resolvedAt: reportHour.start,
              },
              end: {
                localDateTime: '2026-01-01T01:00:00.000',
                disambiguation: 'reject',
                resolvedAt: reportHour.end,
              },
            },
          },
        ],
      ),
    ).toThrow('share one report time basis');
  });

  it.each([
    [
      'expected interval length',
      (value: CoverageSummary) => ({ expectedIntervals: value.expectedIntervals.slice(1) }),
    ],
    [
      'accepted outcomes',
      (value: CoverageSummary) => ({
        outcomes: value.outcomes.filter(({ kind }) => kind !== 'accepted'),
      }),
    ],
    ['gap outcomes', (value: CoverageSummary) => ({ gapCount: value.gapCount + 1 })],
    ['duplicate outcomes', (_value: CoverageSummary) => ({ duplicateCount: 1 })],
    ['quarantine outcomes', (_value: CoverageSummary) => ({ quarantineCount: 1 })],
    ['negative count', () => ({ acceptedCount: -1 })],
    ['fractional count', () => ({ expectedCount: 1.5 })],
  ])('rejects inconsistent %s accounting', (_label, mutate) => {
    const requiredContract = contract('first');
    const valid = coverage(requiredContract, 19);
    expect(() => readiness([requiredContract], [{ ...valid, ...mutate(valid) }])).toThrow();
  });

  it('rejects inconsistent N/A and measured ratio metadata', () => {
    const requiredContract = contract('first');
    const measured = coverage(requiredContract, 19);
    expect(() =>
      readiness([requiredContract], [{ ...measured, coverage: { state: 'not_applicable' } }]),
    ).toThrow('inconsistent ratio');
    expect(() =>
      readiness(
        [requiredContract],
        [
          {
            ...measured,
            coverage: { state: 'measured', numerator: 18, denominator: 20 },
          },
        ],
      ),
    ).toThrow('inconsistent ratio');
    expect(() =>
      readiness(
        [requiredContract],
        [
          {
            ...measured,
            coverage: { state: 'measured', numerator: 19, denominator: 19 },
          },
        ],
      ),
    ).toThrow('inconsistent ratio');

    const inactive = coverage(requiredContract, 0, 'suspended');
    expect(() =>
      readiness(
        [requiredContract],
        [
          {
            ...inactive,
            coverage: { state: 'measured', numerator: 0, denominator: 0 },
          },
        ],
      ),
    ).toThrow('inconsistent ratio');
  });
});
