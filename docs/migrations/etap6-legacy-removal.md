# Этап 6 — Legacy removal (M7)

This is the **migration / deprecation guide** for ТЗ §20 Этап 6 (ledger
`M7-etap6-legacy-removal`). Cutover executes on `pr-m7-etap6-slices`
(after M6 accepted at `f5c37ea`).

## Target state

- One core: the Rust Runtime Kernel.
- One schema: `database.sqlite` (Kernel-owned). `app.db` / Drizzle product
  tables are gone.
- One UI facade: `NeoBackend` (`LocalBackend` / `RemoteBackend` only).
  `LegacyBackend`, `legacyRaw()`, and `/api/v2` product routes are deleted.
- There is **no SillyTavern Compatibility API to preserve**: SillyTavern-era
  plugin compatibility was removed outright by owner decision (2026-10-31,
  ADR-0059 slice) — no Express compatibility host, no `legacy` manifest
  block, no `legacy.trusted` permission, and no migration guide. Only
  SillyTavern **user data** (character cards, chats, backups) keeps
  importing through Settings → Data.

## What stays until the remaining specs are ported

| Surface                         | Why it still exists                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/server` Fastify `/api/v2` | `pnpm test:e2e:legacy` (`playwright.legacy.config.ts` / `e2e/legacy/`) — plugins, theme ZIP, echo, context-audit |
| `packages/db` Drizzle schema    | Legacy adapter for `app.db`                                                                                      |
| `legacyRaw()`                   | Unmigrated UI calls tracked in `docs/architecture/operations-inventory.md`                                       |
| ADR-0048 / ADR-0047 w7 waivers  | Expire at this stage / the release gate                                                                          |

## Cutover sequence (in progress on `pr-m7-etap6-slices`)

1. **Slice 1 (this branch):** Playwright default (`pnpm test:e2e`) boots
   `neotavern-headless` + `apps/web/dist`. Kernel specs seed data over
   Product Wire (`e2e/wire.ts`). Fastify suite is quarantined as
   `pnpm test:e2e:legacy`. The browser honors a saved remote `hostSession`.
2. Switch the desktop **public default** to Kernel (release gate in
   AGENTS.md §21) so the sidecar is no longer the honest default.
3. Delete Drizzle product tables and the legacy writer; keep a read-only
   ST import path if cards/chats still arrive as ST1 dumps.
4. Delete `legacyRaw()` call sites (fail the ui:api check if any remain)
   and the `LegacyBackend` class.
5. ~~Keep a versioned ST Compatibility API only if a remaining extension
   surface still needs it; otherwise delete the Express compatibility host.~~
   Done differently: the Express compatibility host was deleted outright on
   2026-10-31 (ADR-0059 slice) — there is no SillyTavern Compatibility API
   to keep.
6. Recovery drills, SBOM/provenance, two real upgrade cycles — release-gate
   items, not this branch.

## Delete inventory (Fastify still required by `e2e/legacy`)

These surfaces are the remaining cutover targets. Slice 1 quarantined the
Playwright Fastify boot into `e2e/legacy/` + `playwright.legacy.config.ts`;
it did not delete `apps/server`.

| Surface                                                                           | Role until cutover                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/server`                                                                     | Fastify `/api/v2` product host (desktop sidecar + `pnpm test:e2e:legacy`) |
| `packages/db`                                                                     | Drizzle schema for legacy `app.db`                                        |
| `LegacyBackend` + `legacyRaw()` in `apps/web/src/api/backend.ts`                  | Facade transport for the sidecar                                          |
| `apps/web/src/api/{client,events,generate,legacyExtensionSettings,wireBridge}.ts` | Remaining `/api/v2` sites (`docs/architecture/ui-legacy-surface.md`)      |
| ADR-0048 message swipe/draft/revision routes                                      | Deleted with the Fastify product writer                                   |
| ADR-0047 waiver 7                                                                 | Legacy Fastify product-data ownership — expires at this stage             |

There is no versioned SillyTavern Compatibility API: it was removed outright
on 2026-10-31 (ADR-0059 slice) together with the Express compatibility host,
so this stage no longer has a plugin-compat contingency. The Этап 6 cleanup
now covers only the Fastify/Drizzle sidecar and the `app.db` contour.

## Rollback

There is **no automatic down** for deleting Fastify. Rollback is a backup
restore of the previous release artifact plus the previous data-root.
Do not run a hidden destructive migration while reading data.

## Related

- [ADR-0038](../adr/0038-canonical-rust-kernel-core.md) — canonical Kernel core
- [operations inventory](../architecture/operations-inventory.md) — remaining `/api/v2` rows
- Ledger `M7-etap6-legacy-removal`
