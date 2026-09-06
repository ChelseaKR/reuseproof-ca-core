#!/usr/bin/env node
/**
 * Enforce that every commit pushed to a branch can get its own CI verdict.
 *
 * A workflow that runs on a push to a branch and keys its `concurrency:` group on the ref alone
 * gives every commit on that branch ONE shared slot. GitHub allows one running plus one pending
 * run per group, so with `cancel-in-progress: true` the second push cancels the run the first
 * commit was still executing, and with `false` a third push evicts the second from the pending
 * slot.
 *
 * Either way the commit lands with no verdict at all, and it is reported as `cancelled` or is
 * simply absent -- never as red -- so nothing surfaces it. Measured elsewhere in this portfolio on
 * 2026-09-06: one repository's `standards` workflow was cancelled on three consecutive pushes to
 * `main`, leaving three commits with no gate result and nothing anywhere saying so.
 *
 * The rule: a workflow that runs on a push to a BRANCH and declares a workflow-level concurrency
 * group must have a group that varies per commit -- it must reference `github.sha` or
 * `github.run_id`. Pull-request runs may keep a per-PR group and cancel superseded commits: a
 * superseded PR commit really is stale, a merged commit never is.
 *
 * Two things are deliberately not this defect:
 *
 *   1. A JOB-level `concurrency:` block. Serialising one job -- a Pages deploy, say -- is correct,
 *      so the block parser anchors at column zero and can never return an indented block in place
 *      of the workflow-level one.
 *
 *   2. A `push:` trigger restricted to tags. Every tag is a unique ref, so a ref-only key already
 *      gives each release its own slot.
 *
 * The gate fails closed at three floors, because "found nothing to check" and "checked and found
 * nothing wrong" otherwise print the same green line: no workflow directory, no workflow document,
 * and no workflow running on a push to a branch each exit 1 rather than reporting a pass. A
 * workflow whose trigger block does not parse fails too -- without that, one regression in the
 * parser would silently excuse every file at once.
 *
 *     node scripts/check-workflow-concurrency.mjs [workflow-dir]
 */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where workflows live when no directory is given on the command line. */
export const DEFAULT_WORKFLOW_DIR = '.github/workflows';

/** GitHub reads both spellings; scanning only one would leave the other unchecked. */
const workflowExtensions = new Set(['.yml', '.yaml']);

/**
 * Workflows whose runs are meant to converge on one slot, with the reason each is exempt.
 *
 * These describe a property of the REPOSITORY rather than of one commit, so the newest answer is
 * the only one worth having and collapsing onto a single slot is the intended behaviour. An
 * exemption is also how a real defect gets waved through later, so the table is asserted exactly
 * equal in the suite: widening it is a visible diff carrying a reason, not a silent addition.
 */
export const CONVERGING_WORKFLOWS = new Map([
  ['scorecard.yml', 'OpenSSF Scorecard grades the repository, not the commit'],
  ['openssf-scorecard.yml', 'the same, under the other name the action ships with'],
  [
    'pages.yml',
    "publishes the repository's current state to GitHub Pages; two commits cannot be live at " +
      'once, so the newest deploy is the only one worth having',
  ],
]);

/** A group that references either of these varies per commit. */
const perCommitPattern = /github\.sha|github\.run_id/;

/**
 * Slice a column-zero `key:` block out of a workflow document, or return undefined.
 *
 * The block runs from its own key line to the next line starting in column zero, which is what
 * keeps an indented job-level block from being mistaken for the workflow-level one.
 */
export function topLevelBlock(document, key) {
  const opening = new RegExp(String.raw`^(?:${key}|'${key}'|"${key}"):`, 'm').exec(document);
  if (opening === null) {
    return undefined;
  }
  const rest = document.slice(opening.index);
  const firstLineEnd = rest.indexOf('\n');
  if (firstLineEnd < 0) {
    return rest;
  }
  const following = /^\S/m.exec(rest.slice(firstLineEnd + 1));
  return following === null ? rest : rest.slice(0, firstLineEnd + 1 + following.index);
}

