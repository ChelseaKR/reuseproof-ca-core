# Architecture

## 1. Drivers

### Functional

- Isolate each local-jurisdiction tenant and scope system owners/vendors to named systems.
- Register program, system, organization, people/roles and lifecycle facts.
- Preserve versioned permit, commissioning, operations and field-test evidence.
- Ingest CSV/object exports and approved vendor-cloud APIs read-only.
- Normalize heterogeneous monitoring data and calculate reproducible daily summaries.
- Quarantine ambiguity; support replay and mapping changes without overwriting history.
- Manage candidate-exception review, complaints, malfunctions, corrective actions and inspections.
- Generate draft quarterly and annual reports plus evidence receipts.
- Publish only jurisdiction-approved aggregate snapshots.

### Non-functional

- No direct OT connection and no device/control write capability.
- PostgreSQL row-level tenant isolation and object-prefix authorization.
- Reproducible source-to-report lineage.
- WCAG 2.2 AA target and accessible report artifacts.
- Municipal SSO/MFA, complete privileged audit trail and contract-end export.
- 99.9% monthly application availability; product not used for operational safety.
- Database and accepted evidence-object RPO ≤15 minutes, RTO ≤8 hours; acknowledged frozen report/receipt objects have RPO 0.
- V1 capacity: 50 systems × 20 five-minute series, about 105.1 million measurements/year, plus 2x ingestion burst.

### Constraints

- Approximately 5.1 FTE average team and 11-month target.
- Municipal contracting/security/accessibility review is on the critical path.
- Final report formats may vary by jurisdiction.
- Vendor APIs may not exist; customer-pushed CSV must remain first class.
- Legal/regulatory ambiguities are configuration and human-decision inputs, never product conclusions.

## 2. Context

~~~text
 Vendor cloud/API ---read-only--\
 Operator CSV/object -----------> Ingestion boundary -> ReuseProof private tenant
 Permit/DMS export ------------/                         |
                                                          +-> Jurisdiction reviewers
                                                          +-> System owner/operator
                                                          +-> Draft exports (human submitted)
                                                          +-> Approved aggregate public snapshot

 Building OT / SCADA / PLC / BMS --X--> ReuseProof
 ReuseProof --X--> pumps, valves, alarms, setpoints, diversion or treatment
 ReuseProof --X--> automatic State Water Board submission or enforcement
~~~

The safest preferred pattern is customer-pushed export to an S3-compatible upload boundary. Vendor-cloud pulls are allowed only through public/vendor-managed APIs with documented read scopes. V1 does not install an agent inside the building or open an inbound path to operational technology.

## 3. Components and module boundaries

Implement a TypeScript modular monolith with explicit domain packages and one deployment boundary initially.

| Module | Responsibilities | Must not do |
|---|---|---|
| Identity & tenancy | SSO, sessions, RBAC, scoped grants, RLS context | Store local passwords or bypass RLS |
| Program | Jurisdiction profile, authority events, local-program lifecycle/termination preflight, source/version, local fields, disclosure policy | Invent legal interpretation or execute program termination |
| Registry | Systems, applicability facts, sites, governed organizations, people/roles, vendors, supplemental-source approvals, lifecycle and State Board system orders | Expose private contacts publicly, silently expand regulatory scope or execute a system order |
| Evidence | Object metadata, hashes, classifications, versions, links, holds | Modify source content |
| Adapters | Source contracts, credentials, pulls/uploads, parsers | Call control endpoints |
| Ingestion | Runs, raw-row references, validation, quarantine, replay | Silently drop data |
| Measurements | Parameter dictionary, series, observations, daily aggregates | Treat missing data as passing |
| Review | Candidate exceptions, dispositions, corrective actions | Declare legal violations |
| Events | Complaints, malfunctions, investigations, notifications | Replace emergency response |
| Field assurance | Inspections, cross-connection and backflow evidence | Conduct or certify tests |
| Reporting | Quarterly/annual draft, reconciliation, export, submission record | File automatically |
| Receipts | Deterministic manifest, hashes, attestations | Claim certification |
| Publication | Frozen allowlisted aggregate snapshot | Query private live tables directly |
| Audit | Append-only actor/system events and correlation | Store secrets or raw sensitive payloads |

