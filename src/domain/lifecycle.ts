/** Effective-dated lifecycle facts used only to activate coverage denominators. */

import { compareCodeUnits } from './canonical.js';
import {
  createTimeRange,
  deepFreeze,
  instantMilliseconds,
  lifecycleStates,
  type LifecycleState,
  type TimeRange,
} from './model.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export interface LifecyclePeriod {
  readonly lifecycleEventId: string;
  readonly state: LifecycleState;
  readonly effectiveRange: TimeRange;
  readonly evidenceId: string;
  readonly recordedAt: string;
}

export interface LifecycleTimeline {
  readonly schemaVersion: 'lifecycle-timeline/v1';
  readonly version: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly periods: readonly LifecyclePeriod[];
}

export type LifecycleBasis =
  | {
      readonly kind: 'resolved_state';
      readonly state: LifecycleState;
    }
  | {
      readonly kind: 'effective_timeline';
      readonly timelineVersion: string;
    };

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

function createLifecyclePeriod(value: unknown, index: number): LifecyclePeriod {
  const label = `lifecycleTimeline.periods[${index.toString()}]`;
  const record = requireStrictRecord(
    value,
    ['lifecycleEventId', 'state', 'effectiveRange', 'evidenceId', 'recordedAt'],
    [],
    label,
  );
  const state = record.state;
  if (typeof state !== 'string' || !(lifecycleStates as readonly string[]).includes(state)) {
    throw new TypeError(`${label}.state must be supported`);
  }
  const recordedAt = requiredString(record, 'recordedAt', label);
  instantMilliseconds(recordedAt, `${label}.recordedAt`);
  return deepFreeze({
    lifecycleEventId: requiredString(record, 'lifecycleEventId', label),
    state: state as LifecycleState,
    effectiveRange: createTimeRange(record.effectiveRange, `${label}.effectiveRange`),
    evidenceId: requiredString(record, 'evidenceId', label),
    recordedAt,
  });
}

/** Parse a strict timeline, preserving gaps but rejecting overlap and ambiguous identity. */
export function createLifecycleTimeline(value: unknown): LifecycleTimeline {
  const label = 'lifecycleTimeline';
  const record = requireStrictRecord(
    value,
    ['schemaVersion', 'version', 'tenantId', 'systemId', 'periods'],
    [],
    label,
  );
  if (record.schemaVersion !== 'lifecycle-timeline/v1') {
    throw new TypeError('lifecycleTimeline.schemaVersion must be lifecycle-timeline/v1');
  }
  const periodValues = requireStrictArray(record.periods, 'lifecycleTimeline.periods');
  if (periodValues.length === 0) {
    throw new TypeError('lifecycleTimeline.periods must be a non-empty array');
  }
  const periods = periodValues
    .map((period, index) => createLifecyclePeriod(period, index))
    .sort(
      (left, right) =>
        compareCodeUnits(left.effectiveRange.start, right.effectiveRange.start) ||
        compareCodeUnits(left.lifecycleEventId, right.lifecycleEventId),
    );
  const eventIds = periods.map(({ lifecycleEventId }) => lifecycleEventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new RangeError('lifecycle event IDs must be unique');
  }
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      instantMilliseconds(previous.effectiveRange.end) >
        instantMilliseconds(current.effectiveRange.start)
    ) {
      throw new RangeError('lifecycle periods cannot overlap');
    }
  }
  return deepFreeze({
    schemaVersion: 'lifecycle-timeline/v1',
    version: requiredString(record, 'version', label),
    tenantId: requiredString(record, 'tenantId', label),
    systemId: requiredString(record, 'systemId', label),
    periods,
  });
}
