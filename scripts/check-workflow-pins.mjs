#!/usr/bin/env node
/**
 * Enforce that every action this repository runs is pinned, and that the pin names what runs.
 *
 * Three properties, each of which failed silently here before this gate existed:
 *
 *   1. **Every `uses:` is SHA-pinned and carries a version comment.** A mutable tag (`@v4`) is a
 *      supply-chain hole, and a bare SHA with no `# vX.Y.Z` next to it is unreviewable — a bump
 *      would be forty hex characters changing to forty other hex characters.
 *
 *   2. **An action used in several places resolves to one SHA and one version.** `harden-runner`
 *      appears in three workflows and `codeql-action/init` and `analyze` must move together;
 *      Dependabot bumps a group as one pull request, but a hand edit can leave one behind, and
 *      nothing reports two versions of one action running side by side.
 *
 *   3. **An action whose runtime image is chosen by a `version:` input has that input equal to the
 *      SHA's version comment.** This is the one that actually broke.
 *      `trufflesecurity/trufflehog` runs `ghcr.io/trufflesecurity/trufflehog:${VERSION}`, so
 *      SHA-pinning the `uses:` line does not pin what scans; the workflow says so in its own
 *      comment. Dependabot cannot see the input, so it moved the SHA to v3.97.0 (#35) and then
 *      v3.97.1 (#47) while `version:` stayed at '3.96.0'. The repository's only full-history
 *      secret sweep therefore claimed 3.97.1 in its pin and ran 3.96.0, with no diff, no
 *      annotation, and no check anywhere reporting the gap.
 *
 * The gate fails closed at three floors, because "found nothing to check" and "checked and found
 * nothing wrong" print the same green line otherwise: no workflow directory, no workflow
 * document, or no `uses:` reference each exit 1 rather than reporting a pass.
 *
 *     node scripts/check-workflow-pins.mjs [workflow-dir]
 */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where workflows live when no directory is given on the command line. */
export const DEFAULT_WORKFLOW_DIR = '.github/workflows';

/** GitHub reads both spellings; scanning only one would leave the other unpinned and unreported. */
const workflowExtensions = new Set(['.yml', '.yaml']);

/**
 * Actions whose `version:` input selects the runtime that actually executes.
 *
 * Keyed by action repository. The value is the input name to compare against the `uses:` line's
 * version comment. Adding an entry is how a future action of the same shape gets covered; the
 * table is asserted non-empty by the suite so it cannot be emptied into a gate that passes.
 */
export const VERSION_INPUT_ACTIONS = new Map([['trufflesecurity/trufflehog', 'version']]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_PATTERN = /#\s*(v[0-9]+(?:\.[0-9]+)*[^\s]*)\s*$/;

/** `uses: owner/repo/path@ref # comment`, with the trailing comment kept for the version check. */
const USES_PATTERN = /^(\s*)-?\s*uses:\s*(\S+)\s*(#.*)?$/;

/**
 * `version: '3.97.1'` — quoted or bare, any indent, anywhere in the step body.
 *
 * The `m` flag is load-bearing: without it `^` and `$` anchor to the whole body string rather than
 * to a line in it, the input is never found, and the step is reported as setting none. That reads
 * as a stricter gate and is in fact a blind one, so `test_the_version_input_is_read_from_the_step`
 * pins that a step which does set the input passes.
 */
const inputPattern = (name) =>
  new RegExp(`^\\s*${name}:\\s*['"]?([^'"#\\s]+)['"]?\\s*(?:#.*)?$`, 'm');

/** Split `owner/repo/sub/path@ref` into the action repository and the ref. */
function splitReference(reference) {
  const at = reference.lastIndexOf('@');
  if (at < 0) {
    return { action: reference, path: reference, ref: '' };
  }
  const path = reference.slice(0, at);
  const [owner, repo] = path.split('/');
  return { action: owner && repo ? `${owner}/${repo}` : path, path, ref: reference.slice(at + 1) };
}

/**
 * Every `uses:` in one workflow document, with the step body that follows it.
 *
 * The body ends at the next list item at or above the `uses:` line's indent, so a `version:` input
 * belonging to the NEXT step is never read as this one's. Written as a line scan rather than with
 * a YAML parser because this repository has no YAML dependency and adding one to a security gate
 * to read four files is a worse trade than a scanner whose boundary case is tested.
 */
export function usesReferences(document, file) {
  const lines = document.split('\n');
  const references = [];
  lines.forEach((line, index) => {
    const match = USES_PATTERN.exec(line);
    if (!match) {
      return;
    }
    const [, indent, reference, comment = ''] = match;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (next.trim() === '') {
        body.push(next);
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      // A new list item at or above this step's indent starts the next step.
      if (nextIndent <= indent.length && /^\s*-\s/.test(next)) {
        break;
      }
      if (nextIndent < indent.length) {
        break;
      }
      body.push(next);
    }
    references.push({
      file,
      line: index + 1,
      reference,
      comment,
      version: VERSION_COMMENT_PATTERN.exec(comment)?.[1] ?? '',
      body: body.join('\n'),
      ...splitReference(reference),
    });
  });
  return references;
}

async function workflowFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `workflow directory ${JSON.stringify(directory)} could not be read, so no workflow was ` +
        `checked. Fix the path rather than letting the gate report pinned workflows it never ` +
        `opened.`,
      { cause },
    );
  }
  return entries
    .filter((entry) => entry.isFile() && workflowExtensions.has(extname(entry.name)))
    .map((entry) => join(directory, entry.name))
    .sort();
}

