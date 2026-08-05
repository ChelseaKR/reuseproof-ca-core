# Data, ontology, quality and evidence

## 1. Evidence posture and source hierarchy

ReuseProof stores and transforms evidence; it does not create legal truth. Every requirement profile records:

1. official authority or jurisdiction instruction;
2. exact section/document URL and publication/effective date;
3. text excerpt or field interpretation;
4. reviewer and approval date;
5. effective/superseded dates;
6. scope and uncertainty.

Default source hierarchy:

1. California Water Code and other controlling statute;
2. final California Code of Regulations/final official regulation text;
3. formally adopted local ordinance, permit condition or approved local format;
4. official State Water Board guidance;
5. approved engineering/commissioning/operations artifacts;
6. vendor/operator source contracts;
7. secondary explanatory material.

Conflicts are logged and escalated. They are never silently merged. California Government Code section 11342.2 is the hierarchy control: an implementing regulation cannot alter or enlarge its authorizing statute.

### Final-versus-proposed annual-report distinction

The default annual schema follows final 22 CCR section 60606, effective April 22, 2026. It does not include the continuous-monitoring minimum/maximum item from the March 2025 proposed text. Water Code section 13558(b)(3) independently requires water-quality monitoring data, so every annual draft carries a distinct statutory monitoring-data section. Its state is `configured`, `authority_pending` or `review_blocked`; it records authority/schema/reviewer and remains distinct in UI, API and exports. An unresolved interpretation blocks review-ready approval rather than silently omitting monitoring data.

## 2. Core ontology

### Program and jurisdiction

- **Jurisdiction tenant:** city, county, or city and county operating a program.
- **Program profile:** versioned local authority, contacts, reporting rules and disclosure settings.
- **Program authority event:** ordinance adoption, amendment or repeal plus applicable provider consultation, adverse-impact opportunity, mitigation/avoidance and authorized not-applicable evidence.
- **Program lifecycle event:** established, amended, locally terminated or resumed. Local termination has a non-bypassable completeness preflight requiring hardship statement, public-comment opportunity, rescission evidence for every issued permit and render-inoperable evidence for every installed system before cessation. ReuseProof records but never executes the event.
- **Requirement profile:** versioned machine-readable workflow/comparison configuration approved by jurisdiction.
- **Report profile:** versioned section/order/field/export format.
- **Required-series contract:** an immutable, effective-dated statement of regulatory/reporting requiredness and denominator semantics, activated from an approved permit/profile, system lifecycle and prescribed treatment train or approved alternative. It is independent of vendor transport and mapping contracts.

### System and parties

- **OTNWS system:** locally identified onsite treated nonpotable water system.
- **Site/building:** physical context and building type; exact location is private/critical-infrastructure metadata by default.
- **Responsible entity:** permit holder with legal authority/control.
- **Duly authorized agent:** person designated and locally approved for oversight/management.
- **Operator:** person or organization performing operation/maintenance.
- **Vendor:** equipment, data or O&M provider.
- **Public water system:** approval, notice, consultation or report recipient organization.
- **Sewer service provider:** consultation, adverse-impact, mitigation, notice or report recipient organization.
- **Recycled-water supplier/agency:** supplemental-source approver or report/notice recipient organization when applicable; its role is typed for the governing workflow.
- **Lifecycle event:** proposed, permitted, commissioning, in service, modified, replaced, suspended, decommissioning or permanently out of service; these are recorded facts, not compliance states.
- **State Board system order:** a Water Code section 13558(b)(4) direction scoped to one named OTNWS, linked separately to termination-of-operation and render-inoperable evidence. It is never a program-lifecycle state and ReuseProof never executes it.

### Water and treatment context

