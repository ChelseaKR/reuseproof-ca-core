/** Enforce repository source-marker hygiene. */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['src', 'scripts', 'tests'];
const allowedExtensions = new Set(['.ts', '.mjs']);
const markerNames = ['TO' + 'DO', 'FIX' + 'ME', 'HA' + 'CK'];
const markerPattern = new RegExp(`\\b(?:${markerNames.join('|')})\\b`);
const issuePattern = /(?:\(#[0-9]+\)|https?:\/\/\S+\/issues\/[0-9]+)/;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (allowedExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const failures = [];
for (const root of roots) {
  for (const path of await sourceFiles(root)) {
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (markerPattern.test(line) && !issuePattern.test(line)) {
        failures.push(`${path}:${index + 1}`);
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`Bare source markers found:\n${failures.join('\n')}`);
  process.exitCode = 1;
}
