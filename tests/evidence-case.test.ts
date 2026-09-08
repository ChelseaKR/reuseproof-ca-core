/**
 * The evaluation input on disk, and every way reading it back must refuse rather than reassure.
 *
 * The point of the format is a claim the verifier cannot make. `reuseproof-verify` proves a
 * bundle's bytes still satisfy its own render manifest; only a replay from a case proves the
 * bundle is what those inputs produce. So the first test here is not a shape assertion — it is
 * the round trip, and it asserts the identifiers, because a case that reads back into a
 * *plausible* input rather than the *same* input would satisfy every structural check and still
 * derive a different snapshot ID.
 *
 * The refusal tests carry the weight of ADR-0003's rule: a refusal is never a partial read.
 * Each one damages a case in one specific way and asserts the typed reason, because "this could
 * not be reconstructed" must never be readable as "this reconstructed".
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EVIDENCE_CASE_INPUT_FILE,
  EVIDENCE_CASE_INPUT_SCHEMA_VERSION,
  EVIDENCE_CASE_MANIFEST_FIELDS,
  EVIDENCE_CASE_MANIFEST_FILE,
  EVIDENCE_CASE_SCHEMA_VERSION,
  EVIDENCE_CASE_SOURCE_DIRECTORY,
  EvidenceCaseError,
  canonicalJson,
  evaluateReconciledCsvEvidence,
  readEvidenceCaseAtPath,
  sha256,
  writeEvidenceCaseAtomically,
  type EvidenceCaseRejectionReason,
  type ReconciledCsvEvidenceInput,
} from '../src/index.js';
import { nonoperationInput } from './helpers.js';
import {
  csvBytes,
  defaultCsvBytes,
  reconciledEvidenceInput,
  testSeriesParts,
} from './reconciled-evaluation-helpers.js';

/**
 * Schema strings no release of this library can declare.
 *
 * A version-refusal test has to plant a version that is *not* the real one, and planting "the
 * next number" makes the fixture derive from the constant under test: the day the format moves
 * to that number, the refusal stops being a refusal and the test passes because nothing was
 * rejected. Both of these carry a suffix a release never will, and each use asserts it differs
 * from the constant it is standing against.
 */
const UNRELEASED_MANIFEST_SCHEMA = 'evidence-case/v0-never-released';
const UNRELEASED_INPUT_SCHEMA = 'evidence-case-input/v0-never-released';

const parents: string[] = [];

async function newParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'evidence-case-'));
  parents.push(parent);
  return parent;
}

async function writeCase(input: ReconciledCsvEvidenceInput): Promise<string> {
  const written = await writeEvidenceCaseAtomically(await newParent(), input);
  return written.caseDirectory;
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

async function readControl(directory: string, filename: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, filename), 'utf8')) as Record<string, unknown>;
}

