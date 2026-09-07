# ADR-0013: Serialize the evaluation input as `evidence-case/v1`, and replay from it

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-09-07
- **Deciders:** product/engineering foundation owner; jurisdiction records, procurement and vendor/operator review still required
- **Extends:** ADR-0003 (deterministic report freeze and accessible artifacts), ADR-0008 (deterministic reconciled evidence evaluation) and ADR-0009 (exact replay integrity validation)
- **Supersedes:** no earlier ADR

## Context

ADR-0009 made a retained result checkable by rerunning "the exact inputs". Those inputs
are a live JavaScript object graph: a `RequiredSeriesContract` set, a report range and
time basis, a lifecycle state or timeline, scheduled nonoperations, and per series a
`CsvAdapterSourceContract`, a `CsvMeasurementMapping`, its `UnitConversionRule[]`, a
`DailyAggregatePolicy` and `sourceObjects: readonly Uint8Array[]`. Nothing serialized
that graph, and ADR-0003's written bundle deliberately carries only report-safe
aggregates and hashes.

The consequence is stated in the README already: the receipt and freeze wrappers retain
governing-contract preimages, normalized evaluation preimages and full coverage summaries
in memory while emitted artifacts contain only their hashes, so "production restore and
audit therefore still require durable retention of those authoritative objects." The
library named that requirement and modelled nothing that satisfied it.

So `bin/reuseproof-verify.js` proves exactly what it says it proves: this directory's
bytes still satisfy its own render manifest. It cannot prove that this bundle is what
those inputs produce, because the inputs are not anywhere. Two claims a jurisdiction
might want to make are separated by that gap:

1. *this bundle has not been altered since it was written* — available today;
2. *this bundle is what these bytes and these approved contracts produce, and here is
   the command anyone can run to see it* — unreachable from disk.

The second is the claim the whole deterministic design exists for.

## Decision

Adopt `evidence-case/v1`, a canonical on-disk form of one complete evaluation input, with
`writeEvidenceCaseAtomically` / `readEvidenceCaseAtPath` and a `reuseproof-replay`
command, under these rules.

1. **A case directory holds exactly three kinds of member.** `evidence-case.json` is the
   case manifest: canonical JSON listing every other member with its byte length and
   SHA-256, in one canonical order. `case-input.json` is every governance object of the
   input in canonical JSON, with each series' `sourceObjects` replaced by an ordered list
   of digest references. `sources/<digest>` is one source object, verbatim, named by the
   exact-byte SHA-256 the ingestion boundary already computes over it.

2. **The manifest's own bytes root the chain.** The case ID is `rpc1-` followed by the
   SHA-256 of `evidence-case.json`, exactly as the snapshot ID is `rpf1-` followed by the
   SHA-256 of `report-freeze.json`. Member order is part of the document, so a reordered
   manifest is a different case and is refused rather than accepted on set equality.

3. **Source objects are content-addressed; multiplicity lives in the references.** Two
   byte-identical submissions occupy one file and are referenced twice, in submission
   order. This is required, not incidental: ADR-0009 rule 6 makes delivery multiplicity
   input-specific, so a case that deduplicated the *references* would find every digest
   present and still replay a different operational hash and root `evaluationHash`.

4. **The case pins source bytes, never derived identities.** How a row fingerprint is
   derived is an open question whose candidate resolutions emit different artifact bytes.
   A case that stores what a derivation consumed is indifferent to which one is chosen,
   and a replay is what makes the difference between candidates observable rather than
   argued.

5. **Reading is fail-closed and typed.** Fourteen refusal reasons — a missing member, an
   extra entry, a digest mismatch, a non-canonical control file, an unsupported version,
   an unknown source reference, and the rest — each raise `EvidenceCaseError` carrying a
   machine-readable reason. There is no partial or best-effort result, so a case that
   could not be reconstructed never yields a `ReadEvidenceCase`.

6. **The reader validates each governance object through its own domain constructor and
   deliberately does not re-implement the evaluator's cross-object rules.** A case whose
   contracts share an ID reads back faultlessly and is then refused at evaluation. The
   command reports that as its own exit code, `replay_refused`, rather than as an internal
   error: the case was read, and the input it holds is not one this library will evaluate.

7. **The reader returns a newly constructed, frozen input, never a caller's object**, and
   gives each source reference its own copy, so two references to one digest cannot alias.
   Source bytes themselves are not frozen — `Object.freeze` throws on a typed array with
   elements — so the freeze walks the graph and skips views.

