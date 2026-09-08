# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
No version has been tagged yet.

## [Unreleased]

### Fixed

- **A vendor's sensor-fault marker was published as a measurement.** A CSV cell
  holding `-9999` -- what a great many vendor systems write when a sensor
  faults -- is a valid decimal, so normalization accepted it, converted it and
  fed it to the daily aggregate. Measured on this repository's own synthetic
  demo fixture, with one row of a two-row flow series carrying that marker: the
  published daily mean was **-4939.50 gal/day**, at an expected count of 2, an
  accepted count of 2, zero gaps and zero quarantines. A treatment works
  reporting a negative average daily flow did so at full coverage, with nothing
  anywhere on the record suggesting a fault. The non-numeric markers (`ERR`,
  `NaN`, an empty cell) were reported as `malformed_value`, which says the file
  was written badly when in fact it was written exactly as the vendor documents
  a fault.

  `plausibility-policy/v1` (ADR-0014) is the fix, and it is a governance object
  rather than a rule this library invents: sentinel literals compared exactly
  against the cell as the source wrote it, and an inclusive plausible range per
  parameter and canonical unit, both approved and authorized by the
  jurisdiction and content-addressed into the receipt. A value hit by either is
  quarantined as `sensor_sentinel` or `out_of_plausible_range` -- never dropped
  and never clamped. On the same fixture with the approved policy bound, the
  published mean is **150.00 gal/day**, coverage is unchanged at 2 of 2, and
  the quarantine count is 1.

  The range is compared **in exact decimal, on the value after conversion into
  the canonical unit**, through the same `convert` the daily aggregate uses. A
  bound compared against the source value would mean a different thing for
  every source unit; a bound compared through a float would make an inclusive
  boundary a matter of representation. `20.0000000000000000001` source units
  against a canonical maximum of `10` is refused; `20` exactly is accepted.

  The property that makes this safe to introduce is asserted per row: **a bound
  policy can only ever move a row from accepted to quarantined, or refine the
  reason a row was already quarantined for. It can never make a row acceptable
  that was not.**

- **The weekly full-history secret sweep could not fail on a credential that
  had been revoked.** `trufflehog.yml` ran `--only-verified`, which reports a
  finding only when TruffleHog authenticates the credential against the live
  service. A credential that leaked and was then revoked -- the normal end
  state of a real incident, and the exact case a history sweep exists to catch
  -- answers "no", and TruffleHog files that answer under `unverified`. So the
  sweep was structurally incapable of failing on the thing it exists for.

  This is the same shape as the `version:` drift recorded against F7 in
  `docs/plans/improvement-plan.md`: a control that reads as enforced and is
  not. There, the pin claimed a scanner it did not run; here, the tier claimed
  a sweep it could not fail.

  Measured on a throwaway clone with a real-shaped AWS key planted in one
  commit and deleted in the next: `--only-verified`, `--results=verified` and
  `--results=verified,unknown` all exited 0 reporting nothing;
  `--results=verified,unknown,unverified` exited 183 reporting it. The scan now
  runs the widened tier. This repository's entire history was re-scanned under
  it first, with trufflehog 3.97.1, and reported nothing across 463 chunks --
  so no detector had to be excluded and no allowlist was added.

  `tests/secret-scan-tiers.test.ts` fails if any lane drops the `unverified`
  tier, reintroduces `--only-verified`, loses `fetch-depth: 0` or `path: ./`,
  or lets the pinned ref and the `version:` input name different releases.

### Added

