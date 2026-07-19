# ADR-0001: V1 is a read-only local-program evidence plane

- **Status:** Accepted for planning; governance confirmation required before live pilot
- **Date:** July 13, 2026
- **Decision owners:** Product/technical lead
- **Required reviewers:** California water engineer, local program administrator, building operator, cybersecurity reviewer, community/public representative, counsel

## Context

California's OTNWS regulations became effective April 22, 2026. Local jurisdictions that elect to establish programs must manage evidence across permits, engineering and commissioning, operations, monitoring, events, cross-connection controls, inspections and annual reporting. Equipment vendors, operators and municipal systems generate heterogeneous evidence.

A broad “water operating system” would create unacceptable safety, cybersecurity, regulatory, procurement and scope risk. A narrow evidence layer can be tested without touching treatment controls or taking authority from engineers, operators or jurisdictions.

The final February 2026 section 60606 annual-report text also differs from the March 2025 proposed text: the final text omits the proposed continuous-monitoring min/max item, while Water Code section 13558(b)(3) still mentions monitoring data. The product cannot decide that ambiguity.

## Decision

Build V1 as an initially read-only, hardware-neutral, multi-tenant California local-program evidence and reporting control plane.

V1 will:

- configure jurisdiction program/report/disclosure profiles;
- register systems and responsible parties;
- preserve permit/commissioning/operations/field evidence;
- ingest approved CSV and vendor-cloud read APIs;
- normalize measurements and daily summaries;
- expose gaps/quarantines and human-review candidate exceptions;
- record complaints, malfunctions, corrective actions and field evidence;
- generate draft section 60688 quarterly packets;
- generate default final-section-60606 annual drafts;
- provide an always-present, distinct Water Code monitoring-data section whose implementation is configured by authorized humans and whose unresolved state blocks review-ready approval;
- derive coverage only from immutable pre-ingest `RequiredSeriesContract`s activated by approved permit/profile, lifecycle and prescribed treatment train or approved alternative, never vendor mapping presence;
- issue deterministic unsigned evidence-receipt cores with hash-derived IDs and associate separate human verification envelopes;
- use a purpose/threshold-signed release/control plane—offline 2-of-3 Ed25519 root trust and workload-bound KMS/HSM operational keys—without turning receipts into signatures or certificates;
- separate private operational and frozen aggregate public views.

Technology:

- TypeScript/Next.js modular monolith and versioned REST API;
- PostgreSQL with forced row-level security and partitioned normalized measurement tables;
- S3-compatible versioned/hash-addressed evidence objects;
- asynchronous TypeScript workers with PostgreSQL-backed queue;
- managed OIDC/SAML and secrets;
- no time-series extension until measured need.

## Binding invariants

1. No direct connection to building OT/SCADA/PLC/BMS.
2. No device/control write, setpoint, alarm acknowledgement, diversion or treatment command.
3. No safety-critical real-time monitoring claim or operator-response dependency.
4. No automated compliance, safety, violation, permit or enforcement determination.
5. No treatment engineering, commissioning, validation or laboratory function.
6. No automatic State Water Board submission/statewide portal.
7. Unknown/missing/ambiguous evidence remains explicit.
8. Quantitative report facts trace to source and pinned transformation versions.
9. Default annual schema follows final 60606, not proposed text.
10. Public output is copied through a human-approved, versioned allowlist to a separate frozen store.
11. Expected-interval and aggregate-source-set denominators come from immutable approved `RequiredSeriesContract`s; vendor contracts control transport/mapping only.
12. Canonical report content and render bytes are hashed before the receipt core; runtime receipt IDs/times, attestations and URLs live outside the core, and hashed artifacts contain no back-link that creates a self-hash.
13. Release artifacts, adapter/disclosure allowlists and pipeline attestations use distinct purpose/role/threshold signing policies; trust/time/revocation failure freezes promotion, while evidence receipts remain explicitly unsigned.
14. Final-rule covenant, commissioning, pre-indoor information, decommissioning-content, specialist/backflow-report and cross-connection-action evidence is independently represented; the product never performs, sends, files or approves the underlying act.

Any change to invariants 1–6 requires a new product, architecture, legal/safety analysis and ADR; it is not a V1/V2 feature toggle.

## Consequences

### Positive

- Lowest plausible cyber and public-health risk.
- Hardware/vendor neutrality and cross-system portfolio value.
- Faster modular-monolith delivery.
- Clear complement to permitting, vendor and consultant tools.
- Reproducible evidence without false certification.
- Municipal public/private controls designed in from the start.

### Negative

- Cannot replace onsite alarms, operators or vendor O&M.
- File-first delivery may be less “real time.”
- Human review remains necessary and potentially labor intensive.
- Municipal buyers may prefer existing-suite configuration.
- Evidence retention/public-record duties add cost.
- Product may have a smaller market because local programs are elective.

### Accepted uncertainties

- State annual submission format.
- Local/State/counsel interpretation of monitoring-data implementation; unresolved status blocks review-ready annual output.
- Number and pace of electing jurisdictions.
- Vendor API availability/cadence.
- Whether PostgreSQL remains economical at measured volume.
- Building-owner funding authority/acceptance.

## Alternatives considered

### A. SCADA/digital-twin control platform

Rejected. Directly overlaps vendor/OT products, expands cyber/public-health risk, requires operational reliability and creates a potential control path.

### B. Compliance certification engine

Rejected. Local/State authorities and licensed professionals retain decisions; evidence and law are not reducible to an automated pass/fail safely.

### C. Statewide submission portal

Rejected for V1. No authority or official interface; would require State sponsorship, statewide procurement and broader governance.

### D. Configure an incumbent or adjacent platform only

Before adding a new domain capability, compare it against configurable public-sector platforms, vendor portals, consultants and incumbent tools using the same bounded scenario and source contract. Prefer interoperability or configuration when it safely satisfies the requirement.

### E. Spreadsheet/template/consulting package

Viable fallback for small portfolios or weak demand. Prefer this pivot if SaaS commitments, data access or margins fail.

### F. Microservices/time-series platform from day one

Rejected. Adds operational complexity before workload is measured. Modular boundaries and partitioned PostgreSQL preserve an upgrade path.

## Validation

Decision remains accepted only if:

- five jurisdictions/three vendors are interviewed;
- two jurisdictions commit;
- before selection, both prove their own security-approved real historical corpus/profile mapping and independent control totals; one proves a complete calendar-year portfolio and the other its complete annual-draft-UAT corpus;
- three formats ingest read-only;
- one system shadows 30 days;
- generic substitutes do not suffice;
- security, accessibility, reconciliation and governance gates pass;
- 25-system gross-margin hypothesis is ≥55%.

## Review triggers

Create a new ADR if:

- customer requests any control/OT connection;
- an official State submission API/mandate emerges;
- report law/guidance materially changes;
- time-series scale exceeds the architecture trigger;
- public-record/security requirements demand dedicated deployment;
- product expands beyond California;
- generic-platform integration becomes the primary product;
- a safety incident or near miss implicates the product boundary.
