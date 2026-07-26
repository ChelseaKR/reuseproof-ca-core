# ADR-0008: Deterministic reconciled evidence evaluation

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-25
- **Deciders:** product/engineering foundation owner; jurisdiction mapping, water-engineering and vendor/operator review still required
- **Related backlog:** BL-033, BL-038, BL-040, BL-042, BL-043, BL-047, BL-055, BL-056
- **Supersedes:** no earlier ADR; composes ADR-0002 through ADR-0007

## Context

ADR-0005 through ADR-0007 create strict source-routing, normalization and cross-source reconciliation results. ADR-0002 and ADR-0004 separately evaluate coverage and exact daily numeric aggregates, and ADR-0003 creates the unsigned receipt and frozen draft. Before this decision, callers still had to assemble those boundaries. A caller could accidentally omit a required contract with no available source, pass numeric preimages that did not win coverage, invent receipt provenance or collapse delivery retries without retaining their operational accounting.

The required-series set must remain independent of vendor mappings and source availability. An absent source is evidence of a gap, not permission to remove the denominator. At the same time, a byte-identical delivery retry must not change the canonical evidence meaning or receipt, even though the system must retain that an additional submission occurred.

This remains a synthetic local boundary. It does not add object storage, a real vendor format, durable idempotency, correction workflow or a numeric regulatory report.

## Decision

Adopt `reconciled-csv-evidence-evaluation/v1` and the public `evaluateReconciledCsvEvidence` API with these rules:

1. The caller supplies an independent set of one to 64 `RequiredSeriesContract`s. Contract ID/version pairs and contract IDs are unique, and every contract has the same tenant/system scope.
2. The caller also supplies exactly one series bundle for each governing contract ID/version and no extra bundle. Each bundle carries the contract reference, CSV source contract, measurement mapping, unit-conversion rules, daily aggregate policy and exact source byte objects. Contract and bundle ordering is canonicalized; mappings and available sources cannot create, delete or relax the required set.
3. A bundle accepts zero to 64 exact `Uint8Array` source objects. The complete multi-series evaluation accepts no more than 64 submitted source objects and 64 MiB of source bytes, so all bundles share global in-memory count and byte budgets. Intrinsic typed-array slots—not caller-shadowable properties or iterators—supply the byte length and snapshot; shared or resizable backing storage is rejected. Input byte arrays are copied only after both global bounds pass and before downstream evaluation.
4. Before branching on source availability, the evaluator strictly reconstructs the required-series contract, CSV contract, mapping and conversion rules through `csv-measurement-governance-binding/v1`. This source-independent binding contains the required-contract, CSV-contract, mapping, conversion-rule-set and complete governance hashes. Caller-created governance hashes are not accepted.
5. A non-empty source bundle reruns ADR-0007 and produces the tagged state `reconciled`, its complete reconciliation result and a multiplicity-sensitive `operationalHash` equal to the reconciliation hash. An empty bundle produces `no_source_objects`, the same validated governance, a null reconciliation result and a typed operational hash. It then supplies no observations to coverage, preserving applicable expected intervals as explicit gaps.
6. Each series receives a separate retry-insensitive `evidenceSetHash`. It binds the source-independent governance, canonical unique-source summaries with `submissionCount` removed, reconciliation outcomes, final observations and numeric preimages. Repeating an exact source submission changes neither this hash nor the downstream evidence meaning.
7. Operational delivery accounting is intentionally separate. ADR-0007 retains submitted and duplicate source counts, so an exact retry changes the reconciliation result and `operationalHash`. The root `evaluationHash` binds the complete result, including that operational state, and therefore also changes. This preserves retries without allowing them to alter the canonical evidence set.
8. Only reconciliation-derived observations feed coverage. After coverage evaluation, the evaluator selects numeric preimages whose observation IDs are exact accepted coverage winners and supplies only their referenced conversion rules to `DailyNumericAggregate`. Duplicate, quarantine, conflict, scheduled-nonoperation and lifecycle-ineligible candidates cannot contribute. If coverage has no numeric winner, aggregation still returns a deterministic result with an empty `values` array; no zero or fallback winner is manufactured.
9. All receipt provenance is derived rather than caller supplied. Exact source hashes are globally deduplicated across series. Required-series, CSV-contract, mapping, conversion-rule-set and aggregate-policy hashes, the evidence-set hash, the daily aggregate-evaluation hash, the report-time basis and lifecycle basis are pinned into the existing unsigned receipt alongside its independently recomputed coverage provenance.
10. The existing receipt renderer and `freezeReport` create the existing unsigned, non-submittable version-1 frozen draft. Operational multiplicity is not pinned into the receipt, so a byte-identical retry preserves receipt and frozen-draft IDs. The root evaluation hash still records the changed operation.
11. Contracts, bundles, sources and all derived results use deterministic code-unit ordering and deep freezing. The outer evaluation hash is derived last from the complete result without self-reference.

