/** Safe-name and atomic staged-output tests for frozen report bundles. */

import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsFailure = vi.hoisted(() => ({
  failStageCreation: false,
  failRename: false,
  failHandleKind: null as 'directory' | 'file' | null,
  failContainerCleanup: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const kind = args[1] === 'r' ? 'directory' : 'file';
      if (fsFailure.failHandleKind !== kind) return handle;
      return {
        writeFile: async (data: string, options: { readonly encoding: BufferEncoding }) => {
          await handle.writeFile(data, options);
        },
        sync: () => Promise.reject(new Error(`synthetic ${kind} sync failure`)),
        close: async () => {
          await handle.close();
          throw new Error(`synthetic ${kind} close failure`);
        },
      } as unknown as typeof handle;
    },
    mkdtemp: async (prefix: Parameters<typeof actual.mkdtemp>[0]) => {
      if (fsFailure.failStageCreation && prefix.includes('.stage-')) {
        throw new Error('synthetic stage creation failure');
      }
      return actual.mkdtemp(prefix);
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (fsFailure.failRename) {
        throw new Error('synthetic rename failure');
      }
      return actual.rename(oldPath, newPath);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsFailure.failContainerCleanup && String(args[0]).includes('rpf1-')) {
        throw new Error('synthetic container cleanup failure');
      }
      return actual.rm(...args);
    },
  };
});

import {
  freezeReport,
  writeFrozenReportBundleAtomically,
  type FrozenReport,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  fsFailure.failStageCreation = false;
  fsFailure.failRename = false;
  fsFailure.failHandleKind = null;
  fsFailure.failContainerCleanup = false;
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reuseproof-output-test-'));
  cleanupPaths.push(root);
  return root;
}

function unreadProxy<T extends object>(value: T, counter: { reads: number }): T {
  return new Proxy(value, {
    get: () => {
      counter.reads += 1;
      throw new Error('artifact publication must not reread caller Proxy properties');
    },
  });
}

