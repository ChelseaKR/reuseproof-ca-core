/** Report freeze, external-submission evidence, and verification-envelope tests. */

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  createRenderManifest,
  createExternalSubmissionRecord,
  createVerificationEnvelope,
  freezeReport,
  renderReportArtifacts,
  sha256,
  validateExternalSubmissionRecordIntegrity,
  validateFrozenReportIntegrity,
  validateUnsignedReceiptIntegrity,
  validateVerificationEnvelopeIntegrity,
  type ExternalSubmissionRecord,
  type FrozenReport,
  type HumanAttestation,
  type ReceiptSupersessionLink,
  type UnsignedReceipt,
  type VerificationEnvelope,
} from '../src/index.js';
import { createTestReceipt } from './report-helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type StrictRecordAttack =
  'symbol' | 'non_enumerable' | 'accessor' | 'prototype' | 'missing' | 'extra';

const strictRecordAttacks: readonly [StrictRecordAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['non_enumerable', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'plain object'],
  ['missing', 'missing required keys'],
  ['extra', 'unsupported keys'],
];

type StrictArrayAttack =
  'symbol' | 'non_enumerable' | 'accessor' | 'prototype' | 'sparse' | 'extra' | 'descriptor';

const strictArrayAttacks: readonly [StrictArrayAttack, string][] = [
  ['symbol', 'symbol keys'],
  ['non_enumerable', 'enumerable data property'],
  ['accessor', 'enumerable data property'],
  ['prototype', 'Array.prototype'],
  ['sparse', 'dense array'],
  ['extra', 'unsupported array keys'],
  ['descriptor', 'ordinary mutable or frozen'],
];

function applyStrictRecordAttack(
  target: Record<PropertyKey, unknown>,
  requiredKey: string,
  attack: StrictRecordAttack,
): void {
  switch (attack) {
    case 'symbol':
      target[Symbol('unexpected')] = true;
      break;
    case 'non_enumerable':
      Object.defineProperty(target, requiredKey, {
        value: target[requiredKey],
        enumerable: false,
        configurable: true,
        writable: true,
      });
      break;
    case 'accessor':
      Object.defineProperty(target, requiredKey, {
        get: () => {
          throw new Error('strict validation must not invoke accessors');
        },
        enumerable: true,
        configurable: true,
      });
      break;
    case 'prototype':
      Object.setPrototypeOf(target, { inherited: true });
      break;
    case 'missing':
      Reflect.deleteProperty(target, requiredKey);
      break;
    case 'extra':
      target.unexpected = true;
      break;
  }
}

