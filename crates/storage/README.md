# neotavern-storage

Storage foundation for the NeoTavern Runtime Kernel (ТЗ §21–§42, Фаза 2): the
authoritative SQLite owner. The crate provides the SQLite connection baseline
and policy, exclusive data-root leasing, a checksummed migration engine, safe
open/inspection sequences, the immutable asset protocol, consistent online
snapshots, and read-only recovery diagnostics.

## Ownership (ТЗ §21–§42)

- **§21–§23** — the storage engine owns all SQLite databases; the bundled
  SQLite baseline is enforced at runtime; a single writable connection is the
  write coordinator (no read pool in v1).
- **§22** — data roots are exclusively leased through an OS file lock on
  `<root>/.neotavern.lock` (auto-released by the OS on crash; file contents are
  diagnostics only).
- **§24** — schema migrations with a checksummed ledger, risk classes and
  STRICT tables; a fresh install applies the concatenated migration SQL in one
  transaction and records every ledger row, so fresh and migrated databases
  share one fingerprint.
- **§25** — immutable asset publishing with validated relative keys, sha256
  checksums, symlink-safe path resolution and orphan GC.
- **§31** — open sequence with read-only inspection and compatibility
  decisions (`application_id`, storage format, schema revision).
- **§86** — read-only recovery-mode diagnostics (no writes, no lease).

## SQLite baseline

`rusqlite =0.40.2` (default-features off, `bundled`) links
libsqlite3-sys 0.38.2, which bundles **SQLite 3.53.2** — satisfying the ТЗ §23
minimum of **3.51.3** (`REQUIRED_MIN_SQLITE`). `assert_baseline` enforces the
requirement at runtime against the actually linked library version.

## Module map

| Module      | Responsibility                                              |
| ----------- | ----------------------------------------------------------- |
| `baseline`  | SQLite version gate, `ConnectionPolicy`, connection config + verify |
| `error`     | `StorageError`/`StorageErrorCode` classification (incl. Busy/DiskFull) |
| `lease`     | exclusive data-root lease (fs2 lock on `.neotavern.lock`)    |
| `schema`    | v1–v4 migration SQL literals + fresh-install fingerprint   |
| `migrations`| migration engine: ledger + checksums, risk classes          |
| `open`      | inspect / open sequences, read-only recovery open           |
| `paths`     | data-root layout + managed relative-key validation          |
| `assets`    | immutable asset protocol, symlink-safe resolution, orphan GC|
| `snapshot`  | consistent SQLite Online-Backup-API snapshots               |
| `recovery`  | read-only recovery diagnostics                              |

## Constraints

- **No platform branching**: no `cfg(target_os)`-gated code paths; behavior is
  identical on all supported OSes (Windows-reserved key names are rejected on
  every platform to keep keys portable).
- **No HTTP**, no UI. Schema knowledge is table-shape only: v1 foundation
  (`meta`/`migrations`/`assets`), v2 product tables (`characters`, `chats`,
  `messages`, `lorebooks`, `presets`), v3 generation durability
  (`generation_runs`, `generation_events`), v4 provider configuration
  (`provider_configs`, config/secret separation per ТЗ §55/§68). Row-level
  semantics live in the Runtime Kernel, not here.
- **Single-writer coordinator**: all writes flow through one writable
  `Database` connection; no read pool in v1.
