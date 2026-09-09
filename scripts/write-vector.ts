/**
 * Record one vector: the deliberate act that accepts a byte change.
 *
 * `check-vectors` fails when the bytes move. This is the only supported way to make it pass
 * again, and it is deliberately not something `make verify` can do for you: writing a vector is
 * a maintainer saying "this change to what we emit is intended, and here is what we emit now".
 *
 *     node dist/scripts/write-vector.js <vector-id> <input-path> [--recorded-on YYYY-MM-DD]
 *
 * The input is copied into the vector, byte for byte, and every later re-derivation reads that
 * copy rather than `fixtures/`. A vector that re-derived from the maintained fixture would agree
 * with the library about any change the two made together, which is the one thing it exists to
 * refuse.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

import { canonicalJson } from '../src/index.js';
import {
  VECTORS_DIRECTORY,
  VECTOR_INPUT_FILENAME,
  VECTOR_MANIFEST_FILENAME,
  VECTOR_MANIFEST_SCHEMA_VERSION,
  deriveVector,
  type VectorManifest,
} from './vector-corpus.js';

function fail(message: string): never {
  process.stderr.write(`write-vector: ${message}\n`);
  process.exit(2);
}

const [vectorId, inputPath, ...rest] = process.argv.slice(2);
if (vectorId === undefined || inputPath === undefined) {
  fail('usage: write-vector <vector-id> <input-path> [--recorded-on YYYY-MM-DD]');
}
if (!/^[0-9a-z][0-9a-z-]*$/.test(vectorId)) {
  fail('a vector id must be lowercase letters, digits and hyphens, so it is a safe path segment');
}

let recordedOn = new Date().toISOString().slice(0, 10);
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === '--recorded-on') {
    const value = rest[index + 1];
    if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('--recorded-on takes a YYYY-MM-DD date');
    }
    recordedOn = value;
    index += 1;
    continue;
  }
  fail(`unrecognised argument ${JSON.stringify(rest[index])}`);
}

const inputText = await readFile(resolve(inputPath), 'utf8');
const derived = await deriveVector(inputText);

const directory = resolve(VECTORS_DIRECTORY, vectorId);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await writeFile(join(directory, VECTOR_INPUT_FILENAME), inputText, 'utf8');

for (const [path, bytes] of derived.bytes) {
  const target = join(directory, ...path.split(posix.sep));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

const manifest: VectorManifest = {
  schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
  vectorId,
  recordedOn,
  artifactSchemaVersions: derived.artifactSchemaVersions,
  renderManifestOrder: derived.renderManifestOrder,
  identities: derived.identities,
  files: derived.files,
};
await writeFile(join(directory, VECTOR_MANIFEST_FILENAME), `${canonicalJson(manifest)}\n`, 'utf8');

process.stdout.write(
  `write-vector: recorded ${VECTORS_DIRECTORY}/${vectorId} with ` +
    `${derived.files.length.toString()} artifact(s) over ` +
    `${derived.artifactSchemaVersions.length.toString()} artifact-schema version(s); ` +
    `snapshot ${derived.identities.snapshotId}\n`,
);
