/**
 * Re-derive one frozen report from the evaluation input on disk, for a reader who will not
 * write a program.
 *
 * `reuseproof-verify` answers one question: do this directory's bytes still satisfy the render
 * manifest that governs them? That is worth having, and it is not the question a jurisdiction
 * most wants answered. It cannot say that the bundle is *what those inputs produce*, because
 * until `evidence-case/v1` the inputs were not anywhere — they were a live JavaScript object
 * graph inside whatever process happened to run the evaluation.
 *
 * This command is the other question. Given a case directory, it reads every member back over
 * its declared digest, reconstructs the evaluation input, reruns
 * `evaluateReconciledCsvEvidence`, and compares the snapshot ID it derives against one the
 * caller recorded independently. A pass means: these source bytes, under these approved
 * governance objects, produce that report.
 *
 * The same two rules shape it as shape the verifier.
 *
 * A refusal is never a partial replay. Nothing reaches stdout until every check has passed, so
 * there is no output a reader could mistake for a result, and every refusal leaves one
 * machine-readable line on stderr instead. Each `EvidenceCaseRejectionReason` carries its own
 * exit code, so a script can tell a missing member from altered source bytes without parsing
 * prose.
 *
 * A self-consistent case is not a verified one. A case is unsigned, and anyone holding this
 * tool can write a wholly self-consistent one whose replay agrees with itself perfectly. So
 * `--expect-snapshot` is required: omitting it is a usage error, and `--print-only` prints what
 * the case derives while still exiting non-zero, so the missing comparison is visible in the
 * exit code rather than absent from the output.
 *
 * There is one refusal here the verifier has no equivalent for, and it is not hypothetical. A
 * case can read back faultlessly — every digest matched, every member present, every governance
 * object accepted by its own constructor — and still fail to evaluate, because the objects it
 * holds are inconsistent *with each other* in a way only the evaluator sees: two contracts
 * sharing an ID, a series with no governing contract, a scheduled nonoperation against a
 * contract that is not there. The case reader deliberately does not re-implement those
 * cross-object rules, so this arm is reachable from a real directory and is tested from one.
 * It is `replay_refused`, and it is its own exit code rather than an internal error, because
 * the case was read and the input it holds is simply not one this library will evaluate.
 */

import {
  EvidenceCaseError,
  evaluateReconciledCsvEvidence,
  readEvidenceCaseAtPath,
  type EvidenceCaseRejectionReason,
  type ReadEvidenceCase,
  type ReconciledCsvEvidenceInput,
  type ReconciledCsvEvidenceResult,
} from '../src/index.js';

/** Every check passed and the derived snapshot ID matched the one the caller recorded. */
export const EXIT_REPLAYED = 0;
/** The command line was not usable: an unknown flag, a missing argument, no directory. */
export const EXIT_USAGE = 2;
/** The case replayed and derives a different report than the caller recorded. */
export const EXIT_SNAPSHOT_MISMATCH = 3;
/** `--print-only`: the case replayed against itself and against nothing else. */
export const EXIT_NOT_COMPARED = 4;
/** Something failed that is not a refusal this tool models. Never a pass. */
export const EXIT_INTERNAL = 5;
/** The snapshot matched and the recorded root evaluation hash did not. */
export const EXIT_EVALUATION_HASH_MISMATCH = 6;
/** The case read, and the input it holds is not one this library will evaluate. */
export const EXIT_REPLAY_REFUSED = 7;

/**
 * One exit code per refusal reason, so a caller can branch on what went wrong without parsing
 * a message. Declared as a total record over the union: a reason added to
 * `EvidenceCaseRejectionReason` fails to compile here rather than falling into a default that
 * would report it as some other failure.
 */
export const REASON_EXIT_CODES: Readonly<Record<EvidenceCaseRejectionReason, number>> =
  Object.freeze({
    canonical_form_mismatch: 10,
    case_directory_unreadable: 11,
    case_entry_not_a_regular_file: 12,
    case_file_missing: 13,
    case_file_unreadable: 14,
    case_input_shape_invalid: 15,
    case_manifest_order_invalid: 16,
    case_manifest_shape_invalid: 17,
    case_member_digest_mismatch: 18,
    case_path_not_a_directory: 19,
    case_schema_version_unsupported: 20,
    case_source_reference_unknown: 21,
    invalid_utf8: 22,
    unexpected_case_entry: 23,
  });