/** True when this `on:` block fires on a push to a branch rather than only to tags. */
export function pushesToABranch(triggers) {
  const inline = /^(?:on|'on'|"on"):[ \t]*\[([^\]]*)\]/.exec(triggers);
  if (inline !== null) {
    return inline[1].split(',').some((item) => item.trim() === 'push');
  }
  const push = /^ {2}push:[^\n]*\n((?: {3,}[^\n]*\n|\n)*)/m.exec(triggers);
  if (push === null) {
    return false;
  }
  const body = push[1];
  const tags = /^ {3,}tags(?:-ignore)?:/m.test(body);
  const branches = /^ {3,}branches(?:-ignore)?:/m.test(body);
  return branches || !tags;
}

export async function checkWorkflowConcurrency(directory = DEFAULT_WORKFLOW_DIR) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    console.error(
      `Workflow concurrency: no directory at ${JSON.stringify(directory)}. A gate that reads ` +
        'nothing passes everything, so this is a failure rather than a pass.',
    );
    return 1;
  }

  const files = entries.filter((name) => workflowExtensions.has(extname(name))).sort();
  if (files.length === 0) {
    console.error(
      `Workflow concurrency: no workflow document in ${JSON.stringify(directory)}. A gate that ` +
        'reads nothing passes everything, so this is a failure rather than a pass.',
    );
    return 1;
  }

  const failures = [];
  const exempted = [];
  let branchPushDocuments = 0;

  for (const name of files) {
    const document = await readFile(join(directory, name), 'utf8');

    const triggers = topLevelBlock(document, 'on');
    if (triggers === undefined) {
      // Without this, a regression in the block parser would excuse every document at once and
      // the gate would print its green line having examined nothing.
      failures.push(
        `${name}: no column-zero trigger block could be parsed. A workflow without a trigger is ` +
          'not a workflow, so this reads as a broken parser rather than a passing file.',
      );
      continue;
    }
    if (!pushesToABranch(triggers)) {
      continue;
    }
    branchPushDocuments += 1;

    const concurrency = topLevelBlock(document, 'concurrency');
    if (concurrency === undefined) {
      // No workflow-level group at all is not this defect: there is no shared slot for a later
      // push to evict an earlier commit from.
      continue;
    }
    const group = /^ {2}group:[ \t]*(.+?)[ \t]*$/m.exec(concurrency)?.[1];
    if (group === undefined) {
      failures.push(`${name}: the workflow-level concurrency block declares no group.`);
      continue;
    }
    if (perCommitPattern.test(group)) {
      continue;
    }
    const reason = CONVERGING_WORKFLOWS.get(name);
    if (reason !== undefined) {
      exempted.push(`${name} (${reason})`);
      continue;
    }
    failures.push(
      `${name}: runs on a push to a branch, but its concurrency group \`${group}\` does not vary ` +
        'per commit, so every commit on the branch shares one slot and a later push cancels or ' +
        "evicts an earlier commit's run. Append a per-commit discriminator, e.g. " +
        "`-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}`, and leave " +
        '`cancel-in-progress` as it was.',
    );
  }

  if (branchPushDocuments === 0) {
    console.error(
      `Workflow concurrency: no document in ${JSON.stringify(directory)} runs on a push to a ` +
        'branch, so the per-commit rule matched nothing and this run proves nothing.',
    );
    return 1;
  }

  if (failures.length > 0) {
    console.error(`Workflow concurrency failures:\n${failures.join('\n')}`);
    return 1;
  }

  const note = exempted.length > 0 ? ` Converging exemptions applied: ${exempted.join('; ')}.` : '';
  console.log(
    `Workflow concurrency: ${branchPushDocuments} document(s) in ${JSON.stringify(directory)} ` +
      `run on a push to a branch; every concurrency group varies per commit.${note}`,
  );
  return 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  process.exitCode = await checkWorkflowConcurrency(process.argv[2] ?? DEFAULT_WORKFLOW_DIR);
}
