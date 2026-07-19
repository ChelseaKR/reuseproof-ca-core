/** Adversarial runtime-schema and semantic receipt revalidation tests. */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  createObservation,
  createRenderManifest,
  createUnsignedReceipt,
  evaluateFixture,
  evaluateCoverage,
  hashCoverageSummarySet,
  parseEvaluationFixtureJson,
  renderReportArtifacts,
  sha256,
  validateUnsignedReceiptIntegrity,
  type CoverageSummary,
  type ReportContentProjection,
  type ReportRequiredSeries,
  type ReceiptInput,
  type CoverageEvaluationInput,
  type UnsignedReceipt,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableProjectionBase = DeepMutable<ReportContentProjection>;
type MutableProjection = Omit<MutableProjectionBase, 'requiredSeries'> & {
  requiredSeries: DeepMutable<CoverageSummary>[];
};

type StrictRecordAttack =
  'symbol' | 'non_enumerable' | 'accessor' | 'prototype' | 'missing' | 'extra';

const strictRecordAttacks: readonly [StrictRecordAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['non_enumerable', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'plain object'],
  ['missing', 'missing required keys'],
  ['extra', 'unsupported keys'],
];

type StrictArrayAttack =
  'symbol' | 'non_enumerable' | 'accessor' | 'prototype' | 'sparse' | 'extra' | 'descriptor';

const strictArrayAttacks: readonly [StrictArrayAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['non_enumerable', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'Array.prototype'],
  ['sparse', 'dense array'],
  ['extra', 'unsupported array keys'],
  ['descriptor', 'ordinary mutable or frozen'],
];

function applyStrictRecordAttack(
  target: Record<PropertyKey, unknown>,
  requiredKey: string,
  attack: StrictRecordAttack,
): void {
  switch (attack) {
    case 'symbol':
      target[Symbol('unexpected')] = true;
      break;
    case 'non_enumerable':
      Object.defineProperty(target, requiredKey, {
        value: target[requiredKey],
        enumerable: false,
        configurable: true,
        writable: true,
      });
      break;
    case 'accessor':
      Object.defineProperty(target, requiredKey, {
        get: () => {
          throw new Error('strict validation must not invoke accessors');
        },
        enumerable: true,
        configurable: true,
      });
      break;
    case 'prototype':
      Object.setPrototypeOf(target, { inherited: true });
      break;
    case 'missing':
      Reflect.deleteProperty(target, requiredKey);
      break;
    case 'extra':
      target.unexpected = true;
      break;
  }
}

