/** Deterministic report freezing plus separate human/runtime association records. */

import { canonicalJson, compareCodeUnits, sha256 } from './domain/canonical.js';
import { deepFreeze, instantMilliseconds } from './domain/model.js';
import { requireStrictArray, requireStrictRecord } from './domain/validation.js';
import {
  type NamedHash,
  type RenderManifestItem,
  type UnsignedReceipt,
  validateUnsignedReceiptIntegrity,
} from './domain/receipt.js';
import { NON_DETERMINATION_LIMITATION, RECEIPT_CLAIM } from './report-render.js';

export interface FrozenReportCore {
  readonly schemaVersion: 'frozen-report-core/v1';
  readonly reportKind: 'evidence_coverage_draft';
  readonly lifecycleState: 'frozen';
  readonly claim: typeof RECEIPT_CLAIM;
  readonly reportVersion: number;
  readonly unsigned: true;
  readonly submittable: false;
  readonly submissionBoundary: 'external evidence record only';
  readonly receiptId: string;
  readonly receiptCoreHash: string;
  readonly reportContentHash: string;
  readonly renderManifest: readonly RenderManifestItem[];
  readonly supersedesSnapshotHash: string | null;
  readonly limitations: readonly [typeof NON_DETERMINATION_LIMITATION];
}

export interface FrozenReport {
  readonly receipt: UnsignedReceipt;
  readonly supersededReport: FrozenReport | null;
  readonly core: FrozenReportCore;
  readonly canonicalCore: string;
  readonly snapshotHash: string;
  readonly snapshotId: string;
}

export interface FreezeReportInput {
  readonly receipt: UnsignedReceipt;
  readonly reportVersion: number;
  readonly supersededReport?: FrozenReport | null;
}

export interface ExternalSubmissionRecordCore {
  readonly schemaVersion: 'external-submission-record/v1';
  readonly recordKind: 'user-recorded external submission evidence';
  readonly performedOutsideReuseProof: true;
  readonly acceptanceStatus: 'not claimed';
  readonly frozenReportId: string;
  readonly receiptId: string;
  readonly submittedAt: string;
  readonly destination: string;
  readonly submittedByActorReference: string;
  readonly proofHashes: readonly NamedHash[];
  readonly externalTrackingReference: string | null;
  readonly limitations: readonly [typeof NON_DETERMINATION_LIMITATION];
}

export interface ExternalSubmissionRecord {
  readonly core: ExternalSubmissionRecordCore;
  readonly canonicalCore: string;
  readonly recordHash: string;
  readonly recordId: string;
}

export interface ExternalSubmissionRecordInput {
  readonly frozenReport: FrozenReport;
  readonly submittedAt: string;
  readonly destination: string;
  readonly submittedByActorReference: string;
  readonly proofHashes: readonly NamedHash[];
  readonly externalTrackingReference?: string | null;
}

export interface HumanAttestation {
  readonly attestationId: string;
  readonly kind: 'human report-freeze review recorded';
  readonly actorReference: string;
  readonly role: string;
  readonly attestedAt: string;
}

export interface ReceiptSupersessionLink {
  readonly priorReceiptId: string;
  readonly relationship: 'supersedes';
}

export interface VerificationEnvelopeCore {
  readonly schemaVersion: 'verification-envelope/v1';
  readonly associationOnly: true;
  readonly frozenReportId: string;
  readonly frozenReportHash: string;
  readonly reportVersion: number;
  readonly receiptId: string;
  readonly receiptCoreHash: string;
  readonly createdAt: string;
  readonly humanAttestations: readonly HumanAttestation[];
  readonly auditReferences: readonly string[];
  readonly externalSubmissionRecords: readonly {
    readonly recordId: string;
    readonly core: ExternalSubmissionRecordCore;
  }[];
  readonly supersessionLinks: readonly ReceiptSupersessionLink[];
  readonly signedControlPlaneBundleReferences: readonly NamedHash[];
  readonly claimBoundary: 'does not sign, certify, submit, or approve the receipt';
}

export interface VerificationEnvelope {
  readonly core: VerificationEnvelopeCore;
  readonly canonicalEnvelope: string;
  readonly envelopeHash: string;
  readonly envelopeId: string;
}

export interface VerificationEnvelopeInput {
  readonly frozenReport: FrozenReport;
  readonly createdAt: string;
  readonly humanAttestations?: readonly HumanAttestation[];
  readonly auditReferences?: readonly string[];
  readonly externalSubmissionRecords?: readonly ExternalSubmissionRecord[];
  readonly supersessionLinks?: readonly ReceiptSupersessionLink[];
  readonly signedControlPlaneBundleReferences?: readonly NamedHash[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text without control characters`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  return requireStrictArray(value, label);
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireReceiptId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^rp1-[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a hash-derived receipt ID`);
  }
  return value;
}

