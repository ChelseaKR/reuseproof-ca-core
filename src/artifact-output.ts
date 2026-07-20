/** Atomic local output boundary for one already frozen deterministic report bundle. */

import {
  lstat,
  mkdtemp,
  open as openFile,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { compareCodeUnits } from './domain/canonical.js';
import { validateFrozenReportIntegrity, type FrozenReport } from './report-lifecycle.js';
import { requireSafeArtifactFilename } from './report-render.js';

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
