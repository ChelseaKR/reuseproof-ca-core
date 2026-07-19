# Public roadmap

ReuseProof CA Core is the open-source deterministic evidence-domain layer. It
does not contain customer data, jurisdiction-specific configurations,
deployment infrastructure, implementation schedules or commercial plans.

## Current priorities

1. Preserve deterministic, reproducible coverage, aggregation, rendering,
   receipt and frozen-draft behavior.
2. Keep all ingestion read-only toward water systems and fail closed on
   ambiguous, malformed or incomplete evidence.
3. Expand synthetic conformance fixtures for bounded source formats and
   jurisdiction-approved profiles without publishing real operational data.
4. Maintain exact provenance and a strict separation between internal evidence
   preimages and report-safe projections.
5. Keep the library boundary accessible to independently reviewed adapters and
   future hosted implementations.

## Contribution boundary

Public contributions should be independently testable with synthetic fixtures
and must preserve the non-goals and safety constraints in the README. Do not
submit real jurisdiction records, site details, telemetry endpoints, personal
information, credentials or confidential vendor material.

Potential hosted-product features are deliberately not promises or scheduled
commitments. A proposal may be declined when it depends on legal interpretation,
operational control, real customer data or a jurisdiction-specific decision.
