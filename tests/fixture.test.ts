/** End-to-end synthetic fixture entrypoint tests. */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  evaluateFixture,
  parseEvaluationFixture,
  parseEvaluationFixtureJson,
} from '../src/index.js';
import { contractInput, observationInput } from './helpers.js';

async function demoFixture(): Promise<Record<string, unknown>> {
  const text = await readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

async function demoFixtureText(): Promise<string> {
  return readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
}

describe('fixture parser and end-to-end slice', () => {
  it('preserves the entire required set and creates deterministic coverage receipts', async () => {
    const fixture = parseEvaluationFixtureJson(await demoFixtureText());
    const first = evaluateFixture(fixture);
    const second = evaluateFixture(parseEvaluationFixtureJson(await demoFixtureText()));

    expect(first.requiredSet).toEqual([
      { contractId: 'rsc-flow-001', mappingId: 'mapping-demo-v1' },
      { contractId: 'rsc-volume-001', mappingId: null },
    ]);
    expect(first.coverageSummaries[0]).toMatchObject({
      expectedCount: 3,
      acceptedCount: 2,
      duplicateCount: 1,
      quarantineCount: 1,
      gapCount: 1,
      reportTimeBasis: {
        kind: 'civil',
        timeZone: 'America/Los_Angeles',
      },
      lifecycleBasis: {
        kind: 'effective_timeline',
        timelineVersion: 'synthetic-v1',
      },
    });
    expect(first.coverageReadiness).toMatchObject({
      claim: 'data coverage preflight only',
      state: 'blocked',
    });
    expect(first.receipt.reportContentProjection.coverageReadiness).toEqual(
      first.coverageReadiness,
    );
    expect(first.receipt.receiptId).toBe(second.receipt.receiptId);
    expect(first.receipt.canonicalCore).toBe(second.receipt.canonicalCore);
    expect(first.receipt.core.evidenceManifest.pinnedVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'required-series-contract:rsc-flow-001@1' }),
        expect.objectContaining({ name: 'vendor-mapping:rsc-flow-001' }),
        { name: 'vendor-mapping:rsc-volume-001', value: 'unmapped' },
        expect.objectContaining({ name: 'lifecycle-timeline:synthetic-v1' }),
        expect.objectContaining({ name: 'report-time-basis' }),
      ]),
    );
    expect(first.frozenReport.snapshotId).toBe(second.frozenReport.snapshotId);
    expect(first.frozenReport.core).toMatchObject({
      lifecycleState: 'frozen',
      unsigned: true,
      submittable: false,
      reportVersion: 1,
    });
  });

  it('supports the explicit UTC and resolved-state compatibility path', async () => {
    const raw = await demoFixture();
    const { civilReportRange: _civilReportRange, lifecycleTimeline: _timeline, ...rest } = raw;
    const fixture = parseEvaluationFixture({
      ...rest,
      reportRange: {
        start: '2026-01-01T08:00:00.000Z',
        end: '2026-01-01T09:00:00.000Z',
      },
      lifecycleState: 'in_service',
    });
    const result = evaluateFixture(fixture);

    expect(fixture.reportTimeBasis).toEqual({ kind: 'utc' });
    expect(result.coverageSummaries[0]?.lifecycleBasis).toEqual({
      kind: 'resolved_state',
      state: 'in_service',
    });
    expect(result.receipt.core.evidenceManifest.pinnedVersions).toContainEqual({
      name: 'lifecycle-basis',
      value: 'resolved-state:in_service',
    });
  });

  it.each([
    [null, 'must be an object'],
    [{ extra: true }, 'unsupported keys'],
  ])('rejects malformed fixture roots %#', (value, message) => {
    expect(() => parseEvaluationFixture(value)).toThrow(message);
  });

  it('rejects inherited, class, and symbol-bearing fixture roots while allowing null prototypes', async () => {
    const valid = await demoFixture();
    const inherited = Object.create(valid) as unknown;
    class FixtureRecord {
      public readonly recordKind = 'class-instance';
    }
    const classRecord = Object.assign(new FixtureRecord(), valid);
    const symbolRecord = { ...valid, [Symbol('unexpected')]: true };
    const accessorRecord = { ...valid };
    Object.defineProperty(accessorRecord, 'tenantId', {
      enumerable: true,
      get: () => 'jurisdiction-demo',
    });
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, valid);

    expect(() => parseEvaluationFixture(inherited)).toThrow('plain object');
    expect(() => parseEvaluationFixture(classRecord)).toThrow('plain object');
    expect(() => parseEvaluationFixture(symbolRecord)).toThrow('symbol keys');
    expect(() => parseEvaluationFixture(accessorRecord)).toThrow('enumerable data property');
    expect(parseEvaluationFixture(nullPrototype).tenantId).toBe('jurisdiction-demo');
  });

  it('rejects decorated fixture, contract, and lifecycle array containers without reading accessors', async () => {
    const symbolFixture = structuredClone(await demoFixture());
    const symbolContracts = symbolFixture.contracts as unknown[];
    (symbolContracts as unknown as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
    expect(() => parseEvaluationFixture(symbolFixture)).toThrow('symbol keys');

    const prototypeFixture = structuredClone(await demoFixture());
    Object.setPrototypeOf(prototypeFixture.sourceHashes, []);
    expect(() => parseEvaluationFixture(prototypeFixture)).toThrow('Array.prototype');

    let getterReads = 0;
    const accessorFixture = structuredClone(await demoFixture());
    const contracts = accessorFixture.contracts as unknown[];
    Object.defineProperty(contracts, '0', {
      get: () => {
        getterReads += 1;
        return {};
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => parseEvaluationFixture(accessorFixture)).toThrow('enumerable data property');
    expect(getterReads).toBe(0);

    const nestedContractFixture = structuredClone(await demoFixture());
    const firstContract = (nestedContractFixture.contracts as Record<string, unknown>[])[0];
    if (firstContract === undefined) throw new Error('demo fixture lacks a contract');
    const aggregateMembership = firstContract.aggregateMembership as unknown[];
    aggregateMembership.length += 1;
    expect(() => parseEvaluationFixture(nestedContractFixture)).toThrow('dense array');

    const timelineFixture = structuredClone(await demoFixture());
    const timeline = timelineFixture.lifecycleTimeline as Record<string, unknown>;
    const periods = timeline.periods as unknown[];
    (periods as unknown as Record<string, unknown>).unexpected = true;
    expect(() => parseEvaluationFixture(timelineFixture)).toThrow('unsupported array keys');

    const oversizedSparseFixture = structuredClone(await demoFixture());
    const oversizedSourceHashes = oversizedSparseFixture.sourceHashes as unknown[];
    oversizedSourceHashes.length = 4_000_000_000;
    expect(() => parseEvaluationFixture(oversizedSparseFixture)).toThrow('dense array');
  });

  it('snapshots strict record and array descriptor values without re-reading Proxy properties', async () => {
    let rootPropertyReads = 0;
    const rootTarget = structuredClone(await demoFixture());
    const proxiedRoot = new Proxy(rootTarget, {
      get: (target, key, receiver) => {
        rootPropertyReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(parseEvaluationFixture(proxiedRoot).tenantId).toBe('jurisdiction-demo');
    expect(rootPropertyReads).toBe(0);

    let arrayPropertyReads = 0;
    const arrayFixture = structuredClone(await demoFixture());
    const sourceHashes = arrayFixture.sourceHashes as unknown[];
    arrayFixture.sourceHashes = new Proxy(sourceHashes, {
      get: (target, key, receiver) => {
        arrayPropertyReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(parseEvaluationFixture(arrayFixture).sourceHashes).toHaveLength(sourceHashes.length);
    expect(arrayPropertyReads).toBe(0);
  });

  it('strictly reconstructs every exported evaluator collection before use', async () => {
    const parsed = parseEvaluationFixtureJson(await demoFixtureText());
    const arrayKeys = [
      'contracts',
      'mappings',
      'observations',
      'scheduledNonoperations',
      'sourceHashes',
      'pinnedVersions',
    ] as const;

    for (const key of arrayKeys) {
      const attacked = structuredClone(parsed) as unknown as Record<string, unknown>;
      const values = attacked[key] as unknown[];
      const first = values[0];
      if (first === undefined) throw new Error(`demo fixture ${key} must be non-empty`);
      let getterReads = 0;
      Object.defineProperty(values, '0', {
        enumerable: true,
        configurable: true,
        get: () => {
          getterReads += 1;
          return first;
        },
      });

      expect(() =>
        evaluateFixture(attacked as unknown as Parameters<typeof evaluateFixture>[0]),
      ).toThrow('enumerable data property');
      expect(getterReads).toBe(0);
    }
  });

  it('publishes from evaluator-owned snapshots without reading nested Proxy properties', async () => {
    const parsed = parseEvaluationFixtureJson(await demoFixtureText());
    const expected = evaluateFixture(parsed).receipt.receiptId;
    const proxied = structuredClone(parsed) as unknown as Record<string, unknown>;
    let propertyReads = 0;
    const unread = <T extends object>(value: T): T =>
      new Proxy(value, {
        get: () => {
          propertyReads += 1;
          throw new Error('evaluation must not read caller Proxy properties');
        },
      });
    for (const key of [
      'contracts',
      'mappings',
      'observations',
      'scheduledNonoperations',
      'sourceHashes',
      'pinnedVersions',
    ] as const) {
      proxied[key] = unread(proxied[key] as unknown[]);
    }
    proxied.reportRange = unread(proxied.reportRange as Record<string, unknown>);
    proxied.reportTimeBasis = unread(proxied.reportTimeBasis as Record<string, unknown>);
    proxied.lifecycleTimeline = unread(proxied.lifecycleTimeline as Record<string, unknown>);

    expect(
      evaluateFixture(proxied as unknown as Parameters<typeof evaluateFixture>[0]).receipt
        .receiptId,
    ).toBe(expected);
    expect(propertyReads).toBe(0);
  });

  it('rejects malformed lifecycle, arrays, hashes, versions, and duplicate contracts', async () => {
    const raw = await demoFixture();
    const { lifecycleTimeline: _timeline, ...withoutTimeline } = raw;
    expect(() => parseEvaluationFixture({ ...withoutTimeline, lifecycleState: 'unknown' })).toThrow(
      'lifecycleState',
    );
    expect(() => parseEvaluationFixture({ ...raw, mappings: 'not-an-array' })).toThrow(
      'must be an array',
    );
    expect(() => parseEvaluationFixture({ ...raw, contracts: [] })).toThrow('unique required');
    expect(() =>
      parseEvaluationFixture({
        ...raw,
        contracts: [contractInput(), contractInput()],
      }),
    ).toThrow('unique required');
    expect(() =>
      parseEvaluationFixture({
        ...raw,
        sourceHashes: [{ logicalName: 'source', sha256: 'a'.repeat(64), extra: true }],
      }),
    ).toThrow('unsupported keys');
    expect(() =>
      parseEvaluationFixture({
        ...raw,
        pinnedVersions: [{ name: '', value: '1' }],
      }),
    ).toThrow('non-empty string');
    expect(() =>
      parseEvaluationFixture({
        ...raw,
        pinnedVersions: [{ name: 'one', value: '1', extra: true }],
      }),
    ).toThrow('unsupported keys');
  });

  it('requires exactly one report-time input and exactly one lifecycle input', async () => {
    const raw = await demoFixture();
    expect(() =>
      parseEvaluationFixture({
        ...raw,
        reportRange: {
          start: '2026-01-01T08:00:00.000Z',
          end: '2026-01-01T09:00:00.000Z',
        },
      }),
    ).toThrow('exactly one of reportRange');

    const { civilReportRange: _civil, lifecycleTimeline: timeline, ...withoutCivil } = raw;
    expect(() => parseEvaluationFixture({ ...withoutCivil, lifecycleTimeline: timeline })).toThrow(
      'exactly one of reportRange',
    );
    expect(() => parseEvaluationFixture({ ...raw, lifecycleState: 'in_service' })).toThrow(
      'exactly one of lifecycleState',
    );
    const { lifecycleTimeline: _removed, ...withoutLifecycle } = raw;
    expect(() => parseEvaluationFixture(withoutLifecycle)).toThrow('exactly one of lifecycleState');

    const { civilReportRange: _civilRange, ...utcFixture } = raw;
    const utcReportRange = {
      start: '2026-01-01T08:00:00.000Z',
      end: '2026-01-01T09:00:00.000Z',
    };
    const { lifecycleTimeline: _timelineValue, ...resolvedStateFixture } = raw;
    for (const nullish of [undefined, null]) {
      expect(() => parseEvaluationFixture({ ...raw, reportRange: nullish })).toThrow(
        'exactly one of reportRange',
      );
      expect(() =>
        parseEvaluationFixture({
          ...utcFixture,
          reportRange: utcReportRange,
          civilReportRange: nullish,
        }),
      ).toThrow('exactly one of reportRange');
      expect(() => parseEvaluationFixture({ ...utcFixture, reportRange: nullish })).toThrow(
        'must be an object',
      );
      expect(() => parseEvaluationFixture({ ...raw, lifecycleState: nullish })).toThrow(
        'exactly one of lifecycleState',
      );
      expect(() =>
        parseEvaluationFixture({
          ...resolvedStateFixture,
          lifecycleState: 'in_service',
          lifecycleTimeline: nullish,
        }),
      ).toThrow('exactly one of lifecycleState');
      expect(() =>
        parseEvaluationFixture({ ...resolvedStateFixture, lifecycleState: nullish }),
      ).toThrow('lifecycleState must be supported');
    }
  });

  it('requires the exact lifecycle union again at the exported evaluator boundary', async () => {
    const parsed = parseEvaluationFixture(await demoFixture());
    const withoutLifecycle = structuredClone(parsed) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(withoutLifecycle, 'lifecycleTimeline');
    expect(() =>
      evaluateFixture(withoutLifecycle as unknown as Parameters<typeof evaluateFixture>[0]),
    ).toThrow('exactly one of lifecycleState');

    for (const nullish of [undefined, null]) {
      const both = structuredClone(parsed) as unknown as Record<string, unknown>;
      both.lifecycleState = nullish;
      expect(() =>
        evaluateFixture(both as unknown as Parameters<typeof evaluateFixture>[0]),
      ).toThrow('exactly one of lifecycleState');

      const onlyState = structuredClone(withoutLifecycle);
      onlyState.lifecycleState = nullish;
      expect(() =>
        evaluateFixture(onlyState as unknown as Parameters<typeof evaluateFixture>[0]),
      ).toThrow('lifecycleState must be supported');

      const onlyTimeline = structuredClone(parsed) as unknown as Record<string, unknown>;
      onlyTimeline.lifecycleTimeline = nullish;
      expect(() =>
        evaluateFixture(onlyTimeline as unknown as Parameters<typeof evaluateFixture>[0]),
      ).toThrow('must be an object');
    }

    const valid = evaluateFixture(parsed);
    expect(valid.coverageSummaries[0]?.lifecycleBasis.kind).toBe('effective_timeline');
  });

  it('rejects evidence that invents a required contract instead of silently dropping it', async () => {
    const raw = await demoFixture();
    const fixture = parseEvaluationFixture({
      ...raw,
      observations: [
        observationInput('unknown', '2026-01-01T08:00:00.000Z', {
          contractId: 'not-required',
        }),
      ],
    });
    expect(() => evaluateFixture(fixture)).toThrow('unknown required contract');
  });

  it('rejects scheduled nonoperation evidence for an unknown required contract', async () => {
    const raw = await demoFixture();
    const fixture = parseEvaluationFixture({
      ...raw,
      scheduledNonoperations: [
        {
          nonoperationId: 'unknown-contract-stop',
          contractId: 'not-required',
          range: {
            start: '2026-01-01T08:00:00.000Z',
            end: '2026-01-01T08:15:00.000Z',
          },
          authorizedAt: '2025-12-31T00:00:00.000Z',
          evidenceId: 'evidence-unknown',
        },
      ],
    });

    expect(() => evaluateFixture(fixture)).toThrow('unknown required contract');
  });

  it('rejects fixture scope inconsistent with its immutable contracts', async () => {
    const raw = await demoFixture();
    const fixture = parseEvaluationFixture({ ...raw, tenantId: 'different-tenant' });
    expect(() => evaluateFixture(fixture)).toThrow('receipt scope');
  });
});
