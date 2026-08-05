import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_RECONCILED_EVALUATION_SOURCE_BYTES,
  MAX_RECONCILED_EVALUATION_SOURCES,
  evaluateReconciledCsvEvidence,
  type ReconciledCsvEvidenceInput,
  type ReconciledCsvEvidenceResult,
} from '../src/index.js';
import {
  CSV_HEADER,
  REPORT_RANGE,
  csvBytes,
  defaultCsvBytes,
  lifecycleTimeline,
  reconciledEvidenceInput,
  testSeriesParts,
  type TestSeriesParts,
} from './reconciled-evaluation-helpers.js';

function firstSeries(result: ReconciledCsvEvidenceResult) {
  const series = result.series[0];
  if (series === undefined) {
    throw new Error('expected a reconciled series result');
  }
  return series;
}

function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function withoutLifecycle(input: ReconciledCsvEvidenceInput): Record<string, unknown> {
  const value = { ...input } as Record<string, unknown>;
  delete value.lifecycleState;
  delete value.lifecycleTimeline;
  return value;
}

function withSeries(parts: TestSeriesParts, sourceObjects: readonly Uint8Array[]): TestSeriesParts {
  return {
    contract: parts.contract,
    series: { ...parts.series, sourceObjects },
  };
}

function acceptedObservationIds(result: ReconciledCsvEvidenceResult): readonly string[] {
  return firstSeries(result).coverageSummary.outcomes.flatMap((outcome) =>
    outcome.kind === 'accepted' ? [outcome.observationId] : [],
  );
}