function applyStrictArrayAttack(target: unknown[], attack: StrictArrayAttack): void {
  if (target[0] === undefined) throw new Error('array attack requires a non-empty fixture');
  switch (attack) {
    case 'symbol':
      (target as unknown as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
      break;
    case 'non_enumerable':
      Object.defineProperty(target, '0', {
        value: target[0],
        enumerable: false,
        configurable: true,
        writable: true,
      });
      break;
    case 'accessor':
      Object.defineProperty(target, '0', {
        get: () => {
          throw new Error('strict array validation must not invoke accessors');
        },
        enumerable: true,
        configurable: true,
      });
      break;
    case 'prototype':
      Object.setPrototypeOf(target, []);
      break;
    case 'sparse':
      target.length += 1;
      break;
    case 'extra':
      (target as unknown as Record<string, unknown>).unexpected = true;
      break;
    case 'descriptor':
      Object.defineProperty(target, '0', {
        value: target[0],
        enumerable: true,
        configurable: true,
        writable: false,
      });
      break;
  }
}

function expectStrictBoundary<T>(
  value: T,
  select: (clone: DeepMutable<T>) => Record<PropertyKey, unknown>,
  requiredKey: string,
  validate: (clone: T) => void,
  boundary: string,
): void {
  for (const [attack, message] of strictRecordAttacks) {
    const clone = structuredClone(value) as DeepMutable<T>;
    applyStrictRecordAttack(select(clone), requiredKey, attack);
    expect(() => {
      validate(clone as T);
    }, `${boundary} should reject ${attack}`).toThrow(message);
  }
}

function unreadProxy<T extends object>(value: T, counter: { reads: number }): T {
  return new Proxy(value, {
    get: () => {
      counter.reads += 1;
      throw new Error('validated caller objects must not be read through Proxy getters');
    },
  });
}

function submissionRecord(receipt = createTestReceipt()) {
  const frozenReport = freezeReport({ receipt, reportVersion: 1 });
  return createExternalSubmissionRecord({
    frozenReport,
    submittedAt: '2026-02-01T12:00:00.000Z',
    destination: 'Synthetic jurisdiction records desk',
    submittedByActorReference: 'synthetic-actor-1',
    proofHashes: [
      { logicalName: 'z-confirmation.txt', sha256: 'b'.repeat(64) },
      { logicalName: 'a-cover-sheet.pdf', sha256: 'a'.repeat(64) },
    ],
  });
}

function rebuildReceiptWithProjection(
  receipt: UnsignedReceipt,
  reportContentProjection: UnsignedReceipt['reportContentProjection'],
): UnsignedReceipt {
  const canonicalReportContent = canonicalJson(reportContentProjection);
  const reportContentHash = sha256(canonicalReportContent);
  const renderArtifacts = renderReportArtifacts(reportContentProjection, reportContentHash);
  const renderManifest = createRenderManifest(renderArtifacts);
  const core = {
    ...receipt.core,
    reportContentHash,
    renderManifest,
  };
  const canonicalCore = canonicalJson(core);
  const coreHash = sha256(canonicalCore);
  return {
    ...receipt,
    reportContentProjection,
    canonicalReportContent,
    reportContentHash,
    renderArtifacts,
    renderManifest,
    core,
    canonicalCore,
    coreHash,
    receiptId: `rp1-${coreHash}`,
  };
}

describe('strict lifecycle wrapper schemas', () => {
  it('rejects unsafe shapes at frozen-report and supersession-chain boundaries', () => {
    const receipt = createTestReceipt();
    const version1 = freezeReport({ receipt, reportVersion: 1 });
    const version2 = freezeReport({ receipt, reportVersion: 2, supersededReport: version1 });
    const boundaries: readonly [
      string,
      (value: DeepMutable<FrozenReport>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      ['frozen report', (value) => value, 'core'],
      ['frozen report core', (value) => value.core, 'reportVersion'],
      [
        'frozen render manifest item',
        (value) => value.core.renderManifest[0] as unknown as Record<PropertyKey, unknown>,
        'sha256',
      ],
      [
        'superseded chain node',
        (value) => value.supersededReport as unknown as Record<PropertyKey, unknown>,
        'core',
      ],
    ];
    for (const [boundary, select, requiredKey] of boundaries) {
      expectStrictBoundary(version2, select, requiredKey, validateFrozenReportIntegrity, boundary);
    }
  });

  it('rejects unsupported frozen render-manifest values after strict parsing', () => {
    const frozen = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const attacked = structuredClone(frozen) as unknown as DeepMutable<FrozenReport>;
    const manifestItem = attacked.core.renderManifest[0];
    if (manifestItem === undefined) {
      throw new Error('test frozen report lacks a render-manifest item');
    }
    manifestItem.mediaType = 'unsupported' as typeof manifestItem.mediaType;

    expect(() => {
      validateFrozenReportIntegrity(attacked as unknown as FrozenReport);
    }).toThrow('mediaType is not supported');
  });

  it('rejects decorated, sparse, accessor, and custom-prototype lifecycle arrays', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const submission = createExternalSubmissionRecord({
      frozenReport,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic destination',
      submittedByActorReference: 'synthetic-actor',
      proofHashes: [{ logicalName: 'proof.txt', sha256: 'a'.repeat(64) }],
    });
    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [
        {
          attestationId: 'review-1',
          kind: 'human report-freeze review recorded',
          actorReference: 'reviewer-1',
          role: 'reviewer',
          attestedAt: '2026-02-01T11:00:00.000Z',
        },
      ],
      auditReferences: ['audit-1'],
      externalSubmissionRecords: [submission],
      supersessionLinks: [{ priorReceiptId: `rp1-${'b'.repeat(64)}`, relationship: 'supersedes' }],
      signedControlPlaneBundleReferences: [
        { logicalName: 'signed-bundle', sha256: 'c'.repeat(64) },
      ],
    });

    const frozenArrays: readonly [string, (value: DeepMutable<FrozenReport>) => unknown[]][] = [
      ['frozen render manifest', (value) => value.core.renderManifest],
      ['frozen limitations', (value) => value.core.limitations],
    ];
    for (const [boundary, select] of frozenArrays) {
      for (const [attack, message] of strictArrayAttacks) {
        const attacked = structuredClone(frozenReport) as unknown as DeepMutable<FrozenReport>;
        applyStrictArrayAttack(select(attacked), attack);
        expect(() => {
          validateFrozenReportIntegrity(attacked as unknown as FrozenReport);
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }

    const submissionArrays: readonly [
      string,
      (value: DeepMutable<ExternalSubmissionRecord>) => unknown[],
    ][] = [
      ['submission proof hashes', (value) => value.core.proofHashes],
      ['submission limitations', (value) => value.core.limitations],
    ];
    for (const [boundary, select] of submissionArrays) {
      for (const [attack, message] of strictArrayAttacks) {
        const attacked = structuredClone(
          submission,
        ) as unknown as DeepMutable<ExternalSubmissionRecord>;
        applyStrictArrayAttack(select(attacked), attack);
        expect(() => {
          validateExternalSubmissionRecordIntegrity(
            attacked as unknown as ExternalSubmissionRecord,
          );
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }

    const envelopeArrays: readonly [
      string,
      (value: DeepMutable<VerificationEnvelope>) => unknown[],
    ][] = [
      ['human attestations', (value) => value.core.humanAttestations],
      ['audit references', (value) => value.core.auditReferences],
      ['submission associations', (value) => value.core.externalSubmissionRecords],
      ['supersession links', (value) => value.core.supersessionLinks],
      ['control-plane hashes', (value) => value.core.signedControlPlaneBundleReferences],
      [
        'associated proof hashes',
        (value) => value.core.externalSubmissionRecords[0]?.core.proofHashes ?? [],
      ],
    ];
    for (const [boundary, select] of envelopeArrays) {
      for (const [attack, message] of strictArrayAttacks) {
        const attacked = structuredClone(envelope) as unknown as DeepMutable<VerificationEnvelope>;
        applyStrictArrayAttack(select(attacked), attack);
        expect(() => {
          validateVerificationEnvelopeIntegrity(
            attacked as unknown as VerificationEnvelope,
            frozenReport,
          );
        }, `${boundary} should reject ${attack}`).toThrow(message);
      }
    }
  });

  it('strictly snapshots every lifecycle constructor input before field access', () => {
    const receipt = createTestReceipt();
    const freezeInput = { receipt, reportVersion: 1 };
    for (const [attack, message] of strictRecordAttacks) {
      const attacked = structuredClone(freezeInput) as unknown as Record<PropertyKey, unknown>;
      applyStrictRecordAttack(attacked, 'reportVersion', attack);
      expect(() => {
        freezeReport(attacked as unknown as typeof freezeInput);
      }, `freeze input should reject ${attack}`).toThrow(message);
    }

    const frozenReport = freezeReport(freezeInput);
    const submissionInput = {
      frozenReport,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic destination',
      submittedByActorReference: 'synthetic-actor',
      proofHashes: [{ logicalName: 'proof.txt', sha256: 'a'.repeat(64) }],
    };
    for (const [attack, message] of strictRecordAttacks) {
      const attacked = structuredClone(submissionInput) as unknown as Record<PropertyKey, unknown>;
      applyStrictRecordAttack(attacked, 'submittedAt', attack);
      expect(() => {
        createExternalSubmissionRecord(attacked as unknown as typeof submissionInput);
      }, `submission input should reject ${attack}`).toThrow(message);
    }
    for (const [attack, message] of strictArrayAttacks) {
      const attacked = structuredClone(submissionInput);
      applyStrictArrayAttack(attacked.proofHashes, attack);
      expect(() => {
        createExternalSubmissionRecord(attacked);
      }, `submission proof input should reject ${attack}`).toThrow(message);
    }

    const submission = createExternalSubmissionRecord(submissionInput);
    const envelopeInput = {
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [
        {
          attestationId: 'review-1',
          kind: 'human report-freeze review recorded' as const,
          actorReference: 'reviewer-1',
          role: 'reviewer',
          attestedAt: '2026-02-01T11:00:00.000Z',
        },
      ],
      externalSubmissionRecords: [submission],
    };
    for (const [attack, message] of strictRecordAttacks) {
      const attacked = structuredClone(envelopeInput) as unknown as Record<PropertyKey, unknown>;
      applyStrictRecordAttack(attacked, 'createdAt', attack);
      expect(() => {
        createVerificationEnvelope(attacked as unknown as typeof envelopeInput);
      }, `envelope input should reject ${attack}`).toThrow(message);
    }
    for (const [attack, message] of strictArrayAttacks) {
      const attacked = structuredClone(envelopeInput);
      applyStrictArrayAttack(attacked.humanAttestations, attack);
      expect(() => {
        createVerificationEnvelope(attacked);
      }, `envelope association input should reject ${attack}`).toThrow(message);
    }

    const valid = createVerificationEnvelope(envelopeInput);
    expect(() => {
      validateVerificationEnvelopeIntegrity(valid, frozenReport);
    }).not.toThrow();
  });

  it('rejects unsafe shapes at submission and verification-association boundaries', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const submission = createExternalSubmissionRecord({
      frozenReport,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic destination',
      submittedByActorReference: 'synthetic-actor',
      proofHashes: [{ logicalName: 'proof.txt', sha256: 'a'.repeat(64) }],
    });
    const submissionBoundaries: readonly [
      string,
      (value: DeepMutable<ExternalSubmissionRecord>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      ['submission record', (value) => value, 'core'],
      ['submission record core', (value) => value.core, 'submittedAt'],
      [
        'submission proof hash',
        (value) => value.core.proofHashes[0] as unknown as Record<PropertyKey, unknown>,
        'logicalName',
      ],
    ];
    for (const [boundary, select, requiredKey] of submissionBoundaries) {
      expectStrictBoundary(
        submission,
        select,
        requiredKey,
        validateExternalSubmissionRecordIntegrity,
        boundary,
      );
    }

    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [
        {
          attestationId: 'review-1',
          kind: 'human report-freeze review recorded',
          actorReference: 'reviewer-1',
          role: 'reviewer',
          attestedAt: '2026-02-01T11:00:00.000Z',
        },
      ],
      externalSubmissionRecords: [submission],
      supersessionLinks: [{ priorReceiptId: `rp1-${'b'.repeat(64)}`, relationship: 'supersedes' }],
      signedControlPlaneBundleReferences: [
        { logicalName: 'signed-bundle', sha256: 'c'.repeat(64) },
      ],
    });
    const envelopeBoundaries: readonly [
      string,
      (value: DeepMutable<VerificationEnvelope>) => Record<PropertyKey, unknown>,
      string,
    ][] = [
      ['verification envelope', (value) => value, 'core'],
      ['verification envelope core', (value) => value.core, 'createdAt'],
      [
        'human attestation',
        (value) => value.core.humanAttestations[0] as unknown as Record<PropertyKey, unknown>,
        'attestationId',
      ],
      [
        'submission association',
        (value) =>
          value.core.externalSubmissionRecords[0] as unknown as Record<PropertyKey, unknown>,
        'recordId',
      ],
      [
        'associated submission core',
        (value) =>
          value.core.externalSubmissionRecords[0]?.core as unknown as Record<PropertyKey, unknown>,
        'submittedAt',
      ],
      [
        'associated proof hash',
        (value) =>
          value.core.externalSubmissionRecords[0]?.core.proofHashes[0] as unknown as Record<
            PropertyKey,
            unknown
          >,
        'logicalName',
      ],
      [
        'supersession link',
        (value) => value.core.supersessionLinks[0] as unknown as Record<PropertyKey, unknown>,
        'priorReceiptId',
      ],
      [
        'control-plane bundle hash',
        (value) =>
          value.core.signedControlPlaneBundleReferences[0] as unknown as Record<
            PropertyKey,
            unknown
          >,
        'logicalName',
      ],
    ];
    for (const [boundary, select, requiredKey] of envelopeBoundaries) {
      expectStrictBoundary(
        envelope,
        select,
        requiredKey,
        (value) => {
          validateVerificationEnvelopeIntegrity(value, frozenReport);
        },
        boundary,
      );
    }
  });

  it('rejects malformed manifest values and non-boolean lifecycle boundary flags', () => {
    const frozenReport = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });

    const invalidFilename = structuredClone(frozenReport) as unknown as DeepMutable<FrozenReport>;
    const filenameItem = invalidFilename.core.renderManifest[0];
    if (filenameItem === undefined) throw new Error('test report lacks a render manifest item');
    (filenameItem as unknown as { logicalFilename: string }).logicalFilename = 'unsafe.json';
    expect(() => {
      validateFrozenReportIntegrity(invalidFilename as unknown as FrozenReport);
    }).toThrow('logicalFilename is not supported');

    const invalidByteLength = structuredClone(frozenReport) as unknown as DeepMutable<FrozenReport>;
    const byteLengthItem = invalidByteLength.core.renderManifest[0];
    if (byteLengthItem === undefined) throw new Error('test report lacks a render manifest item');
    byteLengthItem.byteLength = -1;
    expect(() => {
      validateFrozenReportIntegrity(invalidByteLength as unknown as FrozenReport);
    }).toThrow('non-negative safe integer');

    const invalidFrozenFlag = structuredClone(frozenReport) as unknown as DeepMutable<FrozenReport>;
    (invalidFrozenFlag.core as unknown as Record<string, unknown>).unsigned = 'true';
    expect(() => {
      validateFrozenReportIntegrity(invalidFrozenFlag as unknown as FrozenReport);
    }).toThrow('flags must be boolean');

    const submission = submissionRecord();
    const invalidSubmissionFlag = structuredClone(
      submission,
    ) as unknown as DeepMutable<ExternalSubmissionRecord>;
    (invalidSubmissionFlag.core as unknown as Record<string, unknown>).performedOutsideReuseProof =
      'true';
    expect(() => {
      validateExternalSubmissionRecordIntegrity(
        invalidSubmissionFlag as unknown as ExternalSubmissionRecord,
      );
    }).toThrow('performedOutsideReuseProof must be boolean');

    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      auditReferences: ['synthetic-audit-reference'],
    });
    const invalidEnvelopeFlag = structuredClone(
      envelope,
    ) as unknown as DeepMutable<VerificationEnvelope>;
    (invalidEnvelopeFlag.core as unknown as Record<string, unknown>).associationOnly = 'true';
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        invalidEnvelopeFlag as unknown as VerificationEnvelope,
        frozenReport,
      );
    }).toThrow('associationOnly must be boolean');
  });
});

