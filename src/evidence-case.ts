/**
 * `evidence-case/v1`: one complete reconciled-evidence evaluation input, on disk.
 *
 * `validateReconciledCsvEvidenceIntegrity` reruns "the exact inputs" and rejects any
 * divergence — but the exact inputs are a live JavaScript object graph, and until this file
 * existed nothing serialized it. The emitted bundle deliberately carries only report-safe
 * aggregates and hashes, so `reuseproof-verify` proves exactly what it says it proves: this
 * directory's bytes still satisfy its own render manifest. It cannot prove that the bundle is
 * what those inputs produce, because the inputs were nowhere.
 *
 * That gap is named in the README already — the receipt and freeze wrappers retain governing
 * contract preimages in memory while the artifacts carry only their hashes, so "production
 * restore and audit therefore still require durable retention of those authoritative
 * objects". A case file is the shape of the thing that must be retained, defined by the code
 * that consumes it.
 *
 * ## The two claims
 *
 * *This bundle has not been altered since it was written* is what the verifier gives you.
 * *This bundle is what these bytes and these approved contracts produce, and here is the
 * command anyone can run to see it* is what a replay over a case gives you. The second is
 * the claim the whole deterministic design is for.
 *
 * It stays inside the existing trust posture. Nothing here is signed, and a replay against a
 * case the same party produced proves derivation, not authenticity — the same limitation the
 * verifier states in terms, and the same reason `--expect-snapshot` is mandatory there and
 * here.
 *
 * ## Shape
 *
 * A case directory holds exactly three kinds of member:
 *
 *   `evidence-case.json`  the case manifest, canonical JSON, listing every other member with
 *                         its byte length and digest. Its own bytes yield the case ID, the
 *                         same way `report-freeze.json`'s bytes yield the snapshot ID.
 *   `case-input.json`     every governance object of the input in canonical JSON, with each
 *                         series' `sourceObjects` replaced by an ordered list of digest
 *                         references.
 *   `sources/<digest>`    one source object, verbatim, named by the exact-byte SHA-256 the
 *                         ingestion boundary already computes over it.
 *
 * Source objects are content-addressed, so two byte-identical submissions occupy one file.
 * Multiplicity is not lost by that: it lives in `case-input.json`, which lists the reference
 * per submission and in submission order. This matters — ADR-0009 rule 6 makes delivery
 * multiplicity input-specific, so a case that deduplicated the *references* would replay to a
 * different operational hash while every digest still matched.
 *
 * ## Why the input side is addressed by source bytes rather than by derived identity
 *
 * A row fingerprint derived from the whole-source hash and a row fingerprint derived within a
 * single pass are different artifact bytes, and which one this library should emit is an open
 * question. A case that pins the *bytes* is indifferent to that: whatever the derivation
 * becomes, the case still holds what it was derived from, and a replay is what makes the
 * difference between candidate derivations observable rather than argued.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, compareCodeUnits, sha256 } from './domain/canonical.js';
import {
  createCsvAdapterSourceContract,
  type CsvAdapterSourceContract,
} from './domain/csv-ingestion.js';
import {
  createCsvMeasurementMapping,
  type CsvMeasurementMapping,
} from './domain/csv-normalization.js';
import { parseBoundedJson, type JsonParseLimits } from './domain/json.js';
import { createPlausibilityPolicy, type PlausibilityPolicy } from './domain/plausibility.js';
import { createLifecycleTimeline, type LifecycleTimeline } from './domain/lifecycle.js';
import {
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  lifecycleStates,
  type LifecycleState,
  type RequiredSeriesContract,
  type ScheduledNonoperation,
  type TimeRange,
} from './domain/model.js';
import {
  createDailyAggregatePolicy,
  createUnitConversionRule,
  type DailyAggregatePolicy,
  type UnitConversionRule,
} from './domain/numeric-aggregation.js';
import { createReportTimeBasis, type ReportTimeBasis } from './domain/time.js';
import { inspectUint8Array, requireStrictArray, requireStrictRecord } from './domain/validation.js';
import {
  MAX_RECONCILED_EVALUATION_SERIES,
  MAX_RECONCILED_EVALUATION_SOURCES,
  MAX_RECONCILED_EVALUATION_SOURCE_BYTES,
  type ReconciledCsvEvidenceInput,
  type ReconciledCsvSeriesInput,
} from './reconciled-evaluation.js';

/** The case format this release writes, and the only one it reads. */
export const EVIDENCE_CASE_SCHEMA_VERSION = 'evidence-case/v1';
/** The input document's own version, carried separately so it can move on its own. */
export const EVIDENCE_CASE_INPUT_SCHEMA_VERSION = 'evidence-case-input/v2';
/** The case manifest: its bytes are what the case ID is derived from. */
export const EVIDENCE_CASE_MANIFEST_FILE = 'evidence-case.json';
/** Every governance object of the input, with sources as ordered digest references. */
export const EVIDENCE_CASE_INPUT_FILE = 'case-input.json';
/** The single directory under a case that holds source objects. */
export const EVIDENCE_CASE_SOURCE_DIRECTORY = 'sources';
/** The directory name a written case is exposed under, after staging. */
export const EVIDENCE_CASE_DIRECTORY_NAME = 'evidence-case';

/**
 * Bounds for `case-input.json`.
 *
 * Wider than {@link DEFAULT_JSON_PARSE_LIMITS} because a case holds every governance object
 * for up to sixty-four series at once, and narrower than the source-byte budget because
 * governance is text and sources are not. Stated here rather than defaulted so the number a
 * reader is held to is visible in the format, not inherited.
 */
