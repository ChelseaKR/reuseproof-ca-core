/**
 * The artifact test-vector corpus: what this library's bytes were, on the day a version was cut.
 *
 * Every identifier this package issues is a hash of bytes it renders -- the snapshot ID, the
 * receipt ID, the case ID, each render-manifest digest. `bin/reuseproof-verify.js` requires
 * `--expect-snapshot` precisely because those identifiers are meant to be recorded elsewhere,
 * independently, when a bundle is issued. Nothing in the repository stated what became of a
 * recorded identifier when the library changed: a whitespace change in `report-render.ts`, one
 * added field in the report projection, or a different canonical ordering moves the bytes and
 * therefore every identifier derived from them, and the only way to learn that was to notice.
 *
 * A vector is a frozen input plus the exact bytes the evaluation emitted for it. The check below
 * re-derives those bytes from the vector's own input -- never from `fixtures/`, because a vector
 * whose input is the file under maintenance moves whenever that file does, and would then agree
 * with the library about a change neither of them was supposed to make.
 *
 * Two states, and the difference between them is the whole point.
 *
 * A vector is **live** when the artifact-schema version set the library emits for its input is
 * the set the vector recorded. A live vector must reproduce byte for byte; anything else is a
 * failure naming the artifact and both digests.
 *
 * A vector is **superseded** when that set has moved. A superseded vector cannot be re-derived
 * at all -- this library no longer renders that generation -- so it is held to what remains
 * checkable: its stored bytes still hash to its recorded digests, and its recorded identifiers
 * are still the ones those bytes yield. That is a weaker claim, and ADR-0015 says in terms what
 * it does and does not mean for an identifier a jurisdiction wrote down.
 *
 * The corpus fails closed. No vectors, a vector with no files, or a run in which no vector was
 * live are each an error, not an empty pass: a check that examined nothing must never print the
 * same line as one that examined everything and found it unchanged (ADR-0011).
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';

import {
  canonicalJson,
  compareCodeUnits,
  evaluateReconciledCsvEvidence,
  parseBoundedJson,
  writeEvidenceCaseAtomically,
  writeFrozenReportBundleAtomically,
} from '../src/index.js';
import { requireStrictArray, requireStrictRecord } from '../src/domain/validation.js';
import { reconciledFixtureInput } from './demo-fixture.js';

/** The manifest schema of one vector directory. Bump with the directory layout, never silently. */
export const VECTOR_MANIFEST_SCHEMA_VERSION = 'artifact-test-vector/v1';

/** The corpus root, relative to the repository root. */
export const VECTORS_DIRECTORY = 'vectors';

/** The frozen input a vector re-derives from. */
export const VECTOR_INPUT_FILENAME = 'input.json';

/** The recorded expectations for one vector. */
export const VECTOR_MANIFEST_FILENAME = 'manifest.json';

/** Files inside a vector directory that are not themselves recorded artifacts. */
const VECTOR_CONTROL_FILES: ReadonlySet<string> = new Set([
  VECTOR_INPUT_FILENAME,
  VECTOR_MANIFEST_FILENAME,
]);

/** One recorded file: its path inside the vector, and the bytes it must still be. */
export interface VectorFileRecord {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** The identifiers a holder of this vector's bundle would have recorded. */
export interface VectorIdentities {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly receiptId: string;
  readonly receiptCoreHash: string;
  readonly reportContentHash: string;
  readonly evaluationHash: string;
  readonly caseId: string;
  readonly caseHash: string;
}

/** Everything one vector directory records. */
export interface VectorManifest {
  readonly schemaVersion: typeof VECTOR_MANIFEST_SCHEMA_VERSION;
  readonly vectorId: string;
  readonly recordedOn: string;
  readonly artifactSchemaVersions: readonly string[];
  readonly renderManifestOrder: readonly string[];
  readonly identities: VectorIdentities;
  readonly files: readonly VectorFileRecord[];
}

/** What the library emits today for one input. */
export interface DerivedVector {
  readonly artifactSchemaVersions: readonly string[];
  readonly renderManifestOrder: readonly string[];
  readonly identities: VectorIdentities;
  readonly files: readonly VectorFileRecord[];
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

/** One vector's verdict. `live` vectors were re-derived; `superseded` ones could not be. */
export interface VectorOutcome {
  readonly vectorId: string;
  readonly state: 'live' | 'superseded';
  readonly recordedFileCount: number;
  readonly supersededReason: string | null;
}

/** What a whole corpus run examined, so a green line states its own coverage. */
export interface VectorCorpusReport {
  readonly outcomes: readonly VectorOutcome[];
  readonly liveVectorId: string;
  readonly checkedFileCount: number;
}

/** A refused corpus check. Never a result type: an unfinished check must not read as a pass. */
export class VectorCorpusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VectorCorpusError';
  }
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toPosixPath(value: string): string {
  return value.split(sep).join(posix.sep);
}

async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(join(root, entry.name), child)));
    } else {
      found.push(child);
    }
  }
  return found.sort(compareCodeUnits);
}

