#!/usr/bin/env node
/**
 * CodeQL SARIF gate — fails the build on any error-severity finding.
 *
 * Code scanning is not enabled on this private repo (no GitHub Advanced Security), so
 * `codeql-action/analyze` cannot upload its SARIF and would otherwise fail the job outright with
 * "Code scanning is not enabled for this repository". The workflow therefore runs the analysis
 * with `upload: never` and writes the SARIF locally; this script reads it and fails on any result
 * whose rule carries `problem.severity: error` (or whose own `level` is `error`).
 *
 * There is no code-scanning dashboard to review the findings in, so this gate IS the enforcement.
 * It fails closed: finding no .sarif at all exits 1 rather than reporting a pass, because a
 * missing SARIF means the analysis did not run, not that the code is clean.
 *
 * CodeQL emits its rule metadata under `runs[].tool.extensions[].rules`, NOT under
 * `runs[].tool.driver.rules` (which it leaves empty), and it does not put a `level` on individual
 * results at all — severity lives on the rule. Resolving rules from the driver alone therefore
 * built an empty lookup table and made every result unclassifiable, so the gate could not fail on
 * an error-severity finding even in principle. Rules are now read from the driver AND every
 * extension, and a rule's `defaultConfiguration.level` counts alongside `problem.severity`.
 *
 * Warning- and note-severity findings are REPORTED but deliberately do NOT affect the exit code.
 * They used to be invisible: the only line this script printed counted error-severity results, so
 * "CodeQL: 0 error-severity finding(s)" read as "CodeQL found nothing" when it often meant "CodeQL
 * found things, none of which this gate is allowed to fail on". The advisory summary exists so
 * that distinction is visible in the log. Raising the floor to fail on warnings is a separate,
 * deliberate decision — it is not made here, and nothing that passes today starts failing.
 *
 *     node scripts/codeql-gate.mjs <sarif-dir-or-file> [...]
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Report order for the advisory summary; anything unrecognized sorts after these.
const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };

const severityRank = (severity) => SEVERITY_ORDER[severity] ?? 99;

// Composite map key for the per-rule tally; NUL cannot occur in a CodeQL rule id.
const KEY_SEP = '\u0000';

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

function reportAdvisory(counts, perRule) {
  const advisory = [...counts.entries()].filter(([severity]) => severity !== 'error');
  if (advisory.length === 0) {
    console.log('CodeQL: no warning- or note-severity findings either.');
    return;
  }
  advisory.sort(([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b));
  const parts = advisory.map(([severity, n]) => `${n} ${severity}`).join(', ');
  console.log(
    `CodeQL (advisory, NOT gated): ${parts}. These do not affect the exit code — this gate ` +
      `fails on error-severity only. Listed so a green check is not read as 'nothing found'.`,
  );
  const rows = [...perRule.entries()]
    .map(([key, n]) => [...key.split(KEY_SEP), n])
    .filter(([severity]) => severity !== 'error');
  rows.sort(
    ([sevA, ruleA, nA], [sevB, ruleB, nB]) =>
      severityRank(sevA) - severityRank(sevB) || nB - nA || ruleA.localeCompare(ruleB),
  );
  for (const [severity, ruleId, n] of rows) {
    console.log(`  ${severity.padEnd(9)} ${String(n).padStart(4)}  ${ruleId}`);
  }
}

export async function gate(paths) {
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
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  let totalErrors = 0;
  for (const file of files) {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    for (const run of doc.runs ?? []) {
      const rules = collectRules(run);
      for (const result of run.results ?? []) {
        const severity = severityOf(result, rules);
        bump(counts, severity);
        bump(perRule, `${severity}${KEY_SEP}${result.ruleId ?? '?'}`);
      }
      const errors = (run.results ?? []).filter((result) => isError(result, rules));
      totalErrors += errors.length;
      for (const error of errors) {
        const location = (error.locations ?? [{}])[0]?.physicalLocation ?? {};
        const uri = location.artifactLocation?.uri ?? '?';
        const line = location.region?.startLine ?? '?';
        console.error(
          `::error file=${uri},line=${line}::[${error.ruleId}] ${error.message?.text ?? ''}`,
        );
      }
    }
  }
  console.log(
    `CodeQL: ${totalErrors} error-severity finding(s) across ${files.length} SARIF file(s).`,
  );
  reportAdvisory(counts, perRule);
  return totalErrors > 0 ? 1 : 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  const paths = process.argv.slice(2);
  process.exitCode = await gate(paths.length > 0 ? paths : ['sarif-results']);
}
