/** Half-open denominator, scheduled-stop, and typed-outcome tests. */

import { describe, expect, it } from 'vitest';

import {
  bindVendorMappings,
  buildExpectedIntervals,
  createLifecycleTimeline,
  createObservation,
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  createUnsignedReceipt,
  createVendorMapping,
  evaluateCoverage,
  hashCoverageEvaluationInputSet,
  hashCoverageSummarySet,
} from '../src/index.js';
import {
  contractInput,
  lifecycleTimelineInput,
  nonoperationInput,
  observationInput,
} from './helpers.js';

const reportHour = createTimeRange({
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T01:00:00.000Z',
});

function evaluate(
  observations: readonly ReturnType<typeof createObservation>[],
  scheduledNonoperations: readonly ReturnType<typeof createScheduledNonoperation>[] = [],
) {
  return evaluateCoverage({
    contract: createRequiredSeriesContract(contractInput()),
    reportRange: reportHour,
    lifecycleState: 'in_service',
    observations,
    scheduledNonoperations,
  });
}

describe('half-open expected intervals', () => {
  it.each([null, undefined])(
    'rejects an explicitly present nullish report-time basis (%s)',
    (reportTimeBasis) => {
      expect(() =>
        evaluateCoverage({
          contract: createRequiredSeriesContract(contractInput()),
          reportRange: reportHour,
          reportTimeBasis,
          lifecycleState: 'in_service',
          observations: [],
          scheduledNonoperations: [],
        } as unknown as Parameters<typeof evaluateCoverage>[0]),
      ).toThrow('must be an object');
    },
  );

  it('requires exact own-key lifecycle unions for direct coverage evaluation', () => {
    const contract = createRequiredSeriesContract(contractInput());
    const timeline = createLifecycleTimeline(lifecycleTimelineInput());
    const base = {
      contract,
      reportRange: reportHour,
      observations: [],
      scheduledNonoperations: [],
    };

    expect(evaluateCoverage({ ...base, lifecycleState: 'in_service' }).lifecycleBasis).toEqual({
      kind: 'resolved_state',
      state: 'in_service',
    });
    expect(evaluateCoverage({ ...base, lifecycleTimeline: timeline }).lifecycleBasis).toEqual({
      kind: 'effective_timeline',
      timelineVersion: timeline.version,
    });

    const invalid: readonly [Record<string, unknown>, string][] = [
      [base, 'exactly one lifecycle'],
      [{ ...base, lifecycleState: 'in_service', lifecycleTimeline: timeline }, 'exactly one'],
      [{ ...base, lifecycleState: 'in_service', lifecycleTimeline: undefined }, 'exactly one'],
      [{ ...base, lifecycleState: 'in_service', lifecycleTimeline: null }, 'exactly one'],
      [{ ...base, lifecycleTimeline: timeline, lifecycleState: undefined }, 'exactly one'],
      [{ ...base, lifecycleTimeline: timeline, lifecycleState: null }, 'exactly one'],
      [{ ...base, lifecycleState: undefined }, 'lifecycle state must be supported'],
      [{ ...base, lifecycleState: null }, 'lifecycle state must be supported'],
      [{ ...base, lifecycleTimeline: undefined }, 'must be an object'],
      [{ ...base, lifecycleTimeline: null }, 'must be an object'],
    ];
    for (const [value, message] of invalid) {
      expect(() =>
        evaluateCoverage(value as unknown as Parameters<typeof evaluateCoverage>[0]),
      ).toThrow(message);
    }

    let rootGetterReads = 0;
    const proxied = new Proxy(
      { ...base, lifecycleState: 'in_service' as const },
      {
        get: (target, key, receiver) => {
          rootGetterReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(evaluateCoverage(proxied).lifecycleBasis.kind).toBe('resolved_state');
    expect(rootGetterReads).toBe(0);
  });

  it('tiles only the report/effective intersection and assigns boundary evidence forward', () => {
    const contract = createRequiredSeriesContract(
      contractInput({
        cadenceMinutes: 10,
        effectiveRange: {
          start: '2026-01-01T00:05:00.000Z',
          end: '2026-01-01T00:35:00.000Z',
        },
      }),
    );
    const observations = [
      createObservation(observationInput('at-start', '2026-01-01T00:05:00.000Z')),
      createObservation(observationInput('at-boundary', '2026-01-01T00:15:00.000Z')),
      createObservation(observationInput('before-end', '2026-01-01T00:34:59.999Z')),
      createObservation(observationInput('at-end', '2026-01-01T00:35:00.000Z')),
    ];
    const summary = evaluateCoverage({
      contract,
      reportRange: reportHour,
      lifecycleState: 'in_service',
      observations,
      scheduledNonoperations: [],
    });

    expect(summary.expectedIntervals.map(({ start, end }) => [start, end])).toEqual([
      ['2026-01-01T00:05:00.000Z', '2026-01-01T00:15:00.000Z'],
      ['2026-01-01T00:15:00.000Z', '2026-01-01T00:25:00.000Z'],
      ['2026-01-01T00:25:00.000Z', '2026-01-01T00:35:00.000Z'],
    ]);
    expect(summary.acceptedCount).toBe(3);
    expect(summary.quarantineCount).toBe(1);
    expect(summary.outcomes).toContainEqual({
      kind: 'quarantine',
      observationId: 'at-end',
      reason: 'outside_expected_range',
    });
  });

  it('retains a final partial interval and returns N/A for an inactive or disjoint contract', () => {
    const partial = createRequiredSeriesContract(
      contractInput({
        cadenceMinutes: 20,
        effectiveRange: {
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-01-01T00:45:00.000Z',
        },
      }),
    );
    expect(buildExpectedIntervals(partial, reportHour, 'in_service').at(-1)).toMatchObject({
      start: '2026-01-01T00:40:00.000Z',
      end: '2026-01-01T00:45:00.000Z',
    });
    expect(buildExpectedIntervals(partial, reportHour, 'suspended')).toEqual([]);

    const disjoint = createRequiredSeriesContract(
      contractInput({
        effectiveRange: {
          start: '2026-01-02T00:00:00.000Z',
          end: '2026-01-02T01:00:00.000Z',
        },
      }),
    );
    const summary = evaluateCoverage({
      contract: disjoint,
      reportRange: reportHour,
      lifecycleState: 'in_service',
      observations: [],
      scheduledNonoperations: [],
    });
    expect(summary.coverage).toEqual({ state: 'not_applicable' });
    expect(summary.expectedCount).toBe(0);
  });

  it('rejects malformed ranges and unsupported lifecycle states instead of returning N/A', () => {
    const contract = createRequiredSeriesContract(contractInput());

    expect(() =>
      buildExpectedIntervals(
        contract,
        {
          start: '2026-01-01T01:00:00.000Z',
          end: '2026-01-01T00:00:00.000Z',
        },
        'in_service',
      ),
    ).toThrow('start < end');
    expect(() => buildExpectedIntervals(contract, reportHour, 'unknown' as never)).toThrow(
      'lifecycle state must be supported',
    );
  });

  it('fails before allocating an unsafe number of in-memory intervals', () => {
    const contract = createRequiredSeriesContract(
      contractInput({
        cadenceMinutes: 1,
        effectiveRange: {
          start: '2026-01-01T00:00:00.000Z',
          end: '2027-01-01T00:00:00.000Z',
        },
      }),
    );
    const year = createTimeRange({
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });

    expect(() => buildExpectedIntervals(contract, year, 'in_service')).toThrow(
      'interval safety limit',
    );
  });

  it('strictly reconstructs direct interval-builder contracts without property gets', () => {
    const raw = contractInput();
    const expected = buildExpectedIntervals(
      createRequiredSeriesContract(raw),
      reportHour,
      'in_service',
    );
    expect(() =>
      buildExpectedIntervals({ ...raw, unsupported: true } as never, reportHour, 'in_service'),
    ).toThrow('unsupported keys');

    let getterReads = 0;
    const accessor = { ...raw };
    Object.defineProperty(accessor, 'eligibleLifecycleStates', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return ['in_service'];
      },
    });
    expect(() => buildExpectedIntervals(accessor as never, reportHour, 'in_service')).toThrow(
      'enumerable data property',
    );
    expect(getterReads).toBe(0);

    const counter = { reads: 0 };
    const proxied = new Proxy(structuredClone(raw), {
      get: () => {
        counter.reads += 1;
        throw new Error('interval builder must not read caller Proxy properties');
      },
    });
    expect(buildExpectedIntervals(proxied as never, reportHour, 'in_service')).toEqual(expected);
    expect(counter.reads).toBe(0);
  });
});

describe('coverage summary hash boundaries', () => {
  it('strictly snapshots summary preimages and preserves deterministic hashes', () => {
    const summary = evaluate([]);
    const summaryHash = hashCoverageSummarySet([summary]);
    const evaluationHash = hashCoverageEvaluationInputSet([summary]);

    expect(summaryHash).toBe('68a44034f4d04cb72ae46eef1485065db06dc9e3de24fbfc2dae6762d6bc9b39');
    expect(evaluationHash).toBe('7f46e40523af221b8e7ecea70965dee9ee8f71f03a63aa06069bbb6a1e2e15ee');
    expect(() => hashCoverageSummarySet([{ ...summary, extra: true } as never])).toThrow(
      'unsupported keys',
    );
    expect(() =>
      hashCoverageEvaluationInputSet([{ ...summary, governingContractHash: 'not-a-digest' }]),
    ).toThrow('lowercase SHA-256');

    let getterReads = 0;
    const accessorSummaries = [summary];
    Object.defineProperty(accessorSummaries, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return summary;
      },
    });
    expect(() => hashCoverageSummarySet(accessorSummaries)).toThrow('enumerable data property');
    expect(getterReads).toBe(0);

    const counter = { reads: 0 };
    const unread = <T extends object>(value: T): T =>
      new Proxy(value, {
        get: () => {
          counter.reads += 1;
          throw new Error('summary hashing must not read caller Proxy properties');
        },
      });
    const proxiedSummary = unread({
      ...structuredClone(summary),
      expectedIntervals: unread([...structuredClone(summary.expectedIntervals)]),
    });
    const proxiedSet = unread([proxiedSummary]);
    expect(hashCoverageSummarySet(proxiedSet as never)).toBe(summaryHash);
    expect(hashCoverageEvaluationInputSet(proxiedSet as never)).toBe(evaluationHash);
    expect(counter.reads).toBe(0);
  });

  it('rejects noncontiguous partitions, unsupported ratios, replayed winners, and orphan extras', () => {
    const validGapped = evaluate([]);
    const secondInterval = validGapped.expectedIntervals[1];
    if (secondInterval === undefined) throw new Error('expected at least two intervals');
    const changedStart = '2026-01-01T00:16:00.000Z';
    const gapped = {
      ...validGapped,
      expectedIntervals: validGapped.expectedIntervals.map((interval, index) =>
        index === 1
          ? {
              ...interval,
              start: changedStart,
              intervalId: `${changedStart}/${interval.end}`,
            }
          : interval,
      ),
    };
    expect(() => hashCoverageSummarySet([gapped])).toThrow('contiguous partition');

    const invalidRatio = structuredClone(evaluate([])) as unknown as Record<string, unknown>;
    invalidRatio.coverage = { state: 'unknown' };
    expect(() => hashCoverageSummarySet([invalidRatio as never])).toThrow(
      'measured or not_applicable',
    );

    const validReplayed = evaluate([
      createObservation(observationInput('first', '2026-01-01T00:00:00.000Z')),
      createObservation(observationInput('second', '2026-01-01T00:15:00.000Z')),
    ]);
    const accepted = validReplayed.outcomes.filter((outcome) => outcome.kind === 'accepted');
    if (accepted[0]?.kind !== 'accepted' || accepted[1]?.kind !== 'accepted') {
      throw new Error('expected two accepted outcomes');
    }
    const replayed = {
      ...validReplayed,
      outcomes: validReplayed.outcomes.map((outcome) =>
        outcome.kind === 'accepted' && outcome.observationId === accepted[1]?.observationId
          ? { ...outcome, sourceFingerprint: accepted[0]?.sourceFingerprint ?? '' }
          : outcome,
      ),
    };
    expect(() => hashCoverageSummarySet([replayed])).toThrow('replayed source fingerprint');

    const validOrphan = evaluate([
      createObservation(observationInput('winner', '2026-01-01T00:00:00.000Z')),
      createObservation(observationInput('extra', '2026-01-01T00:00:01.000Z')),
    ]);
    const winner = validOrphan.outcomes.find((outcome) => outcome.kind === 'accepted');
    if (winner?.kind !== 'accepted') throw new Error('expected an accepted winner');
    const orphanOutcomes = validOrphan.outcomes.map((outcome) =>
      outcome === winner
        ? {
            kind: 'gap' as const,
            intervalId: winner.intervalId,
            reason: 'no_final_accepted_observation' as const,
          }
        : outcome,
    );
    orphanOutcomes.sort((left, right) => {
      const leftInterval = 'intervalId' in left ? left.intervalId : '';
      const rightInterval = 'intervalId' in right ? right.intervalId : '';
      return (
        (leftInterval < rightInterval ? -1 : leftInterval > rightInterval ? 1 : 0) ||
        (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
        ('observationId' in left ? left.observationId : '').localeCompare(
          'observationId' in right ? right.observationId : '',
        )
      );
    });
    const orphan = {
      ...validOrphan,
      outcomes: orphanOutcomes,
      acceptedCount: 0,
      gapCount: validOrphan.gapCount + 1,
      coverage: {
        state: 'measured' as const,
        numerator: 0,
        denominator: validOrphan.expectedCount,
      },
    };
    expect(() => hashCoverageSummarySet([orphan])).toThrow('require an accepted interval winner');
  });
});