function requireFrozenReportId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^rpf1-[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a hash-derived frozen report ID`);
  }
  return value;
}

function normalizeNamedHashes(
  value: unknown,
  label: string,
  requireCanonicalOrder = false,
): readonly NamedHash[] {
  const values = requireArray(value, label);
  if (values.length === 0) {
    throw new TypeError(`${label} requires at least one hash`);
  }
  const normalized = values.map((item, index) => {
    const itemLabel = `${label}[${index.toString()}]`;
    const record = requireStrictRecord(item, ['logicalName', 'sha256'], [], itemLabel);
    return {
      logicalName: requireText(record.logicalName, `${label} logical name`),
      sha256: requireDigest(record.sha256, label),
    };
  });
  if (new Set(normalized.map(({ logicalName }) => logicalName)).size !== normalized.length) {
    throw new TypeError(`${label} logical names must be unique`);
  }
  const sorted = [...normalized].sort((left, right) =>
    compareCodeUnits(left.logicalName, right.logicalName),
  );
  if (requireCanonicalOrder && canonicalJson(normalized) !== canonicalJson(sorted)) {
    throw new RangeError(`${label} must use canonical logical-name order`);
  }
  return sorted;
}

function requireUniqueText(
  value: unknown,
  label: string,
  requireCanonicalOrder = false,
): readonly string[] {
  const normalized = requireArray(value, label).map((item) => requireText(item, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} values must be unique`);
  }
  const sorted = [...normalized].sort(compareCodeUnits);
  if (requireCanonicalOrder && canonicalJson(normalized) !== canonicalJson(sorted)) {
    throw new RangeError(`${label} values must use canonical order`);
  }
  return sorted;
}

const lifecycleMediaTypes = ['application/json', 'text/csv', 'text/html'] as const;
const lifecycleArtifactFilenames = [
  'coverage-report.csv',
  'coverage-report.html',
  'coverage-report.json',
] as const;

function normalizeRenderManifest(value: unknown, label: string): readonly RenderManifestItem[] {
  return requireArray(value, label).map((item, index) => {
    const itemLabel = `${label}[${index.toString()}]`;
    const record = requireStrictRecord(
      item,
      ['mediaType', 'logicalFilename', 'byteLength', 'sha256'],
      [],
      itemLabel,
    );
    if (
      typeof record.mediaType !== 'string' ||
      !(lifecycleMediaTypes as readonly string[]).includes(record.mediaType)
    ) {
      throw new TypeError(`${itemLabel}.mediaType is not supported`);
    }
    if (
      typeof record.logicalFilename !== 'string' ||
      !(lifecycleArtifactFilenames as readonly string[]).includes(record.logicalFilename)
    ) {
      throw new TypeError(`${itemLabel}.logicalFilename is not supported`);
    }
    if (
      typeof record.byteLength !== 'number' ||
      !Number.isSafeInteger(record.byteLength) ||
      record.byteLength < 0
    ) {
      throw new RangeError(`${itemLabel}.byteLength must be a non-negative safe integer`);
    }
    return {
      mediaType: record.mediaType as RenderManifestItem['mediaType'],
      logicalFilename: record.logicalFilename as RenderManifestItem['logicalFilename'],
      byteLength: record.byteLength,
      sha256: requireDigest(record.sha256, `${itemLabel}.sha256`),
    };
  });
}

function requireLimitationArray(value: unknown, label: string): readonly string[] {
  return requireArray(value, label).map((item, index) =>
    requireText(item, `${label}[${index.toString()}]`),
  );
}

interface ParsedFrozenReportNode {
  readonly source: FrozenReport;
  readonly report: FrozenReport;
  readonly core: FrozenReportCore;
  readonly renderManifest: readonly RenderManifestItem[];
}

function parseFrozenReportNode(value: unknown): ParsedFrozenReportNode {
  const outer = requireStrictRecord(
    value,
    ['receipt', 'supersededReport', 'core', 'canonicalCore', 'snapshotHash', 'snapshotId'],
    [],
    'frozen report',
  );
  const core = requireStrictRecord(
    outer.core,
    [
      'schemaVersion',
      'reportKind',
      'lifecycleState',
      'claim',
      'reportVersion',
      'unsigned',
      'submittable',
      'submissionBoundary',
      'receiptId',
      'receiptCoreHash',
      'reportContentHash',
      'renderManifest',
      'supersedesSnapshotHash',
      'limitations',
    ],
    [],
    'frozen report core',
  );
  const renderManifest = normalizeRenderManifest(
    core.renderManifest,
    'frozen report core renderManifest',
  );
  const limitations = requireLimitationArray(core.limitations, 'frozen report core limitations');
  if (typeof core.unsigned !== 'boolean' || typeof core.submittable !== 'boolean') {
    throw new TypeError('frozen report boundary flags must be boolean');
  }
  const supersedesSnapshotHash =
    core.supersedesSnapshotHash === null
      ? null
      : requireDigest(core.supersedesSnapshotHash, 'superseded snapshot hash');
  const normalizedCore = {
    schemaVersion: requireText(core.schemaVersion, 'frozen report core schemaVersion'),
    reportKind: requireText(core.reportKind, 'frozen report core reportKind'),
    lifecycleState: requireText(core.lifecycleState, 'frozen report core lifecycleState'),
    claim: requireText(core.claim, 'frozen report core claim'),
    reportVersion: core.reportVersion,
    unsigned: core.unsigned,
    submittable: core.submittable,
    submissionBoundary: requireText(
      core.submissionBoundary,
      'frozen report core submissionBoundary',
    ),
    receiptId: requireReceiptId(core.receiptId, 'frozen report core receipt ID'),
    receiptCoreHash: requireDigest(core.receiptCoreHash, 'frozen report core receipt hash'),
    reportContentHash: requireDigest(core.reportContentHash, 'frozen report content hash'),
    renderManifest,
    supersedesSnapshotHash,
    limitations,
  } as unknown as FrozenReportCore;
  const report = {
    receipt: outer.receipt,
    supersededReport: outer.supersededReport,
    core: normalizedCore,
    canonicalCore: requireText(outer.canonicalCore, 'frozen report canonical core'),
    snapshotHash: requireDigest(outer.snapshotHash, 'frozen report snapshot hash'),
    snapshotId: requireFrozenReportId(outer.snapshotId, 'frozen report snapshot ID'),
  } as unknown as FrozenReport;
  return {
    source: value as FrozenReport,
    report,
    core: normalizedCore,
    renderManifest,
  };
}

