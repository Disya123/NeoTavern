---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/release-gate-status.md
---

# Release gate status (kernel default switch)

The public desktop default flips from the legacy sidecar to the Kernel only when
every row below is satisfiable **on packaged artifacts**. This page records the
verified state so the remaining work is explicit instead of hopeful — a row is
`PASS` only with the command and its result, never by intention.

Related: [ADR-0038](../adr/0038-canonical-rust-kernel-core.md),
[ADR-0059](../adr/0059-react-primary-pivot.md), `docs/desktop/README.md`,
capability matrix (`docs/capability-matrix.json`, generated), [cutover registry](etap4-ui-cutover-registry.md).

## Verified

| Row | Condition                                | Evidence                                                                                          | Status                           |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| G1  | Rust lints clean under the CI invocation | `cargo clippy --workspace --all-targets -- -D warnings` (from `crates/`) → exit 0                 | **PASS** (round 7)               |
| G2  | Repository formatting clean              | `pnpm format:check` → "All matched files use Prettier code style"                                 | **PASS** (round 8)               |
| G3  | No silent kernel-plane fallbacks         | `pnpm ui:fallback:check` → 3 registered `kernel-empty:` branches, AST classifier, CI step present | **PASS** (round 6)               |
| G4  | Legacy UI surface audited and frozen     | `pnpm ui:api:check` → 51 sites, per-site fingerprints + owner/removal records                     | **PASS** (round 5 audit closure) |
| G5  | Product Wire contract determinism        | `node tools/contract-codegen/codegen.mjs --check` → 143 ops in sync                               | **PASS**                         |

## Not satisfied

| Row                                                                                 | Condition                                               | What is actually missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| G6                                                                                  | Capability matrix to Packaged                           | Packaged pipeline green (portable zip + repo shell smoke). The packaged golden smoke walks, in full: chats/messages CRUD, presets, personas, memories, lorebooks (+entries), providers.list/catalog, settings, the tool loop, meta.get, variants/revisions/drafts, snapshots, app events, the 10-op asset family, the 13-op characters family, the 7-op generation.workflow family (start/get/events/cancel/retry-after-failure/keep-partial/discard-journal) and diagnostics+search (rebuild/query-hit/cache.clear/export) — 17/43 desktop capabilities Packaged (18/172 host cells). Remaining rows need their own walks (backups.restore, providers adapters with live credentials, security rows, ui.* app-layer rows) or are transport/host-bound. | **FAIL** (17/43 desktop rows)                 |
| G7                                                                                  | app.db importer verified                                | Storage plane + CLI complete (rounds 16-18); the ADR-0062 walk (plan -> stage -> validate -> activate -> rollback) now runs INSIDE the packaged binary as smoke step 10 on the real kernel data root (round 28, exit 0). Still FAIL as defined: the user-facing Desktop host command (Settings-triggered import of the operator's real app.db) is not built yet.                                                                                                                                                                                                                                                                                                                                                                                        | **FAIL** (in-process packaged evidence green) |
| [ADR-0062](../adr/0062-legacy-app-db-import-contract.md) before it can be verified. | **FAIL**                                                |
| G8                                                                                  | Rollback verified                                       | `activation::rollback_to` mechanism + CLI (rounds 19-21); the rollback ran INSIDE the packaged binary right after an import activation (round 28: pointer -> staged root -> back to the previous root, journal consistent, kernel uninterrupted). Still FAIL as defined: verification of the user-facing rollback flow on the portable artifact stays open.                                                                                                                                                                                                                                                                                                                                                                                             | **FAIL** (in-process packaged evidence green) |
| G9                                                                                  | Playwright E2E on the packaged build                    | Not run in any round of this program.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **FAIL**                                      |
| G10                                                                                 | Accessibility (WCAG 2.2 AA) and visual regression gates | Not run in any round of this program.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **FAIL**                                      |

## Consequence

The switch is blocked by G6–G10, not by the migration of features: the Rust
kernel, the wire plane and the React contour are ready enough that every UI
consumer flipped in rounds 1–5 has a Product Wire path, but "ready enough" is
not the gate. Until G6–G10 pass on packaged artifacts, the sidecar stays the
public default and the Kernel stays an explicit Preview
(`NEOTA_KERNEL=1`, conflict policy in `apps/desktop/src-tauri/src/lib.rs`).

## Next step order

Rounds 16–21 built the migration plane the older version of this list called
"the keystone": the `import_receipts` ledger (schema v31), the staged-root
import lifecycle `legacy_import::{plan,stage,validate_staged,activate_staged}`
(ADR-0062), the operator CLI `neotavern-headless legacy-import` /
`legacy-rollback`, and the durable rollback mechanism
`activation::rollback_to` — all journal-level tested. What remains, in order:

1. **Packaged build (stream 2 keystone).** A release desktop build must exist
   and boot kernel-mode with its local database (the
   `desktop:shell-smoke` protocol: `NEOTA_DESKTOP_SMOKE=1 NEOTA_KERNEL=1`,
   exit 0, `database.sqlite` created). Every G6 row and the packaged halves
   of G7/G8 evidence hang on this artifact; G9/G10 need the same build to run
   their Playwright/a11y/visual suites against.
2. **G6 evidence** — the capability matrix rows promoted to Packaged only by
   observed behaviour on that build, with the imported dataset in place.
3. **G7/G8 packaged halves** — the import/rollback flow executed ON the
   packaged artifact (Desktop host command over the storage plane; the CLI
   covers headless only), then the matrix rows.
4. **G9/G10** — Playwright E2E, a11y and visual gates on the packaged build.
5. **Largest remaining wire-gap** — row 10 (SillyTavern backup import): the
   ADR-0061 transport exists (`assets.upload.*`), the kernel importer is a
   multi-round port of the legacy analyzer (11 categories, conflicts, aborts).

Until then nothing in this list is "done", and the sidecar stays the default.
Deleting `fastify`/`drizzle`/`api/v2` is the last step of the same gate: it
can only happen when the legacy plane is provably unnecessary, which is exactly
what G6–G8 measure.