- **Applicability facts:** multifamily means at least three units and excludes townhouses; commercial exclusions are explicit; community sewer is recorded as the sole waste-discharge means; excluded untreated graywater/rainwater systems are represented as exclusions rather than OTNWSs.
- **Untreated alternate source type:** graywater, roof runoff, stormwater or onsite wastewater. A source outside the seeded final profile remains prohibited unless a named controlling authority supersedes or changes that profile; a generic local value cannot expand it.
- **Supplemental source:** potable water and, when applicable, qualifying recycled water are represented separately from untreated alternate sources. A typed `SupplementalSourceApproval` must record public-water-system approval and applicable recycled-water-supplier approval dated before local permit issuance.
- **End use:** the final rule's limited indoor/outdoor uses, with ornamental/landscape irrigation explicitly modeled as surface irrigation. Any extension requires a named external authority record; there is no ungoverned “local allowed” value.
- **Treatment process:** MBR, membrane filtration, UV disinfection, chlorine disinfection or approved alternative reference.
- **Treatment-train label:** documentation label only; ReuseProof does not validate design or LRT credit.

### Evidence and workflow

- **Evidence object:** immutable/versioned file or API-response object with hash.
- **Fact:** structured assertion derived from source or human entry.
- **Measurement:** timestamped raw and normalized value.
- **Daily aggregate:** configured statistic plus coverage/algorithm provenance.
- **Candidate exception:** human-review task generated from configured comparison.
- **Official finding reference:** jurisdiction-authored record of an external determination.
- **Corrective action:** owner, target, status and evidence; does not itself establish compliance.
- **Receipt:** manifest connecting sources, transformations, reviews and output.
- **Authority interaction:** consultation, approval, delivery or notification, with organization role, recipient, method, time, governing section and evidence object.

## 3. Identifier and version conventions

- UUIDv7 internal IDs; immutable public slug only for approved public entities.
- Preserve jurisdiction's system/permit/external record IDs as typed external identifiers.
- Version program, requirement, adapter, mapping, parameter, algorithm, report and disclosure profiles.
- Never reuse an ID for a different real-world entity.
- Merge requires explicit survivor/alias record and audit.
- Report snapshot refers to exact fact/profile versions, never “latest.”

## 4. Measurement model

Each Measurement includes:

| Field | Meaning |
|---|---|
| tenant_id, system_id, series_id | Authorization and physical/logical scope |
| process_code, parameter_code | Governed normalized identity |
| raw_value, raw_unit | Source representation retained for explanation |
| normalized_value, canonical_unit | Deterministic conversion |
| event_time_utc | Instant used for ordering |
| source_local_time, source_timezone | Original civil-time semantics |
| received_at, ingested_at | Transfer and processing timing |
| source_object_id, row_locator | Direct provenance |
| adapter_version, mapping_version | Transformation provenance |
| quality_state | accepted, quarantined, superseded |
| source_fingerprint | Idempotency/deduplication |
| calibration_context_id | Optional reference, never inferred |

Store decimal values with sufficient precision; avoid binary floating-point for report facts.

## 5. Seed normalized monitoring parameters

The dictionary is seeded from final section 60688 and Table 60688-1. It is not a substitute for the regulation, local approval or an engineering report.

| Code | Process/context | Parameter | Canonical unit | Required daily statistic/profile |
|---|---|---|---|---|
| flow.treated.daily_avg | Treatment system | Treated flow | gal/day | Daily average |
| volume.produced.daily | System | Onsite treated nonpotable water produced | gal | Daily volume |
| volume.used.daily | System/end use | Onsite treated nonpotable water used | gal | Daily volume |
| mbr.effluent.turbidity | MBR | Effluent turbidity | NTU | Daily maximum; rolling 24-hour 95th percentile |
| uv.influent.turbidity | UV | Influent turbidity | NTU | Daily maximum; rolling 24-hour 95th percentile |
| uv.dose | UV | Ultraviolet dose | mJ/cm² | Daily minimum |
| uv.transmittance | UV | Ultraviolet transmittance | percent | Daily minimum |
| chlorine.flow | Chlorine disinfection | Flow rate | gpm | Daily minimum and maximum |
| chlorine.influent_dose | Chlorine disinfection | Influent chlorine dose | mg/L | Daily minimum |
| chlorine.effluent_free_residual | Chlorine disinfection | Effluent free chlorine residual | mg/L | Daily minimum |
| chlorine.influent_ammonia | Chlorine disinfection | Influent ammonia | mg/L | Daily maximum |
| chlorine.influent_turbidity | Chlorine disinfection | Influent turbidity | NTU | Daily maximum |
| chlorine.influent_ph | Chlorine disinfection | Influent pH | standard units | Daily maximum |
| chlorine.influent_temperature | Chlorine disinfection | Influent water temperature | °C canonical; °F raw allowed | Daily minimum |
| membrane.effluent.turbidity | Membrane filtration | Effluent turbidity | NTU | Daily maximum; rolling 24-hour 95th percentile |
| distribution.residual.weekly | Farthest end-use fixture | Free or total chlorine residual | mg/L | Weekly observation; type required |

