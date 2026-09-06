/**
 * The full-history secret scan must stay capable of failing on a leak that has already been
 * revoked.
 *
 * TruffleHog sorts a finding into `verified` (it authenticated the credential against the live
 * service), `unknown` (verification errored) and `unverified` (it asked, and the service said no).
 * A credential that leaked and was later *revoked* is the normal end state of a real incident, and
 * it is exactly what a scheduled full-history sweep exists to catch. It answers "no", so it lands
 * in `unverified`. A scan configured `--only-verified`, `--results=verified` or
 * `--results=verified,unknown` therefore cannot fail on it, and goes green either way. Measured
 * 2026-09-06 on a throwaway clone with a real-shaped AWS key planted in one commit and deleted in
 * the next: the first three exited 0 reporting nothing; adding `unverified` exited 183 with
 * `unverified_secrets: 1`.
 *
 * Three further properties are asserted because each has silently un-armed a scan in this
 * portfolio without turning any build red:
 *
 *   - the action ref and the `version:` input name the same release (the input selects the
 *     scanning binary, `ghcr.io/trufflesecurity/trufflehog:${VERSION}`; the `uses:` SHA pins only
 *     the wrapper, and omitting the input means `latest`);
 *   - `fetch-depth: 0` survives, or a "full-history" sweep is a one-commit scan reporting success;
 *   - `path: ./` survives, or the action exits on its own "BASE and HEAD commits are the same"
 *     guard having scanned nothing.
 *
 * The pin comment is a YAML comment and so is invisible to a YAML parser: this reads the workflow
 * as text on purpose. `scripts/check-workflow-pins.mjs` polices the pin contract across every
 * workflow; this file states the tier contract for the one workflow that has it, and repeats the
 * pin assertion so that a failure here names the scan rather than the census.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = resolve(import.meta.dirname, '..', '.github', 'workflows', 'trufflehog.yml');

/** The tier a revoked credential lands in. Its absence is the defect. */
const REQUIRED_RESULT_TIER = 'unverified';

async function workflowText(): Promise<string> {
  return readFile(WORKFLOW, 'utf8');
}

/** Every `extra_args:` line: one per scanning lane. */
function lanes(document: string): string[] {
  return [...document.matchAll(/^[ \t]*extra_args:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1] ?? '');
}

function resultTiers(lane: string): string[] {
  const match = /--results=([\w,]+)/.exec(lane);
  return match?.[1] ? match[1].split(',') : [];
}

describe('the full-history secret scan', () => {
  it('has at least one scanning lane this test can read', async () => {
    expect(
      lanes(await workflowText()),
      'no `extra_args:` found; this guard can no longer see which result tiers the scan reports on',
    ).not.toHaveLength(0);
  });

  it('never uses --only-verified, in any lane', async () => {
    for (const lane of lanes(await workflowText())) {
      expect(
        lane,
        '`--only-verified` cannot fail on a credential the provider has already revoked, which is ' +
          'the normal end state of a real leak and the case this scan exists for',
      ).not.toContain('--only-verified');
      expect(lane, 'expected an explicit `--results=` tier list').toMatch(/--results=[\w,]+/);
    }
  });

  it('reports the unverified tier in at least one lane', async () => {
    const tiers = lanes(await workflowText()).map(resultTiers);
    expect(
      tiers.some((lane) => lane.includes(REQUIRED_RESULT_TIER)),
      `no lane reports \`${REQUIRED_RESULT_TIER}\` results (found ${JSON.stringify(tiers)}), so ` +
        'nothing here can fail on a credential that leaked and was then revoked. Measured: ' +
        'verified and verified,unknown both exit 0 on a planted-then-deleted AWS key; adding ' +
        'unverified exits 183.',
    ).toBe(true);
  });

  it('pins the scanning binary to the release its SHA comment names', async () => {
    const document = await workflowText();
    const pinned = [
      ...document.matchAll(/trufflesecurity\/trufflehog@[0-9a-f]{40}\s*#\s*v(\d+(?:\.\d+)*)/g),
    ].map((m) => m[1] ?? '');
    const selected = [...document.matchAll(/^\s*version:\s*['"]?(\d+(?:\.\d+)*)['"]?\s*$/gm)].map(
      (m) => m[1] ?? '',
    );

    expect(pinned, 'no SHA-pinned trufflehog ref with a `# vX.Y.Z` comment').not.toHaveLength(0);
    expect(
      selected,
      'no `version:` input on the trufflehog step. Without it the action defaults to "latest", so ' +
        'the SHA pin above it pins only the wrapper and not the binary that actually scans.',
    ).not.toHaveLength(0);
    expect(selected).toEqual(pinned);
  });

  it('checks out the whole history and walks the whole repository', async () => {
    const document = await workflowText();
    expect(document).toContain('actions/checkout@');
    expect(
      document,
      '`fetch-depth: 0` is missing; actions/checkout then fetches a single commit and this ' +
        'full-history sweep silently becomes a one-commit scan that still reports success',
    ).toMatch(/^\s*fetch-depth:\s*0\s*(?:#.*)?$/m);
    expect(
      document,
      '`path: ./` is missing; with path, base and head all unset the action exits on its own ' +
        '"BASE and HEAD commits are the same" guard having scanned nothing',
    ).toMatch(/^\s*path:\s*\.\/\s*(?:#.*)?$/m);
  });
});
