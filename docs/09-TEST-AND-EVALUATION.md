# Test and evaluation strategy

## 1. Quality claim

V1 may claim only:

> For the named supported source contracts, periods and versions, ReuseProof CA reproducibly preserves source evidence, normalizes configured fields, exposes data-quality gaps, supports authorized human review and generates traceable draft artifacts without control-system write access.

Tests do not prove water safety, legal compliance, engineering adequacy, laboratory accuracy or correctness of an upstream sensor.

## 2. Test layers

| Layer | Focus | Target |
|---|---|---|
| Static/type | Contract exhaustiveness, unsafe imports, secret patterns | All builds |
| Unit/property | Units, time, statistics, identities, status transitions | ≥90% branch on critical domain; ≥80% overall domain |
| Component | Accessible UI states and permissions | All critical components |
| Database | Constraints, migrations, RLS, partitioning | Every migration |
| Adapter contract | Parser, mapping, idempotency, pagination, scope | Every supported format/version |
| Integration | Object→job→facts→aggregate→report→receipt | All P0 vertical slices |
| API | Auth, validation, idempotency, errors, OpenAPI | Every endpoint |
| E2E | Critical user journeys | Release and nightly subset |
| Security | Threat controls, tenant/object/public boundaries | CI + independent pre-release |
| Accessibility | Automated and manual AT | Every release |
| Performance/resilience | Target scale, queue, failover, restore | Before pilot/release |
| Human evaluation | Workflow correctness and semantic understanding | Research/pilot/release |

Framework code and trivial accessors need not be unit-tested; business invariants, errors and security boundaries do.

## 3. Requirement traceability

Every P0 AC has:

- at least one automated test where feasible;
- manual evidence for professional/legal/accessibility judgments;
- linked backlog item and risk;
- owner and most recent passing release.

Minimum trace examples:

| Requirement | Tests | Gate |
|---|---|---|
| FR-04 read-only adapters | T-ADP-001…020, T-SEC-RO-001…010 | G-02/G-04 |
| FR-05 provenance | T-DATA-LIN-001…012 | G-03/G-04 |
| FR-06 aggregation | T-AGG-001…030 | G-03 |
| FR-08 human disposition | T-REV-001…012 | G-03 |
| FR-12 annual draft distinction | T-RPT-ANN-001…015 | G-03/G-04 |
| FR-14 public/private | T-PUB-001…020, T-SEC-TEN-001…030 | G-04 |
| FR-17 safety boundary | T-SEC-RO suite + architecture inspection | Every gate |

The release checklist links the full matrix. A passing UI demo without trace evidence is insufficient.

## 4. Golden and adversarial fixtures

Maintain version-controlled synthetic/redacted fixture packs for:

### Adapter sources

- three real vendor contract shapes;
- CSV with BOM, quoted commas/newlines, reordered columns and extra columns;
- 23-hour and 25-hour DST days;
- UTC, offset and local timestamps;
- duplicate pages/files and overlapping backfill;
- out-of-order and late records;
- missing interval, null, NaN, sentinel -999, comma decimal and scientific notation;
- °F/°C, gpm/gpd, percent/fraction and unit-label mismatch;
- schema drift and unknown parameter;
- wrong system ID or series binding;
- huge row, zip bomb, malware marker and CSV formula injection;
- API rate limit, timeout, partial pagination, expired token and redirect to unapproved host.

The iteration-5 automated subset covers strict CSV contract reconstruction, hard byte/record/column/field ceilings, fatal UTF-8, BOM, LF/CRLF, quoted comma/newline/quote handling, malformed grammar, exact header drift rejection, stable row/line locators, source-local duplicate identity, all typed row quarantines, exact accounting and byte-for-byte replay hashes. It does not satisfy the real-format, streaming 100k-row, malware/archive, durable idempotency, normalization or accepted-yield gates above.

### Regulatory workflows

