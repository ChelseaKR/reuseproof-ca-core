/** Civil-time resolution and DST denominator boundary tests. */

import { describe, expect, it } from 'vitest';

import {
  createReportTimeBasis,
  createRequiredSeriesContract,
  evaluateCoverage,
  resolveCivilTimeRange,
} from '../src/index.js';
import { contractInput } from './helpers.js';

function civilRange(
  start: string,
  end: string,
  disambiguation: 'earlier' | 'later' | 'reject' = 'reject',
) {
  return {
    timeZone: 'America/Los_Angeles',
    start: { localDateTime: start, disambiguation },
    end: { localDateTime: end, disambiguation },
  } as const;
}

describe('explicit civil-time resolution', () => {
  it('resolves an ordinary local range to fixed UTC instants and records the decision', () => {
    const resolved = resolveCivilTimeRange(
      civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
    );

    expect(resolved.reportRange).toEqual({
      start: '2026-01-01T08:00:00.000Z',
      end: '2026-01-01T09:00:00.000Z',
    });
    expect(resolved.timeBasis).toMatchObject({
      kind: 'civil',
      timeZone: 'America/Los_Angeles',
      start: { disambiguation: 'reject', resolvedAt: '2026-01-01T08:00:00.000Z' },
      end: { disambiguation: 'reject', resolvedAt: '2026-01-01T09:00:00.000Z' },
    });
    expect(createReportTimeBasis(resolved.timeBasis)).toEqual(resolved.timeBasis);
    expect(Object.isFrozen(resolved.timeBasis)).toBe(true);
    expect(createReportTimeBasis({ kind: 'utc' })).toEqual({ kind: 'utc' });
  });

  it('requires an explicit choice for a repeated fall-back wall time', () => {
    const earlier = resolveCivilTimeRange(
      civilRange('2026-11-01T01:30:00.000', '2026-11-01T02:30:00.000', 'earlier'),
    );
    const later = resolveCivilTimeRange(
      civilRange('2026-11-01T01:30:00.000', '2026-11-01T02:30:00.000', 'later'),
    );

    expect(earlier.reportRange.start).toBe('2026-11-01T08:30:00.000Z');
    expect(later.reportRange.start).toBe('2026-11-01T09:30:00.000Z');
    expect(() =>
      resolveCivilTimeRange(civilRange('2026-11-01T01:30:00.000', '2026-11-01T02:30:00.000')),
    ).toThrow('cannot be resolved');
  });

  it('requires an explicit choice for a nonexistent spring-forward wall time', () => {
    const earlier = resolveCivilTimeRange(
      civilRange('2026-03-08T02:30:00.000', '2026-03-08T04:00:00.000', 'earlier'),
    );
    const later = resolveCivilTimeRange(
      civilRange('2026-03-08T02:30:00.000', '2026-03-08T04:00:00.000', 'later'),
    );

    expect(earlier.reportRange.start).toBe('2026-03-08T09:30:00.000Z');
    expect(later.reportRange.start).toBe('2026-03-08T10:30:00.000Z');
    expect(() =>
      resolveCivilTimeRange(civilRange('2026-03-08T02:30:00.000', '2026-03-08T04:00:00.000')),
    ).toThrow('cannot be resolved');
  });

  it.each([
    [null, 'must be an object'],
    [{}, 'timeZone'],
    [
      { ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'), extra: true },
      'unsupported keys',
    ],
    [
      { ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'), timeZone: '' },
      'recognized IANA time zone',
    ],
    [
      { ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'), start: null },
      'must be an object',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        start: { localDateTime: '', disambiguation: 'reject' },
      },
      'non-empty string',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        start: { localDateTime: '2026-01-01T00:00:00.000', disambiguation: 'reject', extra: true },
      },
      'unsupported keys',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        start: { localDateTime: '2026-01-01 00:00', disambiguation: 'reject' },
      },
      'civil format',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        start: { localDateTime: '2026-01-01T00:00:00.000', disambiguation: 'compatible' },
      },
      'earlier, later, or reject',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        start: { localDateTime: '2026-02-30T00:00:00.000', disambiguation: 'reject' },
      },
      'cannot be resolved',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        timeZone: 'Not/A_Zone',
      },
      'recognized IANA time zone',
    ],
    [
      {
        ...civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
        timeZone: '-08:00',
      },
      'recognized IANA time zone',
    ],
    [civilRange('2026-01-02T00:00:00.000', '2026-01-01T00:00:00.000'), 'start < end'],
  ])('rejects malformed or unresolved civil ranges %#', (value, message) => {
    expect(() => resolveCivilTimeRange(value)).toThrow(message);
  });

  it('rejects inherited, class, and symbol-bearing civil-time inputs while allowing null prototypes', () => {
    const valid = civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000');
    const inherited = Object.create(valid) as unknown;
    class CivilRangeRecord {
      public readonly recordKind = 'class-instance';
    }
    const classRecord = Object.assign(new CivilRangeRecord(), valid);
    const symbolRecord = { ...valid, [Symbol('unexpected')]: true };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, valid);

    expect(() => resolveCivilTimeRange(inherited)).toThrow('plain object');
    expect(() => resolveCivilTimeRange(classRecord)).toThrow('plain object');
    expect(() => resolveCivilTimeRange(symbolRecord)).toThrow('symbol keys');
    expect(resolveCivilTimeRange(nullPrototype).reportRange).toEqual({
      start: '2026-01-01T08:00:00.000Z',
      end: '2026-01-01T09:00:00.000Z',
    });
  });

  it.each([
    [null, 'must be an object'],
    [{ kind: 'other' }, 'must be utc or civil'],
    [{ kind: 'utc', extra: true }, 'unsupported keys'],
    [
      {
        kind: 'civil',
        timeZone: 'America/Los_Angeles',
        start: {
          localDateTime: '2026-01-01T00:00:00.000',
          disambiguation: 'reject',
          resolvedAt: '2026-01-01T08:00:00.001Z',
        },
        end: {
          localDateTime: '2026-01-01T01:00:00.000',
          disambiguation: 'reject',
          resolvedAt: '2026-01-01T09:00:00.000Z',
        },
      },
      'does not match',
    ],
    [
      {
        kind: 'civil',
        timeZone: 'America/Los_Angeles',
        start: {
          localDateTime: '2026-01-02T00:00:00.000',
          disambiguation: 'reject',
          resolvedAt: '2026-01-02T08:00:00.000Z',
        },
        end: {
          localDateTime: '2026-01-01T00:00:00.000',
          disambiguation: 'reject',
          resolvedAt: '2026-01-01T08:00:00.000Z',
        },
      },
      'start < end',
    ],
  ])('rejects spoofed report-time metadata %#', (value, message) => {
    expect(() => createReportTimeBasis(value)).toThrow(message);
  });
});