export const EVIDENCE_CASE_INPUT_JSON_LIMITS: JsonParseLimits = Object.freeze({
  maxBytes: 8_388_608,
  maxDepth: 32,
  maxNodes: 400_000,
});

/** Bounds for `evidence-case.json`, which is a flat list and needs far less room. */
export const EVIDENCE_CASE_MANIFEST_JSON_LIMITS: JsonParseLimits = Object.freeze({
  maxBytes: 262_144,
  maxDepth: 8,
  maxNodes: 20_000,
});

/** The exact own fields of `evidence-case.json`. Pinned, not sampled: see FROZEN_CORE_FIELDS. */
export const EVIDENCE_CASE_MANIFEST_FIELDS: readonly string[] = Object.freeze([
  'caseInputHash',
  'claim',
  'limitations',
  'members',
  'schemaVersion',
]);

/** One member of a case, exactly as the manifest describes it. */
export interface EvidenceCaseMember {
  readonly logicalFilename: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Every reason one case on disk is refused.
 *
 * A refusal is never a partial read: "we could not reconstruct this input" must never be
 * readable as "this input reconstructed". There is deliberately no best-effort arm, so a case
 * that could not be read never yields a {@link ReadEvidenceCase}.
 */
export type EvidenceCaseRejectionReason =
  | 'canonical_form_mismatch'
  | 'case_directory_unreadable'
  | 'case_entry_not_a_regular_file'
  | 'case_file_missing'
  | 'case_file_unreadable'
  | 'case_input_shape_invalid'
  | 'case_manifest_order_invalid'
  | 'case_manifest_shape_invalid'
  | 'case_member_digest_mismatch'
  | 'case_path_not_a_directory'
  | 'case_schema_version_unsupported'
  | 'case_source_reference_unknown'
  | 'invalid_utf8'
  | 'unexpected_case_entry';

/** A refusal to read a case. Not a result type, so absence cannot be read as reconstruction. */
export class EvidenceCaseError extends Error {
  readonly reason: EvidenceCaseRejectionReason;
  readonly caseDirectory: string;

  constructor(reason: EvidenceCaseRejectionReason, caseDirectory: string, detail: string) {
    super(`evidence case read refused (${reason}): ${detail}`);
    this.name = 'EvidenceCaseError';
    this.reason = reason;
    this.caseDirectory = caseDirectory;
  }
}

/** What {@link writeEvidenceCaseAtomically} produced. */
export interface WrittenEvidenceCase {
  readonly containerDirectory: string;
  readonly caseDirectory: string;
  readonly caseId: string;
  readonly caseHash: string;
  readonly members: readonly EvidenceCaseMember[];
}

/**
 * One case, read back from disk with every member's bytes matched against the manifest.
 *
 * `input` is a freshly constructed, frozen evaluation input: passing it to
 * `evaluateReconciledCsvEvidence` is the replay. The limitations are stated on the value for
 * the same reason the verifier states its own — a caller holding this must not be able to
 * read it as more than it is.
 */
export interface ReadEvidenceCase {
  readonly schemaVersion: 'evidence-case-read/v1';
  readonly claim: 'case members are the complete evaluation input the manifest describes';
  readonly caseDirectory: string;
  readonly caseId: string;
  readonly caseHash: string;
  readonly caseInputHash: string;
  readonly members: readonly EvidenceCaseMember[];
  readonly input: ReconciledCsvEvidenceInput;
  readonly limitations: readonly [
    'byte integrity of one local case only; not a signature, authenticity, provenance, or approval proof',
    'the case is deliberately unsigned, so anyone holding this tool can write a wholly self-consistent one; this detects alteration of a case, never forgery of one',
    'a replay from this case proves that these bytes and these governance objects derive an artifact, never that the source bytes are what a system actually measured',
    'not a compliance, safety, water-quality, engineering, or regulatory-filing determination',
  ];
}

const CASE_CLAIM = 'this directory is one complete reconciled-evidence evaluation input';

const CASE_LIMITATIONS: readonly string[] = Object.freeze([
  'byte integrity of one local case only; not a signature, authenticity, provenance, or approval proof',
  'the case is deliberately unsigned, so anyone holding this tool can write a wholly self-consistent one; this detects alteration of a case, never forgery of one',
  'a replay from this case proves that these bytes and these governance objects derive an artifact, never that the source bytes are what a system actually measured',
  'not a compliance, safety, water-quality, engineering, or regulatory-filing determination',
]);

const READ_LIMITATIONS = CASE_LIMITATIONS as ReadEvidenceCase['limitations'];

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The exact-byte digest the ingestion boundary computes, over the same bytes. */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceMemberName(digest: string): string {
  return `${EVIDENCE_CASE_SOURCE_DIRECTORY}/${digest}`;
}

/**
 * Freeze an evaluation input without freezing its source bytes.
 *
 * `deepFreeze` cannot be used here: `Object.freeze` on a typed array that has elements throws,
 * so freezing the graph naively would fail on the first source object. Views are therefore
 * skipped. They are private copies this reader allocated from disk, so no caller shares them.
 */
function freezeInput<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    if (!Object.isFrozen(value)) {
      for (const child of Object.values(value)) {
        freezeInput(child);
      }
      Object.freeze(value);
    }
  }
  return value;
}

