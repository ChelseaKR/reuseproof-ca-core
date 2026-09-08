# ADR-0014: A governed sentinel and plausibility policy, with typed quarantine reasons

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-09-08
- **Deciders:** product/engineering foundation owner; jurisdiction records, procurement and vendor/operator review still required
- **Extends:** ADR-0004 (governed exact-decimal daily aggregation) and ADR-0006 (governed CSV measurement normalization)
- **Supersedes:** no earlier ADR

## Context

ADR-0006 decides a row in four ways: an unreadable fixed-millisecond timestamp becomes
`ambiguous_timestamp`, a timestamp outside either governing contract becomes
`unmapped_value`, a missing or inapplicable unit rule becomes `impossible_unit`, and a
non-canonical decimal becomes `malformed_value`. Every other numeric cell is a
measurement.

Vendor systems do not write only measurements into that column. When a sensor faults they
write a marker: `-9999`, `9999.99`, `NaN`, `ERR`, or nothing at all. Three of those are
non-numeric and reach `malformed_value`, which is already wrong in a small way — it says
the file was written badly when in fact it was written exactly as the vendor documents a
fault. The numeric ones are wrong in a large way: `-9999` is a valid decimal, so it was
accepted, converted, and aggregated.

Measured on this repository's own synthetic demo fixture, with one row of a two-row flow
series replaced by the vendor's `-9999` marker:

| | published daily mean | expected | accepted | gaps | quarantined |
|---|---|---|---|---|---|
| before this ADR | **-4939.50 gal/day** | 2 | 2 | 0 | 0 |
| after, with an approved policy | **150.00 gal/day** | 2 | 2 | 0 | 1 |

Every other number on that row is identical. A treatment works reporting a *negative
average daily flow* did so at full coverage, with no gap, no quarantine and no caveat —
the reading looked as settled as any other. That is this portfolio's dominant defect
class, absence rendered as a value, sitting in the middle of a measurement pipeline.

The related case is a value that is numeric, is not a documented marker, and is
physically impossible: `-3 NTU` turbidity, `250 mg/L` chlorine residual. Nothing here
could refuse it either.

What this library must *not* do is decide any of it. `-9999` is a fault marker because a
jurisdiction says so about a particular vendor's system, and `0` through `14` is a
plausible pH because a jurisdiction approves that range for that parameter in that unit.
A default range shipped in this package would be a rule nobody approved, applied to
everybody's data, invisibly.

## Decision

Adopt `plausibility-policy/v1` as its own approved, hashed governance object, optional
per series, bound beside the unit conversion rules, under these rules.

1. A policy carries `sentinelLiterals` (exact strings) and `plausibleRanges` (an inclusive
   `minimum`/`maximum` per `parameterCode` and `canonicalUnit`), plus `policyId`,
   `version` and `authorizationId`. It is reconstructed strictly, ordered
   deterministically, frozen, and content-addressed as `plausibility-policy-binding/v1`.

2. **A sentinel literal is compared exactly against the cell as the source wrote it**, and
   the comparison happens **before** the value is read as a number, so a non-numeric
   marker is reported as `sensor_sentinel` rather than as `malformed_value`. It happens
   **after** the timestamp, contract-range and unit-rule decisions, because those refuse a
   row for reasons that do not depend on knowing what the value means.

3. **A plausible range is compared in exact decimal, on the value after conversion into
   the series' canonical unit** — the same `convert` the daily aggregate uses, reached
   through `compareConvertedValue`. A bound compared against the *source* value would mean
   a different thing for every source unit; a bound compared through a float would make an
   inclusive boundary a question of representation. Both bounds are inclusive: a reading
   exactly on an approved bound is a reading the jurisdiction said was possible.

4. Two new `QuarantineReason` values, `sensor_sentinel` and `out_of_plausible_range`. A
   value hit by either is **quarantined, never dropped and never clamped**: it becomes an
   ordinary quarantined observation, counted as quarantine by coverage exactly as every
   other quarantine is.

5. **A policy is optional, and a policy that could decide nothing is refused.** Binding one
   with no sentinel literals and no range for this contract's parameter and canonical unit
   raises, naming both. Accepting it would put an approved policy identifier and hash into
   a receipt with nothing behind them, which is a check that cannot fail wearing a
   governance object's clothes.

6. **The absence of a policy is stated, not omitted.** `CsvMeasurementGovernanceBinding`
   and `CsvMeasurementNormalizationResult` carry `plausibilityPolicyHash: string | null`.
   A field that simply disappeared when no policy applied would read the same as an
   artifact produced before this library had the concept, and "no policy was approved for
   this series" is a fact a reader of a receipt is entitled to see.

7. **Sources reconciled against one another must share one policy.** Reconciliation
   already refuses sources under different contracts, mappings or rule sets; the policy
   hash joins that comparison. A mixture of two rules about what a sensor fault looks like,
   with nothing in the result saying so, is not one accepted set.

8. **The receipt names the policy when one governs a series.** It appears in the evidence
   manifest as `governance:plausibility-policy:<contract>@<version>` and in the pinned
   versions as `plausibility-policy:<contract>@<version>`. Where no policy is bound there
   is no entry, rather than a placeholder digest for a governance object that does not
   exist.

9. **The evidence case carries the policy.** `evidence-case-input/v2` adds an optional
   `plausibilityPolicy` per series. A case that omitted it would replay a policy-governed
   series as an ungoverned one — the quarantined rows would be accepted on replay and the
   aggregate would differ — and the integrity check would report a divergence whose cause
   was the case format rather than the bytes.

10. An empty string is a legal sentinel literal, alone among this codebase's string
    fields. A vendor writing nothing into the cell is the commonest fault expression there
    is, and a reconstructor that refused to let a policy name it would leave that case
    reaching the accepted set by another door.

## Consequences

**The safety property, and it is the reason this can be introduced at all.** A bound
policy can only ever move a row from accepted to quarantined, or refine the reason a row
was already quarantined for. It can never make a row acceptable that was not. This is
asserted directly over a mixed fixture, per row and by fingerprint.

**Behaviour without a policy is unchanged, and the artifact envelopes are not.** No
sentinel and no range means no `sensor_sentinel` and no `out_of_plausible_range` outcome
can be produced, and every existing decision path is untouched. The *bytes* of four
artifacts do move, because they now state `plausibilityPolicyHash: null`:
`csv-measurement-governance-binding/v2`, `csv-measurement-normalization-result/v2`,
`csv-measurement-reconciliation-result/v2` and `evidence-case-input/v2`. That is what a
version on an artifact is for. The alternative — including the field only when a policy
exists, so ungoverned runs stayed byte-identical — was rejected under rule 6: it would buy
byte-stability by making an absence unreadable, which is the defect this ADR exists to
close.

**The jurisdiction keeps the judgement.** The library applies the range it is handed and
records which policy version did so. The synthetic demo fixture carries a labelled
synthetic policy (`flow-sentinels-and-bounds`) so the mechanism is exercised by
`npm run demo:check` and `npm run demo:case`; its bounds are synthetic and approve
nothing.

**What is still out of scope.** Statistical outlier detection, any rolling-window rule,
and any range shipped by this library. A value that is implausible and not covered by an
approved range stays accepted, because nobody has said otherwise.