describe('deterministic report freeze', () => {
  it('uses normalized validator returns instead of rereading receipt, report, or association Proxies', () => {
    const counter = { reads: 0 };
    const originalReceipt = createTestReceipt();
    const receipt = unreadProxy(
      {
        ...originalReceipt,
        coverageSummaries: unreadProxy([...originalReceipt.coverageSummaries], counter),
        renderArtifacts: unreadProxy([...originalReceipt.renderArtifacts], counter),
        core: unreadProxy({ ...originalReceipt.core }, counter),
      },
      counter,
    );
    const frozen = freezeReport({ receipt, reportVersion: 1 });
    expect(counter.reads).toBe(0);
    expect(frozen.receipt).toEqual(originalReceipt);

    const proxiedFrozen = unreadProxy(
      {
        ...frozen,
        receipt: unreadProxy(
          {
            ...frozen.receipt,
            renderArtifacts: unreadProxy([...frozen.receipt.renderArtifacts], counter),
          },
          counter,
        ),
      },
      counter,
    );
    const submission = createExternalSubmissionRecord({
      frozenReport: proxiedFrozen,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic jurisdiction records desk',
      submittedByActorReference: 'synthetic-actor-1',
      proofHashes: [{ logicalName: 'proof.txt', sha256: 'a'.repeat(64) }],
    });
    expect(counter.reads).toBe(0);

    const proxiedSubmission = unreadProxy(
      {
        ...submission,
        core: unreadProxy(
          {
            ...submission.core,
            proofHashes: unreadProxy([...submission.core.proofHashes], counter),
          },
          counter,
        ),
      },
      counter,
    );
    const envelope = createVerificationEnvelope({
      frozenReport: proxiedFrozen,
      createdAt: '2026-02-01T12:01:00.000Z',
      externalSubmissionRecords: [proxiedSubmission],
    });
    expect(counter.reads).toBe(0);

    const proxiedEnvelope = unreadProxy(
      {
        ...envelope,
        core: unreadProxy(
          {
            ...envelope.core,
            externalSubmissionRecords: unreadProxy(
              [...envelope.core.externalSubmissionRecords],
              counter,
            ),
          },
          counter,
        ),
      },
      counter,
    );
    const validatedEnvelope = validateVerificationEnvelopeIntegrity(proxiedEnvelope, proxiedFrozen);
    expect(counter.reads).toBe(0);
    expect(validatedEnvelope).toEqual(envelope);
  });

  it('freezes exact receipt/render hashes into a hash-derived version-1 snapshot', () => {
    const receipt = createTestReceipt();
    const first = freezeReport({ receipt, reportVersion: 1 });
    const second = freezeReport({ receipt, reportVersion: 1, supersededReport: null });

    expect(first).toEqual(second);
    expect(first.snapshotHash).toBe(sha256(first.canonicalCore));
    expect(first.snapshotId).toBe(`rpf1-${first.snapshotHash}`);
    expect(first.core).toMatchObject({
      lifecycleState: 'frozen',
      reportVersion: 1,
      unsigned: true,
      submittable: false,
      submissionBoundary: 'external evidence record only',
      receiptId: receipt.receiptId,
      receiptCoreHash: receipt.coreHash,
      supersedesSnapshotHash: null,
    });
    expect(first.canonicalCore).not.toMatch(
      /createdAt|attestation|audit|verification|https?:\/\//i,
    );
    expect(JSON.parse(first.canonicalCore)).toHaveProperty('supersedesSnapshotHash', null);
    expect(() => {
      validateFrozenReportIntegrity(first);
    }).not.toThrow();
  });

  it('requires a deterministic supersession link for every later version', () => {
    const receipt = createTestReceipt();
    const version1 = freezeReport({ receipt, reportVersion: 1 });
    const version2 = freezeReport({
      receipt,
      reportVersion: 2,
      supersededReport: version1,
    });

    expect(version2.snapshotId).not.toBe(version1.snapshotId);
    expect(version2.core.supersedesSnapshotHash).toBe(version1.snapshotHash);
    expect(version2.supersededReport).toEqual(version1);
    expect(() => freezeReport({ receipt, reportVersion: 0 })).toThrow('positive safe integer');
    expect(() => freezeReport({ receipt, reportVersion: 1, supersededReport: version1 })).toThrow(
      'version 1',
    );
    expect(() => freezeReport({ receipt, reportVersion: 2 })).toThrow('after 1');
    expect(() =>
      freezeReport({
        receipt,
        reportVersion: 1,
        supersededReport: undefined,
      } as unknown as Parameters<typeof freezeReport>[0]),
    ).toThrow('object or null');
    expect(() =>
      freezeReport({
        receipt,
        reportVersion: 2,
        supersededReport: 'a'.repeat(64) as unknown as FrozenReport,
      }),
    ).toThrow('object');
    expect(() => freezeReport({ receipt, reportVersion: 3, supersededReport: version1 })).toThrow(
      'immediately follow',
    );
    expect(() =>
      freezeReport({
        receipt: createTestReceipt({ systemId: 'system-2' }),
        reportVersion: 2,
        supersededReport: version1,
      }),
    ).toThrow('different report scope');
  });

  it('fails closed when content, render, receipt-core, or freeze links are tampered', () => {
    const receipt = createTestReceipt();
    const badContent = {
      ...receipt,
      canonicalReportContent: `${receipt.canonicalReportContent} `,
    } as UnsignedReceipt;
    const badCore = { ...receipt, receiptId: `rp1-${'f'.repeat(64)}` } as UnsignedReceipt;
    expect(() => {
      validateUnsignedReceiptIntegrity(badContent);
    }).toThrow('content or render');
    expect(() => {
      validateUnsignedReceiptIntegrity(badCore);
    }).toThrow('core integrity');
    expect(() => freezeReport({ receipt: badCore, reportVersion: 1 })).toThrow('core integrity');

    const frozen = freezeReport({ receipt, reportVersion: 1 });
    const tampered = {
      ...frozen,
      core: { ...frozen.core, reportContentHash: 'f'.repeat(64) },
    };
    expect(() => {
      validateFrozenReportIntegrity(tampered);
    }).toThrow('frozen report integrity');

    const invalidVersion = {
      ...frozen,
      core: { ...frozen.core, reportVersion: 0 },
    } as FrozenReport;
    expect(() => {
      validateFrozenReportIntegrity(invalidVersion);
    }).toThrow('positive safe integer');
    const invalidSupersession = {
      ...frozen,
      core: { ...frozen.core, supersedesSnapshotHash: 'a'.repeat(64) },
    } as FrozenReport;
    expect(() => {
      validateFrozenReportIntegrity(invalidSupersession);
    }).toThrow('exact superseded snapshot');

    const version2 = freezeReport({ receipt, reportVersion: 2, supersededReport: frozen });
    expect(() => {
      validateFrozenReportIntegrity({ ...version2, supersededReport: null });
    }).toThrow('supersession');
  });

  it('rejects malformed projections and empty or contradictory manifest links on revalidation', () => {
    const receipt = createTestReceipt();
    const firstSummary = receipt.reportContentProjection.requiredSeries[0];
    if (firstSummary === undefined) {
      throw new Error('test receipt has no required-series summary');
    }
    const withProjection = (projection: unknown) =>
      ({ ...receipt, reportContentProjection: projection }) as unknown as UnsignedReceipt;

    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({ ...receipt.reportContentProjection, requiredSeries: [] }),
      );
    }).toThrow('requiredSeries cannot be empty');
    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({
          ...receipt.reportContentProjection,
          requiredSeries: [firstSummary, { ...firstSummary }],
        }),
      );
    }).toThrow('unique contract IDs');
    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({
          ...receipt.reportContentProjection,
          requiredSeries: [{ ...firstSummary, acceptedCount: -1 }],
        }),
      );
    }).toThrow('non-negative safe integer');
    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({
          ...receipt.reportContentProjection,
          requiredSeries: [
            { ...firstSummary, acceptedCount: Number.MAX_SAFE_INTEGER },
            {
              ...firstSummary,
              contractVersion: '2',
              acceptedCount: 1,
            },
          ],
        }),
      );
    }).toThrow('safe-integer limit');
    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({
          ...receipt.reportContentProjection,
          coverageReadiness: {
            ...receipt.reportContentProjection.coverageReadiness,
            tenantId: 'other-tenant',
          },
        }),
      );
    }).toThrow('readiness scope does not match report scope');
    expect(() => {
      validateUnsignedReceiptIntegrity(
        withProjection({ ...receipt.reportContentProjection, claim: 'different claim' }),
      );
    }).toThrow('invalid report boundary');

    const emptySources = {
      ...receipt,
      core: {
        ...receipt.core,
        evidenceManifest: { ...receipt.core.evidenceManifest, sourceHashes: [] },
      },
    } as unknown as UnsignedReceipt;
    const emptyVersions = {
      ...receipt,
      core: {
        ...receipt.core,
        evidenceManifest: { ...receipt.core.evidenceManifest, pinnedVersions: [] },
      },
    } as unknown as UnsignedReceipt;
    expect(() => {
      validateUnsignedReceiptIntegrity(emptySources);
    }).toThrow('manifest cannot be empty');
    expect(() => {
      validateUnsignedReceiptIntegrity(emptyVersions);
    }).toThrow('manifest cannot be empty');

    const readiness = receipt.reportContentProjection.coverageReadiness;
    const forgedReadyProjection = {
      ...receipt.reportContentProjection,
      coverageReadiness: {
        ...readiness,
        state: 'ready' as const,
        requiredSeries: readiness.requiredSeries.map((series) => ({
          ...series,
          state: 'ready' as const,
          reasons: [],
        })),
      },
    };
    expect(() => {
      validateUnsignedReceiptIntegrity(
        rebuildReceiptWithProjection(receipt, forgedReadyProjection),
      );
    }).toThrow('inconsistent readiness accounting');

    const invalidSummaryProjection = {
      ...receipt.reportContentProjection,
      requiredSeries: [
        {
          ...firstSummary,
          schemaVersion: 'coverage-summary/evil',
          expectedCount: -42,
        },
      ],
    } as unknown as UnsignedReceipt['reportContentProjection'];
    expect(() => {
      validateUnsignedReceiptIntegrity(
        rebuildReceiptWithProjection(receipt, invalidSummaryProjection),
      );
    }).toThrow('schemaVersion');
  });
});

