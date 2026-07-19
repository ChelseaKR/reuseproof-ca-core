# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
No version has been tagged yet.

## [Unreleased]

### Added

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
- Standards-conformance sweep (2026-07-16): CodeQL, TruffleHog and Dependabot
  scanning, tag-triggered release workflow, SECURITY.md, CONTRIBUTING.md,
  CITATION.cff, LICENSE (Apache-2.0), pre-commit config, ADR seed record and
  README conformance table.