export const USAGE = [
  'usage: reuseproof-replay <case-directory> --expect-snapshot <snapshot-id>',
  '                         [--expect-evaluation-hash <sha256>] [--json]',
  '       reuseproof-replay <case-directory> --print-only [--json]',
  '',
  'Reads one evidence case, reruns the evaluation it holds, and checks that the report it',
  'derives is the one named by an independently recorded snapshot ID. Reads only the named',
  'directory. No network, no clock, no signature.',
  '',
  '  --expect-snapshot <id>          the snapshot ID recorded when the bundle was issued',
  '  --expect-evaluation-hash <hex>  the root evaluation hash recorded alongside it',
  '  --print-only                    replay the case and print what it derives; always exits ' +
    String(EXIT_NOT_COMPARED) +
    ',',
  '                                  because a self-consistent unsigned case proves nothing on',
  '                                  its own',
  '  --json                          emit the replay result, or the refusal, as JSON',
].join('\n');

export interface ReplayOptions {
  readonly caseDirectory: string;
  readonly expectSnapshot: string | null;
  readonly expectEvaluationHash: string | null;
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

export function parseArguments(argv: readonly string[]): ReplayOptions {
  const remaining = [...argv];
  let caseDirectory: string | null = null;
  let expectSnapshot: string | null = null;
  let expectEvaluationHash: string | null = null;
  let printOnly = false;
  let json = false;
  while (remaining.length > 0) {
    const argument = remaining.shift();
    if (argument === undefined) {
      break;
    }
    if (argument === '--expect-snapshot') {
      expectSnapshot = takeValue(remaining, '--expect-snapshot');
    } else if (argument === '--expect-evaluation-hash') {
      expectEvaluationHash = takeValue(remaining, '--expect-evaluation-hash');
    } else if (argument === '--print-only') {
      printOnly = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${argument}`);
    } else if (caseDirectory !== null) {
      throw new UsageError('exactly one case directory may be given');
    } else {
      caseDirectory = argument;
    }
  }
  if (caseDirectory === null) {
    throw new UsageError('a case directory is required');
  }
  if (expectSnapshot === null && !printOnly) {
    throw new UsageError(
      'either --expect-snapshot <id> or --print-only is required; a self-consistent unsigned case proves nothing on its own',
    );
  }
  if (expectSnapshot !== null && printOnly) {
    throw new UsageError('--print-only cannot be combined with --expect-snapshot');
  }
  if (expectEvaluationHash !== null && printOnly) {
    throw new UsageError('--print-only cannot be combined with --expect-evaluation-hash');
  }
  return Object.freeze({
    caseDirectory,
    expectSnapshot,
    expectEvaluationHash,
    printOnly,
    json,
  });
}

/** What one replay derived, for printing after every check has passed. */
export interface ReplayedIdentifiers {
  readonly caseId: string;
  readonly caseInputHash: string;
  readonly snapshotId: string;
  readonly receiptId: string;
  readonly evaluationHash: string;
  readonly seriesCount: number;
  readonly memberCount: number;
}

function identifiers(
  read: ReadEvidenceCase,
  result: ReconciledCsvEvidenceResult,
): ReplayedIdentifiers {
  return Object.freeze({
    caseId: read.caseId,
    caseInputHash: read.caseInputHash,
    snapshotId: result.frozenReport.snapshotId,
    receiptId: result.receipt.receiptId,
    evaluationHash: result.evaluationHash,
    seriesCount: result.series.length,
    memberCount: read.members.length,
  });
}

function replayedLines(read: ReadEvidenceCase, derived: ReplayedIdentifiers): readonly string[] {
  return [
    ...read.members.map(
      (member) =>
        `member ${member.logicalFilename} bytes=${String(member.byteLength)} sha256=${member.sha256}`,
    ),
    `case-id ${derived.caseId}`,
    `case-input-hash ${derived.caseInputHash}`,
    `series ${String(derived.seriesCount)}`,
    `snapshot-id ${derived.snapshotId}`,
    `receipt-id ${derived.receiptId}`,
    `evaluation-hash ${derived.evaluationHash}`,
  ];
}

/**
 * What to say about something thrown that this command does not model.
 *
 * Split out so the non-Error arm can be shown to fire without a test having to reject a promise
 * with a non-Error value, which the lint rules forbid for good reasons.
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
 * The two library calls this command makes, named so a test can stand in for them.
 *
 * One fail-closed arm below cannot be reached with a real case on a real disk: the reader
 * refusing with something that is not an `EvidenceCaseError`. It must still be shown to fire,
 * because an arm that has never fired is a claim rather than a check, and this seam is how.
 * The `replay_refused` arm does not need the seam — a case whose contracts share an ID reaches
 * it from disk — and it is exercised that way instead, because a stub proves the branch runs
 * and a real case proves the branch is right. The defaults are the real functions.
 */
export interface ReplayDependencies {
  readonly readCase: (directory: string) => Promise<ReadEvidenceCase>;
  readonly evaluate: (input: ReconciledCsvEvidenceInput) => ReconciledCsvEvidenceResult;
}

const REAL_DEPENDENCIES: ReplayDependencies = Object.freeze({
  readCase: readEvidenceCaseAtPath,
  evaluate: evaluateReconciledCsvEvidence,
});

/**
 * Run one replay. Returns the process exit code and writes nothing itself, so the caller
 * decides where output goes and a test can read it without a subprocess.
 */
export async function runReplay(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  dependencies: ReplayDependencies = REAL_DEPENDENCIES,
): Promise<number> {
  let options: ReplayOptions;
  try {
    options = parseArguments(argv);
  } catch (thrown) {
    const message = thrown instanceof UsageError ? thrown.message : 'arguments could not be read';
    err(`${refusalLine({ reason: 'usage', exit: EXIT_USAGE, detail: message })}\n`);
    err(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  let read: ReadEvidenceCase;
  try {
    read = await dependencies.readCase(options.caseDirectory);
  } catch (thrown) {
    if (thrown instanceof EvidenceCaseError) {
      const exit = REASON_EXIT_CODES[thrown.reason];
      if (options.json) {
        out(
          `${JSON.stringify(
            {
              refused: true,
              reason: thrown.reason,
              caseDirectory: thrown.caseDirectory,
              exit,
            },
            null,
            2,
          )}\n`,
        );
      }
      err(
        `${refusalLine({
          reason: thrown.reason,
          exit,
          case: thrown.caseDirectory,
          detail: thrown.message,
        })}\n`,
      );
      return exit;
    }
    err(
      `${refusalLine({
        reason: 'internal_error',
        exit: EXIT_INTERNAL,
        case: options.caseDirectory,
        detail: describeThrown(thrown, 'a non-error value was thrown'),
      })}\n`,
    );
    return EXIT_INTERNAL;
  }

  let result: ReconciledCsvEvidenceResult;
  try {
    result = dependencies.evaluate(read.input);
  } catch (thrown) {
    err(
      `${refusalLine({
        reason: 'replay_refused',
        exit: EXIT_REPLAY_REFUSED,
        case: read.caseDirectory,
        detail: describeThrown(thrown, 'a non-error value was thrown'),
      })}\n`,
    );
    return EXIT_REPLAY_REFUSED;
  }
  const derived = identifiers(read, result);

  if (options.printOnly) {
    out(`${replayedLines(read, derived).join('\n')}\n`);
    out('not compared: no --expect-snapshot was given, so this case was replayed only\n');
    out('against itself. An unsigned case can be written whole; a snapshot ID you recorded\n');
    out('elsewhere is what makes this evidence.\n');
    if (options.json) {
      out(`${JSON.stringify(derived, null, 2)}\n`);
    }
    return EXIT_NOT_COMPARED;
  }

  if (derived.snapshotId !== options.expectSnapshot) {
    if (options.json) {
      out(
        `${JSON.stringify(
          {
            refused: true,
            reason: 'snapshot_id_mismatch',
            caseDirectory: read.caseDirectory,
            expectedSnapshotId: options.expectSnapshot,
            actualSnapshotId: derived.snapshotId,
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
        case: read.caseDirectory,
        expected: options.expectSnapshot ?? '',
        actual: derived.snapshotId,
      })}\n`,
    );
    return EXIT_SNAPSHOT_MISMATCH;
  }

  if (
    options.expectEvaluationHash !== null &&
    derived.evaluationHash !== options.expectEvaluationHash
  ) {
    if (options.json) {
      out(
        `${JSON.stringify(
          {
            refused: true,
            reason: 'evaluation_hash_mismatch',
            caseDirectory: read.caseDirectory,
            expectedEvaluationHash: options.expectEvaluationHash,
            actualEvaluationHash: derived.evaluationHash,
            exit: EXIT_EVALUATION_HASH_MISMATCH,
          },
          null,
          2,
        )}\n`,
      );
    }
    err(
      `${refusalLine({
        reason: 'evaluation_hash_mismatch',
        exit: EXIT_EVALUATION_HASH_MISMATCH,
        case: read.caseDirectory,
        expected: options.expectEvaluationHash,
        actual: derived.evaluationHash,
      })}\n`,
    );
    return EXIT_EVALUATION_HASH_MISMATCH;
  }

  if (options.json) {
    out(
      `${JSON.stringify({ ...derived, claim: read.claim, limitations: read.limitations }, null, 2)}\n`,
    );
    return EXIT_REPLAYED;
  }
  out(`${replayedLines(read, derived).join('\n')}\n`);
  out(`replayed ${read.claim}\n`);
  // Narrowed to a string by the mismatch check above: reaching here means the derived snapshot
  // ID and the recorded one are the same value.
  out(`replayed snapshot-id matches the recorded ${options.expectSnapshot}\n`);
  if (options.expectEvaluationHash !== null) {
    out(`replayed evaluation-hash matches the recorded ${options.expectEvaluationHash}\n`);
  }
  for (const limitation of read.limitations) {
    out(`limitation ${limitation}\n`);
  }
  return EXIT_REPLAYED;
}
