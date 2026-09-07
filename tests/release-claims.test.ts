/**
 * The release metadata, held against the tag that would make it true.
 *
 * `CITATION.cff` carried `date-released: 2026-07-19` while `git tag --list` was empty here
 * and on `origin`, no GitHub Release existed, and `CHANGELOG.md` said in terms that "No
 * version has been tagged yet". Citation tooling prints `date-released` as the date the
 * software was released, so anyone citing this project was handed a release date for a
 * release that never happened. The date was real. It was just the date of something else.
 *
 * It was worse than the same field in a sibling repository, because `CITATION.cff` here
 * declared no `version` at all: the file gave a release date and nothing to attach it to.
 *
 * That is this project's own dominant defect class turned on its packaging. The domain
 * refuses to choose a winner between contradictory readings and quarantines them instead,
 * and `evaluateReconciledCsvEvidence` distinguishes `no_source_objects` from `reconciled`,
 * because a state that was never established must not read like one that was. A release
 * date over no release is the same mistake in the metadata, in the one file a citation
 * manager reads mechanically and a human never re-reads.
 *
 * Being unreleased is not the defect. Publishing a release date, or a version number, in
 * silence is. So this module sorts the declared version into one of two states and binds
 * three claims to it IN BOTH DIRECTIONS, which is what stops the fix from being undone by
 * whoever cuts the first release:
 *
 * - No tag names the declared version, which is where this repository is. Legitimate, and
 *   it passes, but only while `README.md` says so where a reader arrives and `CITATION.cff`
 *   carries no `date-released`.
 * - A tag names the declared version. Then `CITATION.cff` MUST carry a `date-released` and
 *   `CHANGELOG.md` MUST date a section for it, because a release with no entry and no date
 *   is the opposite failure.
 *
 * Both arms run on every invocation from synthetic input rather than waiting for the
 * repository to enter them, next to a positive control so the rule cannot pass by never
 * passing, and a sabotage of the real `README.md` that asserts the substitution landed
 * before reading the result.
 *
 * Two consequences worth knowing before the first tag.
 *
 * The first tag cannot be consistent in one step unless it is cut ON the commit that flips
 * these statements: the pre-tag tree has to say nothing is released and the tagged tree has
 * to carry the citation date, and `release.yml` re-runs `make verify` at the commit its
 * authorize job resolves. Cut the tag on the flip commit, not ahead of it.
 *
 * And this module reads the tags of the checkout it runs in, so it has to run somewhere
 * that could hold them. `tagAuthorityFailure` refuses to answer from a shallow clone or one
 * configured `--no-tags`: "no tags found" from a checkout that was never given any is the
 * vacuous pass this file exists to prevent. `actions/checkout` fetches no tags at its
 * default depth, which is why `ci.yml` checks out with `fetch-depth: 0`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const README = join(REPO_ROOT, 'README.md');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');
const CITATION = join(REPO_ROOT, 'CITATION.cff');

const read = (path: string): string => readFileSync(path, 'utf8');

/**
 * The single source of truth for the version this project declares.
 */
const declaredVersion = (): string => {
  const version: unknown = (JSON.parse(read(PACKAGE_JSON)) as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json declares no version');
  }
  return version;
};

/**
 * Every file that writes the release version down again, with the pattern that reads it
 * back. Each is a literal somebody has to remember to change, so each is compared against
 * `package.json` rather than trusted.
 *
 * Deliberately not listed: the schema and contract version literals in `src`, which version
 * artifact formats rather than this package and happen to start at the same number.
 */
const RESTATEMENTS: readonly { readonly file: string; readonly pattern: RegExp }[] = [
  { file: CITATION, pattern: /^version:\s*'?"?([^'"\s#]+)'?"?/m },
];

/**
 * Phrases that say, in English, that nothing has been released. A statement counts as the
 * disclosure only if it carries one of these AND names the declared version, so neither half
 * can drift away from the other alone.
 */
const UNRELEASED_MARKERS: readonly string[] = [
  'no tag',
  'not been tagged',
  'no tagged release',
  'not tagged',
  'not yet cut',
  'no signed tag',
  'unreleased',
  'pre-release',
  'prerelease',
  'no release has been',
  'no release tagged',
  'nothing has been released',
  'never been published',
  'no published artifact',
  'no github release',
  'no package registry release',
  'no release exists',
];

/** A tag that names a version: `v1.2.3`, `1.2.3`, `v1.0.0-rc.1`. */
const VERSION_TAG = /^v?([0-9]+(?:\.[0-9]+)*(?:[.\-+][0-9A-Za-z.\-+]+)?)$/;

/** A CHANGELOG heading carrying a version and a date, i.e. claiming a release. */
const DATED_SECTION = /^##\s+\[?([0-9][^\]\s]*)\]?[^\n]*?([0-9]{4}-[0-9]{2}-[0-9]{2})/gm;