Enforce module calls through TypeScript interfaces and service methods. Database tables remain grouped by schema/module even in one PostgreSQL database.

## 4. Recommended implementation

| Layer | V1 choice | Rationale |
|---|---|---|
| Web/API | Next.js App Router, TypeScript, versioned REST endpoints | One team/deployment; good accessible SSR; typed full stack |
| Domain | Plain TypeScript modules with dependency injection at boundaries | Testable without framework lock-in |
| Database | Managed PostgreSQL 16+, monthly partitioned measurements, RLS | Strong relational integrity/audit joins; measured V1 scale is feasible |
| ORM/query | Drizzle or Kysely with explicit SQL migrations and RLS tests | Typed queries without hiding SQL/partitions |
| Jobs | Separate TypeScript worker using pg-boss or equivalent PostgreSQL-backed queue | Avoid Redis/extra control plane at V1; transactional enqueue |
| Objects | S3-compatible object store with versioning, encryption and optional Object Lock | Preserve source evidence and large exports |
| Auth | Managed OIDC/SAML broker; MFA and SCIM where buyer requires | Do not build municipal identity |
| Reports | Server-side HTML templates; accessible HTML/CSV/JSON; tagged-PDF service validated separately | Reproducible and accessible formats |
| Observability | OpenTelemetry traces/metrics/logs, managed error tracking, audit events separate | Correlate source-to-report without logging sensitive payloads |
| Infrastructure | Infrastructure as code; separate dev/test/staging/prod accounts/projects | Reproducible procurement/security evidence |

Do not adopt TimescaleDB, ClickHouse, Kafka, Temporal or microservices before pilot measurements justify their operational cost.

## 5. Proposed workspace

~~~text
apps/
  web/                 Next.js UI and route handlers
  worker/              async ingestion, aggregation and report jobs
packages/
  auth/                tenant context and authorization
  program/
  registry/
  evidence/
  adapter-sdk/
  adapters/
    csv-generic/
    vendor-a/
    vendor-b/
  ingestion/
  measurements/
  review/
  field-assurance/
  reporting/
  receipts/
  publication/
  contracts/           JSON Schema/OpenAPI and generated types
  db/                  migrations, RLS policies, seeds
  test-fixtures/
infra/
  environments/
docs/
~~~

Adapter packages contain no network endpoint beyond their allowlisted vendor-cloud host and no shared customer credentials.

## 6. Data flows

### 6.1 Program and system setup

1. Jurisdiction admin authenticates through SSO.
2. Program module creates tenant-scoped, versioned profile.
3. Registry import validates systems and relationships in a dry run.
4. Authorized user confirms import; database transaction writes records and audit events.
5. Evidence artifacts upload through a presigned, tenant/system-scoped URL.
6. Object scanner validates type/size/malware, computes SHA-256 and writes evidence metadata.

### 6.2 CSV/object ingestion

1. Operator requests a presigned upload for a named system and adapter contract.
2. Object lands in quarantine prefix; no browser/API process parses it inline.
3. Malware/type/size checks pass; object is versioned and hashed.
4. Transaction creates ingestion run and job.
5. Worker streams file, validates headers/rows and stores row-level rejection references.
6. Adapter maps raw fields to normalized series/measurements.
7. Accepted measurements write idempotently using source fingerprint.
8. Quarantined records store reason and raw-object row locator, not a mutable copy.
9. Aggregate job computes daily summaries using pinned algorithm/profile version.
10. Receipt job freezes counts, gaps, mappings and hashes.

### 6.3 Vendor-cloud API pull

1. Security-approved OAuth/API credential is stored in managed secrets, referenced by opaque ID.
2. Scheduled worker assumes tenant/system context and calls only allowlisted GET/read endpoints.
3. Response is first written as a source object before normalization.
4. Pagination cursor and source watermark are stored; retry is idempotent.
5. Rate limits use exponential backoff and jitter.
6. Revocation, scope drift or non-GET behavior stops the adapter and opens a security review.

