/**
 * The command that answers "is this bundle what its inputs produce", and every way it refuses.
 *
 * The passing path is the interesting one here, and it is not a shape assertion: the command is
 * handed a snapshot ID derived in this test from the *original* input, and the case it replays
 * has been through canonical JSON and back off a disk. A replay that reconstructed a plausible
 * input rather than the same one would print an equally confident line with a different ID.
 *
 * Everything else is fail-closed. The exit-code table is checked for totality and disjointness,
 * and against the README, because a refusal reason nobody can look up is a reason nobody acts
 * on. Two arms are unreachable with a real case on a real disk — the reader refusing with
 * something that is not an `EvidenceCaseError`, and the evaluator refusing an input the reader
 * has already reconstructed — and they are driven through the dependency seam rather than left
 * as claims.
 */

import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT_EVALUATION_HASH_MISMATCH,
  EXIT_INTERNAL,
  EXIT_NOT_COMPARED,
  EXIT_REPLAYED,
  EXIT_REPLAY_REFUSED,
  EXIT_SNAPSHOT_MISMATCH,
  EXIT_USAGE,
  REASON_EXIT_CODES,
  USAGE,
  describeThrown,
  parseArguments,
  runReplay,
  type ReplayDependencies,
} from '../scripts/replay.js';
import {
  EVIDENCE_CASE_MANIFEST_FILE,
  EVIDENCE_CASE_SOURCE_DIRECTORY,
  EvidenceCaseError,
  evaluateReconciledCsvEvidence,
  readEvidenceCaseAtPath,
  writeEvidenceCaseAtomically,
} from '../src/index.js';
import {
  defaultCsvBytes,
  reconciledEvidenceInput,
  testSeriesParts,
} from './reconciled-evaluation-helpers.js';

const parents: string[] = [];

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function invokeWith(
  dependencies: ReplayDependencies | undefined,
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
      ? await runReplay(argv, write, warn)
      : await runReplay(argv, write, warn, dependencies);
  return { code, out, err };
}

async function invoke(...argv: readonly string[]): Promise<Run> {
  return invokeWith(undefined, ...argv);
}

interface WrittenCase {
  readonly directory: string;
  readonly snapshot: string;
  readonly evaluationHash: string;
}

async function writeCase(sourceObjects?: readonly Uint8Array[]): Promise<WrittenCase> {
  const parent = await mkdtemp(join(tmpdir(), 'replay-cli-'));
  parents.push(parent);
  const parts =
    sourceObjects === undefined ? testSeriesParts() : testSeriesParts({ sourceObjects });
  const input = reconciledEvidenceInput([parts]);
  const result = evaluateReconciledCsvEvidence(input);
  const written = await writeEvidenceCaseAtomically(parent, input);
  return {
    directory: written.caseDirectory,
    snapshot: result.frozenReport.snapshotId,
    evaluationHash: result.evaluationHash,
  };
}

/** Overwrite a case member, bypassing the 0o600 write-once mode the writer sets. */
async function overwrite(
  directory: string,
  filename: string,
  contents: string | Uint8Array,
): Promise<void> {
  const path = join(directory, filename);
  await chmod(path, 0o600);
  await writeFile(path, contents);
}

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    await rm(parent, { recursive: true, force: true });
  }
});

