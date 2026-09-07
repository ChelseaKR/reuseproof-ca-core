/**
 * The safety line, enforced instead of promised.
 *
 * `DEFINITION_OF_DONE.md` states, as a review-gate bullet: "No code or documentation claims
 * regulatory compliance, water safety, engineering adequacy, laboratory quality, legal
 * sufficiency, or filing approval." That is this product's central legal posture — the README's
 * non-goals, ADR-0001's V1 boundary and every `limitations` field in the codebase rest on it.
 *
 * Until this file existed, nothing checked it. The existing tests assert that the *disclaimers*
 * are present (`report-render.test.ts`, `report-schema.test.ts`), and `report-render.test.ts`
 * asserts that specific evidence-routing markers do not leak into report-safe output. Neither
 * asks the opposite question: does a rendered artifact ever *make* one of the claims the product
 * says it never makes? A rule enforced by review alone is a rule that holds until the review is
 * rushed, and this one is the expensive kind to get wrong — the artifacts scanned here are what a
 * jurisdiction actually receives.
 *
 * ## How this works, and why it is built this way
 *
 * Determination vocabulary is not banned outright, because the disclaimers themselves have to use
 * it: "not a compliance, safety, water-quality, engineering, laboratory-quality, legal-sufficiency,
 * regulatory-filing, or approval determination" contains almost every forbidden word, in the one
 * context where they belong. A naive scan would either fail on the disclaimer or, if the word list
 * were trimmed until it passed, check nothing.
 *
 * So the scan is two-stage:
 *
 *   1. assert every declared disclaimer is **present** in the artifact, then
 *   2. remove those exact sentences and assert the **remainder** carries no determination claim.
 *
 * Stage 1 is not decoration. Without it the test could be satisfied by deleting the disclaimer —
 * the artifact would then contain no forbidden vocabulary and no limitation either, which is the
 * worst outcome of the three and the one that would read as green.
 *
 * `detects a planted claim` is a positive control on the scanner itself. A scan whose patterns
 * silently match nothing is indistinguishable from a clean tree, which is the failure ADR-0011
 * exists to prevent; that test fails if the matcher ever stops matching.
 *
 * ## Scope
 *
 * Rendered artifacts and report-safe projections only — the outward-facing surface. Source
 * comments and `docs/` legitimately discuss compliance at length (this file does), and scanning
 * them would produce noise that trains the reader to ignore the gate.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/domain/canonical.js';
import { evaluateFixture, parseEvaluationFixtureJson } from '../src/fixture.js';
import { ARTIFACT_STATUS, NON_DETERMINATION_LIMITATION } from '../src/report-render.js';

/**
 * Sentences that may legitimately carry determination vocabulary, because their whole purpose is
 * to disclaim it. Written as patterns rather than exact constants so the three scoped variants of
 * the limitation (report, readiness, bundle) are all covered, and so HTML escaping of the
 * surrounding markup does not matter.
 */
const DECLARED_DISCLAIMERS: readonly RegExp[] = [
  // Every scoped variant of NON_DETERMINATION_LIMITATION.
  /not a compliance, safety, water-quality, engineering,[^.<"]*determination/gi,
  // The unsigned-artifact notice, which must say "certificate" in order to deny being one.
  /this unsigned artifact cannot be submitted by reuseproof ca and is not a certificate or signature/gi,
];

/**
 * Claims this product states it never makes. Each is a *determination* about the world, as
 * distinct from a statement about evidence handling — "accepted", "quarantined" and
 * "deterministically" are routing and process vocabulary and are deliberately absent from this
 * list.
 */
const FORBIDDEN_CLAIMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'compliance claim', pattern: /\bnon-?complian(?:t|ce)\b|\bcomplian(?:t|ce)\b/i },
  { label: 'violation claim', pattern: /\bviolat(?:ion|ions|es|ed|ing)\b/i },
  { label: 'safety claim', pattern: /\bsafety\b|\bunsafe\b|\bis safe\b/i },
  { label: 'engineering-adequacy claim', pattern: /\badequa(?:te|cy)\b|\binadequate\b/i },
  { label: 'certification claim', pattern: /\bcertif(?:ied|icate|ication)\b/i },
  { label: 'approval claim', pattern: /\bapprov(?:ed|al|es)\b/i },
  { label: 'legal-sufficiency claim', pattern: /\blegal(?:ly)?[ -]sufficien(?:t|cy)\b/i },
  { label: 'filing/determination claim', pattern: /\bdetermination\b|\bfiling approval\b/i },
  { label: 'water-quality verdict', pattern: /\bpotable\b|\bwater[ -]quality\b/i },
];

interface Surface {
  readonly name: string;
  readonly text: string;
  /** Whether this surface is expected to carry the disclaimers (rendered artifacts always are). */
  readonly carriesDisclaimer: boolean;
}

