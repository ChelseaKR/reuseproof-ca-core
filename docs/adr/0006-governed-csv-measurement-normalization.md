# ADR-0006: Governed CSV measurement normalization

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-19
- **Deciders:** product/engineering foundation owner; jurisdiction mapping, water-engineering and vendor/operator review still required
- **Related backlog:** BL-033, BL-038, BL-040, BL-042, BL-043
- **Supersedes:** no earlier ADR; extends ADR-0004 and ADR-0005

## Context

ADR-0005 ends with frozen routing-accepted CSV values, while ADR-0004 begins with already-normalized coverage observations and exact-decimal numeric preimages. Letting callers construct the objects between those boundaries would leave the source bytes, row identity, mapping authorization, required-series contract and unit rule set only conventionally related. It could also encourage timestamp repair, unit guessing or silent loss of malformed candidates.

This remains a synthetic local boundary. It does not implement object storage, malware scanning, durable measurement persistence, a real vendor format or a jurisdiction-approved parameter dictionary.

## Decision

Adopt `csv-measurement-mapping/v1` and `csv-measurement-normalization-result/v1` with these rules:

1. The mapping is transport-only. It identifies fixed-millisecond UTC timestamp and numeric-value columns plus either a unit column or constant unit. It binds exact CSV contract, mapping and required-series contract versions and the jurisdiction mapping-review reference. It cannot set requiredness, cadence, parameter, canonical unit, lifecycle or aggregate membership.
2. Normalization receives the exact source bytes and reruns the bounded ADR-0005 parser. It does not accept caller-created routing outcomes as authoritative.
3. The CSV and required-series contracts must have identical tenant/system scope and overlapping effective ranges. Every mapped field must be a declared source column; timestamp, value and unit-column roles must be distinct.
4. The supplied conversion-rule set is strictly reconstructed, bounded to 256 rules, unique by ID/version and limited to the required series' parameter and canonical unit. Effective ranges for the same source unit cannot overlap. A constant unit must have a governed rule.
5. Every ADR-0005 routing-accepted row receives exactly one normalization outcome. Routing duplicates and routing quarantines remain in the embedded routing result and never re-enter normalization.
6. Row decisions are fail closed in this order: invalid fixed-millisecond UTC timestamp becomes `ambiguous_timestamp`; a timestamp outside either governing contract becomes `unmapped_value`; a missing or inapplicable unit rule becomes `impossible_unit`; and a non-canonical decimal becomes `malformed_value`. Values are never trimmed, coerced or repaired.
7. A timestamp failure has no observation because it cannot be placed on a timeline. Other quarantines emit a typed quarantined observation so coverage can preserve the attributable interval outcome. Accepted candidates emit both an accepted coverage observation and an exact-decimal numeric preimage pinned to the applicable rule ID/version.
8. Observation IDs derive from the row fingerprint, required-series contract hash and mapping hash. The result binds the complete routing result, required-series contract, mapping, normalized conversion-rule set, candidate accounting, observations and numeric preimages in one deterministic normalization hash.
9. The output can feed the existing coverage and daily numeric aggregation engines directly. Those engines still independently reconstruct their inputs and prove that numeric preimages exactly match accepted coverage winners.

## Consequences

Benefits:

- the previously open routing-to-aggregation seam is executable and reproducible;
- source, row, mapping, denominator and conversion provenance remain independently versioned and hash-bound;
- every candidate is accepted or receives one typed reason without guessing;
- malformed or unknown values remain visible to coverage rather than disappearing; and
- callers cannot use a vendor mapping to add, remove or relax a required series.

Costs and limits:

- only fixed-millisecond UTC timestamps are accepted; local civil timestamps require a future explicit, reviewed format and disambiguation contract;
- one mapping produces one required series, so multi-series vendor rows require independently reviewed mappings;
- no sentinel, precision, plausibility or source-quality dictionary is implemented;
- duplicate detection remains source-local and no normalized object is durably stored; and
- the rule/mapping review identifiers are synthetic references, not authenticated approvals.

## Alternatives considered

- **Trust caller-created accepted rows:** rejected because source bytes and ADR-0005 accounting could be bypassed.
- **Let the mapping define parameter, cadence or requiredness:** rejected because vendor transport metadata cannot govern regulatory denominators.
- **Parse offsets or vendor-local time heuristically:** rejected because ambiguity must be an explicit reviewed decision.
- **Infer units from a parameter or prior row:** rejected because silent unit repair can produce credible but wrong aggregates.
- **Drop malformed candidates before coverage:** rejected because a known bad candidate must remain attributable as quarantine evidence.

## Verification and release impact

Automated tests cover strict mapping reconstruction, contract and authorization binding, scope/range validation, field declarations, rule uniqueness/applicability/non-overlap, column and constant units, source rejection replay, routing duplicate preservation, all four normalization quarantine reasons, complete candidate accounting, content hashes, deep immutability and direct daily-aggregation integration. The domain file maintains the repository's at-least-95% per-file branch/line/function/statement coverage gate.

This ADR does **not** close BL-033, BL-038, BL-040, BL-042 or BL-043. Remaining gates include real reviewed source formats and dictionaries, sentinel/precision/plausibility policy, local timestamp formats where unavoidable, immutable source and measurement storage, durable idempotency, multi-series normalization, worker/dead-letter processing, scale evidence and control-total reconciliation.

## Rollback

Before external retention, rollback is removal of the normalization module, export, tests and documentation. Once another system retains either new schema, validators and hash semantics must remain available by version; normalization outcomes and observation identities cannot be rewritten.