/** A heading saying the current work is not in a release yet. */
const UNRELEASED_SECTION = /^##\s+\[?Unreleased\]?/im;

// --- Reading the tags, and refusing to read them from a checkout that cannot ---

const git = (...args: string[]): string => {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/**
 * Why this checkout's tag list cannot be read as the repository's tags.
 *
 * Split out from the git calls so every refusing branch is reachable from a test rather
 * than only from a broken checkout. They share one shape: a checkout that was never given
 * tags reports none, and "none found" read as "none exist" is the vacuous pass this file
 * exists to prevent.
 */
export const tagAuthorityFailure = (input: {
  insideWorkTree: boolean;
  shallow: boolean;
  tagOption: string;
}): string | null => {
  if (!input.insideWorkTree) {
    return 'this is not a git work tree, so there is no tag list to read. Run the suite from a clone rather than from an unpacked archive';
  }
  if (input.shallow) {
    return 'this is a shallow clone. actions/checkout fetches no tags at the default depth, so an empty tag list here would mean "never fetched", not "none exist". Check out with fetch-depth: 0';
  }
  if (input.tagOption === '--no-tags') {
    return 'remote.origin.tagOpt is --no-tags, so this clone never fetches tags and cannot tell an untagged repository from an unfetched one';
  }
  return null;
};

const whyTagsAreNotAuthoritative = (): string | null =>
  tagAuthorityFailure({
    insideWorkTree: git('rev-parse', '--is-inside-work-tree') === 'true',
    shallow: git('rev-parse', '--is-shallow-repository') === 'true',
    tagOption: git('config', '--get', 'remote.origin.tagOpt'),
  });

/** Every tag this checkout holds, having established that it could hold them. */
const tags = (): readonly string[] => {
  const reason = whyTagsAreNotAuthoritative();
  if (reason !== null) {
    throw new Error(`the tag list here cannot be trusted: ${reason}`);
  }
  return git('tag', '--list')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/** The version a tag names, or `null` when it names none. */
export const tagVersion = (tag: string): string | null => VERSION_TAG.exec(tag)?.[1] ?? null;

/** Numeric order, because `git tag --list` sorts v0.10.0 before v0.9.0. */
const tagOrder = (tag: string): number[] =>
  (tagVersion(tag) ?? '').match(/[0-9]+/g)?.map(Number) ?? [];

const compareTags = (left: string, right: string): number => {
  const a = tagOrder(left);
  const b = tagOrder(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.localeCompare(right);
};

const matchingTags = (declared: string, all: readonly string[]): readonly string[] =>
  all.filter((tag) => tagVersion(tag) === declared);

const newestTag = (all: readonly string[]): string | null =>
  all.length === 0 ? null : ([...all].sort(compareTags)[all.length - 1] ?? null);

// --- Where the README is allowed to make the disclosure ----------------------

/**
 * Markdown split into paragraphs and table rows, whitespace collapsed.
 *
 * A sentence wrapped across three source lines is one statement to a reader, and a table
 * row is one statement however its cells are padded. Blockquote markers come off first, so
 * a status line written as a callout is still found.
 */
const statements = (text: string): string[] => {
  const blocks: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.replace(/^\s*>\s?/, ''));
    if (lines.some((line) => line.trimStart().startsWith('|'))) {
      blocks.push(...lines);
    } else {
      blocks.push(lines.join('\n'));
    }
  }
  return blocks
    .filter((block) => block.trim().length > 0)
    .map((block) => block.split(/\s+/).join(' '));
};

/** The two places a reader looks for release status, as they are written. */
export const releaseStatusStatements = (text: string): { label: string; statement: string }[] => {
  const found: { label: string; statement: string }[] = [];
  for (const statement of statements(text)) {
    if (statement.startsWith('**Status:')) {
      found.push({ label: "the README's status line", statement });
    } else if (/^\|\s*Release & Versioning\s*\|/.test(statement)) {
      found.push({ label: "the README's Release & Versioning row", statement });
    }
  }
  return found;
};

// --- The rule itself, as a function of everything it reads -------------------

/**
 * `null` when the declared version is honest, else what is wrong with it.
 *
 * Pure, so both failing branches are exercised on every run by the controls below instead
 * of waiting for the repository to enter them.
 */
export const releaseClaimFailure = (
  declared: string,
  all: readonly string[],
  readme: string,
): string | null => {
  if (matchingTags(declared, all).length > 0) {
    return null;
  }
  if (all.length > 0) {
    return `package.json declares version ${declared} and no tag names it. This checkout holds ${String(all.length)} tag(s) and the newest is ${String(newestTag(all))}, so ${declared} is a version number with no artifact behind it. Cut the tag for the declared version, or move the declaration back to the version that was released.`;
  }
  const places = releaseStatusStatements(readme);
  if (places.length === 0) {
    return `nothing is tagged, and the README has neither a \`**Status:\` line nor a \`Release & Versioning\` row, so there is nowhere a reader is told that version ${declared} was never released.`;
  }
  for (const { statement } of places) {
    const lowered = statement.toLowerCase();
    if (
      statement.includes(declared) &&
      UNRELEASED_MARKERS.some((marker) => lowered.includes(marker))
    ) {
      return null;
    }
  }
  return `nothing is tagged, and ${declared} is not disclosed as unreleased where a reader arrives. ${places
    .map(({ label, statement }) => `${label} reads: ${statement}.`)
    .join(
      ' ',
    )} One of them has to name ${declared} and say it is untagged, so the number is not read as a shipped version, and naming it is what keeps the sentence from outliving the version it describes.`;
};

/** The version a restatement pattern reads out of a file, if it finds one. */
export const restatedVersion = (pattern: RegExp, text: string): string | null =>
  pattern.exec(text)?.[1] ?? null;

const datedChangelogVersions = (text: string): string[] =>
  [...text.matchAll(DATED_SECTION)].flatMap((found) => (found[1] === undefined ? [] : [found[1]]));

// --- The gate ----------------------------------------------------------------

describe('release claims', () => {
  it('this checkout can be trusted to know the repository’s tags', () => {
    // Asserted before anything reads a tag, so a blind checkout says so. Without it every
    // check below would pass on a shallow CI checkout by finding nothing, the gate
    // reporting green precisely when it can see least.
    expect(whyTagsAreNotAuthoritative()).toBeNull();
  });

  it('the declared version is tagged, or the README says it is not', () => {
    expect(releaseClaimFailure(declaredVersion(), tags(), read(README))).toBeNull();
  });

  it('CITATION.cff declares a release date only for a version that was tagged', () => {
    // `date-released` is the field a citation manager prints as the release date. It
    // carried 2026-07-19 against no tag and no GitHub Release. Bound in both directions,
    // so it cannot be left out of a real release either.
    const dated = read(CITATION)
      .split('\n')
      .filter((line) => line.startsWith('date-released:'));
    const tagged = matchingTags(declaredVersion(), tags());
    expect(
      dated.length > 0,
      `CITATION.cff ${dated.length > 0 ? 'declares' : 'omits'} date-released while the declared version is ${
        tagged.length > 0 ? `tagged as ${tagged.join(', ')}` : 'untagged'
      }`,
    ).toBe(tagged.length > 0);
  });

  it('every dated CHANGELOG section names a version that was tagged', () => {
    const held = tags();
    const tagged = new Set(held.map(tagVersion));
    const unbacked = datedChangelogVersions(read(CHANGELOG)).filter(
      (version) => !tagged.has(version),
    );
    expect(
      unbacked,
      `CHANGELOG.md dates a release for ${unbacked.join(', ')} and this checkout holds ${held.join(', ') || 'no tags'}, so those sections describe releases that were never cut`,
    ).toEqual([]);
  });

  it('the CHANGELOG says the current work is unreleased while it is', () => {
    if (matchingTags(declaredVersion(), tags()).length > 0) {
      return;
    }
    expect(
      UNRELEASED_SECTION.test(read(CHANGELOG)),
      'nothing is tagged and CHANGELOG.md has no `## [Unreleased]` heading, so its topmost section reads as the log of a release that happened',
    ).toBe(true);
  });

  it('a tagged version has a dated CHANGELOG section', () => {
    // The other direction, and the one that makes the un-dating reversible.
    const declared = declaredVersion();
    if (matchingTags(declared, tags()).length === 0) {
      return;
    }
    expect(datedChangelogVersions(read(CHANGELOG))).toContain(declared);
  });

  it('every restatement of the version agrees with package.json', () => {
    const declared = declaredVersion();
    for (const { file, pattern } of RESTATEMENTS) {
      const restated = restatedVersion(pattern, read(file));
      expect(
        restated,
        `${file} no longer restates a version where ${String(pattern)} looks for one, so it would have been compared against nothing`,
      ).not.toBeNull();
      expect(restated, `package.json declares ${declared}; ${file} says ${String(restated)}`).toBe(
        declared,
      );
    }
  });
});

// --- Controls: the arms this repository is not in today ----------------------

const SILENT_README = '# demo\n\n**Status: Pre-production.**\n';
const HONEST_README =
  '# demo\n\n> **Status: Pre-production.** Version `0.1.0`, no tag has been cut.\n';

describe('release claims: controls', () => {
  it('fails when tags exist and none names the declared version', () => {
    // The defect arm, unreachable from this repository today because it has no tags.
    const failure = releaseClaimFailure('0.2.0', ['v0.1.0', 'v0.1.1'], HONEST_README);
    expect(failure).not.toBeNull();
    expect(failure).toContain('0.2.0');
    expect(failure).toContain('v0.1.1');
  });

  it('reports the newest tag rather than the last listed', () => {
    // Lexical order puts v0.10.0 before v0.9.0, and the reader wants the newest.
    expect(releaseClaimFailure('1.0.0', ['v0.10.0', 'v0.9.0'], HONEST_README)).toContain('v0.10.0');
  });

  it('passes when a tag names the declared version', () => {
    // The positive control: a released version needs no disclosure at all. Without it the
    // failing branches above would also be satisfied by a rule that simply never passes,
    // which is a broken gate in the other direction.
    expect(releaseClaimFailure('0.1.1', ['v0.1.0', 'v0.1.1'], SILENT_README)).toBeNull();
  });

  it('fails when nothing is tagged and the README does not say so', () => {
    expect(releaseClaimFailure('0.1.0', [], SILENT_README)).toContain('0.1.0');
  });

  it('fails when the disclosure names a different version', () => {
    expect(releaseClaimFailure('0.2.0', [], HONEST_README)).not.toBeNull();
  });

  it('fails when the README offers nowhere to look', () => {
    expect(releaseClaimFailure('0.1.0', [], '# demo\n\nNo status anywhere.\n')).toContain('Status');
  });

  it('reads the disclosure through the blockquote it may be written in', () => {
    expect(releaseStatusStatements(HONEST_README)).toHaveLength(1);
    expect(releaseClaimFailure('0.1.0', [], HONEST_README)).toBeNull();
  });

  it('reads this README rather than passing regardless', () => {
    // The controls above run on synthetic text, which leaves one thing unproven: that the
    // passing verdict on this repository comes from this repository's README. So the
    // declared version is struck out of the real file and the rule re-run against it. The
    // substitution is asserted to have changed something first, because a sabotage that
    // quietly does nothing reads exactly like a passing test.
    const declared = declaredVersion();
    const readme = read(README);
    const sabotaged = readme.split(declared).join('0.0.0-not-the-declared-version');
    expect(
      sabotaged,
      `the README never names the declared version ${declared}, so whatever disclosure it makes cannot be about the version that is declared`,
    ).not.toEqual(readme);
    expect(releaseClaimFailure(declared, [], sabotaged)).not.toBeNull();
  });

  it('the authority check refuses every checkout that cannot see tags', () => {
    // Each argument driven to its failing value, and the healthy case asserted. Without the
    // healthy case the refusal could be unconditional, which would make the gate
    // unreachable rather than strict.
    expect(tagAuthorityFailure({ insideWorkTree: true, shallow: false, tagOption: '' })).toBeNull();
    expect(
      tagAuthorityFailure({ insideWorkTree: false, shallow: false, tagOption: '' }),
    ).not.toBeNull();
    expect(
      tagAuthorityFailure({ insideWorkTree: true, shallow: true, tagOption: '' }),
    ).not.toBeNull();
    expect(
      tagAuthorityFailure({ insideWorkTree: true, shallow: false, tagOption: '--no-tags' }),
    ).not.toBeNull();
  });

  it('each restatement pattern follows the file it reads', () => {
    // A pattern that matched some unrelated string would agree with package.json only by
    // accident, and would go on agreeing after the literal it was supposed to be watching
    // changed. Substituting a sentinel and requiring the pattern to return the sentinel
    // proves each one is reading the literal it is named for.
    const declared = declaredVersion();
    const sentinel = '9.99.999';
    for (const { file, pattern } of RESTATEMENTS) {
      const original = read(file);
      const mutated = original.split(declared).join(sentinel);
      expect(mutated, `${file} does not contain ${declared}`).not.toEqual(original);
      expect(restatedVersion(pattern, mutated)).toBe(sentinel);
    }
  });

  it('tells a dated CHANGELOG section from an unreleased one', () => {
    expect(datedChangelogVersions('# c\n\n## [1.2.3] - 2026-01-02\n\n- a change\n')).toEqual([
      '1.2.3',
    ]);
    expect(datedChangelogVersions('# c\n\n## [Unreleased]\n\n- a change\n')).toEqual([]);
    expect(UNRELEASED_SECTION.test('# c\n\n## [Unreleased]\n\n- a change\n')).toBe(true);
    expect(UNRELEASED_SECTION.test('# c\n\n## [1.2.3] - 2026-01-02\n\n- a change\n')).toBe(false);
  });

  it('recognises a version tag however it is written', () => {
    expect(tagVersion('v0.1.0')).toBe('0.1.0');
    expect(tagVersion('0.1.0')).toBe('0.1.0');
    expect(tagVersion('v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(tagVersion('standards-v1')).toBeNull();
    expect(tagVersion('latest')).toBeNull();
  });
});