- **`plausibility-policy/v1`, and the artifact versions that state it.** Bound
  optionally per series beside the unit conversion rules, through
  `createPlausibilityPolicy`, `hashPlausibilityPolicy` and
  `bindCsvMeasurementGovernance`. A policy that could decide nothing about the
  series it is bound to -- no sentinel literals and no range for that parameter
  and canonical unit -- is refused, naming both, because an approved identifier
  in a receipt with nothing behind it is a check that cannot fail. Sources
  reconciled against one another must share one policy. The receipt names it as
  `governance:plausibility-policy:<contract>@<version>` when one governs a
  series, and carries no entry at all when none does, rather than a placeholder
  digest for an object that does not exist.

  Four artifacts state the policy and therefore move a version:
  `csv-measurement-governance-binding/v2`,
  `csv-measurement-normalization-result/v2`,
  `csv-measurement-reconciliation-result/v2` and `evidence-case-input/v2`. Each
  carries `plausibilityPolicyHash: string | null`, stated rather than omitted:
  a field that disappeared when no policy applied would read the same as an
  artifact written before this library had the concept. `evidence-case-input`
  moves because a case that did not carry the policy would replay a
  policy-governed series as an ungoverned one, and the integrity check would
  report a divergence whose cause was the case format rather than the bytes.

  `QuarantineReason` gains `sensor_sentinel` and `out_of_plausible_range`, and
  is now derived from an exported `QUARANTINE_REASONS` constant: the list
  previously existed twice, as a union type and as a runtime array inside
  `createObservation`, and the two could drift with nothing to notice.
  `coverage-validation.ts` derives its own wider list from the same constant.

- **`evidence-case/v1` and `reuseproof-replay`: a frozen report could be proved
  unaltered and never proved derived.** `validateReconciledCsvEvidenceIntegrity`
  reruns "the exact inputs" and rejects any divergence, but the exact inputs were
  a live JavaScript object graph and nothing serialized them. The emitted bundle
  deliberately carries only report-safe aggregates and hashes, so
  `reuseproof-verify` proved exactly what it says: this directory's bytes still
  satisfy its own render manifest. It could not prove the bundle is what those
  inputs produce, because the inputs were nowhere -- a gap the README already
  named, when it said production restore and audit "still require durable
  retention of those authoritative objects" and then modelled nothing that did.

  An **evidence case** is that input on disk. `evidence-case.json` is the manifest,
  and its own bytes yield the case ID the way `report-freeze.json`'s bytes yield
  the snapshot ID. `case-input.json` holds every governance object in canonical
  JSON with each series' sources as an ordered list of digest references.
  `sources/<digest>` holds each source object verbatim, under the exact-byte
  SHA-256 the ingestion boundary already computes.

  Source objects are content-addressed, so two byte-identical submissions occupy
  one file. Multiplicity is not lost by that: it lives in the reference list, in
  submission order. That is load-bearing rather than tidy -- ADR-0009 rule 6 makes
  delivery multiplicity input-specific, so a case that deduplicated the
  *references* would find every digest present and still replay a different
  `operationalHash` and root `evaluationHash`. The shipped demo fixture submits the
  same bytes twice, so this is the case `make verify` actually exercises.

  `reuseproof-replay` reads a case, reruns the evaluation and compares the report
  it derives against a snapshot ID recorded independently, with the verifier's
  discipline: nothing on stdout until every check passes, one machine-readable
  line on stderr per refusal, an exit code per reason, `--expect-snapshot`
  required, `--print-only` still non-zero. Fourteen typed refusal reasons, and no
  partial read: a case that could not be reconstructed never yields a result.

  One refusal has no equivalent in the verifier. The case reader validates each
  governance object through its own domain constructor and deliberately does not
  re-implement the evaluator's cross-object rules, so a case whose contracts share
  an ID reads back faultlessly and is then refused at evaluation. That is
  `replay_refused`, exit 7 -- its own code rather than an internal error, and
  tested from a real case directory rather than a stub.

  `make verify` gains `npm run demo:case`, which writes the demo evaluation's
  bundle and its case into one container and runs both published commands against
  them. Until now neither `bin` entry was executed by any gate step, and a command
  no gate runs is a claim rather than a check. The step compares against
  identifiers derived in-process rather than scraped from the commands' own
  output, reads each exit code from the spawned process rather than through a
  pipe, and fails closed naming the fixture if it ever stops carrying source
  objects.

  No artifact byte, hash, receipt field or existing schema changes, and nothing is
  signed. A replay against a case the same party produced proves derivation, not
  authenticity -- the limitation the verifier already states, and the reason both
  commands demand a recorded identifier. See ADR-0013.