- existing, new, replacement and permanently retired systems;
- multiple source/end-use combinations;
- complaints with/without personal identity;
- malfunction with open/closed corrective action;
- inspection, annual visual inspection, four-year/triggered test and backflow report;
- official human-entered violation and corrective action;
- no violation, missing official determination and disputed mapping;
- final-60606 schema kept distinct from Water Code monitoring-data states, with authority/schema/status shown;
- program adoption/amendment/repeal with provider consultation, adverse-impact opportunity and mitigation/not-applicable evidence;
- system-scoped State Board order with separate termination-of-operation and render-inoperable evidence, plus program-scoped local termination with hardship, comment, every-permit rescission and every-installed-system render-inoperable evidence;
- multifamily/townhouse, excluded-commercial-use, community-sewer-only, untreated-system exclusion, limited-end-use and surface-irrigation applicability boundaries;
- public-water-system, sewer-provider, recycled-water-supplier/agency, local-jurisdiction and State Board consultation/approval/delivery/notice roles, including typed supplemental-source approval before permit issuance;
- 60604 multi-parcel county-recorded covenant proof; 60684 commissioning-report delivery within 30 days to the jurisdiction for review/approval and to every named service/agency recipient; 60694 pre-indoor-supply tenant/resident information and responsible-entity plumbing-approval documentation; 60694 phone **and** email inadequate-treatment jurisdiction notice plus written indoor tenant/resident notice within 24 hours;
- 60696 pre-notice with all four work/timeline content categories and both notice windows/recipient sets; 60706 certified-specialist reports to jurisdiction and public water system within 30 days; 60708 completed backflow/air-gap report to jurisdiction within 30 days;
- 60710 notice within 24 hours to jurisdiction, public water system and tenants/residents plus independent evidence for cease delivery/drain riser, potable shutdown at service connection, uncover/disconnect, repeat inspection/test, 50 mg/L chlorination for 24 hours, flush and acceptable bacteriological test, cause investigation/correction/report and local approval before restart;
- final-60606 section plus Water Code monitoring-data states `configured`, `authority_pending` and `review_blocked`;
- extension requested, granted externally, denied and unknown.

Fixtures contain no live credentials or unapproved infrastructure details.

## 5. Domain and property tests

### Units and numeric integrity

- round-trip raw display;
- exact conversion formulas;
- decimal precision;
- incompatible units quarantine;
- aggregation independent of input row order;
- min ≤ max and percentile bounded by observed range where mathematically applicable.

### Time

- daily bucket follows tenant/site zone;
- DST expected counts;
- leap day/year;
- ambiguous/nonexistent local times;
- late-arrival superseding aggregate;
- source clock drift classification.

### Idempotency and lineage

- duplicate file/API page creates no duplicate facts;
- replay with same versions yields same facts/receipt;
- mapping upgrade creates new version and diff;
- source hash mismatch halts;
- frozen report never follows “latest.”

### Required-series coverage

- expected intervals exactly tile the half-open intersection of report/effective ranges at approved cadence, including 23/25-hour DST days;
- activation follows approved permit/profile, lifecycle and prescribed treatment train or approved alternative, never vendor mapping presence;
- scheduled nonoperation removes only wholly contained intervals when evidence predates them; unplanned and partial outages remain expected gaps;
- exactly one final accepted, non-superseded observation counts per expected interval; duplicate, extra, quarantined, rejected and superseded values never increase coverage;
- no observations yields typed gaps; a zero denominator yields `not_applicable`, never 100%; late acceptance creates a superseding result;
- immutable pre-ingest contract versions reject in-place/backdated edits; governed correction creates a version and reruns affected periods;
- aggregate source-set tests remove each constituent in turn and prove the missing source/interval pairs stay in the denominator;
- mappings may change transport/fields but cannot create/delete required contracts, cadence, effective ranges or aggregate membership.

### State machines

- candidate exception cannot become official violation automatically;
- corrective action cannot close without evidence/rationale;
- report can be draft/frozen/superseded/submission-recorded but product never marks accepted by State absent external evidence;
- public snapshot cannot publish before required approvals.
- annual draft cannot become review-ready while authority is pending/blocked or report-critical coverage is below threshold;
- permit preflight cannot pass for a potable/recycled supplemental source without public-water-system and applicable recycled-water-supplier approvals dated before permit issuance;
- 60604, 60684, 60694, 60696, 60706, 60708 and 60710 evidence workflows cannot complete while the obligated actor is absent/mismatched or any required recipient, action, method, content item or deadline row is missing;
- attestation cannot override authority, termination-completeness, required-recipient or monitoring-coverage hard gates;
- a State Board system order cannot be fulfilled without named-system termination-of-operation and render-inoperable evidence;
- local program termination cannot complete until hardship/comment, every-permit rescission and every-installed-system render-inoperable evidence reconcile with the program inventory;
- a program/system lifecycle state cannot execute or imply execution of shutdown, restart, rescission or termination.

## 6. Safety invariant tests

### T-SEC-RO — Read-only invariant

- adapter interface exposes read/fetch only;
- network mock fails POST/PUT/PATCH/DELETE;
- egress to non-allowlisted host fails;
- redirect and scope expansion disable source;
- static scan finds no SCADA/PLC/control/setpoint/alarm-ack APIs;
- credential fixture with write scope is rejected;
- deployment network has no route to pilot OT network.

### T-SEM — Claim/semantic invariant

- automated statuses never label compliant/noncompliant/safe/unsafe/violation;
- missing threshold yields “not evaluated”;
- stale/missing data cannot display green/pass;
- official finding requires authorized human, authority reference and audit.

