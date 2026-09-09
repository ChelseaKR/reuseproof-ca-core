# ADR-0015: Artifact-version stability, a test-vector corpus, and what a recorded identifier survives

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-09-09
- **Deciders:** product/engineering foundation owner; jurisdiction records and vendor/operator review still required
- **Extends:** ADR-0003 (deterministic report freeze and accessible artifacts), ADR-0011 (gates that cannot report an empty check) and ADR-0013 (serialized evaluation input and replay)
- **Supersedes:** no earlier ADR

## Context

Every identifier this library issues is a hash of bytes it renders. `snapshotId` is `rpf1-`
plus the SHA-256 of `report-freeze.json`; `receiptId` is the receipt core's digest; `caseId`
is `rpc1-` plus the digest of `evidence-case.json`; each render-manifest entry carries the
digest of one artifact. `bin/reuseproof-verify.js` **requires** `--expect-snapshot` for
exactly that reason: the bundle is unsigned, anyone holding this tool can regenerate a wholly
self-consistent one, and the only thing that makes a bundle evidence is an identifier a
jurisdiction recorded elsewhere, independently, on the day it was issued.

The whole trust model therefore rests on a mapping from inputs to bytes — and until this ADR
nothing in the repository stated that the mapping was a contract.

A whitespace change in `report-render.ts`, one added field in the report content projection,
a different canonical ordering, or a new normalization outcome moves the bytes and therefore
every identifier derived from them. Measured: the demo fixture's evaluation emits **8 files**
across **14 artifact-schema versions**, and every one of the eight is an input to at least one
published identifier. Nothing compared any of those bytes to what they were yesterday. The
only way to learn that a recorded identifier had stopped matching was for a jurisdiction to
try to verify a bundle and be told it did not.

That failure mode is quiet in the worst direction: the verifier's refusal is
`snapshot_id_mismatch`, and its message reads exactly the same whether the reader was handed
a *different bundle* or the *same evaluation rendered by a later version of this library*.
Those are opposite facts and they lead to opposite actions. This is the portfolio's own
"a refusal message that merges two causes hides the one you can act on".

## Decision

**1. The mapping from a frozen input to emitted bytes is a versioned contract, and
`vectors/` is the record of it.**

A vector is a frozen `input.json`, the exact bytes the evaluation emitted for it, and a
manifest recording the artifact-schema version set, the render-manifest order, the identifiers
and every file's byte length and SHA-256. `npm run check:vectors` is a step of `make verify`
and re-derives those bytes **from the vector's own input**, never from `fixtures/` — a vector
whose input is the file under maintenance moves whenever that file does, and would then agree
with the library about a change neither of them was supposed to make.

**2. A vector is live or superseded, and the difference is the artifact-schema version set.**

*Live*: the version set this library emits for the vector's input equals the set the vector
recorded. A live vector must reproduce **byte for byte**, and any difference fails the gate
naming the artifact and both digests.

*Superseded*: that set has moved. This library no longer renders that generation, so the
vector cannot be re-derived at all. It is held to what remains checkable — its stored bytes
still hash to its recorded digests, and its recorded identifiers still carry those digests.

**3. An identifier recorded under one artifact-schema version is NOT re-derivable under the
next, and remains checkable only as an integrity anchor over bytes the holder still has.**

This is the answer the trust model needed and did not have. Stated precisely, because the
distinction is the whole point:

- **What survives a version bump.** The recorded identifier still identifies the bundle it
  was issued over. A holder of both the identifier and the bundle bytes can still show that
  those bytes are unaltered, because the identifier is the digest of those bytes and digests
  do not expire. `reuseproof-verify --expect-snapshot` continues to answer that question
  correctly for such a bundle, for as long as the bundle exists.
- **What does not survive.** The identifier can no longer be *reproduced from the inputs*.
  Re-running the same evidence case through a later artifact version yields different bytes
  and therefore a different identifier. So a holder of the identifier and the *case* — but
  not the bundle — can no longer demonstrate the correspondence between them, and no future
  version of this software can restore that.
- **Consequence for a jurisdiction.** Recording the identifier is not sufficient on its own.
  The bundle bytes must be retained too. That was already true of ADR-0013's evidence case
  for the replay claim; this ADR states it for the identifier claim as well, rather than
  leaving a reader to infer it.

**4. A deliberate byte change takes both halves: a version bump and a new vector.**

Neither alone is accepted, and the gate says which is missing. A byte difference with the
version set unchanged fails as a moved artifact. A moved version set with no vector covering
the new one fails as *no vector is live* — the corpus re-derived nothing while every stored
byte still matched, which is the state that would otherwise report success having checked
only itself. Exactly one vector may be live; two mean a directory was added without any
version actually changing. Recording a vector is `write-vector`, a deliberate maintainer act,
and deliberately not something `make verify` can do for you: a gate that repairs what it
checks cannot fail.

**5. The verifier's refusal names the artifact-schema version it read.**

`snapshot_id_mismatch` now carries `artifact-version=<the frozen report core's schemaVersion>`
and one sentence separating the two causes: a different bundle, or the same evaluation
rendered by a version of this library that does not emit these bytes. The verifier cannot
know which — a recorded identifier is an opaque digest and carries no version — so it does not
guess. It reports the version of the bundle in front of it, which is the fact it has, and
names the other possibility so a reader is not sent to the wrong conclusion.

## Consequences

- `make verify` gains an eleventh step. A change to any renderer, projection, canonical
  ordering or normalization outcome that moves a published byte now fails the merge gate,
  naming the artifact, the recorded digest and the re-derived one.
- The corpus fails closed in three ways that a naive implementation would report as success:
  an empty corpus, a vector recording no file, and a corpus in which every vector is
  superseded. The third is the one this ADR exists for — once a version is bumped, every
  existing vector is superseded, and a corpus of nothing but superseded vectors re-derives
  nothing while printing a green line.
- `vectors/` is added to `.prettierignore`. Recorded artifact bytes are output, not source;
  a formatter that rewrote one would make the corpus agree with a change it exists to refuse,
  and would do it before `check:vectors` ever ran, because `format:check` is the first step of
  the gate.
- The corpus grows by one directory per artifact generation, and superseded directories are
  never deleted. That is the cost: the repository retains the bytes of every generation it has
  published. It is small — one generation is under 25 KB — and it is the only thing that lets
  a later reader see what an older identifier was issued over.
- A vector is not a signature and makes no authenticity claim. It says what this library
  emitted; it does not say that what it emitted is correct, approved, or safe.

## What this ADR does not decide

- It does not change any current byte, hash, identifier or artifact. The first vector was
  recorded from the shipped fixture and the gate is green on the unmodified tree.
- It does not introduce a compatibility shim that re-emits an older version's bytes. Decision
  3 is the reason: the honest answer to "can this identifier be reproduced" is *no*, and a
  shim would replace that answer with a partial one that is right until the first thing it
  cannot re-render.
- It does not decide the vector corpus's role in the published package. `vectors/` is a
  repository artifact today; whether an independent implementation is asked to pass it, and
  under what licence and distribution, is left to #71's discussion and #54's schemas.
