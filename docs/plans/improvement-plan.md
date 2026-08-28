# CI diagnosis and improvement plan

Opened 2026-08-28. Working document: the diagnosis is settled, the plan below
is executed in phases and the log at the bottom records each one as it lands.

Nothing in this document changes a regulatory interpretation, a citation, or a
domain rule. Every change it proposes is to CI, tooling, and the repository's
own gates.

---

## Part 1 — Why CI kept failing

### The headline

**The pipeline was not flaky and the tests never failed intermittently. It was
starved.** Twenty-one of the thirty-two recorded workflow failures are jobs that
GitHub refused to start because of an account-level GitHub Actions billing
condition. They ran zero steps, produced no logs, and are reported in
`gh run list` as a plain `failure` — visually identical to a gate that ran and
found a real defect. That is why a 40%-failing pipeline attracted no issue:
nothing in the failure surface distinguished "the gate failed" from "the gate
never ran".

### Evidence

Every failed run of a repository-owned workflow (`ci`, `codeql`, `trufflehog`,
`release`), classified by its GitHub check-run annotation. Runs where the job
never started carry no steps and no log; the annotation is the only record.

| # runs | Class | Signature | Dates | Status |
| --- | --- | --- | --- | --- |
| 21 | **A — Actions billing starvation** | job never started, 0 steps, 3–5s wall time; annotation `The job was not started because an Actions budget is preventing further use` (9 runs) or `…recent account payments have failed or your spending limit needs to be increased` (11 runs); 1 run (`32218231617`) has the same zero-step shape but no retained annotation and a 12m queue wait, so it is classified here by inference, not evidence | 2026-07-21 → 2026-08-23 | Resolved as a side effect of the repository becoming public (free standard-runner minutes). Not recorded anywhere until now. |
| 4 | **B — CodeQL `actions/cache-poisoning/poisonable-step`** | step `Fail on error-severity findings` exits 1 on a real error-severity finding in `release.yml` | 2026-08-23 → 2026-08-25 | Fixed on `main` by #36 (ADR-0010 acceptance register). Verified green on three subsequent runs. |
| 3 | **C — CodeQL upload rejected** | step `github/codeql-action/analyze` fails with `Code scanning is not enabled for this repository` | 2026-07-28 → 2026-08-01 | Fixed by `upload: never` plus the local SARIF gate (#23/#26). |
| 2 | **D — TruffleHog CLI misuse** | step `TruffleHog (verified secrets only)` exits 1 having scanned nothing: the action already passes `--fail` and the workflow passed it again, which is a hard CLI error | 2026-08-02, 2026-08-09 | Fixed by #29 (drop the duplicate flag, pin the scanner image). |
| 2 | **E — genuine `make verify` failure** | step `Run the repository merge gate` exits 2 on a work-in-progress branch | 2026-08-12 (both) | Not a defect. This is the gate doing its job, red then green inside one PR. |

**Zero flaky tests. Zero races. Zero timeouts. Zero resource limits inside a
job.** Class E is the only class where a repository gate found a repository
problem, and it behaved correctly.

Rates, measured over all 135 recorded runs (117 of them repository-owned; the
rest are `Dependabot Updates`, which is GitHub's own updater job, not a gate):

- All-time repository-owned workflow runs: 78 success, 32 failure, 7 cancelled.
- Last 20 repository-owned runs: **10 success, 10 failure (50%)**.
- Last 20 runs as `gh run list --limit 20` displays them (Dependabot Updates
  included): 12 success, 8 failure — the "8 of the last 20" figure.
- Per workflow, all time: `ci` 44/58 green, `codeql` 33/54 green, `trufflehog`
  **1/5 green**, `release` has never run.

### Two things the taxonomy exposes that were not the presenting complaint

**`trufflehog` has produced exactly one real scan in its life.** Of five
scheduled runs, two were starved (class A), two exited at startup on the
duplicate-`--fail` error (class D) and one — 2026-08-23 — actually scanned:
374 chunks, 1,428,375 bytes, 0 verified secrets. For roughly a month the weekly
full-history secret sweep read nothing. It failed rather than passing falsely,
which is the correct direction, but no one was reading the result.

**Every CodeQL failure was advisory.** See finding F1.

### Recurrence risk

Class A is an account condition, not a repository defect, and it is not fixable
in this repository. It stopped because the repository went public between
02:27Z and 08:20Z on 2026-08-23; public repositories get standard-runner minutes
free. If the repository is ever made private again, or if a private sibling
repository exhausts the same account budget, every workflow here starves again
and reports the same indistinguishable red. The mitigation available in-tree is
to write the signature down so the next reader spends minutes rather than hours:
**a `failure` with zero steps and a sub-10-second wall time is a starved job,
not a gate result.** That is now recorded in `README.md` and here.

---

## Part 2 — Findings, ranked

The portfolio's governing rule is that a check which cannot fail is worse than
no check. These are ranked by how badly each one violates it.

### F1 — CodeQL is not a required status check (BLOCKED: repository settings)

The `protect-main` ruleset requires exactly one status check: `verify`. The two
CodeQL jobs, `analyze (javascript-typescript)` and `analyze (actions)`, are not
required. **All fourteen CodeQL failures — including four runs that reported a
genuine error-severity security finding — could not block a merge.**

`scripts/codeql-gate.mjs` says of itself that "a local gate fails the job,
whereas an uploaded SARIF only populates a dashboard nobody is obliged to read".
That is true and the gate is well built, but at the merge boundary it currently
has the same force as the dashboard it replaced: it turns a check red that
nothing consults.

Demonstrated live rather than inferred: as of 2026-08-28, PR #33 and PR #34 both
report `analyze (actions): FAILURE` and both report `mergeable: MERGEABLE`.

This cannot be fixed in the working tree. It is a repository ruleset change and
needs the owner. The precise remediation is in Part 4.

### F2 — `scripts/check-hygiene.mjs` passes vacuously on an empty scan

The gate walks `src`, `scripts` and `tests` for `.ts` and `.mjs` files. It never
reports how many files it examined, and it exits 0 when it examines none.
Demonstrated: pointed at a directory containing a `.yml` file with a bare marker
in it, the script exits 0 having read nothing.

So the gate goes green in all of these cases: a root directory renamed to
something that still exists but holds no source; the extension set drifting away
from the file types actually in use; a future move of `src/` under a `packages/`
layout. In each case `make verify` reports marker hygiene as enforced, and it is
not. It is also the only `make verify` step with no test of its own — coverage
is measured over `src/**/*.ts` only, so `scripts/` is neither covered nor
gated.

### F3 — coverage threshold globs silently stop applying

`vitest.config.ts` raises the coverage floor from 80% to 95% for the safety core
by naming globs: `src/domain/**` plus five specific files. Demonstrated: a glob
that matches nothing is ignored in silence — no warning, no error, exit 0.

The consequence is that **renaming a safety-core file drops its 95% floor to the
global 80% floor with no gate reporting it.** `DEFINITION_OF_DONE.md` states the
merge gate must include "the 95% per-file safety-core floor"; after such a
rename that statement stops being true and nothing says so. The floor itself
does bite when the glob matches (verified in both directions), so the defect is
specifically the unmatched-glob case.

### F4 — the advertised demo is executed by nothing

`README.md`'s quickstart tells a reader to run `npm run demo`, and
`CONTRIBUTING.md` points at `fixtures/` for reproduction. But
`fixtures/reconciled-demo.json` is read by no test — the test suite uses
`fixtures/demo.json` — and `scripts/demo.ts` is type-checked and compiled by
`npm run build` yet never executed by any gate. The public quickstart can break
while the merge gate stays green.

### F5 — markdown is outside the format gate (accepted, recorded)

`.prettierignore` excludes `*.md`, so all 28 markdown files — the entire public
documentation set — are outside `npm run format:check`. The README's Standards
Conformance table lists "Prettier + ESLint … all in `make verify`" without that
carve-out. This is a scope gap, not a false green: no gate claims to have
checked those files. Left as-is deliberately (reformatting 28 hand-wrapped
documents is churn with no correctness value), but now stated.

### F6 — internal documentation links are unchecked (assessed, no action)

28 markdown files, 100+ relative links, no link checker. Audited by hand as part
of this work: **zero broken links today** (the only two hits were footnote
markers inside a quoted CodeQL message, not links). A checker would add a gate
that currently cannot fail for the good reason that there is nothing to find.
Recorded, not built.

### F7 — TruffleHog could in principle go green having scanned nothing (declined)

The 2026-08-02 and 2026-08-09 failures were the scanner exiting at startup on a
duplicate `--fail`, which is the safe direction: it went red. A variant that
exited 0 having scanned nothing would be a false green, and nothing here would
notice — the job asserts the scanner's exit code and nothing about its
`{"chunks": N}` line.

Not built. The defence already in place is the right one: `version: '3.96.0'`
pins what actually runs, added in #29 precisely because SHA-pinning the action
does not pin the container it launches. Building a chunk-count assertion against
a failure mode that has not occurred would add machinery on speculation.
Recorded so a future reader knows it was considered.

### F8 — `codeql.yml` and `trufflehog.yml` run on `ubuntu-latest` (observation)

`ci.yml` pins `ubuntu-24.04`; the other two workflows do not. In a repository
that SHA-pins every action, pins the scanner image, and pins Node via `.nvmrc`,
that is an inconsistency. It caused none of the failures in the record. Noted,
not changed — it is a deliberate choice for someone who owns the security
workflows to make, not a defect this audit found evidence for.

---

## Part 3 — Plan

| Phase | Work | Value | State |
| --- | --- | --- | --- |
| 0 | Write the diagnosis down (this document); record the starved-job signature in `README.md` | Highest — the presenting complaint was that nobody had written down what was wrong | Done |
| 1 | F2: make the hygiene gate incapable of passing on an empty scan; give it tests | High — it is a merge-gate step that could go green having read nothing | Done |
| 2 | F3: assert every coverage-threshold glob still matches a file | High — protects the stated 95% safety-core floor from silently evaporating | Done |
| 3 | F4: execute the advertised demo inside the gate | Medium — closes the gap between a public promise and a check | Done |
| 4 | Docs, ADR and CHANGELOG alignment for phases 1–3 | Medium — `DEFINITION_OF_DONE.md` enumerates the gate; it has to stay true | Done |
| 5 | F1: make CodeQL block a merge | Highest, but not in-tree | **Blocked** — repository ruleset, owner action, command in Part 4 |

### Open pull requests, triaged against the taxonomy

Useful because three of the four open PRs are red for reasons already fixed on
`main`, not for anything wrong with the PR.

| PR | Red check | Class | What clears it |
| --- | --- | --- | --- |
| #32 | `verify`, both `analyze` jobs | A (starved, 2026-08-19) | A re-run. Nothing was ever executed, so the red says nothing about the change. |
| #33 | `analyze (actions)` | B (cache-poisoning finding) | Rebase on `main`; #36 landed the acceptance register that clears it. |
| #34 | `analyze (actions)` | B | Rebase on `main`. |
| #35 | none — fully green | — | Already re-ran after #36. |

---

## Part 4 — Blocked, and what unblocks it

### F1: require the CodeQL checks on `main`

The `protect-main` ruleset (id `19164559`) has one `required_status_checks`
entry, `verify`. Adding the two CodeQL job names makes the security gate
blocking. This is a repository-settings change; it cannot be represented as a
working-tree diff and needs the repository owner.

The two contexts to add are the job names as GitHub reports them:

- `analyze (javascript-typescript)`
- `analyze (actions)`

One caveat to decide before making the change: `codeql.yml` runs on
`pull_request: branches: [main]`, so both contexts are produced for every PR
into `main` and requiring them will not deadlock. The `release` and
`trufflehog` workflows do not run on pull requests and must **not** be added.

### Recurrence detection for class A

Not built. Detecting "the account is out of Actions budget" from inside a
workflow is not possible — the workflow is exactly what does not run. The only
honest mitigations are the written signature (done) and watching the Actions
billing page. Building a green check that claims to watch for this would be the
defect this audit exists to remove.

---

## Log

- **2026-08-28** — Diagnosis complete. Pulled all 135 recorded workflow runs,
  classified all 32 failures by check-run annotation. Confirmed the dominant
  cause is Actions billing starvation (20/32), not flakiness. Baseline
  `make verify` on `main` at `e3298ed`: **EXIT=0**, 20 test files, 471 tests.
- **2026-08-28** — Confirmed F3 empirically: threshold glob
  `src/report-schema-RENAMED.ts` (matches nothing) → EXIT=0, silent. Control:
  `src/report-render.ts` branches floor 95→99 → EXIT=1 with the expected
  message. Control: new untested `src/` file → EXIT=1 on the global floor.
- **2026-08-28** — Confirmed F2 empirically: hygiene script pointed at a root
  with no `.ts`/`.mjs` exits 0 having scanned nothing.
- **2026-08-28** — Confirmed the hygiene gate does bite in the ordinary case:
  bare marker appended to `src/index.ts` → `npm run hygiene` EXIT=1 naming the
  line; marker removed → EXIT=0.
- **2026-08-28** — Phase 1 landed. `scripts/check-hygiene.mjs` now exports
  `checkHygiene(roots)`, fails on an empty scan, fails naming the root when a
  root cannot be read, and prints its scan size on success.
  `tests/hygiene.test.ts` added, 21 cases.
- **2026-08-28** — Phase 2 landed. `tests/coverage-thresholds.test.ts`, 8 cases:
  every keyed threshold governs an existing file, no keyed threshold sits below
  the global floor, every keyed threshold states every metric, no file is
  governed twice, and an uninterpretable key shape fails rather than being
  skipped.
- **2026-08-28** — Phase 3 landed. `npm run demo:check` added and wired into
  `make verify` between `build` and `npm audit`; it reuses the build's artifacts
  rather than rebuilding.
- **2026-08-28** — Phase 4 landed. ADR-0011 written; `DEFINITION_OF_DONE.md`
  (eight steps, plus the empty-check rule), `CONTRIBUTING.md`, `README.md`,
  `SECURITY.md` and `CHANGELOG.md` updated. `README.md`'s ADR index was already
  missing ADR-0010; both it and ADR-0011 are now listed.
- **2026-08-28** — F1 confirmed live rather than inferred: PRs #33 and #34 are
  `MERGEABLE` with `analyze (actions): FAILURE`.
- **2026-08-28** — Every guard broken deliberately, observed failing, restored,
  observed passing. Eight break/restore pairs, listed in the handover.
- **2026-08-28** — Final `make verify`: **EXIT=0**, 22 test files, 500 tests
  (was 20 files, 471 tests). Marker hygiene line now reads
  "49 source file(s) scanned … no bare markers".
