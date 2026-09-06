#!/usr/bin/env node
/**
 * CodeQL SARIF gate — fails the build on any error-severity finding.
 *
 * The workflow runs the analysis with `upload: never` and writes the SARIF locally; this script
 * reads it and fails on any result whose rule carries `problem.severity: error` (or whose own
 * `level` is `error`). That arrangement dates from when this repository was private and code
 * scanning was unavailable, so `codeql-action/analyze` failed outright with "Code scanning is not
 * enabled for this repository". It stays because it is the enforcement: a local gate fails the
 * job, whereas an uploaded SARIF only populates a dashboard nobody is obliged to read.
 *
 * The gate fails closed: finding no .sarif at all exits 1 rather than reporting a pass, because a
 * missing SARIF means the analysis did not run, not that the code is clean.
 *
 * CodeQL emits its rule metadata under `runs[].tool.extensions[].rules`, NOT under
 * `runs[].tool.driver.rules` (which it leaves empty), and it does not put a `level` on individual
 * results at all — severity lives on the rule. Resolving rules from the driver alone therefore
 * built an empty lookup table and made every result unclassifiable, so the gate could not fail on
 * an error-severity finding even in principle. Rules are now read from the driver AND every
 * extension, and a rule's `defaultConfiguration.level` counts alongside `problem.severity`.
 *
 * CodeQL carries TWO severities per rule and they do not agree. `problem.severity` grades how
 * confident and how noisy the QUERY is; `security-severity` is the CVSS score of the WEAKNESS it
 * found. Gating on `problem.severity` alone therefore lets HIGH security findings through green:
 * `js/incomplete-url-substring-sanitization` is `problem.severity: warning` carrying
 * `security-severity: 7.8`, which GitHub itself renders as a **High** security alert. A security
 * gate whose green check is compatible with an unreviewed CVSS 7.8 finding is not gating security
 * — it is gating query noise and reporting the result as if it were the other thing.
 *
 * So the floor is two-sided: a finding gates when `problem.severity` (or its own `level`, or its
 * rule's default level) is `error`, OR when its `security-severity` is at or above 7.0, GitHub's
 * own high/critical boundary for code-scanning alerts. This gate and the Security tab then agree
 * about what "High" means, if this repository ever gets Code Security.
 *
 * Everything below both floors is REPORTED but does NOT affect the exit code, now with its CVSS
 * score where it has one. Those findings used to be invisible: the only line this script printed
 * counted error-severity results, so "CodeQL: 0 error-severity finding(s)" read as "CodeQL found
 * nothing" when it often meant "CodeQL found things, none of which this gate was allowed to fail
 * on". Raising the advisory floor further is a separate, deliberate decision, not made here.
 *
 * A very small number of error-severity findings are accepted rather than fixed. They are listed
 * in ACCEPTED_FINDINGS below with the reasoning and the condition that would retire them, and they
 * are printed on every run so a green gate never means "CodeQL found nothing". See ADR-0010.
 *
 *     node scripts/codeql-gate.mjs <sarif-dir-or-file> [...]
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Report order for the advisory summary; anything unrecognized sorts after these.
const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };

/**
 * CVSS score at or above which a finding gates the build whatever its `problem.severity` says.
 *
 * 7.0 is GitHub's own high/critical boundary for code-scanning alerts. Lowering this number is a
 * decision about what this repository will ship with; it is never the way to make a red gate green.
 */
export const SECURITY_SEVERITY_FLOOR = 7.0;

/**
 * The rule's CVSS score, or `undefined` when it carries none.
 *
 * SARIF spells it as a string. A value that is present but unparseable is NOT silently treated as
 * absent: it returns `NaN`, which fails the comparison below and leaves the finding gated by
 * `problem.severity` alone while `describeSeverity` still prints the raw text, so a malformed
 * score is visible rather than rounded down to "no security severity" — the absence-as-a-value
 * shape this repository's gates exist to refuse.
 */