Alternative treatment-train parameters are tenant/profile-specific and require local approval provenance. Do not force them into a prescribed-train parameter code.

## 6. Time, statistics and unit rules

### Time

- Store event instants in UTC and retain source local time/time zone.
- Aggregate by jurisdiction-approved reporting time zone, usually site local time.
- A daylight-saving day may contain 23 or 25 hours; expected interval count reflects that.
- Ambiguous fall-back timestamps require offset, sequence or quarantine.
- Source clock drift beyond configured tolerance is a quality gap, not silently corrected.
- Late-arriving values create a new aggregate version and may reopen draft preflight.

### Statistics

- Daily minimum/maximum consider accepted values only and report coverage.
- Rolling 24-hour 95th percentile algorithm, window alignment, interpolation and sample treatment require CA engineer/jurisdiction approval before use.
- “At any time” operational critical limits are not evaluated from sparse reporting exports unless the profile explicitly establishes adequate cadence and authority.
- Never convert absence of an excursion into evidence that one did not occur.
- Each aggregate stores value, expected/observed count, coverage percentage, gap intervals, algorithm version and source set.

### Normative coverage denominator

`RequiredSeriesContract` is the sole source of required-series and denominator truth. Each approved version contains: tenant/system; process, parameter, statistic and canonical unit; activation-basis references; prescribed treatment train or approved-alternative reference; eligible lifecycle states; half-open effective range; approved cadence; jurisdiction time zone; aggregation algorithm; criticality; and, for an aggregate, the immutable ordered set of constituent contract IDs. Source/vendor mapping is a separate association.

The contract obeys these non-bypassable rules:

1. It is approved and immutable before ingest for its first expected interval. A change creates a prospective version; a governed retroactive correction creates a new version and re-evaluation record, never an in-place denominator rewrite.
2. Expected intervals tile `[max(report_start, effective_start), min(report_end, effective_end))` at the approved cadence in the approved time zone. An interval is expected when the system is in an eligible lifecycle state and it is not wholly contained in a previously authorized scheduled-nonoperation interval. An unplanned outage remains an expected gap; a partial overlap remains expected.
3. Exactly one final accepted, non-superseded observation assigned deterministically to an expected interval contributes to its numerator. Zero produces a typed gap. Extra observations are duplicate or superseded and never increase the numerator. Quarantined, rejected, ambiguous and nonfinal observations never count.
4. Coverage is `accepted_expected_intervals / expected_intervals`. A zero denominator is `not_applicable` with activation/lifecycle evidence, never 100%. Late accepted evidence produces a superseding aggregate version.
5. The required set is derived from the approved permit/profile, lifecycle and prescribed treatment train or approved alternative. A vendor contract controls only transport and source-field mapping; it cannot create or delete a required series, change cadence/effective dates or change aggregate membership.
6. A report-critical aggregate declares its complete source set before ingest. Aggregate source-interval coverage is the accepted source/interval pairs divided by all expected source/interval pairs across that set; missing constituents remain gaps. Review-ready requires every required series at least 95%, every report-critical aggregate at least 90%, and every residual gap typed and attributable.

### Units

- Canonical units above; raw unit always retained.
- Convert °F to °C with a versioned exact formula; display precision does not alter stored precision.
- Reject or quarantine unknown/sentinel strings rather than coercing to zero.
- Parameter identity includes location/process context; “turbidity” alone is insufficient.
- The synthetic `unit-conversion-rule/v1` boundary uses exact decimal source strings and an authorized effective-dated affine formula `(source + offset) × numerator / denominator`; it never infers a formula from a unit label.
- The synthetic `daily-aggregate-policy/v1` pins method, decimal places, half-away-from-zero final rounding and the contract's named IANA time zone. Intermediate converted values are not display-rounded.
- A numeric source set must exactly equal the recomputed accepted coverage winners. Duplicate, superseded, quarantined, gap and extra values cannot enter a daily result.