8. **The case format orders its own document.** Contracts, series, conversion rules and
   scheduled nonoperations are sorted by the same keys the evaluator normalizes on, so one
   input does not acquire two case IDs from the incidental array order a caller held.
   `sourceObjects` is deliberately not sorted, because its order is submission order.

9. **`reuseproof-replay` keeps the verifier's discipline.** Nothing reaches stdout until
   every check passes; each refusal writes one machine-readable line to stderr and returns
   its own exit code; `--expect-snapshot` is required and `--print-only` still exits
   non-zero. `--expect-evaluation-hash` is optional and, when given, checked.

10. **No artifact byte, hash, receipt field or existing schema changes.** Nothing is
    signed. A replay against a case the same party produced proves derivation, not
    authenticity — the same limitation the verifier already states, and the same reason
    both commands demand an independently recorded identifier.

## Consequences

Benefits:

- the durable-retention requirement the README names now has a shape defined by the code
  that consumes it, rather than by a hosted system that does not exist;
- a jurisdiction can be handed a bundle, a case and a recorded snapshot ID, and can check
  the stronger of the two claims with one command and no program;
- the boundary of what a snapshot ID records became measurable rather than argued: because
  ADR-0008 keeps delivery multiplicity outside the receipt, a case that loses one of two
  byte-identical submissions replays to the same snapshot ID, receipt ID and
  `evidenceSetHash`. Verified by sabotaging a reader to drop the second reference —
  `--expect-snapshot` passed and `--expect-evaluation-hash` refused. That is why the gate
  step records and checks both, and why `--expect-evaluation-hash` exists at all;
- delivery multiplicity, which the receipt deliberately does not carry, survives to disk;
- byte-level claims made about future derivations become checkable rather than argued; and
- both published commands are now exercised end to end inside `make verify`, against the
  shipped fixture, which is itself the two-identical-submissions case.

Costs and limits:

- a case retains complete governing-contract and source bytes, so it carries confidentiality
  weight the report-safe bundle does not, and no encryption, access control, retention
  schedule or transport is part of this decision;
- a replay repeats the whole bounded evaluation and costs roughly what construction costs;
- a case proves what the artifacts derive from, never that the source bytes are what a
  system measured;
- the writer's cleanup-of-a-failed-cleanup arm is not exercised by the suite, because a
  staged write cannot be made to fail deterministically without a seam the writer does not
  have; it is stated here rather than claimed as tested; and
- a future case schema requires a versioned reader rather than reinterpretation of v1.

## Alternatives considered

- **Serialize the internal preimages the receipt retains:** rejected because they are
  derived, not input. A case that stored them would let a caller supply a preimage that
  the source bytes do not produce, which is the trust gap ADR-0008 and ADR-0009 close.
- **Store source objects by index rather than by digest:** rejected because the digest is
  what the ingestion boundary already computes, and naming a file by anything else creates
  a second identity for the same bytes.
- **Deduplicate the source references as well as the files:** rejected because it silently
  changes the input. See decision 3.
- **Embed source bytes in `case-input.json` as base64:** rejected because it makes the
  document's size unbounded in the input, breaks the digest that already exists, and makes
  a one-byte source change invisible in a diff of the case.
- **Add signing so a replay proves authenticity:** out of scope and would contradict
  ADR-0003's unsigned boundary. The honest claim is derivation, and it is stated as such.
- **Extend `reuseproof-verify` with a `--replay` flag:** rejected because the two commands
  make different claims and take different inputs. One exit code table per claim keeps a
  refusal legible.

## Verification and release impact

Acceptance criteria are the "Evidence case and replay" invariants in
`docs/09-TEST-AND-EVALUATION.md`. `make verify` gains `npm run demo:case`, which writes the
demo evaluation's bundle and its case into one container and runs both published commands
against them. That step compares against identifiers derived in-process rather than scraped
from the commands' own output, reads each exit code from the spawned process rather than
through a pipe, and fails closed — naming the fixture — if the fixture ever stops carrying
source objects, in the shape ADR-0011 requires.

The affected ISO/IEC 25010 characteristics are functional suitability (an input that can be
reconstructed from disk), reliability (deterministic replay from stored bytes),
security (fail-closed structural validation and tamper detection over a directory a third
party may hand you), maintainability (one format, one reader, one exit-code table), and
portability (a case is a plain directory with no database, service or runtime behind it).
