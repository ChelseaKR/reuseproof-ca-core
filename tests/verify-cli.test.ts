/** The command a records clerk runs, and every way it must refuse rather than reassure. */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BundleChangedError,
  EXIT_BUNDLE_CHANGED_DURING_READ,
  EXIT_INTERNAL,
  EXIT_NOT_COMPARED,
  EXIT_SNAPSHOT_MISMATCH,
  EXIT_USAGE,
  EXIT_VERIFIED,
  REASON_EXIT_CODES,
  describeThrown,
  parseArguments,
  readVerifiedManifest,
  runVerify,
  type VerifyDependencies,
} from '../scripts/verify.js';
import {
  freezeReport,
  parseBoundedJson,
  sha256,
  verifyFrozenReportBundleAtPath,
  writeFrozenReportBundleAtomically,
  type FrozenReport,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

const parents: string[] = [];

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function invoke(...argv: readonly string[]): Promise<Run> {
  return invokeWith(undefined, ...argv);
}

async function invokeWith(
  dependencies: VerifyDependencies | undefined,
  ...argv: readonly string[]
): Promise<Run> {
  let out = '';
  let err = '';
  const write = (text: string): void => {
    out += text;
  };
  const warn = (text: string): void => {
    err += text;
  };
  const code =
    dependencies === undefined
      ? await runVerify(argv, write, warn)
      : await runVerify(argv, write, warn, dependencies);
  return { code, out, err };
}

async function writeBundle(
  report?: FrozenReport,
): Promise<{ directory: string; snapshot: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'verify-cli-'));
  parents.push(parent);
  const frozen = report ?? freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
  const written = await writeFrozenReportBundleAtomically(parent, frozen);
  return { directory: written.bundleDirectory, snapshot: frozen.snapshotId };
}

/** Overwrite a bundle file, bypassing the 0o600 write-once mode the writer sets. */
async function overwrite(directory: string, filename: string, text: string): Promise<void> {
  const path = join(directory, filename);
  await chmod(path, 0o600);
  await writeFile(path, text, 'utf8');
}

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    await rm(parent, { recursive: true, force: true });
  }
});

describe('reuseproof-verify, the passing path', () => {
  it('verifies a written bundle against its own snapshot ID and lists every artifact', async () => {
    const { directory, snapshot } = await writeBundle();
    const manifest = (
      parseBoundedJson(await readFile(join(directory, 'report-freeze.json'), 'utf8')) as {
        renderManifest: readonly { logicalFilename: string; byteLength: number; sha256: string }[];
      }
    ).renderManifest;

    const run = await invoke(directory, '--expect-snapshot', snapshot);

    expect(run.code).toBe(EXIT_VERIFIED);
    expect(run.err).toBe('');
    expect(manifest.length).toBeGreaterThan(0);
    for (const item of manifest) {
      expect(run.out).toContain(
        `artifact ${item.logicalFilename} bytes=${String(item.byteLength)} sha256=${item.sha256}`,
      );
    }
    expect(run.out).toContain(`snapshot-id ${snapshot}`);
    expect(run.out).toContain('verified bundle bytes match their frozen render manifest');
    expect(run.out).toContain(`verified snapshot-id matches the recorded ${snapshot}`);
  });

  it('prints every limitation the verification carries, not a bare pass', async () => {
    const { directory, snapshot } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);

    const run = await invoke(directory, '--expect-snapshot', snapshot);

    expect(verified.limitations.length).toBe(5);
    for (const limitation of verified.limitations) {
      expect(run.out).toContain(`limitation ${limitation}`);
    }
  });

  it('emits exactly the VerifiedFrozenReportBundle under --json', async () => {
    const { directory, snapshot } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);

    const run = await invoke(directory, '--expect-snapshot', snapshot, '--json');

    expect(run.code).toBe(EXIT_VERIFIED);
    expect(JSON.parse(run.out)).toEqual(JSON.parse(JSON.stringify(verified)));
  });

  it('is deterministic: the same bundle produces the same bytes twice', async () => {
    const { directory, snapshot } = await writeBundle();

    const first = await invoke(directory, '--expect-snapshot', snapshot);
    const second = await invoke(directory, '--expect-snapshot', snapshot);

    expect(first).toEqual(second);
  });
});

