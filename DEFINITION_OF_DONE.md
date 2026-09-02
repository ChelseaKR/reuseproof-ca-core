# Definition of Done

This definition applies to the current headless, synthetic ReuseProof CA foundation. It does not declare the planned V1 web application production-ready.

## Merge auto-gate

A change is mergeable only when the single repository gate, `make verify`, passes locally and in GitHub Actions. That gate must continue to include:

1. frozen dependency installation with `npm ci`;
2. Prettier formatting and zero-warning ESLint;
3. strict TypeScript type checking;
4. Vitest branch coverage, including the 95% per-file safety-core floor;
5. a production build;
6. execution of the documented demo against the shipped synthetic fixture;
7. a blocking high-severity `npm audit`; and
8. source-marker hygiene.

The CI workflow may set up the pinned runtime and cache, but it calls only `make verify` for repository validation so CI and local behavior cannot drift.

**No gate may report success for a check it did not perform.** A gate that finds nothing to examine — no source files, no SARIF, a threshold key matching no file — fails, and says so; it never reports a clean result for a scan that did not happen. A gate that passes states what it covered, so a green line is not read as "nothing found" when it means "nothing was looked at". See ADR-0011, and ADR-0010 for the same rule applied to the CodeQL SARIF gate.

## Review gate

- Acceptance criteria and the affected ISO/IEC 25010 characteristics are named.
- New or changed evidence logic has positive, boundary, replay/idempotency, and fail-closed tests as applicable.
- Syntactically unsafe source files fail before row persistence; every syntactically accepted data record receives exactly one deterministic routing outcome.
- Required-series denominators remain independent of vendor mappings.
- Missing or ambiguous evidence cannot become a favorable result.
- Numeric aggregates must reuse the exact accepted coverage winners, authorized effective-dated unit rules, exact decimal arithmetic and an explicit final rounding policy.
- Receipt cores remain deterministic, unsigned, non-self-referential, and limited to the claim “evidence assembled.”
- No code or documentation claims regulatory compliance, water safety, engineering adequacy, laboratory quality, legal sufficiency, or filing approval.
- Changes to an expensive-to-reverse architecture, public contract, or safety boundary include an ADR.
- Documentation, threat-model impact, observability impact, and rollback are updated or explicitly marked not applicable with a reason.
- Only synthetic data is committed; secrets, personal data, critical-infrastructure details, and real operational evidence are prohibited.
- Workflow, dependency, and evidence-integrity paths receive code-owner review.

## Current bounded and N/A declarations

- Accessibility: the foundation now emits semantic, script-free English HTML plus CSV/JSON and runs structural, escaping, deterministic-byte and CSV-injection tests. Full WCAG 2.2 AA automation, keyboard/zoom/forced-color checks, NVDA/VoiceOver review, ACR/VPAT evidence and jurisdiction-template review remain release gates. PDF remains deliberately unimplemented until a tagged-PDF path passes separate automated and manual validation.
- Internationalization: executable artifacts are explicitly English-only; no translated or interactive application surface exists yet.
- AI evaluation: the product contains no model, prompt, retrieval, or automated decision feature.
- Service observability: there is no deployed service or runtime request path.
- Hosted performance: this is an in-memory domain library with no latency SLO; resource exhaustion is bounded by interval, decimal/rule and CSV byte/record/column/field limits.
- Deployment and release provenance: there is no deployable service, container, or published package in this iteration.

These declarations must be revisited in the PR that introduces the corresponding surface. Any production release additionally requires responsible-tech artifacts, security scans, accessibility evidence, SBOM/provenance, operational runbooks and authorized governance review outside this public core repository.

Last reviewed: 2026-07-14
Review cadence: quarterly and whenever a new product surface is introduced.
