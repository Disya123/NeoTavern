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

## Related documents

- [Data and SQLite](../data/README.md) — storage foundation.
- [Migrations](../migrations/README.md) — schema/migration engine.
- [ADR-0032](../adr/0032-portable-data.md) — decisions and alternatives.
- [ADR-0041](../adr/0041-versioned-data-roots-activation.md) — versioned
  roots, activation journal, Windows restart-to-complete.
- [Benchmarks](benchmarks.md) — measured backup/restore/export budgets.