describe('atomic frozen report output', () => {
  it('publishes only a complete allowlisted bundle and reproduces every exact byte', async () => {
    const root = await outputRoot();
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const first = await writeFrozenReportBundleAtomically(root, frozen);
    const second = await writeFrozenReportBundleAtomically(root, frozen);

    expect(first.containerDirectory).not.toBe(second.containerDirectory);
    expect(first.filenames).toEqual([
      'coverage-report.csv',
      'coverage-report.html',
      'coverage-report.json',
      'receipt-core.json',
      'report-freeze.json',
    ]);
    expect(await readdir(first.bundleDirectory)).toEqual(first.filenames);
    expect(
      (await readdir(first.containerDirectory)).filter((name) => name.startsWith('.stage-')),
    ).toEqual([]);

    const expected = new Map<string, string>([
      ...frozen.receipt.renderArtifacts.map(
        ({ logicalFilename, utf8Text }) => [logicalFilename, utf8Text] as const,
      ),
      ['receipt-core.json', frozen.receipt.canonicalCore],
      ['report-freeze.json', frozen.canonicalCore],
    ]);
    for (const filename of first.filenames) {
      const firstBytes = await readFile(join(first.bundleDirectory, filename), 'utf8');
      const secondBytes = await readFile(join(second.bundleDirectory, filename), 'utf8');
      expect(firstBytes).toBe(expected.get(filename));
      expect(secondBytes).toBe(firstBytes);
      const fileStat = await lstat(join(first.bundleDirectory, filename));
      expect(fileStat.isFile()).toBe(true);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a file or symlink as the authority-owned output parent', async () => {
    const root = await outputRoot();
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const filePath = join(root, 'file-parent');
    const linkPath = join(root, 'link-parent');
    await writeFile(filePath, 'not a directory', 'utf8');
    await symlink(root, linkPath, 'dir');

    await expect(writeFrozenReportBundleAtomically(filePath, frozen)).rejects.toThrow(
      'real directory',
    );
    await expect(writeFrozenReportBundleAtomically(linkPath, frozen)).rejects.toThrow(
      'real directory',
    );
  });

  it('validates the complete frozen receipt before touching the output parent', async () => {
    const root = await outputRoot();
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const tampered = {
      ...frozen,
      snapshotId: `rpf1-${'f'.repeat(64)}`,
    } as FrozenReport;

    await expect(writeFrozenReportBundleAtomically(root, tampered)).rejects.toThrow(
      'frozen report integrity',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('publishes only the synchronously validated snapshot when a caller mutates its clone', async () => {
    const root = await outputRoot();
    const original = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const mutable = structuredClone(original);
    const expected = new Map<string, string>([
      ...original.receipt.renderArtifacts.map(
        ({ logicalFilename, utf8Text }) => [logicalFilename, utf8Text] as const,
      ),
      ['receipt-core.json', original.receipt.canonicalCore],
      ['report-freeze.json', original.canonicalCore],
    ]);

    const publication = writeFrozenReportBundleAtomically(root, mutable);
    const jsonArtifact = mutable.receipt.renderArtifacts.find(
      ({ logicalFilename }) => logicalFilename === 'coverage-report.json',
    );
    if (jsonArtifact === undefined) {
      throw new Error('test receipt is missing its JSON artifact');
    }
    Object.assign(jsonArtifact, { utf8Text: '{"tampered":true}\n' });
    Object.assign(mutable.receipt, { canonicalCore: '{"tamperedReceiptCore":true}' });
    Object.assign(mutable, {
      snapshotId: `rpf1-${'f'.repeat(64)}`,
      canonicalCore: '{"tamperedFreezeCore":true}',
    });

    const written = await publication;

    expect(basename(written.containerDirectory).startsWith(`${original.snapshotId}-`)).toBe(true);
    expect(await readdir(written.bundleDirectory)).toEqual([...expected.keys()].sort());
    for (const filename of written.filenames) {
      expect(await readFile(join(written.bundleDirectory, filename), 'utf8')).toBe(
        expected.get(filename),
      );
    }
  });

  it('publishes only recursively normalized descriptor values without Proxy property reads', async () => {
    const root = await outputRoot();
    const original = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const counter = { reads: 0 };
    const proxiedReceipt = unreadProxy(
      {
        ...original.receipt,
        renderArtifacts: unreadProxy([...original.receipt.renderArtifacts], counter),
      },
      counter,
    );
    const proxiedReport = unreadProxy({ ...original, receipt: proxiedReceipt }, counter);
    const expected = new Map<string, string>([
      ...original.receipt.renderArtifacts.map(
        ({ logicalFilename, utf8Text }) => [logicalFilename, utf8Text] as const,
      ),
      ['receipt-core.json', original.receipt.canonicalCore],
      ['report-freeze.json', original.canonicalCore],
    ]);

    const written = await writeFrozenReportBundleAtomically(root, proxiedReport);

    expect(counter.reads).toBe(0);
    expect(basename(written.containerDirectory).startsWith(`${original.snapshotId}-`)).toBe(true);
    for (const filename of written.filenames) {
      expect(await readFile(join(written.bundleDirectory, filename), 'utf8')).toBe(
        expected.get(filename),
      );
    }
  });

  it('removes the private container when staging or atomic publication fails', async () => {
    const root = await outputRoot();
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });

    fsFailure.failStageCreation = true;
    await expect(writeFrozenReportBundleAtomically(root, frozen)).rejects.toThrow(
      'stage creation failure',
    );
    fsFailure.failStageCreation = false;
    expect(await readdir(root)).toEqual([]);

    fsFailure.failRename = true;
    await expect(writeFrozenReportBundleAtomically(root, frozen)).rejects.toThrow('rename failure');
    fsFailure.failRename = false;
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['file', 'directory'] as const)(
    'preserves a %s I/O failure when descriptor cleanup also fails',
    async (kind) => {
      const root = await outputRoot();
      const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
      fsFailure.failHandleKind = kind;

      const error = await writeFrozenReportBundleAtomically(root, frozen).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map(String)).toEqual([
        expect.stringContaining(`synthetic ${kind} sync failure`),
        expect.stringContaining(`synthetic ${kind} close failure`),
      ]);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('surfaces both publication and container-cleanup failures', async () => {
    const root = await outputRoot();
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    fsFailure.failStageCreation = true;
    fsFailure.failContainerCleanup = true;

    const error = await writeFrozenReportBundleAtomically(root, frozen).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors.map(String)).toEqual([
      expect.stringContaining('synthetic stage creation failure'),
      expect.stringContaining('synthetic container cleanup failure'),
    ]);
    expect((await readdir(root)).length).toBe(1);
  });
});