### T-PUB — Public boundary

- only frozen public schema/bucket accessible anonymously;
- denylist seeded with precise coordinates, diagrams, endpoints, contacts and restricted narrative;
- aggregation/generalization tests include one-system re-identification case;
- superseded/taken-down snapshot no longer serves while tombstone/correction remains.

### T-TEN — Tenant isolation

- every table, endpoint, search, job, export, presigned URL and receipt tested cross-tenant;
- vendor with grants in two tenants cannot combine results;
- guessed IDs and stale URLs denied;
- support role cannot access without approved elevation.

## 7. Adapter evaluation

For each vendor format:

1. Contract/schema review and read-scope evidence.
2. Golden fixture mapping approved by vendor/operator and jurisdiction/CA engineer.
3. Adversarial fixture suite.
4. 100k-row load and streaming memory test.
5. Idempotent overlap/backfill test.
6. Source-to-normalized sample reconciliation of at least 100 stratified rows.
7. Daily aggregate reconciliation for at least seven days.
8. Scope/endpoint drift simulation.
9. Error/quarantine usability test.
10. Human-attested adapter acceptance receipt.

Pass thresholds are independent and non-waivable: 100% deterministic routing/accounting with zero silent drops; ≥95% of syntactically valid in-contract rows normalize into accepted facts after remediation; 0% unexplained quarantine and ≤5% total quarantine; zero unexplained value differences; zero write capability. A high quarantine rate cannot pass by being well labeled or attested.

## 8. Report and receipt evaluation

### Quarterly packet

- every final section 60688 element present or explicit gap;
- daily values match approved manual controls;
- anomalies/complaints/residual results link to sources;
- page/export watermark and human-review disclaimer.

### Annual draft

- system lifecycle categories reconcile to registry/permits;
- source/end-use volumes reconcile and disclose coverage;
- only authorized official violations appear;
- complaints/malfunctions/investigations/resolutions aggregate correctly;
- inspection counts/summary reconcile;
- monitoring min/max absent from default final-60606 section;
- Water Code monitoring-data section is always distinct, requires authority/schema/status, and blocks review-ready for `authority_pending`, `review_blocked` or sub-threshold coverage;
- February 1 period and extension record logic tested;
- accessible HTML/PDF/CSV/JSON outputs.

### Receipt

- RFC 8785 canonical projection covers object-key ordering, every schema-declared array order, omitted optional versus retained schema-null values, valid non-normalized Unicode, canonical decimal strings/unit/scale, rejection of NaN/Infinity/negative zero and fixed-millisecond UTC timestamps;
- report-content projection excludes runtime/report/receipt/envelope IDs, creation/request/job times, attestations, audit references and URLs;
- render artifacts contain the content hash but no receipt/envelope ID or verification URL; exact HTML/PDF/CSV/JSON bytes and sorted media-type/logical-name manifest hash correctly;
- receipt core excludes runtime receipt ID, creation time, attestations, audit/signature references and URLs; `receipt_id` is `rp1-` plus lowercase SHA-256 core hex and is never hashed as an input;
- mapping/profile/version coverage complete;
- gaps/quarantines included;
- human attestations, audit references and runtime creation time live only in a separate verification envelope associated after rendering;
- identical pinned inputs reproduce content/render/core hashes and ID byte-for-byte while two valid human envelopes may differ;
- reproduction after backup restore; receipt text remains “evidence assembled” and explicitly unsigned/not a certificate.

The iteration-3 automated foundation exercises the synthetic subset above, including content/render/core separation, all three exact render hashes, renderer rejection of a well-formed but mismatched content hash, sorted manifests, actual-prior same-scope sequential version chains, frozen-subject-bound envelopes and same-receipt cross-snapshot rejection, null retention, fixed-millisecond runtime-envelope times, hash-derived IDs, no back-link/self-hash, exact-key plain-data runtime schemas at every public wrapper and nested boundary, strict summary/accounting/threshold reconstruction after hostile rehashing, governing-contract-preimage derivation of parameter/unit/time-zone export metadata, normalized-evaluation-preimage recomputation, exact derivation of report-safe coverage aggregates, rejection of eligible gaps relabeled as lifecycle exclusions, one state/evidence binding per lifecycle-event ID and evidence-bound replay/extra/superseded duplicate reasons, marker-based proof that full interval/outcome summaries and evidence-routing identifiers never enter JSON/HTML/CSV, HTML escaping/semantics, CSV formula neutralization, safe output names, staged atomic output, forced stage/rename cleanup and aggregate preservation of simultaneous primary/cleanup failures. The 95% per-file safety-core threshold explicitly covers the domain, report-schema, renderer, lifecycle and local-output modules. It does not satisfy real-source reproduction, authenticated approval, browser/assistive-technology review, tagged PDF, backup restore or jurisdiction annual-draft UAT.

