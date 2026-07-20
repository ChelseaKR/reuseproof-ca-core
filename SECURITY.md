# Security policy

ReuseProof CA is designed to handle regulatory evidence for water systems — a
domain where some records are critical-infrastructure metadata (exact sites,
schematics, telemetry endpoints, unresolved vulnerabilities, personal
contacts). The current shipped slice is a headless TypeScript library and demo
with no server, no credentials and no real jurisdiction data, but the security
posture is set now so it does not have to be retrofitted when the web
application ships.

## Supported versions

This is a pre-1.0 domain foundation; there is no tagged release yet. Security
fixes land on `main` and, once one exists, the latest tagged release.

| Version | Supported |
| ------- | --------- |
| `main` / latest tag | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

Use GitHub private vulnerability reporting from the repository's *Security*
tab. Do not open a public issue for a suspected vulnerability. Expect an
acknowledgement within a few days; this is a solo project, so please be patient
and do not disclose publicly until a fix is available.

### Redaction-safe reporting (please read)

Never paste real jurisdiction, permit, monitoring or personal data into an
issue, report or reproduction. Reproduce with the synthetic fixtures under
`fixtures/` and `tests/` — describe the *shape* of a leak rather than pasting
real records.

## What we consider a vulnerability

In addition to the usual (RCE, injection, secret exposure), the following are
**first-class** security bugs here, because they break the documented product
boundary (see `docs/06-SECURITY-PRIVACY-THREAT-MODEL.md` and
`docs/adr/0001-v1-boundary.md`):

- **Any path by which confidential evidence detail reaches a report-safe
  artifact** — the `report-content-projection` output-boundary reconstruction
  exists precisely to prove the report-safe aggregate was derived without
  rendering confidential details; a bypass is a vulnerability, not a bug.
- **Any nondeterminism or self-reference in the receipt core** — receipts are
  unsigned, hash-derived and non-self-referential by design; anything that lets
  a receipt validate against the wrong frozen report is a vulnerability.
- **Any write path toward water systems** — ingestion is read-only by
  contract; an adapter that can mutate SCADA/building-control state violates
  the binding V1 boundary.
- **Parser resource-exhaustion bypasses** — the bounded JSON and CSV parsing
  limits and the per-series interval safety limit are load-bearing; a way
  around them is reportable.

## Our commitments

- Boundary regressions (confidential detail in report-safe artifacts,
  receipt-validation confusion, write paths) are fixed with highest priority.
- We credit reporters who want credit, and respect those who want anonymity.
- Dependencies are pinned via `package-lock.json` and scanned (`npm audit` in
  `make verify` and CI, Dependabot, CodeQL for TypeScript and the workflows
  themselves, gitleaks in pre-commit, a weekly full-history TruffleHog sweep);
  GitHub Actions are SHA-pinned.