interface ParsedExternalSubmissionRecord {
  readonly record: ExternalSubmissionRecord;
  readonly core: ExternalSubmissionRecordCore;
  readonly proofHashes: readonly NamedHash[];
}

function parseExternalSubmissionCore(value: unknown): {
  readonly core: ExternalSubmissionRecordCore;
  readonly proofHashes: readonly NamedHash[];
} {
  const core = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'recordKind',
      'performedOutsideReuseProof',
      'acceptanceStatus',
      'frozenReportId',
      'receiptId',
      'submittedAt',
      'destination',
      'submittedByActorReference',
      'proofHashes',
      'externalTrackingReference',
      'limitations',
    ],
    [],
    'external submission record core',
  );
  const proofHashes = normalizeNamedHashes(core.proofHashes, 'external submission proof', true);
  const limitations = requireLimitationArray(
    core.limitations,
    'external submission record core limitations',
  );
  if (typeof core.performedOutsideReuseProof !== 'boolean') {
    throw new TypeError('external submission performedOutsideReuseProof must be boolean');
  }
  const externalTrackingReference =
    core.externalTrackingReference === null
      ? null
      : requireText(core.externalTrackingReference, 'external submission tracking reference');
  const normalizedCore = {
    schemaVersion: requireText(core.schemaVersion, 'external submission schemaVersion'),
    recordKind: requireText(core.recordKind, 'external submission recordKind'),
    performedOutsideReuseProof: core.performedOutsideReuseProof,
    acceptanceStatus: requireText(core.acceptanceStatus, 'external submission acceptanceStatus'),
    frozenReportId: requireFrozenReportId(
      core.frozenReportId,
      'external submission frozen report ID',
    ),
    receiptId: requireReceiptId(core.receiptId, 'external submission receipt ID'),
    submittedAt: requireText(core.submittedAt, 'external submission time'),
    destination: requireText(core.destination, 'external submission destination'),
    submittedByActorReference: requireText(
      core.submittedByActorReference,
      'external submission actor reference',
    ),
    proofHashes,
    externalTrackingReference,
    limitations,
  } as unknown as ExternalSubmissionRecordCore;
  return {
    core: normalizedCore,
    proofHashes,
  };
}

function parseExternalSubmissionRecord(value: unknown): ParsedExternalSubmissionRecord {
  const outer = requireStrictRecord(
    value,
    ['core', 'canonicalCore', 'recordHash', 'recordId'],
    [],
    'external submission record',
  );
  const parsedCore = parseExternalSubmissionCore(outer.core);
  return {
    record: outer as unknown as ExternalSubmissionRecord,
    core: parsedCore.core,
    proofHashes: parsedCore.proofHashes,
  };
}

function parseVerificationEnvelope(value: unknown): {
  readonly envelope: VerificationEnvelope;
  readonly core: VerificationEnvelopeCore;
} {
  const outer = requireStrictRecord(
    value,
    ['core', 'canonicalEnvelope', 'envelopeHash', 'envelopeId'],
    [],
    'verification envelope',
  );
  const core = requireStrictRecord(
    outer.core,
    [
      'schemaVersion',
      'associationOnly',
      'frozenReportId',
      'frozenReportHash',
      'reportVersion',
      'receiptId',
      'receiptCoreHash',
      'createdAt',
      'humanAttestations',
      'auditReferences',
      'externalSubmissionRecords',
      'supersessionLinks',
      'signedControlPlaneBundleReferences',
      'claimBoundary',
    ],
    [],
    'verification envelope core',
  );
  requireArray(core.humanAttestations, 'verification envelope humanAttestations');
  requireArray(core.auditReferences, 'verification envelope auditReferences');
  requireArray(core.externalSubmissionRecords, 'verification envelope externalSubmissionRecords');
  requireArray(core.supersessionLinks, 'verification envelope supersessionLinks');
  requireArray(
    core.signedControlPlaneBundleReferences,
    'verification envelope signedControlPlaneBundleReferences',
  );
  return {
    envelope: outer as unknown as VerificationEnvelope,
    core: core as unknown as VerificationEnvelopeCore,
  };
}

