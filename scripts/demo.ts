/** Run the reconciled deterministic slice against a local synthetic fixture. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  evaluateReconciledCsvEvidence,
  parseBoundedJson,
  validateReconciledCsvEvidenceIntegrity,
} from '../src/index.js';
import { reconciledFixtureInput } from './demo-fixture.js';

const fixturePath = resolve(process.argv[2] ?? 'fixtures/reconciled-demo.json');
const fixtureText = await readFile(fixturePath, 'utf8');
const input = reconciledFixtureInput(parseBoundedJson(fixtureText));
const result = validateReconciledCsvEvidenceIntegrity(evaluateReconciledCsvEvidence(input), input);

process.stdout.write(
  `${JSON.stringify(
    {
      evaluationHash: result.evaluationHash,
      series: result.series.map((item) => ({
        contractId: item.contractId,
        contractVersion: item.contractVersion,
        reconciliation: {
          kind: item.reconciliation.kind,
          operationalHash: item.reconciliation.operationalHash,
          submittedSourceCount: item.reconciliation.result?.submittedSourceCount ?? 0,
          uniqueSourceCount: item.reconciliation.result?.uniqueSourceCount ?? 0,
          duplicateSourceSubmissionCount:
            item.reconciliation.result?.duplicateSourceSubmissionCount ?? 0,
          acceptedIdentityCount: item.reconciliation.result?.acceptedIdentityCount ?? 0,
          quarantinedIdentityCount: item.reconciliation.result?.quarantinedIdentityCount ?? 0,
        },
        evidenceSetHash: item.evidenceSetHash,
        coverage: {
          expectedCount: item.coverageSummary.expectedCount,
          acceptedCount: item.coverageSummary.acceptedCount,
          gapCount: item.coverageSummary.gapCount,
          quarantineCount: item.coverageSummary.quarantineCount,
        },
        dailyAggregate: {
          aggregateHash: item.dailyAggregate.aggregateHash,
          values: item.dailyAggregate.aggregate.values,
        },
      })),
      coverageReadiness: result.coverageReadiness,
      receipt: {
        unsigned: result.receipt.unsigned,
        submittable: result.receipt.submittable,
        claim: result.receipt.claim,
        receiptId: result.receipt.receiptId,
        coreHash: result.receipt.coreHash,
        reportContentHash: result.receipt.reportContentHash,
      },
      frozenReport: {
        snapshotId: result.frozenReport.snapshotId,
        snapshotHash: result.frozenReport.snapshotHash,
      },
    },
    null,
    2,
  )}\n`,
);