describe('external submission evidence record', () => {
  it('records external proof without claiming product submission or destination acceptance', () => {
    const receipt = createTestReceipt();
    const record = submissionRecord(receipt);

    expect(record.recordHash).toBe(sha256(record.canonicalCore));
    expect(record.recordId).toBe(`rps1-${record.recordHash}`);
    expect(record.core).toMatchObject({
      recordKind: 'user-recorded external submission evidence',
      performedOutsideReuseProof: true,
      acceptanceStatus: 'not claimed',
      receiptId: receipt.receiptId,
      externalTrackingReference: null,
    });
    expect(record.core.proofHashes.map(({ logicalName }) => logicalName)).toEqual([
      'a-cover-sheet.pdf',
      'z-confirmation.txt',
    ]);
    expect(JSON.parse(record.canonicalCore)).toHaveProperty('externalTrackingReference', null);
    expect(() => {
      validateExternalSubmissionRecordIntegrity(record);
    }).not.toThrow();
  });

  it('validates time, text, proof hashes, tracking reference, and record integrity', () => {
    const frozenReport = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const base = {
      frozenReport,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic destination',
      submittedByActorReference: 'synthetic-actor',
      proofHashes: [{ logicalName: 'proof.txt', sha256: 'a'.repeat(64) }],
    };
    expect(() => createExternalSubmissionRecord({ ...base, submittedAt: 'yesterday' })).toThrow(
      'fixed-millisecond',
    );
    expect(() => createExternalSubmissionRecord({ ...base, destination: '\n' })).toThrow(
      'control characters',
    );
    expect(() => createExternalSubmissionRecord({ ...base, proofHashes: [] })).toThrow(
      'at least one',
    );
    expect(() =>
      createExternalSubmissionRecord({
        ...base,
        proofHashes: [{ logicalName: 'proof.txt', sha256: 'bad' }],
      }),
    ).toThrow('SHA-256');
    expect(() =>
      createExternalSubmissionRecord({
        ...base,
        proofHashes: [
          { logicalName: 'proof.txt', sha256: 'a'.repeat(64) },
          { logicalName: 'proof.txt', sha256: 'b'.repeat(64) },
        ],
      }),
    ).toThrow('unique');
    expect(() =>
      createExternalSubmissionRecord({ ...base, externalTrackingReference: '' }),
    ).toThrow('non-empty');
    expect(() =>
      createExternalSubmissionRecord({
        ...base,
        externalTrackingReference: undefined,
      } as unknown as Parameters<typeof createExternalSubmissionRecord>[0]),
    ).toThrow('non-empty');
    expect(
      createExternalSubmissionRecord({ ...base, externalTrackingReference: null }).core
        .externalTrackingReference,
    ).toBeNull();

    const valid = createExternalSubmissionRecord({
      ...base,
      externalTrackingReference: 'synthetic-tracking-1',
    });
    const tampered = { ...valid, recordId: `rps1-${'f'.repeat(64)}` } as ExternalSubmissionRecord;
    expect(() => {
      validateExternalSubmissionRecordIntegrity(tampered);
    }).toThrow('integrity');
    const unsafeFrozenId = {
      ...valid,
      core: { ...valid.core, frozenReportId: '../report' },
    } as ExternalSubmissionRecord;
    expect(() => {
      validateExternalSubmissionRecordIntegrity(unsafeFrozenId);
    }).toThrow('hash-derived frozen report ID');
  });

  it('rejects reordered proof hashes in the raw canonical record core', () => {
    const valid = submissionRecord();
    const attacked = structuredClone(valid) as unknown as DeepMutable<ExternalSubmissionRecord>;
    expect(attacked.core.proofHashes).toHaveLength(2);
    attacked.core.proofHashes.reverse();
    expect(() => {
      validateExternalSubmissionRecordIntegrity(attacked as unknown as ExternalSubmissionRecord);
    }).toThrow('canonical');
  });
});

