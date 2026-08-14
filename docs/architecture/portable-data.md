# Portable Data: Backup, Restore, Export, Legacy Conversion, Versioned Roots (Phase 11 / M3)

> **Status.** Phase 11 implemented: public backup containers, kill-safe
> staged restore with atomic activation, Portable Export/import, and the
> read-only legacy converter. Internal recovery snapshots (Phase 2) remain
> the primitive the public formats build on. **Этап 3 (M3, DATA-ACTIVATE)**
> adds the versioned data-root layout, the durable activation journal and the
> Windows restart-to-complete protocol (ADR-0041). Decision records:
> [ADR-0032](../adr/0032-portable-data.md),
> [ADR-0041](../adr/0041-versioned-data-roots-activation.md).

## Backup container (ТЗ §40–§41)

`backups.create` produces `<data-root>/backups/<id>.neotavern-backup/`:

```text
manifest.json     written LAST (finalization), atomic temp+rename
checksums.json    inventory: [{logicalPath, type, size, sha256}]
database.sqlite   copy of a verified Online-Backup snapshot
assets/<key>      exactly the asset set referenced by the snapshot
```

`manifest.json`:

```json
{
  "format": "neotavern-backup",
  "formatVersion": 1,
  "createdAt": "2026-08-13T00:00:00Z",
  "createdBy": { "appVersion": "0.1.0", "platform": "kernel" },
  "storage": { "storageFormat": 1, "schemaRevision": 4 }
}
```

Creation follows the §41 protocol: consistent SQLite snapshot via the
Online Backup API; the immutable asset set is read from the **snapshot's**
`__neotavern_assets` (new assets after the snapshot are not included; the
single-writer coordinator serializes backup and orphan GC, so referenced
blobs cannot vanish mid-copy); every copy is size+checksum verified; the
container is assembled in a `.tmp-*` directory and renamed into place.
Quota: at most 16 completed containers per root (`QUOTA_EXCEEDED`); user
backups are never deleted silently.

Verification (`verify_backup`) rejects, before any activation:

- unknown required sections / `formatVersion > 1` (controlled
  incompatibility);
- inventory entries with wrong size/checksum, or logical paths outside
  `database.sqlite` / `assets/` (traversal-safe grammar);
- containers over 1 GiB total;
- databases failing `quick_check`, `application_id`, or the schema support
  window (`minDirectSchema <= revision <= currentSchema`).

`backups.list` reports completed containers as `wire.backup.dto`
(`completed` only; incomplete `.tmp-*` artifacts are ignored and pruned
after 24 h).

## Staged restore (ТЗ §42)

Restore never extracts over the active data root. A candidate — a complete
data-root directory — is staged next to the target and activated by
directory swap:

```text
1. verify_backup (bounded manifest, checksums, schema window)
2. stage candidate dir, copy db + assets, verify again
3. open candidate through the normal kernel open (migrations inside the
   candidate only) + foreign_key_check + integrity check; close
4. finalize candidate (ready marker with db sha256, written last)
5. activate: pending marker → retain previous root → rename candidate →
   drop marker
```

`open::open` runs `resolve_pending_restore` immediately after acquiring the
data-root lease: a pending marker with a READY candidate completes the swap;
an incomplete candidate is discarded; the current root otherwise stays
active. The previous root is retained until the first successful open after
activation. A kill at any step therefore leaves exactly one fully-verified
state active — the kill matrix is covered by
`crates/storage/tests/backup.rs`.

## Portable Export / import (ТЗ §43)

`.neotavern-export/` holds `manifest.json` (written last), NDJSON record
families (`characters`, `chats`, `messages`, `lorebooks`, `presets` — stable
ids, explicit references, no hidden order semantics) and `assets/` with a
checksummed inventory. Export fixtures are long-lived public data contracts.

Import validates the manifest, inventory and **every** record before any
write, applies in a single transaction, and reports referential orphans
instead of inventing data. The duplicate-ID policy is explicit: `reject`
(re-run safe, skips existing), `replace`, `remap` (new ids with child
references remapped). Import is offline: the host closes the kernel, stages
a candidate, verifies and activates through the same §42 machinery — the
wire registry stays frozen at 21 operations.

## Legacy converter (ТЗ §34)

Pre-kernel data roots (legacy `characters`/`chats`/`messages`/`lorebooks`/
`presets` tables, no `__neotavern_meta`) are converted by reading the source
**strictly read-only** and writing a fresh candidate: epoch-millisecond
timestamps normalize to RFC 3339, missing optional columns get defaults,
orphans are skipped and reported, and secrets/provider configs/plugins/
themes are never copied. The source is never mutated in place; unsupported
layouts yield a controlled incompatibility error.

**Schema mapping (Этап 3, work 1)** covers the real Drizzle layout
(`packages/db` migrations 0000…0024), not just the minimal fixture:

- **Known character-card fields survive** into the kernel `ext_json` under
  stable keys: `personality`, `scenario`, `first_message`,
  `example_dialogues`, `system_prompt`, `post_history_instructions`,
  `creator`, `creator_notes` — the Kernel prompt pipeline already reads
  `ext_json.personality` / `persona` for the persona block, so converted
  characters keep their persona.
- **Tags** are read from the real `character_tags`/`tags` join tables (the
  inline `tags` column of the legacy fixture is also supported) and merged,
  sorted and deduplicated into the kernel `tags_json`.
- **Unknown ext fields are preserved** verbatim (ТЗ §10.3).
- **Soft-deleted rows** (`deleted_at IS NOT NULL`) are skipped and reported
  as orphans — the kernel has no `deleted_at`, so the migration must not
  resurrect deleted characters/chats (ТЗ §17.4 corpus "orphaned records").
- Legacy `messages.branch_id`/`parent_id`/`meta`/`name` have no kernel
  columns; branches are flattened (rows keep chat ordering), matching the
  current kernel message model.

## Staged migration into the application flow (ТЗ §10.3, Этап 3)

`neotavern_storage::migration` orchestrates the full ТЗ §10.3 sequence for
converting a legacy database into a fresh versioned kernel root:

```text
Detect legacy data
→ Acquire exclusive maintenance lock (the data-root lease)
→ Preflight disk space and versions
→ Create verified backup (pre-migration-* safety copy + sha256)
→ Convert into staging data-root (versioned root under roots/)
→ Validate schema, FK, counts and hashes
→ Produce human-readable report (per-table counts + skipped orphans)
→ Platform-aware commit/activation (activation journal, ADR-0041)
→ Retain rollback pointer (previous root stays until first open after)
```

