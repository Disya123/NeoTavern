# NeoTavern — documentation

Index of the internal documentation. Each major topic has its own folder.

> **Architecture Convergence program (M1a, Wave 0 Governance — accepted;
> M1, Wave 1 Immediate security — open).** The governing documents
> are the [target-architecture ТЗ 10/10 rev2](../NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
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
- [Presentation boundary](architecture/presentation-boundary.md) — Milestone A **PASS** (flagged Dioxus Product Wire shell); WebView rollback.
- [Known baseline failures](architecture/known-baseline-failures.md) — `KNOWN_BASELINE_FAILURE` fingerprints; not a green full baseline; not a B PASS waiver.
- [PresentationCompatibilityMatrix](rfc/presentation-compatibility-matrix.md) — baseline after D1/D2 GO (not cutover).
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
  Gate P **`GateP:P1` / PASSED**, technical M0 **PASS**), [BaselineReport
  M-1](rfc/m1-baseline-report.md), the [M0-D1a paint-seam
  probe](rfc/m0-d1a-probe.md) (**M0-D1a PASS** host-side; probe
  `capture=false`; not a compositor GO), the [M0-D1a physical capture
  runbook](rfc/m0-d1a-physical-runbook.md) (RenderDoc v1.45; admitted Vulkan
  stamp `2026-08-17T17-18-59-431Z`; GLES 1437-byte file is
  `WRONG_API_CAPTURE`), the [host adjudication
  record](rfc/m0-d1a-adjudication.json), the [M0-D1b moving
  sample](rfc/m0-d1b-probe.md) (**M0-D1b PASS** host-side; probe
  `capture=false`), the [M0-D1b host adjudication
  record](rfc/m0-d1b-adjudication.json), the [M0-D1b
  physical capture runbook](rfc/m0-d1b-physical-runbook.md), the [M0-D2
  producer seam](rfc/m0-d2-probe.md) (**M0-D2 PASS** host-side; probe
  `capture=false`; [physical
  runbook](rfc/m0-d2-physical-runbook.md); [admission](rfc/m0-d2-adjudication.json)),
  the [TrackComparison](rfc/m0-track-comparison.md), the [signed D1/D2
  record](rfc/d1-d2-decision.md) (`D1=Track D GO`, `D2=Dioxus+Blitz GO`,
  `D3=DEFERRED`, 2026-08-18), the [PERF-18/19/20 host
  adjudication](rfc/perf-18-20-adjudication.json), the [shared-device interop
  host adjudication](rfc/shared-device-interop-adjudication.json)
  (`PASS` on physical Vulkan; Milestone B STARTED), the [input-to-present
  host adjudication](rfc/input-to-present-adjudication.json)
  (`PASS` on physical Vulkan / locked 120 Hz; Milestone B STARTED; raw p99
  `20.65 ms` is a reference-device baseline), the [Milestone B-exit
  registry](rfc/milestone-b-exit.json) (machine-checkable; refuses B PASS
  while PERF-01…05 / PERF-11…22 evidence, physical device-loss, or open
  baseline failures remain), the [PERF-15](rfc/perf-15-adjudication.json)
  (`PASS` on Xiaomi / Vulkan; trusted VisualSurfaceFrameIngress, not Plugin SDK),
  [PERF-22](rfc/perf-22-adjudication.json) (`PASS`),
  [device-loss](rfc/device-loss-adjudication.json) (`PASS`) records, and the [signed Gate P
  record](rfc/gate-p-decision-draft.md) (`GateP:P1`, 2026-08-17, incomplete
  physical M-1 waiver).
- [Changelog](../CHANGELOG.md).

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
