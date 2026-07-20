# Security, privacy and threat model

## 1. Security objective

ReuseProof CA must organize regulatory evidence without creating a route into water-treatment controls, leaking critical-infrastructure metadata, crossing tenant boundaries, corrupting evidence or overstating what the data proves.

Primary invariants:

1. no direct OT/SCADA/PLC/BMS connectivity;
2. no control-capable vendor credential or endpoint;
3. every private row/object is tenant and role scoped;
4. public delivery reads only approved frozen public copies;
5. source evidence is hashed/versioned and transformations are reproducible;
6. secrets and sensitive payloads never enter logs or analytics;
7. unknown or stale evidence cannot silently appear complete or passing.

Security baseline: NIST CSF 2.0-informed program, CISA Cross-Sector Cybersecurity Performance Goals, CISA/EPA/FBI water-sector top actions, OWASP ASVS for web controls and contract-specific municipal requirements.

## 2. Assets

### Highest sensitivity

- vendor API credentials and service identities;
- exact system addresses/coordinates and internal building/plumbing schematics;
- telemetry endpoints, network/topology information and detailed alarm/control patterns;
- unresolved cross-connection or backflow vulnerabilities;
- tenant encryption/configuration and authorization data;
- unredacted complaint narratives or personal contacts;
- source evidence and report facts used in official workflows.

### Operationally important

- program, requirement, mapping and report-profile versions;
- raw monitoring exports and normalized measurements;
- permit, commissioning and inspection evidence;
- candidate-exception dispositions and corrective actions;
- audit trail, receipts and public snapshots.

## 3. Trust boundaries

1. anonymous public internet → public application;
2. authenticated browser/API client → private application;
3. application identity → tenant/RLS authorization;
4. application → S3-compatible private evidence objects;
5. API process → async worker queue;
6. worker → vendor-cloud read API;
7. private report → publication approval → separate public schema/bucket;
8. product logs/metrics → support/observability tools;
9. ReuseProof environment → customer permit/DMS export;
10. building OT network: explicitly **outside and disconnected**.

## 4. Threat actors and misuse

- external attacker seeking infrastructure details or credentials;
- ransomware actor targeting municipal or water-related systems;
- compromised vendor account or API;
- malicious/overprivileged insider;
- user accidentally assigned to the wrong tenant/system;
- vendor attempting cross-customer access;
- scraper correlating public location/event data;
- bad source file designed for CSV formula injection, parser exhaustion, malware or path traversal;
- operator hiding or altering an event;
- unauthorized requester using public-record workflows to obtain sensitive personal/operational details;
- well-intentioned reviewer treating evidence completeness as compliance;
- product staff using production data in support, analytics or development;
- supply-chain compromise in dependencies or CI/CD.

## 5. STRIDE threats and controls

| Threat | Scenario | Prevent/detect controls |
|---|---|---|
| Spoofing | Attacker impersonates jurisdiction admin/vendor | SSO, phishing-resistant MFA for privileged roles, short sessions, scoped service accounts, conditional access |
| Tampering | Source/report changed after review | Object versioning/hash, frozen snapshots, append-only audit, deterministic unsigned receipt reproduction, purpose/threshold-signed control-plane release manifests |
| Repudiation | Reviewer denies disposition/publication | Actor/time/reason audit, SSO identity, attestation, correlation ID |
| Information disclosure | Cross-tenant query or public leak | PostgreSQL RLS, authorization library, separate public copy, object policies, negative tests, DLP/log redaction |
| Denial of service | Huge/malformed CSV or API flood | Size/row/time limits, streaming parser, queue quotas, per-tenant rate limits, circuit breakers |
| Elevation of privilege | Vendor gains portfolio/admin access | System-scoped grants, deny-by-default roles, just-in-time support, quarterly access review |
| Control-system pivot | Cloud credential reaches SCADA/controller | No OT route, read-only vendor-cloud scopes, egress allowlist, GET-only contract, scope-drift kill switch |
| Evidence poisoning | Wrong units/timestamps/system mapping | Mapping approval, quarantine, source preservation, reconciliation and human review |
| Public inference | Exact location plus anomaly reveals weakness | Geographic generalization, aggregation, disclosure review, delay/takedown, no raw telemetry |

## 6. Read-only and OT separation controls

### Contractual

- Data source must be customer-pushed file/object or public vendor-cloud API.
- Vendor attests credential contains no command, configuration, alarm acknowledgement, setpoint, firmware or administrative scope.
- Customer does not provide OT VPN, controller credentials, jump-host access or on-prem agent placement.
- ReuseProof is not part of the operator's alarm or emergency-response plan.

### Technical

- Adapter contract allowlists scheme, host, path pattern and GET/read methods.
- Network policy denies all other adapter egress.
- Credential scope snapshot captured at onboarding and checked at least quarterly where API permits.
- Static scan blocks control-related method/interface imports in adapter packages.
- Dynamic tests fail if adapter attempts POST/PUT/PATCH/DELETE to vendor endpoints.
- No inbound network route from building/site.
- Credentials stored in managed secret service; one tenant/system boundary where possible.
- Scope drift, redirect to unapproved host or unexpected command capability disables adapter.