### 6.4 Review and corrective action

1. Aggregate or event may match a jurisdiction-approved comparison profile.
2. Review module creates a candidate exception with facts and profile version.
3. Reviewer sees raw source link, coverage, calculation and uncertainty.
4. Reviewer records disposition; operator may add explanation/corrective evidence.
5. Jurisdiction records any official violation outside or within the product as a human-authored authority record.
6. Report module includes only authorized status and summary fields.

### 6.5 Quarterly and annual draft

1. Admin selects tenant, period and profile version.
2. Preflight queries detect missing profile fields, unreviewed candidate exceptions, quarantines and reconciliation gaps.
3. Admin may proceed only to a watermarked draft; review-ready approval requires every non-bypassable authority, monitoring-coverage and reconciliation gate to pass. Human attestations may explain eligible residual gaps only after thresholds pass and cannot override a hard gate.
4. Report snapshot freezes fact IDs, narrative versions, `RequiredSeriesContract` versions, section schema and totals.
5. A network-free builder creates the canonical report-content projection, renders bytes, hashes the sorted render manifest, then derives the unsigned receipt-core hash and receipt ID without runtime metadata.
6. Human approval creates a separate verification envelope pinned to the exact frozen snapshot; the hashed artifacts contain no receipt/envelope ID or verification URL, so there is no self-hash cycle.
7. External submission occurs outside V1; admin may record date, destination and proof in that envelope.

The iteration-3 local foundation implements this ordering for the synthetic coverage projection: canonical content with immutable parameter/unit/time-zone series descriptors and report-safe coverage aggregates → HTML/CSV/JSON exact bytes → sorted render manifest → unsigned receipt core → deterministic frozen-draft core. A separate envelope pins one exact frozen snapshot before associating constrained human-review records, audit references, independently signed control-plane bundle hashes and proof of an action performed outside ReuseProof; same-receipt cross-snapshot records fail closed. It cannot mutate the receipt or claim destination receipt/acceptance. Output revalidation reconstructs exact outer and nested schemas, recomputes the retained full interval/outcome summaries from normalized inputs, derives the exported aggregate exactly, and checks fixed thresholds, aggregate membership, set hashes and render bytes. The projection never exposes interval rows, outcome rows, evaluation fingerprints or observation, nonoperation, lifecycle-event or lifecycle-evidence identifiers. Local bundle output uses fixed allowlisted filenames, exclusive file creation, file/directory sync and an atomic staged-directory rename. This is not the hosted report service, durable dual-region acknowledgement, complete quarterly/annual schema or authenticated workflow.

### 6.6 Public publication

1. Admin selects a frozen report snapshot.
2. Publication module applies a purpose-bound, threshold-signed allowlist, geographic generalization and aggregation rules.
3. Security/records/community review occurs in workflow.
4. Approved snapshot copies only public fields into a separate publication schema/bucket.
5. Public app reads only that schema/bucket, never private tenant tables.
6. Publication receipt records approvers, rules and content hash.

## 7. API surface

All private endpoints are under /api/v1, require tenant context, return a correlation ID and use idempotency keys for mutations.

### Program and registry

- GET /program
- POST /program/versions
- POST /program/authority-events
- POST /program/lifecycle-events
- GET /program/authority-preflight
- GET /program/termination-preflight
- GET /systems
- POST /systems/imports:dry-run
- POST /systems/imports
- GET /systems/{systemId}
- POST /systems/{systemId}/lifecycle-events
- POST /systems/{systemId}/state-board-orders
- GET /systems/{systemId}/state-board-order-preflight
- POST /systems/{systemId}/supplemental-source-approvals
- GET /systems/{systemId}/permit-preflight
- POST /systems/{systemId}/role-grants

### Evidence and ingestion

- POST /systems/{systemId}/evidence/uploads
- POST /evidence/{evidenceId}/metadata-versions
- GET /evidence/{evidenceId}
- POST /systems/{systemId}/ingestion-runs
- GET /ingestion-runs/{runId}
- POST /ingestion-runs/{runId}/replay
- GET /ingestion-runs/{runId}/quarantine
- POST /quarantine/{recordId}/resolution

