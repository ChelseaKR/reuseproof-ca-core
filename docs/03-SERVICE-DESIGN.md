# Service design

## 1. Service promise

ReuseProof CA helps a local jurisdiction and permitted systems assemble reproducible OTNWS evidence and report drafts across heterogeneous vendors. It does not operate equipment, monitor safety in real time, approve engineering, certify compliance, determine violations or submit enforcement actions.

The service outcome is: **the authorized reviewer can find what was received, what was transformed, what is missing, who reviewed it, and what entered a draft report.**

## 2. Service blueprint

| Stage | User action | Frontstage product | Backstage service | Evidence/output | Boundary |
|---|---|---|---|---|---|
| Program setup | Jurisdiction supplies ordinance, authority events, provider-consultation/mitigation evidence, roles and local profile | Guided configuration, system-order/program-termination separation and disclosure choices | Regulatory source/version review | Program-authority/profile receipt | No legal opinion or ordinance action |
| Portfolio setup | Admin registers system and organizations | Registry/import preview | Implementation mapping | System lifecycle record | No permit issuance |
| Permit/commissioning | Parties upload/link artifacts | Versioned evidence timeline | Metadata QA and role verification | Object hashes and approval-source record | No engineering review by software |
| Adapter onboarding | Vendor/operator supplies read-only export/API | Mapping preview and fixture validation | Credential/scope and data-contract review | Adapter approval record | No OT connection/control |
| Ongoing ingestion | Operator uploads or schedules vendor-cloud pull | Ingestion status, gaps, quarantine | Async worker, normalization, aggregate QA | Ingestion receipt | Not a safety alarm |
| Review | Reviewer examines candidate exception/event | Evidence comparison and disposition | Support on provenance, not meaning | Review/audit event | No automated violation |
| Field evidence | Inspector/operator records test/inspection | Accessible form and artifact upload | Certification/date validation support | Inspection/test receipt | No performance of test |
| Quarterly packet | Operator/admin selects period | Draft section 60688 packet | Reconciliation and mapping support | Draft + receipt | Human/external submission |
| Annual draft | Admin freezes calendar year | Final-60606 sections plus distinct Water Code monitoring-data status | Authority, coverage and control-total reconciliation | Draft + evidence receipt | No State filing; unresolved authority blocks review-ready |
| Public release | Jurisdiction approves aggregate snapshot | Accessible public view | Disclosure/security check | Publication receipt | No default raw data |
| State Board system order | Jurisdiction records a direction affecting a named OTNWS | System-scoped order, termination-of-operation and render-inoperable evidence | Completeness QA against the external order | System-order receipt | Product never commands or authorizes the action |
| Local program termination | Jurisdiction records its program-termination process | Non-bypassable all-permit/all-system preflight | Hardship/comment, permit-rescission and render-inoperable completeness QA | Program-lifecycle receipt | Product never terminates the program or systems |
| Exit | Jurisdiction requests SaaS export/termination | Documented export and deletion workflow | Records/security signoff | Export/delete certificate | Distinct from statutory program termination; legal holds honored |

## 3. Roles

### Customer

- **Executive sponsor:** secures program authority, budget and cross-department participation.
- **Program administrator:** owns local profile, portfolio, draft reports and public snapshot.
- **Technical reviewer/inspector:** reviews evidence and records official dispositions/actions.
- **Responsible entity:** owns system evidence duties under its permit.
- **Duly authorized agent/operator:** supplies monitoring and operations evidence.
- **Municipal IT/security:** approves identity, vendor access, hosting and incident interfaces.
- **Counsel/records officer:** owns public-records, retention and legal interpretation.
- **Accessibility coordinator:** accepts ACR/test evidence and supports user testing.
- **Public water system/sewer provider/recycled-water supplier or agency contacts:** consultation, approval, notice or delivery recipients as applicable; these are governed organization roles, not generic contacts.

### ReuseProof

- **Implementation lead:** maps workflow and coordinates data sources.
- **Data integration engineer:** builds/tests adapter mapping and reconciliation.
- **Product support:** resolves application/evidence-workflow issues.
- **Security lead:** approves scopes, investigates incidents and protects tenant boundaries.
- **Regulatory lead/CA engineer:** maintains source mapping and reviews product claims without taking over jurisdiction decisions.

## 4. RACI

| Activity | Jurisdiction admin | Reviewer/engineer | Operator/entity | Vendor | ReuseProof | Security/records | Community rep |
|---|---|---|---|---|---|---|---|
| Establish local program/authority | A/R | C | I | I | I | C | C |
| Configure report profile | A | R | C | I | C | C | I |
| Approve engineering/commissioning | A | R | C | C | I | I | I |
| Approve adapter mapping | A | C | R | R | R | C | I |
| Operate treatment/respond to alarms | I | I | A/R | C | I | I | I |
| Review candidate exception | A | R | C | C | I | I | I |
| Determine/report violation | A/R | C | C | I | I | C | I |
| Record corrective action | C | C | A/R | C | I | I | I |
| Approve annual draft | A/R | C | C | I | C | C | I |
| Submit to State Water Board | A/R | C | I | I | I | C | I |
| Approve public fields | A | C | I | I | C | R | C |
| Security incident response | C | I | C | C | R | A/R | I |
| Product release | C | C | C | I | A/R | C | C |

A = accountable, R = responsible, C = consulted, I = informed. ReuseProof is never A/R for treatment operation, engineering approval, violation determination or government submission.

## 5. Intake checklist

