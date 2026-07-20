/** Run the deterministic slice against a local synthetic fixture. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { evaluateFixture, parseEvaluationFixtureJson } from '../src/index.js';

const fixturePath = resolve(process.argv[2] ?? 'fixtures/demo.json');
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = parseEvaluationFixtureJson(fixtureText);
const result = evaluateFixture(fixture);

process.stdout.write(
  `${JSON.stringify(
    {
      requiredSet: result.requiredSet,
      reportRequiredSeries: result.receipt.reportContentProjection.requiredSeries,
      coverageReadiness: result.coverageReadiness,
      receipt: {
        unsigned: result.receipt.unsigned,
        submittable: result.receipt.submittable,
        claim: result.receipt.claim,
        receiptId: result.receipt.receiptId,
        coreHash: result.receipt.coreHash,
        reportContentHash: result.receipt.reportContentHash,
        renderManifest: result.receipt.renderManifest,
        core: result.receipt.core,
      },
      frozenReport: {
        snapshotId: result.frozenReport.snapshotId,
        snapshotHash: result.frozenReport.snapshotHash,
        core: result.frozenReport.core,
      },
    },
    null,
    2,
  )}\n`,
);
