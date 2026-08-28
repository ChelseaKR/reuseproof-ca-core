#!/usr/bin/env node
/**
 * Enforce repository source-marker hygiene: every marker names an issue.
 *
 * A marker left in the tree with no issue behind it is a note to nobody. The rule is that
 * `TO`+`DO`, `FIX`+`ME` and `HA`+`CK` may appear on a line only if that line also carries either a
 * `(#123)` issue reference or an issue URL. (The marker names are assembled from fragments so this
 * file does not trip its own check.)
 *
 * The gate fails closed on an empty scan. It used to report success after examining zero files: it
 * walked three root directories for two extensions, and if a root were renamed, moved under a
 * `packages/` layout, or simply came to hold no `.ts`/`.mjs`, the walk returned nothing and the
 * exit code said "clean". `make verify` would then report marker hygiene as enforced when nothing
 * had been read. Scanning nothing is not a pass, so `checkHygiene` now requires at least one file
 * and prints how many it examined — a green run states what it covered rather than only that it
 * found nothing.
 *
 * A configured root that does not exist is likewise an error and not an empty result. That case
 * did fail before, but as an unhandled promise rejection with a stack trace; it now fails with a
 * sentence naming the missing root.
 *
 *     node scripts/check-hygiene.mjs [root...]
 */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Directories walked when no roots are given on the command line. */
export const DEFAULT_ROOTS = ['src', 'scripts', 'tests'];

/** File types that carry source markers. Anything else inside a root is ignored. */
const allowedExtensions = new Set(['.ts', '.mjs']);

// Assembled from fragments so this file is not itself a bare marker.
const markerNames = ['TO' + 'DO', 'FIX' + 'ME', 'HA' + 'CK'];
const markerPattern = new RegExp(`\\b(?:${markerNames.join('|')})\\b`);
const issuePattern = /(?:\(#[0-9]+\)|https?:\/\/\S+\/issues\/[0-9]+)/;

async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    // Fail closed, and name the root. An unreadable root is a broken configuration, not an empty
    // directory, and it must not be allowed to look like one.
    throw new Error(
      `hygiene root ${JSON.stringify(directory)} could not be read, so it was not scanned. Fix ` +
        `the path in DEFAULT_ROOTS (or the argument passed to this script) rather than letting ` +
        `the gate report a clean tree it never looked at.`,
      { cause },
    );
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (allowedExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Scan `roots` and return the process exit code: 0 clean, 1 otherwise.
 *
 * Exported so the gate itself is testable. It is a `make verify` step, and an untested gate is an
 * unverified one.
 */
export async function checkHygiene(roots = DEFAULT_ROOTS) {
  const files = [];
  for (const root of roots) {
    files.push(...(await sourceFiles(root)));
  }

  if (files.length === 0) {
    // Not a pass. No files means the roots or the extension set no longer describe where this
    // repository keeps its source, so nothing was checked — and a gate that checked nothing has
    // verified nothing.
    console.error(
      `No source files found under ${JSON.stringify(roots)}. This is a gate failure, not a clean ` +
        `tree: marker hygiene examined nothing. Check the roots, and that they still hold ` +
        `${[...allowedExtensions].sort().join('/')} files.`,
    );
    return 1;
  }

  const failures = [];
  for (const path of files) {
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (markerPattern.test(line) && !issuePattern.test(line)) {
        failures.push(`${path}:${index + 1}`);
      }
    });
  }

  if (failures.length > 0) {
    console.error(`Bare source markers found:\n${failures.join('\n')}`);
    return 1;
  }

  console.log(
    `Marker hygiene: ${files.length} source file(s) scanned under ${JSON.stringify(roots)}, ` +
      `no bare markers.`,
  );
  return 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  const roots = process.argv.slice(2);
  process.exitCode = await checkHygiene(roots.length > 0 ? roots : DEFAULT_ROOTS);
}