### Control-plane signature verification

- 2-of-3 offline root tests accept only Security/Release/Governance root-authorized, hash-chained trust generations;
- pipeline provenance accepts exactly one named Release Engineering KMS/HSM workload signature bound to repository, workflow, environment, commit and artifact digest;
- adapter/disclosure allowlists require Security plus Data/Regulatory signatures; release-artifact manifests require Release Engineering plus Security; duplicate or cross-purpose signers do not satisfy thresholds;
- verifier rejects wrong purpose/role/key/identity/repository/workflow/environment/digest, missing threshold, unknown policy generation and altered canonical statement;
- verifier uses trusted current UTC and rejects unknown time, more than five-minute skew, future issuance, not-yet-valid/expired policy or key and statements outside their issuance window;
- rotation accepts both generations only in the signed 14-day overlap and rejects the old key after cutoff;
- revocation state is monotonic/hash-chained; stale over-24-hour, missing, lower-sequence and replayed views fail closed online and offline;
- KMS/HSM, time or revocation outage freezes signing/promotion/allowlist change; compromised keys/workloads are revoked and artifacts in the affected window cannot verify;
- receipt-core verification remains a hash/reproduction check and never passes through a control-plane signature path.

## 9. Human evaluation thresholds

Participants:

- at least 5 jurisdiction admins/reviewers across discovery/pilots;
- 4 operators/responsible-entity users;
- 3 community/public users;
- 2 disabled participants across critical-task testing;
- CA engineer, security and records reviewers.

Thresholds:

- ≥90% critical-task completion without assistance after training;
- no participant mistakes evidence completeness for compliance after viewing status/receipt;
- ≥80% correctly distinguish candidate exception from official finding;
- public users can identify period, scope, source and limitations;
- no critical accessibility/usability defect;
- jurisdiction reports ≥50% annual-assembly time improvement hypothesis or demonstrates equivalent traceability value.

## 10. Performance and resilience

### Load

- 50 systems × 20 series × five-minute cadence ≈105 million measurements/year;
- 2x burst during backfill;
- 20 concurrent staff users per pilot tenant;
- 100k-row CSV and 30-day API backfill;
- portfolio annual report for 50 systems.

Targets:

- p95 common read <2s;
- async upload accepted <60s;
- 100k-row ingestion <15m at target load;
- daily aggregate for one tenant <30m after period close;
- report preflight/render <5m;
- no worker memory >configured budget and no API request blocked on parsing.

### Resilience tests

- worker crash mid-file and safe retry;
- queue/database failover;
- object store temporary failure;
- vendor 429/5xx and credential revocation;
- partial report render;
- PITR plus object recovery;
- accepted-object cross-region recovery meets RPO ≤15 minutes/RTO ≤8 hours and acknowledged frozen report/receipt recovery demonstrates RPO 0;
- production-scale deletion/tamper drill restores object/database relationships and verifies every selected object hash;
- mapping rollback/supersession;
- public snapshot publication failure remains atomic;
- restore and reproduce a frozen receipt.

## 11. Accessibility and security evaluation

- axe/component tests per PR;
- manual keyboard, NVDA/Chrome or Firefox, VoiceOver/Safari, zoom and forced-color testing;
- tagged PDF/manual reading-order test;
- SAST/SCA/IaC/container/secret scan;
- RLS and object-access penetration scenarios;
- independent pre-release security assessment;
- incident tabletop for credential leak, public-data leak and wrong annual total;
- no open critical/high security or critical accessibility defect.

## 12. Release test sequence

1. Source/profile/traceability lint.
2. Static/type/unit/property suite.
3. Database migrations, constraints and RLS suite.
4. Adapter golden/adversarial and read-only suite.
5. Integration vertical slices.
6. API contract and E2E critical journeys.
7. Required-series denominator/aggregate source-set and report/receipt deterministic reproduction.
8. Purpose/threshold signature verifier, rotation, revocation, outage and compromise-negative suite.
9. Performance, failover and restore.
10. Security scans and independent findings.
11. Automated/manual accessibility and document testing.
12. Full-calendar-year historical portfolio/control reconciliation.
13. Annual-draft UAT in both pilot jurisdictions using each jurisdiction's own profile and real historical data/control totals.
14. 30-day live shadow reconciliation.
15. Governance evidence review and human-attested release gate.

Any failure of tenant isolation, read-only boundary, source traceability, final/proposed report distinction, required-series denominator/source-set completeness, exact final-rule evidence preflights, deterministic unsigned receipt/envelope separation, purpose/threshold signer verification or public-copy boundary blocks release.
