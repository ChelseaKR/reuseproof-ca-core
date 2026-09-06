/**
 * Tests for scripts/check-workflow-pins.mjs.
 *
 * Two jobs. The first is the ordinary one: every rule the gate states is broken here on purpose
 * and observed failing, so no rule is a sentence in a docstring that nothing exercises.
 *
 * The second matters more. A gate of this shape can be entirely correct against fixtures and
 * never read `.github/workflows` at all, and a green `make verify` would look identical either
 * way. `the repository's own workflows` below is therefore not a smoke test: it is the assertion
 * that the thing being checked is this repository.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// prettier-ignore
// @ts-expect-error -- plain .mjs gate script, deliberately outside the typed `src` project
import { DEFAULT_WORKFLOW_DIR, VERSION_INPUT_ACTIONS, checkWorkflowPins, usesReferences } from '../scripts/check-workflow-pins.mjs';

const check = checkWorkflowPins as (directory?: string) => Promise<number>;
const references = usesReferences as (
  document: string,
  file: string,
) => { reference: string; version: string; body: string; line: number }[];
const versionInputActions = VERSION_INPUT_ACTIONS as Map<string, string>;
const defaultDirectory = DEFAULT_WORKFLOW_DIR as string;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let dir: string;
let errors: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workflow-pins-'));
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function workflow(name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
}

/** A one-step workflow whose single `uses:` line is whatever the caller passes. */
function step(uses: string, body = ''): string {
  return [
    'name: fixture',
    'on: { workflow_dispatch: {} }',
    'jobs:',
    '  scan:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - name: the step',
    `        uses: ${uses}`,
    ...(body === '' ? [] : [body]),
    '',
  ].join('\n');
}

describe("the repository's own workflows", () => {
  // Load-bearing. Without this the whole file could pass while the gate never opened
  // `.github/workflows`, which is the only directory whose pins protect anything.
  it('are what the default invocation checks, and they pass', async () => {
    expect(defaultDirectory).toBe('.github/workflows');
    expect(await check()).toBe(0);
  });

  it('include the secret scanner, whose input is what selects the image that runs', async () => {
    // The specific defect this gate was written for: the action SHA was bumped to v3.97.1 by
    // Dependabot twice over while `version:` stayed at 3.96.0, so the weekly full-history sweep
    // claimed one scanner and ran another. Pinned here by value, not by "the gate passes", so a
    // future edit that drops the input entirely cannot satisfy this test by removing the mismatch.
    const document = await readFile(join(defaultDirectory, 'trufflehog.yml'), 'utf8');
    const scanner = references(document, 'trufflehog.yml').find(({ reference }) =>
      reference.startsWith('trufflesecurity/trufflehog@'),
    );
    expect(scanner).toBeDefined();
    expect(scanner?.version).toBe('v3.97.1');
    expect(scanner?.body).toMatch(/^\s*version: '3\.97\.1'$/m);
  });
});

describe('an empty check fails closed', () => {
  it('fails on a workflow directory holding no workflow documents', async () => {
    await writeFile(join(dir, 'notes.md'), 'not a workflow\n', 'utf8');
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('No workflow documents found');
  });

  it('fails on workflow documents that carry no `uses:` reference at all', async () => {
    await workflow('ci.yml', 'name: fixture\non: { workflow_dispatch: {} }\njobs: {}\n');
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('No `uses:` references found');
  });

  it('throws naming the directory when it cannot be read, rather than reporting a clean scan', async () => {
    const missing = join(dir, 'no-such-directory');
    await expect(check(missing)).rejects.toThrow(new RegExp(JSON.stringify(missing)));
  });
});

describe('every reference is pinned to an immutable commit', () => {
  it('fails a mutable tag', async () => {
    await workflow('ci.yml', step('actions/checkout@v7 # v7.0.1'));
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('is not pinned to a full 40-character commit SHA');
  });

  it('fails a short SHA', async () => {
    await workflow('ci.yml', step(`actions/checkout@${'a'.repeat(7)} # v7.0.1`));
    expect(await check(dir)).toBe(1);
  });

  it('names the file and line of the offending reference', async () => {
    await workflow('ci.yml', step('actions/checkout@v7 # v7.0.1'));
    await check(dir);
    expect(errors.join('\n')).toContain(`${join(dir, 'ci.yml')}:8`);
  });

  it('passes a full SHA carrying a version comment', async () => {
    await workflow('ci.yml', step(`actions/checkout@${SHA_A} # v7.0.1`));
    expect(await check(dir)).toBe(0);
  });

  it('scans .yaml as well as .yml, so neither spelling hides an unpinned action', async () => {
    await workflow('ci.yaml', step('actions/checkout@v7 # v7.0.1'));
    expect(await check(dir)).toBe(1);
  });
});