### Measurements and review

- GET /systems/{systemId}/series
- GET /systems/{systemId}/measurements?from=&to=&parameter=
- GET /systems/{systemId}/daily-summaries
- GET /candidate-exceptions
- POST /candidate-exceptions/{id}/dispositions
- POST /systems/{systemId}/corrective-actions

### Events and field assurance

- POST /systems/{systemId}/complaints
- POST /systems/{systemId}/malfunctions
- POST /systems/{systemId}/inspections
- POST /systems/{systemId}/cross-connection-events
- POST /systems/{systemId}/backflow-tests
- POST /systems/{systemId}/notification-evidence
- GET /systems/{systemId}/notification-preflight?section={60604,60684,60694,60696,60706,60708,60710}
- POST /systems/{systemId}/restart-approval-evidence
- POST /systems/{systemId}/decommission-events

### Reporting and publication

- POST /reports/preflight
- GET /systems/{systemId}/required-series-contracts
- POST /systems/{systemId}/required-series-contracts/versions
- POST /reports
- GET /reports/{reportId}
- POST /reports/{reportId}/freeze
- POST /reports/{reportId}/submission-records
- GET /receipts/{receiptId}
- POST /publications/previews
- POST /publications/{id}/approvals
- GET /public/v1/jurisdictions/{slug}/reports

No endpoint accepts device commands, setpoints, alarm acknowledgements or control writes.

## 8. Contract schemas

Every adapter publishes a transport/source-mapping contract:

- contract ID/version and effective date;
- supported source schema/version;
- authentication method and allowed host/method/path;
- system binding method;
- field mappings and required/optional fields;
- timestamp/time-zone semantics;
- unit map and precision;
- missing/invalid/sentinel value behavior;
- deduplication key and pagination/watermark rules;
- source delivery cadence, which is informational and cannot set regulatory/reporting requiredness;
- sample golden and adversarial fixtures;
- vendor/operator approval record.

Contracts are JSON Schema plus human-readable documentation. A mapping change cannot mutate prior normalized facts; it produces a replay run and superseding facts if approved. It cannot create/delete required series, alter expected-interval math or change aggregate membership.

The iteration-5 local `csv-adapter-source-contract/v1` subset pins exact ordered columns, source-row requiredness, identity fields, tenant/system, adapter/mapping/source-schema versions, informational delivery cadence, review references and parser limits. `csv-ingestion-result/v1` hashes the exact byte source, rejects unsafe UTF-8/grammar/header/limit failures before row persistence and routes every syntactically safe data record exactly once. It is an in-memory parser/accounting boundary, not the planned object quarantine, scan, streaming worker, durable ingestion run or normalization SDK.

### Required-series contract

`RequiredSeriesContract` is a separate immutable, effective-dated JSON Schema contract approved before ingest. Activation is derived from the approved permit/report profile, system lifecycle and prescribed treatment train or approved alternative—not from vendor availability. It specifies the required series/statistic/unit, half-open effective range, approved cadence/time zone, eligible lifecycle states, scheduled-nonoperation evidence rule, aggregate source-set membership and criticality. A change creates a new prospective version; a governed retroactive correction forces a new evaluation rather than rewriting history.

Expected intervals tile the intersection of report and effective ranges. Exactly one final accepted, non-superseded observation counts per expected interval; duplicates, superseded, quarantined and rejected observations do not. An authorized scheduled-nonoperation interval removes only expected intervals wholly contained within it; unplanned and partial outages remain gaps. Zero expected intervals yields `not_applicable`, never 100%. Aggregate completeness uses the declared union of source/interval pairs, so a missing source cannot disappear from the denominator.

### Governed numeric aggregate contract

The synthetic `DailyNumericAggregate` boundary recomputes coverage and accepts numeric preimages for exactly its accepted winners. Each preimage repeats the observation ID, contract, timestamp and source fingerprint; all must match before conversion. A pinned `UnitConversionRule` supplies parameter/source/canonical-unit scope, authorization, half-open effective range, exact source offset and positive integer multiplier ratio. A pinned `DailyAggregatePolicy` supplies contract, method, precision, rounding, authorization and the same named IANA time zone as the required-series contract.

