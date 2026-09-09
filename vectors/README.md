# Artifact test vectors

A vector is a frozen evaluation input plus **the exact bytes this library emitted for it**,
recorded on a day, together with the identifiers a jurisdiction holding that bundle would
have written down.

`npm run check:vectors` — step of `make verify` — re-derives those bytes from the vector's
own `input.json` and fails naming the artifact and both digests when anything moves. See
[ADR-0015](../docs/adr/0015-artifact-version-stability-and-recorded-identifiers.md) for what
a recorded identifier means across an artifact-schema version change, and
[ADR-0011](../docs/adr/0011-gates-that-cannot-report-an-empty-check.md) for why an empty
corpus is an error rather than a pass.

## What is in a vector directory

| path | what it is |
| --- | --- |
| `input.json` | the frozen input, copied byte for byte at recording time. The check re-derives from **this**, never from `fixtures/`, because a vector whose input is the file under maintenance moves whenever that file does — and would then agree with the library about a change neither was supposed to make. |
| `manifest.json` | `artifact-test-vector/v1`: the recorded artifact-schema version set, the render-manifest order, the identifiers, and every recorded file with its byte length and SHA-256. |
| `artifacts/…` | every member of the frozen report bundle, verbatim. |
| `case/…` | every member of the evidence case, verbatim, including each content-addressed source object. |

## Live and superseded

**Live** — the artifact-schema version set the library emits for this vector's input is the
set the vector recorded. A live vector must reproduce **byte for byte**.

**Superseded** — that set has moved, so this library no longer renders that generation and
the vector cannot be re-derived at all. It is held to what stays checkable: its stored bytes
still hash to its recorded digests, and its recorded identifiers still carry those digests.
That is a weaker claim, and ADR-0015 states exactly what it does and does not mean.

**Exactly one vector may be live.** Two live vectors mean a version bump was recorded in a
new directory without any version actually changing, and the check refuses. A corpus in
which *no* vector is live is also a refusal: nothing was re-derived, so the run examined the
stored bytes and nothing else.

## Recording a vector

`write-vector` is the deliberate act that accepts a byte change. It is not something
`make verify` can do for you, and it must not become one: a gate that repairs what it checks
cannot fail.

```sh
npm run build --silent
node dist/scripts/write-vector.js <vector-id> <input-path> [--recorded-on YYYY-MM-DD]
```

A vector id is lowercase letters, digits and hyphens, so it is a safe path segment. The
convention is `<artifact generation>-<what the input is>`, e.g. `v1-reconciled-demo`.

### When `check:vectors` fails, there are exactly two honest answers

1. **The change was not intended.** Fix the code. Do not re-record.
2. **The change was intended.** Then it is a change to what a recorded identifier means,
   and it takes both halves: bump the artifact-schema version of whatever moved, **and**
   record a new vector beside the existing one. The old directory stays — it becomes
   superseded, and it is the record of what the previous generation emitted. Say in the
   changelog which identifiers moved and why.

The check's message tells you which of the two halves is missing: a byte difference with the
version set unchanged is case 1 or an un-bumped case 2; a moved version set with no vector
covering the new one is case 2 with the recording not done.

**Never edit a recorded file by hand, and never delete a superseded vector to make the check
pass.** Both turn the corpus into a document that agrees with whatever the library currently
does, which is the one thing it exists not to be.