### Operational

- Security reviewer signs each source.
- Quarterly credential/access review and immediate revocation on contract end.
- Adapter incidents never instruct treatment changes.
- Customer's onsite alarm and operator process remains authoritative.

## 7. Tenant and object isolation

- tenant_id is mandatory and immutable on every private domain row;
- PostgreSQL RLS is enabled and forced for application roles;
- application opens transaction only after verified tenant/actor context;
- repository methods cannot accept arbitrary tenant ID from client payload;
- system-scoped grants join actor, tenant and named systems;
- vendor cross-tenant access requires separate explicit grants and sessions;
- background jobs carry signed tenant/system context and reauthorize on execution;
- S3 object keys are opaque and tenant/system prefixed;
- presigned URLs are short-lived, content-limited and generated after row authorization;
- support impersonation is disabled; time-bound audited elevation requires customer approval except emergency containment;
- analytics use de-identified operational metrics, not source payloads.

Release requires exhaustive negative authorization tests and a cross-tenant penetration scenario.

## 8. Critical-infrastructure metadata controls

Treat the following as critical-infrastructure private by default:

- exact system location, coordinates and access information;
- piping, cross-connection, backflow and equipment-room diagrams;
- asset serials if they enable vendor account discovery;
- telemetry endpoint, polling cadence, credential metadata and topology;
- detailed alarms, diversion logic, critical limits and failure patterns tied to a named site;
- unresolved cross-connection, backflow, security or treatment vulnerabilities;
- staff schedules and emergency contact details.

Controls:

- separate classification and role checks;
- field-level redaction in exports;
- no values in URLs, logs, support tickets or product analytics;
- public-view aggregation/generalization and frozen-copy boundary;
- human-approved, versioned disclosure profile and two-person approval for first publication/change;
- public correction/takedown procedure;
- public-records export workspace controlled by jurisdiction records staff;
- no assertion that vendor confidentiality or product classification creates a CPRA exemption.

## 9. File, API and ingestion security

- allowlist file types; validate magic bytes, not extension alone;
- 100 MB/100k-row pilot default, configurable after load test;
- stream parse with CPU/memory/time limits;
- malware scan and archive-bomb protection;
- neutralize spreadsheet formulas in generated CSV;
- reject path traversal, external entity expansion and embedded active content;
- source object lands in quarantine before any parsing;
- API response size/page caps, TLS validation, redirect denial and rate limiting;
- retry only safe idempotent reads;
- schema drift quarantines rather than guessing;
- poison files/jobs move to dead letter with restricted access;
- development/test use synthetic or contract-approved redacted fixtures.

The iteration-5 local parser adds fatal UTF-8 decoding, exact ordered headers, deterministic CSV grammar and immutable ceilings of 10 MiB, 100,000 data records, 256 columns and 64 KiB per field; contracts may only lower those ceilings. It rejects an unsafe source before returning partial rows and retains only source hashes/locators for duplicate or quarantined rows. It does not implement the quarantine object store, magic-byte/malware/archive scan, streaming CPU/time controls or the planned hosted 100 MB envelope, so those controls remain release work.

## 10. Identity, access and secrets

- SAML/OIDC municipal SSO; MFA required for admin/reviewer/support;
- no shared accounts; service identities named by integration;
- least-privilege roles and system scopes;
- joiner/mover/leaver process and quarterly access recertification;
- SCIM when required, manual dual-control fallback in pilot;
- break-glass access protected by phishing-resistant MFA, time limit, reason and alert;
- managed secret store, automatic rotation where supported and no secret export;
- separate environments/accounts/keys; production access just-in-time;
- session inactivity/maximum limits configured with jurisdiction.

## 11. Secure development and supply chain

- protected main branch, two-person review for auth/RLS/adapter/publication changes;
- signed commits/build provenance where platform supports;
- locked dependencies, automated SCA and secret scanning;
- SAST, IaC scanning, container scanning and SBOM per release;
- migration review and rollback;
- synthetic test data by default;
- quarterly dependency patch objective; critical exploited issue expedited;
- annual independent penetration test and pre-pilot focused assessment;
- restore, tenant-isolation and public-copy tests in CI/staging;
- release artifacts pinned and checksummed.

### Signing trust and verification

Signing protects the release/control plane; it does not make an evidence receipt a signature or certificate.