- [ ] Local program authority/ordinance and responsible department identified
- [ ] Where the jurisdiction does not provide water or sewer service, provider consultation, adverse-impact opportunity and mitigation/avoidance evidence recorded before authority-complete
- [ ] System-scoped State Board order and program-scoped local termination evidence owners/workflows named; program termination cannot complete until every permit/system is accounted for
- [ ] Supplemental-source public-water-system and applicable recycled-water-supplier approvals recorded before permit preflight
- [ ] Program administrator, reviewer, IT/security, counsel/records and accessibility contacts named
- [ ] Pilot procurement vehicle and funding party identified
- [ ] System/responsible entity/operator/vendor consent and roles documented
- [ ] Source/evidence inventory completed
- [ ] Vendor access method and OAuth/API scopes documented
- [ ] No direct OT connection or control credential
- [ ] Final 60606 schema and distinct Water Code 13558(b)(3) monitoring-data authority/schema/status recorded; unresolved status blocks review-ready
- [ ] Retention, legal hold, export and public-records process approved
- [ ] Critical-infrastructure data classification approved
- [ ] Public-view default approved
- [ ] Incident contacts and breach-notification terms approved
- [ ] Accessibility conformance/test requirements approved
- [ ] Exit and deletion terms approved

## 6. Standard engagement package

### Deliverables

- jurisdiction program setup and local report profile;
- up to ten V1 systems per pilot;
- registry and evidence import template;
- three supported vendor format mappings across the product, subject to contract;
- one complete calendar year of real historical portfolio/control data in at least one jurisdiction;
- annual-draft UAT in both jurisdictions using each jurisdiction's own profile, pre-selection-proven real historical corpus and independently maintained control totals;
- a 26-active-delivery-week program from September 21, 2026 through April 2, 2027: 6 weeks contract/security/profile setup, 13 weeks source mapping/foundation/reporting and 7 weeks evidence/closeout, excluding the December 21–January 1 pause;
- one 30-day live shadow for a nominated system;
- data-quality and reconciliation report;
- draft quarterly and annual packets;
- evidence receipts;
- administrator/operator training;
- security, accessibility and exit documentation.

### Explicit exclusions

- equipment installation, maintenance or operation;
- alarm response, on-call operator service or emergency dispatch;
- treatment design, validation, commissioning or California PE seal;
- laboratory service;
- legal advice, permit approval, compliance certification or enforcement;
- automatic external filing;
- custom general-permitting replacement;
- public release before customer approval.

## 7. Customer journey and service levels

| Moment | Service target | If missed |
|---|---:|---|
| Intake completeness review | 5 business days | Return explicit gap list |
| New CSV mapping estimate | 5 business days after valid sample/dictionary | Escalate scope and pilot impact |
| Supported file ingestion | 15 minutes for ≤100k rows at target load | Status page + retry/runbook |
| Quarantine explanation | Immediate machine reason; support response in 1 business day | Escalate to data engineer |
| Evidence-workflow support | 1 business day | Support lead escalation |
| Suspected cross-tenant/public leak | Acknowledge in 30 minutes, contain immediately | SEV-1 process |
| Draft report generation | 5 minutes for target portfolio | Retry; preserve prior snapshot |
| Exit export | 10 business days | Executive escalation |

These are software/service levels, not operational-water response times.

## 8. Evidence status and severity

ReuseProof uses evidence workflow states, not regulatory verdicts:

- **Complete:** required product field/evidence present for the configured profile.
- **Gap:** expected evidence absent, stale or unreadable.
- **Quarantined:** source received but not safely normalized.
- **Candidate exception:** configured comparison warrants human review.
- **Acknowledged:** reviewer has seen the item.
- **Referred:** reviewer sent item to an authorized technical/regulatory process.
- **Resolved:** evidence of follow-up recorded.
- **Not applicable:** reviewer documented why the profile does not apply.

Support severity:

- **SEV-1:** cross-tenant access, public disclosure of restricted data, credential/control-boundary compromise, evidence tampering or widespread authentication failure.
- **SEV-2:** incorrect report aggregate, adapter corruption, unavailable report workflow near deadline, or inaccessible critical task.
- **SEV-3:** isolated ingestion delay, noncritical UI defect or documentation issue.

A treatment malfunction remains an operator/jurisdiction event governed by their plan, not a ReuseProof incident unless the product itself failed.

## 9. Disputed evidence or mappings

1. Freeze the affected report/public snapshot if material.
2. Preserve source object, adapter/mapping/profile versions and prior output.
3. Mark the item disputed without rewriting history.
4. Assign an authorized jurisdiction owner and technical evidence reviewer.
5. Record both positions and supporting evidence.
6. Issue a new mapping/profile/output version if resolved.
7. Regenerate the receipt and retain the superseded receipt.
8. Notify affected consumers according to contract.

ReuseProof support may explain transformations but cannot decide engineering or legal meaning.

## 10. Support boundaries

Support may:

- diagnose authentication, upload, mapping, aggregation, export and provenance problems;
- explain product status and source transformations;
- help configure a jurisdiction-approved profile;
- recover or reproduce evidence;
- route a suspected security incident.

Support must not:

- advise whether water is safe;
- tell an operator how to adjust treatment;
- acknowledge or silence an equipment alarm;
- decide whether a threshold constitutes a violation;
- promise a filing satisfies law;
- redact a public record without jurisdiction instruction;
- offer licensed engineering or legal advice.

Scripts route urgent operational language to the customer's approved operator/emergency contacts and state that ReuseProof is not an emergency channel.

## 11. Service improvement

Monthly during pilot and quarterly after release, review:

- implementation hours by system and source;
- recurring quarantine/gap causes;
- report reconciliation defects;
- user task completion and accessibility findings;
- support boundary escalations;
- security/public-records issues;
- customer requests better served by generic systems;
- cost-to-serve and renewal intent.

Any proposed automation of legal or engineering judgment, expansion toward control systems, or public release of operational detail requires a new ADR and governance approval.