describe('civil days become exact UTC denominator ranges', () => {
  it.each([
    [
      'spring-forward',
      '2026-03-08T00:00:00.000',
      '2026-03-09T00:00:00.000',
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T07:00:00.000Z',
      23,
    ],
    [
      'fall-back',
      '2026-11-01T00:00:00.000',
      '2026-11-02T00:00:00.000',
      '2026-11-01T07:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      25,
    ],
  ])(
    'uses the real elapsed hours on the %s day',
    (_label, localStart, localEnd, utcStart, utcEnd, expectedCount) => {
      const resolved = resolveCivilTimeRange(civilRange(localStart, localEnd));
      const contract = createRequiredSeriesContract(
        contractInput({
          effectiveRange: { start: utcStart, end: utcEnd },
          cadenceMinutes: 60,
        }),
      );
      const summary = evaluateCoverage({
        contract,
        reportRange: resolved.reportRange,
        reportTimeBasis: resolved.timeBasis,
        lifecycleState: 'in_service',
        observations: [],
        scheduledNonoperations: [],
      });

      expect(resolved.reportRange).toEqual({ start: utcStart, end: utcEnd });
      expect(summary.expectedCount).toBe(expectedCount);
      expect(summary.gapCount).toBe(expectedCount);
      expect(summary.reportTimeBasis).toEqual(resolved.timeBasis);
    },
  );

  it('rejects civil metadata whose zone or resolved endpoints differ from the contract evaluation', () => {
    const resolved = resolveCivilTimeRange(
      civilRange('2026-01-01T00:00:00.000', '2026-01-01T01:00:00.000'),
    );
    const timeBasis = resolved.timeBasis;
    if (timeBasis.kind !== 'civil') {
      throw new Error('civil resolver returned a UTC basis');
    }
    const newYork = resolveCivilTimeRange({
      timeZone: 'America/New_York',
      start: { localDateTime: '2026-01-01T03:00:00.000', disambiguation: 'reject' },
      end: { localDateTime: '2026-01-01T04:00:00.000', disambiguation: 'reject' },
    });
    const contract = createRequiredSeriesContract(contractInput());
    const base = {
      contract,
      reportRange: resolved.reportRange,
      lifecycleState: 'in_service' as const,
      observations: [],
      scheduledNonoperations: [],
    };

    expect(() =>
      evaluateCoverage({
        ...base,
        reportTimeBasis: newYork.timeBasis,
      }),
    ).toThrow('time zone does not match');
    expect(() =>
      evaluateCoverage({
        ...base,
        reportRange: {
          start: resolved.reportRange.start,
          end: '2026-01-01T08:30:00.000Z',
        },
        reportTimeBasis: timeBasis,
      }),
    ).toThrow('does not match resolved report range');
  });
});
