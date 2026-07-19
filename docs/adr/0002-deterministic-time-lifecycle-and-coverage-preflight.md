# ADR-0002: Deterministic time, lifecycle and data-coverage preflight boundary

- **Status:** Implemented for synthetic domain foundation; jurisdiction, engineering, security and governance approval still required before a live pilot
- **Date:** July 13, 2026
- **Decision owners:** Product/technical lead
- **Required reviewers before pilot use:** California water engineer, jurisdiction program administrator, building operator, cybersecurity reviewer, counsel

## Context

An immutable required-series contract cannot produce a reproducible denominator unless report boundaries, lifecycle transitions and missing aggregate sources are resolved explicitly. JavaScript `Date` does not model ambiguous or nonexistent civil times as an auditable decision. A single lifecycle state for an entire report period hides effective-dated transitions. Vendor mappings or reviewer attestations must not be allowed to shrink required-series or aggregate denominators.

Raw JSON is also an untrusted boundary. Ordinary `JSON.parse` accepts duplicate object keys by silently retaining one value and offers no structural resource limits. That behavior is unsuitable for denominator, lifecycle or receipt inputs.

This decision covers only the synthetic in-memory domain foundation. It does not establish a jurisdiction's required series, approve lifecycle evidence, ingest a real source object, compute a water-quality or engineering result, or make a compliance or filing determination.

## Decision

### Raw JSON boundary

- Scan UTF-8 JSON text before ordinary parsing.
- Reject decoded duplicate keys at every object depth, including escape-equivalent keys such as `"a"` and `"\u0061"`.
- Enforce explicit byte, structural-depth and parsed-node limits. The current defaults are 1 MiB, 32 container levels and 100,000 values.
- Parse into strict domain constructors only after the scan succeeds; unknown fields remain errors.
- At direct object boundaries, accept only plain or null-prototype records with required own enumerable data properties; reject inherited substitutes, class instances, symbols, accessors and unknown fields.
- Treat these limits as an in-process safety boundary, not as source-object upload, malware scanning, authorization, storage or adapter ingestion.

### Civil-time basis

- Accept civil boundaries only in fixed `YYYY-MM-DDTHH:mm:ss.SSS` form with an explicit named IANA zone and an explicit `earlier`, `later` or `reject` disambiguation. Fixed-offset identifiers are rejected consistently by contract and civil-time constructors.
- Resolve with the exactly pinned `@js-temporal/polyfill` 0.5.1 dependency and `overflow: reject`; impossible calendar dates cannot be constrained to a different date.
- Store the original civil input, disambiguation and resolved fixed-millisecond UTC instant as the report-time basis.
- Recalculate caller-supplied resolved metadata rather than trusting it.
- Require the civil zone to match each required-series contract and the resolved endpoints to match the evaluated report range.
- Tile denominators over elapsed UTC time after resolution. A Los Angeles spring-forward civil day therefore has 23 hourly intervals and a fall-back day has 25.

### Effective-dated lifecycle

- Represent lifecycle as a versioned, scoped, non-overlapping timeline of states, half-open effective ranges, event IDs, evidence IDs and recorded instants.
- Sort timeline periods deterministically and reject duplicate event identities or overlaps.
- Permit a timeline to preserve a gap as a fact, but stop denominator evaluation if a gap intersects the contract/report range. Missing lifecycle evidence is not inferred.
- Split cadence intervals at lifecycle transitions using a linear sweep. Eligible segments enter the denominator; ineligible segments and observations remain explicit typed exclusions.
- Retain the existing resolved-state path only as an explicit compatibility input, not as an inferred default.

### Coverage readiness