/**
 * Every `schemaVersion` string anywhere in the emitted JSON artifacts, sorted and deduplicated.
 *
 * The set is the version dimension of the whole published artifact graph, not of one file: a
 * receipt core that grows a `v3`, a nested contract that grows a `v2`, and a new projection
 * version all move it. That is what makes "the bytes moved and no version did" a distinguishable
 * failure from "a version was bumped and no vector covers it".
 */
export function collectSchemaVersions(documents: readonly unknown[]): readonly string[] {
  const versions = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) {
        walk(item);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'schemaVersion' && typeof child === 'string') {
        versions.add(child);
      }
      walk(child);
    }
  };
  for (const document of documents) {
    walk(document);
  }
  return [...versions].sort(compareCodeUnits);
}

/** Re-derive every artifact one frozen input produces, with the identifiers it would issue. */
export async function deriveVector(inputText: string): Promise<DerivedVector> {
  const input = reconciledFixtureInput(parseBoundedJson(inputText));
  const submittedSources = input.series.reduce(
    (total, series) => total + series.sourceObjects.length,
    0,
  );
  if (submittedSources === 0) {
    throw new VectorCorpusError(
      'the vector input submits no source object, so its artifacts would attest nothing. Fix the ' +
        'input rather than letting this check compare an empty evaluation with itself.',
    );
  }
  const result = evaluateReconciledCsvEvidence(input);
  const container = await mkdtemp(join(tmpdir(), 'reuseproof-vector-'));
  try {
    const bundle = await writeFrozenReportBundleAtomically(container, result.frozenReport);
    const evidenceCase = await writeEvidenceCaseAtomically(container, input);

    const bytes = new Map<string, Uint8Array>();
    for (const filename of bundle.filenames) {
      bytes.set(
        posix.join('artifacts', filename),
        await readFile(join(bundle.bundleDirectory, filename)),
      );
    }
    for (const member of evidenceCase.members) {
      bytes.set(
        posix.join('case', member.logicalFilename),
        await readFile(join(evidenceCase.caseDirectory, member.logicalFilename)),
      );
    }
    bytes.set(
      posix.join('case', 'evidence-case.json'),
      await readFile(join(evidenceCase.caseDirectory, 'evidence-case.json')),
    );

    const jsonDocuments: unknown[] = [];
    for (const [path, content] of bytes) {
      if (path.endsWith('.json')) {
        jsonDocuments.push(JSON.parse(Buffer.from(content).toString('utf8')) as unknown);
      }
    }

    const files = [...bytes]
      .map(([path, content]) => ({
        path,
        byteLength: content.byteLength,
        sha256: digestOf(content),
      }))
      .sort((left, right) => compareCodeUnits(left.path, right.path));

    return {
      artifactSchemaVersions: collectSchemaVersions(jsonDocuments),
      renderManifestOrder: result.frozenReport.core.renderManifest.map(
        ({ logicalFilename }) => logicalFilename,
      ),
      identities: {
        snapshotId: result.frozenReport.snapshotId,
        snapshotHash: result.frozenReport.snapshotHash,
        receiptId: result.receipt.receiptId,
        receiptCoreHash: result.receipt.coreHash,
        reportContentHash: result.receipt.reportContentHash,
        evaluationHash: result.evaluationHash,
        caseId: evidenceCase.caseId,
        caseHash: evidenceCase.caseHash,
      },
      files,
      bytes,
    };
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new VectorCorpusError(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VectorCorpusError(`${label} must be non-empty text`);
  }
  return value;
}

function requireTextList(value: unknown, label: string): readonly string[] {
  const values = requireStrictArray(value, label).map((item, index) =>
    requireText(item, `${label}[${index.toString()}]`),
  );
  if (values.length === 0) {
    throw new VectorCorpusError(`${label} cannot be empty`);
  }
  return values;
}

function readIdentities(value: unknown, label: string): VectorIdentities {
  const record = requireStrictRecord(
    value,
    [
      'snapshotId',
      'snapshotHash',
      'receiptId',
      'receiptCoreHash',
      'reportContentHash',
      'evaluationHash',
      'caseId',
      'caseHash',
    ],
    [],
    label,
  );
  return {
    snapshotId: requireText(record.snapshotId, `${label}.snapshotId`),
    snapshotHash: requireDigest(record.snapshotHash, `${label}.snapshotHash`),
    receiptId: requireText(record.receiptId, `${label}.receiptId`),
    receiptCoreHash: requireDigest(record.receiptCoreHash, `${label}.receiptCoreHash`),
    reportContentHash: requireDigest(record.reportContentHash, `${label}.reportContentHash`),
    evaluationHash: requireDigest(record.evaluationHash, `${label}.evaluationHash`),
    caseId: requireText(record.caseId, `${label}.caseId`),
    caseHash: requireDigest(record.caseHash, `${label}.caseHash`),
  };
}

/** Read and shape-check one vector manifest. A malformed manifest is a refusal, not a skip. */
export function readVectorManifest(value: unknown, label: string): VectorManifest {
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'vectorId',
      'recordedOn',
      'artifactSchemaVersions',
      'renderManifestOrder',
      'identities',
      'files',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== VECTOR_MANIFEST_SCHEMA_VERSION) {
    throw new VectorCorpusError(
      `${label}.schemaVersion is ${JSON.stringify(record.schemaVersion)}; this check understands ` +
        `only ${VECTOR_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  const files = requireStrictArray(record.files, `${label}.files`).map((item, index) => {
    const fileLabel = `${label}.files[${index.toString()}]`;
    const file = requireStrictRecord(item, ['path', 'byteLength', 'sha256'], [], fileLabel);
    const byteLength = file.byteLength;
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new VectorCorpusError(`${fileLabel}.byteLength must be a non-negative safe integer`);
    }
    return {
      path: requireText(file.path, `${fileLabel}.path`),
      byteLength,
      sha256: requireDigest(file.sha256, `${fileLabel}.sha256`),
    };
  });
  if (files.length === 0) {
    throw new VectorCorpusError(
      `${label}.files is empty, so this vector records no artifact at all and could never fail`,
    );
  }
  const sorted = [...files].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (canonicalJson(files) !== canonicalJson(sorted)) {
    throw new VectorCorpusError(`${label}.files must be sorted by path`);
  }
  return {
    schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
    vectorId: requireText(record.vectorId, `${label}.vectorId`),
    recordedOn: requireText(record.recordedOn, `${label}.recordedOn`),
    artifactSchemaVersions: requireTextList(
      record.artifactSchemaVersions,
      `${label}.artifactSchemaVersions`,
    ),
    renderManifestOrder: requireTextList(
      record.renderManifestOrder,
      `${label}.renderManifestOrder`,
    ),
    identities: readIdentities(record.identities, `${label}.identities`),
    files,
  };
}

/**
 * An identifier carries the digest of the bytes it was issued over, after a scheme prefix.
 *
 * This is a structural check and deliberately not a re-derivation: re-deriving the prefix here
 * would put a second copy of the library's identifier rule in the checker, and two copies of a
 * rule drift. For a live vector the identifiers are compared against freshly derived ones, which
 * is the real guard; this is what remains available for a superseded vector whose generation
 * this library no longer renders.
 */
function identityCarriesDigest(identity: string, digest: string): boolean {
  return identity.endsWith(`-${digest}`) && identity.length > digest.length + 1;
}

async function checkStoredBytes(
  directory: string,
  manifest: VectorManifest,
  label: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const present = (await filesUnder(directory)).filter((path) => !VECTOR_CONTROL_FILES.has(path));
  const recorded = manifest.files.map(({ path }) => path);
  if (canonicalJson(present) !== canonicalJson(recorded)) {
    throw new VectorCorpusError(
      `${label} holds files its manifest does not record, or records files it does not hold. ` +
        `On disk: ${JSON.stringify(present)}. Recorded: ${JSON.stringify(recorded)}.`,
    );
  }
  const bytes = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    const content = await readFile(join(directory, ...file.path.split(posix.sep)));
    const digest = digestOf(content);
    if (content.byteLength !== file.byteLength || digest !== file.sha256) {
      throw new VectorCorpusError(
        `${label}/${file.path} no longer matches its own manifest: recorded ${file.sha256} ` +
          `(${file.byteLength.toString()} bytes), on disk ${digest} ` +
          `(${content.byteLength.toString()} bytes).`,
      );
    }
    bytes.set(file.path, content);
  }
  return bytes;
}

function checkRecordedIdentities(
  manifest: VectorManifest,
  bytes: ReadonlyMap<string, Uint8Array>,
  label: string,
): void {
  const pairs: readonly (readonly [string, string, string])[] = [
    [
      'artifacts/report-freeze.json',
      manifest.identities.snapshotId,
      manifest.identities.snapshotHash,
    ],
    [
      'artifacts/receipt-core.json',
      manifest.identities.receiptId,
      manifest.identities.receiptCoreHash,
    ],
    ['case/evidence-case.json', manifest.identities.caseId, manifest.identities.caseHash],
  ];
  for (const [path, identity, digest] of pairs) {
    const content = bytes.get(path);
    if (content === undefined) {
      throw new VectorCorpusError(
        `${label} records an identifier over ${path}, which the vector does not hold`,
      );
    }
    const actual = digestOf(content);
    if (actual !== digest) {
      throw new VectorCorpusError(
        `${label}: the recorded digest for ${path} is ${digest}; its stored bytes hash to ${actual}`,
      );
    }
    if (!identityCarriesDigest(identity, digest)) {
      throw new VectorCorpusError(
        `${label}: identifier ${JSON.stringify(identity)} does not carry ${path}'s digest ${digest}`,
      );
    }
  }
}