## 7. Data-quality dimensions

| Dimension | Examples | Product response |
|---|---|---|
| Completeness | Missing intervals, missing report field | Explicit gap/coverage |
| Validity | Impossible unit/value, malformed timestamp | Quarantine |
| Consistency | Vendor/system ID conflict, produced < used question | Candidate data-quality review, not automatic finding |
| Uniqueness | Duplicate upload/API page | Idempotent dedupe with lineage |
| Timeliness | Late or stale source | Freshness indicator/workflow reminder |
| Accuracy | Source mapping error | Dispute/replay/new version |
| Provenance | Missing file/row/mapping | Block report approval for quantitative fact |
| Calibration context | Unknown instrument calibration | Show unknown; do not infer validity |

No record is silently dropped. The ingestion receipt counts accepted, duplicate, quarantined and rejected-before-persistence records, with reasons.

## 8. Adapter and mapping approval

Each mapping requires:

- real or representative source sample;
- vendor field dictionary;
- system identity method;
- time-zone/cadence semantics;
- raw/canonical unit mapping;
- missing/sentinel behavior;
- row-level idempotency key;
- pagination/backfill behavior;
- vendor/operator confirmation;
- jurisdiction/CA engineer confirmation for parameter/statistic identity;
- golden and adversarial fixtures;
- security confirmation of read-only scope.

The mapping must reference, but cannot mutate, the applicable `RequiredSeriesContract`. Mapping approval fails if it attempts to add/delete required series, alter expected-interval math or aggregate membership, or backdate requiredness.

Mapping changes are semantic migrations. Run a dry replay, show fact/aggregate differences, obtain approval, then create superseding facts.

The synthetic CSV boundary accepts only the exact ordered header declared by its source contract. Reordered, missing or extra columns reject the source rather than guessing. Safe rows receive one accepted, duplicate or typed-quarantine outcome; quarantine and duplicate records retain the exact source hash plus record/line locator and row fingerprint, not a mutable raw-row copy. Malformed byte/grammar/header inputs are source-level rejections with no claimed row count. Durable source retention, cross-run idempotency and normalized facts remain unimplemented.

## 9. Permit, commissioning and field evidence

Minimum metadata by artifact:

- document/artifact type;
- system/permit;
- version/title;
- author/issuer and professional/certification reference where applicable;
- document, received, effective and superseded dates;
- external approval decision/source;
- confidentiality class;
- object hash/version;
- relation to requirement/profile;
- submitter and reviewer attestations.

The product validates completeness and metadata shape only. It does not validate a professional seal, engineering adequacy, treatment efficacy, commissioning outcome, cross-connection test technique or laboratory result.

## 10. Complaint, malfunction, investigation and corrective-action model

Separate concepts:

- **Complaint:** report from public, tenant, staff or other source.
- **Malfunction/anomaly:** operational event described by operator/vendor or monitoring packet.
- **Investigation:** authorized review activity and findings.
- **Notification evidence:** record that a notice was sent, to whom/when/method; product does not decide whether notice was legally sufficient.
- **Official finding:** jurisdiction-authored reference to an external determination.
- **Corrective action:** response work and closure evidence.

Personal complainant data is a separate restricted object with purpose and retention. Annual/public summaries use approved categories and generalized location.

### Statutory notification evidence

`NotificationEvidence` pins the reviewed obligation-profile version, the legally obligated actor role and the actual performing/sending party; these are separate from the authenticated user who records the evidence. It has one or more immutable `NotificationRecipientEvidence` rows with governing section, obligation type, recipient organization/person class, required method, actual method, discovery/event time, sent time, evidence object and status. V1 preflights encode these distinct obligations:

| Section/event | Required evidence |
|---|---|
| 60604 multi-parcel property | When collection, treatment or distribution spans more than one parcel, proof provided by the responsible entity to the local jurisdiction of a county-recorder-filed property covenant describing the parcel combination and the effect of sale of a parcel |
| 60684 commissioning | Commissioning report delivered within 30 days after completion to the local jurisdiction for review and approval, and separately to the public water system, sewer service provider and applicable recycled-water agency |
| 60694 before indoor supply | Before indoor supply, responsible entity documentation that tenants/residents were informed and that plumbing modifications or repairs in a building unit require responsible-entity approval |
| 60694 inadequate treatment | Local jurisdiction notified by **both phone and electronic mail** as soon as possible and no later than 24 hours after discovery; for indoor delivery, building tenants/residents receive written notice no later than 24 hours after discovery |
| 60696 decommissioning | Pre-decommissioning notice at least 30 days before work, describing inactivation/demolition/removal of mechanical/electrical equipment, abandonment/removal of internal/external pipe, other locally required activities and timeline; post-completion notice no later than 30 days afterward; each notice independently accounts for the local jurisdiction, public water system, sewer service provider and applicable recycled-water agency |
| 60706 specialist report | Certified cross-connection control specialist's written hazard-assessment, inspection or test report delivered to both the local jurisdiction and public water system within 30 days after completion |
| 60708 backflow/air-gap report | Completed backflow field-test or air-gap inspection report delivered to the local jurisdiction within 30 days after completion |
| 60710 discovered cross-connection | Local jurisdiction, public water system and building tenants/residents each notified within 24 hours; separate evidence for cease delivery/drain riser if applicable, shut potable water at service connection, uncover/disconnect, repeat inspection/test, chlorinate onsite potable system at 50 mg/L for 24 hours, then flush and obtain a locally acceptable standard bacteriological test; cause investigation, corrective actions and report; and local approval before restart |

A missing or mismatched obligated actor, recipient, action, required method, content item or deadline is explicit and blocks the corresponding evidence workflow from being marked complete. The product records external actions and never becomes the notification, emergency, plumbing-approval, treatment, sampling, filing, shutdown or restart channel. Section 60696 does not create a generic external-approval requirement.

## 11. Quarterly monitoring packet schema

Default final section 60688 draft:

1. system and reporting period;
2. daily average treated flow;
3. daily produced and used volume;
4. daily process-verification summaries for prescribed or locally approved parameters;
5. malfunctions, breakdowns, upsets, bypasses and anomalies with dates, duration, investigation/remediation response;
6. public/building occupant/tenant complaints and follow-up;
7. section 60678 residual-monitoring results;
8. locally required additional parameters;
9. gaps/quarantines/coverage and reviewer attestations;
10. evidence receipt.

Draft format is jurisdiction-configured and marked as not submitted until external submission is recorded.

## 12. Annual local-report schema

Default final 22 CCR section 60606 draft for January 1–December 31:

### A. Permits and system lifecycle

- number, location, building type and permit description for:
  - existing OTNWSs;
  - new systems first placed into service during the year, including replacements;
  - systems permanently taken out of service during the year.

### B. Source, end use and volume

- volume and types of nonpotable end uses for each untreated alternate water source treated by each OTNWS.

### C. Violations and corrective actions

- summary of violations and corrective actions, based only on authorized jurisdiction records.

### D. Complaints and malfunctions

- number and location;
- systems investigated;
- how operation/maintenance issues were resolved.

### E. Inspections

- number and summary of local-jurisdiction site inspections.

### F. Water Code monitoring-data section

Always present as a distinct section with one of three states: `configured`, `authority_pending` or `review_blocked`. Record:

- Water Code section 13558(b)(3) plus the jurisdiction/State/counsel basis used to define the implementation;
- schema/statistics and profile version;
- an explicit statement that the proposal-only continuous-monitoring min/max field is not a final section 60606 element;
- source coverage, eligibility thresholds and reconciliation;
- reviewer, approval date and unresolved questions.

`authority_pending`, `review_blocked` or sub-threshold coverage blocks the annual draft from becoming review-ready. The product exports the blocked state and underlying evidence; it does not invent the missing legal interpretation.

