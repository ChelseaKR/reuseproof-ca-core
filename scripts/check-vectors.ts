/**
 * The `make verify` step that holds this library's emitted bytes to what it emitted before.
 *
 * See `scripts/vector-corpus.ts` for what a vector is and why a superseded one is checked
 * differently from a live one, and `vectors/README.md` for how to record a new one.
 *
 *     node dist/scripts/check-vectors.js [corpus-root]
 */

import { resolve } from 'node:path';

import { VECTORS_DIRECTORY, VectorCorpusError, checkVectorCorpus } from './vector-corpus.js';

const root = resolve(process.argv[2] ?? VECTORS_DIRECTORY);

try {
  const report = await checkVectorCorpus(root);
  const live = report.outcomes.filter(({ state }) => state === 'live');
  const superseded = report.outcomes.filter(({ state }) => state === 'superseded');
  process.stdout.write(
    `check-vectors: re-derived ${live.length.toString()} live vector ` +
      `(${report.liveVectorId}) and held ${superseded.length.toString()} superseded vector(s) ` +
      `to their stored bytes; ${report.checkedFileCount.toString()} recorded file(s) checked\n`,
  );
  for (const outcome of superseded) {
    process.stdout.write(
      `check-vectors: ${outcome.vectorId} is superseded and was not re-derived — ` +
        `${outcome.supersededReason ?? 'no reason recorded'}\n`,
    );
  }
} catch (error) {
  const message =
    error instanceof VectorCorpusError ? error.message : `unexpected failure: ${String(error)}`;
  process.stderr.write(`check-vectors: ${message}\n`);
  process.exit(1);
}