describe('evaluateReconciledCsvEvidence', () => {
  it('threads exact CSV evidence through coverage, aggregation, receipt, and freeze', () => {
    const parts = testSeriesParts();
    const source = parts.series.sourceObjects[0];
    if (source === undefined) {
      throw new Error('expected a synthetic source object');
    }
    const first = evaluateReconciledCsvEvidence(reconciledEvidenceInput([parts]));
    const replay = evaluateReconciledCsvEvidence(structuredClone(reconciledEvidenceInput([parts])));
    const series = firstSeries(first);

    expect(series.reconciliation).toMatchObject({
      kind: 'reconciled',
      result: {
        submittedSourceCount: 1,
        uniqueSourceCount: 1,
        acceptedIdentityCount: 2,
        quarantinedIdentityCount: 0,
      },
    });
    expect(series.coverageSummary).toMatchObject({
      expectedCount: 2,
      acceptedCount: 2,
      gapCount: 0,
      duplicateCount: 0,
      quarantineCount: 0,
    });
    expect(series.dailyAggregate).toMatchObject({
      aggregate: {
        values: [
          {
            civilDate: '2026-01-01',
            value: '1.50',
            canonicalUnit: 'canonical-unit',
            acceptedObservationCount: 2,
          },
        ],
      },
    });
    expect(first.coverageReadiness.state).toBe('ready');
    const digest = digestBytes(source);
    expect(
      first.receipt.core.evidenceManifest.sourceHashes.filter(({ logicalName }) =>
        logicalName.startsWith('csv-source-object:'),
      ),
    ).toEqual([
      {
        logicalName: `csv-source-object:${digest}`,
        sha256: digest,
      },
    ]);
    expect(first.receipt.core.evidenceManifest.pinnedVersions).toContainEqual({
      name: 'reconciled-evidence-set:contract-1@1',
      value: series.evidenceSetHash,
    });
    expect(first.receipt.receiptId).toBe(replay.receipt.receiptId);
    expect(first.frozenReport.snapshotId).toBe(replay.frozenReport.snapshotId);
    expect(first.evaluationHash).toBe(replay.evaluationHash);
    expect(first.evaluationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.series)).toBe(true);
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.reconciliation)).toBe(true);
    expect(Object.isFrozen(series.dailyAggregate)).toBe(true);
  });

  it('is invariant to contract, series, and source order while deduplicating sources globally', () => {
    const sourceA = csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit');
    const sourceB = csvBytes('b,2026-01-01T00:35:00.000Z,4,source-unit');
    const firstParts = testSeriesParts({ sourceObjects: [sourceA, sourceB] });
    const secondParts = testSeriesParts({
      contractId: 'contract-2',
      sourceObjects: [sourceA],
    });
    const ordered = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([firstParts, secondParts]),
    );
    const reversedFirst = withSeries(firstParts, [sourceB, sourceA]);
    const reversed = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([secondParts, reversedFirst]),
    );

    expect(reversed).toEqual(ordered);
    expect(ordered.series.map(({ contractId }) => contractId)).toEqual([
      'contract-1',
      'contract-2',
    ]);
    const sourceHashes = ordered.receipt.core.evidenceManifest.sourceHashes.filter(
      ({ logicalName }) => logicalName.startsWith('csv-source-object:'),
    );
    expect(sourceHashes).toHaveLength(2);
    expect(sourceHashes.map(({ sha256: digest }) => digest)).toEqual(
      [digestBytes(sourceA), digestBytes(sourceB)].sort(),
    );
  });

  it('keeps receipt provenance names distinct when contract components contain separators', () => {
    const firstParts = testSeriesParts({
      contractId: 'a@b',
      contractVersion: 'c',
      sourceObjects: [],
    });
    const secondParts = testSeriesParts({
      contractId: 'a',
      contractVersion: 'b@c',
      sourceObjects: [],
    });
    const result = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([firstParts, secondParts]),
    );
    const pinNames = result.receipt.core.evidenceManifest.pinnedVersions.map(({ name }) => name);

    expect(pinNames).toContain('reconciled-evidence-set:a%40b@c');
    expect(pinNames).toContain('reconciled-evidence-set:a@b%40c');
    expect(new Set(pinNames).size).toBe(pinNames.length);
  });

  it('separates exact delivery retries from the canonical evidence set', () => {
    const source = defaultCsvBytes();
    const parts = testSeriesParts({ sourceObjects: [source] });
    const retriedParts = withSeries(parts, [source, source]);
    const first = evaluateReconciledCsvEvidence(reconciledEvidenceInput([parts]));
    const retried = evaluateReconciledCsvEvidence(reconciledEvidenceInput([retriedParts]));
    const firstResult = firstSeries(first);
    const retriedResult = firstSeries(retried);

    expect(retriedResult.reconciliation).toMatchObject({
      kind: 'reconciled',
      result: {
        submittedSourceCount: 2,
        uniqueSourceCount: 1,
        duplicateSourceSubmissionCount: 1,
      },
    });
    expect(retriedResult.reconciliation.operationalHash).not.toBe(
      firstResult.reconciliation.operationalHash,
    );
    expect(retriedResult.evidenceSetHash).toBe(firstResult.evidenceSetHash);
    expect(retriedResult.coverageSummary).toEqual(firstResult.coverageSummary);
    expect(retriedResult.dailyAggregate).toEqual(firstResult.dailyAggregate);
    expect(retried.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(retried.frozenReport.snapshotId).toBe(first.frozenReport.snapshotId);
    expect(retried.evaluationHash).not.toBe(first.evaluationHash);
  });

  it('retains byte-distinct semantic replays as distinct canonical evidence', () => {
    const source = defaultCsvBytes();
    const semanticReplay = new TextEncoder().encode(`${new TextDecoder().decode(source)}\n`);
    const original = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]),
    );
    const replayed = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source, semanticReplay] })]),
    );
    const originalSeries = firstSeries(original);
    const replayedSeries = firstSeries(replayed);

    expect(replayedSeries.reconciliation).toMatchObject({
      kind: 'reconciled',
      result: {
        submittedSourceCount: 2,
        uniqueSourceCount: 2,
        duplicateSourceSubmissionCount: 0,
        semanticReplayCandidateCount: 2,
      },
    });
    expect(replayedSeries.coverageSummary).toEqual(originalSeries.coverageSummary);
    expect(replayedSeries.dailyAggregate).toEqual(originalSeries.dailyAggregate);
    expect(replayedSeries.evidenceSetHash).not.toBe(originalSeries.evidenceSetHash);
    expect(replayed.receipt.receiptId).not.toBe(original.receipt.receiptId);
    expect(replayed.frozenReport.snapshotId).not.toBe(original.frozenReport.snapshotId);
    expect(replayed.evaluationHash).not.toBe(original.evaluationHash);
  });

  it('quarantines conflicting identities and produces no numeric aggregate winner', () => {
    const left = csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit');
    const right = new TextEncoder().encode(
      `${CSV_HEADER}\na,2026-01-01T00:05:00.000Z,4,source-unit\n`,
    );
    const result = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [left, right] })]),
    );
    const series = firstSeries(result);

    expect(series.reconciliation).toMatchObject({
      kind: 'reconciled',
      result: {
        acceptedIdentityCount: 0,
        quarantinedIdentityCount: 1,
        conflictingIdentityCount: 1,
        numericObservations: [],
      },
    });
    expect(series.reconciliation.result?.outcomes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'conflicting_duplicate',
    });
    expect(series.coverageSummary).toMatchObject({
      acceptedCount: 0,
      quarantineCount: 1,
      gapCount: 2,
    });
    expect(series.dailyAggregate.aggregate).toMatchObject({
      values: [],
    });
    expect(result.coverageReadiness.state).toBe('blocked');
    expect(result.receipt.core.evidenceManifest.counts.quarantine).toBe(1);
  });

  it('aggregates only the exact accepted coverage winner from a crowded interval', () => {
    const source = csvBytes(
      'a,2026-01-01T00:05:00.000Z,2,source-unit',
      'b,2026-01-01T00:10:00.000Z,1000,source-unit',
    );
    const result = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]),
    );
    const series = firstSeries(result);
    const acceptedIds = acceptedObservationIds(result);

    expect(series.reconciliation.result?.numericObservations).toHaveLength(2);
    expect(series.coverageSummary).toMatchObject({
      acceptedCount: 1,
      duplicateCount: 1,
      gapCount: 1,
    });
    expect(acceptedIds).toHaveLength(1);
    expect(
      series.dailyAggregate.aggregate.values.flatMap(({ observationIds }) => observationIds),
    ).toEqual(acceptedIds);
    expect(series.dailyAggregate.aggregate.values[0]?.value).toBe('1.00');
  });

  it('excludes scheduled-nonoperation and lifecycle-ineligible numeric preimages', () => {
    const parts = testSeriesParts();
    const scheduled = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([parts], {
        scheduledNonoperations: [
          {
            nonoperationId: 'scheduled-stop-1',
            contractId: 'contract-1',
            range: {
              start: REPORT_RANGE.start,
              end: '2026-01-01T00:30:00.000Z',
            },
            authorizedAt: '2025-12-01T00:00:00.000Z',
            evidenceId: 'scheduled-stop-evidence-1',
          },
        ],
      }),
    );
    const timelineBase = withoutLifecycle(reconciledEvidenceInput([parts]));
    const lifecycle = evaluateReconciledCsvEvidence({
      ...timelineBase,
      lifecycleTimeline: lifecycleTimeline(),
    } as unknown as ReconciledCsvEvidenceInput);

    for (const result of [scheduled, lifecycle]) {
      const series = firstSeries(result);
      const acceptedIds = acceptedObservationIds(result);
      expect(series.reconciliation.result?.numericObservations).toHaveLength(2);
      expect(acceptedIds).toHaveLength(1);
      expect(
        series.dailyAggregate.aggregate.values.flatMap(({ observationIds }) => observationIds),
      ).toEqual(acceptedIds);
      expect(series.dailyAggregate.aggregate.values).toHaveLength(1);
    }
  });

  it('keeps a required source-less series as explicit gaps with an empty aggregate', () => {
    const result = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [] })]),
    );
    const series = firstSeries(result);

    expect(series.reconciliation).toMatchObject({
      kind: 'no_source_objects',
      result: null,
    });
    expect(series.reconciliation.operationalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(series.coverageSummary).toMatchObject({
      expectedCount: 2,
      acceptedCount: 0,
      gapCount: 2,
    });
    expect(series.dailyAggregate.aggregate.values).toEqual([]);
    expect(result.coverageReadiness.state).toBe('blocked');
    expect(
      result.receipt.core.evidenceManifest.sourceHashes.filter(({ logicalName }) =>
        logicalName.startsWith('csv-source-object:'),
      ),
    ).toEqual([]);
    expect(
      result.receipt.core.evidenceManifest.sourceHashes.filter(({ logicalName }) =>
        logicalName.startsWith('governance:'),
      ),
    ).toHaveLength(5);
  });

  it('copies intrinsic source bytes without invoking a caller-defined iterator', () => {
    const source = defaultCsvBytes();
    let iteratorReads = 0;
    Object.defineProperty(source, Symbol.iterator, {
      value() {
        iteratorReads += 1;
        throw new Error('exact-byte evaluation must not invoke caller iteration');
      },
    });
    const result = evaluateReconciledCsvEvidence(
      reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]),
    );

    expect(firstSeries(result).coverageSummary.acceptedCount).toBe(2);
    expect(iteratorReads).toBe(0);
  });

  it('rejects shared source backing storage', () => {
    const expected = defaultCsvBytes();
    const source = new Uint8Array(new SharedArrayBuffer(expected.byteLength));
    source.set(expected);

    expect(() =>
      evaluateReconciledCsvEvidence(
        reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]),
      ),
    ).toThrow('must not use SharedArrayBuffer');
  });

  it('rejects resizable source backing storage', () => {
    const expected = defaultCsvBytes();
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { readonly maxByteLength: number },
    ) => ArrayBuffer;
    const source = new Uint8Array(
      new ResizableArrayBuffer(expected.byteLength, {
        maxByteLength: MAX_RECONCILED_EVALUATION_SOURCE_BYTES + 1,
      }),
    );
    source.set(expected);

    expect(() =>
      evaluateReconciledCsvEvidence(
        reconciledEvidenceInput([testSeriesParts({ sourceObjects: [source] })]),
      ),
    ).toThrow('must not use resizable ArrayBuffer');
  });

  const baseParts = testSeriesParts();
  const secondParts = testSeriesParts({ contractId: 'contract-2' });
  const strictCases: readonly {
    readonly label: string;
    readonly input: () => unknown;
    readonly message: string;
  }[] = [
    {
      label: 'empty contract set',
      input: () => reconciledEvidenceInput([], { contracts: [], series: [] }),
      message: '1 through',
    },
    {
      label: 'duplicate contracts',
      input: () =>
        reconciledEvidenceInput([baseParts], {
          contracts: [baseParts.contract, baseParts.contract],
          series: [baseParts.series, baseParts.series],
        }),
      message: 'contract ID/version pairs must be unique',
    },
    {
      label: 'one contract ID with two versions',
      input: () => reconciledEvidenceInput([baseParts, testSeriesParts({ contractVersion: '2' })]),
      message: 'contract IDs must be unique',
    },
    {
      label: 'blank series contract ID',
      input: () =>
        reconciledEvidenceInput([
          {
            contract: baseParts.contract,
            series: {
              ...baseParts.series,
              requiredSeriesContractId: '',
            },
          },
        ]),
      message: 'must be a non-empty string',
    },
    {
      label: 'series bundle limit',
      input: () =>
        reconciledEvidenceInput([baseParts], {
          series: Array.from({ length: 65 }, () => baseParts.series),
        }),
      message: 'series bundles',
    },
    {
      label: 'missing series bundle',
      input: () =>
        reconciledEvidenceInput([baseParts, secondParts], {
          series: [baseParts.series],
        }),
      message: 'exactly one series bundle',
    },
    {
      label: 'duplicate series bundle',
      input: () =>
        reconciledEvidenceInput([baseParts], {
          series: [baseParts.series, baseParts.series],
        }),
      message: 'exactly one series bundle',
    },
    {
      label: 'mixed contract scope',
      input: () => {
        const foreign = testSeriesParts({ contractId: 'contract-2', tenantId: 'tenant-2' });
        return reconciledEvidenceInput([baseParts, foreign]);
      },
      message: 'share tenant/system scope',
    },
    {
      label: 'source-less CSV scope differs from governing contract',
      input: () =>
        reconciledEvidenceInput([
          testSeriesParts({
            sourceObjects: [],
            csvContractOverrides: { tenantId: 'tenant-2' },
          }),
        ]),
      message: 'identical tenant/system scope',
    },
    {
      label: 'source-less mapping omits observed time from source identity',
      input: () =>
        reconciledEvidenceInput([
          testSeriesParts({
            sourceObjects: [],
            csvContractOverrides: { identityFields: ['id'] },
          }),
        ]),
      message: 'observed-at field in source identityFields',
    },
    {
      label: 'no lifecycle choice',
      input: () => withoutLifecycle(reconciledEvidenceInput([baseParts])),
      message: 'exactly one lifecycle',
    },
    {
      label: 'two lifecycle choices',
      input: () => ({
        ...reconciledEvidenceInput([baseParts]),
        lifecycleTimeline: lifecycleTimeline(),
      }),
      message: 'exactly one lifecycle',
    },
    {
      label: 'unsupported lifecycle state',
      input: () => ({
        ...reconciledEvidenceInput([baseParts]),
        lifecycleState: 'unknown-state',
      }),
      message: 'lifecycle state must be supported',
    },
    {
      label: 'lifecycle timeline scope mismatch',
      input: () => ({
        ...withoutLifecycle(reconciledEvidenceInput([baseParts])),
        lifecycleTimeline: lifecycleTimeline('tenant-2'),
      }),
      message: 'timeline scope does not match',
    },
    {
      label: 'non-byte source',
      input: () =>
        reconciledEvidenceInput([
          {
            contract: baseParts.contract,
            series: {
              ...baseParts.series,
              sourceObjects: ['not-bytes'] as unknown as readonly Uint8Array[],
            },
          },
        ]),
      message: 'must be a Uint8Array',
    },
    {
      label: 'total source limit',
      input: () =>
        reconciledEvidenceInput([
          withSeries(
            baseParts,
            Array.from({ length: MAX_RECONCILED_EVALUATION_SOURCES + 1 }, () => defaultCsvBytes()),
          ),
        ]),
      message: 'source evaluation limit',
    },
    {
      label: 'total source byte limit',
      input: () =>
        reconciledEvidenceInput([
          withSeries(baseParts, [new Uint8Array(MAX_RECONCILED_EVALUATION_SOURCE_BYTES + 1)]),
        ]),
      message: 'byte evaluation limit',
    },
    {
      label: 'shadowed source byte length cannot bypass the total byte limit',
      input: () => {
        const source = new Uint8Array(MAX_RECONCILED_EVALUATION_SOURCE_BYTES + 1);
        Object.defineProperty(source, 'byteLength', { value: 1 });
        return reconciledEvidenceInput([withSeries(baseParts, [source])]);
      },
      message: 'byte evaluation limit',
    },
    {
      label: 'unknown scheduled-nonoperation contract',
      input: () =>
        reconciledEvidenceInput([baseParts], {
          scheduledNonoperations: [
            {
              nonoperationId: 'unknown-stop',
              contractId: 'unknown-contract',
              range: REPORT_RANGE,
              authorizedAt: '2025-12-01T00:00:00.000Z',
              evidenceId: 'unknown-stop-evidence',
            },
          ],
        }),
      message: 'unknown required contract',
    },
    {
      label: 'duplicate scheduled-nonoperation IDs',
      input: () => {
        const stop = {
          nonoperationId: 'duplicate-stop',
          contractId: 'contract-1',
          range: {
            start: REPORT_RANGE.start,
            end: '2026-01-01T00:30:00.000Z',
          },
          authorizedAt: '2025-12-01T00:00:00.000Z',
          evidenceId: 'duplicate-stop-evidence',
        };
        return reconciledEvidenceInput([baseParts], {
          scheduledNonoperations: [stop, stop],
        });
      },
      message: 'scheduled nonoperation IDs must be unique',
    },
    {
      label: 'extra caller-derived provenance',
      input: () => ({
        ...reconciledEvidenceInput([baseParts]),
        sourceHashes: [{ logicalName: 'injected', sha256: 'a'.repeat(64) }],
      }),
      message: 'unsupported keys',
    },
  ];

  it.each(strictCases)('rejects $label', ({ input, message }) => {
    expect(() => evaluateReconciledCsvEvidence(input() as ReconciledCsvEvidenceInput)).toThrow(
      message,
    );
  });

  it('rejects an accessor at the outer boundary without invoking it', () => {
    let getterReads = 0;
    const input = { ...reconciledEvidenceInput([baseParts]) };
    Object.defineProperty(input, 'contracts', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('strict evaluation must not invoke accessors');
      },
    });

    expect(() => evaluateReconciledCsvEvidence(input)).toThrow('enumerable data property');
    expect(getterReads).toBe(0);
  });
});