- Evaluate every required-series contract independently of vendor mapping presence.
- Require at least 95% final accepted expected intervals for every required series.
- Derive each report-critical aggregate's complete source set from immutable contract membership and require at least 90% accepted source/interval pairs across that set.
- Keep missing contracts and intervals in the denominator. No mapping, reviewer attestation or waiver input exists at this boundary.
- Report a zero denominator as `not_applicable`, never 100%.
- Label the output `data coverage preflight only` and state that it is not a compliance, safety, water-quality, engineering or filing determination.
- Add canonical governing-contract and complete normalized evaluation-input hashes to every `coverage-summary/v2` output.
- Require readiness to receive the exact evaluation inputs, verify contract content hashes and safely recompute every supplied summary before applying thresholds.
- Bind canonical contract, evaluation-input and summary-set hashes into readiness, then require receipts to recompute and exactly compare any supplied readiness result. Missing, extra, contradictory or changed series and aggregates are errors.

## Backlog mapping

This slice implements tested domain foundations for:

- **BL-042:** explicit time-zone/DST decisions and adversarial normalization boundaries;
- **BL-043:** half-open cadence math across lifecycle transitions and contract-derived aggregate source-set coverage; and
- **BL-047:** fixed per-series and critical-aggregate data-coverage thresholds with typed N/A and gaps.

The bounded JSON entrypoint and canonical pins are enabling work toward **BL-033**, **BL-038** and **BL-056**. Those items are not complete: no adapter SDK, source storage/quarantine/replay workflow or production receipt/render pipeline exists.

## Alternatives considered

### Native `Date`/`Intl` arithmetic

Rejected. It cannot represent an explicit ambiguous/nonexistent-time choice as durable domain input and makes DST denominator behavior easy to vary by implementation.

### Temporal `compatible` or an implicit default

Rejected. Silent disambiguation would hide a consequential denominator decision. The caller must select `earlier`, `later` or fail with `reject`.

### One lifecycle state for the whole report

Retained only as an explicit compatibility path. It cannot represent commissioning, suspension or return-to-service transitions inside the report period.

### Derive required series or aggregate membership from available mappings

Rejected. Missing mappings would disappear from the denominator and create false readiness.

### Floating-point percentage comparison

Rejected. Thresholds use exact integer cross-multiplication so boundary results such as 19/20 and 36/40 are deterministic.

## Consequences

### Positive

- DST, lifecycle and aggregate denominators are reproducible and auditable.
- Ambiguous, impossible and missing inputs fail closed.
- Missing vendors or fields cannot manufacture readiness.
- Receipt content changes when its time, lifecycle or readiness basis changes.
- Raw fixture parsing has deterministic denial-of-service and duplicate-key boundaries.

### Negative

- Callers must supply more explicit civil-time and lifecycle metadata.
- The Temporal polyfill adds a pinned runtime dependency until native Temporal support is an approved baseline.
- In-memory interval evaluation remains capped at 200,000 segments per required series; streaming evaluation is future work.
- Timeline gaps block evaluation even when an operator believes the intended state is obvious.

## Validation

The synthetic foundation is valid only while:

- duplicate-key, byte, depth and node limit tests pass;
- impossible dates and ambiguous/nonexistent civil times fail unless explicitly resolved;
- 23-hour and 25-hour day tests produce exact expected counts;
- lifecycle transitions split without overlap or hidden gaps;
- mapping changes cannot alter required-series or aggregate denominators;
- same-identity cadence, effective-range or timezone substitutions and lifecycle-input substitutions fail before readiness;
- exact 95%/90% boundaries, below-threshold and zero-denominator cases pass;
- canonical receipts reproduce under stable input ordering, change when the bound readiness basis is added and reject any readiness set not derived from their exact summaries; and
- domain files continue to meet the repository's per-file 95% coverage gate.

## Required external work

Before any live pilot, authorized humans must still approve the jurisdiction profile, required-series contracts, lifecycle facts, treatment basis, scheduled nonoperations, aggregate membership, legal posture and claims. Security review, real vendor samples, source-object controls, historical reconciliation, annual-draft UAT and the 30-day shadow remain required. Synthetic fixtures cannot satisfy those gates.
