# Research sources

**Research cutoff:** July 13, 2026  
**Rule:** Product behavior is pinned to reviewed source versions. This list is not legal advice, and current law/guidance must be rechecked before implementation or customer use.

## 1. Primary California authority

| ID | Source | Date/status | Product use |
|---|---|---|---|
| SRC-001 | [State Water Board: Onsite Treatment and Reuse of Nonpotable Water](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/onsite_nonpotable_reuse_regulations.html) | Updated Apr 23, 2026 | Official overview; effective Apr 22, 2026; pre-existing systems two-year transition |
| SRC-002 | [State Water Board rulemaking page SBDDW-22-001](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/otnws_regs.html) | Updated May 1, 2026 | Rulemaking history, approval date, final documents and affected sections |
| SRC-003 | [Final Regulation Text, Title 22 Division 4 Chapter 3.5](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/docs/2026/final-regulation-text.pdf) | Final Feb 2026; effective Apr 22, 2026 | Canonical V1 regulatory schema |
| SRC-004 | [California Water Code §§13558–13558.1](https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=8.&chapter=7.&division=7.&lawCode=WAT) | Current official code; amended effective Jan 1, 2024 | Local election/ordinance/program duties, annual statutory elements, installation boundary |
| SRC-004A | [California Government Code §11342.2](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=11342.2.&lawCode=GOV) | Current official code | Regulation must be consistent with and not alter/enlarge its authorizing statute; source-hierarchy control |
| SRC-005 | [Final Statement of Reasons](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/docs/2026/final-statement-of-reasons.pdf) | Feb 2026 | Regulatory rationale and response context; subordinate to final text |
| SRC-006 | [OAL approval/Form 400](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/docs/2026/form-400-appr.pdf) | Apr 22, 2026 | Effective-date provenance |
| SRC-007 | [Cross-Connection Control Policy Handbook page](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/cccph.html) | Revised Apr 21, 2026; page updated May 15 | Current cross-connection references and certification resources |

### Final annual-report elements

Final 22 CCR section 60606, in SRC-003, requires a local-jurisdiction report by February 1 following the January 1–December 31 reporting year. It includes:

1. number, location, building type and permit descriptions for existing, newly in-service/replacement and permanently out-of-service systems;
2. volume and types of end uses for each untreated alternate source treated by each system;
3. summary of violations and corrective actions;
4. number/location of complaints and/or malfunctions, systems investigated and resolution;
5. number and summary of site inspections.

A written request submitted by February 1 may seek up to 60 additional days.

### Final versus proposed distinction

