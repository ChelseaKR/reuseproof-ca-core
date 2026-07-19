/** Explicit civil-time resolution for deterministic report boundaries. */

import { Temporal } from '@js-temporal/polyfill';

import { createTimeRange, deepFreeze, type TimeRange } from './model.js';
import { assertStrictRecordKeys, requireIanaTimeZone, requireStrictRecord } from './validation.js';

export const civilTimeDisambiguations = ['earlier', 'later', 'reject'] as const;
export type CivilTimeDisambiguation = (typeof civilTimeDisambiguations)[number];

export interface CivilBoundaryInput {
  readonly localDateTime: string;
  readonly disambiguation: CivilTimeDisambiguation;
}

export interface CivilTimeRangeInput {
  readonly timeZone: string;
  readonly start: CivilBoundaryInput;
  readonly end: CivilBoundaryInput;
}

export interface ResolvedCivilBoundary extends CivilBoundaryInput {
  readonly resolvedAt: string;
}

export type ReportTimeBasis =
  | { readonly kind: 'utc' }
  | {
      readonly kind: 'civil';
      readonly timeZone: string;
      readonly start: ResolvedCivilBoundary;
      readonly end: ResolvedCivilBoundary;
    };

export interface ResolvedReportRange {
  readonly reportRange: TimeRange;
  readonly timeBasis: ReportTimeBasis;
}

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

function resolveBoundary(value: unknown, timeZone: string, label: string): ResolvedCivilBoundary {
  const record = requireStrictRecord(value, ['localDateTime', 'disambiguation'], [], label);
  const localDateTime = requiredString(record, 'localDateTime', label);
  const match = localDateTimePattern.exec(localDateTime);
  if (match === null) {
    throw new TypeError(`${label}.localDateTime must use YYYY-MM-DDTHH:mm:ss.SSS civil format`);
  }
  const disambiguation = record.disambiguation;
  if (
    typeof disambiguation !== 'string' ||
    !(civilTimeDisambiguations as readonly string[]).includes(disambiguation)
  ) {
    throw new TypeError(`${label}.disambiguation must be earlier, later, or reject`);
  }
  try {
    const zoned = Temporal.ZonedDateTime.from(
      {
        timeZone,
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
        millisecond: Number(match[7]),
      },
      {
        disambiguation: disambiguation as CivilTimeDisambiguation,
        overflow: 'reject',
      },
    );
    return deepFreeze({
      localDateTime,
      disambiguation: disambiguation as CivilTimeDisambiguation,
      resolvedAt: new Date(zoned.epochMilliseconds).toISOString(),
    });
  } catch (error) {
    throw new RangeError(
      `${label} cannot be resolved in ${timeZone} with ${disambiguation} disambiguation`,
      { cause: error },
    );
  }
}

/** Resolve two civil boundaries to an auditable, fixed-millisecond UTC range. */
export function resolveCivilTimeRange(value: unknown): ResolvedReportRange {
  const label = 'civilReportRange';
  const record = requireStrictRecord(value, ['timeZone', 'start', 'end'], [], label);
  const timeZone = requireIanaTimeZone(record.timeZone, `${label}.timeZone`);
  const start = resolveBoundary(record.start, timeZone, `${label}.start`);
  const end = resolveBoundary(record.end, timeZone, `${label}.end`);
  const reportRange = createTimeRange(
    { start: start.resolvedAt, end: end.resolvedAt },
    'civilReportRange.resolved',
  );
  return deepFreeze({
    reportRange,
    timeBasis: {
      kind: 'civil',
      timeZone,
      start,
      end,
    },
  });
}

function validateResolvedBoundary(
  value: unknown,
  timeZone: string,
  label: string,
): ResolvedCivilBoundary {
  const record = requireStrictRecord(
    value,
    ['localDateTime', 'disambiguation', 'resolvedAt'],
    [],
    label,
  );
  const calculated = resolveBoundary(
    {
      localDateTime: record.localDateTime,
      disambiguation: record.disambiguation,
    },
    timeZone,
    label,
  );
  const resolvedAt = requiredString(record, 'resolvedAt', label);
  if (resolvedAt !== calculated.resolvedAt) {
    throw new RangeError(`${label}.resolvedAt does not match its civil-time decision`);
  }
  return calculated;
}

/** Validate a caller-supplied time basis instead of trusting resolved metadata. */
export function createReportTimeBasis(value: unknown): ReportTimeBasis {
  const label = 'reportTimeBasis';
  const record = requireStrictRecord(value, ['kind'], ['timeZone', 'start', 'end'], label);
  if (record.kind === 'utc') {
    assertStrictRecordKeys(record, ['kind'], [], label);
    return deepFreeze({ kind: 'utc' });
  }
  if (record.kind !== 'civil') {
    throw new TypeError('reportTimeBasis.kind must be utc or civil');
  }
  assertStrictRecordKeys(record, ['kind', 'timeZone', 'start', 'end'], [], label);
  const timeZone = requireIanaTimeZone(record.timeZone, `${label}.timeZone`);
  const start = validateResolvedBoundary(record.start, timeZone, `${label}.start`);
  const end = validateResolvedBoundary(record.end, timeZone, `${label}.end`);
  createTimeRange({ start: start.resolvedAt, end: end.resolvedAt }, `${label}.resolved`);
  return deepFreeze({ kind: 'civil', timeZone, start, end });
}