/** Pin one receipt and exact render manifest into a deterministic versioned draft snapshot. */
export function freezeReport(input: FreezeReportInput): FrozenReport {
  const strictInput = requireStrictRecord(
    input,
    ['receipt', 'reportVersion'],
    ['supersededReport'],
    'freeze report input',
  );
  const receipt = validateUnsignedReceiptIntegrity(strictInput.receipt as UnsignedReceipt);
  const reportVersion = strictInput.reportVersion;
  if (!Number.isSafeInteger(reportVersion) || (reportVersion as number) <= 0) {
    throw new RangeError('report version must be a positive safe integer');
  }
  const normalizedReportVersion = reportVersion as number;
  const supersededValue = (
    Object.hasOwn(strictInput, 'supersededReport') ? strictInput.supersededReport : null
  ) as FrozenReport | null;
  if (supersededValue !== null && typeof supersededValue !== 'object') {
    throw new TypeError('superseded frozen report must be an object or null');
  }
  if (normalizedReportVersion === 1 && supersededValue !== null) {
    throw new RangeError('report version 1 cannot supersede another snapshot');
  }
  if (normalizedReportVersion > 1 && supersededValue === null) {
    throw new RangeError('report versions after 1 must include the superseded frozen report');
  }
  let supersededReport: FrozenReport | null = null;
  if (supersededValue !== null) {
    supersededReport = validateFrozenReportIntegrity(supersededValue);
    if (normalizedReportVersion !== supersededReport.core.reportVersion + 1) {
      throw new RangeError('report version must immediately follow the superseded report version');
    }
    if (
      receipt.core.tenantId !== supersededReport.receipt.core.tenantId ||
      receipt.core.systemId !== supersededReport.receipt.core.systemId ||
      canonicalJson(receipt.core.reportPeriod) !==
        canonicalJson(supersededReport.receipt.core.reportPeriod)
    ) {
      throw new RangeError('superseded frozen report belongs to a different report scope');
    }
  }
  const supersedesSnapshotHash = supersededReport?.snapshotHash ?? null;
  const core: FrozenReportCore = deepFreeze({
    schemaVersion: 'frozen-report-core/v1',
    reportKind: 'evidence_coverage_draft',
    lifecycleState: 'frozen',
    claim: RECEIPT_CLAIM,
    reportVersion: normalizedReportVersion,
    unsigned: true,
    submittable: false,
    submissionBoundary: 'external evidence record only',
    receiptId: receipt.receiptId,
    receiptCoreHash: receipt.coreHash,
    reportContentHash: receipt.reportContentHash,
    renderManifest: receipt.renderManifest,
    supersedesSnapshotHash,
    limitations: [NON_DETERMINATION_LIMITATION],
  });
  const canonicalCore = canonicalJson(core);
  const snapshotHash = sha256(canonicalCore);
  return deepFreeze({
    receipt,
    supersededReport,
    core,
    canonicalCore,
    snapshotHash,
    snapshotId: `rpf1-${snapshotHash}`,
  });
}

/** Recheck a frozen snapshot and every linked receipt/render hash. */
export function validateFrozenReportIntegrity(report: FrozenReport): FrozenReport {
  const seen = new Set<FrozenReport>();
  const validatedReceipts = new Map<FrozenReport, UnsignedReceipt>();
  const validatedNodes: {
    readonly receipt: UnsignedReceipt;
    readonly core: FrozenReportCore;
    readonly canonicalCore: string;
    readonly snapshotHash: string;
    readonly snapshotId: string;
  }[] = [];
  let currentNode: ParsedFrozenReportNode | null = parseFrozenReportNode(report);
  while (currentNode !== null) {
    if (seen.has(currentNode.source)) {
      throw new RangeError('frozen report supersession chain contains a cycle');
    }
    seen.add(currentNode.source);
    const current: FrozenReport = currentNode.report;
    const currentCore: FrozenReportCore = currentNode.core;
    const receipt =
      validatedReceipts.get(currentNode.source) ??
      validateUnsignedReceiptIntegrity(current.receipt);
    validatedReceipts.set(currentNode.source, receipt);
    if (!Number.isSafeInteger(currentCore.reportVersion) || currentCore.reportVersion <= 0) {
      throw new RangeError('frozen report version must be a positive safe integer');
    }
    const priorValue: FrozenReport | null = current.supersededReport;
    const priorNode: ParsedFrozenReportNode | null =
      priorValue === null ? null : parseFrozenReportNode(priorValue);
    if (
      (currentCore.reportVersion === 1 && priorNode !== null) ||
      (currentCore.reportVersion > 1 && priorNode === null)
    ) {
      throw new RangeError('frozen report supersession does not match its version');
    }
    if (priorNode !== null) {
      if (
        !Number.isSafeInteger(priorNode.core.reportVersion) ||
        priorNode.core.reportVersion <= 0
      ) {
        throw new RangeError('frozen report version must be a positive safe integer');
      }
      const priorReceipt =
        validatedReceipts.get(priorNode.source) ??
        validateUnsignedReceiptIntegrity(priorNode.report.receipt);
      validatedReceipts.set(priorNode.source, priorReceipt);
      if (currentCore.reportVersion !== priorNode.core.reportVersion + 1) {
        throw new RangeError('frozen report versions must form a sequential chain');
      }
      if (
        receipt.core.tenantId !== priorReceipt.core.tenantId ||
        receipt.core.systemId !== priorReceipt.core.systemId ||
        canonicalJson(receipt.core.reportPeriod) !== canonicalJson(priorReceipt.core.reportPeriod)
      ) {
        throw new RangeError('frozen report supersession chain crosses report scope');
      }
    }
    const supersedesSnapshotHash = priorNode?.report.snapshotHash ?? null;
    if (currentCore.supersedesSnapshotHash !== supersedesSnapshotHash) {
      throw new RangeError('frozen report does not identify its exact superseded snapshot');
    }
    if (currentCore.supersedesSnapshotHash !== null) {
      requireDigest(currentCore.supersedesSnapshotHash, 'superseded snapshot hash');
    }
    const expectedCore: FrozenReportCore = {
      schemaVersion: 'frozen-report-core/v1',
      reportKind: 'evidence_coverage_draft',
      lifecycleState: 'frozen',
      claim: RECEIPT_CLAIM,
      reportVersion: currentCore.reportVersion,
      unsigned: true,
      submittable: false,
      submissionBoundary: 'external evidence record only',
      receiptId: receipt.receiptId,
      receiptCoreHash: receipt.coreHash,
      reportContentHash: receipt.reportContentHash,
      renderManifest: receipt.renderManifest,
      supersedesSnapshotHash,
      limitations: [NON_DETERMINATION_LIMITATION],
    };
    const canonicalCore = canonicalJson(currentCore);
    const snapshotHash = sha256(canonicalCore);
    const boundary: { readonly unsigned: boolean; readonly submittable: boolean } = currentCore;
    if (
      current.canonicalCore !== canonicalCore ||
      current.snapshotHash !== snapshotHash ||
      current.snapshotId !== `rpf1-${snapshotHash}` ||
      currentCore.receiptId !== receipt.receiptId ||
      currentCore.receiptCoreHash !== receipt.coreHash ||
      currentCore.reportContentHash !== receipt.reportContentHash ||
      canonicalJson(currentNode.renderManifest) !== canonicalJson(receipt.renderManifest) ||
      !boundary.unsigned ||
      boundary.submittable ||
      canonicalCore !== canonicalJson(expectedCore)
    ) {
      throw new RangeError('frozen report integrity check failed');
    }
    validatedNodes.push({
      receipt,
      core: expectedCore,
      canonicalCore,
      snapshotHash,
      snapshotId: `rpf1-${snapshotHash}`,
    });
    currentNode = priorNode;
  }
  let safePrior: FrozenReport | null = null;
  for (let index = validatedNodes.length - 1; index >= 0; index -= 1) {
    const node = validatedNodes[index];
    if (node === undefined) {
      throw new RangeError('frozen report validation produced an incomplete snapshot chain');
    }
    safePrior = deepFreeze({
      receipt: node.receipt,
      supersededReport: safePrior,
      core: node.core,
      canonicalCore: node.canonicalCore,
      snapshotHash: node.snapshotHash,
      snapshotId: node.snapshotId,
    });
  }
  if (safePrior === null) {
    throw new RangeError('frozen report validation requires one snapshot');
  }
  return safePrior;
}