interface CaseSourceReference {
  readonly sha256: string;
  readonly byteLength: number;
}

interface CaseSeriesDocument {
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly csvContract: CsvAdapterSourceContract;
  readonly mapping: CsvMeasurementMapping;
  readonly conversionRules: readonly UnitConversionRule[];
  readonly aggregatePolicy: DailyAggregatePolicy;
  /**
   * The series' approved sentinel and plausibility policy, present only when it has one.
   *
   * A case that omitted it would replay a policy-governed series as an ungoverned one: the
   * sentinel rows the original evaluation quarantined would be accepted on replay, the
   * aggregate would differ, and the integrity check would report a divergence whose cause was
   * the case format rather than the bytes. `v2` of this document exists for this field.
   */
  readonly plausibilityPolicy?: PlausibilityPolicy;
  readonly sourceObjects: readonly CaseSourceReference[];
}

type CaseLifecycleDocument =
  { readonly lifecycleState: LifecycleState } | { readonly lifecycleTimeline: LifecycleTimeline };

interface CaseInputDocumentBase {
  readonly schemaVersion: string;
  readonly contracts: readonly RequiredSeriesContract[];
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly scheduledNonoperations: readonly ScheduledNonoperation[];
  readonly series: readonly CaseSeriesDocument[];
}

type CaseInputDocument = CaseInputDocumentBase & CaseLifecycleDocument;

const CASE_INPUT_REQUIRED_FIELDS: readonly string[] = Object.freeze([
  'schemaVersion',
  'contracts',
  'reportRange',
  'reportTimeBasis',
  'scheduledNonoperations',
  'series',
]);

const CASE_SERIES_FIELDS: readonly string[] = Object.freeze([
  'requiredSeriesContractId',
  'requiredSeriesContractVersion',
  'csvContract',
  'mapping',
  'conversionRules',
  'aggregatePolicy',
  'sourceObjects',
]);

/** Series fields a case may carry but need not. */
const CASE_SERIES_OPTIONAL_FIELDS: readonly string[] = Object.freeze(['plausibilityPolicy']);

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function lifecycleDocument(record: Record<string, unknown>, label: string): CaseLifecycleDocument {
  const hasState = Object.hasOwn(record, 'lifecycleState');
  const hasTimeline = Object.hasOwn(record, 'lifecycleTimeline');
  if (hasState === hasTimeline) {
    throw new TypeError(`${label} requires exactly one lifecycle state or timeline`);
  }
  if (hasTimeline) {
    return { lifecycleTimeline: createLifecycleTimeline(record.lifecycleTimeline) };
  }
  const state = record.lifecycleState;
  if (typeof state !== 'string' || !(lifecycleStates as readonly string[]).includes(state)) {
    throw new TypeError(`${label}.lifecycleState must be supported`);
  }
  return { lifecycleState: state as LifecycleState };
}

function sortedConversionRules(value: unknown, label: string): readonly UnitConversionRule[] {
  return requireStrictArray(value, label)
    .map(createUnitConversionRule)
    .sort(
      (left, right) =>
        compareCodeUnits(left.ruleId, right.ruleId) ||
        compareCodeUnits(left.version, right.version),
    );
}

/**
 * Build the case document from a live input, ordering it the way the evaluator orders its own
 * normalization.
 *
 * The ordering is the case format's, not the evaluator's: `evaluateReconciledCsvEvidence`
 * normalizes independently, so a divergence here could never change an evaluation result, only
 * which bytes a case is written as. It is matched anyway, because a case whose bytes depended
 * on the incidental array order a caller happened to hold would give the same input two case
 * IDs. `sourceObjects` is deliberately *not* sorted: its order is submission order, and
 * multiplicity is part of the input.
 */
function caseDocument(
  input: ReconciledCsvEvidenceInput,
  digests: ReadonlyMap<ReconciledCsvSeriesInput, readonly CaseSourceReference[]>,
): CaseInputDocument {
  const record = requireStrictRecord(
    input,
    ['contracts', 'reportRange', 'reportTimeBasis', 'scheduledNonoperations', 'series'],
    ['lifecycleState', 'lifecycleTimeline'],
    'evidence case input',
  );
  const contracts = requireStrictArray(record.contracts, 'evidence case input.contracts')
    .map(createRequiredSeriesContract)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.version, right.version),
    );
  const series = input.series
    .map((item, index): CaseSeriesDocument => {
      const label = `evidence case input.series[${index.toString()}]`;
      const sourceObjects = digests.get(item);
      /* v8 ignore next 3 -- every series is measured before this map is consulted. */
      if (sourceObjects === undefined) {
        throw new TypeError(`${label}.sourceObjects were not measured`);
      }
      return {
        requiredSeriesContractId: requiredText(
          item.requiredSeriesContractId,
          `${label}.requiredSeriesContractId`,
        ),
        requiredSeriesContractVersion: requiredText(
          item.requiredSeriesContractVersion,
          `${label}.requiredSeriesContractVersion`,
        ),
        csvContract: createCsvAdapterSourceContract(item.csvContract),
        mapping: createCsvMeasurementMapping(item.mapping),
        conversionRules: sortedConversionRules(item.conversionRules, `${label}.conversionRules`),
        aggregatePolicy: createDailyAggregatePolicy(item.aggregatePolicy),
        ...(item.plausibilityPolicy === undefined
          ? {}
          : { plausibilityPolicy: createPlausibilityPolicy(item.plausibilityPolicy) }),
        sourceObjects,
      };
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.requiredSeriesContractId, right.requiredSeriesContractId) ||
        compareCodeUnits(left.requiredSeriesContractVersion, right.requiredSeriesContractVersion),
    );
  const scheduledNonoperations = requireStrictArray(
    record.scheduledNonoperations,
    'evidence case input.scheduledNonoperations',
  )
    .map(createScheduledNonoperation)
    .sort((left, right) => compareCodeUnits(left.nonoperationId, right.nonoperationId));
  return {
    schemaVersion: EVIDENCE_CASE_INPUT_SCHEMA_VERSION,
    contracts,
    reportRange: createTimeRange(record.reportRange, 'evidence case input.reportRange'),
    reportTimeBasis: createReportTimeBasis(record.reportTimeBasis),
    scheduledNonoperations,
    series,
    ...lifecycleDocument(record, 'evidence case input'),
  };
}

