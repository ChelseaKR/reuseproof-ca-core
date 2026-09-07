#!/usr/bin/env node
/**
 * The published entry point. Built from scripts/replay.ts; this file only wires the
 * process to it, so nothing about the replay itself lives outside TypeScript.
 *
 * `npm run build` must have run: this imports the compiled module rather than a source
 * file, so the shipped command and the tested module are the same code.
 */
import { runReplay } from '../dist/scripts/replay.js';

process.exitCode = await runReplay(
  process.argv.slice(2),
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text),
);
