/**
 * Offline byte-integrity check of one frozen bundle, for a reader who will not write a program.
 *
 * `verifyFrozenReportBundleAtPath` has been able to re-verify a written bundle from disk
 * alone since ADR-0003, and only a TypeScript caller could reach it. A records clerk, a
 * State Board reader, or a jurisdiction auditor holding an independently recorded snapshot
 * ID had no way to use it. This is that boundary as a command.
 *
 * Two rules shape everything here.
 *
 * A refusal is never a partial verification. Nothing is written to stdout until every check
 * has passed, so there is no output a reader could mistake for a result, and every refusal
 * leaves one machine-readable line on stderr instead. Each `FrozenBundleRejectionReason`
 * carries its own exit code, so a script can tell a missing file from altered bytes without
 * parsing prose.
 *
 * A self-consistent bundle is not a verified one. The README says on-disk verification is
 * sound only against an independently recorded snapshot ID, because the bundle is unsigned
 * and anyone holding this tool can regenerate a wholly self-consistent one. So
 * `--expect-snapshot` is required: omitting it is a usage error, and `--print-only` prints
 * the bundle's own identifiers while still exiting non-zero, so the missing comparison is
 * visible in the exit code rather than absent from the output.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  FrozenBundleVerificationError,
  parseBoundedJson,
  sha256,
  verifyFrozenReportBundleAtPath,
  type FrozenBundleRejectionReason,
  type VerifiedFrozenReportBundle,
} from '../src/index.js';

/** Every check passed and the snapshot ID matched the one the caller recorded. */
export const EXIT_VERIFIED = 0;
/** The command line was not usable: an unknown flag, a missing argument, no directory. */
export const EXIT_USAGE = 2;
/** The bundle is internally consistent and is not the bundle the caller recorded. */
export const EXIT_SNAPSHOT_MISMATCH = 3;
/** `--print-only`: the bundle verified against itself and against nothing else. */
export const EXIT_NOT_COMPARED = 4;
/** Something failed that is not a refusal this tool models. Never a pass. */
export const EXIT_INTERNAL = 5;
/** The bundle changed on disk between verification and reading its manifest back. */
export const EXIT_BUNDLE_CHANGED_DURING_READ = 6;

/**
 * One exit code per refusal reason, so a caller can branch on what went wrong without
 * parsing a message. Declared as a total record over the union: a reason added to
 * `FrozenBundleRejectionReason` fails to compile here rather than falling into a default
 * that would report it as some other failure.
 */
export const REASON_EXIT_CODES: Readonly<Record<FrozenBundleRejectionReason, number>> =
  Object.freeze({
    bundle_directory_unreadable: 10,
    bundle_entry_not_a_regular_file: 11,
    bundle_file_missing: 12,
    bundle_file_unreadable: 13,
    bundle_path_not_a_directory: 14,
    canonical_form_mismatch: 15,
    control_file_shape_invalid: 16,
    control_file_version_unsupported: 17,
    invalid_utf8: 18,
    receipt_core_hash_mismatch: 19,
    render_artifact_hash_mismatch: 20,
    render_manifest_disagreement: 21,
    render_manifest_order_invalid: 22,
    snapshot_boundary_violation: 23,
    unexpected_bundle_entry: 24,
  });

export const USAGE = [
  'usage: reuseproof-verify <bundle-directory> --expect-snapshot <snapshot-id> [--json]',
  '       reuseproof-verify <bundle-directory> --print-only [--json]',
  '',
  'Checks that every byte of one frozen bundle still satisfies the render manifest that',
  'governs it, and that the bundle is the one named by an independently recorded snapshot',
  'ID. Reads only the named directory. No network, no clock, no signature.',
  '',
  '  --expect-snapshot <id>  the snapshot ID recorded when the bundle was issued',
  '  --print-only            verify the bundle against itself and print what it claims to',
  '                          be; always exits ' +
    String(EXIT_NOT_COMPARED) +
    ', because a self-consistent',
  '                          unsigned bundle proves nothing on its own',
  '  --json                  emit the verification result, or the refusal, as JSON',
].join('\n');

