# Governance, legal and safety

## 1. Governance purpose

Governance protects five boundaries:

1. California/local authority is represented accurately and versioned.
2. Licensed engineering and regulator decisions remain with authorized people.
3. ReuseProof remains read-only toward operational water systems.
4. Evidence/report claims remain reproducible and bounded.
5. Public transparency does not expose people or critical infrastructure.

Governance approval is necessary but cannot transform ReuseProof into a regulator, engineer, laboratory, operator or certifier.

## 2. Governing group

Minimum voting members:

- **California water engineer:** California-licensed engineer with relevant water/wastewater/reuse experience.
- **Local regulator/program administrator:** currently responsible for an elected local OTNWS program or pilot.
- **Building operator/responsible-entity representative:** practical operation, evidence and emergency workflow.
- **Cybersecurity reviewer:** water/critical-infrastructure and municipal-cloud experience.
- **Community/public representative:** tenant/public-health, transparency and accessibility perspective.

Nonvoting advisors:

- product/engineering lead;
- jurisdiction counsel/records officer;
- accessibility specialist;
- procurement/municipal IT representative;
- equipment vendor only for relevant technical evidence, with conflict disclosed.

Members are compensated where legally permitted. Quorum requires four of five voting perspectives; release or boundary expansion requires all five perspectives represented and no unresolved safety/security veto.

## 3. Decision rights

| Decision | Final authority |
|---|---|
| Local program exists and its official workflow | Local jurisdiction |
| Permit, approval, violation, enforcement and State submission | Local jurisdiction/State authority |
| Engineering report, validation or commissioning professional work | Appropriately licensed/authorized professional and jurisdiction |
| System operation, alarms, diversion and emergency response | Responsible entity/operator under approved plan |
| Source/mapping technical identity | Vendor/operator + CA engineer + jurisdiction reviewer |
| Product architecture/security release | ReuseProof technical/security leads, subject to governance gates |
| Public disclosure profile | Jurisdiction records/security officials with community review |
| Product claims and disclaimers | Governance group + counsel |
| Regulatory source/profile update | Regulatory lead proposes; jurisdiction approves tenant use |
| V1 go/no-go | Governance group using objective gates |

## 4. Reviewer RACI

| Artifact/control | CA engineer | Program admin | Operator | Cyber reviewer | Community rep | Product |
|---|---|---|---|---|---|---|
| Regulatory mapping | R | A | C | I | I | C |
| Parameter/statistic mapping | A/R | C | R | I | I | C |
| Report schema | C | A/R | C | I | C | C |
| Read-only source approval | C | C | C | A/R | I | R |
| Candidate exception meaning | C | A/R | C | I | I | I |
| Public disclosure | I | A | I | R | R | C |
| Accessibility acceptance | I | A | C | C | R | R |
| Product release | R | R | R | R | R | A |
| Treatment/engineering decision | A/R when retained in that role | A/R as authority | C | I | I | I |

## 5. Evidence policy

- Official final text outranks proposed text.
- Every machine-readable requirement stores exact source/version and local approval.
- Source artifacts are preserved; corrections create versions.
- Quantitative report facts must trace through mapping and aggregation to source.
- Missing evidence is a gap, not a favorable assumption.
- Hard authority, termination and monitoring-coverage gates cannot be waived by attestation; attestations may explain only eligible residual gaps after thresholds pass.
- Candidate exceptions are not violations.
- A jurisdiction-authored official finding must name authority, actor, date and evidence.
- Vendor marketing claims are never treated as proof of regulatory status.
- Receipt language is reviewed by governance, says only “evidence assembled,” contains no certification claim and identifies the deterministic receipt core as unsigned. Human attestations live in a separate authenticated verification envelope; purpose/threshold signatures protect only the release/control plane.

## 6. Regulatory baseline

### State rule

The State Water Board's final Title 22, Division 4, Chapter 3.5 regulations became effective April 22, 2026. They address OTNWS serving multifamily, commercial and mixed-use buildings or district-scale combinations, subject to stated limitations.

Systems operating before April 22, 2026 must comply by April 21, 2028. Final section 60608 allows a permitting local jurisdiction to extend until April 21, 2031 under stated extenuating circumstances. ReuseProof records evidence and dates but does not decide eligibility.

### Local election and authority

Water Code section 13558(b) applies when a local jurisdiction elects to establish a program. The jurisdiction adopts an ordinance, establishes design/permitting/cross-connection/enforcement procedures, reports annually and protects public health. When the jurisdiction does not provide water or sewer service, the authority record must also capture consultation with the applicable provider, its opportunity to demonstrate adverse impacts, and avoidance/mitigation of a demonstrated significant risk before adoption, amendment or repeal. An OTNWS may not be installed outside a compliant program, subject to statutory exclusions.

A State Board direction under Water Code section 13558(b)(4) is scoped to the named OTNWS and remains separate from local program termination under section 13558(b)(5). A system order cannot be recorded as fulfilled without termination-of-operation and render-inoperable evidence. A local program cannot be recorded as terminated until the hardship statement and public-comment opportunity are present, every issued permit has rescission evidence and every installed system has render-inoperable evidence. These completeness preflights are non-bypassable; the product never performs, authorizes or directs the actions.

