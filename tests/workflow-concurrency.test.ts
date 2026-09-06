/**
 * Tests for scripts/check-workflow-concurrency.mjs.
 *
 * Two jobs, as in workflow-pins.test.ts. The first is the ordinary one: every rule the gate
 * states is broken here on purpose and observed failing, and every case it deliberately does NOT
 * flag is present too, so neither half is a sentence in a docstring that nothing exercises.
 *
 * The second matters more. A gate of this shape can be entirely correct against fixtures and
 * never read `.github/workflows` at all, and a green `make verify` would look identical either
 * way. `the repository's own workflows` below is therefore not a smoke test: it is the assertion
 * that the thing being checked is this repository.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// prettier-ignore
// @ts-expect-error -- plain .mjs gate script, deliberately outside the typed `src` project
import { CONVERGING_WORKFLOWS, DEFAULT_WORKFLOW_DIR, checkWorkflowConcurrency } from '../scripts/check-workflow-concurrency.mjs';

const check = checkWorkflowConcurrency as (directory?: string) => Promise<number>;
const converging = CONVERGING_WORKFLOWS as Map<string, string>;
const defaultDirectory = DEFAULT_WORKFLOW_DIR as string;

let dir: string;
let errors: string[];
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workflow-concurrency-'));
  errors = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
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

/** A workflow that pushes to `main`, with whatever workflow-level concurrency block is passed. */
function pushWorkflow(concurrency: string[]): string {
  return [
    'name: fixture',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    ...concurrency,
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');
}

const perCommitGroup = [
  'concurrency:',
  "  group: ci-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}",
  '  cancel-in-progress: true',
  '',
];

const refOnlyGroup = [
  'concurrency:',
  '  group: ci-${{ github.ref }}',
  '  cancel-in-progress: true',
  '',
];

describe('per-commit concurrency groups', () => {
  it('passes a branch-push workflow whose group varies per commit', async () => {
    await workflow('ci.yml', pushWorkflow(perCommitGroup));
    await expect(check(dir)).resolves.toBe(0);
    expect(logs.join('\n')).toContain('every concurrency group varies per commit');
  });

  it('fails a branch-push workflow whose group is keyed on the ref alone', async () => {
    await workflow('ci.yml', pushWorkflow(refOnlyGroup));
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('does not vary per commit');
  });

  it('accepts github.run_id as a per-commit discriminator', async () => {
    await workflow(
      'ci.yml',
      pushWorkflow(['concurrency:', '  group: ci-${{ github.run_id }}', '']),
    );
    await expect(check(dir)).resolves.toBe(0);
  });

  it('fails a branch-push workflow whose concurrency block declares no group', async () => {
    await workflow('ci.yml', pushWorkflow(['concurrency:', '  cancel-in-progress: true', '']));
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('declares no group');
  });
});

describe('cases that are deliberately not this defect', () => {
  it('ignores a JOB-level concurrency block keyed on the ref', async () => {
    // Serialising a single job is legitimate. Only the column-zero block is the shared-slot bug,
    // so an indented one must never be read in its place.
    await workflow(
      'ci.yml',
      [
        'name: fixture',
        'on:',
        '  push:',
        '    branches: [main]',
        '',
        'jobs:',
        '  deploy:',
        '    concurrency:',
        '      group: pages-${{ github.ref }}',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    await expect(check(dir)).resolves.toBe(0);
  });

  it('ignores a push trigger restricted to tags', async () => {
    // Every tag is a unique ref, so a ref-only key is already per-release.
    await workflow(
      'release.yml',
      [
        'name: release',
        'on:',
        '  push:',
        "    tags: ['v*']",
        '',
        'concurrency:',
        '  group: release-${{ github.ref }}',
        '',
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    // A tags-only document is out of scope, so nothing runs on a push to a branch and the floor
    // below fires rather than a false pass.
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('no document');
    await workflow('ci.yml', pushWorkflow(perCommitGroup));
    await expect(check(dir)).resolves.toBe(0);
  });

  it('ignores a branch-push workflow with no concurrency block at all', async () => {
    // There is no shared slot to be evicted from.
    await workflow(
      'ci.yml',
      [
        'name: fixture',
        'on:',
        '  push:',
        '    branches: [main]',
        '',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    await expect(check(dir)).resolves.toBe(0);
  });

  it('exempts a converging workflow, and names the reason it applied', async () => {
    await workflow(
      'scorecard.yml',
      pushWorkflow(['concurrency:', '  group: scorecard-${{ github.ref }}', '']),
    );
    await expect(check(dir)).resolves.toBe(0);
    expect(logs.join('\n')).toContain('grades the repository, not the commit');
  });
});

describe('floors, so "found nothing" cannot read as "found nothing wrong"', () => {
  it('fails when the workflow directory does not exist', async () => {
    await expect(check(join(dir, 'absent'))).resolves.toBe(1);
    expect(errors.join('\n')).toContain('no directory at');
  });

  it('fails when the directory holds no workflow document', async () => {
    await writeFile(join(dir, 'README.md'), 'not a workflow', 'utf8');
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('no workflow document');
  });

  it('fails when nothing runs on a push to a branch', async () => {
    await workflow(
      'nightly.yml',
      [
        'name: nightly',
        'on:',
        '  schedule:',
        "    - cron: '0 3 * * *'",
        '',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('runs on a push to a branch');
  });

  it('fails a document whose trigger block cannot be parsed, rather than skipping it', async () => {
    // One regression in the block parser would otherwise excuse every document at once, and the
    // gate would print its green line having examined nothing.
    await workflow('ci.yml', pushWorkflow(perCommitGroup));
    await workflow(
      'broken.yml',
      ['name: broken', 'onx:', '  push:', '    branches: [main]', ''].join('\n'),
    );
    await expect(check(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toContain('no column-zero trigger block');
  });
});

describe('the converging-workflow exemption', () => {
  it('is exactly the three documented entries, each with a reason', () => {
    // An exemption is how a real defect gets waved through later. Pinning the table means adding
    // a name is a visible diff with a stated reason, not a silent widening.
    expect([...converging.keys()].sort()).toEqual([
      'openssf-scorecard.yml',
      'pages.yml',
      'scorecard.yml',
    ]);
    for (const reason of converging.values()) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the repository's own workflows", () => {
  it('every workflow that runs on a push to a branch gives each commit its own slot', async () => {
    await expect(check(defaultDirectory)).resolves.toBe(0);
  });
});
