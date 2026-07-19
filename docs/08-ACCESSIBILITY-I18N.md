# Accessibility and internationalization plan

## 1. Standard, legal baseline and users

ReuseProof CA targets **WCAG 2.2 Level AA** for authenticated workflows, public pages and generated HTML. The binding customer baseline must be confirmed in procurement. Current DOJ guidance after the April 2026 interim rule identifies WCAG 2.1 AA and dates of April 26, 2027 for public entities serving 50,000 or more people and April 26, 2028 for smaller entities and special district governments. ReuseProof will not delay accessible design until a legal deadline.

Design and testing include people who use:

- keyboard only;
- screen readers;
- magnification, zoom and high-contrast/forced-color modes;
- speech input and switch controls;
- color-vision accommodations;
- captions/transcripts;
- plain language and cognitive supports;
- mobile devices in field or office settings.

Accessibility is a release requirement and procurement deliverable, not a best-effort enhancement.

## 2. Critical task inventory

Each critical task must be operable without a mouse and tested with representative assistive technology:

1. sign in through SSO/MFA;
2. select jurisdiction/system without crossing scope;
3. register/import a system and review errors;
4. upload evidence or telemetry export;
5. inspect ingestion status, gaps and quarantined rows;
6. trace a daily summary to source;
7. review and disposition a candidate exception;
8. record a complaint, malfunction, corrective action, inspection or test;
9. run report preflight and resolve a gap;
10. review/freeze/export quarterly or annual draft;
11. preview and approve a public snapshot;
12. use the public report and download accessible formats.

No conforming alternate version may be used as a substitute for making the primary workflow accessible unless customer counsel accepts a narrow lawful exception.

## 3. Interaction requirements

- Semantic HTML before ARIA; headings and landmarks follow logical order.
- Visible keyboard focus; no keyboard traps; skip links and predictable focus after dialogs/errors.
- Target sizes meet WCAG 2.2 AA; no drag-only interaction.
- Authentication does not depend on memory puzzles or inaccessible CAPTCHAs.
- Session timeout warning is perceivable and extendable when security policy permits.
- Errors identify field, cause and correction in text and programmatically.
- Status never depends on color, icon or chart alone.
- Tables support headers, captions, scope and small-screen alternatives.
- Dense grids provide a semantic table/download rather than a canvas-only view.
- Candidate-exception and official-finding states use distinct text, not only styling.
- Date/time/unit displays include zone and expanded labels.
- Auto-refresh does not steal focus; users can pause nonessential updates.
- Destructive/sensitive publication actions require clear confirmation and recovery path.

## 4. Charts, telemetry and diff accessibility

Every chart or time series provides:

- descriptive title and reporting period;
- text summary of trend, gaps and coverage without claiming compliance;
- keyboard-navigable data table or CSV;
- units and time zone;
- non-color encodings;
- zoom/reflow without two-dimensional scrolling where reasonably possible;
- explicit missing/quarantined intervals;
- source/profile link.

Receipt/report diffs provide:

- added/removed/changed text labels;
- before/after values and units;
- mapping/profile version;
- downloadable structured diff;
- no red/green-only presentation.

## 5. Document and export accessibility

### HTML

HTML is the reference accessible report format. It includes landmarks, heading hierarchy, table semantics, descriptive links, print styles and the stable `report_content_hash`. Hashed report bytes contain no receipt/envelope ID or verification URL; accessible application UI associates the separate human verification envelope after rendering, avoiding a self-hash cycle.

### PDF

Where a jurisdiction requires PDF:

- use tagged PDF with title, language, reading order and bookmarks;
- table headers repeat and associate correctly;
- images/charts have alternatives;
- links are descriptive;
- form fields, if any, have labels;
- test with PAC or equivalent plus manual screen-reader/keyboard review.

If the rendering stack cannot reliably produce an accessible tagged PDF, release HTML plus an accessible office/document export and label PDF limitations; do not claim conformance.