Conversion and sum/mean/minimum/maximum use exact rational arithmetic; only the final daily result is rounded. The aggregate binds hashes of the governing contract, recomputed coverage summary, complete conversion-rule set, policy and sorted numeric source set. It is not yet part of the report projection or receipt manifest and does not establish that a rule or policy is approved outside this synthetic boundary.

### Deterministic report and unsigned receipt contract

The reporting boundary is a one-way five-layer contract:

1. `ReportContentProjection` contains pinned report-safe content only; it excludes runtime IDs/times, receipt/envelope IDs, attestations, audit references and URLs. It is canonicalized using RFC 8785 semantics, schema-declared sort keys for order-independent arrays, omitted optional values/schema-declared nulls, canonical decimal strings with unit/scale, finite numbers only and UTC RFC 3339 timestamps with fixed milliseconds.
2. Deterministic render artifacts are produced only from that projection and its hash. Their exact bytes are hashed into a render manifest sorted by media type and logical filename.
3. `EvidenceManifest` binds source hashes and pinned versions, governing-contract/evaluation/summary set hashes, required-series versions and reconciled counts. `ReceiptCorePayload` binds that manifest, the report-content hash, render manifest and prior core hashes; canonicalizing it derives `receipt_id` as `rp1-` plus the lowercase hexadecimal core hash.
4. `FrozenReportCore` binds one exact receipt and render set to a positive report version and, after version 1, the actual immediately prior frozen-report snapshot. It remains an unsigned, non-submittable frozen draft.
5. `VerificationEnvelope` binds nondeterministic human, audit, supersession, external-submission and signed-control-plane associations to the exact frozen-report ID/hash/version and receipt.

Construction follows that order without skipping the freeze layer. The UI associates the envelope through database state/UI chrome or a sidecar, never a link embedded in hashed render bytes. Identical stable inputs and pinned build versions reproduce content, render, receipt and frozen-report hashes/IDs; human envelope content need not. Neither the receipt nor the frozen report is a signature or certificate.

### Signed control-plane trust contract

Three signing purposes are distinct from receipts: release-artifact manifests, adapter/disclosure allowlists and pipeline provenance attestations.

- Root trust consists of three offline Ed25519 hardware-held keys under separate Security, Release and Governance custodians. Any trust-policy generation, root/operational-key authorization or revocation requires 2-of-3 root signatures. Root private keys are never available to CI or the service.
- A root-authorized, hash-chained trust manifest names purpose, allowed role, operational public-key ID, exact workload identity/repository/workflow/environment, validity interval, policy generation and revocation sequence. Operational Ed25519 private keys are non-exportable KMS/HSM keys.
- A pipeline provenance statement requires one Release Engineering operational signature produced only by the named production-release workload identity and binds commit, workflow, repository, environment and artifact digest. An adapter or disclosure allowlist requires two operational signatures: Security and Data/Regulatory. A release-artifact manifest requires two: Release Engineering and Security. A signer/key from one purpose never satisfies another.
- Verification requires trusted current UTC. It fails closed when time is unknown or skew exceeds five minutes, when `issued_at` is in the future, or when current time is outside policy/key validity. A statement also binds the currently accepted policy generation and monotonic revocation sequence.
- Rotation publishes a new root-authorized generation with at least 14 days of overlap. Old and new operational keys are accepted only for statements issued in their own windows; the old key is rejected after cutoff. Revocation documents are hash-chained and monotonic; online verification requires a signed revocation view no older than 24 hours, and an offline bundle expires within 24 hours. A lower/replayed sequence fails.
- If KMS/HSM signing, trusted time or revocation freshness is unavailable, releases, production promotions and allowlist changes freeze. The read-only service may continue using the last fully verified configuration; it may not mint or promote new trusted artifacts.
- Suspected compromise disables the workload/key, publishes a root-authorized revocation and new policy generation, rotates credentials, rebuilds/re-signs unaffected artifacts, invalidates artifacts from the compromised window and preserves an incident/customer-notice audit. Root keys are not used as online recovery signers.

