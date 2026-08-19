/** On-disk verification of an already written frozen bundle, and the attacks it refuses. */

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FROZEN_CORE_FIELDS,
  FrozenBundleVerificationError,
  RECEIPT_CORE_FIELDS,
  canonicalJson,
  freezeReport,
  parseBoundedJson,
  sha256,
  verifyFrozenReportBundleAtPath,
  writeFrozenReportBundleAtomically,
  type FrozenBundleRejectionReason,
  type FrozenReport,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

const parents: string[] = [];

async function newParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'frozen-bundle-verify-'));
  parents.push(parent);
  return parent;
}

async function writeBundle(report?: FrozenReport): Promise<string> {
  const parent = await newParent();
  const frozen = report ?? freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
  const written = await writeFrozenReportBundleAtomically(parent, frozen);
  return written.bundleDirectory;
}

/** Overwrite a bundle file, bypassing the 0o600 write-once mode the writer sets. */
async function overwrite(directory: string, filename: string, text: string): Promise<void> {
  const path = join(directory, filename);
  await chmod(path, 0o600);
  await writeFile(path, text, 'utf8');
}

async function readControl(directory: string, filename: string): Promise<Record<string, unknown>> {
  return parseBoundedJson(await readFile(join(directory, filename), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function expectRefusal(
  directory: string,
  reason: FrozenBundleRejectionReason,
): Promise<FrozenBundleVerificationError> {
  const error = await verifyFrozenReportBundleAtPath(directory).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected a refusal (${reason}) but the bundle verified`).toBeInstanceOf(
    FrozenBundleVerificationError,
  );
  const refusal = error as FrozenBundleVerificationError;
  expect(refusal.reason).toBe(reason);
  expect(refusal.bundleDirectory).toBe(directory);
  return refusal;
}

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    await rm(parent, { recursive: true, force: true });
  }
});

describe('verifyFrozenReportBundleAtPath', () => {
  it('verifies an untouched bundle and returns the identifiers needed to compare it', async () => {
    const report = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const directory = await writeBundle(report);
    const verified = await verifyFrozenReportBundleAtPath(directory);

    expect(verified.schemaVersion).toBe('frozen-bundle-verification/v1');
    expect(verified.claim).toBe('bundle bytes match their frozen render manifest');
    expect(verified.bundleDirectory).toBe(directory);
    expect(verified.snapshotId).toBe(report.snapshotId);
    expect(verified.snapshotHash).toBe(report.snapshotHash);
    expect(verified.receiptId).toBe(report.receipt.receiptId);
    expect(verified.receiptCoreHash).toBe(report.receipt.coreHash);
    expect(verified.reportContentHash).toBe(report.receipt.reportContentHash);
    expect(verified.reportVersion).toBe(1);
    expect(verified.supersedesSnapshotHash).toBeNull();
    expect(verified.verifiedFilenames).toEqual([
      'coverage-report.csv',
      'coverage-report.html',
      'coverage-report.json',
      'receipt-core.json',
      'report-freeze.json',
    ]);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('verifies a superseding snapshot and reports the predecessor it names', async () => {
    const first = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const second = freezeReport({
      receipt: createTestReceipt({
        receiptOverrides: { pinnedVersions: [{ name: 'algorithm', value: 'coverage-v1-rerun' }] },
      }),
      reportVersion: 2,
      supersededReport: first,
    });
    const verified = await verifyFrozenReportBundleAtPath(await writeBundle(second));
    expect(verified.reportVersion).toBe(2);
    expect(verified.supersedesSnapshotHash).toBe(first.snapshotHash);
  });

  it('states that it proves alteration only, never authenticity', async () => {
    const verified = await verifyFrozenReportBundleAtPath(await writeBundle());
    expect(verified.limitations).toHaveLength(5);
    expect(verified.limitations[1]).toContain('detects alteration of a bundle, never forgery');
    expect(verified.limitations.join(' ')).toContain('not a signature');
    expect(verified.limitations.join(' ')).toContain('independently recorded snapshot ID');
  });

  it('resolves a relative bundle path to the directory it actually verified', async () => {
    const directory = await writeBundle();
    const verified = await verifyFrozenReportBundleAtPath(`${directory}/./`);
    expect(verified.bundleDirectory).toBe(directory);
  });
});

describe('on-disk alteration attacks', () => {
  it('A1 catches the edited HTML that flips the draft status to approved', async () => {
    const directory = await writeBundle();
    const original = await readFile(join(directory, 'coverage-report.html'), 'utf8');
    expect(original).toContain('Draft—not submitted; human review required');
    await overwrite(
      directory,
      'coverage-report.html',
      original.replace('Draft—not submitted; human review required', 'FINAL APPROVED'),
    );
    const refusal = await expectRefusal(directory, 'render_artifact_hash_mismatch');
    expect(refusal.message).toContain('coverage-report.html');
  });

  it('A2 catches an edited CSV row', async () => {
    const directory = await writeBundle();
    const original = await readFile(join(directory, 'coverage-report.csv'), 'utf8');
    await overwrite(directory, 'coverage-report.csv', `${original}extra,row,of,evidence\n`);
    await expectRefusal(directory, 'render_artifact_hash_mismatch');
  });

  it('A3 catches an edited JSON artifact even when it stays valid JSON', async () => {
    const directory = await writeBundle();
    const artifact = await readControl(directory, 'coverage-report.json');
    await overwrite(
      directory,
      'coverage-report.json',
      canonicalJson({ ...artifact, injected: true }),
    );
    await expectRefusal(directory, 'render_artifact_hash_mismatch');
  });

  it('A4 catches a truncated artifact', async () => {
    const directory = await writeBundle();
    const original = await readFile(join(directory, 'coverage-report.html'), 'utf8');
    await overwrite(directory, 'coverage-report.html', original.slice(0, original.length - 20));
    await expectRefusal(directory, 'render_artifact_hash_mismatch');
  });

  it('A5 catches a same-length substitution that keeps the byte count identical', async () => {
    const directory = await writeBundle();
    const original = await readFile(join(directory, 'coverage-report.csv'), 'utf8');
    const swapped = original.replace(/1/, '9');
    expect(swapped).not.toBe(original);
    expect(Buffer.byteLength(swapped, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'));
    await overwrite(directory, 'coverage-report.csv', swapped);
    await expectRefusal(directory, 'render_artifact_hash_mismatch');
  });

  it('A6 catches invalid UTF-8 rather than decoding it lossily into a hash comparison', async () => {
    const directory = await writeBundle();
    const path = join(directory, 'coverage-report.html');
    await chmod(path, 0o600);
    await writeFile(path, Buffer.from([0x3c, 0x68, 0x74, 0xff, 0xfe, 0x6d, 0x6c]));
    await expectRefusal(directory, 'invalid_utf8');
  });

  it('A7 catches a deleted artifact', async () => {
    const directory = await writeBundle();
    await rm(join(directory, 'coverage-report.csv'));
    await expectRefusal(directory, 'bundle_file_missing');
  });

  it('A8 catches a deleted receipt core', async () => {
    const directory = await writeBundle();
    await rm(join(directory, 'receipt-core.json'));
    await expectRefusal(directory, 'bundle_file_missing');
  });

  it('A9 catches a deleted freeze control file', async () => {
    const directory = await writeBundle();
    await rm(join(directory, 'report-freeze.json'));
    await expectRefusal(directory, 'bundle_file_missing');
  });

  it('A10 catches a manifest patched to match the altered artifact in the freeze core only', async () => {
    const directory = await writeBundle();
    const html = await readFile(join(directory, 'coverage-report.html'), 'utf8');
    const forged = html.replace('Draft—not submitted; human review required', 'FINAL APPROVED');
    await overwrite(directory, 'coverage-report.html', forged);
    const freeze = await readControl(directory, 'report-freeze.json');
    const manifest = (freeze.renderManifest as Record<string, unknown>[]).map((item) =>
      item.logicalFilename === 'coverage-report.html'
        ? {
            ...item,
            byteLength: Buffer.byteLength(forged, 'utf8'),
            sha256: sha256(forged),
          }
        : item,
    );
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, renderManifest: manifest }),
    );
    // The freeze core now agrees with the altered bytes, so the receipt core is the witness.
    await expectRefusal(directory, 'render_manifest_disagreement');
  });

  it('A11 catches a manifest patched in both control files without rehashing the chain', async () => {
    const directory = await writeBundle();
    const html = await readFile(join(directory, 'coverage-report.html'), 'utf8');
    const forged = html.replace('Draft—not submitted; human review required', 'FINAL APPROVED');
    await overwrite(directory, 'coverage-report.html', forged);
    const patch = (core: Record<string, unknown>): Record<string, unknown> => ({
      ...core,
      renderManifest: (core.renderManifest as Record<string, unknown>[]).map((item) =>
        item.logicalFilename === 'coverage-report.html'
          ? { ...item, byteLength: Buffer.byteLength(forged, 'utf8'), sha256: sha256(forged) }
          : item,
      ),
    });
    await overwrite(
      directory,
      'receipt-core.json',
      canonicalJson(patch(await readControl(directory, 'receipt-core.json'))),
    );
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson(patch(await readControl(directory, 'report-freeze.json'))),
    );
    // Both manifests agree with the altered bytes, but receipt-core.json no longer hashes to
    // the digest report-freeze.json names.
    await expectRefusal(directory, 'receipt_core_hash_mismatch');
  });

  it('A12 catches a receipt core rehashed into the freeze core without a new snapshot ID', async () => {
    const directory = await writeBundle();
    const receipt = await readControl(directory, 'receipt-core.json');
    const forgedReceipt = canonicalJson({ ...receipt, tenantId: 'tenant-someone-else' });
    await overwrite(directory, 'receipt-core.json', forgedReceipt);
    const forgedHash = sha256(forgedReceipt);
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, receiptCoreHash: forgedHash }),
    );
    // receiptCoreHash was updated but the derived receiptId beside it was not.
    await expectRefusal(directory, 'receipt_core_hash_mismatch');
  });

  it('A13 catches the unsigned/non-submittable boundary being flipped in the freeze core', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, submittable: true }),
    );
    await expectRefusal(directory, 'snapshot_boundary_violation');
  });

  it('A14 catches the unsigned flag being cleared in the freeze core', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(directory, 'report-freeze.json', canonicalJson({ ...freeze, unsigned: false }));
    await expectRefusal(directory, 'snapshot_boundary_violation');
  });

  it('A15 catches a lifecycle state promoted away from frozen', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, lifecycleState: 'submitted' }),
    );
    await expectRefusal(directory, 'snapshot_boundary_violation');
  });

  it('A16 catches the boundary being flipped in the receipt core alone', async () => {
    const directory = await writeBundle();
    const receipt = await readControl(directory, 'receipt-core.json');
    const forged = canonicalJson({ ...receipt, submittable: true });
    await overwrite(directory, 'receipt-core.json', forged);
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        receiptCoreHash: sha256(forged),
        receiptId: `rp1-${sha256(forged)}`,
      }),
    );
    await expectRefusal(directory, 'snapshot_boundary_violation');
  });

  it('A17 catches a whole-file swap between two different bundles', async () => {
    const first = await writeBundle();
    const second = await writeBundle(
      freezeReport({
        receipt: createTestReceipt({ tenantId: 'tenant-2', systemId: 'system-2' }),
        reportVersion: 1,
      }),
    );
    await overwrite(
      first,
      'coverage-report.json',
      await readFile(join(second, 'coverage-report.json'), 'utf8'),
    );
    await expectRefusal(first, 'render_artifact_hash_mismatch');
  });

  it('A18 catches a wholesale swap of the receipt core from another bundle', async () => {
    const first = await writeBundle();
    const second = await writeBundle(
      freezeReport({
        receipt: createTestReceipt({ tenantId: 'tenant-2', systemId: 'system-2' }),
        reportVersion: 1,
      }),
    );
    await overwrite(
      first,
      'receipt-core.json',
      await readFile(join(second, 'receipt-core.json'), 'utf8'),
    );
    await expectRefusal(first, 'receipt_core_hash_mismatch');
  });

  it('A19 catches a pretty-printed control file that parses to the same value', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(directory, 'report-freeze.json', JSON.stringify(freeze, null, 2));
    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('A20 catches a control file whose keys were reordered', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'receipt-core.json');
    const reversed = Object.fromEntries(Object.entries(freeze).reverse());
    await overwrite(directory, 'receipt-core.json', JSON.stringify(reversed));
    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('A21 catches a control file carrying an escaped lone surrogate', async () => {
    const directory = await writeBundle();
    await overwrite(directory, 'report-freeze.json', '{"claim":"\\ud800"}');
    await expectRefusal(directory, 'canonical_form_mismatch');
  });

  it('A22 catches an injected extra field in a control file', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, approvedBy: 'the district engineer' }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A23 catches a removed field in a control file', async () => {
    const directory = await writeBundle();
    const { limitations: _dropped, ...rest } = await readControl(directory, 'report-freeze.json');
    await overwrite(directory, 'report-freeze.json', canonicalJson(rest));
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A24 catches a control file that declares an unrecognized schema version', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, schemaVersion: 'frozen-report-core/v9' }),
    );
    await expectRefusal(directory, 'control_file_version_unsupported');
  });

  it('A25 catches a receipt core that declares an unrecognized schema version', async () => {
    const directory = await writeBundle();
    const receipt = await readControl(directory, 'receipt-core.json');
    const forged = canonicalJson({ ...receipt, schemaVersion: 'receipt-core/v1' });
    await overwrite(directory, 'receipt-core.json', forged);
    await expectRefusal(directory, 'control_file_version_unsupported');
  });

  it('A26 catches a manifest entry whose media type no longer matches its filename', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: (freeze.renderManifest as Record<string, unknown>[]).map((item) =>
          item.logicalFilename === 'coverage-report.csv'
            ? { ...item, mediaType: 'text/html' }
            : item,
        ),
      }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A27 catches a manifest reordered out of its canonical media-type order', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: [...(freeze.renderManifest as unknown[])].reverse(),
      }),
    );
    await expectRefusal(directory, 'render_manifest_order_invalid');
  });

  it('A28 catches a manifest entry duplicated to shadow a real one', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    const manifest = freeze.renderManifest as Record<string, unknown>[];
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: [manifest[0], manifest[0], ...manifest.slice(1)],
      }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A29 catches a manifest entry naming a file outside the allowlist', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    const manifest = freeze.renderManifest as Record<string, unknown>[];
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: [
          { ...manifest[0], logicalFilename: '../escape.json' },
          ...manifest.slice(1),
        ],
      }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A30 catches an emptied manifest that would otherwise verify nothing', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, renderManifest: [] }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A31 catches a manifest byte length rewritten to a fractional value', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    const manifest = freeze.renderManifest as Record<string, unknown>[];
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: [{ ...manifest[0], byteLength: 1.5 }, ...manifest.slice(1)],
      }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A32 catches a manifest digest rewritten to a non-digest', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    const manifest = freeze.renderManifest as Record<string, unknown>[];
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        renderManifest: [{ ...manifest[0], sha256: 'A'.repeat(64) }, ...manifest.slice(1)],
      }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A33 catches a manifest entry that is not an object', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, renderManifest: ['coverage-report.csv'] }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A34 catches a manifest replaced by a non-array', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, renderManifest: {} }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A35 catches a report version rewritten to zero', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, reportVersion: 0 }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A36 catches a supersession hash rewritten to something that is not a digest', async () => {
    const directory = await writeBundle();
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({ ...freeze, supersedesSnapshotHash: 'earlier-report' }),
    );
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A37 catches the two cores disagreeing on the report content hash', async () => {
    const directory = await writeBundle();
    const receipt = await readControl(directory, 'receipt-core.json');
    const forged = canonicalJson({ ...receipt, reportContentHash: 'b'.repeat(64) });
    await overwrite(directory, 'receipt-core.json', forged);
    const freeze = await readControl(directory, 'report-freeze.json');
    await overwrite(
      directory,
      'report-freeze.json',
      canonicalJson({
        ...freeze,
        receiptCoreHash: sha256(forged),
        receiptId: `rp1-${sha256(forged)}`,
      }),
    );
    await expectRefusal(directory, 'render_manifest_disagreement');
  });

  it('A38 catches a control file that is no longer JSON at all', async () => {
    const directory = await writeBundle();
    await overwrite(directory, 'report-freeze.json', 'not json');
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A39 catches a control file replaced by a JSON array', async () => {
    const directory = await writeBundle();
    await overwrite(directory, 'report-freeze.json', '[]');
    await expectRefusal(directory, 'control_file_shape_invalid');
  });

  it('A40 catches a stray extra file smuggled into the bundle', async () => {
    const directory = await writeBundle();
    await writeFile(join(directory, 'signed-approval.pdf'), 'approved', 'utf8');
    const refusal = await expectRefusal(directory, 'unexpected_bundle_entry');
    expect(refusal.message).toContain('signed-approval.pdf');
  });

  it('A41 catches a stray dotfile smuggled into the bundle', async () => {
    const directory = await writeBundle();
    await writeFile(join(directory, '.DS_Store'), 'x', 'utf8');
    await expectRefusal(directory, 'unexpected_bundle_entry');
  });

  it('A42 catches a nested directory added inside the bundle', async () => {
    const directory = await writeBundle();
    await mkdir(join(directory, 'attachments'));
    await expectRefusal(directory, 'bundle_entry_not_a_regular_file');
  });

  it('A43 catches an artifact replaced by a symlink to intact bytes elsewhere', async () => {
    const directory = await writeBundle();
    const decoy = join(await newParent(), 'decoy.html');
    await writeFile(decoy, await readFile(join(directory, 'coverage-report.html'), 'utf8'), 'utf8');
    await rm(join(directory, 'coverage-report.html'));
    await symlink(decoy, join(directory, 'coverage-report.html'));
    await expectRefusal(directory, 'bundle_entry_not_a_regular_file');
  });

  it('A44 catches a bundle path that is itself a symlink to a real bundle', async () => {
    const directory = await writeBundle();
    const link = join(await newParent(), 'artifacts');
    await symlink(directory, link);
    await expectRefusal(link, 'bundle_path_not_a_directory');
  });

  it('A45 catches a bundle path pointing at a regular file', async () => {
    const parent = await newParent();
    const path = join(parent, 'artifacts');
    await writeFile(path, 'not a bundle', 'utf8');
    await expectRefusal(path, 'bundle_path_not_a_directory');
  });

  it('A46 catches a bundle directory that does not exist', async () => {
    const parent = await newParent();
    await expectRefusal(join(parent, 'absent'), 'bundle_directory_unreadable');
  });

  it('A47 catches a bundle file that cannot be read', async () => {
    const directory = await writeBundle();
    const path = join(directory, 'report-freeze.json');
    await chmod(path, 0o000);
    try {
      await expectRefusal(directory, 'bundle_file_unreadable');
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('A48 catches a bundle directory that cannot be listed', async () => {
    const directory = await writeBundle();
    await chmod(directory, 0o000);
    try {
      await expectRefusal(directory, 'bundle_directory_unreadable');
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

describe('the miss this verifier does not hide', () => {
  it('M1 accepts a wholly rehashed forgery, because the bundle is deliberately unsigned', async () => {
    const directory = await writeBundle();
    const html = await readFile(join(directory, 'coverage-report.html'), 'utf8');
    const forgedHtml = html.replace(
      'Draft—not submitted; human review required',
      'FINAL APPROVED-------------',
    );
    expect(forgedHtml).not.toBe(html);
    await overwrite(directory, 'coverage-report.html', forgedHtml);

    const patchManifest = (core: Record<string, unknown>): Record<string, unknown> => ({
      ...core,
      renderManifest: (core.renderManifest as Record<string, unknown>[]).map((item) =>
        item.logicalFilename === 'coverage-report.html'
          ? {
              ...item,
              byteLength: Buffer.byteLength(forgedHtml, 'utf8'),
              sha256: sha256(forgedHtml),
            }
          : item,
      ),
    });

    const forgedReceipt = canonicalJson(
      patchManifest(await readControl(directory, 'receipt-core.json')),
    );
    await overwrite(directory, 'receipt-core.json', forgedReceipt);
    const forgedReceiptHash = sha256(forgedReceipt);
    const forgedFreeze = canonicalJson({
      ...patchManifest(await readControl(directory, 'report-freeze.json')),
      receiptCoreHash: forgedReceiptHash,
      receiptId: `rp1-${forgedReceiptHash}`,
    });
    await overwrite(directory, 'report-freeze.json', forgedFreeze);

    // This is the documented gap, asserted rather than hidden: with no signature there is
    // nothing to forge, so a consistently rehashed bundle verifies.
    const verified = await verifyFrozenReportBundleAtPath(directory);
    expect(
      (await readFile(join(directory, 'coverage-report.html'), 'utf8')).includes('FINAL APPROVED'),
    ).toBe(true);

    // The one thing that does change is the snapshot ID. Verification is sound only when
    // compared against a snapshot ID recorded somewhere this tool cannot reach.
    expect(verified.snapshotId).toBe(`rpf1-${sha256(forgedFreeze)}`);
    expect(verified.snapshotId).not.toBe(
      (await verifyFrozenReportBundleAtPath(await writeBundle())).snapshotId,
    );
    expect(verified.limitations[1]).toContain('never forgery');
  });
});

describe('control-file field pins', () => {
  it('match exactly what the freezing pipeline emits today', async () => {
    const directory = await writeBundle();
    expect(Object.keys(await readControl(directory, 'report-freeze.json')).sort()).toEqual(
      [...FROZEN_CORE_FIELDS].sort(),
    );
    expect(Object.keys(await readControl(directory, 'receipt-core.json')).sort()).toEqual(
      [...RECEIPT_CORE_FIELDS].sort(),
    );
  });
});