[The March 2025 proposed regulation text](https://www.waterboards.ca.gov/drinking_water/certlic/drinkingwater/docs/2025/regtext_otnwsregs.pdf) included a section 60606 item summarizing minimum and maximum continuous process-verification parameters. **That item is absent from the final February 2026 regulation text.**

Water Code section 13558(b)(3), SRC-004, still mentions water-quality monitoring data in the annual report. Because statute controls over its implementing regulation, ReuseProof therefore uses:

- final 60606 fields as the default annual schema;
- final section 60688 for at-least-quarterly system monitoring drafts; and
- an always-present, separately labeled Water Code monitoring-data section with configured/authority-pending/review-blocked status. An unresolved implementation blocks review-ready approval; it does not authorize omission.

This distinction is a release gate and must not be “simplified” in marketing, code or documentation.

### Other final requirements informing V1

From SRC-003:

- section 60608: system operating before April 22, 2026 must comply by April 21, 2028; possible local extension until April 21, 2031 under stated conditions;
- section 60604(b): when source collection, treatment or distribution spans more than one parcel, the responsible entity provides the jurisdiction proof of a county-recorder-filed property covenant describing the parcel combination and effect of a parcel sale;
- sections 60640/60642: field verification for alternatives and continuous process-verification monitoring;
- section 60678: weekly farthest-fixture disinfectant residual and 48-hour restore/retest workflow;
- section 60680: locally approved California-PE engineering report and required content;
- section 60684(f): commissioning report submitted within 30 days after completion to the jurisdiction for review and approval and separately to the public water system, sewer service provider and applicable recycled-water agency;
- section 60686: current onsite operations plan;
- section 60688: at-least-quarterly monitoring report and Table 60688-1;
- section 60694(a): before indoor supply, responsible entity documentation that tenants/residents were informed and that plumbing modifications/repairs in a building unit require responsible-entity approval; section 60694 inadequate-treatment phone-and-email and written notification duties remain distinct;
- section 60696(a): the pre-decommissioning notice identifies equipment inactivation/demolition/removal, internal/external pipe abandonment/removal, other locally required activities and timeline; pre/post notice windows and named recipients remain distinct;
- section 60706(b): a certified specialist's written hazard/inspection/test report goes to the jurisdiction and public water system within 30 days; section 60708(c): a completed backflow field-test or air-gap inspection report goes to the jurisdiction within 30 days;
- section 60710: three-party notification and distinct external cease-delivery/drain-riser, potable-shutdown, uncover/disconnect, repeat-inspection/test, 50 mg/L/24-hour chlorination, flush/locally acceptable bacteriological-test, cause/correction/report and local-approval-before-restart steps.

ReuseProof records evidence and dates for these workflows; it does not send, file, perform, validate or approve them. Implementation must re-verify every encoded field against SRC-003 and any controlling local source before release.

## 2. Mature local-program reference

| ID | Source | Use |
|---|---|---|
| SRC-010 | [SFPUC Onsite Water Reuse Program Guidebook, September 2025](https://www.sfpuc.gov/documents/onsite-water-reuse-program-guidebook-september-2025) | Mature program workflow, permit/commissioning/monitoring context; not statewide authority |
| SRC-011 | [SFPUC guidebook PDF](https://www.sfpuc.gov/sites/default/files/construction-and-contracts/design-guidelines/zzz_OnsiteWaterReuseGuide2022_v8.pdf) | Monitoring/reporting and operating workflow examples; verify version before relying |

Do not imply SFPUC endorsement. San Francisco's local process can be stricter/different and is a design reference only outside its authority.

## 3. Security, public records and accessibility

| ID | Source | Product use |
|---|---|---|
| SRC-020 | [CISA/EPA/FBI: Top Cyber Actions for Securing Water Systems](https://www.cisa.gov/news-events/alerts/2024/02/21/cisa-epa-and-fbi-release-top-cyber-actions-securing-water-systems) | OT/IT separation, assessment, credential and recovery baseline |
| SRC-021 | [CISA Cross-Sector Cybersecurity Performance Goals](https://www.cisa.gov/cybersecurity-performance-goals) | Prioritized critical-infrastructure controls |
| SRC-022 | [California DOJ Public Records overview](https://oag.ca.gov/consumers/general/pra) | Government records may be publicly accessible; exemptions/redactions are jurisdiction decisions |
| SRC-023 | [DOJ ADA Title II web/mobile accessibility guide](https://www.ada.gov/resources/small-entity-compliance-guide/) | Current WCAG 2.1 AA public-entity baseline and April 2026 interim-rule dates; recheck in procurement |
| SRC-024 | [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Product target to maximize future applicability |
| SRC-025 | [Section508.gov: Buy Accessible Products and Services](https://www.section508.gov/buy/) | Procurement-oriented accessibility evidence/testing practice; federal guidance, not California law |

## 4. Evidence-strength rules

- **Authority:** final official law/regulation and adopted local sources outrank proposals, summaries and marketing.
- **Currentness:** record page/document date and recheck before each profile release.
- **Scope:** distinguish statewide, local and customer-specific requirements.
- **Inference:** label product hypotheses as hypotheses.
- **Regulatory ambiguity:** escalate to authorized jurisdiction/counsel; product defaults to no automated interpretation.
- **Citation:** every encoded rule/report field links to source/section/version.
