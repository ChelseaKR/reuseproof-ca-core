# ADR-0009: Exact replay integrity validation

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-25
- **Deciders:** product/engineering foundation owner; jurisdiction mapping, water-engineering and vendor/operator review still required
- **Related backlog:** BL-038, BL-043, BL-055, BL-056
- **Supersedes:** no earlier ADR; extends ADR-0008

## Context

ADR-0008 creates a versioned `reconciled-csv-evidence-evaluation/v1` result from exact source bytes through reconciliation, coverage, aggregation, an unsigned receipt and a frozen draft. The constructor validates its inputs and derives every output, but a retained or transported result could later be mutated, incompletely restored or paired with different evidence inputs. Validating only its outer `evaluationHash`, receipt or frozen-report hash would not prove that the complete result still matches the exact source and governance preimages.

The receipt and frozen-report boundaries already have strict integrity validators. The new composition result needs the same fail-closed property without adding another caller-asserted hash, accepting reconstructed intermediate objects as authority or changing any v1 schema.

This remains an in-memory replay boundary. It does not provide durable retention, authenticated correction, regulatory schemas or an external filing verifier.

## Decision

Adopt the public `validateReconciledCsvEvidenceIntegrity(result, input)` API with these rules:

1. The validator reruns `evaluateReconciledCsvEvidence(input)` from the exact source byte objects and complete governance preimages. Caller-supplied reconciliation, coverage, aggregate, readiness, receipt, frozen-report and root hashes are never authoritative.
2. The supplied result must match the replayed result at every nested field. Records require the replay branch's exact own enumerable data-property keys on a plain or null-prototype object. Symbols, missing or extra fields, accessors and custom prototypes are rejected.
3. Arrays must be dense ordinary mutable or frozen arrays with the exact replay length and order. Sparse, decorated, accessor-backed and custom-prototype arrays are rejected.
4. Primitive values use exact `Object.is` comparison. This rejects negative-zero substitutions and all altered identifiers, counts, states, values, timestamps and hashes.
5. Tagged union shape is replay-specific. A `reconciled` result cannot be replaced by `no_source_objects`, or vice versa, even if a caller manufactures internally plausible hashes.
6. Delivery multiplicity is input-specific. A byte-identical retry may preserve the evidence-set, receipt and frozen-draft identities under ADR-0008, but its different operational accounting and root evaluation hash must match the supplied input exactly.
7. Equivalent canonical input orderings reproduce and validate the same result. The validator returns the newly replayed, deeply frozen canonical result, never the caller's object.
8. This API adds no schema field, receipt pin, report value or new identity. All ADR-0008 v1 hashes retain their existing meaning.

## Consequences

Benefits:

- a retained composition result can be reproduced from its authoritative exact inputs;
- coordinated field-and-hash tampering cannot become valid merely because a wrapper was rehashed;
- source-less and source-bearing paths receive the same full-result validation;
- hostile result containers fail before accessor values are read; and
- callers receive a canonical frozen value suitable for subsequent in-memory use.

Costs and limits:

- validation repeats the complete bounded evaluation and therefore has roughly the same CPU and memory cost as construction;
- callers must retain and provide the exact source bytes and every governance/lifecycle/report input needed for replay;
- validation proves deterministic agreement with this library's synthetic v1 rules, not source authenticity, approval authority, storage durability or regulatory correctness;
- no durable idempotency ledger, correction/supersession workflow or external destination proof is added; and
- a future result schema requires a versioned validator rather than reinterpretation of v1.

## Alternatives considered

- **Check only `evaluationHash`:** rejected because a caller could alter nested values and replace the outer hash without proving the authoritative input replay.
- **Validate only the embedded receipt and frozen draft:** rejected because reconciliation accounting, evidence-set identity and internal numeric aggregate results extend beyond those report-safe artifacts.
- **Accept caller-created intermediate preimages:** rejected because it would recreate the trust gap that ADR-0008 closes.
- **Serialize and compare loose JSON:** rejected because it can invoke accessors and does not by itself enforce exact container shape, sparse-array rejection or the replay-specific union arm.
- **Add another signed or self-referential result hash:** rejected because validation is deterministic replay, not authentication, and the existing root hash must remain non-self-referential.

## Verification and release impact

Acceptance criteria are the “Reconciled result integrity replay” invariants in `docs/09-TEST-AND-EVALUATION.md`: pristine and order-equivalent replay returns a new canonical frozen result; exact retry accounting must pair with its exact input; changed bytes, governance, report basis, lifecycle or scheduled nonoperation are rejected; every nested result layer is compared; coordinated rehashing fails; and hostile record/array shapes fail closed without invoking accessors.

The affected ISO/IEC 25010 characteristics are functional suitability (complete exact-input reproduction), reliability (deterministic replay and restoration checks), security (fail-closed structural validation and tamper detection), performance efficiency (reuse of ADR-0008's bounded evaluation), and maintainability (one stable validator for the complete versioned result).

Automated tests cover both source-state union arms, canonical order equivalence, exact-retry pairing, changed authoritative inputs, governance/source/outcome/coverage/aggregate/readiness/receipt/freeze/root tampering, coordinated field-and-hash tampering, extra/missing/symbol/accessor/custom-prototype records, decorated/sparse arrays, stateful array-length proxy spoofing, deep freezing and accessor non-invocation.

This ADR narrows replay and restoration risk for BL-038, BL-043, BL-055 and BL-056 but closes none of them. The ordered public-safe synthetic foundation ends here. Further implementation requires external authority and reviewed artifacts: vendor samples and mappings, immutable source/measurement storage, durable idempotency and transaction behavior, authenticated correction/supersession actors, approved parameter dictionaries and report schemas, pilot control totals, destination verification and accessibility evidence.

Threat-model impact is confined to tampered or hostile in-memory result objects; source-byte backing, bounds and caller behavior remain governed by ADR-0008. Service observability, deployment and release provenance remain not applicable because no deployed request, worker, database or package-release path is added.

## Rollback

Before external retention, rollback is removal of this validator, its tests and documentation without changing the ADR-0008 constructor or v1 identities. Once another system relies on replay validation for retained `reconciled-csv-evidence-evaluation/v1` objects, the validator must remain available by version. Future schemas may add validators but cannot loosen or reinterpret v1.