describe('reuseproof-replay, the passing path', () => {
  it('replays a case and matches the snapshot ID recorded from the original input', async () => {
    const written = await writeCase();
    const read = await readEvidenceCaseAtPath(written.directory);

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot);

    expect(run.code).toBe(EXIT_REPLAYED);
    expect(run.err).toBe('');
    expect(run.out).toContain(`case-id ${read.caseId}`);
    expect(run.out).toContain(`snapshot-id ${written.snapshot}`);
    expect(run.out).toContain(`evaluation-hash ${written.evaluationHash}`);
    expect(run.out).toContain(
      'replayed case members are the complete evaluation input the manifest describes',
    );
    expect(run.out).toContain(`replayed snapshot-id matches the recorded ${written.snapshot}`);
    for (const member of read.members) {
      expect(run.out).toContain(
        `member ${member.logicalFilename} bytes=${String(member.byteLength)} sha256=${member.sha256}`,
      );
    }
  });

  it('checks the recorded root evaluation hash when one is given', async () => {
    const written = await writeCase();

    const run = await invoke(
      written.directory,
      '--expect-snapshot',
      written.snapshot,
      '--expect-evaluation-hash',
      written.evaluationHash,
    );

    expect(run.code).toBe(EXIT_REPLAYED);
    expect(run.out).toContain(
      `replayed evaluation-hash matches the recorded ${written.evaluationHash}`,
    );
  });

  it('prints every limitation the replay carries, not a bare pass', async () => {
    const written = await writeCase();
    const read = await readEvidenceCaseAtPath(written.directory);

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot);

    expect(read.limitations.length).toBe(4);
    for (const limitation of read.limitations) {
      expect(run.out).toContain(`limitation ${limitation}`);
    }
  });

  it('emits the derived identifiers, the claim and the limitations under --json', async () => {
    const written = await writeCase();

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot, '--json');
    const parsed = JSON.parse(run.out) as Record<string, unknown>;

    expect(run.code).toBe(EXIT_REPLAYED);
    expect(parsed.snapshotId).toBe(written.snapshot);
    expect(parsed.evaluationHash).toBe(written.evaluationHash);
    expect(parsed.limitations).toHaveLength(4);
  });

  it('is deterministic: the same case produces the same bytes twice', async () => {
    const written = await writeCase();

    const first = await invoke(written.directory, '--expect-snapshot', written.snapshot);
    const second = await invoke(written.directory, '--expect-snapshot', written.snapshot);

    expect(first).toEqual(second);
  });

  it('replays two byte-identical submissions from one stored source object', async () => {
    const written = await writeCase([defaultCsvBytes(), defaultCsvBytes()]);
    const stored = await readdir(join(written.directory, EVIDENCE_CASE_SOURCE_DIRECTORY));

    const run = await invoke(
      written.directory,
      '--expect-snapshot',
      written.snapshot,
      '--expect-evaluation-hash',
      written.evaluationHash,
    );

    expect(stored).toHaveLength(1);
    expect(run.code).toBe(EXIT_REPLAYED);
  });
});

describe('a comparison that was never made is never a pass', () => {
  it('refuses to run without --expect-snapshot or --print-only', async () => {
    const written = await writeCase();

    const run = await invoke(written.directory);

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=usage');
    expect(run.err).toContain(USAGE);
  });

  it('exits non-zero under --print-only and says why', async () => {
    const written = await writeCase();

    const run = await invoke(written.directory, '--print-only');

    expect(run.code).toBe(EXIT_NOT_COMPARED);
    expect(run.out).toContain(`snapshot-id ${written.snapshot}`);
    expect(run.out).toContain('not compared');
  });

  it('adds the derived identifiers under --print-only --json, still non-zero', async () => {
    const written = await writeCase();

    const run = await invoke(written.directory, '--print-only', '--json');
    const printed = run.out.slice(run.out.indexOf('{'));

    expect(run.code).toBe(EXIT_NOT_COMPARED);
    expect((JSON.parse(printed) as { snapshotId: string }).snapshotId).toBe(written.snapshot);
  });

  it('refuses a case whose replay derives a different report', async () => {
    const written = await writeCase();

    const run = await invoke(written.directory, '--expect-snapshot', 'rpf1-'.padEnd(69, '0'));

    expect(run.code).toBe(EXIT_SNAPSHOT_MISMATCH);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=snapshot_id_mismatch');
    expect(run.err).toContain(`actual=${written.snapshot}`);
  });

  it('refuses a matching snapshot whose recorded evaluation hash does not match', async () => {
    const written = await writeCase();

    const run = await invoke(
      written.directory,
      '--expect-snapshot',
      written.snapshot,
      '--expect-evaluation-hash',
      'a'.repeat(64),
    );

    expect(run.code).toBe(EXIT_EVALUATION_HASH_MISMATCH);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=evaluation_hash_mismatch');
    expect(run.err).toContain(`actual=${written.evaluationHash}`);
  });

  it('reports a snapshot mismatch as JSON when asked, and still writes the stderr line', async () => {
    const written = await writeCase();

    const run = await invoke(
      written.directory,
      '--expect-snapshot',
      'rpf1-'.padEnd(69, '0'),
      '--json',
    );

    expect(run.code).toBe(EXIT_SNAPSHOT_MISMATCH);
    expect(JSON.parse(run.out)).toMatchObject({
      refused: true,
      reason: 'snapshot_id_mismatch',
      actualSnapshotId: written.snapshot,
    });
    expect(run.err).toContain('reason=snapshot_id_mismatch');
  });

  it('reports an evaluation-hash mismatch as JSON when asked', async () => {
    const written = await writeCase();

    const run = await invoke(
      written.directory,
      '--expect-snapshot',
      written.snapshot,
      '--expect-evaluation-hash',
      'a'.repeat(64),
      '--json',
    );

    expect(JSON.parse(run.out)).toMatchObject({
      refused: true,
      reason: 'evaluation_hash_mismatch',
      actualEvaluationHash: written.evaluationHash,
    });
  });
});

