/**
 * Tests for the artifact test-vector corpus (ADR-0015, #71).
 *
 * The corpus is a gate, so the tests that matter are the ones proving it cannot report success
 * for a comparison it did not make. Three of its refusals are exactly the shape ADR-0011 exists
 * for -- an empty corpus, a vector recording nothing, and a corpus in which every vector is
 * superseded -- and each of those is a state in which every byte comparison the checker performs
 * passes, because it performs none.
 *
 * Every negative fixture here is built by mutating a copy of the **shipped** vector, and every
 * mutation is asserted to have changed the bytes before the assertion under test runs. A
 * mutation that silently no-ops reads exactly like a checker that correctly found nothing wrong.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  VECTORS_DIRECTORY,
  VECTOR_MANIFEST_FILENAME,
  VECTOR_MANIFEST_SCHEMA_VERSION,
  VectorCorpusError,
  checkVectorCorpus,
  collectSchemaVersions,
  readVectorManifest,
} from '../scripts/vector-corpus.js';

/** The one vector this repository ships. Named, so a rename fails here rather than silently. */
const SHIPPED_VECTOR = 'v1-reconciled-demo';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vector-corpus-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A working copy of the shipped corpus, so a test may mutate it without touching the tree. */
async function copyShippedCorpus(): Promise<string> {
  const corpus = join(root, 'vectors');
  await cp(VECTORS_DIRECTORY, corpus, { recursive: true });
  return corpus;
}

async function readManifest(
  corpus: string,
  vectorId = SHIPPED_VECTOR,
): Promise<Record<string, unknown>> {
  const text = await readFile(join(corpus, vectorId, VECTOR_MANIFEST_FILENAME), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Write a mutated manifest, and refuse to continue unless the bytes actually moved.
 *
 * This is the `git hash-object` discipline in a test: a mutation that matched nothing writes the
 * file back unchanged, the assertion then passes for a reason unrelated to the guard, and the
 * green run is recorded as proof.
 */
async function writeMutatedManifest(
  corpus: string,
  mutate: (manifest: Record<string, unknown>) => void,
  vectorId = SHIPPED_VECTOR,
): Promise<void> {
  const path = join(corpus, vectorId, VECTOR_MANIFEST_FILENAME);
  const before = await readFile(path, 'utf8');
  const manifest = JSON.parse(before) as Record<string, unknown>;
  mutate(manifest);
  const after = `${JSON.stringify(manifest)}\n`;
  expect(digest(after), 'the mutation did not change the manifest, so it proves nothing').not.toBe(
    digest(before),
  );
  await writeFile(path, after, 'utf8');
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('the shipped corpus', () => {
  it('re-derives the shipped vector byte for byte, and says what it examined', async () => {
    const report = await checkVectorCorpus(VECTORS_DIRECTORY);

    expect(report.liveVectorId).toBe(SHIPPED_VECTOR);
    expect(report.outcomes).toEqual([
      {
        vectorId: SHIPPED_VECTOR,
        state: 'live',
        recordedFileCount: report.checkedFileCount,
        supersededReason: null,
      },
    ]);
    // The count is the coverage claim. "0 findings" and "0 inputs" print the same green line
    // without it, which is the whole reason the report carries it.
    expect(report.checkedFileCount).toBeGreaterThan(0);
  });

  it('covers every artifact the shipped bundle and case emit', async () => {
    const manifest = readVectorManifest(await readManifest(await copyShippedCorpus()), 'manifest');
    const paths = manifest.files.map(({ path }) => path);

    // Both halves of what an evaluation writes: the frozen report bundle, and the evidence case
    // whose replay ADR-0013 defines. A corpus covering one of the two would be silent about
    // every identifier derived from the other.
    expect(paths).toContain('artifacts/report-freeze.json');
    expect(paths).toContain('artifacts/receipt-core.json');
    expect(paths).toContain('case/evidence-case.json');
    expect(paths).toContain('case/case-input.json');
    expect(paths.filter((path) => path.startsWith('case/sources/')).length).toBeGreaterThan(0);
    expect(manifest.renderManifestOrder.length).toBeGreaterThan(0);
  });

  it('keeps git out of the recorded bytes, so a fresh clone is what was recorded', async () => {
    // Measured before `.gitattributes` existed: `coverage-report.csv` is RFC 4180 CSV and
    // carries three CRLF terminators, and with `core.autocrlf=input` the staged blob held zero
    // carriage returns while the worktree file hashed to the digest the manifest records. The
    // gate would then have failed in CI on a byte no renderer touched. This asserts the
    // relation -- git reports end-of-line conversion as off for a recorded artifact -- rather
    // than that a particular line appears in a particular file.
    const path = `${VECTORS_DIRECTORY}/${SHIPPED_VECTOR}/artifacts/coverage-report.csv`;
    const raw = await readFile(path);
    expect(
      raw.includes(Buffer.from('\r\n', 'utf8')),
      'the fixture no longer carries CRLF, so this proves nothing',
    ).toBe(true);

    const attributes = execFileSync('git', ['check-attr', 'text', '--', path], {
      encoding: 'utf8',
    });

    expect(attributes.trim()).toBe(`${path}: text: unset`);
  });
});

describe('a corpus that examined nothing is an error, never a pass', () => {
  it('refuses a root it cannot read', async () => {
    await expect(checkVectorCorpus(join(root, 'no-such-directory'))).rejects.toBeInstanceOf(
      VectorCorpusError,
    );
    await expect(checkVectorCorpus(join(root, 'no-such-directory'))).rejects.toThrow(
      'could not be read',
    );
  });

  it('refuses a root holding no vector directory', async () => {
    const corpus = join(root, 'vectors');
    await mkdir(corpus);
    await writeFile(join(corpus, 'README.md'), '# not a vector\n', 'utf8');

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('holds no vector directory');
  });

  it('refuses a manifest that records no file', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.files = [];
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('could never fail');
  });
});

describe('a vector is held to its own recorded bytes', () => {
  it('refuses a recorded artifact whose stored bytes have drifted', async () => {
    const corpus = await copyShippedCorpus();
    const path = join(corpus, SHIPPED_VECTOR, 'artifacts', 'coverage-report.csv');
    const before = await readFile(path, 'utf8');
    const after = `${before}trailing\n`;
    expect(digest(after)).not.toBe(digest(before));
    await writeFile(path, after, 'utf8');

    // Names the file, the recorded digest and the one on disk -- not merely "a file changed".
    await expect(checkVectorCorpus(corpus)).rejects.toThrow('no longer matches its own manifest');
  });

  it('refuses a vector holding a file its manifest does not record', async () => {
    const corpus = await copyShippedCorpus();
    await writeFile(join(corpus, SHIPPED_VECTOR, 'artifacts', 'extra.json'), '{}\n', 'utf8');

    await expect(checkVectorCorpus(corpus)).rejects.toThrow(
      'holds files its manifest does not record',
    );
  });

  it('refuses a recorded identifier that does not carry its artifact digest', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      const identities = manifest.identities as Record<string, string>;
      identities.snapshotId =
        'rpf1-0000000000000000000000000000000000000000000000000000000000000000';
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('does not carry');
  });

  it('refuses a manifest whose files are not sorted by path', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.files = [...(manifest.files as unknown[])].reverse();
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('must be sorted by path');
  });

  it('refuses a manifest written by a version of this format it does not understand', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.schemaVersion = 'artifact-test-vector/v99';
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow(VECTOR_MANIFEST_SCHEMA_VERSION);
  });

  it('refuses a manifest whose vectorId is not its directory name', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.vectorId = 'some-other-name';
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('which is not its directory name');
  });
});