The verifier test suite must reject wrong purpose, role, signer, threshold, repository/workflow/environment, digest, policy generation, validity window, rotation cutoff, unknown/skewed time, stale/replayed revocation, unavailable trust service and compromised key.

## 9. Core data model

Key entities, all with tenant_id unless explicitly global:

- JurisdictionTenant, ProgramProfileVersion, RequirementProfileVersion, DisclosureProfileVersion
- ProgramAuthorityEvent, ProgramLifecycleEvent, ProgramTerminationPreflight, ProviderConsultation, AdverseImpactRecord, MitigationRecord
- Organization, OrganizationAuthorityRole, Person, RoleGrant, CertificationReference
- Site, Building, OtnwsSystem, SystemLifecycleEvent, StateBoardSystemOrder, TerminationOfOperationEvidence, RenderInoperableEvidence, SourceType, EndUse
- Permit, PermitVersion, PermitRescission, SupplementalSourceApproval, ExternalApproval, EvidenceObject, EvidenceLink, LegalHold
- Vendor, EquipmentModelReference, AdapterDefinition, AdapterCredentialReference
- IngestionRun, SourceObject, QuarantinedRecord, MappingVersion
- ParameterDefinition, RequiredSeriesContractVersion, MeasurementSeries, Measurement, DailyAggregate, CoverageSummary, ScheduledNonoperationEvidence
- CandidateException, ReviewDisposition, OfficialFindingReference, CorrectiveAction
- Complaint, Malfunction, Investigation, NotificationEvidence, NotificationRecipientEvidence, RestartApprovalEvidence, DecommissionNotice
- SiteInspection, HazardAssessment, VisualInspection, CrossConnectionTest, BackflowTest
- ReportProfileVersion, ReportDraft, ReportSnapshot, ReportFactLink, SubmissionRecord
- ReportContentProjection, EvidenceReceiptCore, ReceiptItem, VerificationEnvelope, PublicationSnapshot, PublicationApproval
- RootTrustManifest, SigningPolicyGeneration, OperationalSigningKey, SignedControlStatement, RevocationView
- AuditEvent, JobRun, SecurityEvent

Relational constraints:

- system belongs to exactly one tenant and site;
- role grant must intersect actor tenant and allowed system scope;
- measurement series binds one system, process, parameter and canonical unit;
- measurement identity is unique on tenant + source fingerprint + mapping version;
- required-series contract versions are immutable and pre-ingest; source mappings cannot mutate requiredness, cadence, effective range or aggregate membership;
- accepted coverage has at most one final non-superseded observation per required contract/expected interval;
- report fact cannot reference mutable draft data after freeze;
- a State Board system order cannot be fulfilled without termination-of-operation and render-inoperable evidence for its named system;
- local program termination cannot complete until hardship/comment evidence, every permit rescission and every installed-system render-inoperable record reconcile with the frozen program inventory;
- permit preflight cannot pass for a supplemental source without dated public-water-system and applicable recycled-water-supplier approval;
- public snapshot can reference only allowlisted fields from a frozen report;
- evidence classification controls object access independently from row access.

See [05-DATA-AND-EVIDENCE](05-DATA-AND-EVIDENCE.md) for ontology details.

## 10. Storage and scale

### PostgreSQL

- Normal relational tables for registry, evidence metadata, workflow and reports.
- Measurement table partitioned monthly by event_time, with tenant/system/series indexes.
- Daily aggregates stored separately with algorithm/profile version and coverage.
- RLS on every tenant table; application sets verified tenant/actor context in transaction.
- PITR, encrypted storage and automated vacuum/analyze monitoring.

Target calculation: 50 systems × 20 series × 288 five-minute intervals/day × 365 = **105.1 million measurements/year**. Load and cost tests use this conservative envelope. If pilot cadence/series exceed it or p95/report queries fail, evaluate TimescaleDB or a columnar analytics store through a new ADR.