function securitySeverity(result, rulesById) {
  const raw = rulesById.get(result.ruleId)?.properties?.['security-severity'];
  return raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
}

/** Whether this finding's CVSS score is at or above the gating floor. */
function isHighSecurity(result, rulesById) {
  const score = securitySeverity(result, rulesById);
  return score !== undefined && Number.isFinite(score) && score >= SECURITY_SEVERITY_FLOOR;
}

const severityRank = (severity) => SEVERITY_ORDER[severity] ?? 99;

// Composite map key for the per-rule tally; NUL cannot occur in a CodeQL rule id.
const KEY_SEP = '\u0000';

/**
 * Gated findings this repository has assessed and accepted.
 *
 * An entry is NOT a way to quiet a query. Every field is a matcher and all four must hold, so an
 * entry excuses one finding of one rule, in one analysis category, in one file, about one named
 * untrusted input. A second instance of the same rule — another file, another input — is still an
 * error and still fails the build. Nothing here is wildcarded and nothing here is by severity.
 *
 * An entry that matches nothing FAILS the gate whenever its category was analysed. An acceptance
 * is a claim that a specific finding exists and has been reasoned about; once that stops being
 * true the claim is stale, and a stale exemption sitting in a security gate is exactly the thing
 * that quietly becomes a blanket one. Fixing the finding therefore also means deleting its entry.
 *
 * `category` is matched against the SARIF run's `automationDetails.id` (the `category:` passed to
 * `codeql-action/analyze`, trailing slash ignored). A run carrying no category matches no entry,
 * so its findings are gated normally — fail closed, not open.
 */
export const ACCEPTED_FINDINGS = [
  {
    ruleId: 'actions/cache-poisoning/poisonable-step',
    category: '/language:actions',
    file: '.github/workflows/release.yml',
    messageIncludes: 'needs.authorize.outputs.release-commit',
    reason:
      'release.yml checks out the commit its authorize job resolved from a signed stable SemVer ' +
      'tag on main, then runs `make verify` there. CodeQL cannot see that authorization, and its ' +
      'control-check model has no construct that protects a workflow_dispatch event at all, so ' +
      'no hardening of this workflow can clear the alert. The two shapes that would clear it are ' +
      'both worse: checking out the raw tag input instead of the resolved commit reintroduces a ' +
      'tag-move race between authorization and checkout, and not verifying at the tagged commit ' +
      'removes the point of the job. The impact is instead removed at the other end: no workflow ' +
      'here restores an Actions cache any more (see ci.yml), so the default branch has no cache ' +
      'entry for a poisoned write to land in.',
    removedBy:
      'Either the release job stops checking out an authorize-resolved commit, or CodeQL gains a ' +
      'control check that models workflow_dispatch authorization. Re-run the actions analysis ' +
      'after any change to release.yml and delete this entry the moment the finding is gone.',
  },
];

// SARIF spells the analysis category as `automationDetails.id`, and codeql-action appends a
// trailing slash to whatever `category:` the workflow passed. Compare without it.
const runCategory = (run) => String(run.automationDetails?.id ?? '').replace(/\/+$/u, '');

const resultFile = (result) => result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '';

/** Whether `entry` excuses `result`. Every matcher must hold; none of them is optional. */
function accepts(entry, result, category) {
  return (
    entry.ruleId === result.ruleId &&
    entry.category === category &&
    entry.file === resultFile(result) &&
    String(result.message?.text ?? '').includes(entry.messageIncludes)
  );
}

function reportAccepted(accepted) {
  if (accepted.length === 0) {
    return;
  }
  console.log(
    `CodeQL: ${accepted.length} gating finding(s) ACCEPTED, not gated. Each was assessed ` +
      `and recorded in scripts/codeql-gate.mjs (ADR-0010); they are listed here so a green gate ` +
      `is never read as "CodeQL found nothing".`,
  );
  for (const entry of accepted) {
    console.log(`  ${entry.ruleId}  ${entry.file}`);
    console.log(`    why accepted: ${entry.reason}`);
    console.log(`    removed by:   ${entry.removedBy}`);
  }
}

