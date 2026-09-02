# ADR-0003: Deterministic report freeze and accessible artifact boundary

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-14
- **Deciders:** product/engineering foundation owner; independent accessibility, security, regulatory and jurisdiction review still required
- **Related backlog:** BL-055, BL-056, BL-057
- **Supersedes:** no earlier ADR; extends ADR-0001 and ADR-0002

## Context

The prior slice could hash one canonical JSON report projection and derive an unsigned receipt ID, but it did not freeze a report version, render the documented HTML/CSV/JSON set, model the separate human envelope, record proof of an external submission action, or publish a complete bundle atomically. Treating any runtime time, human attestation, verification link or receipt ID as render input would create nondeterminism or a self-hash cycle. Treating a submission record as a product filing or destination acceptance would also exceed V1's authority boundary.

The implementation remains a local synthetic foundation. There is no authenticated user, jurisdiction-approved report schema, durable object store, external destination integration, browser application or real regulatory evidence.

## Decision

Adopt a one-way five-layer pipeline:

1. Build `report-content-projection/v3` only from stable evidence inputs. It is always unsigned and non-submittable, includes report-safe immutable series descriptors (parameter/statistic/unit/source time zone/critical aggregate membership), always includes the exact-input data-coverage preflight, and states the non-determination limitation. Its `requiredSeries` collection is a strict aggregate containing only contract ID/version/hash, report-time basis, coverage ratio and accepted/expected/gap/duplicate/quarantine counts. Retain normalized governing-contract and coverage-evaluation preimages plus full coverage summaries on the internal receipt wrapper so validation can derive every descriptor and governing set hash, rerun interval/outcome semantics and prove the aggregate while keeping interval/outcome rows, fingerprints and evidence-routing identifiers out of rendered artifacts.
2. Hash the canonical projection before rendering. Render deterministic, script-free HTML, spreadsheet-safe CSV and canonical JSON from that projection plus its content hash. Hash exact UTF-8 bytes and sort the manifest by media type then fixed logical filename.
3. Build `evidence-manifest/v1` from sorted source hashes and versions, the exact governing-contract/evaluation/summary set hashes, series versions and reconciled counts. Place it, the content hash, render manifest and sorted prior-core hashes in `receipt-core/v2`; derive `rp1-<lowercase sha256>` after canonicalization.
4. Build `frozen-report-core/v1` from one receipt and render manifest, a positive version and a prior snapshot hash for every version after 1. The constructor and validator must also receive and validate the actual immediately prior frozen report, require identical tenant/system/report-period scope and walk the chain to version 1. It remains a frozen **draft**, unsigned and non-submittable. Derive its ID from its own canonical core; exclude runtime times and human facts.
5. Associate runtime facts only through `verification-envelope/v1`, whose subject is one exact frozen-report ID/hash/version and receipt. Envelope integrity validation requires that exact frozen report rather than trusting self-consistent subject fields. Its constrained human-review, audit, supersession, independently signed control-plane reference and same-snapshot user-recorded external-submission fields do not flow back into content, render, receipt or freeze hashes. An external-submission record says the action occurred outside ReuseProof and that destination acceptance is not claimed.

Every output boundary revalidates the links rather than trusting an object because its internal hashes happen to agree. Revalidation reconstructs exact-key outer and nested projection/core schemas, recomputes full coverage summaries from normalized observations/nonoperations/lifecycle inputs, derives the report-safe aggregates exactly, checks fixed thresholds/reasons/claims, critical-aggregate membership, scope, governing-contract preimage/descriptor bindings, normalized-input/summary-set hashes, the prior frozen-report chain and render bytes. The exported renderer independently verifies that its displayed content hash equals the canonical projection hash. The local file writer accepts no caller-selected filename: it stages five fixed files with exclusive creation and mode `0600`, syncs files/directories and exposes the completed `artifacts` directory with one rename inside a unique private container. On stage, write, rename or sync failure it attempts recursive container cleanup; if descriptor or container cleanup also fails, one aggregate error preserves both the primary and cleanup failures and the private container may require operator cleanup.

The writer has a matching reader. `verifyFrozenReportBundleAtPath` re-derives the same links from the five files on disk and trusts nothing still held in memory: `report-freeze.json`'s own bytes yield the snapshot ID, that document names the exact receipt-core hash and derived receipt ID, and the two cores must agree on one canonically ordered render manifest whose declared byte lengths and digests every rendered artifact then satisfies. Control-file bytes must round-trip through canonicalization unchanged, carry exactly the fields their pinned schema version declares, and keep the unsigned, non-submittable, frozen boundary. Decoding is fatal rather than substituting, because a lossy decoder would turn corrupt bytes into U+FFFD and let damaged evidence reach the hash comparison as though it were merely different. Every refusal is a typed `FrozenBundleVerificationError` naming a machine-readable reason, and there is deliberately no partial or best-effort result, so a bundle that could not be checked never returns a verification.

