import { describe, expect, it } from 'vitest';

import {
  evaluateReconciledCsvEvidence,
  validateReconciledCsvEvidenceIntegrity,
  type ReconciledCsvEvidenceInput,
  type ReconciledCsvEvidenceResult,
} from '../src/index.js';
import {
  REPORT_RANGE,
  csvBytes,
  defaultCsvBytes,
  reconciledEvidenceInput,
  testSeriesParts,
  type TestSeriesParts,
} from './reconciled-evaluation-helpers.js';

function mutableRecord(value: unknown, label = 'test value'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown, label = 'test value'): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function setPath(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let current = value;
  for (const segment of path.slice(0, -1)) {
    current =
      typeof segment === 'number'
        ? mutableArray(current)[segment]
        : mutableRecord(current)[segment];
  }
  const final = path.at(-1);
  if (typeof final === 'number') {
    mutableArray(current)[final] = replacement;
  } else if (typeof final === 'string') {
    mutableRecord(current)[final] = replacement;
  } else {
    throw new RangeError('test mutation path cannot be empty');
  }
}

function cloneResult(result: ReconciledCsvEvidenceResult): unknown {
  return structuredClone(result);
}

function mixedSourceInput(
  sourceObjects: readonly Uint8Array[] = [defaultCsvBytes()],
  overrides: Readonly<Record<string, unknown>> = {},
): ReconciledCsvEvidenceInput {
  const first = testSeriesParts({ sourceObjects });
  const second = testSeriesParts({ contractId: 'contract-2', sourceObjects: [] });
  return reconciledEvidenceInput([first, second], overrides);
}