function cleanupFailure(primary: unknown, cleanup: unknown, message: string): AggregateError {
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

async function useFileHandle(
  handle: FileHandle,
  operation: () => Promise<void>,
  cleanupMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (primary) {
    try {
      await handle.close();
    } catch (cleanup) {
      throw cleanupFailure(primary, cleanup, cleanupMessage);
    }
    throw primary;
  }
  await handle.close();
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await openFile(path, 'r');
  await useFileHandle(
    handle,
    async () => {
      await handle.sync();
    },
    'directory synchronization and descriptor cleanup both failed',
  );
}

async function writeExclusive(path: string, contents: string | Uint8Array): Promise<void> {
  const handle = await openFile(path, 'wx', 0o600);
  await useFileHandle(
    handle,
    async () => {
      await (typeof contents === 'string'
        ? handle.writeFile(contents, { encoding: 'utf8' })
        : handle.writeFile(contents));
      await handle.sync();
    },
    'case member write and descriptor cleanup both failed',
  );
}

async function removeFailedContainer(containerDirectory: string, primary: unknown): Promise<never> {
  try {
    await rm(containerDirectory, { recursive: true, force: true });
  } catch (cleanup) {
    throw cleanupFailure(primary, cleanup, 'case publication and container cleanup both failed');
  }
  throw primary;
}

/**
 * Serialize one complete evaluation input as an `evidence-case/v1` directory.
 *
 * Staged under a unique private container, fsynced, then exposed with one rename, exactly as
 * a frozen bundle is: a half-written case must never be readable as a case. The output parent
 * must already exist.
 */
export async function writeEvidenceCaseAtomically(
  outputParent: string,
  input: ReconciledCsvEvidenceInput,
): Promise<WrittenEvidenceCase> {
  const seriesList = requireStrictArray(input.series, 'evidence case input.series');
  if (seriesList.length === 0 || seriesList.length > MAX_RECONCILED_EVALUATION_SERIES) {
    throw new RangeError(
      `an evidence case holds 1 through ${MAX_RECONCILED_EVALUATION_SERIES.toString()} series bundles`,
    );
  }
  // Measure every source before anything is written: the case ID is derived from the manifest,
  // the manifest from these digests, and the container is named for the case ID.
  const bytesByDigest = new Map<string, Uint8Array>();
  const references = new Map<ReconciledCsvSeriesInput, readonly CaseSourceReference[]>();
  let totalSources = 0;
  let totalSourceBytes = 0;
  for (const [index, item] of input.series.entries()) {
    const label = `evidence case input.series[${index.toString()}]`;
    const sources = requireStrictArray(item.sourceObjects, `${label}.sourceObjects`);
    const measured = sources.map((source, sourceIndex) => {
      const inspected = inspectUint8Array(
        source,
        `${label}.sourceObjects[${sourceIndex.toString()}]`,
      );
      // Copy before hashing. A caller may hold the same buffer and mutate it between the
      // digest and the write, which would put a file under a name that is not its digest.
      const copy = new Uint8Array(inspected.bytes);
      const digest = digestBytes(copy);
      const existing = bytesByDigest.get(digest);
      if (existing === undefined) {
        bytesByDigest.set(digest, copy);
      }
      totalSources += 1;
      totalSourceBytes += inspected.byteLength;
      return { sha256: digest, byteLength: inspected.byteLength };
    });
    references.set(item, measured);
  }
  if (totalSources > MAX_RECONCILED_EVALUATION_SOURCES) {
    throw new RangeError(
      `an evidence case holds at most ${MAX_RECONCILED_EVALUATION_SOURCES.toString()} source objects`,
    );
  }
  if (totalSourceBytes > MAX_RECONCILED_EVALUATION_SOURCE_BYTES) {
    throw new RangeError(
      `an evidence case holds at most ${MAX_RECONCILED_EVALUATION_SOURCE_BYTES.toString()} source bytes`,
    );
  }

  const inputText = canonicalJson(caseDocument(input, references));
  const inputBytes = new TextEncoder().encode(inputText);
  const caseInputHash = sha256(inputText);
  const members: readonly EvidenceCaseMember[] = Object.freeze(
    [
      {
        logicalFilename: EVIDENCE_CASE_INPUT_FILE,
        byteLength: inputBytes.byteLength,
        sha256: caseInputHash,
      },
      ...[...bytesByDigest.entries()].map(([digest, bytes]) => ({
        logicalFilename: sourceMemberName(digest),
        byteLength: bytes.byteLength,
        sha256: digest,
      })),
    ].sort((left, right) => compareCodeUnits(left.logicalFilename, right.logicalFilename)),
  );
  const manifestText = canonicalJson({
    schemaVersion: EVIDENCE_CASE_SCHEMA_VERSION,
    claim: CASE_CLAIM,
    limitations: CASE_LIMITATIONS,
    caseInputHash,
    members,
  });
  const caseHash = sha256(manifestText);
  const caseId = `rpc1-${caseHash}`;

  const requestedParent = resolve(outputParent);
  const parentStat = await lstat(requestedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new TypeError('evidence case output parent must be a real directory');
  }
  const canonicalParent = await realpath(requestedParent);
  const containerDirectory = await mkdtemp(join(canonicalParent, `${caseId}-`));
  const caseDirectory = join(containerDirectory, EVIDENCE_CASE_DIRECTORY_NAME);
  try {
    const stageDirectory = await mkdtemp(join(containerDirectory, '.stage-'));
    await writeExclusive(join(stageDirectory, EVIDENCE_CASE_MANIFEST_FILE), manifestText);
    await writeExclusive(join(stageDirectory, EVIDENCE_CASE_INPUT_FILE), inputText);
    if (bytesByDigest.size > 0) {
      const sourceDirectory = join(stageDirectory, EVIDENCE_CASE_SOURCE_DIRECTORY);
      await mkdir(sourceDirectory, { mode: 0o700 });
      for (const [digest, bytes] of bytesByDigest) {
        await writeExclusive(join(sourceDirectory, digest), bytes);
      }
      await syncDirectory(sourceDirectory);
    }
    await syncDirectory(stageDirectory);
    await rename(stageDirectory, caseDirectory);
    await syncDirectory(containerDirectory);
    await syncDirectory(canonicalParent);
  } catch (error) {
    await removeFailedContainer(containerDirectory, error);
  }
  return Object.freeze({ containerDirectory, caseDirectory, caseId, caseHash, members });
}

interface CaseReader {
  readonly refuse: (reason: EvidenceCaseRejectionReason, detail: string) => never;
}

function createCaseReader(directory: string): CaseReader {
  return {
    refuse: (reason, detail) => {
      throw new EvidenceCaseError(reason, directory, detail);
    },
  };
}

/**
 * Recover one control file's fields from its own bytes.
 *
 * The emitted bytes are canonical, so re-serializing the parse must reproduce them exactly:
 * reordered keys, re-indented output and equivalent-but-different number spellings are all
 * refused rather than normalized away. Same rule as the bundle's control files, same reason —
 * a document that round-trips only *semantically* has no single byte sequence to hash.
 */
function readCanonicalRecord(
  reader: CaseReader,
  filename: string,
  text: string,
  limits: JsonParseLimits,
  shapeReason: EvidenceCaseRejectionReason,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(text, limits);
  } catch {
    reader.refuse(shapeReason, `${filename} is not bounded, strict JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reader.refuse(shapeReason, `${filename} must be a JSON object`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    reader.refuse('canonical_form_mismatch', `${filename} cannot be canonicalized`);
  }
  if (canonical !== text) {
    reader.refuse('canonical_form_mismatch', `${filename} is not in canonical form`);
  }
  return parsed as Record<string, unknown>;
}

function readManifestMembers(
  reader: CaseReader,
  record: Record<string, unknown>,
): readonly EvidenceCaseMember[] {
  const value = record.members;
  if (!Array.isArray(value) || value.length === 0) {
    reader.refuse(
      'case_manifest_shape_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE}.members must be a non-empty array`,
    );
  }
  if (value.length > MAX_RECONCILED_EVALUATION_SOURCES + 1) {
    reader.refuse(
      'case_manifest_shape_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE}.members exceeds the case member limit`,
    );
  }
  const seen = new Set<string>();
  const members = (value as readonly unknown[]).map((entry, index) => {
    const label = `${EVIDENCE_CASE_MANIFEST_FILE}.members[${index.toString()}]`;
    let item: Record<string, unknown>;
    try {
      item = requireStrictRecord(entry, ['byteLength', 'logicalFilename', 'sha256'], [], label);
    } catch {
      reader.refuse('case_manifest_shape_invalid', `${label} is not a strict member entry`);
    }
    const digest = item.sha256;
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      reader.refuse(
        'case_manifest_shape_invalid',
        `${label}.sha256 must be a lowercase SHA-256 digest`,
      );
    }
    const logicalFilename = item.logicalFilename;
    if (typeof logicalFilename !== 'string') {
      reader.refuse('case_manifest_shape_invalid', `${label}.logicalFilename must be a string`);
    }
    // The member namespace is closed: the input document, or a source under its own digest.
    // Anything else — a traversal, a nested directory, a second control file — is refused here
    // rather than resolved against the filesystem.
    if (
      logicalFilename !== EVIDENCE_CASE_INPUT_FILE &&
      logicalFilename !== sourceMemberName(digest)
    ) {
      reader.refuse(
        'case_manifest_shape_invalid',
        `${label}.logicalFilename ${JSON.stringify(logicalFilename)} is not a case member name`,
      );
    }
    if (seen.has(logicalFilename)) {
      reader.refuse('case_manifest_shape_invalid', `${label}.logicalFilename is duplicated`);
    }
    seen.add(logicalFilename);
    const byteLength = item.byteLength;
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
      reader.refuse(
        'case_manifest_shape_invalid',
        `${label}.byteLength must be a non-negative safe integer`,
      );
    }
    return Object.freeze({
      logicalFilename,
      byteLength: byteLength as number,
      sha256: digest,
    });
  });
  // Member order is part of the emitted document, not an incidental array layout: the case ID
  // is a hash of these bytes, so a reordered manifest is a different case and must not verify
  // on set equality.
  const sorted = [...members].sort((left, right) =>
    compareCodeUnits(left.logicalFilename, right.logicalFilename),
  );
  if (canonicalJson(members) !== canonicalJson(sorted)) {
    reader.refuse(
      'case_manifest_order_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE}.members is not in canonical order`,
    );
  }
  const declaredBytes = members
    .filter(({ logicalFilename }) => logicalFilename !== EVIDENCE_CASE_INPUT_FILE)
    .reduce((total, { byteLength }) => total + byteLength, 0);
  if (declaredBytes > MAX_RECONCILED_EVALUATION_SOURCE_BYTES) {
    reader.refuse(
      'case_manifest_shape_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE} declares more source bytes than an evaluation accepts`,
    );
  }
  return members;
}

