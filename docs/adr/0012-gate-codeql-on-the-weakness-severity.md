# ADR-0012: Gate CodeQL on the weakness severity, not only on the query severity

- **Status:** accepted
- **Date:** 2026-09-06
- **Deciders:** product/engineering foundation owner
- **Extends:** ADR-0010 (accepted-CodeQL-findings register) and ADR-0011 (no gate
  may report success for a check it did not perform)

## Context

`scripts/codeql-gate.mjs` is the enforcement for CodeQL in this repository.
`codeql-action/analyze` runs with `upload: never` and writes SARIF locally, so
there is no Security tab to review; the gate's exit code is the only thing that
can stop a finding from landing.

Until now that exit code was decided by one field. A finding gated when its own
`level`, its rule's `problem.severity`, or its rule's `defaultConfiguration.level`
was `error`. Everything else was printed as advisory and exited 0.

**CodeQL carries two severities per rule and they measure different things.**

| Field | What it grades |
|---|---|
| `problem.severity` | the QUERY: how confident it is, how noisy it is |
| `security-severity` | the WEAKNESS: its CVSS score |

They routinely disagree. `js/incomplete-url-substring-sanitization` is
`problem.severity: warning` carrying `security-severity: 7.8` — GitHub's own
code-scanning UI renders that as a **High** security alert. Under the previous
floor a finding of that rule printed in the advisory block, the gate exited 0,
and the summary line read `CodeQL: 0 error-severity finding(s)`.

That line is true and misleading in the way ADR-0011 exists to forbid. A reader
takes it as "CodeQL found nothing". It means "CodeQL found things, none of which
this gate was allowed to fail on" — and one of those things could be an
unreviewed CVSS 7.8 weakness. A security gate whose green check is compatible
with that is not gating security. It is gating query noise and reporting the
result as though it were the other thing.

This is not hypothetical for the shape of this codebase: the sibling repository
`reuseproof-ca`, which carries a copy of this domain code, hit exactly this rule
and raised its floor for exactly this reason. Nothing about the difference in
repository visibility changes the argument.

## Decision

**The floor is two-sided.** A finding gates the build when either holds:

1. its `level`, its rule's `problem.severity`, or its rule's
   `defaultConfiguration.level` is `error`; **or**
2. its rule's `security-severity` is at or above **7.0**, GitHub's own
   high/critical boundary for code-scanning alerts.

Consequences that follow from ADR-0011 and are not negotiable separately:

- **A missing score is not a low score.** Most rules carry no
  `security-severity`; those are gated by `problem.severity` alone, as before.
- **An unparseable score is not a missing score.** A `security-severity` that is
  present but not a number yields `NaN`, which fails the comparison — so the
  finding stays gated by `problem.severity` — and the raw text is still printed
  in the advisory table. A malformed score is visible rather than rounded down
  to "no security severity", which would be absence rendered as a value.
- **Below-floor findings are reported with their CVSS score.** An advisory a
  reader cannot locate or rank is not advice.
- **The score is resolved from `tool.extensions` as well as `tool.driver`.**
  Real CodeQL SARIF leaves `tool.driver.rules` empty. A floor that read only the
  driver would find no scores in practice and would pass every real run while
  looking identical to one that had checked. ADR-0010 already fixed this for
  `problem.severity`; the same resolution now carries the security severity.

The number 7.0 is a decision about what this repository is willing to ship with.
Lowering it is never the way to make a red gate green: a finding that should not
gate is either fixed or entered in `ACCEPTED_FINDINGS` with the reasoning and
the condition that retires it, per ADR-0010.

## Alternatives considered

**Gate on `security-severity` alone.** Rejected: it would drop every
error-severity finding with no CVSS score, including the `actions`
cache-poisoning class this repository has actually seen.

**Raise the advisory floor to fail on all warnings.** Rejected as a separate,
larger decision. It would fail on query noise, which is what `problem.severity`
is for, and it is not what the disagreement above is about.

**Leave the floor and rely on review of the advisory block.** Rejected. The
repository's governing rule is that a check nobody is obliged to read has the
force of the dashboard it replaced. The advisory block is exactly that.

## Consequences

- The gate can now fail on a finding CodeQL labels `warning`. That is intended,
  and the failure message names the severity and the CVSS score so the reason is
  legible.
- The summary line now reads `N gated finding(s) … (M gated on the security
  floor alone)`, so the two floors are distinguishable in the log.
- `tests/codeql-gate.test.ts` covers both floors, the exact boundary (against a
  literal, not against the constant, so raising the floor cannot keep the
  boundary test green), the missing-score case, the unparseable-score case, and
  the `tool.extensions` resolution.