function applyStrictArrayAttack(target: unknown[], attack: StrictArrayAttack): void {
  if (target[0] === undefined) {
    throw new Error('strict-array attack requires a non-empty fixture array');
  }
  switch (attack) {
    case 'symbol':
      (target as unknown as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
      break;
    case 'non_enumerable':
      Object.defineProperty(target, '0', {
        value: target[0],
        enumerable: false,
        configurable: true,
        writable: true,
      });
      break;
    case 'accessor':
      Object.defineProperty(target, '0', {
        get: () => {
          throw new Error('strict array validation must not invoke accessors');
        },
        enumerable: true,
        configurable: true,
      });
      break;
    case 'prototype':
      Object.setPrototypeOf(target, []);
      break;
    case 'sparse':
      target.length += 1;
      break;
    case 'extra':
      (target as unknown as Record<string, unknown>).unexpected = true;
      break;
    case 'descriptor':
      Object.defineProperty(target, '0', {
        value: target[0],
        enumerable: true,
        configurable: true,
        writable: false,
      });
      break;
  }
}

function mutableProjection(receipt: UnsignedReceipt): MutableProjection {
  return {
    ...structuredClone(receipt.reportContentProjection),
    requiredSeries: structuredClone(receipt.coverageSummaries),
  } as unknown as MutableProjection;
}

function reportRequiredSeries(summary: DeepMutable<CoverageSummary>): ReportRequiredSeries {
  return {
    contractId: summary.contractId,
    contractVersion: summary.contractVersion,
    governingContractHash: summary.governingContractHash,
    reportTimeBasis: summary.reportTimeBasis,
    expectedCount: summary.expectedCount,
    acceptedCount: summary.acceptedCount,
    gapCount: summary.gapCount,
    duplicateCount: summary.duplicateCount,
    quarantineCount: summary.quarantineCount,
    coverage: summary.coverage,
  };
}

function reportProjection(value: MutableProjection): DeepMutable<ReportContentProjection> {
  return {
    ...value,
    requiredSeries: value.requiredSeries.map(reportRequiredSeries),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function firstSummary(projection: MutableProjection) {
  const summary = projection.requiredSeries[0];
  if (summary === undefined) {
    throw new Error('test receipt has no required-series summary');
  }
  return summary;
}

function rejectProjection(
  receipt: UnsignedReceipt,
  mutate: (projection: MutableProjection) => void,
  message: string,
): void {
  const projection = mutableProjection(receipt);
  mutate(projection);
  expect(() => {
    validateUnsignedReceiptIntegrity({
      ...receipt,
      coverageSummaries: projection.requiredSeries,
      reportContentProjection: reportProjection(projection),
    } as unknown as UnsignedReceipt);
  }).toThrow(message);
}

function demoReceipt(): UnsignedReceipt {
  const text = readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
  return evaluateFixture(parseEvaluationFixtureJson(text)).receipt;
}

function constructorInput(receipt = createTestReceipt()): ReceiptInput {
  return {
    tenantId: receipt.core.tenantId,
    systemId: receipt.core.systemId,
    reportPeriod: receipt.core.reportPeriod,
    contracts: receipt.governingContracts,
    coverageEvaluationInputs: receipt.normalizedEvaluationInputs,
    coverageSummaries: receipt.coverageSummaries,
    coverageReadiness: receipt.reportContentProjection.coverageReadiness,
    sourceHashes: receipt.core.evidenceManifest.sourceHashes,
    pinnedVersions: receipt.core.evidenceManifest.pinnedVersions,
    supersededCoreHashes: receipt.core.supersededCoreHashes,
  };
}

function typedDuplicateReceipt(): UnsignedReceipt {
  const base = createTestReceipt();
  const baseEvaluation = base.normalizedEvaluationInputs[0];
  const winner = baseEvaluation?.observations[0];
  if (baseEvaluation?.lifecycleState === undefined || winner === undefined) {
    throw new Error('test receipt lacks a resolved-state evaluation and accepted winner');
  }
  const evaluation: CoverageEvaluationInput = {
    contract: baseEvaluation.contract,
    reportRange: baseEvaluation.reportRange,
    ...(baseEvaluation.reportTimeBasis === undefined
      ? {}
      : { reportTimeBasis: baseEvaluation.reportTimeBasis }),
    lifecycleState: baseEvaluation.lifecycleState,
    observations: [
      winner,
      createObservation({
        observationId: 'observation-replay',
        contractId: winner.contractId,
        observedAt: '2026-01-01T00:00:01.000Z',
        sourceFingerprint: winner.sourceFingerprint,
        qualityState: 'accepted',
      }),
      createObservation({
        observationId: 'observation-extra',
        contractId: winner.contractId,
        observedAt: '2026-01-01T00:00:02.000Z',
        sourceFingerprint: 'fingerprint-distinct-extra',
        qualityState: 'accepted',
      }),
      createObservation({
        observationId: 'observation-superseded',
        contractId: winner.contractId,
        observedAt: '2026-01-01T00:00:03.000Z',
        sourceFingerprint: 'fingerprint-distinct-superseded',
        qualityState: 'accepted',
        supersededBy: winner.observationId,
      }),
    ],
    scheduledNonoperations: baseEvaluation.scheduledNonoperations,
  };
  const summary = evaluateCoverage(evaluation);
  return createUnsignedReceipt({
    tenantId: base.core.tenantId,
    systemId: base.core.systemId,
    reportPeriod: base.core.reportPeriod,
    contracts: base.governingContracts,
    coverageEvaluationInputs: [evaluation],
    coverageSummaries: [summary],
    sourceHashes: base.core.evidenceManifest.sourceHashes,
    pinnedVersions: base.core.evidenceManifest.pinnedVersions,
  });
}

function rebuildReceiptWithProjection(
  receipt: UnsignedReceipt,
  value: MutableProjection,
): UnsignedReceipt {
  const mutated = structuredClone(value);
  const coverageSummaries = mutated.requiredSeries;
  const projection = reportProjection(mutated);
  projection.coverageReadiness.coverageSummarySetHash = hashCoverageSummarySet(coverageSummaries);
  const canonicalReportContent = canonicalJson(projection);
  const reportContentHash = sha256(canonicalReportContent);
  const renderArtifacts = renderReportArtifacts(
    projection as unknown as ReportContentProjection,
    reportContentHash,
  );
  const renderManifest = createRenderManifest(renderArtifacts);
  const core = structuredClone(receipt.core) as unknown as DeepMutable<UnsignedReceipt['core']>;
  core.reportContentHash = reportContentHash;
  core.renderManifest = structuredClone(renderManifest) as unknown as DeepMutable<
    UnsignedReceipt['core']['renderManifest']
  >;
  core.evidenceManifest.coverageSummarySetHash =
    projection.coverageReadiness.coverageSummarySetHash;
  core.evidenceManifest.counts = coverageSummaries.reduce(
    (totals, summary) => ({
      accepted: totals.accepted + summary.acceptedCount,
      duplicate: totals.duplicate + summary.duplicateCount,
      gap: totals.gap + summary.gapCount,
      quarantine: totals.quarantine + summary.quarantineCount,
    }),
    { accepted: 0, duplicate: 0, gap: 0, quarantine: 0 },
  );
  const canonicalCore = canonicalJson(core);
  const coreHash = sha256(canonicalCore);
  return {
    ...receipt,
    coverageSummaries,
    reportContentProjection: projection,
    canonicalReportContent,
    reportContentHash,
    renderArtifacts,
    renderManifest,
    core,
    canonicalCore,
    coreHash,
    receiptId: `rp1-${coreHash}`,
  } as unknown as UnsignedReceipt;
}

function rebuildReceiptWithReportSafeProjection(
  receipt: UnsignedReceipt,
  value: DeepMutable<ReportContentProjection>,
): UnsignedReceipt {
  const projection = structuredClone(value);
  const canonicalReportContent = canonicalJson(projection);
  const reportContentHash = sha256(canonicalReportContent);
  const renderArtifacts = renderReportArtifacts(
    projection as unknown as ReportContentProjection,
    reportContentHash,
  );
  const renderManifest = createRenderManifest(renderArtifacts);
  const core = structuredClone(receipt.core) as unknown as DeepMutable<UnsignedReceipt['core']>;
  core.reportContentHash = reportContentHash;
  core.renderManifest = structuredClone(renderManifest) as unknown as DeepMutable<
    UnsignedReceipt['core']['renderManifest']
  >;
  const canonicalCore = canonicalJson(core);
  const coreHash = sha256(canonicalCore);
  return {
    ...receipt,
    reportContentProjection: projection as unknown as ReportContentProjection,
    canonicalReportContent,
    reportContentHash,
    renderArtifacts,
    renderManifest,
    core,
    canonicalCore,
    coreHash,
    receiptId: `rp1-${coreHash}`,
  } as unknown as UnsignedReceipt;
}

describe('strict receipt runtime revalidation', () => {
  it('rejects unsafe runtime object shapes at every receipt wrapper and manifest boundary', () => {
    const receipt = createTestReceipt();
    const boundaries: readonly [
      string,
      (value: DeepMutable<UnsignedReceipt>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      ['outer receipt', (value) => record(value), 'coverageSummaries'],
      ['receipt core', (value) => record(value.core), 'evidenceManifest'],
      ['evidence manifest', (value) => record(value.core.evidenceManifest), 'counts'],
      ['evidence counts', (value) => record(value.core.evidenceManifest.counts), 'accepted'],
      [
        'required-series version',
        (value) => record(value.core.evidenceManifest.requiredSeriesVersions[0]),
        'contractId',
      ],
      [
        'source hash',
        (value) => record(value.core.evidenceManifest.sourceHashes[0]),
        'logicalName',
      ],
      ['pinned version', (value) => record(value.core.evidenceManifest.pinnedVersions[0]), 'name'],
      ['render artifact', (value) => record(value.renderArtifacts[0]), 'utf8Text'],
      ['outer render manifest item', (value) => record(value.renderManifest[0]), 'sha256'],
      ['core render manifest item', (value) => record(value.core.renderManifest[0]), 'sha256'],
    ];

    for (const [boundary, select, requiredKey] of boundaries) {
      for (const [attack, message] of strictRecordAttacks) {
        const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
        applyStrictRecordAttack(select(attacked), requiredKey, attack);
        expect(() => {
          validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }
  });

  it('rejects decorated, sparse, accessor, and custom-prototype arrays across receipt schemas', () => {
    const receipt = demoReceipt();
    const boundaries: readonly [string, (value: DeepMutable<UnsignedReceipt>) => unknown[]][] = [
      ['internal coverage summaries', (value) => value.coverageSummaries],
      ['normalized evaluation inputs', (value) => value.normalizedEvaluationInputs],
      [
        'normalized observations',
        (value) => value.normalizedEvaluationInputs[0]?.observations ?? [],
      ],
      [
        'governing eligible states',
        (value) => value.governingContracts[0]?.eligibleLifecycleStates ?? [],
      ],
      [
        'governing aggregate membership',
        (value) => value.governingContracts[0]?.aggregateMembership ?? [],
      ],
      ['series metadata', (value) => value.reportContentProjection.seriesMetadata],
      [
        'metadata aggregate membership',
        (value) => value.reportContentProjection.seriesMetadata[0]?.aggregateMembership ?? [],
      ],
      ['report-safe required series', (value) => value.reportContentProjection.requiredSeries],
      [
        'readiness required gates',
        (value) => value.reportContentProjection.coverageReadiness.requiredSeries,
      ],
      [
        'readiness critical gates',
        (value) => value.reportContentProjection.coverageReadiness.criticalAggregates,
      ],
      [
        'critical source contracts',
        (value) =>
          value.reportContentProjection.coverageReadiness.criticalAggregates[0]
            ?.sourceContractIds ?? [],
      ],
      [
        'critical reasons',
        (value) =>
          value.reportContentProjection.coverageReadiness.criticalAggregates[0]?.reasons ?? [],
      ],
      ['render artifacts', (value) => value.renderArtifacts],
      ['render manifest', (value) => value.renderManifest],
      ['evidence source hashes', (value) => value.core.evidenceManifest.sourceHashes],
      ['projection limitations', (value) => value.reportContentProjection.limitations],
    ];

    for (const [boundary, select] of boundaries) {
      for (const [attack, message] of strictArrayAttacks) {
        const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
        applyStrictArrayAttack(select(attacked), attack);
        expect(() => {
          validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }
  });

  it('rejects noncanonical order in every parser-sorted receipt core array', () => {
    const receipt = demoReceipt();
    const manifestArrays: readonly [string, (value: DeepMutable<UnsignedReceipt>) => unknown[]][] =
      [
        ['source hashes', (value) => value.core.evidenceManifest.sourceHashes],
        ['pinned versions', (value) => value.core.evidenceManifest.pinnedVersions],
      ];
    for (const [boundary, select] of manifestArrays) {
      const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
      const values = select(attacked);
      expect(values.length, `${boundary} fixture must have multiple items`).toBeGreaterThan(1);
      values.reverse();
      expect(() => {
        validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
      }).toThrow('canonical');
    }

    const withSupersededHashes = createUnsignedReceipt({
      ...constructorInput(receipt),
      supersededCoreHashes: ['f'.repeat(64), '0'.repeat(64)],
    });
    expect(withSupersededHashes.core.supersededCoreHashes).toEqual([
      '0'.repeat(64),
      'f'.repeat(64),
    ]);
    const attacked = structuredClone(
      withSupersededHashes,
    ) as unknown as DeepMutable<UnsignedReceipt>;
    attacked.core.supersededCoreHashes.reverse();
    expect(() => {
      validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
    }).toThrow('canonical');
  });

  it('strictly reconstructs every nested readiness record before semantic comparison', () => {
    const receipt = demoReceipt();
    const boundaries: readonly [
      string,
      (value: DeepMutable<UnsignedReceipt>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      [
        'readiness report range',
        (value) => record(value.reportContentProjection.coverageReadiness.reportRange),
        'start',
      ],
      [
        'required-series readiness gate',
        (value) => record(value.reportContentProjection.coverageReadiness.requiredSeries[0]),
        'acceptedCount',
      ],
      [
        'critical-aggregate readiness gate',
        (value) => record(value.reportContentProjection.coverageReadiness.criticalAggregates[0]),
        'acceptedSourceIntervalPairs',
      ],
      [
        'critical-aggregate ratio',
        (value) =>
          record(value.reportContentProjection.coverageReadiness.criticalAggregates[0]?.coverage),
        'state',
      ],
    ];

    for (const [boundary, select, requiredKey] of boundaries) {
      for (const [attack, message] of strictRecordAttacks) {
        const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
        applyStrictRecordAttack(select(attacked), requiredKey, attack);
        expect(() => {
          validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }
  });

  it('strictly snapshots constructor inputs and rejects nested preimage array attacks', () => {
    const baseInput = constructorInput(demoReceipt());
    for (const [attack, message] of strictRecordAttacks) {
      const attacked = structuredClone(baseInput) as unknown as DeepMutable<ReceiptInput>;
      applyStrictRecordAttack(record(attacked), 'sourceHashes', attack);
      expect(() => {
        createUnsignedReceipt(attacked as unknown as ReceiptInput);
      }, `receipt input should reject ${attack}`).toThrow(message);
    }

    const selectors: readonly [string, (value: DeepMutable<ReceiptInput>) => unknown[]][] = [
      ['source hashes', (value) => value.sourceHashes],
      ['contract aggregate membership', (value) => value.contracts[0]?.aggregateMembership ?? []],
      [
        'evaluation contract eligible states',
        (value) => value.coverageEvaluationInputs[0]?.contract.eligibleLifecycleStates ?? [],
      ],
      [
        'lifecycle timeline periods',
        (value) => value.coverageEvaluationInputs[0]?.lifecycleTimeline?.periods ?? [],
      ],
    ];
    for (const [boundary, select] of selectors) {
      for (const [attack, message] of strictArrayAttacks) {
        const attacked = structuredClone(baseInput) as unknown as DeepMutable<ReceiptInput>;
        applyStrictArrayAttack(select(attacked), attack);
        expect(() => {
          createUnsignedReceipt(attacked as unknown as ReceiptInput);
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }

    const valid = createUnsignedReceipt(structuredClone(baseInput));
    expect(() => {
      validateUnsignedReceiptIntegrity(valid);
    }).not.toThrow();
  });

  it('rejects invalid render values after strict shell parsing', () => {
    const receipt = createTestReceipt();
    const cases: readonly [(value: DeepMutable<UnsignedReceipt>) => void, string][] = [
      [
        (value) => {
          record(value.renderManifest[0]).mediaType = 'unsupported';
        },
        'mediaType is not supported',
      ],
      [
        (value) => {
          record(value.renderManifest[0]).logicalFilename = '../unsafe';
        },
        'logicalFilename is not supported',
      ],
      [
        (value) => {
          record(value.renderArtifacts[0]).mediaType = 'unsupported';
        },
        'mediaType is not supported',
      ],
      [
        (value) => {
          record(value.renderArtifacts[0]).logicalFilename = '../unsafe';
        },
        'logicalFilename is not supported',
      ],
      [
        (value) => {
          record(value.renderArtifacts[0]).utf8Text = 42;
        },
        'utf8Text must be text',
      ],
    ];
    for (const [mutate, message] of cases) {
      const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
      mutate(attacked);
      expect(() => {
        validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
      }).toThrow(message);
    }
  });

  it('rejects empty, duplicate, and inconsistent internal summary sets', () => {
    const receipt = createTestReceipt();
    expect(() => {
      validateUnsignedReceiptIntegrity({ ...receipt, coverageSummaries: [] });
    }).toThrow('at least one internal coverage summary');

    const duplicate = structuredClone(receipt.coverageSummaries[0]);
    if (duplicate === undefined) throw new Error('test receipt lacks a coverage summary');
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        coverageSummaries: [...receipt.coverageSummaries, duplicate],
      });
    }).toThrow('internal coverage summaries must be unique');

    const sameContract = { ...structuredClone(duplicate), contractVersion: '2' };
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        coverageSummaries: [...receipt.coverageSummaries, sameContract],
      });
    }).toThrow('internal coverage contract IDs must be unique');

    const timelineReceipt = demoReceipt();
    if (timelineReceipt.coverageSummaries[1] === undefined) {
      throw new Error('demo receipt lacks two coverage summaries');
    }
    const mismatchedBasis = timelineReceipt.coverageSummaries.map((summary, index) =>
      index === 1 ? { ...summary, reportTimeBasis: { kind: 'utc' as const } } : summary,
    );
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...timelineReceipt,
        coverageSummaries: mismatchedBasis,
      });
    }).toThrow('must share one report time basis');
  });

  it('rejects malformed internal summary scalars before comparing the public projection', () => {
    const receipt = createTestReceipt();
    const cases: readonly [(summary: Record<string, unknown>) => void, string][] = [
      [
        (summary) => {
          summary.schemaVersion = 'coverage-summary/v0';
        },
        'schemaVersion must be coverage-summary/v2',
      ],
      [
        (summary) => {
          summary.expectedCount = -1;
        },
        'expectedCount must be a non-negative safe integer',
      ],
      [
        (summary) => {
          record(summary.coverage).state = 'unknown';
        },
        'coverage.state must be measured or not_applicable',
      ],
      [
        (summary) => {
          summary.acceptedCount = (summary.acceptedCount as number) + 1;
        },
        'inconsistent coverage accounting',
      ],
      [
        (summary) => {
          const coverage = record(summary.coverage);
          coverage.numerator = (coverage.numerator as number) + 1;
        },
        'inconsistent coverage accounting',
      ],
    ];

    for (const [mutate, message] of cases) {
      const attacked = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
      const summary = attacked.coverageSummaries[0];
      if (summary === undefined) throw new Error('test receipt lacks a coverage summary');
      mutate(record(summary));
      expect(() => {
        validateUnsignedReceiptIntegrity(attacked as unknown as UnsignedReceipt);
      }).toThrow(message);
    }
  });

  it('rejects malformed governing-contract sets and core digests at their strict boundaries', () => {
    const receipt = createTestReceipt();
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        governingContracts: [],
      });
    }).toThrow('exactly one item per required series');

    const demo = demoReceipt();
    const duplicateContracts = structuredClone(demo.governingContracts) as unknown as DeepMutable<
      UnsignedReceipt['governingContracts']
    >;
    const firstContract = duplicateContracts[0];
    if (firstContract === undefined || duplicateContracts[1] === undefined) {
      throw new Error('demo receipt lacks two governing contracts');
    }
    duplicateContracts[1] = structuredClone(firstContract);
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...demo,
        governingContracts: duplicateContracts,
      });
    }).toThrow('ID/version pairs must be unique');

    const missingContract = structuredClone(demo.governingContracts) as unknown as DeepMutable<
      UnsignedReceipt['governingContracts']
    >;
    const secondContract = missingContract[1];
    if (secondContract === undefined) throw new Error('demo receipt lacks a second contract');
    secondContract.contractId = 'unmatched-contract';
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...demo,
        governingContracts: missingContract,
      });
    }).toThrow('do not match required-series scope and hashes');

    const badDigest = structuredClone(receipt) as unknown as DeepMutable<UnsignedReceipt>;
    const manifestItem = badDigest.core.renderManifest[0];
    if (manifestItem === undefined) throw new Error('test receipt lacks a render manifest item');
    manifestItem.sha256 = 'not-a-digest';
    expect(() => {
      validateUnsignedReceiptIntegrity(badDigest as unknown as UnsignedReceipt);
    }).toThrow('must be lowercase SHA-256 hex');
  });

  it('accepts resolved-state, timeline, measured, aggregate, and not-applicable variants', () => {
    const receipts = [
      createTestReceipt(),
      demoReceipt(),
      createTestReceipt({
        contractOverrides: { cadenceMinutes: 60, criticality: 'report_critical' },
      }),
      createTestReceipt({
        contractOverrides: {
          eligibleLifecycleStates: ['commissioning'],
          criticality: 'report_critical',
        },
      }),
    ];

    for (const receipt of receipts) {
      expect(() => {
        validateUnsignedReceiptIntegrity(receipt);
      }).not.toThrow();
    }
  });

  it('rejects a fully rehashed report-safe aggregate that diverges from internal summaries', () => {
    const receipt = createTestReceipt();
    const projection = structuredClone(
      receipt.reportContentProjection,
    ) as unknown as DeepMutable<ReportContentProjection>;
    const series = projection.requiredSeries[0];
    if (series === undefined) throw new Error('test receipt lacks report-safe required series');
    series.duplicateCount += 1;

    expect(() => {
      validateUnsignedReceiptIntegrity(rebuildReceiptWithReportSafeProjection(receipt, projection));
    }).toThrow('report-safe required series do not match internal coverage summaries');

    const withEvidenceDetail = structuredClone(
      receipt.reportContentProjection,
    ) as unknown as DeepMutable<ReportContentProjection>;
    record(withEvidenceDetail.requiredSeries[0]).outcomes = [];
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        reportContentProjection: withEvidenceDetail as unknown as ReportContentProjection,
      });
    }).toThrow('unsupported keys');
  });

  it('rejects malformed interval, lifecycle, ratio, and outcome structures', () => {
    const receipt = createTestReceipt();
    const cases: readonly [string, (projection: MutableProjection) => void, string][] = [
      [
        'non-array intervals',
        (projection) => {
          record(firstSummary(projection)).expectedIntervals = 'not-an-array';
        },
        'must be an array',
      ],
      [
        'unsupported lifecycle state',
        (projection) => {
          record(firstSummary(projection).expectedIntervals[0]).lifecycleState = 'unknown';
        },
        'supported lifecycle state',
      ],
      [
        'range-derived interval identity',
        (projection) => {
          record(firstSummary(projection).expectedIntervals[0]).intervalId = 'wrong-range';
        },
        'must match its exact half-open range',
      ],
      [
        'duplicate interval identity',
        (projection) => {
          const summary = firstSummary(projection);
          const first = summary.expectedIntervals[0];
          if (first === undefined) throw new Error('missing interval');
          summary.expectedIntervals[1] = structuredClone(first);
        },
        'interval IDs must be unique',
      ],
      [
        'nondeterministic interval order',
        (projection) => {
          firstSummary(projection).expectedIntervals.reverse();
        },
        'deterministic range order',
      ],
      [
        'unsupported coverage ratio',
        (projection) => {
          record(firstSummary(projection).coverage).state = 'unknown';
        },
        'measured or not_applicable',
      ],
      [
        'unsupported lifecycle basis',
        (projection) => {
          record(firstSummary(projection)).lifecycleBasis = { kind: 'unknown' };
        },
        'resolved_state or effective_timeline',
      ],
      [
        'unsupported outcome kind',
        (projection) => {
          record(firstSummary(projection).outcomes[0]).kind = 'unknown';
        },
        'kind is not supported',
      ],
      [
        'incorrect gap reason',
        (projection) => {
          const gap = firstSummary(projection).outcomes.find(({ kind }) => kind === 'gap');
          record(gap).reason = 'unknown';
        },
        'no_final_accepted_observation',
      ],
      [
        'overlapping interval classifications',
        (projection) => {
          const summary = firstSummary(projection);
          const interval = summary.expectedIntervals[0];
          if (interval === undefined) throw new Error('missing interval');
          summary.excludedIntervals = [
            { ...interval, nonoperationId: 'stop-copy', evidenceId: 'evidence-copy' },
          ];
        },
        'classifications must be disjoint',
      ],
      [
        'overlapping interval ranges with distinct identities',
        (projection) => {
          const intervals = firstSummary(projection).expectedIntervals;
          const first = intervals[0];
          const second = intervals[1];
          if (first === undefined || second === undefined) {
            throw new Error('test receipt lacks two intervals');
          }
          second.start = first.start;
          second.intervalId = `${second.start}/${second.end}`;
        },
        'cannot overlap',
      ],
      [
        'resolved-state interval with timeline provenance',
        (projection) => {
          const interval = firstSummary(projection).expectedIntervals[0];
          if (interval === undefined) throw new Error('missing interval');
          interval.lifecycleEventId = 'unexpected-event';
        },
        'resolved lifecycle basis',
      ],
      [
        'nondeterministic outcome order',
        (projection) => {
          firstSummary(projection).outcomes.reverse();
        },
        'outcomes must use deterministic order',
      ],
      [
        'duplicate observation routing',
        (projection) => {
          const summary = firstSummary(projection);
          const accepted = summary.outcomes.find(({ kind }) => kind === 'accepted');
          const gapIndex = summary.outcomes.findIndex(({ kind }) => kind === 'gap');
          const gap = summary.outcomes[gapIndex];
          if (accepted?.kind !== 'accepted' || gap === undefined || !('intervalId' in gap)) {
            throw new Error('test receipt lacks accepted/gap outcomes');
          }
          summary.outcomes[gapIndex] = {
            kind: 'accepted',
            intervalId: gap.intervalId,
            observationId: accepted.observationId,
            sourceFingerprint: accepted.sourceFingerprint,
          };
        },
        'route each observation exactly once',
      ],
      [
        'unknown outcome interval',
        (projection) => {
          const gap = firstSummary(projection).outcomes.findLast(({ kind }) => kind === 'gap');
          record(gap).intervalId = 'zzzz-unknown-interval';
        },
        'unknown interval',
      ],
      [
        'missing terminal outcome',
        (projection) => {
          const summary = firstSummary(projection);
          const gapIndex = summary.outcomes.findIndex(({ kind }) => kind === 'gap');
          summary.outcomes.splice(gapIndex, 1);
        },
        'exactly one accepted or gap',
      ],
      [
        'contradictory ratio',
        (projection) => {
          const coverage = firstSummary(projection).coverage;
          if (coverage.state !== 'measured') {
            throw new Error('test receipt lacks a measured ratio');
          }
          coverage.numerator += 1;
        },
        'coverage accounting',
      ],
    ];

    for (const [, mutate, message] of cases) {
      rejectProjection(receipt, mutate, message);
    }
  });

  it('rejects malformed exclusion, duplicate, quarantine, and civil-time variants', () => {
    const demo = demoReceipt();
    rejectProjection(
      demo,
      (projection) => {
        const duplicate = projection.requiredSeries
          .flatMap(({ outcomes }) => outcomes)
          .find(({ kind }) => kind === 'duplicate');
        record(duplicate).reason = 'unknown';
      },
      'reason is not supported',
    );
    rejectProjection(
      demo,
      (projection) => {
        const quarantine = projection.requiredSeries
          .flatMap(({ outcomes }) => outcomes)
          .find(({ kind }) => kind === 'quarantine');
        record(quarantine).reason = 'unknown';
      },
      'reason is not supported',
    );
    rejectProjection(
      demo,
      (projection) => {
        const summary = projection.requiredSeries.find(
          ({ excludedIntervals }) => excludedIntervals.length > 0,
        );
        const excludedId = summary?.excludedIntervals[0]?.intervalId;
        const gap = summary?.outcomes.find(({ kind }) => kind === 'gap');
        if (excludedId === undefined || gap === undefined) {
          throw new Error('demo receipt lacks excluded/gap intervals');
        }
        record(gap).intervalId = excludedId;
      },
      'outside the denominator',
    );
    rejectProjection(
      demo,
      (projection) => {
        const summary = projection.requiredSeries[0];
        if (summary === undefined) {
          throw new Error('demo receipt lacks a summary');
        }
        summary.reportRange = {
          ...summary.reportRange,
          end: '2026-01-01T08:30:00.000Z',
        };
      },
      'does not match its report range',
    );

    const forgedProjection = mutableProjection(demo);
    const scheduledSummary = forgedProjection.requiredSeries.find(
      ({ excludedIntervals }) => excludedIntervals.length > 0,
    );
    const scheduledIds = new Set(
      scheduledSummary?.excludedIntervals.map(({ intervalId }) => intervalId) ?? [],
    );
    const scheduledOutcome = scheduledSummary?.outcomes.find(
      (outcome) => outcome.kind === 'excluded' && scheduledIds.has(outcome.intervalId),
    );
    if (scheduledOutcome?.kind !== 'excluded') {
      throw new Error('demo receipt lacks a scheduled-exclusion outcome');
    }
    scheduledOutcome.reason = 'lifecycle_state_ineligible';
    expect(() => {
      validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(demo, forgedProjection));
    }).toThrow('exclusion reason does not match its interval class');

    const inactive = createTestReceipt({
      contractOverrides: { eligibleLifecycleStates: ['commissioning'] },
    });
    rejectProjection(
      inactive,
      (projection) => {
        record(firstSummary(projection).lifecycleExcludedIntervals[0]).reason = 'unknown';
      },
      'lifecycle_state_ineligible',
    );
  });

  it('rejects a fully rehashed attempt to turn eligible gaps into lifecycle exclusions', () => {
    const receipt = createTestReceipt();
    const projection = mutableProjection(receipt);
    const summary = firstSummary(projection);
    const gapIds = new Set(
      summary.outcomes.flatMap((outcome) => (outcome.kind === 'gap' ? [outcome.intervalId] : [])),
    );
    const movedIntervals = summary.expectedIntervals.filter(({ intervalId }) =>
      gapIds.has(intervalId),
    );
    if (movedIntervals.length === 0) {
      throw new Error('test receipt lacks gap intervals');
    }
    summary.expectedIntervals = summary.expectedIntervals.filter(
      ({ intervalId }) => !gapIds.has(intervalId),
    );
    summary.lifecycleExcludedIntervals.push(
      ...movedIntervals.map((interval) => ({
        ...interval,
        reason: 'lifecycle_state_ineligible' as const,
      })),
    );
    summary.outcomes = summary.outcomes.filter(({ kind }) => kind !== 'gap');
    summary.expectedCount = summary.expectedIntervals.length;
    summary.gapCount = 0;
    summary.coverage = {
      state: 'measured',
      numerator: summary.acceptedCount,
      denominator: summary.expectedCount,
    };

    const gate = projection.coverageReadiness.requiredSeries.find(
      ({ contractId }) => contractId === summary.contractId,
    );
    if (gate === undefined) throw new Error('test receipt lacks a readiness gate');
    gate.state = 'ready';
    gate.acceptedCount = summary.acceptedCount;
    gate.expectedCount = summary.expectedCount;
    gate.reasons = [];
    projection.coverageReadiness.state = 'ready';

    expect(() => {
      validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, projection));
    }).toThrow('interval class contradicts its governing lifecycle eligibility');
  });

  it('binds every duplicate reason to the normalized observation evidence after full rehash', () => {
    const receipt = typedDuplicateReceipt();
    const relabels = [
      ['extra_accepted_observation', 'replayed_fingerprint'],
      ['replayed_fingerprint', 'superseded'],
      ['superseded', 'extra_accepted_observation'],
    ] as const;

    for (const [originalReason, forgedReason] of relabels) {
      const projection = mutableProjection(receipt);
      const duplicate = projection.requiredSeries
        .flatMap(({ outcomes }) => outcomes)
        .find((outcome) => outcome.kind === 'duplicate' && outcome.reason === originalReason);
      if (duplicate?.kind !== 'duplicate') {
        throw new Error(`test receipt lacks ${originalReason} evidence`);
      }
      duplicate.reason = forgedReason;

      expect(() => {
        validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, projection));
      }).toThrow('does not match its exact evaluation input');
    }
  });

  it('strictly normalizes retained evaluation preimages before semantic validation', () => {
    const receipt = createTestReceipt();
    const timelineEvaluation = demoReceipt().normalizedEvaluationInputs.find(
      ({ lifecycleTimeline }) => lifecycleTimeline !== undefined,
    );
    const contradictoryInputs = structuredClone(
      receipt.normalizedEvaluationInputs,
    ) as unknown as DeepMutable<UnsignedReceipt['normalizedEvaluationInputs']>;
    const contradictory = contradictoryInputs[0];
    if (contradictory === undefined || timelineEvaluation?.lifecycleTimeline === undefined) {
      throw new Error('test receipts lack required evaluation variants');
    }
    record(contradictory).lifecycleTimeline = timelineEvaluation.lifecycleTimeline;
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        normalizedEvaluationInputs: contradictoryInputs,
      });
    }).toThrow('requires exactly one lifecycle state or timeline');

    const duplicateInputs = structuredClone(
      receipt.normalizedEvaluationInputs,
    ) as unknown as DeepMutable<UnsignedReceipt['normalizedEvaluationInputs']>;
    const duplicate = structuredClone(duplicateInputs[0]);
    if (duplicate === undefined) throw new Error('test receipt lacks an evaluation preimage');
    duplicate.contract.version = '2';
    duplicateInputs.push(duplicate);
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...receipt,
        normalizedEvaluationInputs: duplicateInputs,
      });
    }).toThrow('evaluations must have unique contract IDs');
  });

  it('rejects contradictory state or evidence for one lifecycle event ID after full rehash', () => {
    const receipt = demoReceipt();
    for (const contradiction of ['state', 'evidence'] as const) {
      const projection = mutableProjection(receipt);
      const summary = projection.requiredSeries.find(
        ({ lifecycleBasis, expectedIntervals }) =>
          lifecycleBasis.kind === 'effective_timeline' && expectedIntervals.length > 1,
      );
      const first = summary?.expectedIntervals[0];
      const second = summary?.expectedIntervals[1];
      if (
        first?.lifecycleEventId === null ||
        first?.lifecycleEventId === undefined ||
        second?.lifecycleEventId !== first.lifecycleEventId
      ) {
        throw new Error('demo receipt lacks two intervals for one lifecycle event');
      }
      if (contradiction === 'state') {
        second.lifecycleState = 'commissioning';
      } else {
        second.lifecycleEvidenceId = 'contradictory-lifecycle-evidence';
      }

      expect(() => {
        validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, projection));
      }).toThrow('lifecycle event ID must map to one state and evidence reference');
    }

    const missingProvenance = mutableProjection(receipt);
    const timelineSummary = missingProvenance.requiredSeries.find(
      ({ lifecycleBasis, expectedIntervals }) =>
        lifecycleBasis.kind === 'effective_timeline' && expectedIntervals.length > 0,
    );
    const interval = timelineSummary?.expectedIntervals[0];
    if (interval === undefined) throw new Error('demo receipt lacks a timeline interval');
    interval.lifecycleEventId = null;
    expect(() => {
      validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, missingProvenance));
    }).toThrow('timeline interval requires lifecycle provenance');
  });

  it('rejects a lifecycle event ID that resumes after another event after full rehash', () => {
    const receipt = demoReceipt();
    const projection = mutableProjection(receipt);
    const summary = projection.requiredSeries.find(
      ({ lifecycleBasis, expectedIntervals, excludedIntervals }) =>
        lifecycleBasis.kind === 'effective_timeline' &&
        expectedIntervals.length > 1 &&
        excludedIntervals.length > 0,
    );
    const second = summary?.expectedIntervals[1];
    if (second === undefined) {
      throw new Error('demo receipt lacks the interval partition needed for this test');
    }
    second.lifecycleEventId = 'intervening-lifecycle-event';
    second.lifecycleEvidenceId = 'intervening-lifecycle-evidence';

    expect(() => {
      validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, projection));
    }).toThrow('lifecycle event intervals must be contiguous');
  });

  it('rejects malformed immutable series metadata and readiness bindings', () => {
    const receipt = createTestReceipt();
    const cases: readonly [(projection: MutableProjection) => void, string][] = [
      [
        (projection) => {
          record(projection.seriesMetadata[0]).criticality = 'unknown';
        },
        'criticality',
      ],
      [
        (projection) => {
          const metadata = projection.seriesMetadata[0];
          if (metadata === undefined) throw new Error('missing metadata');
          metadata.aggregateMembership = ['same', 'same'];
        },
        'must be unique',
      ],
      [
        (projection) => {
          record(projection.seriesMetadata[0]).sourceTimeZone = '+01:00';
        },
        'IANA time zone',
      ],
      [
        (projection) => {
          projection.seriesMetadata = [];
        },
        'seriesMetadata cannot be empty',
      ],
      [
        (projection) => {
          record(projection.seriesMetadata[0]).contractId = 'other-contract';
        },
        'do not match immutable metadata',
      ],
      [
        (projection) => {
          record(projection.coverageReadiness).requiredSeries = 'not-an-array';
        },
        'must be an array',
      ],
      [
        (projection) => {
          projection.coverageReadiness.governingContractSetHash = 'bad';
        },
        'SHA-256',
      ],
      [
        (projection) => {
          firstSummary(projection).tenantId = 'other-tenant';
        },
        'summary scope does not match report scope',
      ],
    ];

    for (const [mutate, message] of cases) {
      rejectProjection(receipt, mutate, message);
    }

    rejectProjection(
      receipt,
      (projection) => {
        const first = firstSummary(projection);
        projection.requiredSeries.push({ ...structuredClone(first), contractVersion: '2' });
      },
      'unique contract IDs',
    );
  });

  it('derives every exported series descriptor from its hashed governing contract preimage', () => {
    const receipt = createTestReceipt();
    const descriptorChanges = [
      ['parameterCode', 'forged-parameter'],
      ['statistic', 'forged-statistic'],
      ['canonicalUnit', 'mg/L'],
      ['sourceTimeZone', 'America/New_York'],
    ] as const;

    for (const [field, value] of descriptorChanges) {
      const projection = mutableProjection(receipt);
      const metadata = projection.seriesMetadata[0];
      if (metadata === undefined) throw new Error('test receipt has no series metadata');
      metadata[field] = value;
      expect(() => {
        validateUnsignedReceiptIntegrity(rebuildReceiptWithProjection(receipt, projection));
      }).toThrow('not derived from governing contracts');
    }

    const relabeledProjection = mutableProjection(receipt);
    const relabeledMetadata = relabeledProjection.seriesMetadata[0];
    const relabeledContracts = structuredClone(
      receipt.governingContracts,
    ) as unknown as DeepMutable<UnsignedReceipt['governingContracts']>;
    const relabeledContract = relabeledContracts[0];
    if (relabeledContract === undefined || relabeledMetadata === undefined) {
      throw new Error('test receipt has no governing contract binding');
    }
    relabeledContract.parameterCode = 'forged-parameter';
    relabeledMetadata.parameterCode = relabeledContract.parameterCode;
    expect(() => {
      validateUnsignedReceiptIntegrity({
        ...rebuildReceiptWithProjection(receipt, relabeledProjection),
        governingContracts: relabeledContracts,
      });
    }).toThrow('governing contract preimages');
  });
});