async function readMemberBytes(
  reader: CaseReader,
  directory: string,
  member: EvidenceCaseMember,
): Promise<Uint8Array> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, member.logicalFilename));
  } catch {
    reader.refuse('case_file_unreadable', `${member.logicalFilename} could not be read`);
  }
  if (bytes.byteLength !== member.byteLength) {
    reader.refuse(
      'case_member_digest_mismatch',
      `${member.logicalFilename} is ${bytes.byteLength.toString()} bytes, and the manifest declares ${member.byteLength.toString()}`,
    );
  }
  const actual = digestBytes(bytes);
  if (actual !== member.sha256) {
    reader.refuse(
      'case_member_digest_mismatch',
      `${member.logicalFilename} expected sha256 ${member.sha256}, actual sha256 ${actual}`,
    );
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(reader: CaseReader, filename: string, bytes: Uint8Array): string {
  try {
    // Fatal decoding only. A substituting decoder would turn corrupt bytes into U+FFFD and let
    // damaged evidence reach the canonical comparison as though merely different.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reader.refuse('invalid_utf8', `${filename} is not valid UTF-8`);
  }
}

function readSourceReferences(
  reader: CaseReader,
  value: unknown,
  label: string,
): readonly CaseSourceReference[] {
  let entries: readonly unknown[];
  try {
    entries = requireStrictArray(value, label);
  } catch {
    reader.refuse('case_input_shape_invalid', `${label} must be an array`);
  }
  return entries.map((entry, index) => {
    const itemLabel = `${label}[${index.toString()}]`;
    let item: Record<string, unknown>;
    try {
      item = requireStrictRecord(entry, ['byteLength', 'sha256'], [], itemLabel);
    } catch {
      reader.refuse('case_input_shape_invalid', `${itemLabel} is not a strict source reference`);
    }
    const digest = item.sha256;
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      reader.refuse(
        'case_input_shape_invalid',
        `${itemLabel}.sha256 must be a lowercase SHA-256 digest`,
      );
    }
    const byteLength = item.byteLength;
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
      reader.refuse(
        'case_input_shape_invalid',
        `${itemLabel}.byteLength must be a non-negative safe integer`,
      );
    }
    return { sha256: digest, byteLength: byteLength as number };
  });
}

