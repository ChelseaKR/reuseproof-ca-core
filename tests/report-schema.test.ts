/** Fail-closed tests for the report-safe projection reconstruction boundary. */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  evaluateFixture,
  parseEvaluationFixtureJson,
  type ReportContentProjection,
} from '../src/index.js';
import { normalizeReportContentProjection } from '../src/report-schema.js';
import { createTestReceipt } from './report-helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableProjection = DeepMutable<ReportContentProjection>;
type Mutation = (projection: MutableProjection) => void;

const demoText = readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
const demoProjection = evaluateFixture(parseEvaluationFixtureJson(demoText)).receipt
  .reportContentProjection;

function cloneDemo(): MutableProjection {
  return structuredClone(demoProjection) as unknown as MutableProjection;
}

function cloneNotApplicable(): MutableProjection {
  return structuredClone(
    createTestReceipt({
      contractOverrides: {
        effectiveRange: {
          start: '2027-01-01T00:00:00.000Z',
          end: '2027-01-01T01:00:00.000Z',
        },
      },
    }).reportContentProjection,
  ) as unknown as MutableProjection;
}

function replace(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

function requireFixtureItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`demo projection lacks ${label} at index ${index.toString()}`);
  }
  return item;
}

function metadata(projection: MutableProjection, index = 0) {
  return requireFixtureItem(projection.seriesMetadata, index, 'series metadata');
}

function series(projection: MutableProjection, index = 0) {
  return requireFixtureItem(projection.requiredSeries, index, 'required series');
}

function gate(projection: MutableProjection, index = 0) {
  return requireFixtureItem(projection.coverageReadiness.requiredSeries, index, 'readiness gate');
}

function aggregate(projection: MutableProjection, index = 0) {
  return requireFixtureItem(
    projection.coverageReadiness.criticalAggregates,
    index,
    'critical aggregate',
  );
}

function expectRejected(mutate: Mutation, message: string | RegExp): void {
  const projection = cloneDemo();
  mutate(projection);
  expect(() => normalizeReportContentProjection(projection)).toThrow(message);
}