export interface VerifyOptions {
  readonly bundleDirectory: string;
  readonly expectSnapshot: string | null;
  readonly printOnly: boolean;
  readonly json: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function takeValue(remaining: string[], flag: string): string {
  const value = remaining.shift();
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

export function parseArguments(argv: readonly string[]): VerifyOptions {
  const remaining = [...argv];
  let bundleDirectory: string | null = null;
  let expectSnapshot: string | null = null;
  let printOnly = false;
  let json = false;
  while (remaining.length > 0) {
    const argument = remaining.shift();
    if (argument === undefined) {
      break;
    }
    if (argument === '--expect-snapshot') {
      expectSnapshot = takeValue(remaining, '--expect-snapshot');
    } else if (argument === '--print-only') {
      printOnly = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${argument}`);
    } else if (bundleDirectory !== null) {
      throw new UsageError('exactly one bundle directory may be given');
    } else {
      bundleDirectory = argument;
    }
  }
  if (bundleDirectory === null) {
    throw new UsageError('a bundle directory is required');
  }
  if (expectSnapshot === null && !printOnly) {
    throw new UsageError(
      'either --expect-snapshot <id> or --print-only is required; a self-consistent unsigned bundle proves nothing on its own',
    );
  }
  if (expectSnapshot !== null && printOnly) {
    throw new UsageError('--print-only cannot be combined with --expect-snapshot');
  }
  return Object.freeze({ bundleDirectory, expectSnapshot, printOnly, json });
}

/** One artifact as the frozen manifest describes it, for printing after verification. */
export interface VerifiedArtifactLine {
  readonly logicalFilename: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** The bundle stopped being the bundle that verified. Never a partial pass. */
export class BundleChangedError extends Error {}

/**
 * The render manifest the verification just matched, read back for display.
 *
 * The verification does not return the per-artifact byte lengths and digests, and the file
 * is read a second time to print them. That second read is anchored, not trusted: the
 * snapshot ID is derived from `report-freeze.json`'s own bytes, so requiring it to equal the
 * one verification returned proves this is the same file that was verified. A bundle edited
 * between the two reads fails here rather than being printed as verified.
 */
export async function readVerifiedManifest(
  verified: VerifiedFrozenReportBundle,
): Promise<readonly VerifiedArtifactLine[]> {
  const bytes = await readFile(join(verified.bundleDirectory, 'report-freeze.json'));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BundleChangedError('report-freeze.json is no longer valid UTF-8');
  }
  if (`rpf1-${sha256(text)}` !== verified.snapshotId) {
    throw new BundleChangedError('report-freeze.json changed between verification and read-back');
  }
  const core = parseBoundedJson(text);
  const manifest = (core as Record<string, unknown>).renderManifest;
  if (!Array.isArray(manifest)) {
    throw new BundleChangedError('report-freeze.json carries no render manifest');
  }
  return manifest.map((entry) => {
    const item = entry as Record<string, unknown>;
    if (
      typeof item.logicalFilename !== 'string' ||
      typeof item.byteLength !== 'number' ||
      typeof item.sha256 !== 'string'
    ) {
      throw new BundleChangedError('render manifest entry is not in the verified shape');
    }
    return Object.freeze({
      logicalFilename: item.logicalFilename,
      byteLength: item.byteLength,
      sha256: item.sha256,
    });
  });
}

function verifiedLines(
  verified: VerifiedFrozenReportBundle,
  artifacts: readonly VerifiedArtifactLine[],
): readonly string[] {
  return [
    ...artifacts.map(
      (item) =>
        `artifact ${item.logicalFilename} bytes=${String(item.byteLength)} sha256=${item.sha256}`,
    ),
    `snapshot-id ${verified.snapshotId}`,
    `receipt-core-hash ${verified.receiptCoreHash}`,
    `report-content-hash ${verified.reportContentHash}`,
    `report-version ${String(verified.reportVersion)}`,
    `supersedes-snapshot-hash ${verified.supersedesSnapshotHash ?? 'none'}`,
  ];
}

/**
 * What to say about something thrown that this command does not model.
 *
 * Split out so the non-Error arm can be shown to fire without a test having to reject a
 * promise with a non-Error value, which the lint rules forbid for good reasons.
 */
export function describeThrown(thrown: unknown, fallback: string): string {
  return thrown instanceof Error ? thrown.message : fallback;
}

function refusalLine(fields: Readonly<Record<string, string | number>>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/**
 * The one library call this command makes, named so a test can stand in for it.
 *
 * Two of the fail-closed arms below cannot be reached with a real bundle on a real disk:
 * the library refusing with something that is not a `FrozenBundleVerificationError`, and
 * the bundle changing between verification and the manifest read-back. Both must still be
 * shown to fire, because an arm that has never fired is a claim rather than a check. This
 * seam is how, and it is the whole of it: the default is the real function.
 */
export interface VerifyDependencies {
  readonly verifyBundle: (directory: string) => Promise<VerifiedFrozenReportBundle>;
}

const REAL_DEPENDENCIES: VerifyDependencies = Object.freeze({
  verifyBundle: verifyFrozenReportBundleAtPath,
});

/**
 * Run one verification. Returns the process exit code and writes nothing itself, so the
 * caller decides where output goes and a test can read it without a subprocess.
 */
export async function runVerify(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  dependencies: VerifyDependencies = REAL_DEPENDENCIES,
): Promise<number> {
  let options: VerifyOptions;
  try {
    options = parseArguments(argv);
  } catch (thrown) {
    const message = thrown instanceof UsageError ? thrown.message : 'arguments could not be read';
    err(`${refusalLine({ reason: 'usage', exit: EXIT_USAGE, detail: message })}\n`);
    err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const directory = resolve(options.bundleDirectory);

  let verified: VerifiedFrozenReportBundle;
  try {
    verified = await dependencies.verifyBundle(directory);
  } catch (thrown) {
    if (thrown instanceof FrozenBundleVerificationError) {
      const exit = REASON_EXIT_CODES[thrown.reason];
      if (options.json) {
        out(
          `${JSON.stringify(
            { refused: true, reason: thrown.reason, bundleDirectory: directory, exit },
            null,
            2,
          )}\n`,
        );
      }
      err(
        `${refusalLine({ reason: thrown.reason, exit, bundle: directory, detail: thrown.message })}\n`,
      );
      return exit;
    }
    err(
      `${refusalLine({
        reason: 'internal_error',
        exit: EXIT_INTERNAL,
        bundle: directory,
        detail: describeThrown(thrown, 'a non-error value was thrown'),
      })}\n`,
    );
    return EXIT_INTERNAL;
  }

  let artifacts: readonly VerifiedArtifactLine[];
  try {
    artifacts = await readVerifiedManifest(verified);
  } catch (thrown) {
    err(
      `${refusalLine({
        reason: 'bundle_changed_during_read',
        exit: EXIT_BUNDLE_CHANGED_DURING_READ,
        bundle: directory,
        detail: describeThrown(thrown, 'the bundle could not be read back'),
      })}\n`,
    );
    return EXIT_BUNDLE_CHANGED_DURING_READ;
  }

  if (options.printOnly) {
    out(`${verifiedLines(verified, artifacts).join('\n')}\n`);
    out('not compared: no --expect-snapshot was given, so this bundle was checked only\n');
    out('against itself. An unsigned bundle can be regenerated whole; a snapshot ID you\n');
    out('recorded elsewhere is what makes this evidence.\n');
    if (options.json) {
      out(`${JSON.stringify(verified, null, 2)}\n`);
    }
    return EXIT_NOT_COMPARED;
  }

  if (verified.snapshotId !== options.expectSnapshot) {
    if (options.json) {
      out(
        `${JSON.stringify(
          {
            refused: true,
            reason: 'snapshot_id_mismatch',
            bundleDirectory: directory,
            expectedSnapshotId: options.expectSnapshot,
            actualSnapshotId: verified.snapshotId,
            exit: EXIT_SNAPSHOT_MISMATCH,
          },
          null,
          2,
        )}\n`,
      );
    }
    err(
      `${refusalLine({
        reason: 'snapshot_id_mismatch',
        exit: EXIT_SNAPSHOT_MISMATCH,
        bundle: directory,
        expected: options.expectSnapshot ?? '',
        actual: verified.snapshotId,
      })}\n`,
    );
    return EXIT_SNAPSHOT_MISMATCH;
  }

  if (options.json) {
    out(`${JSON.stringify(verified, null, 2)}\n`);
    return EXIT_VERIFIED;
  }
  out(`${verifiedLines(verified, artifacts).join('\n')}\n`);
  out(`verified ${verified.claim}\n`);
  out(`verified snapshot-id matches the recorded ${options.expectSnapshot}\n`);
  for (const limitation of verified.limitations) {
    out(`limitation ${limitation}\n`);
  }
  return EXIT_VERIFIED;
}
