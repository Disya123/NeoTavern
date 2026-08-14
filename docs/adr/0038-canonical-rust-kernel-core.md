# ADR-0038: Canonical Rust Kernel Core — Architecture Convergence decision

Date: 2026-08-13. Status: Accepted — **Milestone 1a / Wave 0 (Governance)**
accepted 2026-08-13; **Milestone 1 / Wave 1 (Immediate security) remains
open** (SEC-01 SecretStore hardening, SEC-02 legacy allowlist export, plugin
networking and package verification — tracked in
[release-manifest.json](../release-manifest.json) and
`docs/architecture/exceptions.json`).
Related documents: [Target architecture ТЗ 10/10 rev2](../../NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
[Architecture](../architecture/README.md), [Wire contracts](../architecture/wire-contracts.md),
[ADR-0029](0029-wire-contract-toolchain.md), [ADR-0033](0033-desktop-local-kernel-transport.md),
[ADR-0039](0039-legacy-compatibility-authority-boundary.md).

## Context

NeoTavern currently contains two partially overlapping product contours:

1. a mature product contour `React → Fastify → Drizzle → app.db` that holds the
   bulk of the feature surface, the prompt pipeline and production providers;
2. a target contour `React → Product Wire → Rust Runtime Kernel →
database.sqlite` that owns strong storage/recovery primitives and native
   hosts but has not reached functional parity.

The Desktop shell historically defaulted to the Kernel (ADR-0033), while a
significant part of the UI still talks to `/api/v2` or `legacyRaw()` — in
kernel mode those calls degrade to typed `UnsupportedError`s. `app.db` and
`database.sqlite` have different schemas and migration stacks; the Kernel
carries no production provider and no full prompt pipeline; Android does not
yet bundle finished web assets; profile export, plugin networking and package
verification have open security gaps; and `AGENTS.md` still names the
Fastify/Drizzle/Node-sidecar stack as the approved core while newer
documentation and code describe the Rust Kernel.

The architectural risk is not the quality of individual components but the
existence of two owners of product logic and data. This ADR is the decision
record the Architecture Convergence program (ТЗ 10/10 rev2 §4, §28) requires
before any migration work can be declared.

## Decision

- **The Rust Runtime Kernel is the canonical application core of NeoTavern.**
  It is the single owner of product logic and persistent state. All new
  product logic is implemented in the Kernel; any exception requires a
  separate ADR.
- **The Fastify/Drizzle contour is placed into legacy/migration mode.** It is
  feature-frozen: no new product features are added to it, only security
  fixes, defect fixes and migration bridges (each tracked in
  `docs/architecture/exceptions.json`). It is an explicitly installable
  compatibility/migration adapter, never a second product core, and it never
  gains access to the canonical database as a writer.
- **Canonical storage.** The canonical database filename is `database.sqlite`
  (already `DB_FILE_NAME` in `crates/storage/src/paths.rs`). The data-root
  layout uses immutable versioned roots with a small active-root pointer and a
  durable activation journal — fixed by ADR-0041. **Live dual-write between
  `app.db` and `database.sqlite` is prohibited.**
- **Fate of the legacy stack.** Fastify: legacy/migration adapter, removed at
  the stage-6 cleanup of the program. Node sidecar: the legacy host adapter —
  the **public release default while the Kernel is a Preview**, forceable via
  `NEOTA_LEGACY_SERVER=1` — removed with Fastify at the stage-6 cleanup.
  TypeScript provider adapters (`packages/provider-sdk` adapters): legacy
  surface, replaced by Rust adapters behind the provider port; the provider
  contract itself stays a single port.
- **Support tiers and host policy** (per capability matrix, ARC-10): the
  Desktop HOST ships public builds on the tested legacy sidecar today (a
  Released product); the **Kernel capability on Desktop reaches `Released`
  only after the M2 exit gate** (golden packaged Kernel E2E). Headless —
  Released after the data convergence milestone; Android — Experimental until
  the data convergence milestone; Web Client — Remote-only (see ADR-0043).
  Capabilities are reported with the statuses
  Designed/Implemented/Integrated/Packaged/Released/Deprecated only.
- **Honest Desktop default (staged).** Public builds temporarily default to
  the tested legacy sidecar; the Kernel is shipped as an explicit Preview
  (marked in the DiagnosticsPanel as **Kernel Preview** and in release
  metadata). Kernel becomes the default for nightly/internal builds only. The
  public default switches to the Kernel only after the release gate passes:
  all mandatory Desktop capabilities are `Packaged` in the capability matrix,
  migration and rollback are verified on packaged artifacts, no silent
  fallbacks exist and no P0 defects are open. Mode selection in
  `apps/desktop/src-tauri/src/lib.rs` is release-channel-aware
  (`NEOTA_DESKTOP_CHANNEL=nightly` → Kernel default; unset or `release` →
  sidecar default) with explicit runtime overrides `NEOTA_LEGACY_SERVER=1`
  (force sidecar) and `NEOTA_KERNEL=1` (force Kernel). **Conflict policy:**
  when both overrides are set, `NEOTA_KERNEL=1` wins (the Kernel is the
  canonical plane and the direction of travel) and the shell prints a warning
  to stderr; the full mode matrix is unit-tested in `lib.rs`
  (`resolve_desktop_mode`).
- **Standalone browser/WASM runtime is out of product scope.** The Web Client
  is a Remote/Installable Web Client to a user-controlled Headless/Desktop
  backend; it does not claim offline product capability (ARC-12, ADR-0043).
  A standalone browser runtime, if ever required, needs a separate ADR/RFC.
- **Legacy compatibility is an authority-non-expanding boundary.** Compatibility
  MAY translate or restrict an operation but MUST NOT grant more authority than
  the corresponding native capability; canonical SQL, SecretStore access and
  Product Wire bypass are forbidden unconditionally (ADR-0039).
- **Governance documents.** The target-architecture ТЗ 10/10 rev2
  (`NeoTavern_architecture_10_of_10_spec_2026-08-13.md`, repo root) is the
  governing document and supersedes the previous ТЗ 7.2 wherever the two
  conflict (this ADR records the supersession). `AGENTS.md` is amended
  accordingly (§2, §6, §21): the "approved stack" is split into a canonical
  plane (Rust Kernel: product logic, storage ownership, provider port,
  SecretStore port) and a legacy-compat plane (Fastify/Drizzle as migration
  adapter).
- **Program structure.** The work is delivered as the Architecture Convergence
  program of four independently approved milestones, each with its own exit
  criteria and stop right:
  - **M1a / Wave 0 — Governance** (accepted 2026-08-13): this ADR, the
    governance tooling (capability matrix ARC-10, exceptions registry ARC-09,
    legacy-surface gate ARC-02/03), the honest staged Desktop default in code
    and the single docs source tree;
  - **M1 / Wave 1 — Immediate security** (OPEN): SEC-01 SecretStore
    hardening, SEC-02 legacy allowlist export (replacing the full-DB snapshot),
    plugin networking and package verification; M1 is NOT closed until these
    land;
  - **M2 — Kernel Golden Foundation**, **M3 — Data Convergence**,
    **M4 — Product Convergence** (GEN-RUN 10C/10D).
    This ADR is the M1a/Wave-0 governance decision.

## Alternatives

- **Keep the Node core canonical.** Rejected: it cannot satisfy the
  single-writer local-first requirement across standalone Android (no Node on
  device), and it would leave the Kernel contour as dead weight while the
  storage/recovery primitives it already owns are the strongest part of the
  codebase.
- **Finish the Rust core (chosen).** The Kernel already owns storage,
  migrations, generation durability and backup/restore primitives; the work is
  vertical parity slices rather than a rewrite. This preserves existing
  investment and avoids throwing away the strongest subsystems.
- **Full rewrite.** Rejected: the program explicitly forbids a big-bang
  rewrite; it risks losing the mature Fastify product surface without a
  working replacement.

## Consequences

- Every new change has a single place of implementation: product logic in the
  Kernel, transport framing in host adapters, presentation in the web UI.
- The legacy contour is frozen and its removal milestones are tracked; no new
  dual-architecture surface is introduced.
- CI must enforce the invariants (dependency direction, no new
  `/api/v2`/`legacyRaw()` in production UI, capability matrix freshness,
  migration/shim expiry) so the dual architecture cannot silently return.
- The Desktop default is temporarily the legacy sidecar in public builds;
  this is an honest interim state, not a permanent architecture.
- A separate decision record (ADR-0041) fixes the exact versioned data-root
  layout and Windows activation protocol before the converter is built.
