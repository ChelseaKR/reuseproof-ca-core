# 0. Record architecture decisions

## Status

Accepted

## Context

ReuseProof CA makes a small number of consequential, hard-to-reverse decisions
— the binding read-only V1 boundary, deterministic time and lifecycle
semantics, the report-freeze/receipt scheme. This is a solo project: when the
maintainer's attention moves elsewhere for a while, the reasoning behind a
structural choice must not live only in a commit message or a closed PR
thread, or a later change will either re-litigate a settled question or
unknowingly reverse a decision made for a reason nobody re-reads. ADRs 0001–
0003 already existed in `docs/decisions/`; this record formalizes the practice
and the location.

## Decision

We will record architecture decisions in **Architecture Decision Records
(ADRs)** using the format described by Michael Nygard.

- Each ADR is a short Markdown file in `docs/adr/`, numbered sequentially and
  named `NNNN-title-in-kebab-case.md`.
- Each ADR has the sections **Title**, **Status**, **Context**, **Decision**,
  and **Consequences** (the pre-existing ADRs 0001–0003 use an equivalent
  richer shape with decision owners and required reviewers; both are valid).
- **Status** is one of *Proposed*, *Accepted*, *Deprecated*, or *Superseded*.
  A superseded ADR is not deleted; it is marked superseded and points to the
  ADR that replaces it, and the replacement points back.
- ADRs are immutable once accepted, except to change their status. A new
  decision is a new ADR, not an edit to an old one.

This ADR establishes the practice; ADRs 0001–0003 (previously in
`docs/decisions/`, relocated to `docs/adr/` with this record) are the seed set.

## Consequences

- The reasoning behind structural decisions is preserved and versioned
  alongside the code it explains.
- Writing an ADR is a small, deliberate friction on consequential change —
  intended, since it makes reversing a load-bearing decision a visible act
  rather than an accident.
- ADRs capture decisions, not the full design — the public product,
  architecture, evidence, safety and operations documents remain the
  authoritative record for this repository's published scope.