- **`reuseproof-verify`, the on-disk bundle check as a command.**
  `verifyFrozenReportBundleAtPath` could re-verify a written bundle from disk
  alone, and only a TypeScript caller could reach it. A records clerk, a State
  Board reader, or a jurisdiction auditor holding an independently recorded
  snapshot ID had no way to use it. `bin/reuseproof-verify.js`, built from
  `scripts/verify.ts`, is that boundary: it prints each artifact's filename,
  byte length and digest, the snapshot ID, the receipt-core hash, the report
  content hash and version, and every limitation the verification carries.
  `--json` emits the `VerifiedFrozenReportBundle`, or the refusal.

  `--expect-snapshot` is required, and that is the point. The bundle is
  deliberately unsigned, so anyone holding this tool can regenerate a wholly
  self-consistent one; omitting the recorded ID is a usage error, and
  `--print-only` prints the bundle's own identifiers while still exiting
  non-zero, so a comparison that was never made cannot be read as one that
  passed.

  A refusal is never a partial verification. Nothing reaches standard output
  until every check has passed; a refusal writes one machine-readable line to
  standard error and returns its own exit code. Every
  `FrozenBundleRejectionReason` has a distinct code, declared as a total record
  over the union so a reason added to the library fails to compile rather than
  falling into a default that would report it as some other failure, and
  `tests/verify-cli.test.ts` holds the README's exit-code table against the
  codes the command actually returns.

  The manifest the command prints is read back from `report-freeze.json` after
  verification, and that second read is anchored rather than trusted: the
  snapshot ID is derived from that file's own bytes, so it must equal the one
  verification returned. A bundle edited between the two reads exits 6 instead
  of being printed as verified.

### Changed

- The coverage scope now covers every command this package ships.
  `vitest.config.ts` measured `src/**/*.ts` only, which was the whole of the
  package until a `bin` existed; a published surface outside the coverage scope
  is a floor that cannot fail. `scripts/verify.ts` is named there, and
  `tests/coverage-thresholds.test.ts` derives the required set from
  `package.json`'s `bin` and the module each shim imports, so a second command
  added without a coverage entry fails the suite instead of shipping
  unmeasured. `scripts/demo.ts` stays out deliberately: `npm run demo:check`
  runs it as a subprocess, which this provider does not follow, so including it
  would report 0% for code that does run.

### Security

- The CodeQL gate fails on a High security finding, not only on an
  error-severity query. CodeQL carries two severities per rule and they measure
  different things: `problem.severity` grades the query, `security-severity` is
  the CVSS score of the weakness. `js/incomplete-url-substring-sanitization` is
  `problem.severity: warning` carrying `security-severity: 7.8`, which GitHub
  renders as a **High** alert — and the gate printed it as advisory and exited 0
  under a line reading `0 error-severity finding(s)`, which a reader takes as
  "CodeQL found nothing". The floor is now two-sided: error-severity, or CVSS at
  or above 7.0, GitHub's own high/critical boundary. A missing score is still
  not a low score, an unparseable score is not a missing one (it stays gated by
  `problem.severity` and is printed as it was found rather than rounded down),
  and below-floor findings are now listed with their CVSS score so an advisory
  is locatable. See [ADR-0012](docs/adr/0012-gate-codeql-on-the-weakness-severity.md).

### Security