function readCaseSeries(
  reader: CaseReader,
  value: unknown,
  sources: ReadonlyMap<string, Uint8Array>,
): readonly ReconciledCsvSeriesInput[] {
  let entries: readonly unknown[];
  try {
    entries = requireStrictArray(value, `${EVIDENCE_CASE_INPUT_FILE}.series`);
  } catch {
    reader.refuse(
      'case_input_shape_invalid',
      `${EVIDENCE_CASE_INPUT_FILE}.series must be an array`,
    );
  }
  if (entries.length === 0 || entries.length > MAX_RECONCILED_EVALUATION_SERIES) {
    reader.refuse(
      'case_input_shape_invalid',
      `${EVIDENCE_CASE_INPUT_FILE}.series must hold 1 through ${MAX_RECONCILED_EVALUATION_SERIES.toString()} bundles`,
    );
  }
  return entries.map((entry, index) => {
    const label = `${EVIDENCE_CASE_INPUT_FILE}.series[${index.toString()}]`;
    let item: Record<string, unknown>;
    try {
      item = requireStrictRecord(entry, CASE_SERIES_FIELDS, CASE_SERIES_OPTIONAL_FIELDS, label);
    } catch (error) {
      reader.refuse('case_input_shape_invalid', (error as Error).message);
    }
    const references = readSourceReferences(reader, item.sourceObjects, `${label}.sourceObjects`);
    const sourceObjects = references.map((reference) => {
      const bytes = sources.get(reference.sha256);
      if (bytes === undefined) {
        reader.refuse(
          'case_source_reference_unknown',
          `${label} references source ${reference.sha256}, which the manifest does not list`,
        );
      }
      if (bytes.byteLength !== reference.byteLength) {
        reader.refuse(
          'case_input_shape_invalid',
          `${label} declares source ${reference.sha256} as ${reference.byteLength.toString()} bytes, and it is ${bytes.byteLength.toString()}`,
        );
      }
      // A private copy per reference. Two references to one digest must not alias, or a
      // consumer mutating one submission would silently change the other.
      return new Uint8Array(bytes);
    });
    try {
      return {
        requiredSeriesContractId: requiredText(
          item.requiredSeriesContractId,
          `${label}.requiredSeriesContractId`,
        ),
        requiredSeriesContractVersion: requiredText(
          item.requiredSeriesContractVersion,
          `${label}.requiredSeriesContractVersion`,
        ),
        csvContract: createCsvAdapterSourceContract(item.csvContract),
        mapping: createCsvMeasurementMapping(item.mapping),
        conversionRules: sortedConversionRules(item.conversionRules, `${label}.conversionRules`),
        aggregatePolicy: createDailyAggregatePolicy(item.aggregatePolicy),
        ...(item.plausibilityPolicy === undefined
          ? {}
          : { plausibilityPolicy: createPlausibilityPolicy(item.plausibilityPolicy) }),
        sourceObjects,
      };
    } catch (error) {
      reader.refuse('case_input_shape_invalid', (error as Error).message);
    }
  });
}