describe('validateReconciledCsvEvidenceIntegrity', () => {
  it('returns a new canonical frozen replay for both reconciled and source-less series', () => {
    const sourceA = csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit');
    const sourceB = csvBytes('b,2026-01-01T00:35:00.000Z,4,source-unit');
    const input = mixedSourceInput([sourceA, sourceB]);
    const result = evaluateReconciledCsvEvidence(input);
    const reorderedParts: readonly TestSeriesParts[] = [
      testSeriesParts({ contractId: 'contract-2', sourceObjects: [] }),
      testSeriesParts({ sourceObjects: [sourceB, sourceA] }),
    ];
    const replayed = validateReconciledCsvEvidenceIntegrity(
      result,
      reconciledEvidenceInput(reorderedParts),
    );

    expect(replayed).toEqual(result);
    expect(replayed).not.toBe(result);
    expect(replayed.series.map(({ reconciliation }) => reconciliation.kind)).toEqual([
      'reconciled',
      'no_source_objects',
    ]);
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Object.isFrozen(replayed.series)).toBe(true);
  });

  it('requires exact delivery-retry accounting to pair with the supplied input', () => {
    const source = defaultCsvBytes();
    const originalInput = reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]);
    const retryInput = reconciledEvidenceInput([
      testSeriesParts({ sourceObjects: [source, source] }),
    ]);
    const original = evaluateReconciledCsvEvidence(originalInput);
    const retried = evaluateReconciledCsvEvidence(retryInput);

    expect(validateReconciledCsvEvidenceIntegrity(retried, retryInput)).toEqual(retried);
    expect(() => validateReconciledCsvEvidenceIntegrity(original, retryInput)).toThrow(
      'does not match the exact evidence replay',
    );
  });

  const changedInputs: readonly {
    readonly label: string;
    readonly create: () => ReconciledCsvEvidenceInput;
  }[] = [
    {
      label: 'source bytes',
      create: () =>
        reconciledEvidenceInput([
          testSeriesParts({
            sourceObjects: [
              csvBytes(
                'a,2026-01-01T00:05:00.000Z,8,source-unit',
                'b,2026-01-01T00:35:00.000Z,4,source-unit',
              ),
            ],
          }),
        ]),
    },
    {
      label: 'governance',
      create: () =>
        reconciledEvidenceInput([
          testSeriesParts({
            conversionRuleOverrides: { authorizationId: 'different-unit-authorization' },
          }),
        ]),
    },
    {
      label: 'report time basis',
      create: () =>
        reconciledEvidenceInput([testSeriesParts()], {
          reportTimeBasis: {
            kind: 'civil',
            timeZone: 'UTC',
            start: {
              localDateTime: '2026-01-01T00:00:00.000',
              disambiguation: 'earlier',
              resolvedAt: REPORT_RANGE.start,
            },
            end: {
              localDateTime: '2026-01-01T01:00:00.000',
              disambiguation: 'earlier',
              resolvedAt: REPORT_RANGE.end,
            },
          },
        }),
    },
    {
      label: 'lifecycle basis',
      create: () => reconciledEvidenceInput([testSeriesParts()], { lifecycleState: 'suspended' }),
    },
    {
      label: 'scheduled nonoperation',
      create: () =>
        reconciledEvidenceInput([testSeriesParts()], {
          scheduledNonoperations: [
            {
              nonoperationId: 'integrity-stop-1',
              contractId: 'contract-1',
              range: {
                start: REPORT_RANGE.start,
                end: '2026-01-01T00:30:00.000Z',
              },
              authorizedAt: '2025-12-01T00:00:00.000Z',
              evidenceId: 'integrity-stop-evidence-1',
            },
          ],
        }),
    },
  ];

  it.each(changedInputs)('rejects a result paired with different $label', ({ create }) => {
    const originalInput = reconciledEvidenceInput([testSeriesParts()]);
    const result = evaluateReconciledCsvEvidence(originalInput);

    expect(() => validateReconciledCsvEvidenceIntegrity(result, create())).toThrow();
  });

  const tamperCases: readonly {
    readonly label: string;
    readonly path: readonly (string | number)[];
    readonly replacement: unknown;
  }[] = [
    {
      label: 'source-state union',
      path: ['series', 0, 'reconciliation', 'kind'],
      replacement: 'no_source_objects',
    },
    {
      label: 'governance hash',
      path: ['series', 0, 'reconciliation', 'governance', 'governanceHash'],
      replacement: '0'.repeat(64),
    },
    {
      label: 'source accounting',
      path: ['series', 0, 'reconciliation', 'result', 'submittedSourceCount'],
      replacement: 99,
    },
    {
      label: 'reconciliation outcome',
      path: ['series', 0, 'reconciliation', 'result', 'outcomes', 0, 'kind'],
      replacement: 'conflict',
    },
    {
      label: 'coverage count',
      path: ['series', 0, 'coverageSummary', 'acceptedCount'],
      replacement: 99,
    },
    {
      label: 'aggregate value',
      path: ['series', 0, 'dailyAggregate', 'aggregate', 'values', 0, 'value'],
      replacement: '999.00',
    },
    {
      label: 'readiness state',
      path: ['coverageReadiness', 'state'],
      replacement: 'blocked',
    },
    {
      label: 'receipt ID',
      path: ['receipt', 'receiptId'],
      replacement: 'receipt_invalid',
    },
    {
      label: 'frozen snapshot ID',
      path: ['frozenReport', 'snapshotId'],
      replacement: 'snapshot_invalid',
    },
    {
      label: 'root evaluation hash',
      path: ['evaluationHash'],
      replacement: 'f'.repeat(64),
    },
  ];

  it.each(tamperCases)('rejects a tampered $label', ({ path, replacement }) => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const tampered = cloneResult(evaluateReconciledCsvEvidence(input));
    setPath(tampered, path, replacement);

    expect(() =>
      validateReconciledCsvEvidenceIntegrity(tampered as ReconciledCsvEvidenceResult, input),
    ).toThrow('does not match the exact evidence replay');
  });

  it('rejects coordinated field and hash tampering rather than trusting rehashed wrappers', () => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const tampered = cloneResult(evaluateReconciledCsvEvidence(input));
    setPath(tampered, ['series', 0, 'coverageSummary', 'acceptedCount'], 0);
    setPath(tampered, ['series', 0, 'coverageSummary', 'evaluationInputHash'], 'a'.repeat(64));
    setPath(tampered, ['evaluationHash'], 'b'.repeat(64));

    expect(() =>
      validateReconciledCsvEvidenceIntegrity(tampered as ReconciledCsvEvidenceResult, input),
    ).toThrow('does not match the exact evidence replay');
  });

  it('rejects extra, missing, symbol, custom-prototype, and sparse result shapes', () => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const result = evaluateReconciledCsvEvidence(input);

    const extra = mutableRecord(cloneResult(result));
    extra.injected = true;
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(
        extra as unknown as ReconciledCsvEvidenceResult,
        input,
      ),
    ).toThrow('unsupported keys');

    const missing = mutableRecord(cloneResult(result));
    delete missing.evaluationHash;
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(
        missing as unknown as ReconciledCsvEvidenceResult,
        input,
      ),
    ).toThrow('missing required keys');

    const symbol = mutableRecord(cloneResult(result));
    Reflect.defineProperty(symbol, Symbol('injected'), {
      enumerable: true,
      value: true,
    });
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(
        symbol as unknown as ReconciledCsvEvidenceResult,
        input,
      ),
    ).toThrow('symbol keys');

    const customPrototype = mutableRecord(cloneResult(result));
    Object.setPrototypeOf(customPrototype, { injected: true });
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(
        customPrototype as unknown as ReconciledCsvEvidenceResult,
        input,
      ),
    ).toThrow('plain object');

    const sparse = cloneResult(result);
    const sparseSeries = mutableArray(mutableRecord(sparse).series);
    Reflect.deleteProperty(sparseSeries, '0');
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(sparse as ReconciledCsvEvidenceResult, input),
    ).toThrow('dense array');

    const shorter = cloneResult(result);
    mutableArray(mutableRecord(shorter).series).splice(0, 1);
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(shorter as ReconciledCsvEvidenceResult, input),
    ).toThrow('length does not match');
  });

  it('rejects a nested accessor without invoking it', () => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const tampered = cloneResult(evaluateReconciledCsvEvidence(input));
    const series = mutableRecord(mutableArray(mutableRecord(tampered).series)[0]);
    const summary = mutableRecord(series.coverageSummary);
    let getterReads = 0;
    Object.defineProperty(summary, 'acceptedCount', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('integrity validation must not invoke accessors');
      },
    });

    expect(() =>
      validateReconciledCsvEvidenceIntegrity(tampered as ReconciledCsvEvidenceResult, input),
    ).toThrow('enumerable data property');
    expect(getterReads).toBe(0);
  });

  it('rejects symbol, accessor, and custom-prototype result arrays', () => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const result = evaluateReconciledCsvEvidence(input);

    const symbolResult = cloneResult(result);
    const symbolSeries = mutableArray(mutableRecord(symbolResult).series);
    Reflect.defineProperty(symbolSeries, Symbol('injected'), {
      enumerable: true,
      value: true,
    });
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(symbolResult as ReconciledCsvEvidenceResult, input),
    ).toThrow('symbol keys');

    const accessorResult = cloneResult(result);
    const accessorSeries = mutableArray(mutableRecord(accessorResult).series);
    let getterReads = 0;
    Object.defineProperty(accessorSeries, '0', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('integrity validation must not invoke array accessors');
      },
    });
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(accessorResult as ReconciledCsvEvidenceResult, input),
    ).toThrow('enumerable data property');
    expect(getterReads).toBe(0);

    const prototypeResult = cloneResult(result);
    const prototypeSeries = mutableArray(mutableRecord(prototypeResult).series);
    Object.setPrototypeOf(prototypeSeries, []);
    expect(() =>
      validateReconciledCsvEvidenceIntegrity(prototypeResult as ReconciledCsvEvidenceResult, input),
    ).toThrow('Array.prototype');
  });

  it('rejects a stateful array Proxy that hides extra replay entries during precheck', () => {
    const input = reconciledEvidenceInput([testSeriesParts()]);
    const tampered = mutableRecord(cloneResult(evaluateReconciledCsvEvidence(input)));
    const series = mutableArray(tampered.series);
    const first = series[0];
    if (first === undefined) {
      throw new Error('test result requires one series');
    }
    series.push(structuredClone(first));
    let lengthDescriptorReads = 0;
    tampered.series = new Proxy(series, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === 'length' && descriptor !== undefined) {
          lengthDescriptorReads += 1;
          return lengthDescriptorReads === 1 ? { ...descriptor, value: 1 } : descriptor;
        }
        return descriptor;
      },
    });

    expect(() =>
      validateReconciledCsvEvidenceIntegrity(
        tampered as unknown as ReconciledCsvEvidenceResult,
        input,
      ),
    ).toThrow('length does not match');
    expect(lengthDescriptorReads).toBeGreaterThanOrEqual(2);
  });
});
