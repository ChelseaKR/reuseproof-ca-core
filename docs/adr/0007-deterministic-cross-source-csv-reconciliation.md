# ADR-0007: Deterministic cross-source CSV reconciliation

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-19
- **Deciders:** product/engineering foundation owner; jurisdiction mapping, water-engineering and vendor/operator review still required
- **Related backlog:** BL-033, BL-038, BL-040, BL-042, BL-043
- **Supersedes:** no earlier ADR; extends ADR-0005 and ADR-0006

## Context

ADR-0005 rejects repeated identities within one CSV source, and ADR-0006 normalizes each routing-accepted source row independently. Neither boundary decides what to do when the same governed measurement identity appears in multiple source objects. Passing both accepted observations to coverage would let interval ordering select a winner even when the source values conflict. Trusting a caller to choose one normalized result would also break exact-source reproducibility.

This remains an in-memory synthetic boundary. It does not provide object retention, a durable uniqueness constraint, transactions, worker coordination or operator conflict disposition.

## Decision

Adopt `csv-measurement-reconciliation-result/v1` with these rules:

1. Reconciliation receives between one and 64 complete ADR-0006 normalization inputs and reruns every exact source byte sequence. Caller-created normalization results are not authoritative.
2. Every input must share identical required-series, CSV source-contract, measurement-mapping and conversion-rule-set hashes. Reconciliation cannot span tenants, systems, series or governance versions.
3. The mapped observed-at field must be one of the source contract's governed identity fields. This prevents one source identity from resolving to multiple timeline positions.
4. Exact source-object resubmissions are counted and processed once. Unique sources are sorted by source-object hash so input order cannot select a winner.
5. Candidates group by ADR-0005 identity hash. Their semantic hash binds normalization disposition and reason, exact mapped timestamp, exact mapped numeric text, resolved source unit and applicable conversion-rule version. Incidental delivery bytes outside those mapped fields cannot create a measurement conflict.
6. If every candidate in one identity group has the same semantic hash, the code selects the code-unit-lowest source/row locator as the canonical preimage. Remaining candidates are explicit semantic replays. One accepted or quarantined result proceeds downstream.
7. If semantic hashes differ, no source wins. The group emits `conflicting_duplicate`, discards every accepted numeric preimage and, when the governed timestamp is valid, emits one deterministic quarantined observation for coverage. A conflicting invalid timestamp remains an explicit reconciliation outcome with no observation because it cannot be placed on a timeline.
8. The result separately accounts for submitted and unique sources, duplicate source submissions, rejected sources, submitted and unique-source candidates, accepted identities, quarantined identities, conflicts and semantic replays. It exposes only the reconciled observations and numeric preimages for downstream evaluation.
9. A reconciliation hash binds governance, source summaries, all candidate dispositions, final observations, final numeric preimages and complete accounting. Source and identity ordering is deterministic.

## Consequences

Benefits:

- byte-identical source retries are idempotent within one reconciliation call;
- byte-distinct replays of the same mapped measurement collapse reproducibly;
- conflicting values, units or normalization states can never become an arbitrary accepted coverage winner;
- coverage receives an attributable conflict quarantine whenever a timestamp is valid; and
- exact source, semantic-replay and conflict accounting remains independently visible.

Costs and limits:

- idempotency is bounded to one in-memory call and 64 submitted sources;
- the source contract must include observed-at in identity, which can require a new reviewed contract version;
- exact mapped decimal text is significant, so `2` and `2.0` conflict even if numerically equivalent;
- conflict disposition is not implemented and quarantined values cannot be promoted by this boundary; and
- no database uniqueness constraint, immutable source store, transaction or concurrent-worker behavior is demonstrated.

## Alternatives considered

- **Let coverage choose its first accepted observation:** rejected because stable sorting is not evidence that one conflicting source is correct.
- **Use source-object hash alone for idempotency:** rejected because byte-distinct exports can contain the same measurement.
- **Treat numerically equivalent decimal strings as identical:** rejected because normalization must not silently rewrite source precision or representation.
- **Prefer the newest source:** rejected because source arrival time is not a governed correction or supersession decision.
- **Drop conflict groups:** rejected because known contradictory evidence must remain visible as quarantine.

## Verification and release impact

Automated tests cover exact-source resubmission, byte-distinct semantic replay, input-order independence, conflicting accepted values, downstream coverage quarantine, preserved normalization quarantines, rejected sources, invalid-timestamp conflicts, governance-hash equality, observed-at identity, strict input shape, source bounds, deterministic hashes and deep immutability. The module is included in the repository's per-file coverage gate.

This ADR narrows but does **not** close BL-033, BL-038, BL-040, BL-042 or BL-043. Remaining gates include durable immutable source and normalized-measurement storage, database-enforced idempotency, transaction/concurrency behavior, authenticated correction and supersession, operator conflict review, real reviewed vendor formats, scale evidence and control-total reconciliation.

## Rollback

Before external retention, rollback is removal of the reconciliation module, quarantine reason, export, tests and documentation. Once another system retains the new result schema or conflict observations, the validator and hash semantics must remain available by version; conflict identities and dispositions cannot be rewritten.