describe('separate verification envelope', () => {
  const attestation: HumanAttestation = {
    attestationId: 'human-review-1',
    kind: 'human report-freeze review recorded',
    actorReference: 'synthetic-reviewer-1',
    role: 'jurisdiction report reviewer',
    attestedAt: '2026-02-01T11:00:00.000Z',
  };
  const priorLink: ReceiptSupersessionLink = {
    priorReceiptId: `rp1-${'d'.repeat(64)}`,
    relationship: 'supersedes',
  };

  it('defaults only omitted association arrays and rejects explicit null or undefined', () => {
    const frozenReport = freezeReport({ receipt: createTestReceipt(), reportVersion: 1 });
    const fields = [
      'humanAttestations',
      'auditReferences',
      'externalSubmissionRecords',
      'supersessionLinks',
      'signedControlPlaneBundleReferences',
    ] as const;

    for (const field of fields) {
      for (const value of [null, undefined]) {
        expect(() =>
          createVerificationEnvelope({
            frozenReport,
            createdAt: '2026-02-01T12:01:00.000Z',
            auditReferences: ['audit-anchor'],
            [field]: value,
          }),
        ).toThrow('must be an array');
      }
    }
  });

  it('associates human/runtime facts without changing or back-linking the unsigned receipt', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const originalCore = receipt.canonicalCore;
    const record = submissionRecord(receipt);
    const input = {
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [
        attestation,
        {
          ...attestation,
          attestationId: 'human-review-0',
          actorReference: 'synthetic-reviewer-0',
        },
      ],
      auditReferences: ['audit-2', 'audit-1'],
      externalSubmissionRecords: [record],
      supersessionLinks: [
        priorLink,
        { priorReceiptId: `rp1-${'c'.repeat(64)}`, relationship: 'supersedes' },
      ],
      signedControlPlaneBundleReferences: [
        { logicalName: 'release-manifest', sha256: 'e'.repeat(64) },
      ],
    } as const;
    const first = createVerificationEnvelope(input);
    const reordered = createVerificationEnvelope({
      ...input,
      auditReferences: [...input.auditReferences].reverse(),
    });
    const later = createVerificationEnvelope({
      ...input,
      createdAt: '2026-02-01T12:02:00.000Z',
    });

    expect(first.envelopeHash).toBe(sha256(first.canonicalEnvelope));
    expect(first.envelopeId).toBe(`rpe1-${first.envelopeHash}`);
    expect(first.envelopeId).toBe(reordered.envelopeId);
    expect(later.envelopeId).not.toBe(first.envelopeId);
    expect(first.core).toMatchObject({
      associationOnly: true,
      frozenReportId: frozenReport.snapshotId,
      frozenReportHash: frozenReport.snapshotHash,
      reportVersion: 1,
      receiptId: receipt.receiptId,
      receiptCoreHash: receipt.coreHash,
      claimBoundary: 'does not sign, certify, submit, or approve the receipt',
    });
    expect(first.core.auditReferences).toEqual(['audit-1', 'audit-2']);
    expect(receipt.canonicalCore).toBe(originalCore);
    expect(receipt.canonicalCore).not.toContain(first.envelopeId);
    expect(receipt.canonicalReportContent).not.toContain(first.envelopeId);
    expect(() => {
      validateVerificationEnvelopeIntegrity(first, frozenReport);
    }).not.toThrow();

    const tampered = { ...first, envelopeId: `rpe1-${'f'.repeat(64)}` };
    expect(() => {
      validateVerificationEnvelopeIntegrity(tampered, frozenReport);
    }).toThrow('envelope integrity');
  });

  it('rejects reordered raw canonical arrays for all five envelope associations', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const firstRecord = submissionRecord(receipt);
    const secondRecord = createExternalSubmissionRecord({
      frozenReport,
      submittedAt: '2026-02-01T12:00:01.000Z',
      destination: 'Second synthetic destination',
      submittedByActorReference: 'synthetic-actor-2',
      proofHashes: [{ logicalName: 'second-proof.txt', sha256: 'c'.repeat(64) }],
    });
    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [
        attestation,
        {
          ...attestation,
          attestationId: 'human-review-0',
          actorReference: 'synthetic-reviewer-0',
        },
      ],
      auditReferences: ['audit-2', 'audit-1'],
      externalSubmissionRecords: [firstRecord, secondRecord],
      supersessionLinks: [
        priorLink,
        { priorReceiptId: `rp1-${'c'.repeat(64)}`, relationship: 'supersedes' },
      ],
      signedControlPlaneBundleReferences: [
        { logicalName: 'z-bundle', sha256: 'f'.repeat(64) },
        { logicalName: 'a-bundle', sha256: 'a'.repeat(64) },
      ],
    });
    const selectors: readonly [string, (value: DeepMutable<VerificationEnvelope>) => unknown[]][] =
      [
        ['human attestations', (value) => value.core.humanAttestations],
        ['audit references', (value) => value.core.auditReferences],
        ['external submission records', (value) => value.core.externalSubmissionRecords],
        ['supersession links', (value) => value.core.supersessionLinks],
        [
          'signed control-plane references',
          (value) => value.core.signedControlPlaneBundleReferences,
        ],
      ];

    for (const [boundary, select] of selectors) {
      const attacked = structuredClone(envelope) as unknown as DeepMutable<VerificationEnvelope>;
      const values = select(attacked);
      expect(values.length, `${boundary} fixture must have multiple items`).toBeGreaterThan(1);
      values.reverse();
      expect(() => {
        validateVerificationEnvelopeIntegrity(
          attacked as unknown as VerificationEnvelope,
          frozenReport,
        );
      }).toThrow('canonical');
    }
  });

  it('rejects empty, malformed, duplicate, self-referential, and cross-receipt associations', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const createdAt = '2026-02-01T12:01:00.000Z';
    expect(() => createVerificationEnvelope({ frozenReport, createdAt })).toThrow(
      'at least one association',
    );
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt: 'invalid',
        auditReferences: ['audit-1'],
      }),
    ).toThrow('fixed-millisecond');
    expect(() =>
      createVerificationEnvelope({ frozenReport, createdAt, auditReferences: ['same', 'same'] }),
    ).toThrow('unique');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        humanAttestations: [{ ...attestation, kind: 'wrong' } as unknown as HumanAttestation],
      }),
    ).toThrow('kind');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        humanAttestations: [attestation, { ...attestation }],
      }),
    ).toThrow('IDs must be unique');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        supersessionLinks: [{ priorReceiptId: receipt.receiptId, relationship: 'supersedes' }],
      }),
    ).toThrow('cannot supersede itself');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        supersessionLinks: [{ priorReceiptId: 'not-a-receipt', relationship: 'supersedes' }],
      }),
    ).toThrow('hash-derived receipt ID');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        supersessionLinks: [priorLink, { ...priorLink }],
      }),
    ).toThrow('must be unique');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt: '2026-02-01T10:00:00.000Z',
        humanAttestations: [attestation],
      }),
    ).toThrow('cannot predate a human attestation');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        supersessionLinks: [
          {
            priorReceiptId: priorLink.priorReceiptId,
            relationship: 'wrong',
          } as unknown as ReceiptSupersessionLink,
        ],
      }),
    ).toThrow('relationship');

    const otherRecord = submissionRecord(createTestReceipt({ systemId: 'system-2' }));
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        externalSubmissionRecords: [otherRecord],
      }),
    ).toThrow('different receipt');
    const record = submissionRecord(receipt);
    const version2 = freezeReport({
      receipt,
      reportVersion: 2,
      supersededReport: frozenReport,
    });
    expect(() =>
      createVerificationEnvelope({
        frozenReport: version2,
        createdAt,
        externalSubmissionRecords: [record],
      }),
    ).toThrow('different frozen report');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt: '2026-02-01T11:59:59.999Z',
        externalSubmissionRecords: [record],
      }),
    ).toThrow('cannot predate external submission');
    expect(() =>
      createVerificationEnvelope({
        frozenReport,
        createdAt,
        externalSubmissionRecords: [record, record],
      }),
    ).toThrow('must be unique');
  });

  it('keeps the envelope canonical and supports one independently signed bundle reference', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      signedControlPlaneBundleReferences: [
        { logicalName: 'synthetic-bundle', sha256: 'a'.repeat(64) },
      ],
    });

    expect(envelope.canonicalEnvelope).toBe(canonicalJson(envelope.core));
    expect(Object.isFrozen(envelope.core)).toBe(true);
    expect(() => {
      validateVerificationEnvelopeIntegrity(envelope, frozenReport);
    }).not.toThrow();

    const emptyOptionalReferences = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      auditReferences: ['audit-only'],
      signedControlPlaneBundleReferences: [],
    });
    expect(() => {
      validateVerificationEnvelopeIntegrity(emptyOptionalReferences, frozenReport);
    }).not.toThrow();
  });

  it('fails closed when a standalone envelope changes snapshot or association semantics', () => {
    const receipt = createTestReceipt();
    const frozenReport = freezeReport({ receipt, reportVersion: 1 });
    const record = submissionRecord(receipt);
    const envelope = createVerificationEnvelope({
      frozenReport,
      createdAt: '2026-02-01T12:01:00.000Z',
      humanAttestations: [attestation],
      externalSubmissionRecords: [record],
    });
    const withCore = (core: unknown) => ({ ...envelope, core }) as unknown as VerificationEnvelope;
    const rebuiltWithCore = (core: VerificationEnvelope['core']): VerificationEnvelope => {
      const canonicalEnvelope = canonicalJson(core);
      const envelopeHash = sha256(canonicalEnvelope);
      return {
        core,
        canonicalEnvelope,
        envelopeHash,
        envelopeId: `rpe1-${envelopeHash}`,
      };
    };

    expect(() => {
      validateVerificationEnvelopeIntegrity(
        rebuiltWithCore({
          ...envelope.core,
          frozenReportId: `rpf1-${'f'.repeat(64)}`,
          frozenReportHash: 'f'.repeat(64),
        }),
        frozenReport,
      );
    }).toThrow('supplied frozen report');
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        rebuiltWithCore({ ...envelope.core, reportVersion: 2 }),
        frozenReport,
      );
    }).toThrow('supplied frozen report');
    const otherReceipt = createTestReceipt({ systemId: 'system-2' });
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        rebuiltWithCore({
          ...envelope.core,
          receiptId: otherReceipt.receiptId,
          receiptCoreHash: otherReceipt.coreHash,
        }),
        frozenReport,
      );
    }).toThrow('supplied frozen report');
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        withCore({ ...envelope.core, reportVersion: 0 }),
        frozenReport,
      );
    }).toThrow('positive safe integer');
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        withCore({
          ...envelope.core,
          externalSubmissionRecords: [
            envelope.core.externalSubmissionRecords[0],
            envelope.core.externalSubmissionRecords[0],
          ],
        }),
        frozenReport,
      );
    }).toThrow('IDs must be unique');
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        withCore({
          ...envelope.core,
          humanAttestations: [],
          externalSubmissionRecords: [],
        }),
        frozenReport,
      );
    }).toThrow('at least one association');
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        withCore({
          ...envelope.core,
          humanAttestations: [{ ...attestation, attestedAt: '2026-02-01T12:02:00.000Z' }],
          externalSubmissionRecords: [],
        }),
        frozenReport,
      );
    }).toThrow('predates a human attestation');

    const version2 = freezeReport({
      receipt,
      reportVersion: 2,
      supersededReport: frozenReport,
    });
    const version2Record = createExternalSubmissionRecord({
      frozenReport: version2,
      submittedAt: '2026-02-01T12:00:00.000Z',
      destination: 'Synthetic version-2 destination',
      submittedByActorReference: 'synthetic-actor-2',
      proofHashes: [{ logicalName: 'version-2-proof.txt', sha256: 'c'.repeat(64) }],
    });
    const version2Envelope = createVerificationEnvelope({
      frozenReport: version2,
      createdAt: '2026-02-01T12:01:00.000Z',
      externalSubmissionRecords: [version2Record],
    });
    expect(() => {
      validateVerificationEnvelopeIntegrity(
        withCore({
          ...envelope.core,
          externalSubmissionRecords: version2Envelope.core.externalSubmissionRecords,
        }),
        frozenReport,
      );
    }).toThrow('cross-snapshot');
  });
});
