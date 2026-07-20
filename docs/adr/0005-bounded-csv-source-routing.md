# ADR-0005: Bounded CSV source-contract and routing boundary

- **Status:** accepted for the synthetic local foundation
- **Date:** 2026-07-18
- **Deciders:** product/engineering foundation owner; vendor/operator, jurisdiction mapping and security review still required
- **Related backlog:** BL-030, BL-033, BL-034, BL-038
- **Supersedes:** no earlier ADR; extends ADR-0001 and ADR-0002

## Context

The foundation had transport-only vendor field mappings and deterministic downstream coverage, aggregation and receipt behavior, but no executable source contract or CSV ingestion boundary. Passing decoded text or caller-created row objects directly into normalization would discard exact source bytes, hide malformed UTF-8/CSV behavior, make replay fingerprints ambiguous and allow unbounded parser work. Conversely, claiming record-level accounting for a file whose grammar cannot be parsed would invent evidence.

This remains a local synthetic boundary. It does not upload, malware-scan, retain or authorize an evidence object; stream from object storage; enqueue work; normalize measurements; or implement any real vendor contract.

## Decision

Adopt `csv-adapter-source-contract/v1` and `csv-ingestion-result/v1` with these rules:

1. The source contract is transport-only and pins tenant/system scope, adapter and mapping versions, source schema, half-open effective range, exact ordered columns, source-row requiredness, row-identity fields, informational delivery cadence, review references and parser limits. It contains no regulatory required-series, coverage cadence or aggregate-membership authority.
2. Input is an exact `Uint8Array` snapshot. Hash the bytes before routing and decode with fatal UTF-8 semantics. A leading UTF-8 BOM is allowed but remains part of the source-object hash.
3. Accept comma-delimited customer-pushed CSV only. Support LF/CRLF records, quoted commas, escaped quotes and normalized embedded newlines. Reject lone carriage returns, quotes inside unquoted fields, trailing content after a closing quote and unterminated quotes.
4. Apply immutable hard ceilings of 10 MiB, 100,000 data records, 256 columns and 64 KiB per field; each contract may select only equal or lower limits. The current 10 MiB ceiling is deliberately below the planned hosted pilot's provisional 100 MB envelope until streaming and load evidence exist.
5. Treat byte/UTF-8/grammar/record-limit/header failures as one `rejected_before_persistence` source disposition with no claimed record count. Do not expose partial row outcomes for an unsafe source.
6. Once the source is syntactically accepted, route every data record exactly once as accepted, duplicate or quarantined. Column-count, field-size, required-field and identity-field failures are typed quarantines. Duplicate identity is deterministic first-record-wins within the source.
7. Accepted rows carry a frozen column/value snapshot for the next synthetic mapping step. Duplicate and quarantine outcomes retain only hashes and source row/line locators, not a mutable raw copy.
8. Content-address the normalized contract, exact source object, each row, each identity and the complete routing result. Replaying the same bytes and contract reproduces all outcomes and hashes.

This result proves bounded parsing and accounting only. It does not prove malware safety, measurement validity, correct parameter mapping, accepted database persistence, cross-file idempotency, vendor approval or regulatory sufficiency.

## Consequences

Benefits:

- exact source bytes and contract versions anchor deterministic replay;
- malformed sources cannot leak partially trusted rows downstream;
- every syntactically safe data record receives one explainable outcome;
- header drift and duplicate identity cannot be silently guessed; and
- raw quarantine values remain in the future immutable source object rather than being copied into mutable records.

Costs and limits:

- the local implementation parses one bounded byte array in memory rather than a storage stream;
- duplicate detection is source-local and does not replace durable cross-run idempotency;
- only one strict comma-delimited UTF-8 shape is supported;
- accepted values are still raw strings and require mapping, timestamp, unit, sentinel and system validation; and
- a rejected malformed source has no row count by design.

## Alternatives considered

- **Accept pre-decoded text:** rejected because invalid UTF-8 and exact source-byte identity would be lost.
- **Best-effort parsing after malformed CSV:** rejected because row boundaries after a grammar error are not trustworthy.
- **Allow reordered or extra columns:** rejected because silent schema drift could remap values; a new contract/version is required.
- **Copy raw quarantined rows:** rejected because the immutable source object plus locator is the authoritative preimage.
- **Use a third-party CSV parser immediately:** deferred; the bounded grammar is small, fully covered and avoids adding a dependency before real vendor shapes determine streaming requirements.
- **Claim BL-034's 100k streaming gate:** rejected because the parser is bounded but still in-memory and has no object-store or worker integration.

## Verification and release impact

Automated tests cover strict contract reconstruction, hard limits, exact headers, BOM/fatal UTF-8, LF/CRLF, quoted commas/newlines/quotes, malformed grammar, record overflow, accepted/duplicate/quarantine accounting, all row quarantine reasons, source-local replay, line locators, Unicode field-byte limits, buffer snapshotting and content hashes. These primarily advance ISO/IEC 25010 functional suitability, reliability, security, performance efficiency, compatibility and maintainability.

This ADR does **not** close BL-030, BL-033, BL-034 or BL-038. Remaining gates include presigned quarantine upload, magic-byte and malware/archive scanning, immutable source retention, streaming 100k-row proof, worker/dead-letter behavior, real source schemas, timestamp/unit/sentinel normalization, cross-run persistence/idempotency, quarantine remediation, 95% accepted yield and full ingestion reconciliation.

## Rollback

Because no durable production source or result exists, rollback is removal of the CSV module, export and synthetic tests. Once another system retains either schema, validators and routing semantics must remain available by version; source hashes, row locators and outcomes cannot be rewritten.