function readCaseInput(
  reader: CaseReader,
  text: string,
  sources: ReadonlyMap<string, Uint8Array>,
): ReconciledCsvEvidenceInput {
  const record = readCanonicalRecord(
    reader,
    EVIDENCE_CASE_INPUT_FILE,
    text,
    EVIDENCE_CASE_INPUT_JSON_LIMITS,
    'case_input_shape_invalid',
  );
  let fields: Record<string, unknown>;
  try {
    fields = requireStrictRecord(
      record,
      CASE_INPUT_REQUIRED_FIELDS,
      ['lifecycleState', 'lifecycleTimeline'],
      EVIDENCE_CASE_INPUT_FILE,
    );
  } catch (error) {
    reader.refuse('case_input_shape_invalid', (error as Error).message);
  }
  if (fields.schemaVersion !== EVIDENCE_CASE_INPUT_SCHEMA_VERSION) {
    reader.refuse(
      'case_schema_version_unsupported',
      `${EVIDENCE_CASE_INPUT_FILE} declares ${JSON.stringify(fields.schemaVersion)}; this release reads ${JSON.stringify(EVIDENCE_CASE_INPUT_SCHEMA_VERSION)}`,
    );
  }
  const series = readCaseSeries(reader, fields.series, sources);
  let rest: {
    readonly contracts: readonly RequiredSeriesContract[];
    readonly reportRange: TimeRange;
    readonly reportTimeBasis: ReportTimeBasis;
    readonly scheduledNonoperations: readonly ScheduledNonoperation[];
    readonly lifecycle: CaseLifecycleDocument;
  };
  try {
    rest = {
      contracts: requireStrictArray(fields.contracts, `${EVIDENCE_CASE_INPUT_FILE}.contracts`).map(
        createRequiredSeriesContract,
      ),
      reportRange: createTimeRange(fields.reportRange, `${EVIDENCE_CASE_INPUT_FILE}.reportRange`),
      reportTimeBasis: createReportTimeBasis(fields.reportTimeBasis),
      scheduledNonoperations: requireStrictArray(
        fields.scheduledNonoperations,
        `${EVIDENCE_CASE_INPUT_FILE}.scheduledNonoperations`,
      ).map(createScheduledNonoperation),
      lifecycle: lifecycleDocument(fields, EVIDENCE_CASE_INPUT_FILE),
    };
  } catch (error) {
    reader.refuse('case_input_shape_invalid', (error as Error).message);
  }
  const base = {
    contracts: rest.contracts,
    reportRange: rest.reportRange,
    reportTimeBasis: rest.reportTimeBasis,
    scheduledNonoperations: rest.scheduledNonoperations,
    series,
  };
  return freezeInput(
    'lifecycleTimeline' in rest.lifecycle
      ? { ...base, lifecycleTimeline: rest.lifecycle.lifecycleTimeline }
      : { ...base, lifecycleState: rest.lifecycle.lifecycleState },
  );
}

/**
 * Read one `evidence-case/v1` directory back into the evaluation input that wrote it.
 *
 * The chain is rooted at `evidence-case.json`: that file's own bytes yield the case ID, it
 * names the digest and byte length of every other member, and no member's bytes are used for
 * anything until they match what it declares. Every refusal raises {@link EvidenceCaseError}
 * carrying a machine-readable reason; there is no partial or best-effort result.
 *
 * What comes back is a newly constructed input, never a caller's object, so a replay from it
 * shares nothing with whatever produced the case.
 */
