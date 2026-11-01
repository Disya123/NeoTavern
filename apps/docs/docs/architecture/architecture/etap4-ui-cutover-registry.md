---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/etap4-ui-cutover-registry.md
---

# Этап 4 — UI/API cutover registry (working checklist)

> **Status.** Living working document for the ADR-0038 Этап-4 program on the
> `react-primary` branch: the vertical-slice registry that moves every
> production React call off `/api/v2` onto the Product Wire / Kernel plane,
> in the ТЗ §20 order, one slice per PR-sized change. Exit criteria (ТЗ
> §20 Этап 4): a repository scan finds **zero** production `/api/v2` or
> `legacyRaw()` calls, and legacy Fastify no longer owns product data.
> The ST-plugin compatibility layer is already gone (ADR-0059 Amendment 1,
> 2026-10-31); what remains legacy is the Fastify/Drizzle contour itself and
> SillyTavern data import.

## 1. Slice protocol (Definition of Done per row)

Every slice follows the vertical order mandated by ТЗ §20 Этап 4:

1. **contract** — wire op(s) in `packages/contracts/src/wire/registry.ts`
   (schema, scope, idempotency, byte limits, error codes); codegen refreshed;
2. **application** — kernel handler + storage, component + integration
   tests, payload gates where the op is heavy;
3. **adapter** — host surfaces (headless remote-http) reachable; no silent
   fallbacks;
4. **UI** — `apps/web` switches to the wire path (kernel mode), legacy
   browser/sidecar mode either removed or explicitly dual-mode with an
   honest default;
5. **E2E** — Playwright path for the migrated journey (kernel mode first;
   the legacy-config quarantine only while the sidecar contour exists);
6. **remove the legacy route** — the Fastify route module row is deleted in
   the SAME slice; `docs/architecture/operations-inventory.md` and the
   `ui-legacy-surface` baseline are regenerated.

A slice may ship steps 1–5 and defer step 6 only when another panel still
shares the route; the shared route's last consumer owns its deletion.

## 2. Ground-truth snapshot (verified 2026-10-31)

- **React production call sites into `/api/v2`: 134** across **124 distinct
  method+path endpoints** (`apps/web/src`, tests excluded; `apps/web/test`
  has zero).
- **Registered legacy routes: 165** across 29 route families (25 modules;
  pluginJobs/pluginAuth/pluginData/pluginSecrets mount inside
  `registerPluginRoutes`, not from `app.ts`).
- **Wire registry: 107 ops, 107/107 with kernel implementations** (102 unary
  dispatch arms + `generation.start`/`retry` streaming +
  `backups.restore` staged; the 2026-10-31 follow-ups added
  `backups.delete` (the backups cluster is fully covered),
  `characters.gallery.{list,add,delete}` — the gallery cluster is fully
  covered, avatar-original rides the existing `assets.content` —
  `settings.instructformats.list` (the settings cluster is fully covered)
  and `chats.reorder` (manual chat order; the chats cluster's restore and
  branches routes are documented N/A — the kernel keeps one linear sequence
  per chat and deletes permanently, so there is no trash to restore and no
  branch model on the wire)).
- **Legacy-route coverage: 76 covered / 5 partial / 84 missing** (no wire op
  at all; `backups.delete` closes its route into the covered set on the
  next registry recount).
- Kernel-mode gating in the UI is consistent: every legacy branch sits
  behind `isKernelMode()` — except the **plugin runtime/kernel host**
  (`plugins/runtime.ts`, `plugins/kernel/{blocks,chat,auth,jobs,models,
storage,workers}.ts`), which is legacy-only and hard-fails
  `legacyRaw()` with `UnsupportedError` on the kernel plane.
- The typed `backend.*` facade's legacy route table lives in
  `packages/neobackend` (same-origin transport strips `/api/v2`): that
  traffic is real and enumerated by the operations inventory, not by the
  web-src sweep.
- Dead production exports (tests only): `createBridgeChatMessage`,
  `readPersona` — candidates for deletion in their cluster slices.

## 3. Cluster registry

Legend: **wire** = legacy-route coverage (`covered` / `partial` / `missing`
— details in the slice work, not repeated here); **state** = `todo` →
`in-progress` → `kernel-only` → `done`. Order follows ТЗ §20 Этап 4:
personas/lorebooks → variants/revisions/drafts → memories/presets →
remaining providers → imports/exports/assets/thumbnails → plugins/themes →
diagnostics/settings.