ReuseProof must never imply every California locality has a program or that the State Water Board administers a local program on its behalf.

### Reporting

- Final 22 CCR section 60688 requires OTNWS monitoring results in a locally approved format at least quarterly.
- Final 22 CCR section 60606 requires the local annual report by February 1 following the January–December reporting year and permits a written request by February 1 for up to 60 additional days.
- Final 60606 fields are implemented exactly as a default; monitoring min/max from the proposed text is not.
- Water Code section 13558(b)(3) mentions water-quality monitoring data. Because statute controls over implementing regulation, every draft contains a distinct monitoring-data section with configured/authority-pending/review-blocked status. The proposal-only continuous-monitoring min/max item remains excluded. An unresolved implementation blocks review-ready approval rather than silently omitting the statutory subject.

### Plans, commissioning and cross-connection

The product tracks evidence related to final sections 60680–60688 and 60700–60710. It does not prepare or approve the engineering report, validation study, commissioning work, operations plan, hazard assessment, visual inspection, cross-connection test or backflow test.

The P0 record-only profile also preserves distinct, non-bypassable evidence rows for:

- section 60604(b) multi-parcel county-recorded property-covenant proof and its sale-effect description;
- section 60684(f) commissioning-report delivery within 30 days to the local jurisdiction for review/approval and to the public water system, sewer service provider and applicable recycled-water agency;
- section 60694(a) responsible-entity documentation before indoor supply that tenants/residents were informed and building-unit plumbing modifications/repairs require responsible-entity approval;
- section 60696(a) pre-notice content covering equipment inactivation/demolition/removal, internal/external pipe abandonment/removal, other locally required activities and timeline, plus both notice windows and recipient sets;
- sections 60706(b) and 60708(c) separate certified-specialist/report-delivery recipients and 30-day clocks; and
- every section 60710(a)(2)–(7) external action—cease delivery/drain riser, potable shutdown, uncover/disconnect, repeat inspection/test, 50 mg/L chlorination for 24 hours, flush and acceptable bacteriological test—plus cause investigation, corrective action/report and local approval before restart.

ReuseProof records evidence only. It never files a covenant, issues or sends a notice/report, approves plumbing, commands shutdown, disconnects plumbing, performs treatment/sampling/testing, decides bacteriological acceptability or authorizes restart.

## 7. Legal posture

### No legal advice or compliance certification

Allowed:

- “Evidence present for the configured profile.”
- “Draft assembled from the listed sources.”
- “Candidate exception requires authorized review.”
- “Submission was recorded by the jurisdiction.”

Disallowed:

- “This system/jurisdiction is compliant.”
- “This water is safe.”
- “This is a legal violation.”
- “The report satisfies all law.”
- “State Water Board certified/approved,” absent an exact external record and bounded wording.

### No engineering or laboratory practice

- Engineering reports must be prepared by the professional required by the regulation; ReuseProof stores and traces them.
- Product does not calculate or validate LRTs, treatment efficacy, operating envelopes, critical limits or commissioning findings.
- Product does not verify professional licensure beyond recording/referencing an external source.
- Product does not perform sampling, analysis, calibration, chain-of-custody or lab accreditation.

### Local authority and unauthorized delegation

Contracts state that:

- jurisdiction retains all permit, interpretation, finding, submission and enforcement authority;
- responsible entity/operator retains operations and notifications;
- product workflow cannot replace legally required signature, seal, inspection or consultation;
- external submission is not delegated in V1.

### Public records and privacy

Data held for a California local agency may be subject to the California Public Records Act. Product classifications are security/workflow controls, not legal exemptions. The jurisdiction controls retention, holds, search, review, redaction and disclosure. Contracts must address assistance costs, export format and incident response.

### Procurement and accessibility

The service must support municipal security review, insurance, data-processing, records, accessibility and subcontractor terms. The product targets WCAG 2.2 AA and provides an ACR/VPAT-style report; counsel/procurement confirms the applicable ADA Title II date and contractual baseline.

### Contracts and insurance

Before live pilot:

- master/pilot scope and prohibited-actions schedule;
- DPA and data inventory;
- security exhibit and incident-notification terms;
- records/export/retention/deletion and legal-hold terms;
- accessibility requirements and remediation SLA;
- professional/general/cyber insurance appropriate to actual service;
- no warranty of compliance, safety or uninterrupted operational monitoring;
- indemnity/liability reviewed without disclaiming negligence or security obligations improperly;
- applicable funding and procurement authority reviewed where proposed.

## 8. Safety case

### Intended safety contribution

ReuseProof may reduce administrative omissions and make source/report gaps visible. It is not a safety control.

### Hazards and controls