export async function readEvidenceCaseAtPath(caseDirectory: string): Promise<ReadEvidenceCase> {
  const directory = resolve(caseDirectory);
  // Annotated, not inferred: TypeScript only treats `reader.refuse(...)` as never-returning
  // when the root identifier carries an explicit type, and every fail-closed arm below depends
  // on that. Without it the refusals still throw, but the compiler stops proving that nothing
  // after them runs.
  const reader: CaseReader = createCaseReader(directory);

  let directoryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryStat = await lstat(directory);
  } catch {
    reader.refuse('case_directory_unreadable', 'case directory could not be inspected');
  }
  if (!directoryStat.isDirectory()) {
    reader.refuse(
      'case_path_not_a_directory',
      'a case path must be a real directory, not a link to one',
    );
  }

  let topEntries: Dirent[];
  try {
    topEntries = await readdir(directory, { withFileTypes: true });
  } catch {
    reader.refuse('case_directory_unreadable', 'case directory could not be listed');
  }
  const present = new Set<string>();
  for (const entry of topEntries) {
    if (entry.name === EVIDENCE_CASE_SOURCE_DIRECTORY) {
      if (!entry.isDirectory()) {
        reader.refuse(
          'case_entry_not_a_regular_file',
          `${EVIDENCE_CASE_SOURCE_DIRECTORY} must be a real directory`,
        );
      }
      let sourceEntries: Dirent[];
      try {
        sourceEntries = await readdir(join(directory, EVIDENCE_CASE_SOURCE_DIRECTORY), {
          withFileTypes: true,
        });
      } catch {
        reader.refuse(
          'case_directory_unreadable',
          `${EVIDENCE_CASE_SOURCE_DIRECTORY} could not be listed`,
        );
      }
      if (sourceEntries.length === 0) {
        reader.refuse(
          'unexpected_case_entry',
          `${EVIDENCE_CASE_SOURCE_DIRECTORY} is present and holds no source object`,
        );
      }
      for (const source of sourceEntries) {
        if (!source.isFile()) {
          reader.refuse(
            'case_entry_not_a_regular_file',
            `${sourceMemberName(source.name)} is not a regular file`,
          );
        }
        present.add(sourceMemberName(source.name));
      }
      continue;
    }
    if (!entry.isFile()) {
      reader.refuse('case_entry_not_a_regular_file', `${entry.name} is not a regular file`);
    }
    present.add(entry.name);
  }

  if (!present.has(EVIDENCE_CASE_MANIFEST_FILE)) {
    reader.refuse('case_file_missing', `${EVIDENCE_CASE_MANIFEST_FILE} is absent from the case`);
  }
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(directory, EVIDENCE_CASE_MANIFEST_FILE));
  } catch {
    reader.refuse('case_file_unreadable', `${EVIDENCE_CASE_MANIFEST_FILE} could not be read`);
  }
  const manifestText = decodeUtf8(reader, EVIDENCE_CASE_MANIFEST_FILE, manifestBytes);
  const manifestRecord = readCanonicalRecord(
    reader,
    EVIDENCE_CASE_MANIFEST_FILE,
    manifestText,
    EVIDENCE_CASE_MANIFEST_JSON_LIMITS,
    'case_manifest_shape_invalid',
  );
  if (manifestRecord.schemaVersion !== EVIDENCE_CASE_SCHEMA_VERSION) {
    reader.refuse(
      'case_schema_version_unsupported',
      `${EVIDENCE_CASE_MANIFEST_FILE} declares ${JSON.stringify(manifestRecord.schemaVersion)}; this release reads ${JSON.stringify(EVIDENCE_CASE_SCHEMA_VERSION)}`,
    );
  }
  try {
    requireStrictRecord(
      manifestRecord,
      EVIDENCE_CASE_MANIFEST_FIELDS,
      [],
      EVIDENCE_CASE_MANIFEST_FILE,
    );
  } catch (error) {
    reader.refuse('case_manifest_shape_invalid', (error as Error).message);
  }
  const members = readManifestMembers(reader, manifestRecord);
  const caseHash = sha256(manifestText);
  const caseId = `rpc1-${caseHash}`;

  for (const member of members) {
    if (!present.has(member.logicalFilename)) {
      reader.refuse('case_file_missing', `${member.logicalFilename} is absent from the case`);
    }
  }
  const listed = new Set<string>([
    EVIDENCE_CASE_MANIFEST_FILE,
    ...members.map(({ logicalFilename }) => logicalFilename),
  ]);
  for (const name of present) {
    if (!listed.has(name)) {
      reader.refuse('unexpected_case_entry', `${name} is not listed by the case manifest`);
    }
  }

  const inputMember = members.find(
    ({ logicalFilename }) => logicalFilename === EVIDENCE_CASE_INPUT_FILE,
  );
  if (inputMember === undefined) {
    reader.refuse(
      'case_manifest_shape_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE} lists no ${EVIDENCE_CASE_INPUT_FILE}`,
    );
  }
  const declaredInputHash = manifestRecord.caseInputHash;
  if (typeof declaredInputHash !== 'string' || declaredInputHash !== inputMember.sha256) {
    reader.refuse(
      'case_manifest_shape_invalid',
      `${EVIDENCE_CASE_MANIFEST_FILE}.caseInputHash does not name the ${EVIDENCE_CASE_INPUT_FILE} member beside it`,
    );
  }

  // Every member is matched against the manifest before any of it is interpreted, and each is
  // read exactly once: reading the input document a second time to parse it would open the
  // window where the bytes that verified are not the bytes that were used.
  const sources = new Map<string, Uint8Array>();
  let inputBytes: Uint8Array | null = null;
  for (const member of members) {
    const bytes = await readMemberBytes(reader, directory, member);
    if (member.logicalFilename === EVIDENCE_CASE_INPUT_FILE) {
      inputBytes = bytes;
    } else {
      sources.set(member.sha256, bytes);
    }
  }
  /* v8 ignore next 3 -- the input member was located in the manifest above. */
  if (inputBytes === null) {
    reader.refuse('case_file_missing', `${EVIDENCE_CASE_INPUT_FILE} was not read`);
  }
  const input = readCaseInput(
    reader,
    decodeUtf8(reader, EVIDENCE_CASE_INPUT_FILE, inputBytes),
    sources,
  );

  return Object.freeze({
    schemaVersion: 'evidence-case-read/v1',
    claim: 'case members are the complete evaluation input the manifest describes',
    caseDirectory: directory,
    caseId,
    caseHash,
    caseInputHash: inputMember.sha256,
    members,
    input,
    limitations: READ_LIMITATIONS,
  } as ReadEvidenceCase);
}