describe('reuseproof-verify never prints a partial verification', () => {
  it('refuses an altered artifact with the digest-mismatch code and no verified line', async () => {
    const { directory, snapshot } = await writeBundle();
    const original = await readFile(join(directory, 'coverage-report.csv'), 'utf8');
    await overwrite(directory, 'coverage-report.csv', `${original} `);

    const run = await invoke(directory, '--expect-snapshot', snapshot);

    expect(run.code).toBe(REASON_EXIT_CODES.render_artifact_hash_mismatch);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=render_artifact_hash_mismatch');
    expect(run.err.trimEnd().split('\n')).toHaveLength(1);
  });

  it('refuses a wrong recorded snapshot ID even though the bundle is self-consistent', async () => {
    const { directory, snapshot } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);

    const run = await invoke(directory, '--expect-snapshot', `${snapshot}0`);

    expect(verified.snapshotId).toBe(snapshot);
    expect(run.code).toBe(EXIT_SNAPSHOT_MISMATCH);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=snapshot_id_mismatch');
    expect(run.err).toContain(`actual=${snapshot}`);
  });

  it('gives the snapshot mismatch a code no refusal reason uses', () => {
    expect(Object.values(REASON_EXIT_CODES)).not.toContain(EXIT_SNAPSHOT_MISMATCH);
  });

  it('refuses a missing bundle directory rather than reporting nothing wrong', async () => {
    const run = await invoke(
      join(tmpdir(), 'verify-cli-absent-directory'),
      '--expect-snapshot',
      'x',
    );

    expect(run.code).toBe(REASON_EXIT_CODES.bundle_directory_unreadable);
    expect(run.out).toBe('');
  });

  it('refuses a stray file in the bundle', async () => {
    const { directory, snapshot } = await writeBundle();
    await writeFile(join(directory, 'notes.txt'), 'left behind', 'utf8');

    const run = await invoke(directory, '--expect-snapshot', snapshot);

    expect(run.code).toBe(REASON_EXIT_CODES.unexpected_bundle_entry);
    expect(run.out).toBe('');
  });

  it('emits the refusal as JSON under --json, and still no verified line', async () => {
    const { directory, snapshot } = await writeBundle();
    await writeFile(join(directory, 'notes.txt'), 'left behind', 'utf8');

    const run = await invoke(directory, '--expect-snapshot', snapshot, '--json');

    expect(run.code).toBe(REASON_EXIT_CODES.unexpected_bundle_entry);
    expect(JSON.parse(run.out)).toEqual({
      refused: true,
      reason: 'unexpected_bundle_entry',
      bundleDirectory: directory,
      exit: REASON_EXIT_CODES.unexpected_bundle_entry,
    });
    expect(run.out).not.toContain('verified');
  });

  it('emits a snapshot mismatch as JSON naming both IDs', async () => {
    const { directory, snapshot } = await writeBundle();

    const run = await invoke(directory, '--expect-snapshot', 'rpf1-nope', '--json');

    expect(JSON.parse(run.out)).toEqual({
      refused: true,
      reason: 'snapshot_id_mismatch',
      bundleDirectory: directory,
      expectedSnapshotId: 'rpf1-nope',
      actualSnapshotId: snapshot,
      exit: EXIT_SNAPSHOT_MISMATCH,
    });
  });
});

describe('reuseproof-verify requires an independently recorded snapshot ID', () => {
  it('refuses to run with neither --expect-snapshot nor --print-only', async () => {
    const { directory } = await writeBundle();

    const run = await invoke(directory);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=usage');
    expect(run.err).toContain('a self-consistent unsigned bundle proves nothing on its own');
  });

  it('prints under --print-only and still exits non-zero, so the omission is visible', async () => {
    const { directory, snapshot } = await writeBundle();

    const run = await invoke(directory, '--print-only');

    expect(run.code).toBe(EXIT_NOT_COMPARED);
    expect(run.code).not.toBe(EXIT_VERIFIED);
    expect(run.out).toContain(`snapshot-id ${snapshot}`);
    expect(run.out).toContain('not compared');
    expect(run.out).not.toContain('verified bundle bytes match');
  });

  it('refuses --print-only together with --expect-snapshot', async () => {
    const { directory, snapshot } = await writeBundle();

    const run = await invoke(directory, '--print-only', '--expect-snapshot', snapshot);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out).toBe('');
  });
});

describe('reuseproof-verify argument handling', () => {
  it('rejects an unknown option', () => {
    expect(() => parseArguments(['dir', '--verify-everything'])).toThrow('unknown option');
  });

  it('rejects a second bundle directory', () => {
    expect(() => parseArguments(['dir', 'other', '--print-only'])).toThrow(
      'exactly one bundle directory',
    );
  });

  it('rejects --expect-snapshot with no value, including a following flag', () => {
    expect(() => parseArguments(['dir', '--expect-snapshot'])).toThrow('needs a value');
    expect(() => parseArguments(['dir', '--expect-snapshot', '--json'])).toThrow('needs a value');
  });

  it('accepts flags in any order', () => {
    expect(parseArguments(['--json', '--expect-snapshot', 'rpf1-a', 'dir'])).toEqual({
      bundleDirectory: 'dir',
      expectSnapshot: 'rpf1-a',
      printOnly: false,
      json: true,
    });
  });
});

