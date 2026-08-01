/**
 * Tests for scripts/codeql-gate.mjs — especially that it does NOT fail open.
 *
 * The four "no SARIF" cases are the point of this file. A gate that returns success when it finds
 * no SARIF reports a clean scan for an analysis that never ran, and with no code-scanning
 * dashboard on this private repo nothing else would notice.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- plain .mjs helper, deliberately outside the typed `src` project
import { gate } from '../scripts/codeql-gate.mjs';

const runGate = gate as (paths: string[]) => Promise<number>;

interface SarifResult {
  ruleId: string;
  level?: string;
  message: { text: string };
}

interface SarifRule {
  id: string;
  properties: Record<string, string>;
}

function sarif(results: SarifResult[], rules: SarifRule[] = []): unknown {
  return { runs: [{ tool: { driver: { rules } }, results }] };
}

async function writeSarif(dir: string, name: string, doc: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(doc), 'utf8');
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeql-gate-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('no SARIF fails closed', () => {
  it('fails on an empty directory', async () => {
    expect(await runGate([dir])).toBe(1);
  });

  it('fails on a path that does not exist', async () => {
    expect(await runGate([join(dir, 'sarif-results')])).toBe(1);
  });

  it('fails on the default path when it is absent', async () => {
    expect(await runGate(['sarif-results'])).toBe(1);
  });

  it('fails on a directory holding only non-SARIF files', async () => {
    await writeFile(join(dir, 'results.json'), '{}', 'utf8');
    expect(await runGate([dir])).toBe(1);
  });
});

describe('gate verdicts', () => {
  it('passes when the SARIF holds no findings', async () => {
    await writeSarif(dir, 'results.sarif', sarif([]));
    expect(await runGate([dir])).toBe(0);
  });

  it('fails on an error-level result', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif([{ ruleId: 'x/y', level: 'error', message: { text: 'boom' } }]),
    );
    expect(await runGate([dir])).toBe(1);
  });

  it('fails on a result whose rule is error severity', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif(
        [{ ruleId: 'x/y', level: 'note', message: { text: 'boom' } }],
        [{ id: 'x/y', properties: { 'problem.severity': 'error' } }],
      ),
    );
    expect(await runGate([dir])).toBe(1);
  });

  it('passes on warning-only findings', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif(
        [{ ruleId: 'x/y', level: 'warning', message: { text: 'meh' } }],
        [{ id: 'x/y', properties: { 'problem.severity': 'warning' } }],
      ),
    );
    expect(await runGate([dir])).toBe(0);
  });

  it('discovers SARIF nested below the given directory', async () => {
    const nested = join(dir, 'runs', 'lang');
    await mkdir(nested, { recursive: true });
    await writeSarif(
      nested,
      'results.sarif',
      sarif([{ ruleId: 'x/y', level: 'error', message: { text: 'boom' } }]),
    );
    expect(await runGate([dir])).toBe(1);
  });
});