### CSV/JSON

- UTF-8;
- stable documented headers;
- formula-injection neutralization for spreadsheet use;
- units/time zone/schema version included;
- no color/layout dependency.

### Executable foundation status

Iteration 3 emits an English, script-free HTML reference for the synthetic evidence-coverage projection with `lang`, skip navigation, landmarks, ordered headings, definition-list metadata, an explicitly labelled scrollable table region, caption, row/column headers, parameter/statistic/canonical-unit/source-time-zone/report-time-zone metadata, UTC `time` values, print/reflow/forced-color styles, plain-text gaps and the non-determination boundary. Its CSV uses fixed UTF-8 headers, CRLF records, quoted fields, the same unit/time-zone descriptors and leading-apostrophe neutralization for spreadsheet formula prefixes; JSON is canonical, schema-versioned and carries the immutable series metadata. Tests verify semantics present in source, escaping, metadata presence, safe CSV cells and byte-for-byte reproduction.

This is implementation evidence, not a WCAG conformance claim. Automated accessibility tooling, browser layout checks, keyboard testing, 200% zoom/reflow, forced-colors inspection, NVDA/VoiceOver tasks, human plain-language review, ACR/VPAT-style reporting and jurisdiction-specific templates remain open. No PDF is emitted; a tagged-PDF implementation remains blocked until its stack passes the PDF criteria above.

## 6. Public artifact requirements

- Plain-language summary: what the local program is, reporting period, last update and product limitations.
- No inaccessible scanned-document-only publication.
- Contact/complaint information is text, not an image.
- Public snapshot indicates generalized location and explains why operational details may not be displayed.
- Corrections and superseded reports remain understandable.
- Download size/type is stated.
- Public interface works at 200% zoom and narrow viewport.

## 7. Plain language and terminology

Target:

- public summaries approximately grade 8 where technical/legal accuracy permits;
- define OTNWS, responsible entity, source, end use, candidate exception and evidence receipt on first use;
- distinguish “evidence complete” from “compliant”;
- avoid unexplained abbreviations and vendor jargon;
- include exact dates rather than relative “recent” labels;
- phrase unknowns directly: “No data was received for 2:00–3:00 PM,” not “system normal.”

Technical regulation text may remain verbatim when required, paired with a plain-language explanation that is not legal advice.

## 8. Language scope and internationalization

### V1

- English application and reports.
- Architecture supports locale-aware messages, dates, numbers and units from the start.
- User-entered narratives retain language tags.
- Do not concatenate UI strings or embed English in adapter/report schemas.
- Preserve source text; translation never replaces authoritative text.

### P1

- Human-reviewed Spanish public summary, navigation, complaint instructions and key report explanation.
- Terminology reviewed by a California water/public-health translator and community representative.
- Machine translation may create a marked draft only; no unreviewed regulatory/publication text.

### Later

Additional languages chosen from pilot-jurisdiction language-access obligations and community need, not national market convenience.

## 9. Test matrix and release evidence

| Layer | Method | Frequency |
|---|---|---|
| Component | eslint accessibility rules, axe, semantic tests | Every PR |
| Critical workflow | Playwright keyboard/focus and axe | Every PR/nightly |
| Manual AT | NVDA/Chrome or Firefox; VoiceOver/Safari; keyboard; zoom; forced colors | Each release candidate |
| Mobile/reflow | iOS/Android browser and 320 CSS px viewport | Each release candidate |
| Reports | HTML semantics; PDF tag/reading-order/manual review; CSV | Each template change |
| Usability | At least 5 participants including 2 disabled users across pilot | Before pilot and release |
| Language | Human terminology/translation review | Each localized release |

Release evidence:

- accessibility test plan and results;
- defect list with severity/remediation dates;
- ACR/VPAT-style conformance report;
- known-limitations page and accessible support route;
- procurement mapping to customer requirements;
- regression test artifacts.

No open critical accessibility defect may block a core report, review, complaint or public-information task at release.