describe('report-safe projection schema', () => {
  it('reconstructs a valid projection and preserves the safe aggregate content', () => {
    const normalized = normalizeReportContentProjection(structuredClone(demoProjection));

    expect(normalized).toEqual(demoProjection);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.requiredSeries)).toBe(true);
  });

  it('rejects unsafe text, invalid descriptors, and malformed digests', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'blank tenant',
        (projection) => {
          replace(projection, 'tenantId', '   ');
        },
        'non-empty text without control characters',
      ],
      [
        'control character',
        (projection) => {
          replace(metadata(projection), 'processCode', 'treatment\u0000system');
        },
        'without control characters',
      ],
      [
        'non-text identifier',
        (projection) => {
          replace(metadata(projection), 'parameterCode', 42);
        },
        'non-empty text',
      ],
      [
        'uppercase digest',
        (projection) => {
          replace(metadata(projection), 'governingContractHash', 'A'.repeat(64));
        },
        'lowercase SHA-256 hex',
      ],
      [
        'bad criticality',
        (projection) => {
          replace(metadata(projection), 'criticality', 'optional');
        },
        'criticality must be required or report_critical',
      ],
      [
        'bad source time zone',
        (projection) => {
          replace(metadata(projection), 'sourceTimeZone', 'Mars/Olympus');
        },
        /IANA time zone/,
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }
  });

  it('rejects unsafe counts, overflow, and contradictory coverage ratios', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'negative count',
        (projection) => {
          series(projection).duplicateCount = -1;
        },
        'non-negative safe integer',
      ],
      [
        'unsafe count',
        (projection) => {
          series(projection).quarantineCount = Number.MAX_SAFE_INTEGER + 1;
        },
        'non-negative safe integer',
      ],
      [
        'accepted plus gap overflow',
        (projection) => {
          const summary = series(projection);
          summary.expectedCount = Number.MAX_SAFE_INTEGER;
          summary.acceptedCount = Number.MAX_SAFE_INTEGER;
          summary.gapCount = 1;
          replace(summary, 'coverage', {
            state: 'measured',
            numerator: Number.MAX_SAFE_INTEGER,
            denominator: Number.MAX_SAFE_INTEGER,
          });
        },
        'exceeds the safe-integer limit',
      ],
      [
        'zero measured denominator',
        (projection) => {
          replace(series(projection), 'coverage', {
            state: 'measured',
            numerator: 2,
            denominator: 0,
          });
        },
        'denominator must be positive',
      ],
      [
        'unknown ratio state',
        (projection) => {
          replace(series(projection), 'coverage', { state: 'estimated' });
        },
        'state must be measured or not_applicable',
      ],
      [
        'not-applicable nonzero ratio',
        (projection) => {
          replace(series(projection), 'coverage', { state: 'not_applicable' });
        },
        'inconsistent coverage accounting',
      ],
      [
        'wrong measured numerator',
        (projection) => {
          const summary = series(projection);
          if (summary.coverage.state !== 'measured') throw new Error('fixture must be measured');
          summary.coverage.numerator -= 1;
        },
        'inconsistent coverage accounting',
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }

    const zeroExpected = cloneNotApplicable();
    replace(series(zeroExpected), 'coverage', {
      state: 'measured',
      numerator: 0,
      denominator: 1,
    });
    expect(() => normalizeReportContentProjection(zeroExpected)).toThrow(
      'inconsistent coverage accounting',
    );
  });

  it('rejects malformed required-series readiness gates', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'accepted above expected',
        (projection) => {
          gate(projection).acceptedCount = 4;
        },
        'acceptedCount cannot exceed expectedCount',
      ],
      [
        'wrong threshold',
        (projection) => {
          replace(gate(projection), 'thresholdBasisPoints', 9_499);
        },
        'thresholdBasisPoints must be 9500',
      ],
      [
        'unsupported reason',
        (projection) => {
          replace(gate(projection), 'reasons', ['coverage_unknown']);
        },
        'unsupported reason',
      ],
      [
        'duplicate reason',
        (projection) => {
          const reason = 'required_series_below_95_percent';
          replace(gate(projection), 'reasons', [reason, reason]);
        },
        'reasons must be unique',
      ],
      [
        'unknown state',
        (projection) => {
          replace(gate(projection), 'state', 'pending');
        },
        'must be ready, blocked, or not_applicable',
      ],
      [
        'contradictory state',
        (projection) => {
          replace(gate(projection), 'state', 'ready');
        },
        'inconsistent readiness accounting',
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }
  });

  it('rejects malformed critical-aggregate readiness gates', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'empty source set',
        (projection) => {
          replace(aggregate(projection), 'sourceContractIds', []);
        },
        'sourceContractIds cannot be empty',
      ],
      [
        'accepted above expected',
        (projection) => {
          aggregate(projection).acceptedSourceIntervalPairs = 4;
        },
        'acceptedSourceIntervalPairs cannot exceed expected',
      ],
      [
        'wrong threshold',
        (projection) => {
          replace(aggregate(projection), 'thresholdBasisPoints', 8_999);
        },
        'thresholdBasisPoints must be 9000',
      ],
      [
        'unsupported reason',
        (projection) => {
          replace(aggregate(projection), 'reasons', ['aggregate_unknown']);
        },
        'unsupported reason',
      ],
      [
        'duplicate reason',
        (projection) => {
          const reason = 'critical_aggregate_below_90_percent';
          replace(aggregate(projection), 'reasons', [reason, reason]);
        },
        'reasons must be unique',
      ],
      [
        'contradictory state',
        (projection) => {
          replace(aggregate(projection), 'state', 'ready');
        },
        'inconsistent aggregate accounting',
      ],
      [
        'contradictory ratio',
        (projection) => {
          const aggregateGate = aggregate(projection);
          if (aggregateGate.coverage.state !== 'measured') {
            throw new Error('fixture must be measured');
          }
          aggregateGate.coverage.numerator -= 1;
        },
        'inconsistent aggregate accounting',
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }
  });

  it('rejects malformed readiness report identity, claims, limitations, and state', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'schema version',
        (projection) => {
          replace(projection.coverageReadiness, 'schemaVersion', 'coverage-readiness/v2');
        },
        'schemaVersion must be coverage-readiness/v1',
      ],
      [
        'claim',
        (projection) => {
          replace(projection.coverageReadiness, 'claim', 'coverage certified');
        },
        'claim must be data coverage preflight only',
      ],
      [
        'digest',
        (projection) => {
          replace(projection.coverageReadiness, 'coverageSummarySetHash', 'not-a-digest');
        },
        'lowercase SHA-256 hex',
      ],
      [
        'limitation',
        (projection) => {
          replace(projection.coverageReadiness, 'limitations', []);
        },
        'must contain exactly the required limitation',
      ],
      [
        'overall state',
        (projection) => {
          replace(projection.coverageReadiness, 'state', 'ready');
        },
        'state does not match its gates',
      ],
      [
        'report limitation',
        (projection) => {
          replace(projection, 'limitations', ['safe for filing']);
        },
        'must contain exactly the required limitation',
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }
  });

  it('rejects cross-record metadata, time-basis, scope, and gate mismatches', () => {
    const cases: readonly [string, Mutation, string | RegExp][] = [
      [
        'metadata count',
        (projection) => {
          projection.seriesMetadata.pop();
        },
        'one metadata item per required series',
      ],
      [
        'governing hash',
        (projection) => {
          series(projection).governingContractHash = '0'.repeat(64);
        },
        'required series do not match immutable metadata',
      ],
      [
        'civil source time zone',
        (projection) => {
          metadata(projection).sourceTimeZone = 'UTC';
        },
        'required series do not match immutable metadata',
      ],
      [
        'shared report time basis',
        (projection) => {
          replace(series(projection, 1), 'reportTimeBasis', { kind: 'utc' });
        },
        'must share one report time basis',
      ],
      [
        'readiness scope',
        (projection) => {
          projection.coverageReadiness.tenantId = 'another-tenant';
        },
        'readiness scope does not match report scope',
      ],
      [
        'missing required gate identity',
        (projection) => {
          gate(projection, 1).contractId = 'zz-missing-contract';
        },
        'readiness gates do not match required-series coverage',
      ],
      [
        'required gate count',
        (projection) => {
          gate(projection).acceptedCount = 1;
        },
        'readiness gates do not match required-series coverage',
      ],
      [
        'aggregate gate count',
        (projection) => {
          const aggregateGate = aggregate(projection);
          aggregateGate.acceptedSourceIntervalPairs = 1;
          if (aggregateGate.coverage.state !== 'measured') {
            throw new Error('fixture must be measured');
          }
          aggregateGate.coverage.numerator = 1;
        },
        'critical aggregate source set does not match metadata',
      ],
    ];

    for (const [label, mutate, message] of cases) {
      expect(() => {
        expectRejected(mutate, message);
      }, label).not.toThrow();
    }
  });
});
