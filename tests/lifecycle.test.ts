/** Effective-dated lifecycle parsing and denominator transition tests. */

import { describe, expect, it } from 'vitest';

import {
  createLifecycleTimeline,
  createObservation,
  createRequiredSeriesContract,
  createTimeRange,
  evaluateCoverage,
} from '../src/index.js';
import {
  contractInput,
  lifecyclePeriodInput,
  lifecycleTimelineInput,
  observationInput,
} from './helpers.js';

const reportHour = createTimeRange({
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T01:00:00.000Z',
});

function period(
  lifecycleEventId: string,
  state: 'permitted' | 'commissioning' | 'in_service' | 'suspended' | 'decommissioning',
  start: string,
  end: string,
) {
  return lifecyclePeriodInput({
    lifecycleEventId,
    state,
    effectiveRange: { start, end },
    evidenceId: `synthetic-evidence-${lifecycleEventId}`,
  });
}

describe('strict lifecycle timelines', () => {
  it('sorts adjacent periods deterministically and deeply freezes their evidence references', () => {
    const timeline = createLifecycleTimeline(
      lifecycleTimelineInput({
        periods: [
          period('second', 'suspended', '2026-01-01T00:30:00.000Z', '2026-01-01T01:00:00.000Z'),
          period('first', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z'),
        ],
      }),
    );

    expect(timeline.periods.map(({ lifecycleEventId }) => lifecycleEventId)).toEqual([
      'first',
      'second',
    ]);
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(Object.isFrozen(timeline.periods[0]?.effectiveRange)).toBe(true);
  });

  it('preserves a gap as an explicit fact for the evaluator to reject in an applicable range', () => {
    const timeline = createLifecycleTimeline(
      lifecycleTimelineInput({
        periods: [
          period('first', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T00:20:00.000Z'),
          period('second', 'in_service', '2026-01-01T00:30:00.000Z', '2026-01-01T01:00:00.000Z'),
        ],
      }),
    );

    expect(timeline.periods).toHaveLength(2);
    expect(() =>
      evaluateCoverage({
        contract: createRequiredSeriesContract(contractInput()),
        reportRange: reportHour,
        lifecycleTimeline: timeline,
        observations: [],
        scheduledNonoperations: [],
      }),
    ).toThrow('timeline does not cover');
  });

  it.each([
    [null, 'must be an object'],
    [{ ...lifecycleTimelineInput(), extra: true }, 'unsupported keys'],
    [{ ...lifecycleTimelineInput(), schemaVersion: 'v2' }, 'schemaVersion'],
    [{ ...lifecycleTimelineInput(), periods: 'not-an-array' }, 'must be an array'],
    [{ ...lifecycleTimelineInput(), periods: [] }, 'non-empty array'],
    [{ ...lifecycleTimelineInput(), periods: [null] }, 'must be an object'],
    [
      {
        ...lifecycleTimelineInput(),
        periods: [{ ...lifecyclePeriodInput(), extra: true }],
      },
      'unsupported keys',
    ],
    [
      {
        ...lifecycleTimelineInput(),
        periods: [{ ...lifecyclePeriodInput(), state: 'unknown' }],
      },
      'state must be supported',
    ],
    [
      {
        ...lifecycleTimelineInput(),
        periods: [{ ...lifecyclePeriodInput(), recordedAt: 'yesterday' }],
      },
      'fixed-millisecond',
    ],
    [
      {
        ...lifecycleTimelineInput(),
        periods: [{ ...lifecyclePeriodInput(), lifecycleEventId: '' }],
      },
      'non-empty string',
    ],
    [
      {
        ...lifecycleTimelineInput(),
        periods: [{ ...lifecyclePeriodInput(), evidenceId: '' }],
      },
      'non-empty string',
    ],
    [{ ...lifecycleTimelineInput(), version: '' }, 'non-empty string'],
    [{ ...lifecycleTimelineInput(), tenantId: '' }, 'non-empty string'],
    [{ ...lifecycleTimelineInput(), systemId: '' }, 'non-empty string'],
  ])('rejects malformed lifecycle facts %#', (value, message) => {
    expect(() => createLifecycleTimeline(value)).toThrow(message);
  });

  it('rejects inherited, class, and symbol-bearing lifecycle records while allowing null prototypes', () => {
    const valid = lifecycleTimelineInput();
    const inherited = Object.create(valid) as unknown;
    class LifecycleRecord {
      public readonly recordKind = 'class-instance';
    }
    const classRecord = Object.assign(new LifecycleRecord(), valid);
    const symbolRecord = { ...valid, [Symbol('unexpected')]: true };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, valid);

    expect(() => createLifecycleTimeline(inherited)).toThrow('plain object');
    expect(() => createLifecycleTimeline(classRecord)).toThrow('plain object');
    expect(() => createLifecycleTimeline(symbolRecord)).toThrow('symbol keys');
    expect(createLifecycleTimeline(nullPrototype).version).toBe('synthetic-v1');
  });

  it('rejects duplicate event identity and overlapping effective periods', () => {
    expect(() =>
      createLifecycleTimeline(
        lifecycleTimelineInput({
          periods: [
            period('same', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z'),
            period('same', 'suspended', '2026-01-01T00:30:00.000Z', '2026-01-01T01:00:00.000Z'),
          ],
        }),
      ),
    ).toThrow('event IDs must be unique');
    expect(() =>
      createLifecycleTimeline(
        lifecycleTimelineInput({
          periods: [
            period('first', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T00:40:00.000Z'),
            period('second', 'suspended', '2026-01-01T00:30:00.000Z', '2026-01-01T01:00:00.000Z'),
          ],
        }),
      ),
    ).toThrow('cannot overlap');
  });
});

describe('lifecycle-aware denominator evaluation', () => {
  it('splits cadence at every transition and types ineligible evidence without hiding it', () => {
    const timeline = createLifecycleTimeline(
      lifecycleTimelineInput({
        periods: [
          period('active-1', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T00:20:00.000Z'),
          period('suspended', 'suspended', '2026-01-01T00:20:00.000Z', '2026-01-01T00:40:00.000Z'),
          period('active-2', 'in_service', '2026-01-01T00:40:00.000Z', '2026-01-01T01:00:00.000Z'),
        ],
      }),
    );
    const summary = evaluateCoverage({
      contract: createRequiredSeriesContract(contractInput()),
      reportRange: reportHour,
      lifecycleTimeline: timeline,
      observations: [
        createObservation(observationInput('active-first', '2026-01-01T00:00:00.000Z')),
        createObservation(observationInput('inactive', '2026-01-01T00:20:00.000Z')),
        createObservation(observationInput('active-second', '2026-01-01T00:40:00.000Z')),
      ],
      scheduledNonoperations: [],
    });

    expect(summary.lifecycleBasis).toEqual({
      kind: 'effective_timeline',
      timelineVersion: 'synthetic-v1',
    });
    expect(summary.expectedIntervals.map(({ start, end }) => [start, end])).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z'],
      ['2026-01-01T00:15:00.000Z', '2026-01-01T00:20:00.000Z'],
      ['2026-01-01T00:40:00.000Z', '2026-01-01T00:45:00.000Z'],
      ['2026-01-01T00:45:00.000Z', '2026-01-01T01:00:00.000Z'],
    ]);
    expect(summary.lifecycleExcludedIntervals.map(({ start, end }) => [start, end])).toEqual([
      ['2026-01-01T00:20:00.000Z', '2026-01-01T00:30:00.000Z'],
      ['2026-01-01T00:30:00.000Z', '2026-01-01T00:40:00.000Z'],
    ]);
    expect(summary.expectedCount).toBe(4);
    expect(summary.acceptedCount).toBe(2);
    expect(summary.gapCount).toBe(2);
    expect(summary.outcomes).toContainEqual({
      kind: 'excluded',
      intervalId: '2026-01-01T00:20:00.000Z/2026-01-01T00:30:00.000Z',
      observationId: 'inactive',
      reason: 'lifecycle_state_ineligible',
    });
    expect(summary.expectedIntervals[1]).toMatchObject({
      lifecycleEventId: 'active-1',
      lifecycleEvidenceId: 'synthetic-evidence-active-1',
    });
  });

  it('advances past earlier history and still requires full applicable coverage', () => {
    const timeline = createLifecycleTimeline(
      lifecycleTimelineInput({
        periods: [
          period('prior', 'permitted', '2025-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          period('current', 'in_service', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        ],
      }),
    );
    const summary = evaluateCoverage({
      contract: createRequiredSeriesContract(contractInput()),
      reportRange: reportHour,
      lifecycleTimeline: timeline,
      observations: [],
      scheduledNonoperations: [],
    });

    expect(summary.expectedCount).toBe(4);
    expect(summary.lifecycleExcludedIntervals).toEqual([]);
  });

  it('turns a resolved inactive state into explicit lifecycle exclusions and N/A coverage', () => {
    const summary = evaluateCoverage({
      contract: createRequiredSeriesContract(contractInput()),
      reportRange: reportHour,
      lifecycleState: 'suspended',
      observations: [createObservation(observationInput('inactive', reportHour.start))],
      scheduledNonoperations: [],
    });

    expect(summary.lifecycleBasis).toEqual({ kind: 'resolved_state', state: 'suspended' });
    expect(summary.expectedCount).toBe(0);
    expect(summary.lifecycleExcludedIntervals).toHaveLength(4);
    expect(summary.coverage).toEqual({ state: 'not_applicable' });
    expect(summary.outcomes[0]).toMatchObject({
      kind: 'excluded',
      reason: 'lifecycle_state_ineligible',
    });
  });

  it('rejects timeline scope drift and unsupported direct lifecycle values', () => {
    const contract = createRequiredSeriesContract(contractInput());
    const wrongScope = createLifecycleTimeline(
      lifecycleTimelineInput({ tenantId: 'another-tenant' }),
    );
    expect(() =>
      evaluateCoverage({
        contract,
        reportRange: reportHour,
        lifecycleTimeline: wrongScope,
        observations: [],
        scheduledNonoperations: [],
      }),
    ).toThrow('scope does not match');
    expect(() =>
      evaluateCoverage({
        contract,
        reportRange: reportHour,
        lifecycleState: 'unknown' as never,
        observations: [],
        scheduledNonoperations: [],
      }),
    ).toThrow('lifecycle state must be supported');
  });
});
