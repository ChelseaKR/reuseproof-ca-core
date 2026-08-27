/**
 * Tests for scripts/codeql-gate.mjs — especially that it does NOT fail open.
 *
 * The four "no SARIF" cases are the point of this file. A gate that returns success when it finds
 * no SARIF reports a clean scan for an analysis that never ran, and since the analysis is never
 * uploaded to a code-scanning dashboard, nothing else would notice.
 *
 * The accepted-findings block is the second point. That register is the only way an
 * error-severity finding can leave this gate green, so its matchers have to be exact and its
 * staleness check has to bite: a register that quietly widened would disable the gate without
 * ever failing it.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- plain .mjs helper, deliberately outside the typed `src` project
import { ACCEPTED_FINDINGS, gate } from '../scripts/codeql-gate.mjs';

interface AcceptedFinding {
  ruleId: string;
  category: string;
  file: string;
  messageIncludes: string;
  reason: string;
  removedBy: string;
}

const runGate = gate as (paths: string[], register?: AcceptedFinding[]) => Promise<number>;
const register = ACCEPTED_FINDINGS as AcceptedFinding[];

interface SarifResult {
  ruleId: string;
  level?: string;
  message: { text: string };
}

interface SarifRule {
  id: string;
  properties: Record<string, string>;
}

function sarif(results: SarifResult[], rules: SarifRule[] = []): unknown {
  return { runs: [{ tool: { driver: { rules } }, results }] };
}

async function writeSarif(dir: string, name: string, doc: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(doc), 'utf8');
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeql-gate-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('no SARIF fails closed', () => {
  it('fails on an empty directory', async () => {
    expect(await runGate([dir])).toBe(1);
  });

  it('fails on a path that does not exist', async () => {
    expect(await runGate([join(dir, 'sarif-results')])).toBe(1);
  });

  it('fails on the default path when it is absent', async () => {
    expect(await runGate(['sarif-results'])).toBe(1);
  });

  it('fails on a directory holding only non-SARIF files', async () => {
    await writeFile(join(dir, 'results.json'), '{}', 'utf8');
    expect(await runGate([dir])).toBe(1);
  });
});

describe('gate verdicts', () => {
  it('passes when the SARIF holds no findings', async () => {
    await writeSarif(dir, 'results.sarif', sarif([]));
    expect(await runGate([dir])).toBe(0);
  });

  it('fails on an error-level result', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif([{ ruleId: 'x/y', level: 'error', message: { text: 'boom' } }]),
    );
    expect(await runGate([dir])).toBe(1);
  });

  it('fails on a result whose rule is error severity', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif(
        [{ ruleId: 'x/y', level: 'note', message: { text: 'boom' } }],
        [{ id: 'x/y', properties: { 'problem.severity': 'error' } }],
      ),
    );
    expect(await runGate([dir])).toBe(1);
  });

  it('passes on warning-only findings', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif(
        [{ ruleId: 'x/y', level: 'warning', message: { text: 'meh' } }],
        [{ id: 'x/y', properties: { 'problem.severity': 'warning' } }],
      ),
    );
    expect(await runGate([dir])).toBe(0);
  });

  // Regression test for the shape CodeQL actually emits. Real CodeQL SARIF leaves
  // `tool.driver.rules` EMPTY, puts every query-pack rule under `tool.extensions[].rules`, and
  // puts no `level` on results at all — severity lives only on the rule. A gate that resolves
  // rules from the driver alone builds an empty table, classifies nothing, and reports
  // "0 error-severity finding(s)" no matter what CodeQL found.
  it('detects an error whose rule metadata lives in tool.extensions, not tool.driver', async () => {
    await writeSarif(dir, 'results.sarif', {
      runs: [
        {
          tool: {
            driver: { name: 'CodeQL', rules: [] },
            extensions: [
              {
                name: 'codeql/javascript-queries',
                rules: [
                  {
                    id: 'js/sqli',
                    defaultConfiguration: { level: 'error' },
                    properties: { 'problem.severity': 'error' },
                  },
                ],
              },
            ],
          },
          results: [{ ruleId: 'js/sqli', message: { text: 'injection' } }],
        },
      ],
    });
    expect(await runGate([dir])).toBe(1);
  });

  it('discovers SARIF nested below the given directory', async () => {
    const nested = join(dir, 'runs', 'lang');
    await mkdir(nested, { recursive: true });
    await writeSarif(
      nested,
      'results.sarif',
      sarif([{ ruleId: 'x/y', level: 'error', message: { text: 'boom' } }]),
    );
    expect(await runGate([dir])).toBe(1);
  });
});

describe('accepted findings', () => {
  const accepted: AcceptedFinding = {
    ruleId: 'actions/some-query',
    category: '/language:actions',
    file: '.github/workflows/example.yml',
    messageIncludes: 'needs.authorize.outputs.release-commit',
    reason: 'assessed and accepted for the purposes of this test',
    removedBy: 'the finding no longer being reported',
  };

  /** A SARIF run in `category` holding one error-severity result at `file` saying `text`. */
  function analysed(category: string, results: { file: string; ruleId: string; text: string }[]) {
    return {
      runs: [
        {
          automationDetails: { id: `${category}/` },
          tool: { driver: { rules: [] } },
          results: results.map((result) => ({
            ruleId: result.ruleId,
            level: 'error',
            message: { text: result.text },
            locations: [{ physicalLocation: { artifactLocation: { uri: result.file } } }],
          })),
        },
      ],
    };
  }

  const matching = {
    ruleId: accepted.ruleId,
    file: accepted.file,
    text: `poisoning via ${accepted.messageIncludes}.`,
  };

  it('lets the accepted finding through', async () => {
    await writeSarif(dir, 'results.sarif', analysed(accepted.category, [matching]));
    expect(await runGate([dir], [accepted])).toBe(0);
  });

  it('still fails on a different rule in the accepted file', async () => {
    const otherRule = { ...matching, ruleId: 'actions/another-query' };
    await writeSarif(dir, 'results.sarif', analysed(accepted.category, [matching, otherRule]));
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('still fails on the same rule in a different file', async () => {
    const elsewhere = { ...matching, file: '.github/workflows/other.yml' };
    await writeSarif(dir, 'results.sarif', analysed(accepted.category, [matching, elsewhere]));
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('still fails on the same rule and file in a different analysis category', async () => {
    await writeSarif(dir, 'results.sarif', analysed('/language:javascript-typescript', [matching]));
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('still fails when the message no longer names the accepted untrusted input', async () => {
    const rephrased = { ...matching, text: 'poisoning via github.event.pull_request.head.sha.' };
    await writeSarif(dir, 'results.sarif', analysed(accepted.category, [rephrased]));
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('fails on a run with no category at all rather than accepting into the gap', async () => {
    await writeSarif(
      dir,
      'results.sarif',
      sarif([{ ruleId: accepted.ruleId, level: 'error', message: { text: matching.text } }]),
    );
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('fails when an acceptance matches nothing in an analysed category', async () => {
    await writeSarif(dir, 'results.sarif', analysed(accepted.category, []));
    expect(await runGate([dir], [accepted])).toBe(1);
  });

  it('does not enforce staleness for a category that was not analysed', async () => {
    await writeSarif(dir, 'results.sarif', analysed('/language:javascript-typescript', []));
    expect(await runGate([dir], [accepted])).toBe(0);
  });
});

/**
 * The register that actually ships. The mechanism is exercised above against a synthetic entry;
 * this asserts the real entries are usable by it and carry the reasoning an acceptance owes a
 * reader. An entry missing `messageIncludes`, say, would silently match every message.
 */
describe('the shipped acceptance register', () => {
  it('gives every entry all six fields, non-empty', () => {
    const fields: (keyof AcceptedFinding)[] = [
      'ruleId',
      'category',
      'file',
      'messageIncludes',
      'reason',
      'removedBy',
    ];
    for (const entry of register) {
      for (const field of fields) {
        expect(typeof entry[field], `${entry.ruleId}.${field}`).toBe('string');
        expect(entry[field].length, `${entry.ruleId}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('accepts named findings only, never a whole rule, file or category', () => {
    for (const entry of register) {
      expect(entry.file).not.toContain('*');
      expect(entry.ruleId).not.toContain('*');
      expect(entry.messageIncludes).not.toContain('*');
    }
  });
});