| #   | Cluster                                                                          | UI surface                       | Legacy routes                          | Wire verdict                                                                                                                                                                      | State               |
| --- | -------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Personas                                                                         | PersonasPanel, macros            | 5 (PATCH partial: avatar-clear)        | 5 covered (`clearAvatar` flag M7)                                                                                                                                                 | wire done           |
| 2   | Lorebooks + entries                                                              | LorebookPanel                    | 10 (entries-PATCH partial)             | 9 covered (entries-PATCH position/metadata M7), restore N/A (kernel deletes are permanent — no kernel soft delete; the legacy trash route has no kernel counterpart)              | wire done           |
| 3   | Variants/revisions/swipe                                                         | ChatPage                         | covered (swipe maps to variants)       | covered                                                                                                                                                                           | todo (UI flag flip) |
| 4   | Drafts                                                                           | plugin draft streaming           | covered (save→upsert)                  | covered                                                                                                                                                                           | todo (UI flag flip) |
| 5   | Memories                                                                         | MemoryEditor                     | 4 (PATCH partial)                      | 4 covered (`scope=global` un-scope M7)                                                                                                                                            | wire done           |
| 6   | Presets                                                                          | preset editors                   | 5                                      | covered                                                                                                                                                                           | todo (UI flag flip) |
| 7   | Providers: config + secrets CRUD/reveal/exposure                                 | provider editors, ApiKeysModal   | 16, all missing (config list/set only) | missing×16                                                                                                                                                                        | todo (wire gap)     |
| 8   | Providers: models/test/speech/images/transcribe                                  | provider setup, TTS              | 5                                      | missing×5                                                                                                                                                                         | todo (wire gap)     |
| 9   | Connection profiles + apply                                                      | quick-switch                     | 6                                      | missing×6                                                                                                                                                                         | todo                |
| 10  | Imports: SillyTavern backup                                                      | DataMigrationPanel               | 4                                      | missing×4 (critical migration path)                                                                                                                                               | todo                |
| 11  | Imports: character card                                                          | CharactersPage                   | covered (`imports.character.card`)     | covered                                                                                                                                                                           | todo (UI flag flip) |
| 12  | Gallery + avatar-original                                                        | CharacterManagementPanel         | 4                                      | 3 new ops (M7), avatar-original via `assets.content`                                                                                                                              | wire done           |
| 13  | Backgrounds                                                                      | BackgroundsPanel                 | 4                                      | missing×4                                                                                                                                                                         | todo                |
| 14  | Themes: extras (boot, per-theme settings, user.css, install)                     | ThemesPage, ThemeSync            | 10 (install partial: host verifier)    | 5 covered, 1 partial, 4 missing                                                                                                                                                   | todo                |
| 15  | Message blocks                                                                   | message bubbles, sandbox RPC     | 4                                      | missing×4                                                                                                                                                                         | todo                |
| 16  | Search + FTS rebuild                                                             | global search, diagnostics       | 2                                      | missing×2                                                                                                                                                                         | todo                |
| 17  | Context preview/audit + plugin-intercepts                                        | composer, interceptor plugins    | 3                                      | missing×3                                                                                                                                                                         | todo                |
| 18  | Events SSE (app-event relay)                                                     | shell invalidation, plugin relay | 1 (2 subscribers)                      | missing×1                                                                                                                                                                         | todo                |
| 19  | Plugins: lifecycle                                                               | PluginsPage                      | 5 (install partial: host verifier)     | 4 covered, 1 partial                                                                                                                                                              | todo                |
| 20  | Plugins: runtime surface (safe-mode, sandbox, capabilities, assets, git-install) | runtime host                     | 8                                      | missing×8                                                                                                                                                                         | todo                |
| 21  | Plugins: jobs/auth/data/secrets (21 routes, sandbox RPC)                         | sandbox RPC handlers             | 21                                     | missing×21                                                                                                                                                                        | todo                |
| 22  | Auth/session                                                                     | AuthGate                         | 3                                      | missing×3                                                                                                                                                                         | todo                |
| 23  | Diagnostics + cache                                                              | DiagnosticsPanel                 | 2                                      | 1 partial, 1 missing                                                                                                                                                              | todo                |
| 24  | Backups                                                                          | SettingsPanel                    | 4                                      | 4 covered (`backups.delete` M7)                                                                                                                                                   | wire done           |
| 25  | Chats: order/restore/branches                                                    | ChatManagementPanel              | 3                                      | 1 covered (`chats.reorder` + `sort=manual` M7); restore + branches N/A (the kernel keeps one linear sequence per chat, permanent deletes — no trash, no branch model on the wire) | wire done           |
| 26  | Characters: restore/version history                                              | CharacterManagementPanel         | 4                                      | missing×4                                                                                                                                                                         | todo                |
| 27  | Settings + instruct-formats + context-preview                                    | SettingsPanel, editors           | 3                                      | 3 covered (`settings.instructformats.list` M7)                                                                                                                                    | wire done           |
| 28  | Version/health meta                                                              | HomePage                         | 2                                      | covered                                                                                                                                                                           | todo (UI flag flip) |

(A cluster marked `covered` still ships a slice: flip the UI to the kernel
branch, delete the legacy branch + route, shrink the ui-legacy baseline.)

## 4. Ground truth and machine gates

- Route inventory: `docs/architecture/operations-inventory.md` (updated per
  slice deletion).
- UI call-site gate: `pnpm ui:api:check` over the
  `docs/architecture/ui-legacy-surface.md` baseline — the baseline must
  shrink every slice; a slice that adds sites fails the gate by design.
- Kernel parity: `docs/capability-matrix.json` rows move to `Integrated` /
  `Packaged` per slice notes.
- Final scan (ТЗ exit): grep for production `/api/v2` + `legacyRaw(` in
  `apps/web/src` excluding tests must return zero.

## 5. Slice log

| Slice    | Clusters | Commit                   | Notes                                                                                        |
| -------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| registry | —        | (this slice, 2026-10-31) | ground-truth snapshot verified against code; M1/M7 ledger state corrected in the same commit |