describe('scheduled nonoperation', () => {
  it('removes only wholly contained intervals authorized before their start', () => {
    const stop = createScheduledNonoperation(
      nonoperationInput({
        range: {
          start: '2026-01-01T00:10:00.000Z',
          end: '2026-01-01T00:35:00.000Z',
        },
      }),
    );
    const summary = evaluate(
      [
        createObservation(observationInput('first', '2026-01-01T00:00:00.000Z')),
        createObservation(observationInput('stopped', '2026-01-01T00:15:00.000Z')),
        createObservation(observationInput('third', '2026-01-01T00:30:00.000Z')),
        createObservation(observationInput('fourth', '2026-01-01T00:45:00.000Z')),
      ],
      [stop],
    );

    expect(summary.expectedCount).toBe(3);
    expect(summary.excludedIntervals).toHaveLength(1);
    expect(summary.excludedIntervals[0]).toMatchObject({
      start: '2026-01-01T00:15:00.000Z',
      end: '2026-01-01T00:30:00.000Z',
      nonoperationId: 'stop-1',
    });
    expect(summary.outcomes).toContainEqual({
      kind: 'excluded',
      intervalId: '2026-01-01T00:15:00.000Z/2026-01-01T00:30:00.000Z',
      observationId: 'stopped',
      reason: 'authorized_scheduled_nonoperation',
    });
  });

  it('does not remove a partially overlapping or late-authorized interval', () => {
    const lateStop = createScheduledNonoperation(
      nonoperationInput({ authorizedAt: '2026-01-01T00:20:00.000Z' }),
    );
    const wrongContractStop = createScheduledNonoperation(
      nonoperationInput({ nonoperationId: 'other', contractId: 'contract-2' }),
    );
    const summary = evaluate([], [lateStop, wrongContractStop]);

    expect(summary.excludedIntervals).toEqual([]);
    expect(summary.expectedCount).toBe(4);
    expect(summary.gapCount).toBe(4);
  });

  it('rejects duplicate scheduled-nonoperation identities instead of choosing by input order', () => {
    const first = createScheduledNonoperation(nonoperationInput({ evidenceId: 'first' }));
    const conflictingReplay = createScheduledNonoperation(
      nonoperationInput({ evidenceId: 'conflicting-replay' }),
    );

    expect(() => evaluate([], [first, conflictingReplay])).toThrow(
      'scheduled nonoperation IDs must be unique',
    );
  });
});