Coverage and authority thresholds are non-waivable. Human attestations may explain eligible residual gaps only after all applicable thresholds pass; they cannot turn a below-threshold or unresolved-authority draft into review-ready output.

An extension record can capture a written request made by February 1 and requested date up to 60 days under final section 60606(b). It never assumes approval.

## 13. Evidence receipt

A receipt is an unsigned deterministic hash manifest associated with a separate verification envelope. It is not a certificate, cryptographic signature, regulatory filing or approval. V1 uses SHA-256, immutable/versioned objects and authenticated approval audit; separately signed release artifacts, adapter allowlists and pipeline attestations do not sign or certify receipt content.

### Reconciled evidence evaluation provenance

Iteration 8 adds `reconciled-csv-evidence-evaluation/v1` as a strict composition of the existing CSV, coverage, numeric, receipt and freeze schemas. The caller supplies an independent set of one to 64 required-series contracts and exactly one matching series bundle for each contract ID/version. A mapping or available source cannot create, remove or relax that set. Each bundle supplies its reviewed CSV contract, measurement mapping, conversion rules, daily aggregate policy and zero to 64 exact source byte objects; the complete evaluation accepts at most 64 submitted source objects and 64 MiB of source bytes across all bundles.

Every bundle first derives `csv-measurement-governance-binding/v1` from its required-series contract, CSV contract, mapping and conversion-rule set, whether or not source bytes are present. Its source state is a tagged union:

- `reconciled` contains the rerun ADR-0007 result and uses its reconciliation hash as the multiplicity-sensitive `operationalHash`;
- `no_source_objects` contains the validated governance, a null result and a typed operational hash, then supplies an empty observation set so applicable expected intervals remain gaps.

`evidenceSetHash` binds the source-independent governance plus canonical unique source summaries, reconciliation outcomes, observations and numeric preimages, while deliberately excluding each source's submission count. Byte-identical delivery retries therefore preserve the evidence-set hash. The operational hash retains submitted-source multiplicity, and the root `evaluationHash` binds the complete result including that operational state; retries can change those two hashes without changing the evidence meaning.

Only reconciliation-derived observations enter coverage. The exact observation IDs that coverage classifies as accepted winners select the numeric preimages and referenced conversion rules for daily aggregation. Duplicate, quarantine, conflict, scheduled-nonoperation and lifecycle-ineligible candidates never contribute numeric values. With no accepted numeric winner, the aggregate is still a deterministic result whose `values` array is empty.

The evaluator does not accept caller-created source hashes, pinned versions, coverage summaries, receipts or frozen reports. It derives and pins globally deduplicated exact source-object hashes; required-series, CSV-contract, mapping, conversion-rule-set and aggregate-policy hashes; each retry-insensitive evidence-set hash; and each daily aggregate-evaluation hash into the existing unsigned receipt. The receipt then produces the existing deterministic version-1 frozen draft. Operational delivery multiplicity remains outside the receipt so exact retries leave the receipt and frozen-draft IDs unchanged; the outer evaluation hash preserves that operational difference.

`validateReconciledCsvEvidenceIntegrity` reproduces a retained composition result from the same exact inputs. It rejects any change to the source-state union, governance, source accounting, outcomes, coverage, aggregate, readiness, receipt, frozen draft or root hash, including coordinated changes accompanied by caller-created replacement hashes. Exact retry multiplicity must match its input, while canonically equivalent contract/bundle/source orderings reproduce the same result. Strict record and array reconstruction rejects missing, extra, symbol, accessor, custom-prototype and sparse structures; the accepted return is the new frozen replay rather than the retained object.

This is synthetic, fixed-millisecond-UTC CSV processing over in-memory bytes. It does not provide a real vendor format, durable source or normalized storage, database uniqueness, concurrent-worker idempotency, authenticated correction/supersession or a numeric report projection. Aggregate hashes are provenance pins; aggregate values are not fields in the current HTML/CSV/JSON report projection. BL-033, BL-038, BL-040, BL-042, BL-043, BL-047, BL-055 and BL-056 remain open.

### Canonical report-content projection