describe('a pin without a version comment is unreviewable', () => {
  it('fails a bare SHA on an action', async () => {
    await workflow('ci.yml', step(`actions/checkout@${SHA_A}`));
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('no `# vX.Y.Z` comment');
  });

  it('exempts a reusable workflow, which is selected by commit and publishes no version', async () => {
    await workflow(
      'release.yml',
      [
        'name: fixture',
        'on: { workflow_dispatch: {} }',
        'jobs:',
        '  authorize:',
        `    uses: ChelseaKR/portfolio-standards/.github/workflows/release-authorize.yml@${SHA_A}`,
        '',
      ].join('\n'),
    );
    expect(await check(dir)).toBe(0);
  });

  it('still requires the reusable workflow itself to be SHA-pinned', async () => {
    // The carve-out above is about the comment only. A carve-out that also dropped the SHA
    // requirement would let a mutable ref into the one place that runs with this repository's
    // release authority.
    await workflow(
      'release.yml',
      [
        'name: fixture',
        'on: { workflow_dispatch: {} }',
        'jobs:',
        '  authorize:',
        '    uses: ChelseaKR/portfolio-standards/.github/workflows/release-authorize.yml@main',
        '',
      ].join('\n'),
    );
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('is not pinned to a full 40-character commit SHA');
  });
});

describe('one action resolves to one release everywhere', () => {
  it('fails two SHAs for the same action across two documents', async () => {
    await workflow('ci.yml', step(`step-security/harden-runner@${SHA_A} # v2.21.1`));
    await workflow('codeql.yml', step(`step-security/harden-runner@${SHA_B} # v2.21.1`));
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('One action must resolve to one release everywhere');
  });

  it('fails one SHA carrying two different version comments', async () => {
    // The comment is what a reviewer reads. Two comments on one SHA means at least one is a lie,
    // and the SHA comparison alone would not see it.
    await workflow('ci.yml', step(`step-security/harden-runner@${SHA_A} # v2.21.1`));
    await workflow('codeql.yml', step(`step-security/harden-runner@${SHA_A} # v2.20.0`));
    expect(await check(dir)).toBe(1);
  });

  it('passes the same action pinned identically in several documents', async () => {
    await workflow('ci.yml', step(`step-security/harden-runner@${SHA_A} # v2.21.1`));
    await workflow('codeql.yml', step(`step-security/harden-runner@${SHA_A} # v2.21.1`));
    await workflow('trufflehog.yml', step(`step-security/harden-runner@${SHA_A} # v2.21.1`));
    expect(await check(dir)).toBe(0);
  });

  it('treats two subpaths of one action repository as separate references', async () => {
    // `codeql-action/init` and `codeql-action/analyze` are different `uses:` paths that must move
    // together; keying consistency on the repository alone would report them as a conflict, and
    // keying it on nothing would let them drift.
    await workflow('codeql.yml', step(`github/codeql-action/init@${SHA_A} # v4.37.9`));
    await workflow(
      'codeql-2.yml',
      step(`github/codeql-action/analyze@${SHA_A} # v4.37.9`.replace(SHA_A, SHA_B)),
    );
    expect(await check(dir)).toBe(0);
  });
});

describe('an action whose runtime is chosen by an input', () => {
  const scanner = (pinned: string, declared: string | undefined): string =>
    step(
      `trufflesecurity/trufflehog@${SHA_A} # ${pinned}`,
      [
        '        with:',
        '          path: ./',
        ...(declared ? [`          version: '${declared}'`] : []),
      ].join('\n'),
    );

  it('passes when the input equals the version the SHA is pinned at', async () => {
    await workflow('trufflehog.yml', scanner('v3.97.1', '3.97.1'));
    expect(await check(dir)).toBe(0);
  });

  it('fails when the input names an older image than the pin claims', async () => {
    await workflow('trufflehog.yml', scanner('v3.97.1', '3.96.0'));
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('The pin claims 3.97.1; the job runs 3.96.0');
  });

  it('fails when the input is absent, because then the action default decides', async () => {
    await workflow('trufflehog.yml', scanner('v3.97.1', undefined));
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('does not set one');
  });

  it('reads the input from the step it belongs to, not from the one after it', async () => {
    // The boundary that makes the rule mean anything. Without it a `version:` input on a later
    // step satisfies an earlier step's check, and the gate reports agreement between two
    // unrelated lines.
    await workflow(
      'trufflehog.yml',
      [
        'name: fixture',
        'on: { workflow_dispatch: {} }',
        'jobs:',
        '  scan:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - name: the scanner',
        `        uses: trufflesecurity/trufflehog@${SHA_A} # v3.97.1`,
        '        with:',
        '          path: ./',
        '      - name: a later, unrelated step',
        `        uses: actions/upload-artifact@${SHA_B} # v7.0.1`,
        '        with:',
        "          version: '3.97.1'",
        '',
      ].join('\n'),
    );
    expect(await check(dir)).toBe(1);
    expect(errors.join('\n')).toContain('does not set one');
  });

  it('has a non-empty table, so the rule is not switched off by an empty map', () => {
    // Emptying `VERSION_INPUT_ACTIONS` removes every case above without failing any of them: each
    // one would simply stop being checked and start passing. This is the assertion that notices.
    expect(versionInputActions.size).toBeGreaterThan(0);
    expect(versionInputActions.get('trufflesecurity/trufflehog')).toBe('version');
  });
});