function describeMoved(
  vectorId: string,
  manifest: VectorManifest,
  derived: DerivedVector,
): string | null {
  for (const file of manifest.files) {
    const actual = derived.files.find((candidate) => candidate.path === file.path);
    if (actual === undefined) {
      return (
        `${vectorId}: the evaluation no longer emits ${file.path}, which this vector records ` +
        `as ${file.sha256}. The artifact set moved without an artifact-schema version moving ` +
        `with it.`
      );
    }
    if (actual.sha256 !== file.sha256) {
      return (
        `${vectorId}/${file.path} moved: recorded ${file.sha256} ` +
        `(${file.byteLength.toString()} bytes), re-derived ${actual.sha256} ` +
        `(${actual.byteLength.toString()} bytes), with the artifact-schema version set ` +
        `unchanged. Either this change was not intended, or the artifact version must be ` +
        `bumped and a new vector recorded beside this one -- see ${VECTORS_DIRECTORY}/README.md.`
      );
    }
  }
  const extra = derived.files.filter(
    (candidate) => !manifest.files.some((file) => file.path === candidate.path),
  );
  if (extra.length > 0) {
    return (
      `${vectorId}: the evaluation now emits ${JSON.stringify(extra.map(({ path }) => path))}, ` +
      `which this vector does not record, with the artifact-schema version set unchanged.`
    );
  }
  if (canonicalJson(derived.renderManifestOrder) !== canonicalJson(manifest.renderManifestOrder)) {
    return (
      `${vectorId}: the render manifest is ${JSON.stringify(derived.renderManifestOrder)}; ` +
      `this vector recorded ${JSON.stringify(manifest.renderManifestOrder)}. The comparison is ` +
      `ordered, because a manifest that agrees as a set and differs in order is a different ` +
      `document with a different snapshot ID.`
    );
  }
  if (canonicalJson(derived.identities) !== canonicalJson(manifest.identities)) {
    return (
      `${vectorId}: the identifiers moved while every artifact's bytes matched. ` +
      `Recorded ${canonicalJson(manifest.identities)}; re-derived ${canonicalJson(derived.identities)}.`
    );
  }
  return null;
}

