# ADR-0004: Governed exact-decimal daily aggregation

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-18
- **Deciders:** product/engineering foundation owner; California engineer, jurisdiction and regulatory review still required
- **Related backlog:** BL-040, BL-042, BL-043, BL-047
- **Supersedes:** no earlier ADR; extends ADR-0002 and ADR-0003

## Context

The existing coverage engine selects exactly one final accepted observation per expected interval and excludes duplicates, superseded values, quarantines, gaps and authorized nonoperation. It deliberately carries no numeric value, however, so the foundation could not prove which accepted values contributed to a daily result. Using JavaScript binary floating point, a caller-selected unit formula or a UTC date bucket would make quantitative output difficult to reproduce and could silently detach an aggregate from the coverage decision that governs its denominator.

The implementation remains a synthetic in-memory domain boundary. No jurisdiction has approved its parameter dictionary, conversion formulas, display precision or daily aggregation semantics. There is no adapter, durable measurement store, authenticated approver, report integration or real operational evidence.

## Decision

Adopt a separate `daily-numeric-aggregate/v1` pipeline with these invariants:

1. Recompute the existing coverage evaluation and aggregate only its exact `accepted` winner set. The numeric preimage set must contain every accepted winner and no duplicate, quarantine, gap, superseded or extra observation.
2. Bind every numeric preimage back to the normalized observation's ID, contract, timestamp and source fingerprint. Any mismatch fails the entire aggregate rather than being repaired or dropped.
3. Represent source values and conversion constants as plain base-10 strings. Scientific notation, negative zero, non-finite values and implicit numeric coercion are rejected.
4. Convert with an effective-dated `unit-conversion-rule/v1`: `(source_value + source_offset) × numerator / denominator`. Rule ID/version, parameter, source unit, canonical unit, half-open effective range and authorization reference are mandatory. The supplied rule set must exactly equal the rule versions pinned by the accepted numeric preimages.
5. Perform conversion and sum/mean/minimum/maximum with exact `BigInt` rational arithmetic. Round only the final daily result using the policy's fixed decimal places and `half_away_from_zero`; display rounding never changes the retained source preimage.
6. Bucket each accepted observation by the named IANA time zone in the governing `RequiredSeriesContract`. A separate authorized `daily-aggregate-policy/v1` pins method, precision, rounding, time zone and contract.
7. Content-address the governing contract, recomputed coverage summary, complete conversion-rule set, aggregate policy and sorted numeric source set. Caller ordering cannot change the result or hashes.
8. Bound source/constant strings to 64 digits and one aggregate evaluation to 256 conversion-rule versions, in addition to the coverage engine's interval limit.

This aggregate is quantitative evidence assembly only. It does not evaluate a regulatory limit, declare compliance, prove sensor accuracy or establish that a conversion/policy is legally or technically appropriate.

## Consequences

Benefits:

- daily values reproduce without binary floating-point drift;
- coverage selection and numeric aggregation cannot disagree about contributing observations;
- unit, civil-time and rounding decisions remain explicit and reviewable; and
- late or corrected evidence produces a new content-addressed result rather than mutating a prior one.

Costs and limits:

- exact rational arithmetic is more complex than native-number arithmetic;
- the current evaluator remains bounded by the coverage engine's 200,000-interval in-memory limit;
- formulas are limited to an authorized affine conversion and four daily methods; and
- profile approval, range plausibility, source precision, uncertainty, daily algorithm versioning in durable storage and aggregate-to-report reconciliation remain future work.

## Alternatives considered

- **Store and aggregate JavaScript numbers:** rejected because binary rounding and exponent serialization can change reproducibility at the evidence boundary.
- **Round each converted observation:** rejected because intermediate display precision can bias a sum or mean.
- **Trust a caller-provided coverage summary:** rejected because a self-consistent but fabricated winner set could influence the aggregate.
- **Infer conversions from unit names:** rejected because aliases and formulas require explicit governance and effective dates.
- **Use UTC calendar days:** rejected because local reporting profiles and DST require the contract's named civil time zone.
- **Embed numeric values in the existing coverage schema:** rejected for this iteration to preserve the denominator/outcome contract and keep quantitative authority separate.

## Verification and release impact

Automated tests cover all four methods, affine conversions, rational reduction, positive/negative tie rounding, zero formatting, civil-day boundaries, ordering/replay, exact winner/rule sets, observation identity, unit/parameter/effective-range applicability and strict schema rejection. These primarily advance ISO/IEC 25010 functional suitability, reliability, security, compatibility and maintainability.

This ADR does **not** close BL-040, BL-042, BL-043 or BL-047. Remaining gates include a jurisdiction/engineer-approved parameter and conversion dictionary, adapter normalization, source precision and sentinel handling, immutable storage/versioning, daily source-set denominator and reconciliation rules for each statistic, report integration, real-format replay, scale testing and pilot control-total reconciliation.

## Rollback

Because no durable production data exists, rollback is removal of the numeric-aggregation module, exports and synthetic tests. Once another system retains `daily-numeric-aggregate/v1`, its validator and exact arithmetic must remain available by schema version; prior hashes and values cannot be rewritten.