- The weekly full-history secret sweep runs the scanner its pin names. The
  TruffleHog action's `version:` input selects the container image that actually
  scans — SHA-pinning the `uses:` line does not — and Dependabot cannot see that
  input. It bumped the action SHA to v3.97.0 and then to v3.97.1 while the input
  stayed at `'3.96.0'`, so the sweep claimed 3.97.1 in its pin and ran 3.96.0,
  with no diff, no annotation and nothing anywhere reporting the gap. The input
  is now `'3.97.1'`.

### Added

- `scripts/check-workflow-pins.mjs`, in `make verify` as `npm run check:pins`,
  so that gap cannot reopen silently. It holds three properties across
  `.github/workflows`: every `uses:` is pinned to a full commit SHA and carries
  a reviewable version comment; an action used in several places resolves to one
  SHA and one version everywhere; and an action whose runtime is selected by an
  input has that input equal to the version its SHA is pinned at. Per ADR-0011
  it fails closed at three empty-scan floors — an unreadable workflow directory,
  a directory with no workflow document, and documents carrying no `uses:`
  reference — rather than reporting a clean scan it did not perform. A reusable
  workflow is exempt from the version-comment rule only, because it is selected
  by commit and publishes no version to name; the SHA requirement still applies
  to it.

### Fixed