describe('typed routing and deterministic selection', () => {
  it('counts one final accepted observation and types all other evidence', () => {
    const observations = [
      createObservation(observationInput('winner', '2026-01-01T00:00:00.000Z')),
      createObservation(
        observationInput('replay', '2026-01-01T00:00:00.000Z', {
          sourceFingerprint: 'fingerprint-winner',
        }),
      ),
      createObservation(observationInput('extra', '2026-01-01T00:00:01.000Z')),
      createObservation(
        observationInput('superseded', '2026-01-01T00:00:02.000Z', {
          supersededBy: 'winner',
        }),
      ),
      createObservation(
        observationInput('quarantined', '2026-01-01T00:00:03.000Z', {
          qualityState: 'quarantined',
          quarantineReason: 'ambiguous_timestamp',
        }),
      ),
      createObservation(
        observationInput('wrong-contract', '2026-01-01T00:00:04.000Z', {
          contractId: 'contract-2',
        }),
      ),
      createObservation(observationInput('outside', '2026-01-01T01:00:00.000Z')),
    ];
    const summary = evaluate(observations);

    expect(summary.acceptedCount).toBe(1);
    expect(summary.gapCount).toBe(3);
    expect(summary.duplicateCount).toBe(3);
    expect(summary.quarantineCount).toBe(3);
    expect(summary.coverage).toEqual({ state: 'measured', numerator: 1, denominator: 4 });
    expect(summary.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'duplicate', reason: 'replayed_fingerprint' }),
        expect.objectContaining({ kind: 'duplicate', reason: 'extra_accepted_observation' }),
        expect.objectContaining({ kind: 'duplicate', reason: 'superseded' }),
        expect.objectContaining({ kind: 'quarantine', reason: 'ambiguous_timestamp' }),
        expect.objectContaining({ kind: 'quarantine', reason: 'contract_mismatch' }),
        expect.objectContaining({ kind: 'quarantine', reason: 'outside_expected_range' }),
        expect.objectContaining({ kind: 'gap', reason: 'no_final_accepted_observation' }),
      ]),
    );
  });

  it('is independent of input order and vendor mapping presence or field names', () => {
    const contract = createRequiredSeriesContract(contractInput());
    const observations = [
      createObservation(observationInput('b', '2026-01-01T00:00:00.000Z')),
      createObservation(observationInput('a', '2026-01-01T00:00:00.000Z')),
    ];
    const forwardEvaluation = {
      contract,
      reportRange: reportHour,
      lifecycleState: 'in_service' as const,
      observations,
      scheduledNonoperations: [],
    };
    const reverseEvaluation = {
      ...forwardEvaluation,
      observations: [...observations].reverse(),
    };
    const forward = evaluateCoverage(forwardEvaluation);
    const reverse = evaluateCoverage(reverseEvaluation);
    expect(reverse).toEqual(forward);

    const mappingA = createVendorMapping({
      schemaVersion: 'vendor-mapping/v1',
      mappingId: 'a',
      version: '1',
      contractId: 'contract-1',
      vendorField: 'FLOW',
      sourceUnit: 'gal/day',
    });
    const mappingB = createVendorMapping({
      schemaVersion: 'vendor-mapping/v1',
      mappingId: 'b',
      version: '2',
      contractId: 'contract-1',
      vendorField: 'totally_different_field',
      sourceUnit: 'gpd',
    });
    expect(bindVendorMappings([contract], [mappingA])[0]?.contract).toEqual(
      bindVendorMappings([contract], [mappingB])[0]?.contract,
    );

    const baseReceipt = {
      tenantId: 'tenant-1',
      systemId: 'system-1',
      reportPeriod: reportHour,
      contracts: [contract],
      coverageEvaluationInputs: [forwardEvaluation],
      coverageSummaries: [forward],
      sourceHashes: [{ logicalName: 'source.csv', sha256: 'a'.repeat(64) }],
      pinnedVersions: [{ name: 'algorithm', value: 'coverage-v1' }],
    } as const;
    expect(createUnsignedReceipt(baseReceipt).receiptId).toBe(
      createUnsignedReceipt({
        ...baseReceipt,
        coverageEvaluationInputs: [reverseEvaluation],
        coverageSummaries: [reverse],
      }).receiptId,
    );
  });

  it('counts a replayed source fingerprint at most once across expected intervals', () => {
    const observations = [
      createObservation(observationInput('first', '2026-01-01T00:00:00.000Z')),
      createObservation(
        observationInput('replayed-next-interval', '2026-01-01T00:15:00.000Z', {
          sourceFingerprint: 'fingerprint-first',
        }),
      ),
    ];

    const summary = evaluate(observations);

    expect(summary.coverage).toEqual({ state: 'measured', numerator: 1, denominator: 4 });
    expect(summary.acceptedCount).toBe(1);
    expect(summary.duplicateCount).toBe(1);
    expect(summary.outcomes).toContainEqual({
      kind: 'duplicate',
      intervalId: '2026-01-01T00:15:00.000Z/2026-01-01T00:30:00.000Z',
      observationId: 'replayed-next-interval',
      reason: 'replayed_fingerprint',
    });
  });

  it('rejects a repeated observation identity before it can inflate coverage', () => {
    const observations = [
      createObservation(observationInput('same-id', '2026-01-01T00:00:00.000Z')),
      createObservation(
        observationInput('same-id', '2026-01-01T00:15:00.000Z', {
          sourceFingerprint: 'conflicting-fingerprint',
        }),
      ),
    ];

    expect(() => evaluate(observations)).toThrow('observation IDs must be unique');
  });

  it('orders canonically equivalent Unicode identifiers without locale dependence', () => {
    const decomposed = createObservation(
      observationInput('e\u0301', '2026-01-01T00:00:00.000Z', {
        sourceFingerprint: 'e\u0301',
      }),
    );
    const composed = createObservation(
      observationInput('\u00e9', '2026-01-01T00:00:00.000Z', {
        sourceFingerprint: '\u00e9',
      }),
    );

    expect(evaluate([decomposed, composed])).toEqual(evaluate([composed, decomposed]));
  });
});
