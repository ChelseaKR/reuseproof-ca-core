# ADR-0011: No gate may report success for a check it did not perform

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** product/engineering foundation owner
- **Supersedes:** no earlier ADR; extends the merge gate defined in `DEFINITION_OF_DONE.md`

## Context

A CI audit of this repository (`docs/plans/improvement-plan.md`) classified all
32 recorded workflow failures. The headline result is that the pipeline was
never flaky: 21 of the 32 failures were jobs GitHub declined to start because of
an account-level Actions billing condition. They ran zero steps and produced no
logs, yet they are reported as an ordinary `failure`, indistinguishable in
`gh run list` from a gate that ran and found a defect.

That is the same shape, inverted, as the defect this repository already knows
about from ADR-0010 and from `scripts/codeql-gate.mjs`: a result whose text does
not say whether anything was actually examined. ADR-0010 fixed one direction —
a SARIF gate that reported "0 error-severity findings" whether or not CodeQL had
classified anything. The audit found two more instances of the same shape, both
inside `make verify`, and both capable of going **green** while checking
nothing.

### Instance one: marker hygiene passed on an empty scan

`scripts/check-hygiene.mjs` walked `src`, `scripts` and `tests` for `.ts` and
`.mjs` files, collected violations, and exited 0 when it found none. It never
distinguished "found no violations in 47 files" from "found no files". Pointed
at a directory holding a `.yml` file with a bare marker in it, the script exited
0 having read nothing at all.

So the gate reported marker hygiene as enforced in every case where the roots or
the extension set stopped describing where this repository keeps its source: a
root renamed, a move to a `packages/` layout, a new source file type. It was
also the only `make verify` step with no test behind it — coverage is measured
over `src/**/*.ts`, so nothing under `scripts/` was covered or gated.

### Instance two: coverage threshold keys stopped applying in silence

`vitest.config.ts` raises the coverage floor from 80% to 95% for the safety core
by naming threshold keys: `src/domain/**` plus five files. Vitest applies a
keyed threshold only to files the key matches, and **ignores a key that matches
nothing without any diagnostic**. Verified by experiment: renaming the key
`src/report-schema.ts` to a path that does not exist left `vitest run --coverage`
at exit 0, silent. Raising a *matching* key's floor above the real number failed
correctly, so the floor itself works — the unmatched key is the hole.

The consequence is that renaming a safety-core file drops it from the 95% floor
to the 80% global floor with nothing reporting it, and the sentence in
`DEFINITION_OF_DONE.md` promising "the 95% per-file safety-core floor" quietly
stops being true.

### A third, smaller gap: the advertised demo had no gate

`README.md` tells a reader to run `npm run demo`. `scripts/demo.ts` was
type-checked and compiled by `npm run build` but executed by nothing, and
`fixtures/reconciled-demo.json` — the fixture it reads — was read by no test.
The public quickstart could break with the merge gate green.

## Decision

**A gate in `make verify` must fail when it cannot establish that it performed
its check, and a green gate must state what it covered.** Concretely:

1. `scripts/check-hygiene.mjs` exports a testable `checkHygiene(roots)`. It
   fails when the scan finds zero files, fails with a sentence naming the root
   when a configured root cannot be read, and on success prints the number of
   files it examined. `tests/hygiene.test.ts` covers both the mechanism and the
   shipped roots.

2. `tests/coverage-thresholds.test.ts` asserts every keyed coverage threshold
   still governs at least one file that exists; that no keyed threshold sets a
   metric *below* the global floor (a key that reads as a safety rule while
   actually exempting those files); that every keyed threshold states every
   metric; and that the guard understands every key shape it is given — an
   unrecognised pattern fails rather than being skipped, because a guard that
   silently stops checking is the defect this ADR is about.

3. `make verify` gains an eighth step, `npm run demo:check`, which runs the
   already-built demo against the shipped fixture. It reuses the artifacts from
   the preceding `npm run build` rather than rebuilding, and its output is
   discarded: the assertion is that the documented quickstart completes without
   throwing on the fixture this repository ships.

The merge gate remains a single target that CI invokes literally, so local and
CI behaviour still cannot drift.

## Consequences

- `DEFINITION_OF_DONE.md` now enumerates eight gate steps, and adds the rule
  that a gate must not report success for a check it did not perform. That
  sentence is enforceable: each of the three guards above was broken
  deliberately, observed failing, and restored.
- `make verify` runs the demo, so a change that breaks the public quickstart or
  invalidates `fixtures/reconciled-demo.json` now fails the merge gate. The cost
  is a sub-second subprocess.
- The hygiene gate is louder on success. That is deliberate: "no bare markers"
  and "scanned 49 files, no bare markers" are different claims, and only the
  second one is checkable by a reader.
- The coverage guard duplicates, in a test, the shape of the configuration it
  guards. That duplication is the mechanism: the test asserts the configuration
  and the filesystem still agree.

## What this ADR does not decide

- It does not raise any coverage floor, change any threshold value, or alter
  what marker hygiene considers a violation. Every guard added here reports on
  the existing rules; none of them tightens one.
- It does not address the audit's highest-ranked finding, **F1: the CodeQL jobs
  are not required status checks on `main`**, so every CodeQL failure to date —
  including four runs reporting a genuine error-severity finding — was advisory
  at the merge boundary. That is a repository ruleset change, not a working-tree
  change, and it is recorded as blocked in `docs/plans/improvement-plan.md`.
- It does not attempt to detect the Actions billing starvation that caused most
  of the failure record. A workflow cannot observe the condition that prevents
  it from starting, and a check claiming to watch for it would be precisely the
  false-green shape this ADR rejects. The signature is written down instead.