- Three offline hardware-held Ed25519 roots are separately held by Security, Release and Governance. A 2-of-3 root threshold authorizes every purpose/role trust-manifest generation, operational key, rotation and revocation; no root private key is present in CI, KMS service workloads or the application.
- Non-exportable KMS/HSM Ed25519 keys are bound to exact workload identities. Pipeline provenance requires one Release Engineering key/workload signature and binds repository, workflow, environment, commit and artifact digest. Adapter/disclosure allowlists require both Security and Data/Regulatory signatures. Release-artifact manifests require both Release Engineering and Security signatures. Cross-purpose keys and roles never count toward a threshold.
- Every statement binds purpose, artifact/config digest, signer key ID, workload identity, `issued_at`, policy generation/hash and monotonic revocation sequence. Verifiers use trusted current UTC, allow at most five minutes of clock skew and fail if current time is unknown or outside the policy/key validity interval.
- Key rotation has at least 14 days of signed overlap and a hard old-key cutoff. Signed, hash-chained revocation views only advance; online data must be no older than 24 hours and offline bundles expire within 24 hours. Stale, missing, lower-sequence or replayed revocation data fails closed.
- Loss of KMS/HSM signing, trusted time or fresh revocation state freezes releases, promotions and allowlist changes. Existing read-only production may use only its last verified configuration.
- Compromise response disables the key and workload, uses 2-of-3 offline roots to revoke and authorize a new generation, rebuilds/re-signs unaffected artifacts, invalidates the compromised window and preserves customer-notice/audit evidence. Roots are never brought online as emergency signers.

Negative verification tests cover wrong purpose/role/signer/threshold, repo/workflow/environment/digest substitution, expired/not-yet-valid keys, unknown/skewed time, stale/replayed revocation, rotation cutoff, policy-generation rollback, signing outage and compromised keys.

## 12. Privacy impact

### People affected

- building tenants/residents;
- complainants;
- operators, reviewers, engineers and vendor staff;
- responsible-entity contacts;
- members of the public using published information.

### Main privacy risks

- complaint narrative identifies a resident or health concern;
- public location plus event reveals residence or vulnerability;
- personnel schedules enable targeting;
- support/export includes unnecessary personal data;
- long telemetry retention creates behavioral or occupancy inference;
- public-record request surprises users who assumed “private” meant legally exempt.

### Controls

- collect person data only for defined program purpose;
- separate complainant identity from event/report summary;
- role/field minimization and no ad-tech analytics;
- retention by approved schedule; legal hold visible;
- clear notices and data inventory;
- aggregate public view and re-identification review;
- full tenant export/correction workflow;
- contract names controller/processor roles and breach terms;
- records staff, not product, decides disclosure.

## 13. Logging and audit

Security/audit log includes:

- authentication/authorization events;
- role and disclosure-profile changes;
- object upload/access/delete/hold;
- credential reference changes and scope-check result;
- ingestion/mapping/replay;
- candidate/official disposition;
- report freeze/submission record;
- public preview/approval/publish/takedown;
- support elevation and export.

Exclude:

- credentials/tokens;
- full source rows or complaint narratives;
- exact infrastructure coordinates/diagrams;
- full API payloads;
- raw personal identifiers unless an audit purpose requires a separately protected reference.

Audit retention follows contract; debug/observability retention is shorter.

## 14. Incident response

### SEV-1

Cross-tenant access; restricted public disclosure; credential/OT-boundary compromise; evidence tampering/hash mismatch; ransomware or material production breach.

Actions:

1. contain access/publication/adapter immediately;
2. preserve evidence and rotate/revoke credentials;
3. notify customer security contacts per contract;
4. determine whether any vendor/cloud account or operational system is affected;
5. never access OT to investigate;
6. provide timeline, affected objects/tenants and corrective plan;
7. require governance approval before re-enable.

### SEV-2

Incorrect report aggregate, corrupted mapping, inaccessible critical workflow, material ingestion loss, or missed deadline risk.

Freeze affected report/publication, preserve versions, reconcile, issue corrected receipt and customer notice.

### SEV-3

Isolated delay or noncritical defect. Normal support and problem management.

If a user reports a possible water-safety emergency, direct them to the approved operator/jurisdiction emergency process; ReuseProof support does not diagnose or direct treatment.

## 15. Verification before pilot/release

- [ ] Architecture threat-model review with municipal and water-sector cybersecurity reviewer
- [ ] No OT route documented in data-flow and network tests
- [ ] Adapter scope/method/egress verification for all three formats
- [ ] RLS/object negative test suite and cross-tenant penetration test
- [ ] Public-copy leakage and re-identification review
- [ ] Secret/log/DLP scan
- [ ] Malware/archive/parser abuse tests
- [ ] Dependency/SBOM/SAST/IaC scan
- [ ] Backup/PITR/object recovery exercise
- [ ] Incident tabletop: vendor credential leak, public detail leak, wrong annual aggregate
- [ ] Access recertification and exit revocation drill
- [ ] No open critical/high finding at release

## 16. Known residual risks

- A vendor may inaccurately characterize API scope.
- Public-record law may require disclosure despite product classification.
- Aggregated data may permit inference in a jurisdiction with very few systems.
- A correct transformation can still reflect an inaccurate sensor or source.
- A read-only cloud account may expose more vendor data than intended.
- Users may treat completeness or candidate-exception status as a compliance verdict.
- Municipal procurement may require controls beyond V1 resources.

Residual risks are shown in contracts, training and the release decision; they are not hidden by a “secure” claim.
