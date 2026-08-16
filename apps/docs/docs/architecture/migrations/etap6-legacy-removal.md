---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/migrations/etap6-legacy-removal.md
---

# Этап 6 — Legacy removal (M7)

This is the **migration / deprecation guide** for ТЗ §20 Этап 6 (ledger
`M7-etap6-legacy-removal`). It is published now so the cutover has a single
source of truth. **The cutover itself is not executed on `pr-m6-etap5-slices`:**
Playwright functional E2E still boots Fastify `/api/v2`, and sequential
policy forbids `deliveredCommit` on M7 while M6 is open.

## Target state

- One core: the Rust Runtime Kernel.
- One schema: `database.sqlite` (Kernel-owned). `app.db` / Drizzle product
  tables are gone.
- One UI facade: `NeoBackend` (`LocalBackend` / `RemoteBackend` only).
  `LegacyBackend`, `legacyRaw()`, and `/api/v2` product routes are deleted.
- Compatibility, if still needed, is a **versioned SillyTavern Compatibility
  API** (documented, tested, no product-data ownership) — not a second writer.

## What stays until the cutover

| Surface                         | Why it still exists                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/server` Fastify `/api/v2` | Default Playwright suite and the public desktop sidecar while the Kernel is Preview |
| `packages/db` Drizzle schema    | Legacy adapter for `app.db`                                                         |
| `legacyRaw()`                   | Unmigrated UI calls tracked in `docs/architecture/operations-inventory.md`          |
| ADR-0048 / ADR-0047 w7 waivers  | Expire at this stage / the release gate                                             |

## Cutover sequence (after M6 is human-accepted)

1. Point Playwright `webServer` at `neotavern-headless` (the M6
   `playwright.headless.config.ts` / `e2e/headless/remote.spec.ts` path) and
   delete the Fastify health-check boot.
2. Switch the desktop **public default** to Kernel (release gate in
   AGENTS.md §21) so the sidecar is no longer the honest default.
3. Delete Drizzle product tables and the legacy writer; keep a read-only
   ST import path if cards/chats still arrive as ST1 dumps.
4. Delete `legacyRaw()` call sites (fail the ui:api check if any remain)
   and the `LegacyBackend` class.
5. Keep a versioned ST Compatibility API only if a remaining extension
   surface still needs it; otherwise delete the Express compatibility host.
6. Recovery drills, SBOM/provenance, two real upgrade cycles — release-gate
   items, not this branch.

## Delete inventory (not executed here)

These surfaces are the cutover targets. They stay on `pr-m6-etap5-slices`.

| Surface                                                                           | Role until cutover                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/server`                                                                     | Fastify `/api/v2` product host (desktop sidecar + Playwright functional suite) |
| `packages/db`                                                                     | Drizzle schema for legacy `app.db`                                             |
| `LegacyBackend` + `legacyRaw()` in `apps/web/src/api/backend.ts`                  | Facade transport for the sidecar                                               |
| `apps/web/src/api/{client,events,generate,legacyExtensionSettings,wireBridge}.ts` | Remaining `/api/v2` sites (`docs/architecture/ui-legacy-surface.md`)           |
| ADR-0048 message swipe/draft/revision routes                                      | Deleted with the Fastify product writer                                        |
| ADR-0047 waiver 7                                                                 | Legacy Fastify product-data ownership — expires at this stage                  |

Do not delete the versioned SillyTavern Compatibility API until a remaining
extension surface is proven unused; plugin-compat (`apps/web/src/plugins/**`)
is ADR-0039 and is not this inventory.

## Rollback

There is **no automatic down** for deleting Fastify. Rollback is a backup
restore of the previous release artifact plus the previous data-root.
Do not run a hidden destructive migration while reading data.

## Related

- [ADR-0038](../adr/0038-canonical-rust-kernel-core.md) — canonical Kernel core
- [operations inventory](../architecture/operations-inventory.md) — remaining `/api/v2` rows
- Ledger `M7-etap6-legacy-removal`