/** Record user-supplied proof of an external action without claiming receipt or acceptance. */
export function createExternalSubmissionRecord(
  input: ExternalSubmissionRecordInput,
): ExternalSubmissionRecord {
  const strictInput = requireStrictRecord(
    input,
    ['frozenReport', 'submittedAt', 'destination', 'submittedByActorReference', 'proofHashes'],
    ['externalTrackingReference'],
    'external submission input',
  );
  const frozenReport = validateFrozenReportIntegrity(strictInput.frozenReport as FrozenReport);
  const submittedAt = requireText(strictInput.submittedAt, 'external submission time');
  const destination = requireText(strictInput.destination, 'external submission destination');
  const submittedByActorReference = requireText(
    strictInput.submittedByActorReference,
    'external submission actor reference',
  );
  const proofHashes = normalizeNamedHashes(strictInput.proofHashes, 'external submission proof');
  instantMilliseconds(submittedAt, 'externalSubmission.submittedAt');
  const externalTrackingValue = Object.hasOwn(strictInput, 'externalTrackingReference')
    ? strictInput.externalTrackingReference
    : null;
  const externalTrackingReference =
    externalTrackingValue === null
      ? null
      : requireText(externalTrackingValue, 'external submission tracking reference');
  const core: ExternalSubmissionRecordCore = deepFreeze({
    schemaVersion: 'external-submission-record/v1',
    recordKind: 'user-recorded external submission evidence',
    performedOutsideReuseProof: true,
    acceptanceStatus: 'not claimed',
    frozenReportId: frozenReport.snapshotId,
    receiptId: frozenReport.receipt.receiptId,
    submittedAt,
    destination,
    submittedByActorReference,
    proofHashes,
    externalTrackingReference,
    limitations: [NON_DETERMINATION_LIMITATION],
  });
  const canonicalCore = canonicalJson(core);
  const recordHash = sha256(canonicalCore);
  return deepFreeze({
    core,
    canonicalCore,
    recordHash,
    recordId: `rps1-${recordHash}`,
  });
}