function surfaces(): Surface[] {
  const fixtureText = readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8');
  const evaluated = evaluateFixture(parseEvaluationFixtureJson(fixtureText));
  const { receipt, coverageReadiness } = evaluated;

  const result: Surface[] = receipt.renderArtifacts.map((artifact) => ({
    name: `renderArtifact ${artifact.logicalFilename}`,
    text: artifact.utf8Text,
    carriesDisclaimer: true,
  }));
  result.push(
    {
      name: 'receipt.canonicalReportContent',
      text: receipt.canonicalReportContent,
      carriesDisclaimer: false,
    },
    {
      name: 'receipt.reportContentProjection',
      text: canonicalJson(receipt.reportContentProjection),
      carriesDisclaimer: false,
    },
    {
      name: 'coverageReadiness',
      text: canonicalJson(coverageReadiness),
      carriesDisclaimer: true,
    },
  );
  return result;
}

/** Remove every declared disclaimer sentence, leaving the text the product asserts in its own voice. */
function stripDisclaimers(text: string): string {
  return DECLARED_DISCLAIMERS.reduce(
    (remaining, pattern) => remaining.replace(new RegExp(pattern.source, pattern.flags), ' '),
    text,
  );
}

describe('the scanner itself works', () => {
  it('detects a planted claim in each category', () => {
    // Positive control. A scan whose patterns match nothing reads exactly like a clean artifact.
    const planted = [
      'the system is compliant with title 22',
      'one violation was recorded this quarter',
      'water safety confirmed',
      'treatment is adequate',
      'this report is certified',
      'approved by the district engineer',
      'legally sufficient for filing',
      'a determination of record',
      'water-quality verified',
    ];
    for (const [index, sentence] of planted.entries()) {
      const claim = FORBIDDEN_CLAIMS[index];
      expect(claim, `no claim pattern at index ${index.toString()}`).toBeDefined();
      expect(claim?.pattern.test(sentence), `${claim?.label ?? '?'} missed ${sentence}`).toBe(true);
    }
  });

  it('does not fire on evidence-handling vocabulary', () => {
    // Guards the other direction: if these tripped, the gate would be noise and would be silenced.
    const benign =
      'accepted coverage; duplicate and quarantined observations do not increase accepted ' +
      'coverage; generated deterministically from the canonical report-content projection; ' +
      'gaps are explicit; evidence assembled';
    for (const { label, pattern } of FORBIDDEN_CLAIMS) {
      expect(pattern.test(benign), `${label} fired on evidence-handling vocabulary`).toBe(false);
    }
  });

  it('strips the declared disclaimer, and only the declared disclaimer', () => {
    const stripped = stripDisclaimers(
      `before ${NON_DETERMINATION_LIMITATION}. after a compliance claim`,
    );
    expect(stripped).toContain('before');
    expect(stripped).toContain('after a compliance claim');
    expect(stripped).not.toContain('water-quality, engineering');
  });
});

describe('rendered artifacts carry the disclaimers they are required to carry', () => {
  it('states the non-determination limitation in every rendered artifact', () => {
    // Stage 1. Without this, the scan below could be satisfied by deleting the disclaimer.
    for (const surface of surfaces().filter(({ carriesDisclaimer }) => carriesDisclaimer)) {
      expect(
        /not a compliance, safety, water-quality, engineering,[^.<"]*determination/i.test(
          surface.text,
        ),
        `${surface.name} does not state the non-determination limitation`,
      ).toBe(true);
    }
  });

  it('marks rendered artifacts as a draft that has not been submitted', () => {
    const rendered = surfaces().filter(({ name }) => name.startsWith('renderArtifact'));
    expect(rendered).not.toHaveLength(0);
    for (const surface of rendered) {
      // The em dash survives JSON and CSV; HTML escapes the surrounding markup, not the dash.
      expect(surface.text, `${surface.name} is not marked as a non-submitted draft`).toContain(
        ARTIFACT_STATUS,
      );
    }
  });
});

describe('no report-safe surface makes a determination it disclaims', () => {
  it('has surfaces to scan at all', () => {
    // An empty scan is not a pass (ADR-0011).
    const scanned = surfaces();
    expect(scanned.length).toBeGreaterThan(3);
    for (const surface of scanned) {
      expect(surface.text.length, `${surface.name} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(surfaces().map((surface) => [surface.name, surface] as const))(
    '%s carries no determination claim outside its disclaimer',
    (_name, surface) => {
      const remainder = stripDisclaimers(surface.text);
      for (const { label, pattern } of FORBIDDEN_CLAIMS) {
        const match = pattern.exec(remainder);
        expect(
          match,
          `${surface.name} makes a ${label}: ${JSON.stringify(
            match === null ? '' : remainder.slice(Math.max(0, match.index - 90), match.index + 90),
          )}`,
        ).toBeNull();
      }
    },
  );
});