async function expectRefusal(
  directory: string,
  reason: EvidenceCaseRejectionReason,
): Promise<EvidenceCaseError> {
  const error = await readEvidenceCaseAtPath(directory).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected a refusal (${reason}) but the case read`).toBeInstanceOf(
    EvidenceCaseError,
  );
  const refusal = error as EvidenceCaseError;
  expect(refusal.reason).toBe(reason);
  expect(refusal.caseDirectory).toBe(directory);
  return refusal;
}

/** The first source file of a case, by the name the manifest gives it. */
async function firstSourceName(directory: string): Promise<string> {
  const names = await readdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY));
  const first = [...names].sort()[0];
  if (first === undefined) {
    throw new Error('the case under test has no source object');
  }
  return first;
}

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    await rm(parent, { recursive: true, force: true });
  }
});

/** Rewrite the manifest through a transform, so a test can restate what it declares. */
async function restate(
  directory: string,
  transform: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const manifest = await readControl(directory, EVIDENCE_CASE_MANIFEST_FILE);
  await overwrite(directory, EVIDENCE_CASE_MANIFEST_FILE, canonicalJson(transform(manifest)));
}

/** The exact-byte digest the case format names a source file by. */
function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Replace the input document and restate every manifest field that describes it. */
async function replaceInput(directory: string, text: string): Promise<void> {
  await overwrite(directory, EVIDENCE_CASE_INPUT_FILE, text);
  const byteLength = new TextEncoder().encode(text).byteLength;
  await restate(directory, (manifest) => ({
    ...manifest,
    caseInputHash: sha256(text),
    members: (manifest.members as Record<string, unknown>[]).map((member) =>
      member.logicalFilename === EVIDENCE_CASE_INPUT_FILE
        ? { ...member, byteLength, sha256: sha256(text) }
        : member,
    ),
  }));
}

describe('a case is the evaluation input, and a replay from it derives the same artifact', () => {
  it('reproduces the snapshot ID, receipt ID and root evaluation hash from disk alone', async () => {
    const input = reconciledEvidenceInput();
    const original = evaluateReconciledCsvEvidence(input);
    const directory = await writeCase(input);

    const read = await readEvidenceCaseAtPath(directory);
    const replayed = evaluateReconciledCsvEvidence(read.input);

    expect(replayed.frozenReport.snapshotId).toBe(original.frozenReport.snapshotId);
    expect(replayed.receipt.receiptId).toBe(original.receipt.receiptId);
    expect(replayed.evaluationHash).toBe(original.evaluationHash);
    expect(read.schemaVersion).toBe('evidence-case-read/v1');
    expect(read.caseId).toBe(`rpc1-${read.caseHash}`);
  });

  it('returns a frozen input that shares no object with the one the case was written from', async () => {
    const input = reconciledEvidenceInput();
    const directory = await writeCase(input);
    const read = await readEvidenceCaseAtPath(directory);

    expect(read.input).not.toBe(input);
    expect(Object.isFrozen(read.input)).toBe(true);
    expect(Object.isFrozen(read.input.series)).toBe(true);
    const contract = read.input.contracts[0];
    expect(contract).toBeDefined();
    expect(Object.isFrozen(contract)).toBe(true);
    // Source bytes are deliberately not frozen: `Object.freeze` throws on a typed array with
    // elements, so a naive deep freeze could not return an input at all.
    expect(read.input.series[0]?.sourceObjects[0]).toBeInstanceOf(Uint8Array);
  });

  it('writes byte-identical bytes for an input whose arrays arrive in a different order', async () => {
    const first = testSeriesParts({ contractId: 'contract-a' });
    const second = testSeriesParts({ contractId: 'contract-b' });
    const forward = await writeEvidenceCaseAtomically(
      await newParent(),
      reconciledEvidenceInput([first, second]),
    );
    const reversed = await writeEvidenceCaseAtomically(
      await newParent(),
      reconciledEvidenceInput([second, first]),
    );

    expect(reversed.caseId).toBe(forward.caseId);
    expect(canonicalJson(reversed.members)).toBe(canonicalJson(forward.members));
  });

  it('round-trips a series that has no source objects at all', async () => {
    const parts = testSeriesParts({ sourceObjects: [] });
    const input = reconciledEvidenceInput([parts]);
    const directory = await writeCase(input);
    const read = await readEvidenceCaseAtPath(directory);

    expect(read.members).toHaveLength(1);
    expect(read.members[0]?.logicalFilename).toBe(EVIDENCE_CASE_INPUT_FILE);
    await expect(readdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY))).rejects.toThrow();
    expect(evaluateReconciledCsvEvidence(read.input).evaluationHash).toBe(
      evaluateReconciledCsvEvidence(input).evaluationHash,
    );
  });

  it('round-trips a lifecycle timeline as well as a resolved lifecycle state', async () => {
    const input = reconciledEvidenceInput([testSeriesParts()], {
      lifecycleState: undefined,
      lifecycleTimeline: {
        schemaVersion: 'lifecycle-timeline/v1',
        version: 'timeline-v1',
        tenantId: 'tenant-1',
        systemId: 'system-1',
        periods: [
          {
            lifecycleEventId: 'lifecycle-event-in-service',
            state: 'in_service',
            effectiveRange: {
              start: '2026-01-01T00:00:00.000Z',
              end: '2026-01-01T01:00:00.000Z',
            },
            evidenceId: 'lifecycle-evidence-in-service',
            recordedAt: '2025-12-01T00:00:00.000Z',
          },
        ],
      },
    });
    // `reconciledEvidenceInput` spreads overrides, so the resolved-state key has to go.
    const timelineInput = { ...input } as Record<string, unknown>;
    delete timelineInput.lifecycleState;
    const cast = timelineInput as unknown as ReconciledCsvEvidenceInput;

    const directory = await writeCase(cast);
    const read = await readEvidenceCaseAtPath(directory);

    expect(evaluateReconciledCsvEvidence(read.input).evaluationHash).toBe(
      evaluateReconciledCsvEvidence(cast).evaluationHash,
    );
  });
});

describe('multiplicity survives content addressing', () => {
  it('reproduces the operational hash for two byte-identical submissions, from one stored file', async () => {
    const parts = testSeriesParts({ sourceObjects: [defaultCsvBytes(), defaultCsvBytes()] });
    const input = reconciledEvidenceInput([parts]);
    const original = evaluateReconciledCsvEvidence(input);
    const directory = await writeCase(input);

    // One file on disk, because the two submissions are the same bytes...
    const stored = await readdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY));
    expect(stored).toHaveLength(1);

    const read = await readEvidenceCaseAtPath(directory);
    // ...and two references in the input, because ADR-0009 rule 6 makes delivery multiplicity
    // input-specific. A case that deduplicated references would replay a different operational
    // hash while every digest still matched.
    expect(read.input.series[0]?.sourceObjects).toHaveLength(2);

    const replayed = evaluateReconciledCsvEvidence(read.input);
    expect(replayed.series[0]?.reconciliation.operationalHash).toBe(
      original.series[0]?.reconciliation.operationalHash,
    );
    expect(replayed.series[0]?.evidenceSetHash).toBe(original.series[0]?.evidenceSetHash);
    expect(replayed.evaluationHash).toBe(original.evaluationHash);
  });

  it('gives each reference its own copy, so mutating one submission cannot change the other', async () => {
    const parts = testSeriesParts({ sourceObjects: [defaultCsvBytes(), defaultCsvBytes()] });
    const directory = await writeCase(reconciledEvidenceInput([parts]));
    const read = await readEvidenceCaseAtPath(directory);
    const [left, right] = read.input.series[0]?.sourceObjects ?? [];

    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left).not.toBe(right);
  });

  it('stores two distinct submissions as two files', async () => {
    const parts = testSeriesParts({
      sourceObjects: [
        csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit'),
        csvBytes('b,2026-01-01T00:35:00.000Z,4,source-unit'),
      ],
    });
    const directory = await writeCase(reconciledEvidenceInput([parts]));

    expect(await readdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY))).toHaveLength(2);
  });
});

describe('a damaged case is refused, never partially read', () => {
  it('names both digests when one byte of one source file is flipped', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const name = await firstSourceName(directory);
    const path = join(EVIDENCE_CASE_SOURCE_DIRECTORY, name);
    const bytes = new Uint8Array(await readFile(join(directory, path)));
    const flipped = new Uint8Array(bytes);
    // A single bit, in the value column: the kind of change that would otherwise produce a
    // different aggregate and a wholly self-consistent bundle to go with it.
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
    await overwrite(directory, path, flipped);

    const refusal = await expectRefusal(directory, 'case_member_digest_mismatch');
    // Both digests, named: the point of the refusal is that a reader can see which member moved
    // and by how much, rather than being handed a different snapshot ID and left to wonder.
    expect(refusal.message).toContain(name);
    expect(refusal.message).toContain(`expected sha256 ${name}`);
    expect(refusal.message).toContain(`actual sha256 ${digestOf(flipped)}`);
  });

  it('refuses a source file whose length no longer matches the manifest', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const path = join(EVIDENCE_CASE_SOURCE_DIRECTORY, await firstSourceName(directory));
    await overwrite(directory, path, new Uint8Array([0x61]));

    const refusal = await expectRefusal(directory, 'case_member_digest_mismatch');
    expect(refusal.message).toContain('1 bytes');
  });

  it('refuses a case whose input document is missing, naming it', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rm(join(directory, EVIDENCE_CASE_INPUT_FILE));

    const refusal = await expectRefusal(directory, 'case_file_missing');
    expect(refusal.message).toContain(EVIDENCE_CASE_INPUT_FILE);
  });

  it('refuses a case whose manifest is missing', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rm(join(directory, EVIDENCE_CASE_MANIFEST_FILE));

    const refusal = await expectRefusal(directory, 'case_file_missing');
    expect(refusal.message).toContain(EVIDENCE_CASE_MANIFEST_FILE);
  });

  it('refuses a case whose source file the manifest lists and disk does not hold', async () => {
    // Two distinct submissions, so removing one leaves `sources` populated: this test is about a
    // *listed* member being absent, not about an empty source directory.
    const parts = testSeriesParts({
      sourceObjects: [
        csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit'),
        csvBytes('b,2026-01-01T00:35:00.000Z,4,source-unit'),
      ],
    });
    const directory = await writeCase(reconciledEvidenceInput([parts]));
    const name = await firstSourceName(directory);
    await rm(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY, name));

    const refusal = await expectRefusal(directory, 'case_file_missing');
    expect(refusal.message).toContain(name);
  });

  it('refuses an entry the manifest does not list, naming it', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await writeFile(join(directory, 'notes.txt'), 'left behind by a well-meaning operator');

    const refusal = await expectRefusal(directory, 'unexpected_case_entry');
    expect(refusal.message).toContain('notes.txt');
  });

  it('refuses a stray file under sources that no member names', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await writeFile(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY, 'extra'), 'x');

    const refusal = await expectRefusal(directory, 'unexpected_case_entry');
    expect(refusal.message).toContain('extra');
  });

  it('refuses a case directory that is not a directory', async () => {
    const parent = await newParent();
    const path = join(parent, 'not-a-case');
    await writeFile(path, 'x');

    await expectRefusal(path, 'case_path_not_a_directory');
  });

  it('refuses a case path that does not exist', async () => {
    const parent = await newParent();
    await expectRefusal(join(parent, 'absent'), 'case_directory_unreadable');
  });

  it('refuses a symbolic link standing in for the case directory', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const parent = await newParent();
    const link = join(parent, 'link-to-case');
    await symlink(directory, link);

    await expectRefusal(link, 'case_path_not_a_directory');
  });

  it('refuses a non-regular entry inside a case', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await mkdir(join(directory, 'nested'));

    await expectRefusal(directory, 'case_entry_not_a_regular_file');
  });

  it('refuses a sources path that is a file rather than a directory', async () => {
    const parts = testSeriesParts({ sourceObjects: [] });
    const directory = await writeCase(reconciledEvidenceInput([parts]));
    await writeFile(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY), 'x');

    const refusal = await expectRefusal(directory, 'case_entry_not_a_regular_file');
    expect(refusal.message).toContain(EVIDENCE_CASE_SOURCE_DIRECTORY);
  });

  it('refuses an empty sources directory rather than reading it as no sources', async () => {
    const parts = testSeriesParts({ sourceObjects: [] });
    const directory = await writeCase(reconciledEvidenceInput([parts]));
    await mkdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY));

    const refusal = await expectRefusal(directory, 'unexpected_case_entry');
    expect(refusal.message).toContain('holds no source object');
  });

  it('refuses a non-regular entry inside sources', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await mkdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY, 'nested'));

    await expectRefusal(directory, 'case_entry_not_a_regular_file');
  });

  it('refuses a manifest that is not valid UTF-8', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await overwrite(directory, EVIDENCE_CASE_MANIFEST_FILE, new Uint8Array([0xff, 0xfe]));

    await expectRefusal(directory, 'invalid_utf8');
  });

  it('refuses an input document that is not valid UTF-8, over its declared digest', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const invalid = new Uint8Array([0xff, 0xfe]);
    await overwrite(directory, EVIDENCE_CASE_INPUT_FILE, invalid);
    await restate(directory, (manifest) => ({
      ...manifest,
      caseInputHash: digestOf(invalid),
      members: (manifest.members as Record<string, unknown>[]).map((member) =>
        member.logicalFilename === EVIDENCE_CASE_INPUT_FILE
          ? { ...member, byteLength: invalid.byteLength, sha256: digestOf(invalid) }
          : member,
      ),
    }));

    await expectRefusal(directory, 'invalid_utf8');
  });
});

describe('the manifest is the root of the chain, and its own shape is checked', () => {
  it('refuses a manifest that is not in canonical form', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const manifest = await readControl(directory, EVIDENCE_CASE_MANIFEST_FILE);
    await overwrite(directory, EVIDENCE_CASE_MANIFEST_FILE, JSON.stringify(manifest, null, 2));

    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('refuses a manifest carrying a field this release does not emit', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({ ...manifest, note: 'rode along' }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('note');
  });

  it('refuses a manifest missing one of its pinned fields', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => {
      const { limitations: _limitations, ...rest } = manifest;
      return rest;
    });

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('limitations');
  });

  it('names both versions when the case schema is one this release does not read', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    // Deliberately not "the next version number": a planted value that could one day become the
    // real one turns this test into a tautology the day the format moves, and it goes green for
    // the wrong reason with nothing to notice. UNRELEASED_MANIFEST_SCHEMA is a string no release
    // can carry, and the assertion below pins that it is not the real one.
    expect(UNRELEASED_MANIFEST_SCHEMA).not.toBe(EVIDENCE_CASE_SCHEMA_VERSION);
    await restate(directory, (manifest) => ({
      ...manifest,
      schemaVersion: UNRELEASED_MANIFEST_SCHEMA,
    }));

    const refusal = await expectRefusal(directory, 'case_schema_version_unsupported');
    expect(refusal.message).toContain(UNRELEASED_MANIFEST_SCHEMA);
    expect(refusal.message).toContain(EVIDENCE_CASE_SCHEMA_VERSION);
  });

  it('names both versions when the input document declares another schema', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const input = await readControl(directory, EVIDENCE_CASE_INPUT_FILE);
    // Was `evidence-case-input/v2`, which the plausibility policy made the *real* version: the
    // planted "other schema" became the one under test and this refusal stopped happening. Same
    // trap as above, caught by that failure.
    expect(UNRELEASED_INPUT_SCHEMA).not.toBe(EVIDENCE_CASE_INPUT_SCHEMA_VERSION);
    await replaceInput(
      directory,
      canonicalJson({ ...input, schemaVersion: UNRELEASED_INPUT_SCHEMA }),
    );

    const refusal = await expectRefusal(directory, 'case_schema_version_unsupported');
    expect(refusal.message).toContain(UNRELEASED_INPUT_SCHEMA);
    expect(refusal.message).toContain(EVIDENCE_CASE_INPUT_SCHEMA_VERSION);
  });

  it('refuses a reordered member list rather than passing on set equality', async () => {
    const parts = testSeriesParts({
      sourceObjects: [
        csvBytes('a,2026-01-01T00:05:00.000Z,2,source-unit'),
        csvBytes('b,2026-01-01T00:35:00.000Z,4,source-unit'),
      ],
    });
    const directory = await writeCase(reconciledEvidenceInput([parts]));
    await restate(directory, (manifest) => ({
      ...manifest,
      members: [...(manifest.members as unknown[])].reverse(),
    }));

    await expectRefusal(directory, 'case_manifest_order_invalid');
  });

  it('refuses a member entry that is not a strict manifest entry', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) => ({
        ...member,
        mediaType: 'text/csv',
      })),
    }));

    await expectRefusal(directory, 'case_manifest_shape_invalid');
  });

  it('refuses a member whose name is outside the case namespace', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) =>
        member.logicalFilename === EVIDENCE_CASE_INPUT_FILE
          ? { ...member, logicalFilename: '../case-input.json' }
          : member,
      ),
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('case member name');
  });

  it('refuses a source member stored under a name that is not its digest', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) =>
        member.logicalFilename === EVIDENCE_CASE_INPUT_FILE
          ? member
          : { ...member, logicalFilename: `${EVIDENCE_CASE_SOURCE_DIRECTORY}/renamed` },
      ),
    }));

    await expectRefusal(directory, 'case_manifest_shape_invalid');
  });

  it('refuses an empty member list', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({ ...manifest, members: [] }));

    await expectRefusal(directory, 'case_manifest_shape_invalid');
  });

  it('refuses a member digest that is not a lowercase SHA-256', async () => {
    // Three shapes, because one is not enough to hold the pattern to its length. A fixture of
    // only `NOT-A-DIGEST` is refused by the character class alone, so a digest pattern that had
    // quietly stopped requiring 64 characters would still look enforced.
    for (const sha256 of ['NOT-A-DIGEST', 'a'.repeat(63), 'A'.repeat(64)]) {
      const directory = await writeCase(reconciledEvidenceInput());
      await restate(directory, (manifest) => ({
        ...manifest,
        members: (manifest.members as Record<string, unknown>[]).map((member) => ({
          ...member,
          sha256,
        })),
      }));

      // The message, not only the reason. A source member's name must equal its digest, so a
      // bad digest is *also* refused as a bad member name, under the same reason code -- and
      // measured: with the pattern weakened to accept fewer than 64 characters, this test
      // stayed green on the reason alone. Asserting the message is what holds the pattern.
      const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
      expect(refusal.message).toContain('must be a lowercase SHA-256 digest');
    }
  });

  it('refuses a member byte length that is not a non-negative safe integer', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) => ({
        ...member,
        byteLength: -1,
      })),
    }));

    await expectRefusal(directory, 'case_manifest_shape_invalid');
  });

  it('refuses a manifest whose caseInputHash does not name the input member beside it', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      caseInputHash: sha256('something else entirely'),
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('caseInputHash');
  });

  it('refuses a manifest that lists only source objects and no input document', async () => {
    // A case whose whole governance graph is missing must be refused as a manifest that does not
    // describe an input, not read as an input with nothing in it.
    const directory = await writeCase(reconciledEvidenceInput());
    await rm(join(directory, EVIDENCE_CASE_INPUT_FILE));
    const source = await firstSourceName(directory);
    const bytes = new Uint8Array(
      await readFile(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY, source)),
    );
    await restate(directory, (manifest) => ({
      ...manifest,
      caseInputHash: digestOf(bytes),
      members: [
        {
          logicalFilename: `${EVIDENCE_CASE_SOURCE_DIRECTORY}/${source}`,
          byteLength: bytes.byteLength,
          sha256: digestOf(bytes),
        },
      ],
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain(EVIDENCE_CASE_INPUT_FILE);
  });

  it('pins the manifest field list this release emits', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const manifest = await readControl(directory, EVIDENCE_CASE_MANIFEST_FILE);

    expect(Object.keys(manifest).sort()).toEqual([...EVIDENCE_CASE_MANIFEST_FIELDS].sort());
  });
});

describe('the input document is checked before any of it is believed', () => {
  async function rewriteInput(
    directory: string,
    transform: (input: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const input = await readControl(directory, EVIDENCE_CASE_INPUT_FILE);
    await replaceInput(directory, canonicalJson(transform(input)));
  }

  it('refuses an input document missing a required governance member, naming it', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => {
      const { contracts: _contracts, ...rest } = input;
      return rest;
    });

    const refusal = await expectRefusal(directory, 'case_input_shape_invalid');
    expect(refusal.message).toContain('contracts');
  });

  it('refuses a series missing one of its governance members, naming it', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => {
        const { mapping: _mapping, ...rest } = series;
        return rest;
      }),
    }));

    const refusal = await expectRefusal(directory, 'case_input_shape_invalid');
    expect(refusal.message).toContain('mapping');
  });

  it('refuses an input document that declares neither a lifecycle state nor a timeline', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => {
      const { lifecycleState: _state, ...rest } = input;
      return rest;
    });

    const refusal = await expectRefusal(directory, 'case_input_shape_invalid');
    expect(refusal.message).toContain('lifecycle');
  });

  it('refuses an unsupported lifecycle state', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({ ...input, lifecycleState: 'imaginary' }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a governance object the domain constructors reject', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        aggregatePolicy: {
          ...(series.aggregatePolicy as Record<string, unknown>),
          method: 'guess',
        },
      })),
    }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a contract the domain constructors reject', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      contracts: (input.contracts as Record<string, unknown>[]).map((contract) => ({
        ...contract,
        cadenceMinutes: 0,
      })),
    }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a series entry that is not a record', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({ ...input, series: ['not a series'] }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses an empty series list', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({ ...input, series: [] }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a series list that is not an array', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({ ...input, series: { count: 1 } }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a source reference that is not a strict reference record', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        sourceObjects: (series.sourceObjects as Record<string, unknown>[]).map((reference) => ({
          ...reference,
          note: 'rode along',
        })),
      })),
    }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a source reference list that is not an array', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        sourceObjects: { count: 0 },
      })),
    }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a source reference digest that is not a lowercase SHA-256', async () => {
    for (const sha256 of ['NOT-A-DIGEST', 'a'.repeat(63), 'A'.repeat(64)]) {
      const directory = await writeCase(reconciledEvidenceInput());
      await rewriteInput(directory, (input) => ({
        ...input,
        series: (input.series as Record<string, unknown>[]).map((series) => ({
          ...series,
          sourceObjects: (series.sourceObjects as Record<string, unknown>[]).map((reference) => ({
            ...reference,
            sha256,
          })),
        })),
      }));

      await expectRefusal(directory, 'case_input_shape_invalid');
    }
  });

  it('refuses a source reference byte length that is not a non-negative safe integer', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        sourceObjects: (series.sourceObjects as Record<string, unknown>[]).map((reference) => ({
          ...reference,
          byteLength: 1.5,
        })),
      })),
    }));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });

  it('refuses a source reference the manifest does not list, naming the digest', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const absent = sha256('a source object this case does not hold');
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        sourceObjects: (series.sourceObjects as Record<string, unknown>[]).map((reference) => ({
          ...reference,
          sha256: absent,
        })),
      })),
    }));

    const refusal = await expectRefusal(directory, 'case_source_reference_unknown');
    expect(refusal.message).toContain(absent);
  });

  it('refuses a reference whose declared byte length disagrees with the stored source', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await rewriteInput(directory, (input) => ({
      ...input,
      series: (input.series as Record<string, unknown>[]).map((series) => ({
        ...series,
        sourceObjects: (series.sourceObjects as Record<string, unknown>[]).map((reference) => ({
          ...reference,
          byteLength: 1,
        })),
      })),
    }));

    const refusal = await expectRefusal(directory, 'case_input_shape_invalid');
    expect(refusal.message).toContain('bytes');
  });

  it('refuses an input document that is not in canonical form', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const input = await readControl(directory, EVIDENCE_CASE_INPUT_FILE);
    await replaceInput(directory, JSON.stringify(input, null, 2));

    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('refuses an input document that is a JSON array rather than an object', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await replaceInput(directory, canonicalJson([]));

    await expectRefusal(directory, 'case_input_shape_invalid');
  });
});

describe('the writer refuses inputs it could not faithfully serialize', () => {
  it('refuses an input with no series', async () => {
    const parent = await newParent();
    const input = {
      ...reconciledEvidenceInput(),
      series: [],
    } as unknown as ReconciledCsvEvidenceInput;

    await expect(writeEvidenceCaseAtomically(parent, input)).rejects.toThrow(RangeError);
  });

  it('refuses an output parent that is not a real directory', async () => {
    const parent = await newParent();
    const path = join(parent, 'file');
    await writeFile(path, 'x');

    await expect(writeEvidenceCaseAtomically(path, reconciledEvidenceInput())).rejects.toThrow(
      TypeError,
    );
  });

  it('refuses a source object that is not a Uint8Array', async () => {
    const parent = await newParent();
    const parts = testSeriesParts();
    const input = reconciledEvidenceInput([
      {
        ...parts,
        series: {
          ...parts.series,
          sourceObjects: ['not bytes'] as unknown as readonly Uint8Array[],
        },
      },
    ]);

    await expect(writeEvidenceCaseAtomically(parent, input)).rejects.toThrow(TypeError);
  });

  it('refuses more source objects than an evaluation accepts', async () => {
    const parent = await newParent();
    const sourceObjects = Array.from({ length: 65 }, (_unused, index) =>
      csvBytes(`row-${index.toString()},2026-01-01T00:05:00.000Z,2,source-unit`),
    );
    const input = reconciledEvidenceInput([testSeriesParts({ sourceObjects })]);

    await expect(writeEvidenceCaseAtomically(parent, input)).rejects.toThrow(RangeError);
  });
});

describe('ordering is the case format own, and it is total', () => {
  it('orders two contracts that share an ID by version, whichever order they arrive in', async () => {
    // Contract IDs are unique in any input the evaluator will accept, so the version tiebreaker
    // exists for inputs it will not: the writer does not enforce uniqueness, and a case whose
    // bytes depended on the caller's incidental array order would give one input two case IDs.
    const first = testSeriesParts({ contractId: 'contract-1', contractVersion: '1' });
    const second = testSeriesParts({ contractId: 'contract-1', contractVersion: '2' });

    const forward = await writeEvidenceCaseAtomically(
      await newParent(),
      reconciledEvidenceInput([first, second]),
    );
    const reversed = await writeEvidenceCaseAtomically(
      await newParent(),
      reconciledEvidenceInput([second, first]),
    );

    expect(reversed.caseId).toBe(forward.caseId);
  });

  it('orders two conversion rules that share an ID by version', async () => {
    const rules = (version: string): Record<string, unknown> => ({
      schemaVersion: 'unit-conversion-rule/v1',
      ruleId: 'conversion-contract-1',
      version,
      parameterCode: 'flow.treated.daily_avg',
      sourceUnit: 'source-unit',
      canonicalUnit: 'canonical-unit',
      sourceOffset: '0',
      multiplierNumerator: '1',
      multiplierDenominator: '2',
      effectiveRange: { start: '2025-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
      authorizationId: 'unit-dictionary-contract-1',
    });
    const withRules = (order: readonly string[]): ReconciledCsvEvidenceInput => {
      const parts = testSeriesParts();
      return reconciledEvidenceInput([
        {
          ...parts,
          series: {
            ...parts.series,
            conversionRules: order.map(
              rules,
            ) as unknown as (typeof parts.series)['conversionRules'],
          },
        },
      ]);
    };

    const forward = await writeEvidenceCaseAtomically(await newParent(), withRules(['1', '2']));
    const reversed = await writeEvidenceCaseAtomically(await newParent(), withRules(['2', '1']));

    expect(reversed.caseId).toBe(forward.caseId);
  });

  it('refuses to write a series whose governing contract is not named', async () => {
    const parent = await newParent();
    const parts = testSeriesParts();
    const input = reconciledEvidenceInput([
      { ...parts, series: { ...parts.series, requiredSeriesContractId: '   ' } },
    ]);

    await expect(writeEvidenceCaseAtomically(parent, input)).rejects.toThrow(TypeError);
  });
});

describe('a case that cannot be read is refused before anything in it is believed', () => {
  it('refuses a manifest that is not JSON at all', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await overwrite(directory, EVIDENCE_CASE_MANIFEST_FILE, 'not json, just words');

    await expectRefusal(directory, 'case_manifest_shape_invalid');
  });

  it('refuses a manifest that parses and cannot be canonicalized', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    // An escaped lone surrogate: valid UTF-8 on disk, valid JSON, and not canonicalizable. It
    // must refuse rather than be normalized into something with a different hash.
    await overwrite(directory, EVIDENCE_CASE_MANIFEST_FILE, '{"claim":"\\ud800"}');

    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('refuses a manifest listing more members than an evaluation could hold', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: Array.from({ length: 66 }, (_unused, index) => ({
        logicalFilename: `${EVIDENCE_CASE_SOURCE_DIRECTORY}/${index.toString().padStart(64, '0')}`,
        byteLength: 1,
        sha256: index.toString().padStart(64, '0'),
      })),
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('member limit');
  });

  it('refuses a member whose logical filename is not a string', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) => ({
        ...member,
        logicalFilename: 5,
      })),
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('must be a string');
  });

  it('refuses a member listed twice', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => {
      const members = manifest.members as Record<string, unknown>[];
      const input = members.find((member) => member.logicalFilename === EVIDENCE_CASE_INPUT_FILE);
      if (input === undefined) {
        throw new Error('the case under test lists no input document');
      }
      return { ...manifest, members: [input, input] };
    });

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('duplicated');
  });

  it('refuses a manifest declaring more source bytes than an evaluation accepts', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await restate(directory, (manifest) => ({
      ...manifest,
      members: (manifest.members as Record<string, unknown>[]).map((member) =>
        member.logicalFilename === EVIDENCE_CASE_INPUT_FILE
          ? member
          : { ...member, byteLength: 70_000_000 },
      ),
    }));

    const refusal = await expectRefusal(directory, 'case_manifest_shape_invalid');
    expect(refusal.message).toContain('more source bytes');
  });

  it('refuses a source object that cannot be read', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const path = join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY, await firstSourceName(directory));
    await chmod(path, 0o000);
    try {
      await expectRefusal(directory, 'case_file_unreadable');
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('refuses a manifest that cannot be read', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const path = join(directory, EVIDENCE_CASE_MANIFEST_FILE);
    await chmod(path, 0o000);
    try {
      await expectRefusal(directory, 'case_file_unreadable');
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('refuses a case directory that cannot be listed', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    await chmod(directory, 0o000);
    try {
      await expectRefusal(directory, 'case_directory_unreadable');
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('refuses a sources directory that cannot be listed', async () => {
    const directory = await writeCase(reconciledEvidenceInput());
    const path = join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY);
    await chmod(path, 0o000);
    try {
      const refusal = await expectRefusal(directory, 'case_directory_unreadable');
      expect(refusal.message).toContain(EVIDENCE_CASE_SOURCE_DIRECTORY);
    } finally {
      await chmod(path, 0o700);
    }
  });
});

describe('scheduled nonoperations survive the round trip in a stated order', () => {
  it('orders two nonoperations by ID and replays to the same evaluation', async () => {
    const nonoperations = [
      nonoperationInput({
        nonoperationId: 'stop-2',
        range: { start: '2026-01-01T00:45:00.000Z', end: '2026-01-01T01:00:00.000Z' },
      }),
      nonoperationInput({
        nonoperationId: 'stop-1',
        range: { start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T00:30:00.000Z' },
      }),
    ];
    const input = reconciledEvidenceInput([testSeriesParts()], {
      scheduledNonoperations: nonoperations,
    });
    const reversed = reconciledEvidenceInput([testSeriesParts()], {
      scheduledNonoperations: [...nonoperations].reverse(),
    });

    const forward = await writeEvidenceCaseAtomically(await newParent(), input);
    const backward = await writeEvidenceCaseAtomically(await newParent(), reversed);
    const read = await readEvidenceCaseAtPath(forward.caseDirectory);

    expect(backward.caseId).toBe(forward.caseId);
    expect(read.input.scheduledNonoperations).toHaveLength(2);
    expect(evaluateReconciledCsvEvidence(read.input).evaluationHash).toBe(
      evaluateReconciledCsvEvidence(input).evaluationHash,
    );
  });
});