/**
 * Accepted entries whose category was analysed but which matched no finding. Reported as errors:
 * see the note on ACCEPTED_FINDINGS for why a stale acceptance must not be allowed to linger.
 */
function staleAcceptances(register, matched, categoriesSeen) {
  const stale = register.filter(
    (entry) => categoriesSeen.has(entry.category) && !matched.has(entry),
  );
  for (const entry of stale) {
    console.error(
      `::error::accepted finding [${entry.ruleId}] in ${entry.file} was not reported by the ` +
        `${entry.category} analysis. Either it is fixed — delete its entry from ACCEPTED_FINDINGS ` +
        `in scripts/codeql-gate.mjs — or the matchers no longer describe it and the acceptance ` +
        `must be re-examined rather than re-fitted.`,
    );
  }
  return stale.length;
}

async function sarifFiles(paths) {
  const out = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          out.push(...(await sarifFiles([child])));
        } else if (entry.name.endsWith('.sarif')) {
          out.push(child);
        }
      }
    } else if (path.endsWith('.sarif')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every rule the run can cite, keyed by id. CodeQL puts query-pack rules in
 * `tool.extensions[].rules` and leaves `tool.driver.rules` empty. Reading only the driver yields
 * an empty table, which silently declassifies every result — the gate then reports
 * "0 error-severity finding(s)" no matter what was found.
 */
function collectRules(run) {
  const tool = run.tool ?? {};
  const rules = new Map();
  for (const component of [tool.driver ?? {}, ...(tool.extensions ?? [])]) {
    for (const rule of component.rules ?? []) {
      if (!rules.has(rule.id)) {
        rules.set(rule.id, rule);
      }
    }
  }
  return rules;
}

function isError(result, rulesById) {
  if (String(result.level ?? '').toLowerCase() === 'error') {
    return true;
  }
  const rule = rulesById.get(result.ruleId) ?? {};
  const severity = rule.properties?.['problem.severity'] ?? '';
  if (String(severity).toLowerCase() === 'error') {
    return true;
  }
  // CodeQL omits `level` on results and carries the severity on the rule instead, so the rule's
  // own default level is the deciding signal for most findings.
  return String(rule.defaultConfiguration?.level ?? '').toLowerCase() === 'error';
}

/**
 * Bucket a result for reporting. `error` is decided by `isError` and by nothing else, so reporting
 * can never disagree with the exit code — in particular a result whose own `level` is `note` but
 * whose rule is `problem.severity: error` still counts as an error.
 */
function severityOf(result, rulesById) {
  if (isError(result, rulesById)) {
    return 'error';
  }
  const level = String(result.level ?? '').toLowerCase();
  if (level) {
    return level;
  }
  const rule = rulesById.get(result.ruleId) ?? {};
  const severity = String(rule.properties?.['problem.severity'] ?? '').toLowerCase();
  if (severity) {
    // CodeQL's `recommendation` is SARIF's `note`.
    return severity === 'recommendation' ? 'note' : severity;
  }
  const defaultLevel = String(rule.defaultConfiguration?.level ?? '').toLowerCase();
  // SARIF's own default when nothing states a level is `warning`.
  return defaultLevel || 'warning';
}

function reportAdvisory(counts, perRule, scoreByRule) {
  const advisory = [...counts.entries()];
  if (advisory.length === 0) {
    console.log('CodeQL: no below-floor findings either.');
    return;
  }
  advisory.sort(([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b));
  const parts = advisory.map(([severity, n]) => `${n} ${severity}`).join(', ');
  console.log(
    `CodeQL (advisory, NOT gated): ${parts}. These do not affect the exit code — they are neither ` +
      `error-severity nor CVSS >= ${SECURITY_SEVERITY_FLOOR}. Listed, with their security ` +
      `severity where they carry one, so a green check is not read as 'nothing found'.`,
  );
  const rows = [...perRule.entries()].map(([key, n]) => [...key.split(KEY_SEP), n]);
  rows.sort(
    ([sevA, ruleA, nA], [sevB, ruleB, nB]) =>
      severityRank(sevA) - severityRank(sevB) || nB - nA || ruleA.localeCompare(ruleB),
  );
  for (const [severity, ruleId, n] of rows) {
    const score = scoreByRule.get(ruleId);
    const cvss = score === undefined ? '' : `  CVSS ${score}`;
    console.log(`  ${severity.padEnd(9)} ${String(n).padStart(4)}  ${ruleId}${cvss}`);
  }
}

export async function gate(paths, register = ACCEPTED_FINDINGS) {
  const files = await sarifFiles(paths);
  if (files.length === 0) {
    // FAIL, never pass. No SARIF does not mean "no findings" — it means the analysis did not run,
    // or wrote somewhere else, or the output path changed under us. Returning success here would
    // make the gate go green vacuously: CodeQL could silently stop producing results and every
    // build would still show a passing security check. A gate that cannot see its input has not
    // verified anything, so it must not report success.
    console.error(
      `::error::no .sarif files found under ${JSON.stringify(paths)} — CodeQL produced no ` +
        `output, so nothing was analyzed. This is a gate failure, not a pass: check the analyze ` +
        `step's \`output:\` path and that the analyze step actually ran.`,
    );
    return 1;
  }
  const counts = new Map();
  const perRule = new Map();
  const scoreByRule = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const matched = new Set();
  const categoriesSeen = new Set();
  const accepted = [];
  let totalGated = 0;
  let gatedBySecurity = 0;
  for (const file of files) {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    for (const run of doc.runs ?? []) {
      const rules = collectRules(run);
      const category = runCategory(run);
      if (category) {
        categoriesSeen.add(category);
      }
      for (const result of run.results ?? []) {
        // Acceptance is checked before classification so an accepted finding is neither counted
        // as an error nor smuggled into the advisory tally as something milder than it is.
        const entry = register.find((candidate) => accepts(candidate, result, category));
        if (entry) {
          matched.add(entry);
          accepted.push(entry);
          continue;
        }
        const severity = severityOf(result, rules);
        const score = securitySeverity(result, rules);
        if (score !== undefined) {
          scoreByRule.set(result.ruleId ?? '?', String(score));
        }
        // Two floors, either of which gates. `problem.severity` grades the query;
        // `security-severity` grades the weakness. A CVSS 7.8 finding that CodeQL labels
        // `warning` is a High security alert, and gating on the query grade alone would report it
        // as advisory and exit 0.
        const highSecurity = isHighSecurity(result, rules);
        if (!isError(result, rules) && !highSecurity) {
          bump(counts, severity);
          bump(perRule, `${severity}${KEY_SEP}${result.ruleId ?? '?'}`);
          continue;
        }
        totalGated += 1;
        if (highSecurity && !isError(result, rules)) {
          gatedBySecurity += 1;
        }
        const location = (result.locations ?? [{}])[0]?.physicalLocation ?? {};
        const uri = location.artifactLocation?.uri ?? '?';
        const line = location.region?.startLine ?? '?';
        const why = highSecurity ? `severity ${severity}, CVSS ${score}` : `severity ${severity}`;
        console.error(
          `::error file=${uri},line=${line}::[${result.ruleId}] (${why}) ` +
            `${result.message?.text ?? ''}`,
        );
      }
    }
  }
  console.log(
    `CodeQL: ${totalGated} gated finding(s) across ${files.length} SARIF file(s) — ` +
      `error-severity, or CVSS >= ${SECURITY_SEVERITY_FLOOR} (${gatedBySecurity} gated on the ` +
      `security floor alone).`,
  );
  reportAccepted(accepted);
  reportAdvisory(counts, perRule, scoreByRule);
  return totalGated + staleAcceptances(register, matched, categoriesSeen) > 0 ? 1 : 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  const paths = process.argv.slice(2);
  process.exitCode = await gate(paths.length > 0 ? paths : ['sarif-results']);
}