/**
 * Check every vector under `root`, and say what was examined.
 *
 * Refuses rather than returning on: no vectors, a vector that records nothing, a vector whose
 * stored bytes have drifted from its own manifest, a live vector whose re-derived bytes moved,
 * and a corpus in which no vector was live. The last one is the failure mode this whole file
 * exists for: once an artifact version is bumped, every existing vector is superseded, and a
 * corpus of nothing but superseded vectors re-derives nothing while reporting success.
 */
export async function checkVectorCorpus(root: string): Promise<VectorCorpusReport> {
  const corpusRoot = resolve(root);
  let entries;
  try {
    entries = await readdir(corpusRoot, { withFileTypes: true });
  } catch (cause) {
    // The cause is carried, not discarded: an absent root and an unreadable one are different
    // configuration mistakes and only the underlying error says which.
    throw new VectorCorpusError(
      `the vector corpus root ${JSON.stringify(corpusRoot)} could not be read, so nothing was ` +
        `checked. Fix the path rather than letting this gate report a clean corpus it never opened.`,
      { cause },
    );
  }
  const vectorIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
  if (vectorIds.length === 0) {
    throw new VectorCorpusError(
      `${toPosixPath(relative(process.cwd(), corpusRoot))} holds no vector directory. A corpus ` +
        `with nothing in it passes every comparison it makes, which is why this is an error.`,
    );
  }

  const outcomes: VectorOutcome[] = [];
  let checkedFileCount = 0;
  let liveVectorId: string | null = null;
  const supersededSummaries: string[] = [];

  for (const vectorId of vectorIds) {
    const directory = join(corpusRoot, vectorId);
    const label = `${VECTORS_DIRECTORY}/${vectorId}`;
    const manifest = readVectorManifest(
      parseBoundedJson(await readFile(join(directory, VECTOR_MANIFEST_FILENAME), 'utf8')),
      `${label}/${VECTOR_MANIFEST_FILENAME}`,
    );
    if (manifest.vectorId !== vectorId) {
      throw new VectorCorpusError(
        `${label}/${VECTOR_MANIFEST_FILENAME} names vectorId ${JSON.stringify(manifest.vectorId)}, ` +
          `which is not its directory name`,
      );
    }
    const bytes = await checkStoredBytes(directory, manifest, label);
    checkRecordedIdentities(manifest, bytes, label);
    checkedFileCount += manifest.files.length;

    const inputText = await readFile(join(directory, VECTOR_INPUT_FILENAME), 'utf8');
    let derived: DerivedVector | null = null;
    let supersededReason: string | null = null;
    try {
      derived = await deriveVector(inputText);
    } catch (error) {
      supersededReason = `this library refuses the vector's frozen input: ${(error as Error).message}`;
    }

    if (derived === null) {
      outcomes.push({
        vectorId,
        state: 'superseded',
        recordedFileCount: manifest.files.length,
        supersededReason,
      });
      supersededSummaries.push(`${vectorId} (${supersededReason ?? 'unknown reason'})`);
      continue;
    }

    if (
      canonicalJson(derived.artifactSchemaVersions) !==
      canonicalJson(manifest.artifactSchemaVersions)
    ) {
      const reason =
        `the library now emits ${canonicalJson(derived.artifactSchemaVersions)}; this vector ` +
        `recorded ${canonicalJson(manifest.artifactSchemaVersions)}`;
      outcomes.push({
        vectorId,
        state: 'superseded',
        recordedFileCount: manifest.files.length,
        supersededReason: reason,
      });
      supersededSummaries.push(`${vectorId} (${reason})`);
      continue;
    }

    const moved = describeMoved(label, manifest, derived);
    if (moved !== null) {
      throw new VectorCorpusError(moved);
    }
    if (liveVectorId !== null) {
      throw new VectorCorpusError(
        `${label} and ${VECTORS_DIRECTORY}/${liveVectorId} both record the artifact-schema ` +
          `version set this library emits. Exactly one vector may be live: two mean a version ` +
          `bump was recorded in a new directory without changing any version.`,
      );
    }
    liveVectorId = vectorId;
    outcomes.push({
      vectorId,
      state: 'live',
      recordedFileCount: manifest.files.length,
      supersededReason: null,
    });
  }

  if (liveVectorId === null) {
    throw new VectorCorpusError(
      `no vector is live: every one of ${vectorIds.length.toString()} was superseded ` +
        `(${supersededSummaries.join('; ')}). The artifact-schema version set moved and no ` +
        `vector covers what this library emits now, so nothing was re-derived. Record a new ` +
        `vector -- see ${VECTORS_DIRECTORY}/README.md.`,
    );
  }

  return { outcomes, liveVectorId, checkedFileCount };
}