| Hazard | Cause | Control | Verification |
|---|---|---|---|
| Operator relies on stale data | Dashboard resembles SCADA | Freshness banner; no real-time language; training; no alarm role | Usability and copy tests |
| Product sends unsafe command | Scope creep/credential | No OT route; GET-only allowlist; static/dynamic invariant | T-SEC-RO suite |
| Wrong aggregate enters report | Mapping/time/unit defect | Source preservation, versioned mapping, coverage, reconciliation | Golden/property/pilot tests |
| Missing data looks favorable | Silent drop/default | Quarantine/gap; unknown blocks approval | Adversarial fixtures |
| Candidate becomes “violation” | UI/automation semantics | Human-only official finding; prohibited labels | Domain/UI tests |
| Sensitive vulnerability published | Disclosure error | Separate frozen public store; allowlist/two-person approval | Leak tests |
| Wrong system/tenant evidence | Identity/mapping failure | RLS, system binding, source contract, negative tests | Auth/integration tests |
| Report uses proposed rule as final | Stale source | Final source pin; schema distinction; release checklist | Traceability audit |
| Accessibility blocks reviewer | Inaccessible table/PDF | WCAG target; manual AT and document tests | Accessibility acceptance |

### Safety constraints

- SC-01: ReuseProof cannot participate in closed-loop or supervisory control.
- SC-02: Product notification cannot be the sole means for required operational response.
- SC-03: No pass/fail conclusion without authorized human and explicit external authority.
- SC-04: Unknown/ambiguous input stays unknown.
- SC-05: Public output is built from a frozen allowlist copy.
- SC-06: Material evidence transformation is versioned and reproducible.

Violation of SC-01, SC-03, SC-04 or SC-05 is a release blocker.

## 9. Claims policy

### Approved positioning

> ReuseProof CA is a read-only, hardware-neutral evidence and reporting workspace for California local onsite nonpotable water reuse programs.

> It preserves source provenance, normalizes approved monitoring fields and helps authorized users prepare reviewable drafts.

### Required disclaimer

> ReuseProof CA does not control water systems, monitor safety in real time, certify compliance, provide legal or engineering advice, perform laboratory work, approve permits or submit enforcement decisions. Authorized operators, engineers and government officials remain responsible for those functions.

### Prohibited marketing

- “automatic compliance”
- “guaranteed regulatory approval”
- “certified safe water”
- “replaces operators/engineers/inspectors”
- “statewide official portal”
- “works with every system” before validated mapping
- “tamper-proof” or “immutable” without qualifying technical/records behavior
- “no competitors”

## 10. Conflicts, compensation and independence

- Publish governance roles and material vendor/customer relationships.
- Vendor-funded adapter work cannot alter evidence quality or exception logic.
- CA engineer cannot approve product handling of their own undisclosed vendor claim without independent review.
- Community representative is not expected to waive security or transparency concerns for schedule.
- Sales cannot override release gates.
- Meeting minutes record dissent and residual risk; sensitive operational detail is redacted from broadly distributed minutes.

## 11. Change, appeal and withdrawal

### Normal change

Source proposal → impact analysis → fixture/report diff → required reviewers → versioned release → customer notice → traceability update.

### Evidence/mapping appeal

Any customer or affected vendor may dispute a mapping or report fact. Freeze affected publication where material, preserve both versions, assign independent reviewer, document disposition and issue a superseding receipt if corrected.

### Emergency withdrawal

Security lead or program admin may immediately disable an adapter, report template or public snapshot for suspected leak, control-scope drift or material evidence error. Restoration requires root cause, corrected tests and appropriate governance approval.

## 12. Regulatory and evidence watch

Monthly during build and quarterly after release, review:

- State Water Board OTNWS rule/guidance/reporting changes;
- California Code of Regulations currentness;
- Water Code amendments;
- local ordinance and report formats;
- Cross-Connection Control Policy Handbook updates;
- State submission interface/template;
- ADA/public-sector accessibility changes;
- CPRA/security guidance;
- vendor API/schema/scope changes.

Each watch item has owner, review date, source hash/link and action.

## 13. Governance launch gates

- [ ] Five voting perspectives seated and conflicts recorded
- [ ] Final/proposed annual-report distinction approved
- [ ] Distinct Water Code monitoring-data authority/schema/status implementation recorded for both pilots
- [ ] Read-only/no-OT architecture and adapter scopes approved
- [ ] All final-rule recipient/action/content/deadline preflights above pass with product record-only claims
- [ ] Immutable `RequiredSeriesContract` denominator and aggregate-source-set semantics approved independently of vendor mappings
- [ ] Unsigned deterministic receipt core/envelope separation and non-circular reproduction approved
- [ ] Offline-root and purpose/threshold operational signing policy, time/rotation/revocation/outage/compromise controls approved
- [ ] Safety case and constraints verified
- [ ] Claims/disclaimer approved
- [ ] Public/private disclosure profile approved with community input
- [ ] CPRA/retention/export posture reviewed by jurisdiction
- [ ] Accessibility evidence accepted
- [ ] Pilot reconciliation and residual risks reviewed
- [ ] No open critical/high security issue
- [ ] Release decision and any dissent published internally