/** Verify an external-submission record without interpreting its human-supplied proof. */
function validateParsedExternalSubmissionRecord(parsed: ParsedExternalSubmissionRecord): void {
  const { record, core, proofHashes } = parsed;
  instantMilliseconds(core.submittedAt, 'externalSubmission.submittedAt');
  const externalTrackingReference = core.externalTrackingReference;
  if (externalTrackingReference !== null) {
    requireText(externalTrackingReference, 'external submission tracking reference');
  }
  if (!/^rpf1-[0-9a-f]{64}$/.test(core.frozenReportId)) {
    throw new TypeError('external submission record requires a hash-derived frozen report ID');
  }
  requireReceiptId(core.receiptId, 'external submission receipt ID');
  const expectedCore: ExternalSubmissionRecordCore = {
    schemaVersion: 'external-submission-record/v1',
    recordKind: 'user-recorded external submission evidence',
    performedOutsideReuseProof: true,
    acceptanceStatus: 'not claimed',
    frozenReportId: core.frozenReportId,
    receiptId: core.receiptId,
    submittedAt: core.submittedAt,
    destination: requireText(core.destination, 'external submission destination'),
    submittedByActorReference: requireText(
      core.submittedByActorReference,
      'external submission actor reference',
    ),
    proofHashes,
    externalTrackingReference,
    limitations: [NON_DETERMINATION_LIMITATION],
  };
  const canonicalCore = canonicalJson(core);
  const recordHash = sha256(canonicalCore);
  const boundary: {
    readonly performedOutsideReuseProof: boolean;
    readonly acceptanceStatus: string;
  } = core;
  if (
    record.canonicalCore !== canonicalCore ||
    record.recordHash !== recordHash ||
    record.recordId !== `rps1-${recordHash}` ||
    !boundary.performedOutsideReuseProof ||
    boundary.acceptanceStatus !== 'not claimed' ||
    canonicalCore !== canonicalJson(expectedCore)
  ) {
    throw new RangeError('external submission record integrity check failed');
  }
}

export function validateExternalSubmissionRecordIntegrity(
  record: ExternalSubmissionRecord,
): ExternalSubmissionRecord {
  const parsed = parseExternalSubmissionRecord(record);
  validateParsedExternalSubmissionRecord(parsed);
  const canonicalCore = canonicalJson(parsed.core);
  const recordHash = sha256(canonicalCore);
  return deepFreeze({
    core: parsed.core,
    canonicalCore,
    recordHash,
    recordId: `rps1-${recordHash}`,
  });
}

function normalizeAttestations(
  value: unknown,
  requireCanonicalOrder = false,
): readonly HumanAttestation[] {
  const normalized = requireArray(value, 'human attestations').map((item, index) => {
    const label = `humanAttestations[${index.toString()}]`;
    const attestation = requireStrictRecord(
      item,
      ['attestationId', 'kind', 'actorReference', 'role', 'attestedAt'],
      [],
      label,
    );
    if (attestation.kind !== 'human report-freeze review recorded') {
      throw new TypeError('human attestation kind is not supported');
    }
    const attestedAt = requireText(attestation.attestedAt, 'human attestation time');
    instantMilliseconds(attestedAt, 'humanAttestation.attestedAt');
    return {
      attestationId: requireText(attestation.attestationId, 'human attestation ID'),
      kind: 'human report-freeze review recorded' as const,
      actorReference: requireText(attestation.actorReference, 'human attestation actor'),
      role: requireText(attestation.role, 'human attestation role'),
      attestedAt,
    };
  });
  if (new Set(normalized.map(({ attestationId }) => attestationId)).size !== normalized.length) {
    throw new TypeError('human attestation IDs must be unique');
  }
  const sorted = [...normalized].sort((left, right) =>
    compareCodeUnits(left.attestationId, right.attestationId),
  );
  if (requireCanonicalOrder && canonicalJson(normalized) !== canonicalJson(sorted)) {
    throw new RangeError('human attestations must use canonical attestation-ID order');
  }
  return sorted;
}

function normalizeSupersessionLinks(
  value: unknown,
  currentReceiptId: string,
  requireCanonicalOrder = false,
): readonly ReceiptSupersessionLink[] {
  const normalized = requireArray(value, 'receipt supersession links').map((item, index) => {
    const link = requireStrictRecord(
      item,
      ['priorReceiptId', 'relationship'],
      [],
      `supersessionLinks[${index.toString()}]`,
    );
    if (link.relationship !== 'supersedes') {
      throw new TypeError('receipt supersession relationship must be supersedes');
    }
    const priorReceiptId = requireReceiptId(link.priorReceiptId, 'prior receipt ID');
    if (priorReceiptId === currentReceiptId) {
      throw new RangeError('a receipt cannot supersede itself');
    }
    return { priorReceiptId, relationship: 'supersedes' as const };
  });
  if (new Set(normalized.map(({ priorReceiptId }) => priorReceiptId)).size !== normalized.length) {
    throw new TypeError('receipt supersession links must be unique');
  }
  const sorted = [...normalized].sort((left, right) =>
    compareCodeUnits(left.priorReceiptId, right.priorReceiptId),
  );
  if (requireCanonicalOrder && canonicalJson(normalized) !== canonicalJson(sorted)) {
    throw new RangeError('receipt supersession links must use canonical prior-receipt order');
  }
  return sorted;
}

