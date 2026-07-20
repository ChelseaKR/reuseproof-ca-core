/** Accessible deterministic render-byte tests. */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  createRenderManifest,
  evaluateFixture,
  parseEvaluationFixtureJson,
  renderReportArtifacts,
  requireSafeArtifactFilename,
  sha256,
  type RenderArtifact,
  type ReportContentProjection,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type RecordAttack = 'symbol' | 'hidden' | 'accessor' | 'prototype' | 'missing' | 'extra';

const recordAttacks: readonly [RecordAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['hidden', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'plain object'],
  ['missing', 'missing required keys'],
  ['extra', 'unsupported keys'],
];

function attackRecord(
  target: Record<PropertyKey, unknown>,
  requiredKey: string,
  attack: RecordAttack,
): void {
  switch (attack) {
    case 'symbol':
      target[Symbol('unexpected')] = true;
      break;
    case 'hidden':
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
          throw new Error('renderer must not invoke accessors');
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

type ArrayAttack = 'symbol' | 'hidden' | 'accessor' | 'prototype' | 'sparse' | 'extra';

const arrayAttacks: readonly [ArrayAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['hidden', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'Array.prototype'],
  ['sparse', 'dense array'],
  ['extra', 'unsupported array keys'],
];

function attackArray(target: unknown[], attack: ArrayAttack): void {
  if (target[0] === undefined) throw new Error('array attack requires a non-empty fixture');
  switch (attack) {
    case 'symbol':
      (target as unknown as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
      break;
    case 'hidden':
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
          throw new Error('renderer must not invoke array accessors');
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
  }
}

function demoProjection(): ReportContentProjection {
  const fixtureText = readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
  return evaluateFixture(parseEvaluationFixtureJson(fixtureText)).receipt.reportContentProjection;
}

function baseHash(projection: ReportContentProjection): string {
  return sha256(canonicalJson(projection));
}

describe('accessible report rendering', () => {
  it('renders deterministic JSON, CSV, and script-free semantic HTML with exact hashes', () => {
    const receipt = createTestReceipt();
    const rerendered = renderReportArtifacts(
      receipt.reportContentProjection,
      receipt.reportContentHash,
    );

    expect(rerendered).toEqual(receipt.renderArtifacts);
    expect(createRenderManifest(rerendered)).toEqual(receipt.renderManifest);
    for (const item of receipt.renderManifest) {
      const artifact = receipt.renderArtifacts.find(
        ({ logicalFilename }) => logicalFilename === item.logicalFilename,
      );
      expect(artifact).toBeDefined();
      expect(item.byteLength).toBe(Buffer.byteLength(artifact?.utf8Text ?? '', 'utf8'));
      expect(item.sha256).toBe(sha256(artifact?.utf8Text ?? ''));
    }

    const html = receipt.renderArtifacts.find(
      ({ mediaType }) => mediaType === 'text/html',
    )?.utf8Text;
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain('href="#report-content">Skip to report content</a>');
    expect(html).toContain('<main id="report-content">');
    expect(html).toContain('<caption>Coverage by immutable required-series contract</caption>');
    expect(html).toContain('<th scope="col">Contract</th>');
    expect(html).toContain('<th scope="row">contract-1</th>');
    expect(html).toContain('<th scope="col">Canonical unit</th>');
    expect(html).toContain('<td>gal/day</td>');
    expect(html).toContain('<td>America/Los_Angeles</td>');
    expect(html).toContain('<td>UTC</td>');
    expect(html).toContain(receipt.reportContentHash);
    expect(html).toContain('Draft—not submitted; human review required');
    expect(html).toContain('not a compliance, safety, water-quality');
    expect(html).not.toMatch(/<script|https?:\/\/|rp1-|rpe1-|verification/i);
  });

  it('escapes HTML and neutralizes every spreadsheet-formula prefix before CSV quoting', () => {
    const receipt = createTestReceipt({
      tenantId: '=SUM(1,1)<tenant&',
      systemId: '-unsafe"system',
      contractId: '@contract',
    });
    const html = receipt.renderArtifacts.find(
      ({ mediaType }) => mediaType === 'text/html',
    )?.utf8Text;
    const csv = receipt.renderArtifacts.find(({ mediaType }) => mediaType === 'text/csv')?.utf8Text;

    expect(html).toContain('=SUM(1,1)&lt;tenant&amp;');
    expect(html).toContain('-unsafe&quot;system');
    expect(csv).toContain('"\'=SUM(1,1)<tenant&"');
    expect(csv).toContain('"\'-unsafe""system"');
    expect(csv).toContain('"\'@contract"');
    expect(csv).toContain('"canonical_unit"');
    expect(csv).toContain('"source_time_zone"');
    expect(csv).toContain('"report_time_zone"');
    expect(csv).toContain('"gal/day"');
    expect(csv).toContain('"America/Los_Angeles"');
    expect(csv).toContain('"UTC"');
    expect(csv?.endsWith('\r\n')).toBe(true);
    expect(csv?.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('renders an explicit not-applicable ratio without inventing a percentage', () => {
    const receipt = createTestReceipt({
      contractOverrides: {
        effectiveRange: {
          start: '2027-01-01T00:00:00.000Z',
          end: '2027-01-01T01:00:00.000Z',
        },
      },
    });
    const html = receipt.renderArtifacts.find(
      ({ mediaType }) => mediaType === 'text/html',
    )?.utf8Text;
    const csv = receipt.renderArtifacts.find(({ mediaType }) => mediaType === 'text/csv')?.utf8Text;

    expect(html).toContain('Not applicable (zero expected intervals)');
    expect(csv).toContain('"not_applicable","",""');
  });

  it('wraps canonical JSON around content without creating a self-hash', () => {
    const receipt = createTestReceipt();
    const json = receipt.renderArtifacts.find(
      ({ mediaType }) => mediaType === 'application/json',
    )?.utf8Text;
    const parsed = JSON.parse(json ?? '') as Record<string, unknown>;

    expect(json).toBe(canonicalJson(parsed));
    expect(parsed.reportContentHash).toBe(receipt.reportContentHash);
    expect(parsed.reportContent).toMatchObject({
      seriesMetadata: [
        expect.objectContaining({
          canonicalUnit: 'gal/day',
          sourceTimeZone: 'America/Los_Angeles',
        }),
      ],
    });
    expect(parsed).not.toHaveProperty('receiptId');
    expect(parsed).not.toHaveProperty('envelopeId');
  });

  it('keeps evidence-routing markers out of JSON, HTML, CSV, and canonical report content', () => {
    const fixtureText = readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
    const receipt = evaluateFixture(parseEvaluationFixtureJson(fixtureText)).receipt;
    const markers = [
      'flow-002-replay',
      'source-a-row-1',
      'scheduled-stop-001',
      'evidence-stop-001',
      'lifecycle-event-demo-01',
      'synthetic-lifecycle-evidence-01',
    ];
    const internalText = canonicalJson({
      coverageSummaries: receipt.coverageSummaries,
      normalizedEvaluationInputs: receipt.normalizedEvaluationInputs,
    });
    for (const marker of markers) {
      expect(internalText).toContain(marker);
      expect(receipt.canonicalReportContent).not.toContain(marker);
      for (const artifact of receipt.renderArtifacts) {
        expect(artifact.utf8Text, `${artifact.logicalFilename} leaked ${marker}`).not.toContain(
          marker,
        );
      }
    }

    const safeSeries = receipt.reportContentProjection.requiredSeries[0];
    expect(Object.keys(safeSeries ?? {}).sort()).toEqual(
      [
        'acceptedCount',
        'contractId',
        'contractVersion',
        'coverage',
        'duplicateCount',
        'expectedCount',
        'gapCount',
        'governingContractHash',
        'quarantineCount',
        'reportTimeBasis',
      ].sort(),
    );
  });

  it('rejects direct-render projection extras and nested readiness record attacks', () => {
    const base = demoProjection();
    const leaked = {
      ...structuredClone(base),
      confidential: { observationId: 'SECRET-OBSERVATION' },
    } as unknown as ReportContentProjection;
    expect(() => renderReportArtifacts(leaked, sha256(canonicalJson(leaked)))).toThrow(
      'unsupported keys',
    );

    const hiddenExtra = structuredClone(base) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hiddenExtra, 'confidential', {
      value: { observationId: 'SECRET-OBSERVATION' },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(() =>
      renderReportArtifacts(hiddenExtra as unknown as ReportContentProjection, baseHash(base)),
    ).toThrow('enumerable data property');

    let getterReads = 0;
    const accessorExtra = structuredClone(base) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorExtra, 'confidential', {
      get: () => {
        getterReads += 1;
        return { observationId: 'SECRET-OBSERVATION' };
      },
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      renderReportArtifacts(accessorExtra as unknown as ReportContentProjection, '0'.repeat(64)),
    ).toThrow('enumerable data property');
    expect(getterReads).toBe(0);

    const boundaries: readonly [
      string,
      (value: DeepMutable<ReportContentProjection>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      ['projection', (value) => value, 'claim'],
      ['readiness report range', (value) => value.coverageReadiness.reportRange, 'start'],
      [
        'required readiness gate',
        (value) =>
          value.coverageReadiness.requiredSeries[0] as unknown as Record<PropertyKey, unknown>,
        'acceptedCount',
      ],
      [
        'critical readiness gate',
        (value) =>
          value.coverageReadiness.criticalAggregates[0] as unknown as Record<PropertyKey, unknown>,
        'acceptedSourceIntervalPairs',
      ],
      [
        'critical coverage ratio',
        (value) =>
          value.coverageReadiness.criticalAggregates[0]?.coverage as unknown as Record<
            PropertyKey,
            unknown
          >,
        'state',
      ],
    ];
    for (const [boundary, select, key] of boundaries) {
      for (const [attack, message] of recordAttacks) {
        const attacked = structuredClone(base) as unknown as DeepMutable<ReportContentProjection>;
        attackRecord(select(attacked), key, attack);
        expect(() => {
          renderReportArtifacts(attacked as unknown as ReportContentProjection, baseHash(base));
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }
  });

  it('rejects decorated direct-render arrays and contradictory aggregate gates', () => {
    const base = demoProjection();
    for (const [attack, message] of arrayAttacks) {
      const attacked = structuredClone(base) as unknown as DeepMutable<ReportContentProjection>;
      attackArray(attacked.requiredSeries, attack);
      expect(() => {
        renderReportArtifacts(attacked as unknown as ReportContentProjection, baseHash(base));
      }, `direct requiredSeries should reject ${attack}`).toThrow(message);
    }

    const cases: readonly [string, (value: DeepMutable<ReportContentProjection>) => void][] = [
      [
        'omitted aggregate',
        (value) => {
          value.coverageReadiness.criticalAggregates = [];
        },
      ],
      [
        'extra aggregate',
        (value) => {
          const aggregate = value.coverageReadiness.criticalAggregates[0];
          if (aggregate === undefined) throw new Error('demo projection lacks an aggregate');
          value.coverageReadiness.criticalAggregates.push({
            ...structuredClone(aggregate),
            aggregateId: 'zz-unexpected-aggregate',
          });
        },
      ],
      [
        'altered aggregate counts',
        (value) => {
          const aggregate = value.coverageReadiness.criticalAggregates[0];
          if (aggregate?.coverage.state !== 'measured') {
            throw new Error('demo projection lacks a measured aggregate');
          }
          aggregate.acceptedSourceIntervalPairs -= 1;
          aggregate.coverage.numerator -= 1;
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const attacked = structuredClone(base) as unknown as DeepMutable<ReportContentProjection>;
      mutate(attacked);
      expect(() => {
        renderReportArtifacts(
          attacked as unknown as ReportContentProjection,
          sha256(canonicalJson(attacked)),
        );
      }, label).toThrow('critical aggregate');
    }
  });

  it('strictly snapshots manifest artifacts once and rejects record/array decorations', () => {
    const artifacts = [...createTestReceipt().renderArtifacts];
    for (const [attack, message] of arrayAttacks) {
      const attacked = structuredClone(artifacts);
      attackArray(attacked, attack);
      expect(
        () => createRenderManifest(attacked),
        `manifest array should reject ${attack}`,
      ).toThrow(message);
    }
    for (const [attack, message] of recordAttacks) {
      const attacked = structuredClone(artifacts);
      attackRecord(attacked[0] as unknown as Record<PropertyKey, unknown>, 'utf8Text', attack);
      expect(() => createRenderManifest(attacked), `manifest item should reject ${attack}`).toThrow(
        message,
      );
    }

    let getterReads = 0;
    const accessorArtifact = {
      mediaType: 'application/json',
      logicalFilename: 'coverage-report.json',
    } as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorArtifact, 'utf8Text', {
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? 'A' : getterReads === 2 ? 'BB' : 'CCC';
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => createRenderManifest([accessorArtifact as unknown as RenderArtifact])).toThrow(
      'enumerable data property',
    );
    expect(getterReads).toBe(0);
  });

  it('rejects unsafe/duplicate artifact names and malformed content hashes', () => {
    const receipt = createTestReceipt();
    expect(requireSafeArtifactFilename('coverage-report.csv')).toBe('coverage-report.csv');
    expect(() => requireSafeArtifactFilename('../report.csv')).toThrow('allowlisted');
    expect(() => requireSafeArtifactFilename('folder\\report.csv')).toThrow('allowlisted');
    expect(() => renderReportArtifacts(receipt.reportContentProjection, 'not-a-hash')).toThrow(
      'SHA-256',
    );
    expect(() => renderReportArtifacts(receipt.reportContentProjection, '0'.repeat(64))).toThrow(
      'does not match',
    );
    const missingMetadata = { ...receipt.reportContentProjection, seriesMetadata: [] };
    expect(() =>
      renderReportArtifacts(missingMetadata, sha256(canonicalJson(missingMetadata))),
    ).toThrow('seriesMetadata cannot be empty');

    const first = receipt.renderArtifacts[0];
    if (first === undefined) {
      throw new Error('test receipt did not render artifacts');
    }
    const duplicate: readonly RenderArtifact[] = [first, { ...first }];
    expect(() => createRenderManifest(duplicate)).toThrow('unique');
    const unsafe = [{ ...first, logicalFilename: '../report.json' }] as unknown as RenderArtifact[];
    expect(() => createRenderManifest(unsafe)).toThrow('allowlisted');
    const nonTextName = [{ ...first, logicalFilename: 42 }] as unknown as RenderArtifact[];
    expect(() => createRenderManifest(nonTextName)).toThrow('logicalFilename must be text');
    const wrongMediaType = [{ ...first, mediaType: 'text/html' }] as RenderArtifact[];
    expect(() => createRenderManifest(wrongMediaType)).toThrow('media type');
    const nonText = [{ ...first, utf8Text: 123 }] as unknown as RenderArtifact[];
    expect(() => createRenderManifest(nonText)).toThrow('UTF-8 text');
  });
});