### Object store

- Separate quarantine, private evidence, generated report and public publication buckets/prefixes.
- Server-side encryption with managed keys; per-environment keys.
- Versioning enabled; lifecycle rules follow tenant schedule.
- Accepted private evidence replicates cross-region within 15 minutes; upload acknowledgement is withheld until the primary version and durable replication-job record exist.
- Frozen report and receipt acknowledgement requires durable copies in both configured regions, yielding RPO 0 for acknowledged release artifacts.
- SHA-256 stored in database and receipt.
- Optional Object Lock only after records counsel approves retention/hold implications.
- Presigned access is short-lived, content-type/size limited and tenant/system scoped.

### Secrets

- Managed secret store; database contains opaque reference only.
- Separate credential per tenant/vendor/system where supported.
- Rotation and revocation tested.
- Never include token, endpoint query secret or raw response in logs.

## 11. Async jobs, errors and recovery

Job classes:

- object_scan
- adapter_pull
- parse_normalize
- aggregate_daily
- evaluate_candidate
- report_preflight
- render_report
- generate_receipt
- build_public_snapshot
- retention_export_delete

Each job has tenant context, idempotency key, attempt count, trace ID and dead-letter state. Retries apply only to transient failures. Schema/mapping/security failures stop and require human review.

Recovery rules:

- preserve source before parsing;
- never partially publish a report or public snapshot;
- database facts and job enqueue share a transaction;
- use staging tables then atomic merge for large ingestion;
- failed aggregate leaves prior approved aggregate intact and visibly stale;
- replay creates a new run; prior facts remain traceable;
- report regeneration pins all dependency versions;
- evidence hash mismatch is SEV-1 and freezes affected publication/report actions.

## 12. Security boundaries

1. Internet/public edge
2. Authenticated application
3. Tenant authorization/RLS
4. Evidence object authorization
5. Worker/job boundary
6. Vendor-cloud egress boundary
7. Publication-copy boundary
8. Observability/support boundary

Private application has no route to building OT. Vendor egress uses DNS/host allowlists, GET/read methods, constrained service identities and network monitoring. Public application has credentials for the public schema/bucket only.

## 13. Observability

Track without logging raw telemetry or sensitive documents:

- API availability/latency/error rate;
- job queue depth/age, retries and dead letters;
- source freshness and expected/received interval counts;
- normalized/quarantined/duplicate counts;
- aggregation duration and reconciliation status;
- report preflight gaps/render failures;
- RLS/object authorization denials;
- vendor scope/endpoint drift;
- public snapshot field counts and policy version;
- backup/PITR/restore status;
- cost by tenant/system/adapter.

Audit events are evidence, not debug logs. Debug logs have shorter retention and redaction.

## 14. Trade-offs

| Decision | Benefit | Cost/risk | Revisit trigger |
|---|---|---|---|
| Modular monolith | Fast delivery and transactional integrity | Requires disciplined boundaries | Independent scaling/team ownership |
| PostgreSQL measurements | Fewer systems and strong joins | Index/storage cost at high cadence | >100M/year with missed SLO or >20% DB cost |
| PostgreSQL job queue | One durable platform | Worker contention possible | Queue latency/SLO or workload isolation need |
| Source-first object storage | Reproducibility | Retention cost and records complexity | Approved summary-only retention policy |
| Customer-pushed CSV first | Lowest cyber/integration risk | More manual delivery | Stable read-only APIs and buyer demand |
| Frozen public copy | Strong isolation | Publication delay | Mature automated disclosure controls |
| Human dispositions | Avoids false legal automation | Review workload | Never automate legal meaning; improve prioritization only |

## 15. What grows later

- Additional vendor and permit-system read adapters
- Customer-specific report templates without branching core code
- Dedicated tenant database/deployment for higher-assurance buyers
- State submission integration only through an official supported interface
- Time-series/columnar storage after measured need
- Offline field inspection app
- Open-data API with formal re-identification/critical-infrastructure review
- Multi-state rule packs as separate governed products

Control systems, legal certification and treatment engineering are not architectural growth paths for this product.
