/** Canonical projection and non-circular unsigned-receipt tests. */

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  createObservation,
  createRequiredSeriesContract,
  createTimeRange,
  createUnsignedReceipt,
  evaluateCoverage,
  evaluateCoverageReadiness,
  sha256,
  type CoverageEvaluationInput,
  type CoverageReadinessReport,
  type CoverageSummary,
  type RequiredSeriesContract,
} from '../src/index.js';
import { contractInput, observationInput } from './helpers.js';

const reportPeriod = createTimeRange({
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T01:00:00.000Z',
});

interface CoverageBundle {
  readonly contract: RequiredSeriesContract;
  readonly evaluation: CoverageEvaluationInput;
  readonly summary: CoverageSummary;
}

function coverageBundle(contractOverrides: Readonly<Record<string, unknown>> = {}): CoverageBundle {
  const contract = createRequiredSeriesContract(contractInput(contractOverrides));
  const evaluation: CoverageEvaluationInput = {
    contract,
    reportRange: reportPeriod,
    lifecycleState: 'in_service',
    observations: [
      createObservation(
        observationInput(`one-${contract.contractId}`, '2026-01-01T00:00:00.000Z', {
          contractId: contract.contractId,
        }),
      ),
    ],
    scheduledNonoperations: [],
  };
  return { contract, evaluation, summary: evaluateCoverage(evaluation) };
}

function summary(overrides: Partial<CoverageSummary> = {}): CoverageSummary {
  return { ...coverageBundle().summary, ...overrides };
}

function receiptInput(overrides: Readonly<Record<string, unknown>> = {}) {
  const bundle = coverageBundle();
  return {
    tenantId: 'tenant-1',
    systemId: 'system-1',
    reportPeriod,
    contracts: [bundle.contract],
    coverageEvaluationInputs: [bundle.evaluation],
    coverageSummaries: [bundle.summary],
    sourceHashes: [
      { logicalName: 'z.csv', sha256: 'b'.repeat(64) },
      { logicalName: 'a.csv', sha256: 'a'.repeat(64) },
    ],
    pinnedVersions: [
      { name: 'profile', value: 'profile-v1' },
      { name: 'algorithm', value: 'coverage-v1' },
    ],
    ...overrides,
  };
}

describe('canonical JSON', () => {
  it('sorts object keys while preserving array order and valid Unicode', () => {
    expect(
      canonicalJson({
        z: null,
        a: [true, false, 1, 1.5, 'é', '😀'],
        middle: { b: 2, a: 1 },
      }),
    ).toBe('{"a":[true,false,1,1.5,"é","😀"],"middle":{"a":1,"b":2},"z":null}');
    expect(sha256('evidence')).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [-0, 'negative zero'],
    [Number.POSITIVE_INFINITY, 'non-finite'],
    [{ missing: undefined }, 'undefined'],
    [new Date(0), 'plain objects'],
    [1n, 'bigint'],
    [Symbol('not-json'), 'symbol'],
    [new Array(2), 'sparse arrays'],
    ['\ud800', 'unpaired Unicode'],
    ['\udc00', 'unpaired Unicode'],
  ])('rejects noncanonical input %#', (value, message) => {
    expect(() => canonicalJson(value)).toThrow(message);
  });
});