describe('a live vector must re-derive, and only one vector may be live', () => {
  it('fails naming the artifact and both digests when a recorded byte moves', async () => {
    const corpus = await copyShippedCorpus();
    // Rewrite BOTH the stored bytes and their recorded digest, so the stored-bytes check passes
    // and the re-derivation is what has to fire. Without this the test would pass on the
    // earlier, weaker check and prove nothing about re-derivation at all.
    const path = join(corpus, SHIPPED_VECTOR, 'artifacts', 'coverage-report.csv');
    const before = await readFile(path);
    const after = Buffer.concat([before, Buffer.from('moved\n', 'utf8')]);
    await writeFile(path, after);
    await writeMutatedManifest(corpus, (manifest) => {
      const files = manifest.files as { path: string; byteLength: number; sha256: string }[];
      const record = files.find((file) => file.path === 'artifacts/coverage-report.csv');
      if (record === undefined) {
        throw new Error('the shipped vector no longer records coverage-report.csv');
      }
      record.byteLength = after.byteLength;
      record.sha256 = createHash('sha256').update(after).digest('hex');
    });

    const failure = await checkVectorCorpus(corpus).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(VectorCorpusError);
    expect(failure?.message).toContain('artifacts/coverage-report.csv moved');
    expect(failure?.message).toContain(createHash('sha256').update(after).digest('hex'));
    expect(failure?.message).toContain(createHash('sha256').update(before).digest('hex'));
    // The message has to say what the maintainer's two options are, or the only way past it is
    // to re-record -- which turns the corpus into a document that agrees with whatever the
    // library currently does.
    expect(failure?.message).toContain('artifact version must be');
  });

  it('fails on a render manifest that agrees as a set and differs in order', async () => {
    const corpus = await copyShippedCorpus();
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.renderManifestOrder = [...(manifest.renderManifestOrder as string[])].reverse();
    });

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('The comparison is ordered');
  });

  it('refuses two vectors that both record the version set this library emits', async () => {
    const corpus = await copyShippedCorpus();
    await cp(join(corpus, SHIPPED_VECTOR), join(corpus, 'a-duplicate'), { recursive: true });
    await writeMutatedManifest(
      corpus,
      (manifest) => {
        manifest.vectorId = 'a-duplicate';
      },
      'a-duplicate',
    );

    await expect(checkVectorCorpus(corpus)).rejects.toThrow('Exactly one vector may be live');
  });

  it('refuses a corpus in which every vector is superseded, having re-derived nothing', async () => {
    const corpus = await copyShippedCorpus();
    // A version set the library does not emit makes the vector superseded rather than failed --
    // which is correct, and is also the state in which every remaining check passes because
    // there is nothing left to compare against.
    await writeMutatedManifest(corpus, (manifest) => {
      manifest.artifactSchemaVersions = ['frozen-report-core/v99'];
    });

    const failure = await checkVectorCorpus(corpus).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(VectorCorpusError);
    expect(failure?.message).toContain('no vector is live');
    expect(failure?.message).toContain('frozen-report-core/v99');
  });

  it('treats an input this library refuses as superseded, not as a pass and not as a crash', async () => {
    const corpus = await copyShippedCorpus();
    // Both directories are needed: one whose input this library no longer reads, and one that
    // still re-derives. Without the second, the run would fail as "no vector is live" and this
    // test could not tell the superseded path from the empty-corpus one.
    await cp(join(corpus, SHIPPED_VECTOR), join(corpus, 'v0-unreadable'), { recursive: true });
    await writeMutatedManifest(
      corpus,
      (manifest) => {
        manifest.vectorId = 'v0-unreadable';
      },
      'v0-unreadable',
    );
    await writeFile(join(corpus, 'v0-unreadable', 'input.json'), '{"not":"an input"}\n', 'utf8');

    const report = await checkVectorCorpus(corpus);

    expect(report.liveVectorId).toBe(SHIPPED_VECTOR);
    const superseded = report.outcomes.find(({ vectorId }) => vectorId === 'v0-unreadable');
    expect(superseded?.state).toBe('superseded');
    expect(superseded?.supersededReason).toContain("refuses the vector's frozen input");
  });
});

