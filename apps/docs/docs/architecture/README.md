---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/README.md
---

# NeoTavern — documentation

Index of the internal documentation. Each major topic has its own folder.

> **Architecture Convergence program (M1a, Wave 0 Governance — accepted;
> M1, Wave 1 Immediate security — open).** The governing documents
> are the [target-architecture ТЗ 10/10 rev2](https://github.com/Disya123/NeoTavern/blob/main/NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
> [ADR-0038](adr/0038-canonical-rust-kernel-core.md) (canonical Rust Kernel;
> Fastify/Drizzle is the legacy/migration contour) and
> [ADR-0039](adr/0039-legacy-compatibility-authority-boundary.md) (authority
> boundary). Capability and host statuses are tracked in the generated
> [capability matrix](capability-matrix.md) (ARC-10).
>
> **Single source tree.** This `docs/` directory is the canonical
> documentation tree. The Docusaurus site does not keep a second copy: it is
> built from a deterministic mirror of `docs/` at
> `apps/docs/docs/architecture/` produced by `scripts/docs-sync.mjs`
> (`pnpm docs:sync`). Edit files here, run `pnpm docs:sync` and commit the
> mirror together with your change; `pnpm docs:sync:check` blocks CI on any
> divergence and `pnpm docs:site:build` always syncs first. The mirror is a
> **closed tree**: `--check` enumerates the actual target directory and fails
> on any file a fresh sync would not produce, and a plain sync deletes stale
> generated files — a page smuggled into the mirror cannot reach the site.

## Sections

- [Architecture](architecture/README.md) — package boundaries, data flow, stack.
- [Capability matrix](capability-matrix.md) — capability × host statuses (generated).
- [Legacy UI surface](architecture/ui-legacy-surface.md) — baseline inventory of `/api/v2`/`legacyRaw` in production UI (ARC-02/ARC-03).
- [Operations inventory](architecture/operations-inventory.md) — current `/api/v2` surface, feature ownership/routing.
- [Product Wire Contracts](architecture/wire-contracts.md) — canonical contracts, codegen, handshake, corpus.
- [Generation durability](architecture/generation-durability.md) — Phase 6 recoverable generation workflows, state machine, SSE resume.
- [Generation run/steps and the tool-call loop](architecture/generation-run-steps.md) — M2 / Этап 2.7: durable step journal, `waiting_for_tool`, tool registry and loop guard (ТЗ §8.3).
- [Providers](architecture/providers.md) — Phase 7 provider contract, built-in adapters, secrets, conformance.
- [Portable data](architecture/portable-data.md) — Phase 11 backup container, staged restore, Portable Export, legacy converter.
- [Version axes](architecture/version-axes.md) — independent app/storage/wire/SDK versioning.
- [UX spec](ux/README.md) — user scenarios, states, accessibility, and
  acceptance criteria.
- [API](api/README.md) — REST `/api/v2`, SSE generation, error envelope.
- [Plugin SDK](plugin-sdk/README.md) — manifest, permissions, frontend/backend API, cleanup.
- [Theme SDK](theme-sdk/README.md) — tokens, skins, shells, safe mode, `data-*` hooks.
- [Prompt pipeline](prompt-pipeline/README.md) — stages, instruct formats, context shifting.
- [Data and SQLite](data/README.md) — schema, WAL/FTS5, files, cache.
- [Desktop](desktop/README.md) — Tauri 2 + Node sidecar, Web Client, updates.
- [Android](android/README.md) — WebView + JNI local host, mobile-ffi bridge protocol, Keystore secrets.
- [Migrations](migrations/README.md) — schema version, backup, rollback.
- [ADR](adr/README.md) — architectural decisions.
- [RFC / proposals](rfc/README.md) — non-canonical drafts. They do not
  replace ADR or the target-architecture ТЗ until an accepting ADR lands.
  Current NeoUI v4 items: the presentation-backend proposal (RFC **4.5**,
  Gate P **`GateP:P1` / PASSED**, M0 **`ENTERED`**, not PASS), [BaselineReport
  M-1](rfc/m1-baseline-report.md), the [M0-D1a paint-seam
  probe](rfc/m0-d1a-probe.md) (**PRE-GATE / BLOCKED**, not a compositor GO),
  and the [signed Gate P record](rfc/gate-p-decision-draft.md)
  (`GateP:P1`, 2026-08-17, incomplete physical M-1 waiver).
- [Changelog](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run server + web (dev)
pnpm build            # tsc -b + vite build
pnpm typecheck        # type-check the whole monorepo
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm test             # Vitest (backend + frontend)
pnpm docs:check       # check mandatory documents, links, capability matrix, exceptions
pnpm docs:build       # index docs/
```