- **`migration::MigrationSession`** stages, commits and cancels while holding
  the data-root lease for the **whole** sequence: `MigrationSession::begin`
  acquires the exclusive maintenance lock and stages + validates without
  activating (the host can still cancel); `session.commit()` publishes the
  staged root through the journal (`activation_pending` → pointer switch with
  bounded transient retry → `committed`) and releases the lease on success;
  `session.cancel()` records `rolled_back`, keeps the previous root active,
  removes the staging root and releases the lease (the safety copy is
  retained). Holding the lease across the phases makes the migration
  single-writer — no second process can open or write the data root between
  staging and activation (audit P0 #3). **`migration::migrate`** is the
  one-shot convenience (begin + commit under one lease).
- **Immutable source**: the legacy database is opened strictly read-only;
  only the safety copy reads its bytes. **No live dual-write**: staging is a
  fresh versioned root on the same volume, published by the pointer switch.
- **Verified safety copy**: the pre-migration snapshot is made with the
  SQLite online-backup API (not a byte copy), so committed WAL frames are
  included and the copy passes `quick_check` before its checksum is written.
- **Preflight** refuses a non-file or missing source (`NotFound`), a
  non-legacy source (`UnsupportedStorageFormat`), and a target volume with
  less than 3× the source size + 64 MiB free (`DiskFull`) before any write.
- **Idempotent**: re-running `begin` after a committed migration reports
  the existing committed entry without staging a second root; re-committing a
  committed entry is a no-op.
- **Pointer integrity** (audit P0 #3): the active-root pointer is only ever
  written for the data root itself or a versioned root under `<data-root>/
  roots/` — an arbitrary absolute path is refused on write AND on read; a
  pointer/journal that exists but cannot be read fails closed (`Corrupt`)
  instead of being treated as missing.
- **Migration corpus** (ТЗ §17.4) is covered by `crates/storage/tests/
  migration.rs`: kernel databases at every released schema revision (1..6)
  upgrade with seeds preserved, a future schema fails closed
  (`SchemaTooNew`), a corrupted page is detected (`Corrupt`), an interrupted
  legacy migration recovers with a fresh staging root, the real Drizzle
  layout maps completely (card fields → `ext_json`, join-table tags →
  `tags_json`, unknown ext preserved, soft-deleted rows skipped), a 1000×1000
  library converts with exact counts, unicode/RTL/20k-char values round-trip,
  and **the Windows platform corpus** holds a real file handle without
  `FILE_SHARE_DELETE` (ТЗ §17.4 platform corpus): the pointer switch exhausts
  the bounded retry budget, `commit` returns the stable recoverable
  `ActivationPending`, the journal stays `activation_pending`, the previous
  root stays active, and releasing the handle lets the next `open` resolve
  the pending activation (restart-to-complete).

## Versioned data roots and the activation journal (ADR-0041, Этап 3)

The canonical v2 layout keeps every version of a data root under
`roots/root-<id>/` and points at the active one with a small
`active-root.json` pointer written atomically (temp+rename):

```text
<data-root>/
├── roots/
│   ├── root-<id>/          # immutable versioned root: database.sqlite + assets/ + ...
│   └── root-<id2>/
├── active-root.json        # {"formatVersion":1, "root": "<abs path>", "activatedAt": ...}
└── activation-journal.json # durable stage history (ТЗ §10.3)
```

- **v1 flat layout remains valid input**: a data root without
  `active-root.json` is fully supported (the active root IS the data root),
  and the ADR-0032 candidate-swap restore path keeps working unchanged.
  `open::open` and `open_read_only` resolve the active root first, so product
  reads/writes always hit the current version.
- **The pointer switch is the commit point** — a tiny file replace, never a
  directory rename — so Windows lock contention (sharing/lock violation from
  antivirus, indexers, backup/sync clients) targets one small file.
- **Activation journal**: every staged activation (migration, restore, import,
  rollback) records `prepared` → `validated` → `activation_pending` →
  `committed` (or `rolled_back`) in `activation-journal.json` (atomic writes).
  The newest entry is the recovery source of truth; unknown future formats
  fail closed.
- **Windows restart-to-complete** (ТЗ §10.3.1): the pointer switch runs
  through bounded retry with exponential backoff + jitter for classified
  transient errors only (`ERROR_SHARING_VIOLATION` 32, `ERROR_LOCK_VIOLATION`
  33, POSIX `WouldBlock`; access-denied is never retried). When the budget is
  exhausted the journal stays at `activation_pending` and the caller gets a
  stable recoverable error — the host shuts down cleanly and offers
  **Restart to finish migration**.
- **Recovery**: `open::open` runs `resolve_pending_activation` right after
  the data-root lease and before any SQLite open: a pending switch completes
  (restart-to-complete) when the target carries a database, or records
  `rolled_back` and keeps the previous root when the target is missing.
  Exactly one fully-verified root is ever active; the previous root is never
  deleted before the switch is confirmed and is retained until the first
  successful open after activation (rollback point).

The kill matrix (journal write, pointer write, first rename) is covered by
`crates/storage/tests/activation.rs`.

## Host flow: `neotavern-cli --migrate-legacy` (Этап 3 work 7–8)

The CLI is the maintenance-mode host that runs the staged converter with the
kernel **closed** (all SQLite handles released, ТЗ §10.3), then opens the
kernel on the activated root — the canonical data-root switch:

```text
neotavern-cli --root <data-root> --migrate-legacy <legacy.db> [--no-backup]
```

- Progress stages (`preflight`/`backup`/`convert`/`validate`/`activate`) go to
  stderr; the committed report (entry id, active root, previous root, per-table
  counts, skipped orphans) and the kernel-open confirmation go to stdout.
- Without `--root` → usage error (exit 2). A non-legacy or missing source →
  controlled storage diagnostic on stderr and exit 1 with **no journal
  written** (fail-closed before any write).
- After the migration the CLI opens the same [`Kernel`](../README.md) the
  hosts use: product reads through the generated wire client prove the
  switch, and the previous (flat) root stays as the rollback pointer until
  the first successful open.
- This flow is covered end-to-end in `crates/adapters/cli/tests/cli.rs`
  (spawns the real binary): full migration + `characters.get` round-trip on
  the versioned root, missing-`--root` usage error, and non-legacy rejection.

### Upgrade drill (Этап 3 work 7)

`node scripts/upgrade-drill.mjs` proves the cross-platform upgrade cycle on a
real CLI artifact (Windows/macOS/Linux; Node 24 built-in `node:sqlite`, no
external deps). It builds a Drizzle-style legacy fixture, runs
`--migrate-legacy`, and asserts:

1. migration commits and the kernel opens on the active root;
2. `characters.get` returns the migrated character (same data for the
   upgraded user);
3. the legacy database is byte-identical afterwards (immutable source,
   ТЗ §10.3);
4. re-running the migration is idempotent — one committed entry, one staging
   root;
5. the pre-migration safety copy matches the legacy database checksum;
6. the journal ends `committed` and the rollback pointer (previous root) is
   retained.

The Windows lock-contention/restart-to-complete platform corpus stays in the
Rust suite (`crates/storage/tests/migration.rs`, held handle without
`FILE_SHARE_DELETE`); the drill covers the upgrade cycle itself so the
Windows/macOS/Linux upgrade runs can gate the release branch in CI.

## Related documents

- [Data and SQLite](../data/README.md) — storage foundation.
- [Migrations](../migrations/README.md) — schema/migration engine.
- [ADR-0032](../adr/0032-portable-data.md) — decisions and alternatives.
- [ADR-0041](../adr/0041-versioned-data-roots-activation.md) — versioned
  roots, activation journal, Windows restart-to-complete.
- [Benchmarks](benchmarks.md) — measured backup/restore/export budgets.
