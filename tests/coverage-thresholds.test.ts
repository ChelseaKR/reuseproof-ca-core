/**
 * Tests that the coverage floors in vitest.config.ts still describe this repository.
 *
 * `DEFINITION_OF_DONE.md` promises the merge gate includes "the 95% per-file safety-core floor".
 * That floor is expressed as threshold keys — `src/domain/**` plus named files — and Vitest
 * applies a keyed threshold only to the files the key matches. A key matching nothing is ignored
 * in silence: no warning, no error, exit 0. So renaming or moving a safety-core file drops it from
 * the 95% floor to the 80% global floor, `make verify` stays green, and the sentence in
 * DEFINITION_OF_DONE quietly stops being true.
 *
 * Verified by experiment before this file existed: changing the key `src/report-schema.ts` to
 * `src/report-schema-RENAMED.ts` left `vitest run --coverage` at exit 0 with no diagnostic, while
 * raising a *matching* key's floor above the real number failed as it should. The floor works; the
 * unmatched key is the hole. These tests close it.
 *
 * They also refuse two quieter ways the floor could be lowered without looking lowered: a keyed
 * threshold set *below* the global one (a key that reads as a special safety rule while actually
 * exempting those files), and a key shape this guard cannot interpret (which must fail rather
 * than be skipped — a guard that silently stops checking is the thing it exists to prevent).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

/** Threshold fields Vitest reserves for itself; every other key is a file glob. */
const RESERVED = new Set([
  'perFile',
  'autoUpdate',
  '100',
  'branches',
  'functions',
  'lines',
  'statements',
]);

const METRICS = ['branches', 'functions', 'lines', 'statements'] as const;
type Metric = (typeof METRICS)[number];

type ThresholdEntry = Partial<Record<Metric, number>>;

function thresholds(): Record<string, unknown> {
  const coverage = config.test?.coverage;
  if (coverage === undefined || !('thresholds' in coverage)) {
    throw new Error('vitest.config.ts declares no coverage thresholds');
  }
  const value = coverage.thresholds;
  if (typeof value !== 'object') {
    throw new Error('vitest.config.ts coverage.thresholds is not an object');
  }
  return value as Record<string, unknown>;
}

function globalFloor(): ThresholdEntry {
  const all = thresholds();
  const floor: ThresholdEntry = {};
  for (const metric of METRICS) {
    const value = all[metric];
    if (typeof value === 'number') {
      floor[metric] = value;
    }
  }
  return floor;
}

/** The keyed (per-glob) entries, in declaration order. */
function keyedEntries(): [string, ThresholdEntry][] {
  return Object.entries(thresholds())
    .filter(([key]) => !RESERVED.has(key))
    .map(([key, value]) => {
      if (typeof value !== 'object' || value === null) {
        throw new Error(`coverage threshold ${JSON.stringify(key)} is not an object`);
      }
      return [key, value];
    });
}

/** Every TypeScript file coverage is configured to measure, as a repository-relative path. */
async function measuredFiles(directory = 'src'): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await measuredFiles(path)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Which of `files` a threshold key governs.
 *
 * Deliberately narrow: it understands an exact path and a `prefix/**` subtree, the only two shapes
 * this repository uses. Anything else throws, so adding a pattern shape this guard cannot reason
 * about fails the build instead of silently going unchecked.
 */
function governed(key: string, files: string[]): string[] {
  if (!key.includes('*')) {
    return files.filter((file) => file === key);
  }
  if (key.endsWith('/**') && !key.slice(0, -3).includes('*')) {
    const prefix = `${key.slice(0, -3)}/`;
    return files.filter((file) => file.startsWith(prefix));
  }
  throw new Error(
    `coverage threshold key ${JSON.stringify(key)} uses a pattern shape this guard cannot ` +
      `interpret. Teach tests/coverage-thresholds.test.ts the shape rather than leaving the key ` +
      `unverified — an unverified key is exactly the unmatched-key hole this file exists to close.`,
  );
}

describe('coverage threshold keys still match real files', () => {
  it('has keyed thresholds at all', async () => {
    expect(keyedEntries().length).toBeGreaterThan(0);
    expect(await measuredFiles()).not.toHaveLength(0);
  });

  it('governs at least one existing file with every keyed threshold', async () => {
    const files = await measuredFiles();
    for (const [key] of keyedEntries()) {
      expect(governed(key, files), `threshold key ${key} matches no file under src/`).not.toEqual(
        [],
      );
    }
  });

  it('matches each file with at most one keyed threshold', async () => {
    const files = await measuredFiles();
    const keys = keyedEntries().map(([key]) => key);
    for (const file of files) {
      const matching = keys.filter((key) => governed(key, [file]).length > 0);
      expect(matching.length, `${file} is governed by ${matching.join(' and ')}`).toBeLessThan(2);
    }
  });
});

describe('a keyed threshold may only raise the floor', () => {
  it('never sets a metric below the global threshold', () => {
    const floor = globalFloor();
    expect(Object.keys(floor).length).toBeGreaterThan(0);
    for (const [key, entry] of keyedEntries()) {
      for (const metric of METRICS) {
        const keyed = entry[metric];
        const global = floor[metric];
        if (keyed === undefined || global === undefined) {
          continue;
        }
        expect(
          keyed,
          `${key}.${metric} is below the global ${metric} floor`,
        ).toBeGreaterThanOrEqual(global);
      }
    }
  });

  it('states every metric on every keyed threshold, so none silently falls back', () => {
    for (const [key, entry] of keyedEntries()) {
      for (const metric of METRICS) {
        expect(typeof entry[metric], `${key} does not set ${metric}`).toBe('number');
      }
    }
  });
});

describe('the safety core keeps its stated 95% floor', () => {
  it('governs every src/domain file at 95% or better', async () => {
    const files = await measuredFiles('src/domain');
    expect(files).not.toHaveLength(0);
    const domain = keyedEntries().filter(([key]) => governed(key, files).length > 0);
    const covered = new Set(domain.flatMap(([key]) => governed(key, files)));
    expect([...covered].sort()).toEqual([...files].sort());
    for (const [key, entry] of domain) {
      for (const metric of METRICS) {
        expect(entry[metric], `${key}.${metric}`).toBeGreaterThanOrEqual(95);
      }
    }
  });

  it('measures coverage over src and over every command this package ships', async () => {
    // `src` is where the safety core lives, and it was the whole scope until a
    // command shipped. A published `bin` outside the coverage scope is a floor
    // that cannot fail, so the required set is derived from `package.json` here
    // rather than restated: a second command added without a coverage entry
    // fails this test instead of shipping unmeasured.
    const coverage = config.test?.coverage;
    const include = coverage !== undefined && 'include' in coverage ? coverage.include : undefined;
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { bin?: Record<string, string> };
    const shipped = Object.values(manifest.bin ?? {});
    const sources: string[] = [];
    for (const relative of shipped) {
      const shim = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
      const built = /from '\.\.\/dist\/(?<source>[^']+)\.js'/.exec(shim)?.groups?.source;
      if (built === undefined) {
        throw new Error(`${relative} does not import a built module, so its source is unknown`);
      }
      sources.push(`${built}.ts`);
    }

    expect(shipped).not.toHaveLength(0);
    expect(Array.isArray(include) ? [...include].sort() : include).toEqual(
      ['src/**/*.ts', ...sources].sort(),
    );
  });

  it('enforces thresholds per file, not as a repository-wide average', () => {
    expect(thresholds().perFile).toBe(true);
  });
});
