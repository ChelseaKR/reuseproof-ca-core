# Contributing to ReuseProof CA

Thank you for considering a contribution. ReuseProof CA handles a domain —
regulatory evidence for California onsite treated nonpotable water systems —
where correctness boundaries are safety boundaries, so contributing here
carries one obligation beyond the usual: never let real jurisdiction, permit,
monitoring or personal data reach the repository.

If you have not yet, read [`README.md`](README.md) for what the project is and
why (especially the **Working principles** and **Non-goals** sections),
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) for what "done" means here,
and [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.

## Project independence

ReuseProof CA is an independent, personal project. It is not affiliated with,
sponsored by, or endorsed by any employer, client, government agency, or the
California State Water Resources Control Board, and it contains no
proprietary, confidential, or client material. Please keep it that way: do not
contribute anything you do not have the right to release under Apache-2.0.

## The no-real-data rule (read this first)

**Never paste real jurisdiction, system, permit, monitoring, incident or
personal data into an issue, a pull request, a commit, a log, a screenshot, a
test, or a fixture.** Reproduce bugs with the synthetic fixtures under
[`fixtures/`](fixtures/) and [`tests/`](tests/). If a fixture you need doesn't
exist yet, add a synthetic one rather than reaching for anything real.

## Getting set up

The project targets Node.js 22.13+ (see [`.nvmrc`](.nvmrc)) and uses npm with
a committed `package-lock.json` for a reproducible environment:

```sh
npm ci
```

## The merge gate

A change merges when the full gate is green. Reproduce it locally with:

```sh
make verify
```

`make verify` runs **format-check + lint + typecheck + test/coverage + build +
npm audit + marker hygiene** — the exact same target `ci.yml` and
`release.yml` invoke, on the same locked (`npm ci`) toolchain, so green
locally means green in CI: there is no second, drifted reimplementation of the
gate.

| Gate | Command | What it checks |
| --- | --- | --- |
| Format | `npm run format:check` | Prettier formatting |
| Lint | `npm run lint` | ESLint with `--max-warnings 0` |
| Type | `npm run typecheck` | `tsc --noEmit` over the full project |
| Test + coverage | `npm run test:coverage` | Vitest with V8 coverage |
| Build | `npm run build` | `tsc -p tsconfig.build.json` |
| Dependency audit | `npm audit --audit-level=high` | Known-vulnerable dependencies |
| Marker hygiene | `npm run hygiene` | Every `TODO`/`FIXME`/`HACK` names an issue |

Optionally install the pre-commit hooks (Prettier, ESLint, hygiene, gitleaks
secret scan) so problems surface before a commit exists:

```sh
pre-commit install
```

## Determinism is a feature

Coverage summaries, report projections, render bytes, receipts and frozen
drafts are deterministic and content-addressed by design. A change that makes
any hashed artifact nondeterministic (map iteration order, locale-dependent
formatting, wall-clock reads, floating-point drift) is a correctness bug even
if every test still passes — add a test that would have caught it.

## Commit style: Conventional Commits

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
`chore`. A breaking change is marked with `!` after the type/scope and
explained in a `BREAKING CHANGE:` footer.

## ADRs: record significant decisions

Any decision that is hard to reverse or that shapes the architecture, the
product boundary, or a public interface gets an **Architecture Decision
Record** in [`docs/adr/`](docs/adr/), following
[`docs/adr/0000-record-architecture-decisions.md`](docs/adr/0000-record-architecture-decisions.md).
Superseding an earlier decision means marking the old ADR superseded, not
deleting it.

## Pull requests

Open a PR against `main`. The short version of the checklist:

- `make verify` is green.
- No real jurisdiction/system/personal data appears anywhere in the diff —
  synthetic fixtures only.
- An ADR is added if you made a significant decision.
- Docs are updated to match the change, and [`CHANGELOG.md`](CHANGELOG.md)'s
  `[Unreleased]` section gets an entry for user-visible changes.

## Reporting bugs and security issues

- **Security issues:** do **not** open a public issue — see
  [`SECURITY.md`](SECURITY.md).
- **Ordinary bugs:** open a GitHub issue, reproduced with synthetic fixtures.

## Versioning and releases

The project follows [Semantic Versioning](https://semver.org/). Releases are
tagged `vX.Y.Z`; the release workflow re-runs `make verify` at the tagged
commit and refuses to release a tag whose `CHANGELOG.md` has no matching
section.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license. You must have the right to release
what you contribute, and it must contain no proprietary or client material.
