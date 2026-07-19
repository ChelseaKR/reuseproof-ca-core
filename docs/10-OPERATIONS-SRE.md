# Operations and SRE plan

## 1. Service model

V1 is a managed multi-tenant SaaS with:

- separate production, staging, test and development environments;
- web/API service and asynchronous worker deployment;
- managed PostgreSQL, S3-compatible objects, identity broker and secret manager;
- business-hours implementation/support, with 24×7 automated security monitoring and SEV-1 escalation;
- no operational-water on-call, process alarm monitoring or equipment control.

The customer remains responsible for onsite alarms, operator response, required notifications and regulatory deadlines. Product freshness indicators are evidence-workflow signals, not public-health alarms.

## 2. Service level indicators and objectives

| SLI | Measurement | V1 SLO |
|---|---|---:|
| Authenticated availability | Successful eligible UI/API requests | 99.9% monthly |
| Common read latency | p95 system/dashboard/report-read API | <2 seconds |
| Upload acceptance | Presigned upload→ingestion-run created | 99% <60 seconds |
| Supported ingestion completion | ≤100k valid rows at target load | 95% <15 minutes; 99% <60 minutes |
| Queue age | Oldest ready job | 99% <15 minutes outside vendor outage |
| Report generation | Preflight + 50-system draft | 95% <5 minutes |
| Receipt generation | Frozen artifact→receipt | 99% <2 minutes |
| Provenance coverage | Quantitative report facts with full lineage | 100% |
| Public snapshot isolation | Restricted fields served publicly | 0 |
| Database recovery | Point-in-time recovery | RPO ≤15 minutes; RTO ≤8 hours |
| Accepted evidence-object recovery | Versioned cross-region object + metadata relationship | RPO ≤15 minutes; RTO ≤8 hours |
| Frozen release-artifact recovery | Acknowledged report/receipt objects | RPO 0; RTO ≤8 hours |
| Evidence integrity | Object hash checks | 100% verified on receipt/recovery |

Source freshness is reported against the source contract but has no safety SLO. Vendor outages and customer delivery delays are identified separately from ReuseProof availability.

## 3. Run lifecycle

### Scheduled/API pull

1. scheduler enqueues tenant/system/adapter job;
2. worker reauthorizes scope and checks circuit breaker;
3. pull writes source object;
4. parser/normalizer writes accepted/quarantined counts;
5. aggregate and candidate-evaluation jobs run;
6. receipt generated;
7. freshness/coverage status updated.

### File delivery

1. upload URL issued and expires;
2. object quarantined/scanned;
3. ingestion job streams data;
4. invalid records quarantine with row locators;
5. authorized user receives workflow notification;
6. safe replay after mapping/data correction.

### Report

1. preflight enforces non-bypassable authority, monitoring-coverage, statutory-recipient and lifecycle-completeness gates;
2. deterministic snapshot;
3. render formats;
4. hash/receipt;
5. human freeze/approval;
6. optional external submission record;
7. deliberate public-copy workflow.

## 4. Alerting

### Page/escalate immediately

- suspected cross-tenant access;
- restricted public disclosure;
- credential or read-only/OT-boundary compromise;
- source/evidence hash mismatch;
- production authentication outage;
- widespread data corruption/ransomware indicator.

### Business-hours urgent

- wrong report aggregate or mapping;
- report generation unavailable within 10 business days of known deadline;
- repeated ingestion failure/queue age >60 minutes;
- backup/PITR failure;
- inaccessible critical workflow;
- vendor scope/schema drift disabling a source.

### Ticket/digest

- normal quarantine/data gap;
- source freshness delay attributable to vendor/customer;
- upcoming evidence due date;
- noncritical UI/documentation issue.

Do not page product staff for treatment excursions or equipment alarms. The product is not subscribed to or responsible for them.

## 5. Required runbooks

| ID | Runbook | Key outcome |
|---|---|---|
| RB-01 | Cross-tenant access suspected | Contain sessions/data, preserve logs, notify tenants |
| RB-02 | Restricted public snapshot | Takedown atomically, identify fields/consumers, correction |
| RB-03 | Vendor credential leak/scope drift | Disable adapter, revoke/rotate, confirm no OT/control impact |
| RB-04 | Evidence hash mismatch | Freeze affected reports/publication, restore/forensics |
| RB-05 | Wrong adapter mapping | Stop source, dry replay, approve new mapping, supersede outputs |
| RB-06 | Stuck/poison ingestion | Quarantine, isolate job, safe retry without duplicate facts |
| RB-07 | Vendor API outage/rate limit | Circuit break/backoff, distinguish source delay |
| RB-08 | Report discrepancy | Freeze, reconcile source/facts/profile, issue corrected receipt |
| RB-09 | Database PITR | Restore isolated, integrity/RLS/receipt checks, controlled cutover |
| RB-10 | Object recovery | Restore version, verify hash/metadata/linkage |
| RB-11 | Identity provider outage | Deny privileged changes; documented recovery; no unsafe local fallback |
| RB-12 | Accessibility blocker | Provide equivalent assisted service while remediating primary flow |
| RB-13 | Customer exit/legal hold | Export, validate, revoke, delete/retain with certificate |
| RB-14 | Regulatory/profile change | Impact analysis, report diff, approval and controlled rollout |
| RB-15 | Urgent water-safety message to support | Route to customer emergency contact; no diagnosis/control advice |
| RB-16 | Signing/trust outage or stale revocation | Freeze releases/promotions/allowlist changes; retain last verified read-only configuration |
| RB-17 | Signing-key/workload compromise | Disable, root-authorized revoke/rotate, invalidate affected window, rebuild/re-sign and notify |
| RB-18 | Receipt reproduction mismatch | Freeze affected output; compare projection/render/core bytes without mutating the human envelope |