/** Associate mutable human/runtime facts after rendering without changing the receipt core. */
export function createVerificationEnvelope(input: VerificationEnvelopeInput): VerificationEnvelope {
  const strictInput = requireStrictRecord(
    input,
    ['frozenReport', 'createdAt'],
    [
      'humanAttestations',
      'auditReferences',
      'externalSubmissionRecords',
      'supersessionLinks',
      'signedControlPlaneBundleReferences',
    ],
    'verification envelope input',
  );
  const frozenReport = validateFrozenReportIntegrity(strictInput.frozenReport as FrozenReport);
  const createdAt = requireText(strictInput.createdAt, 'verification envelope creation time');
  const receipt = frozenReport.receipt;
  const createdAtMilliseconds = instantMilliseconds(createdAt, 'verificationEnvelope.createdAt');
  const attestations = normalizeAttestations(
    Object.hasOwn(strictInput, 'humanAttestations') ? strictInput.humanAttestations : [],
  );
  if (
    attestations.some(({ attestedAt }) => instantMilliseconds(attestedAt) > createdAtMilliseconds)
  ) {
    throw new RangeError('verification envelope cannot predate a human attestation');
  }
  const auditReferences = requireUniqueText(
    Object.hasOwn(strictInput, 'auditReferences') ? strictInput.auditReferences : [],
    'audit reference',
  );
  const externalSubmissionRecords = requireArray(
    Object.hasOwn(strictInput, 'externalSubmissionRecords')
      ? strictInput.externalSubmissionRecords
      : [],
    'verification envelope externalSubmissionRecords',
  )
    .map((record) => {
      const submission = validateExternalSubmissionRecordIntegrity(
        record as ExternalSubmissionRecord,
      );
      if (submission.core.receiptId !== receipt.receiptId) {
        throw new RangeError('external submission record belongs to a different receipt');
      }
      if (submission.core.frozenReportId !== frozenReport.snapshotId) {
        throw new RangeError('external submission record belongs to a different frozen report');
      }
      if (instantMilliseconds(submission.core.submittedAt) > createdAtMilliseconds) {
        throw new RangeError('verification envelope cannot predate external submission evidence');
      }
      return { recordId: submission.recordId, core: submission.core };
    })
    .sort((left, right) => compareCodeUnits(left.recordId, right.recordId));
  if (
    new Set(externalSubmissionRecords.map(({ recordId }) => recordId)).size !==
    externalSubmissionRecords.length
  ) {
    throw new TypeError('external submission records must be unique');
  }
  const supersessionLinks = normalizeSupersessionLinks(
    Object.hasOwn(strictInput, 'supersessionLinks') ? strictInput.supersessionLinks : [],
    receipt.receiptId,
  );
  const unvalidatedControlPlaneReferences = requireArray(
    Object.hasOwn(strictInput, 'signedControlPlaneBundleReferences')
      ? strictInput.signedControlPlaneBundleReferences
      : [],
    'signed control-plane bundle references',
  );
  const signedControlPlaneBundleReferences =
    unvalidatedControlPlaneReferences.length === 0
      ? []
      : normalizeNamedHashes(
          unvalidatedControlPlaneReferences,
          'signed control-plane bundle reference',
        );
  if (
    attestations.length === 0 &&
    auditReferences.length === 0 &&
    externalSubmissionRecords.length === 0 &&
    supersessionLinks.length === 0 &&
    signedControlPlaneBundleReferences.length === 0
  ) {
    throw new TypeError('verification envelope requires at least one association');
  }
  const core: VerificationEnvelopeCore = deepFreeze({
    schemaVersion: 'verification-envelope/v1',
    associationOnly: true,
    frozenReportId: frozenReport.snapshotId,
    frozenReportHash: frozenReport.snapshotHash,
    reportVersion: frozenReport.core.reportVersion,
    receiptId: receipt.receiptId,
    receiptCoreHash: receipt.coreHash,
    createdAt,
    humanAttestations: attestations,
    auditReferences,
    externalSubmissionRecords,
    supersessionLinks,
    signedControlPlaneBundleReferences,
    claimBoundary: 'does not sign, certify, submit, or approve the receipt',
  });
  const canonicalEnvelope = canonicalJson(core);
  const envelopeHash = sha256(canonicalEnvelope);
  return deepFreeze({
    core,
    canonicalEnvelope,
    envelopeHash,
    envelopeId: `rpe1-${envelopeHash}`,
  });
}

