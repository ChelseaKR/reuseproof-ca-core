# ADR-0010: A register for accepted CodeQL findings, and a cache-free default branch

- **Status:** accepted
- **Date:** 2026-08-26
- **Deciders:** product/engineering foundation owner
- **Supersedes:** no earlier ADR; extends the CodeQL gate introduced in #24 and #26

## Context

The `codeql` workflow has failed on `main` since the scheduled run of
2026-08-18. The last green scheduled run was 2026-08-11. The failure is real
and reproducible: the `actions` language pack reports one error-severity
finding, and `scripts/codeql-gate.mjs` correctly refuses to pass.

```
##[error][actions/cache-poisoning/poisonable-step] Potential cache poisoning in
the context of the default branch due to privilege checkout of untrusted code
from [needs.authorize.outputs.release-commit](1). ([workflow_dispatch](2)).
CodeQL: 1 error-severity finding(s) across 1 SARIF file(s).
```

The finding points at `.github/workflows/release.yml` line 66, the
`run: make verify` step. The chain the query describes is:

1. `release.yml` is triggered by `workflow_dispatch`, so the run carries
   `refs/heads/main` and therefore write access to the default branch's Actions
   cache scope;
2. its `verify-at-tag` job checks out
   `${{ needs.authorize.outputs.release-commit }}`, a ref CodeQL cannot prove
   is trusted; and
3. it then executes that commit's own code via `make verify`.

Arbitrary code in step 3 can write the default branch's cache scope directly
through the runner's cache credentials, whatever actions the job does or does
not use. `package-manager-cache: false` on `setup-node` (#18) does not close
that, because the attack does not need `setup-node`.

The finding was not introduced by a workflow change. It was introduced by #26,
which repaired a gate that could never fail: rules were resolved only from
`tool.driver.rules`, which CodeQL leaves empty, so every result was
unclassifiable and the gate reported "0 error-severity finding(s)" regardless
of what CodeQL found. Repairing the gate surfaced a finding that had been
present and invisible. The red build is the gate working.

Three properties of the CodeQL query decide what can be done about it. They
were read from `github/codeql` at
`actions/ql/src/Security/CWE-349/CachePoisoningViaPoisonableStep.ql` and its
supporting libraries, not inferred from the message:

- The query is silenced by a `ControlCheck` that dominates the checkout. Every
  control check in `ControlChecks.qll` declares the events it is effective
  against via `actor_is_attacker_event()` and `actor_not_attacker_event()`, and
  `workflow_dispatch` appears in neither list. No control check, including a
  deployment `environment:`, can protect a `workflow_dispatch`-triggered job.
- `hasDefaultBranchCacheWriteAccess` is decided by the trigger event alone.
  `workflow_dispatch` is in `defaultBranchCacheWriteEvent()`; nothing in the
  workflow can make that false while the workflow remains dispatchable.
- The checkout matches `ActionsSHACheckout` through a name heuristic: the ref
  expression's field name is matched against `.*(head|sha|commit).*`, and
  `release-commit` contains "commit".

## Decision

**1. Accept the finding, in a register that can only accept that one finding.**

`scripts/codeql-gate.mjs` gains `ACCEPTED_FINDINGS`. An entry carries four
matchers, all of which must hold: rule id, analysis category, file, and a
substring the finding's message must contain naming the specific untrusted
input. An entry excuses one finding of one rule about one input in one file. A
second instance of the same rule, in another file or about another input, is
still an error and still fails the build. Nothing is wildcarded, and nothing is
accepted by severity or by rule alone.

An entry that matches nothing fails the gate whenever its category was
analysed. An acceptance asserts that a specific finding exists and has been
reasoned about; when that stops being true the assertion is stale, and a stale
exemption in a security gate is what a blanket exemption grows from. A run
carrying no analysis category matches no entry at all, so its findings are
gated normally.

Every accepted finding is printed on every run with its reason and its removal
condition, so a green gate is never read as "CodeQL found nothing" — the same
reasoning that put the advisory summary in #26.

**2. Do not silence the finding by editing the workflow.**

The two changes that would clear the alert both weaken the control it is
complaining about:

- checking out `inputs.tag` instead of the authorize job's resolved commit
  would dodge the name heuristic and reintroduce a tag-move race between
  authorization and checkout; and
- not verifying at the tagged commit at all would remove the reason the job
  exists.

Renaming the `release-commit` output to evade `.*(head|sha|commit).*` would
change nothing about the code and hide the finding from every future reader. It
is rejected on those grounds, and is not available anyway: the output belongs to
a reusable workflow in another repository.

**3. Remove the impact instead: the default branch keeps no Actions cache.**

`ci.yml` set `cache: npm` on `setup-node`, which made it the one consumer of a
default-branch cache entry, and therefore the one place a poisoned entry could
land. It now sets `package-manager-cache: false`, matching `release.yml` since
#18. No workflow in this repository writes or restores an Actions cache. The
accepted finding describes a write with no reader.

## Consequences

Benefits:

- `main` can be green again without the gate being weakened, disabled, or made
  unable to fail;
- the accepted finding is stated in the repository, with its reasoning and its
  exit condition, rather than living in a closed PR thread;
- a stale acceptance fails the build instead of quietly widening;
- the cache-poisoning chain has no consumer, so the accepted finding is not
  merely tolerated but defanged; and
- `npm ci` without a restored cache is the more deterministic install, which is
  the posture the rest of this repository already takes.

Costs and limits:

- an acceptance register is a mechanism that could be misused; the matcher
  design, the staleness failure and `tests/codeql-gate.test.ts` are what keep it
  from becoming a severity-level or rule-level exemption, and a review that lets
  a wildcard or a bare rule id into the register loses that;
- CI installs dependencies without a cache and is correspondingly slower, on the
  order of seconds for this dependency tree;
- accepting the finding does not make the underlying pattern safe in general. It
  is safe here because `release.yml` verifies a commit an authorize job resolved
  from a signed tag on `main`, and because nothing restores a cache. A future
  workflow that checks out an unauthorized ref, or a future re-introduction of
  caching, invalidates that reasoning and must not reuse this acceptance; and
- the register is enforced only where CodeQL emits an analysis category. The
  workflow passes `category:` explicitly, and a run without one is gated rather
  than accepted, so the failure direction is closed.

## Not decided here

Whether to restore SARIF upload to GitHub code scanning. It was disabled because
code scanning was unavailable while this repository was private; the repository
is now public, so upload would work. That is a separate change with its own
trade-off, and the local gate remains the enforcement either way.