describe('the command line', () => {
  it('rejects an unknown option, a second directory, and a flag with no value', async () => {
    const written = await writeCase();

    for (const argv of [
      [written.directory, '--nope'],
      [written.directory, written.directory, '--print-only'],
      [written.directory, '--expect-snapshot', '--json'],
      [written.directory, '--expect-evaluation-hash'],
      [],
    ]) {
      const run = await invoke(...argv);
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.out).toBe('');
    }
  });

  it('refuses --print-only combined with either recorded value', async () => {
    const written = await writeCase();

    const withSnapshot = await invoke(
      written.directory,
      '--print-only',
      '--expect-snapshot',
      written.snapshot,
    );
    const withHash = await invoke(
      written.directory,
      '--print-only',
      '--expect-evaluation-hash',
      written.evaluationHash,
    );

    expect(withSnapshot.code).toBe(EXIT_USAGE);
    expect(withHash.code).toBe(EXIT_USAGE);
  });

  it('parses a complete command line into a frozen options record', () => {
    const options = parseArguments([
      'dir',
      '--expect-snapshot',
      'rpf1-a',
      '--expect-evaluation-hash',
      'abc',
      '--json',
    ]);

    expect(options).toEqual({
      caseDirectory: 'dir',
      expectSnapshot: 'rpf1-a',
      expectEvaluationHash: 'abc',
      printOnly: false,
      json: true,
    });
    expect(Object.isFrozen(options)).toBe(true);
  });
});

describe('a damaged case refuses with its own exit code', () => {
  it('returns the digest-mismatch code when one source byte moved', async () => {
    const written = await writeCase();
    const names = await readdir(join(written.directory, EVIDENCE_CASE_SOURCE_DIRECTORY));
    const name = names[0];
    expect(name).toBeDefined();
    const path = join(EVIDENCE_CASE_SOURCE_DIRECTORY, name ?? '');
    const bytes = new Uint8Array(await readFile(join(written.directory, path)));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    await overwrite(written.directory, path, bytes);

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot);

    expect(run.code).toBe(REASON_EXIT_CODES.case_member_digest_mismatch);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=case_member_digest_mismatch');
    expect(run.err).toContain('expected sha256');
    expect(run.err).toContain('actual sha256');
  });

  it('returns the unreadable-directory code for a path that does not exist', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'replay-cli-'));
    parents.push(parent);

    const run = await invoke(join(parent, 'absent'), '--expect-snapshot', 'rpf1-x');

    expect(run.code).toBe(REASON_EXIT_CODES.case_directory_unreadable);
  });

  it('returns the unexpected-entry code for a stray file, and reports it as JSON', async () => {
    const written = await writeCase();
    await writeFile(join(written.directory, 'notes.txt'), 'left behind');

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot, '--json');

    expect(run.code).toBe(REASON_EXIT_CODES.unexpected_case_entry);
    expect(JSON.parse(run.out)).toMatchObject({
      refused: true,
      reason: 'unexpected_case_entry',
      exit: REASON_EXIT_CODES.unexpected_case_entry,
    });
    expect(run.err).toContain('reason=unexpected_case_entry');
  });

  it('returns the invalid-UTF-8 code for a manifest that is not text', async () => {
    const written = await writeCase();
    await overwrite(written.directory, EVIDENCE_CASE_MANIFEST_FILE, new Uint8Array([0xff, 0xfe]));

    const run = await invoke(written.directory, '--expect-snapshot', written.snapshot);

    expect(run.code).toBe(REASON_EXIT_CODES.invalid_utf8);
  });
});