/** Recheck an envelope against the exact frozen report without interpreting human facts. */
export function validateVerificationEnvelopeIntegrity(
  envelope: VerificationEnvelope,
  frozenReport: FrozenReport,
): VerificationEnvelope {
  const safeFrozenReport = validateFrozenReportIntegrity(frozenReport);
  const parsedEnvelope = parseVerificationEnvelope(envelope);
  const strictEnvelope = parsedEnvelope.envelope;
  const core = parsedEnvelope.core;
  const schemaVersion = requireText(core.schemaVersion, 'verification envelope schemaVersion');
  if (typeof core.associationOnly !== 'boolean') {
    throw new TypeError('verification envelope associationOnly must be boolean');
  }
  const frozenReportId = requireFrozenReportId(
    core.frozenReportId,
    'verification envelope frozen report ID',
  );
  const frozenReportHash = requireDigest(
    core.frozenReportHash,
    'verification envelope frozen report hash',
  );
  if (!Number.isSafeInteger(core.reportVersion) || core.reportVersion <= 0) {
    throw new RangeError('verification envelope report version must be a positive safe integer');
  }
  const receiptId = requireReceiptId(core.receiptId, 'verification envelope receipt ID');
  const receiptCoreHash = requireDigest(
    core.receiptCoreHash,
    'verification envelope receipt core hash',
  );
  if (
    core.frozenReportId !== safeFrozenReport.snapshotId ||
    core.frozenReportHash !== safeFrozenReport.snapshotHash ||
    core.reportVersion !== safeFrozenReport.core.reportVersion ||
    core.receiptId !== safeFrozenReport.receipt.receiptId ||
    core.receiptCoreHash !== safeFrozenReport.receipt.coreHash
  ) {
    throw new RangeError('verification envelope does not belong to the supplied frozen report');
  }
  const createdAt = requireText(core.createdAt, 'verification envelope creation time');
  const createdAtMilliseconds = instantMilliseconds(createdAt, 'verificationEnvelope.createdAt');
  const humanAttestations = normalizeAttestations(core.humanAttestations, true);
  const auditReferences = requireUniqueText(core.auditReferences, 'audit reference', true);
  const supersessionLinks = normalizeSupersessionLinks(
    core.supersessionLinks,
    safeFrozenReport.receipt.receiptId,
    true,
  );
  const controlPlaneReferences = requireArray(
    core.signedControlPlaneBundleReferences,
    'verification envelope signedControlPlaneBundleReferences',
  );
  const signedControlPlaneBundleReferences =
    controlPlaneReferences.length === 0
      ? []
      : normalizeNamedHashes(controlPlaneReferences, 'signed control-plane bundle reference', true);
  const inputOrderExternalSubmissionRecords = requireArray(
    core.externalSubmissionRecords,
    'verification envelope externalSubmissionRecords',
  ).map((value, index) => {
    const association = requireStrictRecord(
      value,
      ['recordId', 'core'],
      [],
      `verification envelope externalSubmissionRecords[${index.toString()}]`,
    );
    const recordId = requireText(
      association.recordId,
      'verification envelope external submission record ID',
    );
    const parsedCore = parseExternalSubmissionCore(association.core);
    const canonicalCore = canonicalJson(parsedCore.core);
    const record: ExternalSubmissionRecord = {
      core: parsedCore.core,
      canonicalCore,
      recordHash: sha256(canonicalCore),
      recordId,
    };
    validateParsedExternalSubmissionRecord({
      record,
      core: parsedCore.core,
      proofHashes: parsedCore.proofHashes,
    });
    if (parsedCore.core.receiptId !== safeFrozenReport.receipt.receiptId) {
      throw new RangeError('verification envelope contains a cross-receipt submission record');
    }
    if (parsedCore.core.frozenReportId !== safeFrozenReport.snapshotId) {
      throw new RangeError('verification envelope contains a cross-snapshot submission record');
    }
    if (instantMilliseconds(parsedCore.core.submittedAt) > createdAtMilliseconds) {
      throw new RangeError('verification envelope predates external submission evidence');
    }
    return { recordId, core: parsedCore.core };
  });
  const externalSubmissionRecords = [...inputOrderExternalSubmissionRecords].sort((left, right) =>
    compareCodeUnits(left.recordId, right.recordId),
  );
  if (
    canonicalJson(inputOrderExternalSubmissionRecords) !== canonicalJson(externalSubmissionRecords)
  ) {
    throw new RangeError(
      'verification envelope submission records must use canonical record-ID order',
    );
  }
  if (
    new Set(externalSubmissionRecords.map(({ recordId }) => recordId)).size !==
    externalSubmissionRecords.length
  ) {
    throw new TypeError('verification envelope submission record IDs must be unique');
  }
  if (
    humanAttestations.length === 0 &&
    auditReferences.length === 0 &&
    externalSubmissionRecords.length === 0 &&
    supersessionLinks.length === 0 &&
    signedControlPlaneBundleReferences.length === 0
  ) {
    throw new TypeError('verification envelope requires at least one association');
  }
  if (
    humanAttestations.some(
      ({ attestedAt }) => instantMilliseconds(attestedAt) > createdAtMilliseconds,
    )
  ) {
    throw new RangeError('verification envelope predates a human attestation');
  }
  const claimBoundary = requireText(core.claimBoundary, 'verification envelope claim boundary');
  const normalizedCore = {
    schemaVersion,
    associationOnly: core.associationOnly,
    frozenReportId,
    frozenReportHash,
    reportVersion: core.reportVersion,
    receiptId,
    receiptCoreHash,
    createdAt,
    humanAttestations,
    auditReferences,
    externalSubmissionRecords,
    supersessionLinks,
    signedControlPlaneBundleReferences,
    claimBoundary,
  } as unknown as VerificationEnvelopeCore;
  const expectedCore: VerificationEnvelopeCore = {
    schemaVersion: 'verification-envelope/v1',
    associationOnly: true,
    frozenReportId: safeFrozenReport.snapshotId,
    frozenReportHash: safeFrozenReport.snapshotHash,
    reportVersion: safeFrozenReport.core.reportVersion,
    receiptId: safeFrozenReport.receipt.receiptId,
    receiptCoreHash: safeFrozenReport.receipt.coreHash,
    createdAt,
    humanAttestations,
    auditReferences,
    externalSubmissionRecords,
    supersessionLinks,
    signedControlPlaneBundleReferences,
    claimBoundary: 'does not sign, certify, submit, or approve the receipt',
  };
  const canonicalEnvelope = canonicalJson(normalizedCore);
  const envelopeHash = sha256(canonicalEnvelope);
  if (
    strictEnvelope.canonicalEnvelope !== canonicalEnvelope ||
    strictEnvelope.envelopeHash !== envelopeHash ||
    strictEnvelope.envelopeId !== `rpe1-${envelopeHash}` ||
    canonicalEnvelope !== canonicalJson(expectedCore)
  ) {
    throw new RangeError('verification envelope integrity check failed');
  }
  return deepFreeze({
    core: expectedCore,
    canonicalEnvelope,
    envelopeHash,
    envelopeId: `rpe1-${envelopeHash}`,
  });
}

/** The fixed receipt claim is exported here for lifecycle-facing consumers. */
export const FROZEN_REPORT_CLAIM = RECEIPT_CLAIM;