/**
 * Check the pins under `directory` and return the process exit code: 0 clean, 1 otherwise.
 *
 * Exported so the gate is testable. It is a `make verify` step, and an untested gate is an
 * unverified one.
 */
export async function checkWorkflowPins(directory = DEFAULT_WORKFLOW_DIR) {
  const files = await workflowFiles(directory);
  if (files.length === 0) {
    console.error(
      `No workflow documents found in ${JSON.stringify(directory)}. This is a gate failure, not ` +
        `a clean result: nothing was checked.`,
    );
    return 1;
  }

  const references = [];
  for (const file of files) {
    references.push(...usesReferences(await readFile(file, 'utf8'), file));
  }
  if (references.length === 0) {
    console.error(
      `No \`uses:\` references found across ${files.length} workflow document(s) in ` +
        `${JSON.stringify(directory)}. This is a gate failure, not a clean result: the scanner ` +
        `read the files and recognised nothing in them.`,
    );
    return 1;
  }

  const failures = [];
  const seen = new Map();

  for (const entry of references) {
    const where = `${entry.file}:${entry.line}`;

    if (entry.reference.startsWith('./')) {
      // A local action or workflow is this repository's own code at this repository's own commit.
      continue;
    }

    if (!SHA_PATTERN.test(entry.ref)) {
      failures.push(
        `${where}: ${entry.reference} is not pinned to a full 40-character commit SHA. A tag is ` +
          `mutable, so the pin names something that can change underneath it.`,
      );
      continue;
    }
    // A reusable workflow is selected by commit, not by release: `ChelseaKR/portfolio-standards`
    // publishes no tags for `release-authorize.yml`, so there is no version string a comment could
    // name and no second fact for this gate to compare the SHA against. The SHA requirement above
    // still applies to it. This is a carve-out by reference SHAPE, not by owner or by name, so it
    // cannot be widened to excuse an action.
    const isReusableWorkflow = /\/\.github\/workflows\//.test(entry.path);
    if (entry.version === '' && !isReusableWorkflow) {
      failures.push(
        `${where}: ${entry.path} is SHA-pinned with no \`# vX.Y.Z\` comment, so a bump to it is ` +
          `unreviewable.`,
      );
      continue;
    }

    const previous = seen.get(entry.path);
    if (previous === undefined) {
      seen.set(entry.path, entry);
    } else if (previous.ref !== entry.ref || previous.version !== entry.version) {
      failures.push(
        `${where}: ${entry.path} is pinned to ${entry.ref} (${entry.version}) here and to ` +
          `${previous.ref} (${previous.version}) at ${previous.file}:${previous.line}. One ` +
          `action must resolve to one release everywhere, or two versions of it run side by side.`,
      );
    }

    const input = VERSION_INPUT_ACTIONS.get(entry.action);
    if (input === undefined) {
      continue;
    }
    const declared = inputPattern(input).exec(entry.body)?.[1];
    if (declared === undefined) {
      failures.push(
        `${where}: ${entry.action} selects what it runs with its \`${input}:\` input, and this ` +
          `step does not set one. Without it the action's default decides, and the SHA pin above ` +
          `names something that is not what runs.`,
      );
      continue;
    }
    const pinned = entry.version.replace(/^v/, '');
    if (declared !== pinned) {
      failures.push(
        `${where}: ${entry.action} is pinned at ${entry.version} but its \`${input}:\` input ` +
          `says ${declared}, and the input is what selects the image that runs. The pin claims ` +
          `${pinned}; the job runs ${declared}.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`Workflow pin failures:\n${failures.join('\n')}`);
    return 1;
  }

  console.log(
    `Workflow pins: ${references.length} \`uses:\` reference(s) across ${files.length} ` +
      `document(s) in ${JSON.stringify(directory)}; all SHA-pinned with a version comment, ` +
      `consistent across documents, and every runtime-selecting input matches its pin.`,
  );
  return 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  process.exitCode = await checkWorkflowPins(process.argv[2] ?? DEFAULT_WORKFLOW_DIR);
}