describe('the arms a real case cannot reach still have to fire', () => {
  const readable: ReplayDependencies['readCase'] = () => {
    throw new Error('unreachable in these tests');
  };

  it('reports a non-EvidenceCaseError from the reader as an internal error, never a pass', async () => {
    const run = await invokeWith(
      {
        readCase: () => Promise.reject(new TypeError('something the reader does not model')),
        evaluate: evaluateReconciledCsvEvidence,
      },
      'dir',
      '--expect-snapshot',
      'rpf1-x',
    );

    expect(run.code).toBe(EXIT_INTERNAL);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=internal_error');
  });

  it('reports an input the evaluator refuses as replay_refused, from a real case on disk', async () => {
    // The reader validates each governance object through its own constructor and deliberately
    // does not re-implement the evaluator's cross-object rules. So a case holding two contracts
    // that share an ID reads back faultlessly and is then refused at evaluation. No stub: the
    // point is that the exit code is right for a case a jurisdiction could actually be handed.
    const parent = await mkdtemp(join(tmpdir(), 'replay-cli-'));
    parents.push(parent);
    const written = await writeEvidenceCaseAtomically(
      parent,
      reconciledEvidenceInput([
        testSeriesParts({ contractId: 'contract-1', contractVersion: '1' }),
        testSeriesParts({ contractId: 'contract-1', contractVersion: '2' }),
      ]),
    );

    const run = await invoke(written.caseDirectory, '--expect-snapshot', 'rpf1-x');

    expect(run.code).toBe(EXIT_REPLAY_REFUSED);
    expect(run.out).toBe('');
    expect(run.err).toContain('reason=replay_refused');
    expect(run.err).toContain('unique');
  });

  it('describes a thrown non-Error through the stated fallback', () => {
    expect(readable).toBeTypeOf('function');
    expect(describeThrown(new Error('a real one'), 'fallback')).toBe('a real one');
    expect(describeThrown('a string', 'a non-error value was thrown')).toBe(
      'a non-error value was thrown',
    );
  });

  it('carries the refusing case directory from the error, not from the argument', async () => {
    const run = await invokeWith(
      {
        readCase: () =>
          Promise.reject(
            new EvidenceCaseError('case_file_missing', '/resolved/elsewhere', 'a member is gone'),
          ),
        evaluate: evaluateReconciledCsvEvidence,
      },
      'relative-path',
      '--expect-snapshot',
      'rpf1-x',
    );

    expect(run.code).toBe(REASON_EXIT_CODES.case_file_missing);
    expect(run.err).toContain('case=/resolved/elsewhere');
  });
});

describe('the exit-code table', () => {
  it('gives every refusal reason its own code, disjoint from the fixed ones', () => {
    const reasonCodes = Object.values(REASON_EXIT_CODES);
    const fixed = [
      EXIT_REPLAYED,
      EXIT_USAGE,
      EXIT_SNAPSHOT_MISMATCH,
      EXIT_NOT_COMPARED,
      EXIT_INTERNAL,
      EXIT_EVALUATION_HASH_MISMATCH,
      EXIT_REPLAY_REFUSED,
    ];

    // Fourteen is the size of EvidenceCaseRejectionReason. The record is total over that union,
    // so a reason added to the library fails to compile here; this pins that the table was not
    // quietly narrowed by widening the type instead.
    expect(reasonCodes).toHaveLength(14);
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
    expect(readme).toContain(
      `| ${String(EXIT_EVALUATION_HASH_MISMATCH)} | \`evaluation_hash_mismatch\` |`,
    );
    expect(readme).toContain(`| ${String(EXIT_REPLAY_REFUSED)} | \`replay_refused\` |`);
  });
});

describe('the published command', () => {
  it('is wired to the built module and is executable', async () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      bin: Record<string, string>;
    };
    const shim = await readFile(new URL('bin/reuseproof-replay.js', root), 'utf8');
    const mode = (await stat(new URL('bin/reuseproof-replay.js', root))).mode;

    expect(manifest.bin['reuseproof-replay']).toBe('bin/reuseproof-replay.js');
    expect(shim).toContain("from '../dist/scripts/replay.js'");
    expect(shim).toContain('runReplay');
    expect(mode & 0o111).not.toBe(0);
  });
});