describe('collectSchemaVersions', () => {
  it('finds every schemaVersion at any depth, sorted and deduplicated', () => {
    expect(
      collectSchemaVersions([
        { schemaVersion: 'b/v1', nested: { schemaVersion: 'a/v1' } },
        [{ deeper: [{ schemaVersion: 'b/v1' }] }],
        'a string',
        null,
      ]),
    ).toEqual(['a/v1', 'b/v1']);
  });

  it('ignores a schemaVersion that is not a string, rather than recording its shape', () => {
    expect(collectSchemaVersions([{ schemaVersion: 7 }])).toEqual([]);
  });
});

describe('readVectorManifest refuses a malformed manifest rather than skipping it', () => {
  const base = {
    schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
    vectorId: 'x',
    recordedOn: '2026-09-09',
    artifactSchemaVersions: ['a/v1'],
    renderManifestOrder: ['one.json'],
    identities: {
      snapshotId: `rpf1-${'0'.repeat(64)}`,
      snapshotHash: '0'.repeat(64),
      receiptId: `rpr1-${'1'.repeat(64)}`,
      receiptCoreHash: '1'.repeat(64),
      reportContentHash: '2'.repeat(64),
      evaluationHash: '3'.repeat(64),
      caseId: `rpc1-${'4'.repeat(64)}`,
      caseHash: '4'.repeat(64),
    },
    files: [{ path: 'one.json', byteLength: 1, sha256: '5'.repeat(64) }],
  };

  it('accepts the well-formed shape', () => {
    expect(readVectorManifest(structuredClone(base), 'm').vectorId).toBe('x');
  });

  it.each([
    [
      'a digest that is not lowercase hex',
      { identities: { ...base.identities, snapshotHash: 'NOTHEX' } },
    ],
    ['a byteLength that is not an integer', { files: [{ ...base.files[0], byteLength: 1.5 }] }],
    ['a negative byteLength', { files: [{ ...base.files[0], byteLength: -1 }] }],
    ['an empty artifactSchemaVersions', { artifactSchemaVersions: [] }],
    ['an empty renderManifestOrder', { renderManifestOrder: [] }],
    ['a blank vectorId', { vectorId: '   ' }],
  ])('refuses %s', (_label, patch) => {
    expect(() => readVectorManifest({ ...structuredClone(base), ...patch }, 'm')).toThrow(
      VectorCorpusError,
    );
  });
});
