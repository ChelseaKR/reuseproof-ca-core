/**
 * The gate step that runs both published commands against one shipped fixture, end to end.
 *
 * `npm run demo:check` proves the evaluation still runs. It does not prove that either command
 * this package installs still works, because neither is executed anywhere in `make verify`, and
 * a `bin` that is never run is a claim rather than a check. This step runs them: it writes the
 * demo evaluation's frozen bundle and its evidence case into one temporary container, then
 * spawns `reuseproof-verify` against the bundle and `reuseproof-replay` against the case,
 * requiring exit 0 from each.
 *
 * Three things make it a real gate rather than a smoke test.
 *
 * It compares against identifiers derived *here*, in this process, from the fixture — not
 * against whatever the commands print. `--expect-snapshot` is the whole point of both binaries,
 * and passing them a value scraped from their own output would be a comparison with nothing.
 *
 * It reads each command's exit code from the spawned process, never from a pipe. A shell
 * pipeline reports the last stage's status, and a command whose refusal is piped into anything
 * has had its verdict discarded.
 *
 * It fails closed on an empty run, in the shape ADR-0011 requires. If the fixture ever stops
 * carrying source objects, or the case is written with nothing in it, this step says so and
 * exits non-zero rather than reporting a clean replay of nothing. On success it states what it
 * covered.
 *
 * The shipped fixture is also the interesting multiplicity case: its first series submits the
 * same source bytes twice. Content addressing stores one file for the two, so a replay that
 * lost the second reference would still find every digest present and would still derive a
 * different operational hash. That is the case this step actually exercises.
 *
 *     node dist/scripts/demo-case.js [fixture-path]
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateReconciledCsvEvidence,
  parseBoundedJson,
  writeEvidenceCaseAtomically,
  writeFrozenReportBundleAtomically,
} from '../src/index.js';
import { reconciledFixtureInput } from './demo-fixture.js';

const repositoryRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function binary(name: string): string {
  return join(repositoryRoot, 'bin', name);
}

/** Run one published command and return the exit code the process itself reported. */
async function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [command, ...args], { stdio: 'inherit' });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (code === null) {
        fail(new Error(`${command} was terminated by ${signal ?? 'an unknown signal'}`));
        return;
      }
      settle(code);
    });
  });
}

function fail(message: string): never {
  process.stderr.write(`demo-case: ${message}\n`);
  process.exit(1);
}

const fixturePath = resolve(process.argv[2] ?? 'fixtures/reconciled-demo.json');
const input = reconciledFixtureInput(parseBoundedJson(await readFile(fixturePath, 'utf8')));

const submittedSources = input.series.reduce(
  (total, series) => total + series.sourceObjects.length,
  0,
);
if (submittedSources === 0) {
  fail(
    `${fixturePath} submits no source object, so a replay over it would check nothing. Fix the fixture rather than letting this step report a clean run it never made.`,
  );
}

const result = evaluateReconciledCsvEvidence(input);
const snapshotId = result.frozenReport.snapshotId;
const evaluationHash = result.evaluationHash;

const container = await mkdtemp(join(tmpdir(), 'reuseproof-demo-case-'));
try {
  const bundle = await writeFrozenReportBundleAtomically(container, result.frozenReport);
  const evidenceCase = await writeEvidenceCaseAtomically(container, input);

  const storedSources = evidenceCase.members.filter(
    ({ logicalFilename }) => logicalFilename !== 'case-input.json',
  ).length;
  if (storedSources === 0) {
    fail('the written case holds no source object, so the replay below would check nothing');
  }

  const verified = await run(binary('reuseproof-verify.js'), [
    bundle.bundleDirectory,
    '--expect-snapshot',
    snapshotId,
  ]);
  if (verified !== 0) {
    fail(`reuseproof-verify exited ${verified.toString()} against the demo bundle`);
  }

  const replayed = await run(binary('reuseproof-replay.js'), [
    evidenceCase.caseDirectory,
    '--expect-snapshot',
    snapshotId,
    '--expect-evaluation-hash',
    evaluationHash,
  ]);
  if (replayed !== 0) {
    fail(`reuseproof-replay exited ${replayed.toString()} against the demo case`);
  }

  process.stdout.write(
    `demo-case: verified 1 bundle and replayed 1 case (${evidenceCase.members.length.toString()} members, ` +
      `${storedSources.toString()} stored source object(s) for ${submittedSources.toString()} submission(s), ` +
      `${result.series.length.toString()} series) against snapshot ${snapshotId}\n`,
  );
} finally {
  await rm(container, { recursive: true, force: true });
}