## Consequences

Benefits:

- every required contract remains present even when it has no source object;
- source governance is validated and content-addressed before data availability is considered;
- one public API reruns exact bytes through reconciliation, coverage, exact aggregation, receipt and freeze without trusting caller-created intermediate results;
- canonical evidence, receipt and frozen-draft identity are insensitive to byte-identical delivery retries, while operational and root evaluation identity retain retry multiplicity;
- cross-source conflicts and other quarantines remain visible to coverage and cannot become numeric winners;
- aggregate values are derived only from the same accepted observations that determine coverage; and
- exact source and governance provenance is pinned without exposing numeric values in the report-safe projection.

Costs and limits:

- at most 64 source submissions and 64 MiB of source bytes can be evaluated in memory across all bundles;
- CSV source timestamps remain limited to fixed-millisecond UTC and one mapping produces one required series;
- governance and approval references remain synthetic identifiers rather than authenticated jurisdiction decisions;
- there is no real reviewed vendor format, immutable source store, durable normalized-measurement store, database uniqueness, concurrent-worker behavior or cross-run transaction;
- exact retries are distinguished only inside one evaluation result; no durable operational ledger is implemented;
- no authenticated correction, supersession or operator conflict-disposition workflow exists;
- `freezeReport` is invoked only for version 1 by this API; and
- daily aggregate hashes are pinned as internal provenance, but numeric aggregate values are not included in `ReportContentProjection`, HTML, CSV or JSON.

## Alternatives considered

- **Let available source bundles define the required set:** rejected because missing vendor data would disappear from the denominator.
- **Allow zero or multiple bundles for one required contract:** rejected because governance and downstream provenance would be absent or ambiguous.
- **Require at least one source per bundle:** rejected because a required source-less series must remain an explicit, governed gap.
- **Hash source submission multiplicity into the receipt:** rejected because delivery retries do not change the canonical evidence meaning and must not create new receipt or frozen-draft IDs.
- **Discard source retry multiplicity entirely:** rejected because operational accounting must record that another submission occurred.
- **Pass every normalized numeric preimage to aggregation:** rejected because an extra, duplicate, quarantined or lifecycle-ineligible value could influence a report-critical number without winning coverage.
- **Let callers provide source hashes and pinned versions:** rejected because provenance must be derived from the exact inputs and results the evaluator actually used.
- **Add numeric values to the report projection now:** rejected because the current projection is an evidence-coverage report and no complete reviewed regulatory numeric schema exists.

## Verification and release impact

Acceptance criteria are the “Reconciled evidence composition” invariants in `docs/09-TEST-AND-EVALUATION.md`: exact contract/bundle bijection; bounded, intrinsically snapshotted sources; source-independent governance; order-independent replay; retry identity separation; explicit source-less gaps; reconciliation-only coverage; coverage-winner-only aggregation; and derived provenance. The affected ISO/IEC 25010 characteristics are functional suitability (correct composition and exact aggregation), reliability (deterministic replay and fail-closed missing/conflicting evidence), security (strict inputs, bounded immutable bytes and derived provenance), performance efficiency (global count/byte bounds), and maintainability (versioned schemas, tagged states and an ADR-defined identity split).

Automated tests cover exact contract-to-bundle bijection, shared scope, strict outer input shape, one-to-64 contract, 64-total-source and 64-MiB bounds, intrinsic byte-length enforcement, caller-iterator isolation, shared/resizable-buffer rejection, delimiter-safe provenance names, contract/bundle/source order independence, global source-hash deduplication, deterministic replay, source-less required series, exact-delivery retry identity separation, byte-distinct semantic replay, conflict quarantine, crowded-interval winner selection, scheduled-nonoperation and lifecycle exclusion, empty aggregates, derived receipt pins, unsupported caller provenance and deep immutability.

This ADR narrows but does **not** close BL-033, BL-038, BL-040, BL-042, BL-043, BL-047, BL-055 or BL-056. Remaining gates include real reviewed source formats and jurisdiction governance, upload scanning and immutable retention, durable normalized storage and idempotency, concurrent worker/transaction behavior, authenticated correction and supersession, control-total reconciliation, complete report schemas and numeric report-projection review.

Threat-model impact is confined to this in-memory boundary: iterator/length shadowing, mutable shared storage, provenance-name collisions, resource exhaustion and caller-injected provenance are now explicit fail-closed cases. Service observability remains not applicable because this iteration adds no deployed request, worker or storage path. Release and deployment impact remain not applicable for the same reason.

## Rollback

Before external use, rollback is removal of the composition API, source-independent governance export, tests and documentation. Once another system retains `reconciled-csv-evidence-evaluation/v1`, its validators and hash semantics must remain available by version. Evidence-set, operational and root evaluation identities cannot be reinterpreted or rewritten after retention.
