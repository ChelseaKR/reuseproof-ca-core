/** Atomic local output boundary for one already frozen deterministic report bundle. */

import type { Dirent } from 'node:fs';
import {
  lstat,
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
import { parseBoundedJson } from './domain/json.js';
import { assertStrictRecordKeys } from './domain/validation.js';
import { validateFrozenReportIntegrity, type FrozenReport } from './report-lifecycle.js';
import {
  artifactMediaType,
  requireSafeArtifactFilename,
  type RenderManifestItem,
} from './report-render.js';

export type FrozenBundleFilename =
  | 'coverage-report.csv'
  | 'coverage-report.html'
  | 'coverage-report.json'
  | 'receipt-core.json'
  | 'report-freeze.json';

export interface WrittenFrozenReportBundle {
  readonly containerDirectory: string;
  readonly bundleDirectory: string;
  readonly filenames: readonly FrozenBundleFilename[];
}

/**
 * Every reason one bundle on disk is refused. A refusal is never a partial verification:
 * "we could not check this" must never be readable as "this checked out".
 */
export type FrozenBundleRejectionReason =
  | 'bundle_directory_unreadable'
  | 'bundle_entry_not_a_regular_file'
  | 'bundle_file_missing'
  | 'bundle_file_unreadable'
  | 'bundle_path_not_a_directory'
  | 'canonical_form_mismatch'
  | 'control_file_shape_invalid'
  | 'control_file_version_unsupported'
  | 'invalid_utf8'
  | 'receipt_core_hash_mismatch'
  | 'render_artifact_hash_mismatch'
  | 'render_manifest_disagreement'
  | 'render_manifest_order_invalid'
  | 'snapshot_boundary_violation'
  | 'unexpected_bundle_entry';

/** A refusal to verify. Deliberately not a result type, so absence cannot be read as proof. */
export class FrozenBundleVerificationError extends Error {
  readonly reason: FrozenBundleRejectionReason;
  readonly bundleDirectory: string;

  constructor(reason: FrozenBundleRejectionReason, bundleDirectory: string, detail: string) {
    super(`frozen bundle verification refused (${reason}): ${detail}`);
    this.name = 'FrozenBundleVerificationError';
    this.reason = reason;
    this.bundleDirectory = bundleDirectory;
  }
}

/**
 * Evidence that every byte of one bundle on disk still satisfies the frozen manifest that
 * governs it. Only constructed after all five files were read, decoded, and matched.
 */
export interface VerifiedFrozenReportBundle {
  readonly schemaVersion: 'frozen-bundle-verification/v1';
  readonly claim: 'bundle bytes match their frozen render manifest';
  readonly bundleDirectory: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly receiptId: string;
  readonly receiptCoreHash: string;
  readonly reportContentHash: string;
  readonly reportVersion: number;
  readonly supersedesSnapshotHash: string | null;
  readonly verifiedFilenames: readonly FrozenBundleFilename[];
  readonly limitations: readonly [
    'byte integrity of one local bundle only; not a signature, authenticity, provenance, or approval proof',
    'the bundle is deliberately unsigned, so anyone holding this tool can regenerate a wholly self-consistent one; this detects alteration of a bundle, never forgery of one',
    'sound only against an independently recorded snapshot ID, which this result returns for exactly that purpose',
    'a superseding snapshot names its predecessor by hash but cannot prove that predecessor from this bundle alone',
    'not a compliance, safety, water-quality, engineering, or regulatory-filing determination',
  ];
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

async function writeExclusive(path: string, text: string): Promise<void> {
  const handle = await openFile(path, 'wx', 0o600);
  await useFileHandle(
    handle,
    async () => {
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    },
    'artifact write and descriptor cleanup both failed',
  );
}

async function removeFailedContainer(containerDirectory: string, primary: unknown): Promise<never> {
  try {
    await rm(containerDirectory, { recursive: true, force: true });
  } catch (cleanup) {
    throw cleanupFailure(
      primary,
      cleanup,
      'artifact publication and container cleanup both failed',
    );
  }
  throw primary;
}

/**
 * Stage every file under a unique private container, fsync it, then expose the complete
 * `artifacts` directory with one rename. The output parent must already exist.
 */
export async function writeFrozenReportBundleAtomically(
  outputParent: string,
  report: FrozenReport,
): Promise<WrittenFrozenReportBundle> {
  const safeReport = validateFrozenReportIntegrity(report);
  // Capture every validated primitive before the first asynchronous boundary. Callers may
  // supply an otherwise valid mutable clone and change it while output-parent I/O is pending.
  const receiptCanonicalCore = safeReport.receipt.canonicalCore;
  const freezeCanonicalCore = safeReport.canonicalCore;
  const snapshot = Object.freeze({
    snapshotId: safeReport.snapshotId,
    receiptCanonicalCore,
    freezeCanonicalCore,
    entries: Object.freeze(
      [
        ...safeReport.receipt.renderArtifacts.map((artifact) =>
          Object.freeze({
            filename: requireSafeArtifactFilename(artifact.logicalFilename),
            utf8Text: artifact.utf8Text,
          }),
        ),
        Object.freeze({
          filename: 'receipt-core.json' as const,
          utf8Text: receiptCanonicalCore,
        }),
        Object.freeze({
          filename: 'report-freeze.json' as const,
          utf8Text: freezeCanonicalCore,
        }),
      ].sort((left, right) => compareCodeUnits(left.filename, right.filename)),
    ),
  });
  const requestedParent = resolve(outputParent);
  const parentStat = await lstat(requestedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new TypeError('artifact output parent must be a real directory');
  }
  const canonicalParent = await realpath(requestedParent);
  const containerDirectory = await mkdtemp(join(canonicalParent, `${snapshot.snapshotId}-`));
  const bundleDirectory = join(containerDirectory, 'artifacts');
  try {
    const stageDirectory = await mkdtemp(join(containerDirectory, '.stage-'));
    for (const entry of snapshot.entries) {
      await writeExclusive(join(stageDirectory, entry.filename), entry.utf8Text);
    }
    await syncDirectory(stageDirectory);
    await rename(stageDirectory, bundleDirectory);
    await syncDirectory(containerDirectory);
    await syncDirectory(canonicalParent);
  } catch (error) {
    await removeFailedContainer(containerDirectory, error);
  }
  return Object.freeze({
    containerDirectory,
    bundleDirectory,
    filenames: Object.freeze(snapshot.entries.map(({ filename }) => filename)),
  });
}

const FREEZE_CONTROL_FILE = 'report-freeze.json' as const;
const RECEIPT_CONTROL_FILE = 'receipt-core.json' as const;
const FREEZE_CORE_SCHEMA_VERSION = 'frozen-report-core/v1' as const;
const RECEIPT_CORE_SCHEMA_VERSION = 'receipt-core/v2' as const;

/**
 * The exact own fields each emitted control file carries. Pinned rather than sampled: a
 * control file that gained or lost a field is a different document, and pinning the key
 * set means an injected field can never ride along unread inside verified bytes.
 */
export const FROZEN_CORE_FIELDS: readonly string[] = Object.freeze([
  'claim',
  'lifecycleState',
  'limitations',
  'receiptCoreHash',
  'receiptId',
  'renderManifest',
  'reportContentHash',
  'reportKind',
  'reportVersion',
  'schemaVersion',
  'submissionBoundary',
  'submittable',
  'supersedesSnapshotHash',
  'unsigned',
]);

/** The exact own fields of the emitted receipt core. See {@link FROZEN_CORE_FIELDS}. */
export const RECEIPT_CORE_FIELDS: readonly string[] = Object.freeze([
  'claim',
  'evidenceManifest',
  'limitations',
  'renderManifest',
  'reportContentHash',
  'schemaVersion',
  'submittable',
  'supersededCoreHashes',
  'systemId',
  'tenantId',
  'reportPeriod',
  'unsigned',
]);

interface BundleReader {
  readonly refuse: (reason: FrozenBundleRejectionReason, detail: string) => never;
  readonly readText: (filename: FrozenBundleFilename) => Promise<{
    readonly text: string;
    readonly byteLength: number;
  }>;
}

function createBundleReader(directory: string, entries: ReadonlySet<string>): BundleReader {
  const refuse: BundleReader['refuse'] = (reason, detail) => {
    throw new FrozenBundleVerificationError(reason, directory, detail);
  };
  return {
    refuse,
    readText: async (filename) => {
      if (!entries.has(filename)) {
        refuse('bundle_file_missing', `${filename} is absent from the bundle`);
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(join(directory, filename));
      } catch {
        refuse('bundle_file_unreadable', `${filename} could not be read`);
      }
      let text: string;
      try {
        // Fatal decoding only. A substituting decoder would turn corrupt bytes into U+FFFD
        // and let damaged evidence reach the hash comparison as though merely different.
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        refuse('invalid_utf8', `${filename} is not valid UTF-8`);
      }
      return { text, byteLength: bytes.byteLength };
    },
  };
}

/**
 * Recover one control file's fields from its own bytes. The emitted bytes are canonical, so
 * re-serializing the parse must reproduce them exactly: reordered keys, re-indented output,
 * and equivalent-but-different number spellings are all refused rather than normalized away.
 */
function readControlRecord(
  reader: BundleReader,
  filename: FrozenBundleFilename,
  text: string,
  fields: readonly string[],
  schemaVersion: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(text);
  } catch {
    reader.refuse('control_file_shape_invalid', `${filename} is not bounded, strict JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reader.refuse('control_file_shape_invalid', `${filename} must be a JSON object`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    // Canonicalization itself can reject the parse, e.g. an escaped lone surrogate. That is
    // still a refusal to verify, never an untyped error escaping the boundary.
    reader.refuse('canonical_form_mismatch', `${filename} cannot be canonicalized`);
  }
  if (canonical !== text) {
    reader.refuse('canonical_form_mismatch', `${filename} is not in canonical form`);
  }
  let record: Record<string, unknown>;
  try {
    record = assertStrictRecordKeys(parsed as Record<string, unknown>, fields, [], filename);
  } catch (error) {
    reader.refuse('control_file_shape_invalid', (error as Error).message);
  }
  if (record.schemaVersion !== schemaVersion) {
    reader.refuse(
      'control_file_version_unsupported',
      `${filename} declares a schema this verifier does not understand`,
    );
  }
  return record;
}

function readDigestField(
  reader: BundleReader,
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    reader.refuse(
      'control_file_shape_invalid',
      `${label}.${key} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

/** Rebuild a declared render manifest under exactly the rules that produced it. */
function readRenderManifest(
  reader: BundleReader,
  record: Record<string, unknown>,
  label: string,
): readonly RenderManifestItem[] {
  const value = record.renderManifest;
  if (!Array.isArray(value) || value.length === 0) {
    reader.refuse(
      'control_file_shape_invalid',
      `${label}.renderManifest must be a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const items = (value as readonly unknown[]).map((entry, index) => {
    const itemLabel = `${label}.renderManifest[${index.toString()}]`;
    let item: Record<string, unknown>;
    try {
      item = assertStrictRecordKeys(
        entry as Record<string, unknown>,
        ['byteLength', 'logicalFilename', 'mediaType', 'sha256'],
        [],
        itemLabel,
      );
    } catch {
      reader.refuse('control_file_shape_invalid', `${itemLabel} is not a strict manifest entry`);
    }
    let mediaType: RenderManifestItem['mediaType'];
    let logicalFilename: RenderManifestItem['logicalFilename'];
    try {
      logicalFilename = requireSafeArtifactFilename(item.logicalFilename as string);
      mediaType = artifactMediaType(logicalFilename);
    } catch {
      reader.refuse(
        'control_file_shape_invalid',
        `${itemLabel}.logicalFilename is not allowlisted`,
      );
    }
    // The emitted pairing is fixed. A CSV declared as text/html is a rewritten manifest.
    if (item.mediaType !== mediaType) {
      reader.refuse(
        'control_file_shape_invalid',
        `${itemLabel}.mediaType is not the type allowlisted for ${logicalFilename}`,
      );
    }
    if (seen.has(logicalFilename)) {
      reader.refuse('control_file_shape_invalid', `${itemLabel}.logicalFilename is duplicated`);
    }
    seen.add(logicalFilename);
    const byteLength = item.byteLength;
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
      reader.refuse(
        'control_file_shape_invalid',
        `${itemLabel}.byteLength must be a non-negative safe integer`,
      );
    }
    return {
      mediaType,
      logicalFilename,
      byteLength: byteLength as number,
      sha256: readDigestField(reader, item, 'sha256', itemLabel),
    };
  });
  // Manifest order is part of the emitted document, not an incidental array layout.
  const sorted = [...items].sort((left, right) =>
    compareCodeUnits(left.mediaType, right.mediaType),
  );
  if (canonicalJson(items) !== canonicalJson(sorted)) {
    reader.refuse(
      'render_manifest_order_invalid',
      `${label}.renderManifest is not in canonical order`,
    );
  }
  return items;
}

/**
 * Re-verify one already written bundle from disk alone, trusting nothing still in memory.
 *
 * The chain is rooted at `report-freeze.json`: that file's own bytes yield the snapshot ID,
 * it names the exact receipt-core hash, and the two cores must then agree on one render
 * manifest that every rendered artifact's bytes satisfy.
 *
 * Every refusal — a missing file, an unreadable file, corrupt UTF-8, a reordered key, a
 * stray entry — raises {@link FrozenBundleVerificationError} carrying a machine-readable
 * reason. There is deliberately no partial or best-effort result, so a bundle that could
 * not be checked never returns a {@link VerifiedFrozenReportBundle}.
 */
export async function verifyFrozenReportBundleAtPath(
  bundleDirectory: string,
): Promise<VerifiedFrozenReportBundle> {
  const directory = resolve(bundleDirectory);
  const fail: BundleReader['refuse'] = (reason, detail) => {
    throw new FrozenBundleVerificationError(reason, directory, detail);
  };

  let directoryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryStat = await lstat(directory);
  } catch {
    fail('bundle_directory_unreadable', 'bundle directory could not be inspected');
  }
  if (!directoryStat.isDirectory()) {
    fail('bundle_path_not_a_directory', 'bundle path must be a real directory, not a link to one');
  }

  let dirEntries: Dirent[];
  try {
    dirEntries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail('bundle_directory_unreadable', 'bundle directory could not be listed');
  }
  for (const entry of dirEntries) {
    if (!entry.isFile()) {
      fail('bundle_entry_not_a_regular_file', `${entry.name} is not a regular file`);
    }
  }
  const entryNames = new Set(dirEntries.map(({ name }) => name));
  const reader = createBundleReader(directory, entryNames);

  const freeze = await reader.readText(FREEZE_CONTROL_FILE);
  const freezeCore = readControlRecord(
    reader,
    FREEZE_CONTROL_FILE,
    freeze.text,
    FROZEN_CORE_FIELDS,
    FREEZE_CORE_SCHEMA_VERSION,
  );
  const snapshotHash = sha256(freeze.text);
  const snapshotId = `rpf1-${snapshotHash}`;

  if (freezeCore.unsigned !== true || freezeCore.submittable !== false) {
    reader.refuse(
      'snapshot_boundary_violation',
      'a frozen bundle must remain unsigned and non-submittable',
    );
  }
  if (freezeCore.lifecycleState !== 'frozen') {
    reader.refuse('snapshot_boundary_violation', 'report-freeze.json is not a frozen snapshot');
  }
  const reportVersion = freezeCore.reportVersion;
  if (!Number.isSafeInteger(reportVersion) || (reportVersion as number) <= 0) {
    reader.refuse(
      'control_file_shape_invalid',
      'report-freeze.json reportVersion must be a positive safe integer',
    );
  }
  const supersedes = freezeCore.supersedesSnapshotHash;
  if (supersedes !== null) {
    readDigestField(reader, freezeCore, 'supersedesSnapshotHash', FREEZE_CONTROL_FILE);
  }
  const declaredReceiptCoreHash = readDigestField(
    reader,
    freezeCore,
    'receiptCoreHash',
    FREEZE_CONTROL_FILE,
  );
  const declaredReportContentHash = readDigestField(
    reader,
    freezeCore,
    'reportContentHash',
    FREEZE_CONTROL_FILE,
  );
  const freezeManifest = readRenderManifest(reader, freezeCore, FREEZE_CONTROL_FILE);

  const receipt = await reader.readText(RECEIPT_CONTROL_FILE);
  const receiptCore = readControlRecord(
    reader,
    RECEIPT_CONTROL_FILE,
    receipt.text,
    RECEIPT_CORE_FIELDS,
    RECEIPT_CORE_SCHEMA_VERSION,
  );
  const receiptCoreHash = sha256(receipt.text);
  if (receiptCoreHash !== declaredReceiptCoreHash) {
    reader.refuse(
      'receipt_core_hash_mismatch',
      'receipt-core.json bytes do not hash to the receiptCoreHash named by report-freeze.json',
    );
  }
  const receiptId = `rp1-${receiptCoreHash}`;
  if (freezeCore.receiptId !== receiptId) {
    reader.refuse(
      'receipt_core_hash_mismatch',
      'report-freeze.json receiptId is not derived from the receipt core beside it',
    );
  }
  if (receiptCore.unsigned !== true || receiptCore.submittable !== false) {
    reader.refuse(
      'snapshot_boundary_violation',
      'the receipt core must remain unsigned and non-submittable',
    );
  }
  const receiptContentHash = readDigestField(
    reader,
    receiptCore,
    'reportContentHash',
    RECEIPT_CONTROL_FILE,
  );
  if (receiptContentHash !== declaredReportContentHash) {
    reader.refuse(
      'render_manifest_disagreement',
      'the receipt core and the frozen core disagree on the report content hash',
    );
  }
  const receiptManifest = readRenderManifest(reader, receiptCore, RECEIPT_CONTROL_FILE);
  if (canonicalJson(receiptManifest) !== canonicalJson(freezeManifest)) {
    reader.refuse(
      'render_manifest_disagreement',
      'the receipt core and the frozen core disagree on the render manifest',
    );
  }

  for (const item of freezeManifest) {
    const artifact = await reader.readText(item.logicalFilename);
    if (artifact.byteLength !== item.byteLength || sha256(artifact.text) !== item.sha256) {
      reader.refuse(
        'render_artifact_hash_mismatch',
        `${item.logicalFilename} bytes do not match the frozen render manifest`,
      );
    }
  }

  const expected = new Set<string>([
    FREEZE_CONTROL_FILE,
    RECEIPT_CONTROL_FILE,
    ...freezeManifest.map(({ logicalFilename }) => logicalFilename),
  ]);
  for (const name of entryNames) {
    if (!expected.has(name)) {
      reader.refuse('unexpected_bundle_entry', `${name} is not part of the frozen bundle`);
    }
  }

  return Object.freeze({
    schemaVersion: 'frozen-bundle-verification/v1',
    claim: 'bundle bytes match their frozen render manifest',
    bundleDirectory: directory,
    snapshotId,
    snapshotHash,
    receiptId,
    receiptCoreHash,
    reportContentHash: declaredReportContentHash,
    reportVersion: reportVersion as number,
    supersedesSnapshotHash: supersedes as string | null,
    verifiedFilenames: Object.freeze(
      [...expected].sort(compareCodeUnits) as FrozenBundleFilename[],
    ),
    limitations: Object.freeze([
      'byte integrity of one local bundle only; not a signature, authenticity, provenance, or approval proof',
      'the bundle is deliberately unsigned, so anyone holding this tool can regenerate a wholly self-consistent one; this detects alteration of a bundle, never forgery of one',
      'sound only against an independently recorded snapshot ID, which this result returns for exactly that purpose',
      'a superseding snapshot names its predecessor by hash but cannot prove that predecessor from this bundle alone',
      'not a compliance, safety, water-quality, engineering, or regulatory-filing determination',
    ]),
  } as VerifiedFrozenReportBundle);
}
