# ReuseProof CA Core

ReuseProof CA Core is the open-source, deterministic evidence-domain foundation for a read-only, hardware-neutral regulatory evidence and program-operations control plane for California local jurisdictions that elect to operate onsite treated nonpotable water system (OTNWS) programs.

It helps a jurisdiction and each permitted system assemble traceable permit, commissioning, monitoring, incident, inspection, cross-connection, and reporting evidence. It does **not** operate treatment equipment or decide that a system or jurisdiction is legally compliant.

## Quickstart

Run the synthetic local slice (everything is local; no credentials, no network writes):

```sh
npm ci          # install pinned dependencies
make verify     # format check + lint + typecheck + tests with coverage + build + audit + hygiene (CI parity)
npm run demo    # synthetic end-to-end fixture: bounded parse → contract/mapping bind → coverage → render/receipt → frozen draft
```

What the demo exercises — and the deliberate limits of the local slice — are described under [Implementation status](#implementation-status).

## Exact V1 definition

V1 is a multi-tenant web application and API that:

1. configures one or more local OTNWS programs and their locally approved reporting profiles;
2. registers systems, responsible entities, duly authorized agents, operators, vendors, permits, and lifecycle state;
3. records permit and commissioning evidence without approving engineering;
4. ingests three demonstrated vendor formats through read-only CSV or vendor-cloud API adapters, never by writing to SCADA or building controls;
5. retains source objects, normalizes monitoring measurements and required daily summaries, and computes coverage from immutable pre-ingest required-series contracts independent of vendor mappings;
6. creates human-reviewable candidate exceptions and links corrective-action evidence without making compliance determinations;
7. records complaints, malfunctions, inspections, cross-connection hazard assessments/tests, and backflow tests;
8. produces an editable draft of the annual local-jurisdiction report due February 1 under final 22 CCR section 60606, plus a distinct Water Code section 13558(b)(3) monitoring-data section whose authority, schema and review status must be recorded;
9. issues a deterministic unsigned receipt core with a hash-derived ID and separate human verification envelope—never a signature, certificate or self-hashing artifact; and
10. provides private jurisdiction/system views and an explicitly approved, aggregate public view that excludes critical-infrastructure metadata.

The public repository currently ships only the synthetic, headless domain foundation described below. Hosted deployment, jurisdiction-specific configurations, real-data integrations, implementation schedules, customer work and commercial planning are outside this repository.

## Regulatory anchor and important distinction

The State Water Resources Control Board states that the regulations became effective **April 22, 2026**. An OTNWS operating before that date must comply by **April 21, 2028**, subject to a local extension under the final rule. A jurisdiction electing to establish a program must report to the State Water Board by **February 1 following each calendar reporting year**.

The final February 2026 regulation text at 22 CCR section 60606 lists permit/system lifecycle, source/end-use volume, violations/corrective actions, complaints/malfunctions and resolutions, and inspections. It does **not** contain the continuous-monitoring minimum/maximum item that appeared in the March 2025 proposed text. California Water Code section 13558(b)(3) nevertheless mentions water-quality monitoring data in the annual local report. ReuseProof CA therefore:

- implements the final section 60606 elements as the default annual-report schema;
- keeps monitoring summaries in the at-least-quarterly system report workflow under section 60688; and
- keeps final 22 CCR section 60606 fields distinct from Water Code section 13558(b)(3) monitoring data;
- excludes the proposal-only continuous-monitoring min/max annual field; and
- blocks an annual draft from becoming review-ready until the jurisdiction records the authority, schema and reviewer for its statutory monitoring-data implementation. An unresolved interpretation remains a visible blocker rather than an omitted section.

The product never resolves that legal-text tension on its own.

## Non-goals

- SCADA, PLC, building-management, alarm, valve, pump, diversion, or treatment control commands
- real-time operational safety monitoring or replacement of onsite alarms and operator response
- compliance certification, legal advice, permit approval, enforcement, or automatic violation issuance
- treatment-process design, engineering calculations, validation studies, or commissioning judgments
- laboratory sampling, analysis, chain-of-custody, or accreditation functions
- a statewide State Water Board submission portal
- a replacement for general permitting, asset-management, CMMS, vendor O&M, or public-records systems

## Start here

| Document | Purpose |
|---|---|
| [01-PRD](docs/01-PRD.md) | Personas, jobs, functional and non-functional requirements, acceptance criteria |
| [03-SERVICE-DESIGN](docs/03-SERVICE-DESIGN.md) | Service blueprint, roles, RACI, support and escalation boundaries |
| [04-ARCHITECTURE](docs/04-ARCHITECTURE.md) | Modular-monolith design, data flow, APIs, storage, workers, trade-offs |
| [05-DATA-AND-EVIDENCE](docs/05-DATA-AND-EVIDENCE.md) | Ontology, normalized parameters, provenance, quality, receipts and report schema |
| [06-SECURITY-PRIVACY-THREAT-MODEL](docs/06-SECURITY-PRIVACY-THREAT-MODEL.md) | Tenant isolation, critical-infrastructure controls and misuse analysis |
| [07-GOVERNANCE-LEGAL-SAFETY](docs/07-GOVERNANCE-LEGAL-SAFETY.md) | Decision rights, regulatory posture, claims and safety case |
| [08-ACCESSIBILITY-I18N](docs/08-ACCESSIBILITY-I18N.md) | WCAG, accessible reports, language and procurement evidence |
| [09-TEST-AND-EVALUATION](docs/09-TEST-AND-EVALUATION.md) | Test pyramid, adapter evaluation, invariants and release sequence |
| [10-OPERATIONS-SRE](docs/10-OPERATIONS-SRE.md) | SLOs, observability, backup, incident response and runbooks |
| [16-RESEARCH-SOURCES](docs/16-RESEARCH-SOURCES.md) | Official primary sources and evidence-strength rules |
| [PUBLIC-ROADMAP](docs/PUBLIC-ROADMAP.md) | Public core scope, priorities and contribution boundaries |
| [ADR-0001](docs/adr/0001-v1-boundary.md) | Binding V1 boundary and architectural decision |
| [ADR-0002](docs/adr/0002-deterministic-time-lifecycle-and-coverage-preflight.md) | Deterministic time, lifecycle and coverage boundary |
| [ADR-0003](docs/adr/0003-deterministic-report-freeze-and-accessible-artifacts.md) | Report freeze, render-byte, receipt and envelope boundary |
| [ADR-0004](docs/adr/0004-governed-exact-decimal-daily-aggregation.md) | Governed exact-decimal conversion and daily numeric aggregation boundary |
| [ADR-0005](docs/adr/0005-bounded-csv-source-routing.md) | Bounded CSV source-contract and deterministic routing boundary |
| [ADR-0006](docs/adr/0006-governed-csv-measurement-normalization.md) | Governed CSV measurement normalization into coverage and numeric preimages |
| [ADR-0007](docs/adr/0007-deterministic-cross-source-csv-reconciliation.md) | Deterministic cross-source CSV replay and conflict reconciliation |

## Working principles

1. **Evidence, not certification.** Every status names its source, time window, mapping version, and human disposition.
2. **Read-only toward water systems.** No adapter credential may possess control-plane write privileges.
3. **Local authority stays local.** Jurisdiction profiles are versioned; ReuseProof does not invent statewide interpretations.
4. **Public by deliberate review, not default.** Exact sites, schematics, telemetry endpoints, unresolved vulnerabilities, and personal contacts remain private unless the jurisdiction makes a documented disclosure decision.
5. **Raw evidence remains reproducible.** Original files are retained according to the jurisdiction's approved schedule; normalized facts never overwrite source objects.
6. **Unknown is a valid result.** Missing, stale, ambiguous, or unmapped data is shown as a gap, never silently converted into pass/fail.
7. **Trust purposes stay separate.** Offline-root-authorized, workload-bound signatures protect pipeline, allowlist and release manifests; they do not sign receipts or evidence claims.

## Proposed implementation

- TypeScript, Next.js and a versioned REST API in a modular monolith
- PostgreSQL with row-level security and normalized measurement tables
- S3-compatible immutable source/evidence objects with hashes
- TypeScript asynchronous ingestion workers using a PostgreSQL-backed queue for V1
- OIDC/SAML identity provider, MFA for privileged roles, and scoped service accounts
- time-series extensions only after measured pilot scale or query performance justifies them

## Implementation status

Iterations 1–7 now include a headless TypeScript domain foundation, not a production application:

- deeply frozen, effective-dated `RequiredSeriesContract` inputs with explicit permit, profile, lifecycle and treatment activation references;
- a transport-only vendor-mapping type and binder that cannot add, remove or relax the required-series set;
- a strict transport-only CSV adapter/source contract plus exact-byte hashing, fatal UTF-8 decoding, bounded RFC-style parsing, exact-header enforcement and one accepted/duplicate/quarantine outcome for every syntactically safe data record;
- a strict CSV measurement mapping that reroutes the exact source bytes, binds accepted candidate rows to independently approved required-series and unit-conversion contracts, and emits deterministic coverage observations plus exact-decimal numeric preimages without guessing timestamps, units or malformed values;
- a bounded cross-source CSV reconciliation boundary that reruns complete normalization inputs, deduplicates exact source submissions and byte-distinct semantic replays, requires timestamp-bearing governed identities, and replaces contradictory values, units or normalization states with an explicit `conflicting_duplicate` quarantine rather than choosing a winner;
- half-open expected-interval evaluation, prior-authorized scheduled-nonoperation handling and exactly-one-final-observation counting;
- explicit accepted, duplicate, quarantined, gap and scheduled-nonoperation outcomes;
- fail-closed duplicate observation identities and a 200,000-interval in-memory safety limit per required series;
- duplicate-key-safe raw JSON parsing with fixed UTF-8 byte, structural-depth and parsed-node limits before strict JSON-shaped domain construction; direct object inputs require own enumerable data fields on plain or null-prototype records;
- explicit civil-time resolution with a named IANA zone—never a fixed-offset identifier—and `earlier`, `later` or `reject` disambiguation, including 23-hour and 25-hour DST denominator tests;
- effective-dated lifecycle timelines that split cadence intervals at transitions, preserve evidence references and stop evaluation on an applicable timeline gap;
- fixed data-coverage preflight gates of at least 95% per required series and at least 90% declared source/interval pairs per report-critical aggregate, with zero denominators reported as not applicable;
- exact-decimal numeric preimages bound to the recomputed accepted-coverage winner set, effective-dated authorized affine unit-conversion rules, named-IANA-zone civil-day bucketing and deterministic sum/mean/minimum/maximum output with explicit final rounding;
- content-addressed internal `coverage-summary/v2` results whose governing contract and complete normalized evaluation input are verified by safe recomputation before readiness;
- deterministic coverage-readiness set hashes and a complete canonical evidence manifest whose source, version, governing-contract, evaluation-input and coverage-summary set bindings are included in an unsigned, hash-derived, non-self-referential receipt core;
- an always-present, recomputed coverage preflight in `report-content-projection/v3`, immutable report-safe series metadata including parameter, canonical unit and source/report time zones, and a `requiredSeries` aggregate limited to contract ID/version/hash, report-time basis, coverage ratio and accepted/expected/gap/duplicate/quarantine counts; deterministic script-free HTML, spreadsheet-injection-safe CSV and canonical JSON bytes form an exact media-type/filename-sorted render manifest;
- strict output-boundary reconstruction of exact outer and nested runtime schemas, summary accounting, readiness thresholds, aggregate membership, input/summary set hashes and render bytes; the internal receipt retains each governing-contract and normalized evaluation preimage plus the full coverage summaries, recomputes interval classes, lifecycle provenance and duplicate reasons, then proves the report-safe aggregate was derived exactly without rendering those confidential details;
- versioned deterministic frozen-draft snapshots whose later versions require the actual valid, same-scope, immediately prior frozen report, plus a verification envelope that can validate only against its exact frozen-report subject—never product filing, destination acceptance, signature or approval;
- an allowlisted local-output boundary that writes fixed safe filenames into a private staging directory, fsyncs each file and directory, and atomically exposes the complete bundle without including an envelope in the hashed report artifacts; and
- a synthetic end-to-end fixture and CLI demonstrating bounded parse → contract/mapping bind → lifecycle/time resolution → coverage/readiness → content/render/receipt → frozen draft.

Run the local slice:

~~~sh
npm ci
make verify
npm run demo
~~~

CSV routing, normalization and reconciliation, civil-time, lifecycle, readiness, numeric aggregation, rendering, freezing and envelope behavior is executable only as a synthetic local foundation. The CSV boundary hashes caller-supplied bytes but does not upload, magic-byte inspect, malware-scan, retain, authorize or stream an evidence object; its 10 MiB in-memory ceiling deliberately does not satisfy the hosted 100k-row streaming gate. Normalization accepts only fixed-millisecond UTC timestamps and one measurement mapping per source; it does not implement vendor-local timestamp formats, sentinel/plausibility policy, multi-series rows or an approved jurisdiction parameter/unit dictionary. Cross-source reconciliation is limited to 64 exact in-memory inputs and demonstrates deterministic replay/conflict handling, not durable idempotency, concurrent-worker safety, correction approval or database uniqueness. The readiness result is explicitly a data-coverage preflight—not report approval. Numeric aggregation is connected to the synthetic reconciled CSV result but still requires synthetic caller-supplied authorization references and is not connected to durable measurement storage or report projections. The fixture's lifecycle evidence and activation references are synthetic identifiers, not jurisdiction-approved facts. The emitted HTML/CSV/JSON covers only the synthetic evidence-coverage projection; it is not the complete quarterly or annual regulatory schema. Three real vendor adapters, real source-object ingestion, PDF, databases, tenancy/authentication, authenticated actors, append-only audit storage, vendor/OT networking, hosted report workflows, external APIs, destination receipt verification and cryptographic signing are not implemented. The verification-envelope constructor models trusted references but does not authenticate a human or validate an external destination's proof. The local in-memory receipt/freeze wrappers retain governing-contract preimages, normalized evaluation preimages, full coverage summaries and prior frozen reports for validation, while emitted report artifacts contain only report-safe aggregates and emitted cores contain only their hashes; production restore and audit therefore still require durable retention of those authoritative objects.

The repository therefore remains pre-production. Its plans are not a legal opinion or engineering approval, and the executable slice makes no compliance, safety, water-quality or regulatory-filing determination.

## Standards Conformance

This repository is developed against a shared set of portfolio engineering
standards. Applicability and current state:

| Standard | Applies? | State |
|---|---|---|
| Responsible-Tech Framework | Applies | Applies — governance, claims and safety-case posture in [07-GOVERNANCE-LEGAL-SAFETY](docs/07-GOVERNANCE-LEGAL-SAFETY.md) and the Working principles above |
| Code Quality | Applies | Applies — Prettier + ESLint (zero warnings) + strict `tsc` + Vitest + marker hygiene, all in `make verify` |
| Security & Supply-Chain | Applies | Applies — SHA-pinned Actions, CodeQL, TruffleHog weekly full-history sweep, gitleaks pre-commit, `npm audit` in the merge gate, Dependabot; threat model in [06-SECURITY-PRIVACY-THREAT-MODEL](docs/06-SECURITY-PRIVACY-THREAT-MODEL.md) |
| CI/CD | Applies | Applies — `ci.yml` runs the literal `make verify` merge gate; scoped permissions and concurrency on every workflow |
| Observability | Applies | Applies at library tier — deterministic, content-addressed artifacts and explicit outcome taxonomies are the current observability surface; SLOs/runbooks planned in [10-OPERATIONS-SRE](docs/10-OPERATIONS-SRE.md) for the hosted app |
| Accessibility | N/A — current shipped slice is a TypeScript library/demo with no human-facing HTML; re-enters scope when the planned web app ships | Deterministic report HTML is built script-free with accessibility in mind ([08-ACCESSIBILITY-I18N](docs/08-ACCESSIBILITY-I18N.md)); full WCAG gates arrive with the web app |
| Internationalization | Applies | In progress — planned California jurisdiction/public workflow keeps I18N in scope (conservative default); no catalog infrastructure exists yet and an owner declaration is pending, so this is an acknowledged open gap, not a declared exemption |
| AI Evaluation | N/A — deterministic regulatory-evidence domain; no LLM/model component | N/A — no model or generative component anywhere in `src/`, `scripts/` or `tests/` |
| Documentation | Applies | Applies — public product, architecture, data, safety and operations documentation; ADR log in [docs/adr/](docs/adr/); CONTRIBUTING, SECURITY and CHANGELOG |
| Quality & Metrics | Applies | Applies — coverage measured via `npm run test:coverage` in the merge gate; priorities and contribution boundaries in [PUBLIC-ROADMAP](docs/PUBLIC-ROADMAP.md) |
| Release & Versioning | Applies | Applies — SemVer, `CHANGELOG.md` with `[Unreleased]`, tag-triggered `release.yml` that re-verifies at the tagged commit; no tag shipped yet (pre-1.0) |