- Coverage evaluation resolves observations to intervals by binary search rather
  than by scanning the whole interval list per observation. `containingInterval`
  was called once per observation and re-parsed both RFC 3339 bounds of every
  interval it rejected, making the join O(observations x intervals) — and
  `MAX_EXPECTED_INTERVALS` permits 200,000 intervals with no ceiling on
  observations. The candidate intervals tile their range, so sorted by start
  they are disjoint and ascending and at most one can contain a given instant;
  that invariant is now checked while the index is built rather than assumed.
  `applicableNonoperation` no longer copies, re-sorts and re-parses the
  nonoperation list once per expected interval either. Measured, one required
  series at minute cadence with one observation per interval: 8,000 intervals
  fell from 46.1 s to 93 ms, and 1,000 to 4,000 intervals cost 15.2x before
  against 4.3x after. `CoverageSummary` output is unchanged — the demo fixture
  renders byte-identically (#42).
- CSV reconciliation is linear in the row count rather than quadratic.
  `candidateFromOutcome` ran once per row and resolved its routed row, its
  observation and its numeric preimage with `Array.prototype.find` over arrays
  whose length is the row count — two of those lookups performed twice — while
  rebuilding the measurement mapping each time. Every key involved is unique
  within a submission, so the joins are now indexed once per submission and each
  row costs constant time. Measured on one source: 800 to 3,200 rows cost 9.3x
  before and 4.2x after, and 3,200 rows fell from 937 ms to 240 ms; the 100,000
  rows `CSV_HARD_LIMITS.maxRecords` admits took just over 20 minutes before,
  against NFR-03's 15-minute budget for the whole pipeline. Reconciliation
  output is unchanged — the demo fixture renders byte-identically (#44).
- Marker hygiene's empty-scan guard is now per root rather than aggregate.
  `scripts/check-hygiene.mjs` required one file across all roots together, but
  the drift it exists to catch happens to one root at a time: a root that still
  existed and merely stopped holding `.ts`/`.mjs` returned nothing, was absorbed
  into the other roots' totals, and the green line went on naming it as scanned
  while every bare marker under it was unenforced. Each configured root must now
  contribute at least one file, the failure names the specific roots that
  contributed none, and a passing run prints the per-root counts so a green gate
  states what it actually covered (ADR-0011, #43).
- Marker hygiene no longer reports success for a scan that examined nothing.
  `scripts/check-hygiene.mjs` walked three roots for two file extensions and
  exited 0 whenever it found no violations — including when it found no files at
  all, which is what happens if a root is renamed, moved under a different
  layout, or comes to hold no `.ts`/`.mjs`. `make verify` then reported hygiene
  as enforced having read nothing. An empty scan and an unreadable root are now
  failures, the failure names the root, and a passing run states how many files
  it covered (ADR-0011).
- Coverage threshold keys that match no file are now a failing test.
  `vitest.config.ts` expresses the 95% safety-core floor with keys like
  `src/domain/**` and five named files, and Vitest ignores a key matching
  nothing without any diagnostic — so renaming a safety-core file silently
  dropped it to the 80% global floor while `DEFINITION_OF_DONE.md` went on
  promising the 95% one. `tests/coverage-thresholds.test.ts` also refuses a
  keyed threshold set below the global floor, a keyed threshold that omits a
  metric, and a key shape the guard cannot interpret (ADR-0011).

### Added

- `npm run demo:check` as an eighth `make verify` step, running the already-built
  demo against `fixtures/reconciled-demo.json`. The quickstart `README.md`
  advertises was executed by no gate, and that fixture was read by no test, so
  the documented entrypoint could break with CI green (ADR-0011).
- `tests/hygiene.test.ts`, covering the previously untested marker-hygiene gate:
  bare markers, issue references, word-boundary matching, nested directories,
  the empty-scan and missing-root failures, and the shipped roots.
- `docs/plans/improvement-plan.md`, recording the CI failure diagnosis. All 32
  recorded workflow failures are classified: 21 were jobs GitHub declined to
  start for an account-level Actions billing reason and ran zero steps, 4 were a
  real CodeQL error-severity finding, 3 a CodeQL upload rejection, 2 a TruffleHog
  CLI misuse and 2 a genuine `make verify` failure. No test was ever flaky. The
  document also records the highest-ranked open finding: the `codeql` jobs are
  not required status checks on `main`, so every CodeQL failure to date was
  advisory at the merge boundary. That is a repository ruleset change and remains
  open.
- `README.md` now states the signature of a starved job — a `failure` with zero
  steps and a sub-10-second wall time — because it is indistinguishable from a
  real gate failure in `gh run list`.

### Security

- Stop restoring an npm cache in `ci.yml`, so no workflow in this repository
  reads or writes an Actions cache. `release.yml` verifies an authorize-resolved
  commit under the default branch's cache scope, and the code it runs could
  write an entry `ci.yml` would later restore; with the restore side gone, the
  default branch has no cache entry for that path to poison (ADR-0010).
- Record accepted CodeQL findings in `scripts/codeql-gate.mjs` rather than
  leaving the gate red or lowering it. An acceptance matches one rule, in one
  analysis category, in one file, about one named untrusted input; a second
  instance of the same rule still fails the build, and an acceptance matching
  nothing fails the build too, so a stale exemption cannot sit there widening.
  Accepted findings print on every run with their reasoning and their removal
  condition. The first and only entry is
  `actions/cache-poisoning/poisonable-step` in `release.yml`, which has failed
  the default branch since 2026-08-18 (ADR-0010).
- Keep the tag-triggered release verification path cache-free so runtime
  artifacts cannot inherit mutable npm cache contents from a less-trusted run.
- Pin the transitive `postcss` build dependency (pulled in via `vite`/`vitest`)
  to 8.5.25 via an `overrides` entry, closing GHSA-fxqj-rqcc-2cmp. `npm audit`
  is gated on high severity only, so this moderate finding was already
  invisible to CI green/red — it showed up solely as a GitHub Dependabot alert
  on the default branch. `postcss` never processes untrusted CSS here (it is
  build/test tooling only), so this closes a visible advisory rather than a
  live exposure.

### Changed

- Delay newly published dependency versions before Dependabot proposes routine
  updates: 30 days for npm majors, seven days for npm minors and GitHub
  Actions, and three days for npm patches. Security updates remain immediate.

### Added

- On-disk frozen-bundle verification (`verifyFrozenReportBundleAtPath`): the
  write boundary had no read side, so once a bundle left memory nothing in this
  repository could tell an intact one from an edited one. Verification is rooted
  at `report-freeze.json` and closes the chain through the receipt core to every
  rendered artifact's bytes. Missing, unreadable, non-UTF-8, non-canonical,
  wrongly versioned, structurally altered, duplicated, reordered, extra and
  non-regular entries all raise a typed `FrozenBundleVerificationError` carrying
  a machine-readable reason, so "could not check" can never be returned as
  "verified". Byte integrity only — an unsigned bundle can still be regenerated
  wholesale, which the returned limitations state explicitly.
- Signed-tag release-candidate authorization that proves stable SemVer,
  protected-main ancestry, and the exact current main commit before the private
  package's verification workflow receives execution authority.
- An explicit internationalization applicability record that preserves the
  locale-independent evidence contract and blocks the first public web release
  on reviewed EN/ES catalogs and automated parity gates.
- Public product, architecture, evidence, safety, accessibility, testing and
  operations documentation plus ADR-0001 fixing the read-only local-program
  evidence-plane boundary.
- Iteration 1 (#1): required-series coverage foundation — deeply frozen,
  effective-dated `RequiredSeriesContract` inputs, transport-only vendor
  mapping binder, half-open expected-interval evaluation and fail-closed
  duplicate observation identities.
- V1 wave 2 (#2): deterministic readiness preflight — explicit civil-time
  resolution with named IANA zones and DST disambiguation, effective-dated
  lifecycle timelines, fixed coverage preflight gates and content-addressed
  `coverage-summary/v2` results (ADR-0002).
- V1 wave 3 (#3): frozen deterministic report artifacts —
  `report-content-projection/v3`, deterministic script-free HTML /
  injection-safe CSV / canonical JSON render manifest, unsigned hash-derived
  receipt core with verification envelope, and an allowlisted atomic
  local-output boundary (ADR-0003).
- Iteration 4: governed exact-decimal daily aggregation — coverage-winner-bound
  numeric preimages, effective-dated affine unit rules, IANA civil-day buckets,
  exact rational sum/mean/minimum/maximum and explicit final rounding
  (ADR-0004).
- Iteration 5: bounded CSV source routing — strict transport/source contracts,
  exact source and row hashes, fatal UTF-8 and bounded CSV parsing, exact
  headers, stable row locators and reconciled accepted/duplicate/quarantine
  outcomes (ADR-0005).
- Iteration 6: governed CSV measurement normalization — authorized transport
  field mappings, exact source rerouting, deterministic observation identities,
  typed timestamp/range/unit/value quarantines and direct exact-decimal
  preimages for the coverage and aggregation engines (ADR-0006).
- Iteration 7: deterministic cross-source CSV reconciliation — exact-source
  resubmission accounting, byte-distinct semantic replay collapse and explicit
  `conflicting_duplicate` quarantine with no arbitrary accepted winner
  (ADR-0007).
- Iteration 8: deterministic reconciled evidence evaluation — an independent
  required-contract set with exactly one governed series bundle per contract,
  bounded zero-source/reconciled operational states, retry-insensitive evidence
  identity, coverage-winner-only exact daily aggregation and fully derived
  provenance through the existing unsigned receipt and frozen draft
  (ADR-0008).
- Iteration 9: exact replay integrity validation — strict full-result
  reconstruction from exact bytes and governance preimages, hostile-container
  rejection, nested tamper detection and canonical frozen replay return
  (ADR-0009).
- Standards-conformance sweep (2026-07-16): CodeQL, TruffleHog and Dependabot
  scanning, tag-triggered release workflow, SECURITY.md, CONTRIBUTING.md,
  CITATION.cff, LICENSE (Apache-2.0), pre-commit config, ADR seed record and
  README conformance table.

### Fixed

- Reconciled `conflicting_duplicate` quarantine outcomes now pass the strict
  coverage/receipt reconstruction boundary, and exact source snapshots ignore
  caller-shadowed typed-array properties/iterators while rejecting shared or
  resizable backing storage.
- Updated the transitive `brace-expansion` development dependency to 5.0.8 so
  the blocking high-severity dependency audit is clean.