## Canonical and accessibility rules

- UTF-16 code-unit ordering, valid non-normalized Unicode, finite JSON numbers, no negative zero, fixed-millisecond UTC time and explicit schema nulls follow the existing restricted RFC 8785-compatible boundary.
- Projection, readiness, manifest and association arrays use schema-declared deterministic sort keys, so caller order cannot change their stable hashes. Ordered contract/evidence fields remain part of their governing preimage and must be versioned if their declared order changes.
- The HTML reference has English language metadata, skip navigation, landmarks, ordered headings, definition-list scope metadata, captioned row/column-header tables, text equivalents for coverage/gaps and print/reflow/forced-color styles. It has no script or external link.
- CSV has a fixed documented header including parameter, canonical unit and source/report time zones, CRLF rows, quoted UTF-8 cells and neutralizes formula-capable leading characters after optional whitespace before quoting.
- JSON is a canonical wrapper that names the content hash, draft state, claim, limitation and complete report-content projection.
- Every rendered artifact displays the report-content hash and contains no receipt/envelope ID or verification URL.

## Consequences

Benefits:

- identical stable inputs reproduce content, all render bytes, manifest, receipt core/ID and frozen snapshot;
- runtime human records may legitimately differ without invalidating the deterministic evidence receipt;
- report version/supersession is explicit rather than an implicit mutable “latest” lookup;
- spreadsheet and HTML output have a bounded safety/accessibility baseline; and
- a crash cannot expose a partially populated `artifacts` directory through the local writer; and
- a written bundle can be re-checked later from its own bytes, so the manifest keeps governing the artifacts after they leave memory.

Costs and limits:

- schema versions advance to projection v3 and receipt-core v2;
- exact bytes, including whitespace/CSS, are part of the receipt and require intentional versioning when changed;
- the reference HTML is deliberately plain and English-only;
- a unique container path is runtime-specific even though every file byte is deterministic;
- local fsync/rename is not dual-region durable acknowledgement or an adversarial shared-directory security boundary; and
- on-disk verification proves byte integrity, not authenticity. Because the bundle is deliberately unsigned there is nothing to forge: anyone holding this tool can regenerate a wholly self-consistent bundle, so the check detects alteration of a bundle, never forgery of one. It is sound only against an independently recorded snapshot ID, which the verifier returns for that purpose, and one bundle cannot prove the predecessor a superseding snapshot names.

## Alternatives considered

- **Put receipt/envelope IDs in rendered files:** rejected because it creates a self-reference or requires an unstable second render.
- **Hash semantic data but not exact render bytes:** rejected because it cannot prove which human/download artifact was reviewed.
- **Use one mutable report record with `latest` joins:** rejected because later evidence or mapping changes could silently alter a frozen draft.
- **Let ReuseProof create a “submitted” or “accepted” state:** rejected because V1 has no authority or supported interface to file with or speak for an external destination.
- **Generate PDF now:** rejected until a stack can demonstrate tags, language, reading order, table associations and manual assistive-technology results. HTML remains the reference format.
- **Write files directly into the final directory:** rejected because interruption could expose a partial bundle.

## Verification and release impact

Automated tests cover positive construction, stable replay/reordering, changed-input hashes, fixed output names/media types, manifest byte lengths/hashes, HTML semantics/escaping/no-script, CSV injection neutralization, JSON canonicalization, zero-denominator text, version/supersession state, null retention, envelope independence, malformed runtime times/IDs/hashes, cross-receipt/duplicate associations, tamper revalidation, file modes and byte-for-byte staged-output reproduction. These primarily advance ISO/IEC 25010 functional suitability, security, reliability, compatibility, maintainability and accessibility/usability characteristics.

This ADR does **not** close BL-055–057 or any V1 release checklist item. Remaining gates include complete quarterly/annual schemas, real source retention and restoration, database/RLS/auth/audit, jurisdiction-approved templates, two-jurisdiction UAT, real destination-proof review, hosted atomic/durable storage, browser and automated accessibility evaluation, keyboard/zoom/forced-color/NVDA/VoiceOver review, ACR/VPAT-style evidence, tagged PDF if required, security review and governance approval.

## Rollback

Because no durable production data exists, rollback is removal of the v3 projection/v2 receipt, lifecycle/render/output modules and synthetic tests, followed by restoration of the v2 projection/v1 JSON-only receipt. Once any external system retains these artifacts, rollback must instead preserve the old validators/renderers by schema version; existing hashes and IDs cannot be rewritten or silently migrated.