describe('the exit-code table', () => {
  it('gives every refusal reason its own code, disjoint from the fixed ones', () => {
    const reasonCodes = Object.values(REASON_EXIT_CODES);
    const fixed = [
      EXIT_VERIFIED,
      EXIT_USAGE,
      EXIT_SNAPSHOT_MISMATCH,
      EXIT_NOT_COMPARED,
      EXIT_INTERNAL,
      EXIT_BUNDLE_CHANGED_DURING_READ,
    ];

    // Fifteen is the size of FrozenBundleRejectionReason. The record is total over that
    // union, so a reason added to the library fails to compile here; this pins that the
    // table was not quietly narrowed by widening the type instead.
    expect(reasonCodes).toHaveLength(15);
    expect(new Set(reasonCodes).size).toBe(reasonCodes.length);
    expect(new Set(fixed).size).toBe(fixed.length);
    for (const code of reasonCodes) {
      expect(fixed).not.toContain(code);
      expect(Number.isSafeInteger(code) && code > 0 && code < 126).toBe(true);
    }
  });

  it('is documented in the README exactly as it is defined', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

    for (const [reason, code] of Object.entries(REASON_EXIT_CODES)) {
      expect(readme).toContain(`| ${String(code)} | \`${reason}\` |`);
    }
    expect(readme).toContain(`| ${String(EXIT_SNAPSHOT_MISMATCH)} | \`snapshot_id_mismatch\` |`);
  });
});

describe('the published command', () => {
  it('is wired to the built module and is executable', async () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      bin: Record<string, string>;
    };
    const shim = await readFile(new URL('bin/reuseproof-verify.js', root), 'utf8');
    const mode = (await stat(new URL('bin/reuseproof-verify.js', root))).mode;

    expect(manifest.bin).toEqual({ 'reuseproof-verify': 'bin/reuseproof-verify.js' });
    expect(shim).toContain("from '../dist/scripts/verify.js'");
    expect(shim.startsWith('#!/usr/bin/env node')).toBe(true);
    // The shim must not reimplement the check: everything it does is call one function.
    expect(shim).not.toContain('verifyFrozenReportBundleAtPath');
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});

describe('the arms a real bundle on a real disk cannot reach', () => {
  it('reports a refusal it does not model as an internal error, never as a pass', async () => {
    const { directory } = await writeBundle();

    const run = await invokeWith(
      {
        verifyBundle: () => Promise.reject(new Error('the disk went away')),
      },
      directory,
      '--expect-snapshot',
      'rpf1-anything',
    );

    expect(run.code).toBe(EXIT_INTERNAL);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=internal_error');
    expect(run.err).toContain('detail=the disk went away');
  });

  it('names a thrown non-Error rather than printing undefined', () => {
    expect(describeThrown(new Error('a real one'), 'fallback')).toBe('a real one');
    expect(describeThrown('a string', 'a non-error value was thrown')).toBe(
      'a non-error value was thrown',
    );
    expect(describeThrown(undefined, 'the bundle could not be read back')).toBe(
      'the bundle could not be read back',
    );
  });

  it('refuses when the bundle changed between verification and the manifest read-back', async () => {
    const { directory, snapshot } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);
    // Verification has happened. The file it was rooted at is now a different file, so
    // the manifest read back is not the manifest that was matched.
    await overwrite(directory, 'report-freeze.json', '{"renderManifest":[]}');

    const run = await invokeWith(
      { verifyBundle: () => Promise.resolve(verified) },
      directory,
      '--expect-snapshot',
      snapshot,
    );

    expect(run.code).toBe(EXIT_BUNDLE_CHANGED_DURING_READ);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=bundle_changed_during_read');
    expect(run.err).toContain('changed between verification and read-back');
  });

  it('refuses a read-back that is no longer valid UTF-8', async () => {
    const { directory } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);
    await chmod(join(directory, 'report-freeze.json'), 0o600);
    await writeFile(join(directory, 'report-freeze.json'), Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(readVerifiedManifest(verified)).rejects.toBeInstanceOf(BundleChangedError);
  });

  it.each([
    ['{"renderManifest":{}}', 'carries no render manifest'],
    ['{"renderManifest":[{"logicalFilename":1}]}', 'not in the verified shape'],
  ])('refuses a read-back whose manifest is %s', async (text, detail) => {
    const { directory } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);
    // The hash is recomputed over the replacement, so the anchor holds and the shape
    // check is what has to fire. Without this the test would pass on the anchor alone.
    const stale = { ...verified, snapshotId: `rpf1-${sha256(text)}` };

    await overwrite(directory, 'report-freeze.json', text);

    await expect(readVerifiedManifest(stale)).rejects.toBeInstanceOf(BundleChangedError);
    await expect(readVerifiedManifest(stale)).rejects.toThrow(detail);
  });
});

describe('--print-only with --json', () => {
  it('prints the identifiers, the caveat, and the result, and still exits non-zero', async () => {
    const { directory, snapshot } = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(directory);

    const run = await invoke(directory, '--print-only', '--json');

    expect(run.code).toBe(EXIT_NOT_COMPARED);
    expect(run.out).toContain(`snapshot-id ${snapshot}`);
    expect(run.out).toContain('not compared');
    expect(run.out).toContain(JSON.stringify(verified, null, 2));
  });
});
