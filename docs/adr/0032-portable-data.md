# ADR-0032: Portable Data — Backup Container, Staged Restore, Portable Export

Date: 2026-08-13. Status: Accepted (Phase 11).
Related documents: [Providers](../architecture/providers.md),
[Generation durability](../architecture/generation-durability.md),
[ADR-0029](0029-wire-contract-toolchain.md), ТЗ §34, §40–§43, §78 Фаза 11.

## Context

Phase 2 delivered the internal recovery snapshot primitive (SQLite Online
Backup API, checksummed, verified) but no public long-lived formats. ТЗ §40
requires the backup to be a cross-platform full recovery format with a
manifest, file inventory and checksums; §42 requires restore to build and
validate a candidate and activate it atomically, never extracting over the
active data root; §43 requires a long-lived Portable Export for user data;
§34 requires a legacy converter that reads old data roots without in-place
mutation. All of it must be kill-safe (a kill at any step leaves either the
current state or a fully validated candidate active) and must not introduce
a second writer.

## Decision

- **Backup container** (`.neotavern-backup/` directory): `manifest.json`
  (format `neotavern-backup`, formatVersion 1, createdAt, producer,
  storage axes), `checksums.json` inventory (logicalPath/type/size/sha256,
  sorted), `database.sqlite` (copy of a verified Online-Backup snapshot) and
  exactly the asset set referenced by the snapshot's `__neotavern_assets`
  (pinned immutable set, ТЗ §41). Manifest is written last; the container is
  assembled in a `.tmp-*` directory and renamed into place. `backups.create`
  (wire op, workflow class) executes synchronously on the writer thread —
  the single-writer coordinator serializes it with asset GC, which is the
  backup-lease guarantee without a second lock. Quota: 16 containers per
  root (`QUOTA_EXCEEDED`), no silent deletion of user backups.
- **Staged restore** (`crates/storage/src/restore.rs`): candidates are full
  data-root directories staged next to the target; a pending marker in the
  root's parent records the activation intent; `resolve_pending_restore`
  runs inside `open::open` right after lease acquisition and either
  completes the swap (candidate carries a ready marker whose checksum
  matches its database) or discards the incomplete candidate — exactly one
  fully-verified state ever becomes active. The previous root is retained
  until the first successful open after activation (ТЗ §42 step 12).
- **Portable Export** (`.neotavern-export/`): NDJSON record families with
  stable ids and explicit references, assets with inventory/checksums,
  manifest last. Import validates every record and the inventory before any
  write, applies in one transaction with an explicit duplicate policy
  (`reject`/`replace`/`remap`), reports orphans instead of inventing them,
  and is re-run safe. Import and legacy conversion are OFFLINE: the host
  closes the kernel, stages a candidate, verifies, activates — the kernel
  exposes no import wire op (registry frozen at 21 ops).
- **Legacy converter** reads pre-kernel data roots strictly read-only,
  maps the five product families into a fresh candidate schema, skips
  secrets/plugins/themes, and reports skipped orphans; the source is never
  mutated.

## Alternatives

- Single-file zip/tar backup: rejected for this phase — a directory
  container makes per-entry checksum verification, streaming copies and
  partial inspection trivial with std-only code; archive hardening
  (compression-bomb ratios, zip-slip) is already covered at the entry level
  by logicalPath validation and size caps.
- Restore directly over the active root with per-file rollback: rejected —
  violates ТЗ §42 (never extract over the active root) and cannot guarantee
  one verified state after a kill.
- Import as a kernel wire workflow: rejected — the wire registry is frozen
  (21 ops) and offline staging through the same candidate machinery is
  strictly safer (no second writer, no live-data mutation).

## Consequences

- Backup/restore/export/import share one kill-safe activation path; the
  kill matrix (stage, finalize, first rename, marker) is tested.
- `backups.create`/`backups.list` close the Phase 0 wire surface gap in the
  kernel; Local/Remote parity tests cover them over `/rpc`.
- Corrupt, traversal and oversized containers are rejected at verification,
  before any activation.
- The legacy converter gives the documented 10–15-year recovery path for
  pre-kernel data roots without in-place mutation.
- Benchmark manifest (ТЗ §84) ships with measured backup/restore/export
  throughput on the reference fixture (docs/architecture/benchmarks.md).