`ReportContentProjection` is a schema-defined JSON object built only from pinned inputs. It excludes database/runtime IDs, receipt/envelope IDs, creation/request/job times, attestations, audit references, links, URLs, confidential full contract or evaluation preimages and full coverage summaries. Its `requiredSeries` items contain exactly contract ID/version/hash, report-time basis, coverage ratio and accepted/expected/gap/duplicate/quarantine counts; they contain no interval/outcome rows, evaluation fingerprints or observation, scheduled-nonoperation, lifecycle-event or lifecycle-evidence identifiers. The internal receipt wrapper retains normalized `RequiredSeriesContract` and coverage-evaluation preimages plus full `coverage-summary/v2` results: contracts prove each report-safe descriptor and governing-contract set hash, while observations, scheduled nonoperations and lifecycle inputs allow exact semantic recomputation of each internal summary and derivation of its report-safe aggregate. It follows RFC 8785 JSON Canonicalization Scheme semantics: object keys use the specified lexicographic ordering; every array has a schema-declared stable sort key and never depends on database order; optional values are omitted, while schema-declared nulls are retained; Unicode is valid and preserved without normalization; and NaN, Infinity and negative zero are forbidden. Report decimal values use canonical decimal strings plus canonical unit/scale. Timestamps use UTC RFC 3339 with fixed millisecond precision (`YYYY-MM-DDTHH:mm:ss.SSSZ`).

### Deterministic construction

1. Pin source objects, facts, `RequiredSeriesContract`s, profiles, mappings and build version; build and canonicalize `ReportContentProjection`; compute `report_content_hash = SHA256(canonical_bytes)`.
2. Render HTML/PDF/CSV/JSON only from that projection. Generated artifact bytes may display `report_content_hash` but contain no receipt ID, envelope ID or verification URL. Hash exact bytes and create a manifest sorted by media type and logical filename, including byte length.
3. Build `EvidenceManifest` from sorted source hashes and pinned versions, governing-contract/evaluation/summary set hashes, required-series versions and reconciled accepted/duplicate/quarantine/gap counts.
4. Build `ReceiptCorePayload` from tenant/system/report period, the evidence manifest, `report_content_hash`, sorted render manifest and superseded-core hashes. Canonicalize it using the same rules; compute `receipt_core_hash = SHA256(core_bytes)` and `receipt_id = "rp1-" + lowercase_hex(receipt_core_hash)`. The core excludes runtime receipt ID, creation time, attestations, audit references, signature references and URLs, and the ID is derived rather than an input to its own hash.
5. Build `FrozenReportCore` from the exact receipt/render set and a positive report version. Version 1 has no prior snapshot; every later version requires and binds the actual immediately prior same-scope frozen report. Canonicalize the core and derive the frozen-report ID/hash. The result remains an unsigned, non-submittable frozen draft.
6. Create a separate, nondeterministic `VerificationEnvelope` pinned to that exact frozen-report ID/hash/version and its receipt, then containing created time, authenticated human attestations, audit references, same-snapshot external-submission evidence, supersession links and any independently signed control-plane bundle references. The application associates it through UI chrome or a sidecar/resolver; hashed artifacts never link back to or hash the envelope.

Identical stable inputs and pinned build versions reproduce the report-content hash, render-byte hashes, receipt-core hash and receipt ID. Human attestations and envelope creation time may differ without changing the deterministic core. Every UI and export states that the receipt means only “evidence assembled.”

### Executable iteration-3 subset

The local foundation now makes the receipt ordering executable for a synthetic evidence-coverage report:

- `report-content-projection/v3` always includes immutable report-safe contract descriptors (parameter, statistic, canonical unit, source time zone, criticality and aggregate membership), the safely recomputed exact-input coverage preflight, the unsigned/non-submittable boundary and the non-determination limitation; each `requiredSeries` item is the strict aggregate defined above, derived from an internal full summary that is itself recomputed from normalized evaluation preimages;
- `evidence-manifest/v1` binds sorted source hashes and pinned versions plus governing-contract, normalized-evaluation-input and coverage-summary set hashes and reconciled counts;
- deterministic HTML, CSV and JSON all display the report-content hash and draft/human-review boundary, while no render contains a receipt/envelope ID or verification URL;
- `receipt-core/v2` binds the evidence manifest, exact render-byte manifest and prior core hashes before deriving `rp1-<sha256>`;
- `frozen-report-core/v1` pins one receipt/render set, a positive report version and the prior snapshot hash after version 1; construction and validation also require the actual valid prior frozen report, the same tenant/system/period scope and an immediately sequential version;
- external-submission records say only that a user recorded hashed proof of an action outside ReuseProof and keep destination acceptance `not claimed`; and
- `verification-envelope/v1` is a separate hash-derived association object pinned to one exact frozen snapshot; validation requires that frozen report as the trusted subject, its runtime time and human/audit/submission references never flow back into content, render, receipt or freeze hashes, and submission evidence from another snapshot is rejected even when the receipt is shared.

Before freeze or file output, the local validator reconstructs exact outer and nested projection/core shapes, coverage-summary interval/outcome accounting, fixed 95%/90% readiness results, critical-aggregate membership, normalized-input and summary-set hashes, governing-contract preimage/metadata bindings and every render byte. It recomputes each full internal summary from the retained normalized observations, scheduled nonoperations and lifecycle basis, enforces one state/evidence meaning per lifecycle-event ID, verifies duplicate reasons against that evidence and requires the exported report-safe aggregate to equal the exact derivation. Frozen-report validation walks the retained actual prior chain, and envelope validation compares every subject field with the supplied frozen report. Recomputed outer hashes therefore do not make a semantically contradictory in-memory object acceptable. The objects remain unsigned, so this is schema and internal-integrity validation rather than source authenticity. The emitted projection never contains the full summaries or their preimages, and the emitted receipt and freeze cores retain hashes rather than the confidential contract/evaluation preimages or complete prior wrappers; durable production retention and trusted restoration of those objects remain required.

These constructors and local files are not authenticated records, durable object storage, regulatory submissions, or official report templates. Complete report sections, real retained sources, append-only audit, authorization, destination-proof review and restore evidence remain required.

Receipt claim:

> ReuseProof CA assembled the listed evidence using the identified versions. The receipt does not certify regulatory compliance, water safety, engineering adequacy, laboratory quality or legal sufficiency.

## 14. Public/private classification

| Class | Examples | Default |
|---|---|---|
| Public approved | Aggregate counts, generalized program narrative, reporting period, update date | Only after frozen approval |
| Internal | Workflow status, non-sensitive report drafts | Authenticated tenant |
| Confidential | Contracts, private contacts, complaint narratives, permit drafts | Restricted roles |
| Critical infrastructure | Exact site/coordinates, schematics, topology, control/alarm patterns, telemetry endpoints, detailed unresolved cross-connection findings | Need-to-know; never public by default |
| Secret | API tokens, credentials, keys | Secret manager only |

The classification is not a CPRA exemption determination. Jurisdiction counsel/records staff decide response and redaction.

## 15. Retention, legal hold and deletion

- Source objects, normalized facts and receipts follow a tenant-approved schedule.
- V1 proposes source/raw telemetry online for 90 days and archived per contract, but this is a hypothesis, not a default legal schedule.
- Report snapshots and receipts retain as approved government records.
- Legal hold overrides lifecycle deletion and is auditable.
- Object versioning/lock configuration must not prevent lawful correction, export or approved destruction.
- Contract exit provides documented export, then deletion certificate for data not retained/held.
- Public snapshots remain separately versioned with correction notices.

## 16. Data and evidence change process

1. Propose change with source and rationale.
2. Classify as additive, mapping correction, algorithm change, regulatory/profile change or breaking schema.
3. Run impact query and fixture replay.
4. Obtain required vendor/operator, CA engineer, jurisdiction, security and accessibility review.
5. Version; never edit history in place.
6. Recompute only affected facts/aggregates into new versions.
7. Flag frozen reports/publications affected.
8. Issue superseding receipt/correction if approved.
9. Update traceability, tests and source register.

Emergency withdrawal is permitted for security or materially wrong evidence. It preserves a tombstone and audit record rather than erasing history.
