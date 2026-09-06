# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
No version has been tagged yet.

## [Unreleased]

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
