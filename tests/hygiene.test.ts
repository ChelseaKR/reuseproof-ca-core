/**
 * Tests for scripts/check-hygiene.mjs — especially that it does NOT pass on an empty scan.
 *
 * The "scanned nothing" cases are the point of this file. The gate walks a fixed set of roots for
 * a fixed set of extensions; if either drifts away from where the repository actually keeps its
 * source, the walk returns no files. Reporting success there would tell `make verify` that marker
 * hygiene is enforced when nothing was read at all, and there is no second place that would
 * notice.
 *
 * Marker words are assembled from fragments throughout, exactly as the script does, so this file
 * does not trip the gate it is testing.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- plain .mjs gate script, deliberately outside the typed `src` project
import { DEFAULT_ROOTS, checkHygiene } from '../scripts/check-hygiene.mjs';

const check = checkHygiene as (roots?: string[]) => Promise<number>;
const defaultRoots = DEFAULT_ROOTS as string[];

// Never written as literals: this file is itself scanned by the gate.
const bareTodo = 'TO' + 'DO';
const bareFixme = 'FIX' + 'ME';
const bareHack = 'HA' + 'CK';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hygiene-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
}

describe('an empty scan fails closed', () => {
  it('fails on a root holding no source files at all', async () => {
    expect(await check([dir])).toBe(1);
  });

  it('fails on a root holding only files of unscanned types, marker or not', async () => {
    await write('notes.txt', `${bareTodo}: a marker the gate does not look at\n`);
    await write('workflow.yml', `# ${bareFixme}: nor this one\n`);
    await write('data.json', '{}\n');
    expect(await check([dir])).toBe(1);
  });

  it('fails rather than passing when every configured root is empty', async () => {
    const second = await mkdtemp(join(tmpdir(), 'hygiene-b-'));
    try {
      expect(await check([dir, second])).toBe(1);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  it('rejects, naming the root, when a configured root does not exist', async () => {
    await expect(check([join(dir, 'no-such-root')])).rejects.toThrow('could not be read');
  });

  it('rejects on a missing root even when another root has files', async () => {
    await write('clean.ts', 'export const value = 1;\n');
    await expect(check([dir, join(dir, 'no-such-root')])).rejects.toThrow('could not be read');
  });
});

describe('bare markers fail', () => {
  it.each([bareTodo, bareFixme, bareHack])('fails on a bare %s', async (marker) => {
    await write('a.ts', `// ${marker}: no issue behind this\n`);
    expect(await check([dir])).toBe(1);
  });

  it('reports the offending file and line', async () => {
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    await write('a.ts', `const x = 1;\nconst y = 2;\n// ${bareTodo}: bare\n`);
    expect(await check([dir])).toBe(1);
    expect(errors.join('\n')).toContain(`${join(dir, 'a.ts')}:3`);
  });

  it('fails on a marker in a .mjs file, not only .ts', async () => {
    await write('a.mjs', `// ${bareHack}: bare\n`);
    expect(await check([dir])).toBe(1);
  });

  it('fails on a marker nested below the root', async () => {
    await mkdir(join(dir, 'deep', 'deeper'), { recursive: true });
    await writeFile(join(dir, 'deep', 'deeper', 'a.ts'), `// ${bareFixme}: bare\n`, 'utf8');
    expect(await check([dir])).toBe(1);
  });

  it('fails when one file among several is bare', async () => {
    await write('clean.ts', `// ${bareTodo}: tracked (#12)\n`);
    await write('bare.ts', `// ${bareTodo}: untracked\n`);
    expect(await check([dir])).toBe(1);
  });
});

describe('markers naming an issue pass', () => {
  it('accepts a parenthesised issue number', async () => {
    await write('a.ts', `// ${bareTodo}: rework the binder (#42)\n`);
    expect(await check([dir])).toBe(0);
  });

  it('accepts an issue URL', async () => {
    await write(
      'a.ts',
      `// ${bareFixme}: https://github.com/ChelseaKR/reuseproof-ca-core/issues/7\n`,
    );
    expect(await check([dir])).toBe(0);
  });

  it('requires the reference on the same line as the marker', async () => {
    await write('a.ts', `// ${bareTodo}: rework the binder\n// tracked in (#42)\n`);
    expect(await check([dir])).toBe(1);
  });

  it('does not accept a bare hash without the parentheses', async () => {
    await write('a.ts', `// ${bareTodo}: rework the binder #42\n`);
    expect(await check([dir])).toBe(1);
  });
});

describe('marker matching is word-bounded', () => {
  it('passes on a longer word merely containing a marker', async () => {
    await write(
      'a.ts',
      `export const ${bareTodo.toLowerCase()}s = 1;\nexport const un${bareHack}ed = 2;\n`,
    );
    expect(await check([dir])).toBe(0);
  });

  it('is case sensitive: lowercase prose is not a marker', async () => {
    await write('a.ts', `// this is a ${bareTodo.toLowerCase()} for later\n`);
    expect(await check([dir])).toBe(0);
  });
});

describe('a clean scan reports what it covered', () => {
  it('states the number of files scanned so a pass is not read as "nothing found"', async () => {
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    await write('a.ts', 'export const a = 1;\n');
    await write('b.mjs', 'export const b = 2;\n');
    expect(await check([dir])).toBe(0);
    expect(logs.join('\n')).toContain('2 source file(s) scanned');
  });
});

/**
 * The roots that actually ship. The mechanism is exercised above against temporary directories;
 * this asserts the shipped configuration still describes this repository, which is the condition
 * the empty-scan guard exists to protect.
 */
describe('the shipped roots', () => {
  it('scans a non-empty set of files and finds no bare markers', async () => {
    expect(await check(defaultRoots)).toBe(0);
  });

  it('names src, scripts and tests', () => {
    expect(defaultRoots).toEqual(['src', 'scripts', 'tests']);
  });
});