Runbooks name incident commander, customer contacts, evidence to preserve, communications templates, recovery validation and post-incident review.

## 6. Backup and disaster recovery

### Database

- automated encrypted backups and PITR with ≤15-minute target;
- cross-zone high availability;
- monthly restore test in isolated environment;
- quarterly full recovery exercise including RLS/auth checks;
- migrations and configuration stored/versioned separately.

### Objects

- versioning enabled;
- cross-region replication target ≤15 minutes for accepted evidence objects;
- frozen report/receipt acknowledgement only after durable copies exist in both configured regions;
- lifecycle/retention protected from application admin;
- quarterly sampled restore/hash verification;
- pre-pilot and pre-release production-scale deletion/tamper recovery drill, including object/database relationship restoration and 100% hash verification for the selected report corpus;
- Object Lock only after records/legal approval.

### Config/secrets and trust

- infrastructure as code and purpose/threshold-signed deployment manifests;
- secret references backed up through approved provider process, not exported in plaintext;
- adapter mappings/profiles versioned and exportable.
- three offline hardware-held Ed25519 roots under Security/Release/Governance require 2-of-3 authorization for trust generations and revocation; operational Ed25519 keys remain non-exportable in KMS/HSM;
- pipeline provenance requires the named Release Engineering workload signature; adapter/disclosure allowlists require Security plus Data/Regulatory; release-artifact manifests require Release Engineering plus Security;
- trusted time and monotonic/hash-chained revocation state are monitored; clock uncertainty/skew over five minutes or revocation freshness over 24 hours freezes signing/promotion/config changes;
- rotations provide at least 14 days of signed overlap and enforce the old-key cutoff; no root private key is restored into an online system.

### Recovery acceptance

- source objects and database relationships reconcile;
- known object-loss window is ≤15 minutes for accepted evidence and zero for acknowledged frozen report/receipt objects;
- tenant/public isolation tests pass;
- a frozen report and receipt reproduce;
- no jobs replay twice or publish automatically;
- customer receives RPO/RTO and known-loss window.

## 7. Change management

Change classes:

- standard low-risk application change;
- adapter/mapping change;
- regulatory/report-profile change;
- security/authorization/publication change;
- infrastructure/data migration;
- emergency disable/withdrawal.

Controls:

- peer review and CI;
- staging fixture/report diff;
- database migration dry run/rollback;
- two-person review for RLS, adapters, report schema, claims and publication;
- customer notice for material report/mapping change;
- canary tenant/system where contract allows;
- feature flags cannot bypass safety/authorization;
- emergency disable preserves audit/tombstone.

No production hotfix may add a control endpoint or automated legal state.

## 8. Capacity and cost

Initial capacity target:

- 5 jurisdictions;
- 50 total systems;
- 20 five-minute series/system;
- approximately 105 million measurements/year;
- 100k-row uploads and 30-day backfills;
- 20 concurrent authenticated staff per tenant;
- annual report across 50 systems.

Track monthly:

- database storage/index/IO by tenant;
- object raw/archive/generated storage;
- worker CPU/memory/time per million rows;
- API/vendor egress and call volume;
- report-render cost;
- observability/log volume;
- support and mapping hours/system.

Revisit storage architecture if:

- p95 target fails after indexing/partition tuning;
- DB cost exceeds 20% of recurring revenue;
- raw volume exceeds 200 million measurements/year;
- report queries materially affect ingestion;
- a customer requires sub-minute streaming, which is outside V1.

## 9. Deadline operations

- Program calendar records February 1 annual deadline and configured quarterly dates.
- 120/90/60/30/14/7-day workflow reminders go to authorized users.
- Product displays source gaps and draft status; it does not guarantee submission.
- Capacity/load test runs at least 60 days before expected report peak.
- Change freeze begins 14 days before deadline except security/correctness fixes.
- Extension request workflow stores written request evidence; it never assumes approval.
- External submission proof is recorded manually in V1.

## 10. Operational readiness review

Before pilot and again before V1 release:

- [ ] Production ownership/on-call/escalation contacts named
- [ ] Service map and dependencies documented
- [ ] SLO dashboards and error budgets operating
- [ ] All required runbooks tested or table-topped
- [ ] Backup/PITR/object restore and receipt reproduction pass
- [ ] Canonical content/render/receipt-core hashes reproduce; human verification envelope remains separate and receipt remains explicitly unsigned
- [ ] Root/operational signer inventory, purpose thresholds, trusted time, rotation cutoff and ≤24-hour revocation freshness verify
- [ ] Negative signer tests and signing-outage/compromise runbooks pass; promotion freezes closed
- [ ] Read-only/egress/scope monitors pass
- [ ] Tenant/public negative tests pass in production-like environment
- [ ] Capacity and report-peak tests pass
- [ ] Vendor rate limits/outage behavior confirmed
- [ ] Security/accessibility/customer support handoffs confirmed
- [ ] Deadline calendar and communications tested
- [ ] Exit/export/revocation drill passes
- [ ] No open critical/high security, correctness or critical accessibility issue