describe('unsigned receipt', () => {
  it('builds content before a core whose ID is derived and never self-hashed', () => {
    const receipt = createUnsignedReceipt(receiptInput());
    const parsedCore = JSON.parse(receipt.canonicalCore) as Record<string, unknown>;

    expect(receipt.unsigned).toBe(true);
    expect(receipt.submittable).toBe(false);
    expect(receipt.claim).toBe('evidence assembled');
    expect(receipt.receiptId).toBe(`rp1-${receipt.coreHash}`);
    expect(receipt.coreHash).toBe(sha256(receipt.canonicalCore));
    expect(receipt.reportContentHash).toBe(sha256(receipt.canonicalReportContent));
    expect(receipt.renderManifest.map(({ logicalFilename }) => logicalFilename)).toEqual([
      'coverage-report.json',
      'coverage-report.csv',
      'coverage-report.html',
    ]);
    expect(receipt.renderArtifacts).toHaveLength(3);
    expect(receipt.coverageSummaries).toHaveLength(1);
    expect(receipt.coverageSummaries[0]).toHaveProperty('outcomes');
    expect(receipt.reportContentProjection.requiredSeries[0]).not.toHaveProperty('outcomes');
    expect(receipt.reportContentProjection.requiredSeries[0]).not.toHaveProperty(
      'expectedIntervals',
    );
    expect(receipt.core.evidenceManifest).toMatchObject({
      schemaVersion: 'evidence-manifest/v1',
      governingContractSetHash:
        receipt.reportContentProjection.coverageReadiness.governingContractSetHash,
      evaluationInputSetHash:
        receipt.reportContentProjection.coverageReadiness.evaluationInputSetHash,
      coverageSummarySetHash:
        receipt.reportContentProjection.coverageReadiness.coverageSummarySetHash,
    });
    expect(parsedCore).not.toHaveProperty('receiptId');
    expect(parsedCore).not.toHaveProperty('receipt_id');
    expect(parsedCore).not.toHaveProperty('coreHash');
    expect(receipt.canonicalCore).not.toMatch(/attestation|createdAt|verificationUrl|signature/);
    expect(Object.isFrozen(receipt.core)).toBe(true);
  });

  it('reproduces despite input order changes and changes when stable evidence changes', () => {
    const input = receiptInput();
    const first = createUnsignedReceipt(input);
    const reordered = createUnsignedReceipt({
      ...input,
      sourceHashes: [...input.sourceHashes].reverse(),
      pinnedVersions: [...input.pinnedVersions].reverse(),
    });
    const changed = createUnsignedReceipt({
      ...input,
      sourceHashes: [{ logicalName: 'a.csv', sha256: 'c'.repeat(64) }],
    });

    expect(reordered.receiptId).toBe(first.receiptId);
    expect(reordered.canonicalCore).toBe(first.canonicalCore);
    expect(changed.receiptId).not.toBe(first.receiptId);
    expect(first.core.evidenceManifest.sourceHashes.map(({ logicalName }) => logicalName)).toEqual([
      'a.csv',
      'z.csv',
    ]);
    expect(first.core.evidenceManifest.pinnedVersions.map(({ name }) => name)).toEqual([
      'algorithm',
      'profile',
    ]);
  });

  it('sorts multiple required series independently of evaluation order', () => {
    const second = coverageBundle({
      contractId: 'contract-2',
      version: '2',
      parameterCode: 'synthetic.contract-2',
    });
    const first = coverageBundle();
    const receipt = createUnsignedReceipt({
      ...receiptInput(),
      contracts: [second.contract, first.contract],
      coverageEvaluationInputs: [second.evaluation, first.evaluation],
      coverageSummaries: [second.summary, first.summary],
    });
    expect(receipt.core.evidenceManifest.requiredSeriesVersions).toEqual([
      { contractId: 'contract-1', contractVersion: '1' },
      { contractId: 'contract-2', contractVersion: '2' },
    ]);
  });

  it('always binds the recomputed scoped data-coverage preflight into canonical report content', () => {
    const bundle = coverageBundle();
    const coverageSummary = bundle.summary;
    const coverageReadiness = evaluateCoverageReadiness({
      contracts: [bundle.contract],
      coverageEvaluationInputs: [bundle.evaluation],
      coverageSummaries: [coverageSummary],
    });
    const withoutReadiness = createUnsignedReceipt({
      ...receiptInput(),
      contracts: [bundle.contract],
      coverageEvaluationInputs: [bundle.evaluation],
      coverageSummaries: [coverageSummary],
    });
    const withReadiness = createUnsignedReceipt({
      ...receiptInput(),
      contracts: [bundle.contract],
      coverageEvaluationInputs: [bundle.evaluation],
      coverageSummaries: [coverageSummary],
      coverageReadiness,
    });

    expect(withReadiness.reportContentProjection.coverageReadiness).toEqual(coverageReadiness);
    expect(withReadiness.reportContentHash).toBe(withoutReadiness.reportContentHash);
    expect(withReadiness.receiptId).toBe(withoutReadiness.receiptId);
    expect(withReadiness.canonicalReportContent).toContain('data coverage preflight only');

    expect(() =>
      createUnsignedReceipt({
        ...receiptInput(),
        contracts: [bundle.contract],
        coverageEvaluationInputs: [bundle.evaluation],
        coverageSummaries: [coverageSummary],
        coverageReadiness: { ...coverageReadiness, tenantId: 'other' },
      }),
    ).toThrow('exact semantic result');
    expect(() =>
      createUnsignedReceipt({
        ...receiptInput(),
        contracts: [bundle.contract],
        coverageEvaluationInputs: [bundle.evaluation],
        coverageSummaries: [coverageSummary],
        coverageReadiness: {
          ...coverageReadiness,
          reportRange: {
            start: reportPeriod.start,
            end: '2026-01-01T00:30:00.000Z',
          },
        },
      }),
    ).toThrow('exact semantic result');
  });

  it.each([null, undefined])(
    'rejects an explicitly present nullish evaluation report-time basis (%s)',
    (reportTimeBasis) => {
      const input = receiptInput();
      const evaluation = input.coverageEvaluationInputs[0];
      if (evaluation === undefined) {
        throw new Error('test setup requires one coverage evaluation input');
      }
      expect(() =>
        createUnsignedReceipt({
          ...input,
          coverageEvaluationInputs: [{ ...evaluation, reportTimeBasis }],
        } as unknown as Parameters<typeof createUnsignedReceipt>[0]),
      ).toThrow('must be an object');
    },
  );

  it('rejects contradictory, missing, extra, or changed readiness series and aggregates', () => {
    const critical = coverageBundle({
      contractId: 'critical',
      parameterCode: 'synthetic.critical',
      criticality: 'report_critical',
      aggregateMembership: ['shared-total'],
    });
    const member = coverageBundle({
      contractId: 'member',
      parameterCode: 'synthetic.member',
      aggregateMembership: ['shared-total'],
    });
    const contracts = [critical.contract, member.contract];
    const coverageEvaluationInputs = [critical.evaluation, member.evaluation];
    const coverageSummaries = [critical.summary, member.summary];
    const valid = evaluateCoverageReadiness({
      contracts,
      coverageEvaluationInputs,
      coverageSummaries,
    });
    const firstSeries = valid.requiredSeries[0];
    const aggregate = valid.criticalAggregates[0];
    if (firstSeries === undefined || aggregate === undefined) {
      throw new Error('test setup did not produce readiness series and aggregate gates');
    }
    const alternative = coverageBundle({ cadenceMinutes: 60 });
    const contradictory = evaluateCoverageReadiness({
      contracts: [alternative.contract],
      coverageEvaluationInputs: [alternative.evaluation],
      coverageSummaries: [alternative.summary],
    });
    const invalidReports: readonly CoverageReadinessReport[] = [
      { ...valid, requiredSeries: valid.requiredSeries.slice(1) },
      {
        ...valid,
        requiredSeries: [...valid.requiredSeries, { ...firstSeries, contractId: 'extra' }],
      },
      {
        ...valid,
        requiredSeries: [
          { ...firstSeries, acceptedCount: firstSeries.acceptedCount + 1 },
          ...valid.requiredSeries.slice(1),
        ],
      },
      { ...valid, criticalAggregates: [] },
      {
        ...valid,
        criticalAggregates: [...valid.criticalAggregates, { ...aggregate, aggregateId: 'extra' }],
      },
      {
        ...valid,
        criticalAggregates: [
          {
            ...aggregate,
            acceptedSourceIntervalPairs: aggregate.acceptedSourceIntervalPairs + 1,
          },
        ],
      },
      contradictory,
    ];

    for (const coverageReadiness of invalidReports) {
      expect(() =>
        createUnsignedReceipt({
          ...receiptInput(),
          contracts,
          coverageEvaluationInputs,
          coverageSummaries,
          coverageReadiness,
        }),
      ).toThrow();
    }
  });

  it.each([
    [{ tenantId: '' }, 'tenant ID'],
    [
      {
        coverageSummaries: [summary({ tenantId: 'another-tenant' })],
      },
      'scope',
    ],
    [
      {
        coverageSummaries: [
          summary({
            reportRange: {
              start: '2026-01-01T00:00:00.000Z',
              end: '2026-01-01T00:30:00.000Z',
            },
          }),
        ],
      },
      'report range',
    ],
    [
      {
        sourceHashes: [{ logicalName: 'bad', sha256: 'not-a-hash' }],
      },
      'SHA-256',
    ],
    [
      {
        sourceHashes: [
          { logicalName: 'same', sha256: 'a'.repeat(64) },
          { logicalName: 'same', sha256: 'b'.repeat(64) },
        ],
      },
      'unique',
    ],
    [
      {
        pinnedVersions: [
          { name: 'same', value: '1' },
          { name: 'same', value: '2' },
        ],
      },
      'unique',
    ],
    [
      {
        pinnedVersions: [{ name: 'algorithm', value: '' }],
      },
      'non-empty',
    ],
    [{ tenantId: 'unsafe\nvalue' }, 'control characters'],
    [{ sourceHashes: [{ logicalName: 'unsafe\u0000name', sha256: 'a'.repeat(64) }] }, 'control'],
    [{ coverageReadiness: null }, 'must be an object'],
    [{ coverageReadiness: undefined }, 'must be an object'],
    [{ supersededCoreHashes: null }, 'must be an array'],
    [{ supersededCoreHashes: undefined }, 'must be an array'],
    [{ supersededCoreHashes: ['bad'] }, 'SHA-256'],
    [{ supersededCoreHashes: ['a'.repeat(64), 'a'.repeat(64)] }, 'duplicates'],
    [{ coverageSummaries: [] }, 'at least one'],
    [{ sourceHashes: [] }, 'at least one source hash'],
    [{ pinnedVersions: [] }, 'at least one pinned version'],
    [{ coverageSummaries: [summary(), summary()] }, 'unique'],
  ])('rejects invalid receipt input %#', (overrides, message) => {
    expect(() => createUnsignedReceipt(receiptInput(overrides))).toThrow(message);
  });
});
