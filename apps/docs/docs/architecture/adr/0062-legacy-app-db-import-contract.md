---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0062-legacy-app-db-import-contract.md
---

# ADR-0062: legacy `app.db` import contract (draft)

- **Status:** Draft / proposed (round 12 of the legacy-removal program).
- **Supersedes:** nothing. **Amends:** nothing. **Related:**
  [ADR-0038](0038-canonical-rust-kernel-core.md) (canonical Kernel, no
  dual-write), [ADR-0058](0058-no-web-plugin-ir-platform.md) (data
  compatibility outlives plugin compatibility),
  [release-gate-status.md](../architecture/release-gate-status.md) row G7.
- **Decision owner:** Kernel/data plane. This is an architectural but
  reversible decision, so it is implemented as a canonical-Product-Wire choice
  with this draft, per the program's round rules.

## Context

The public default switches from the legacy sidecar to the Kernel only after
G7: the legacy database (`app.db`, Drizzle-managed) must be readable into the
canonical `database.sqlite` on packaged artifacts, with a verified rollback.
Today no importer exists at all, so G8 (rollback) and G6 (Packaged evidence)
have no dataset to work from.

Three forces constrain the design:

1. **Preservation of user data outranks everything** (AGENTS §1). A failed
   import must leave both databases exactly as they were.
2. **No dual-write** (ADR-0038): after the import the Kernel owns the data; the
   legacy file is evidence, not a peer.
3. **Re-runnable import** (AGENTS §11): running it twice must not duplicate
   characters, chats, messages or assets.

## Decision

1. **One-way copy, never a link.** The importer opens `app.db` with SQLite
   `readonly` and copies rows into `database.sqlite`. It never writes to the
   source and never keeps a connection after the run.
2. **Per-family transactions.** Each entity family (characters, chats,
   messages, presets, lorebooks, personas, settings, plugins, asset metadata)
   commits its own transaction together with its import receipt, so a failure
   mid-run leaves _completed families committed and the rest untouched_ —
   resumable and inspectable, not all-or-nothing.
3. **Receipts, not guesswork, make it re-runnable.** One `import_receipts`
   table records `(source, entity family, source id, target id, checksum)`.
   A second run skips rows whose checksum matches and reports them as
   `already-imported`; a changed row is a conflict that aborts that family
   instead of silently overwriting.
4. **Dry-run is the default.** The importer always plans first and requires an
   explicit `commit` flag; the plan reports per-family counts, unknown columns
   and unsupported values. Unknown columns in the source are a **hard refusal**
   for that family — the alternative (silently dropping fields) violates
   AGENTS §11 ("do not lose unknown character card fields").
5. **Rollback is a snapshot, not an inverse script.** Before the first commit
   the importer takes a `database.sqlite` snapshot and records its path in the
   run receipt; rollback restores that snapshot. Inverse-write scripts are
   rejected: they cannot be proven correct for partial runs.
6. **Binary payloads stay out of the database.** Asset bytes go through the
   existing asset plane (`publish_asset_from_file`), and only the metadata rows
   are imported. This keeps `database.sqlite` a data database and reuses the
   hashing/thumbnail path instead of duplicating it.
7. **The import is a Kernel operation, not a HTTP route.** It runs as a local
   kernel entry point (CLI + host command) over the Product Wire data model;
   the remote Web Client never triggers it. Legacy plugin _state_ is imported
   as opaque blobs into `plugins.state`; legacy plugin _code_ is discarded
   (ADR-0059: SillyTavern-era plugins are not supported).

## Alternatives considered

- **Dual-write bridge.** Rejected by ADR-0038; it makes two writers of truth and
  cannot be rolled back.
- **SQL `ATTACH` + `INSERT ... SELECT`.** Attractive for speed, but it bypasses
  validation and turns unknown columns into silent drops; a dry-run plan is
  impossible to produce meaningfully.
- **All-or-nothing single transaction.** Simpler, but a 4 GiB library import
  makes a single transaction a memory/IO hazard and destroys resumability.
- **Inverse rollback script.** Rejected as unprovable under partial failure.

## Consequences

- `database.sqlite` gains `import_receipts` (schema migration, checksum-covered),
  and the schema stays the Kernel's own: nothing about the legacy shape leaks.
- G7 verification becomes three tests, not a manual ritual: dry-run plan on an
  ST-era fixture, re-run idempotency, and snapshot rollback.
- G6 evidence can finally be produced from real user data, which is what the
  Packaged rows are supposed to mean.
- Cost: two extra passes (plan, then commit) and a snapshot copy for large
  libraries — accepted, because the alternative is unrecoverable data loss.

## Resolved questions (round 13)

1. **Mandatory families for a first run.** Characters, chats with their
   messages, presets, lorebooks, personas and settings are mandatory and import
   as one **run group**: if any of them refuses, the run refuses as a whole
   (before any commit) — a half-imported library where chats exist without their
   characters is worse than no import. Plugin state blobs and asset metadata are
   a second group that may be deferred to a follow-up run; the plan reports them
   as `deferred`, never as `skipped`.
2. **Asset paths that no longer exist on disk.** Skip and report. The plan lists
   every missing path with its referencing entity, the run continues, and the
   receipt records `asset_missing` so a later run can retry without touching the
   rows that did import. A missing original is a user-visible data gap, not an
   error that should abort a whole library.
3. **Snapshot ownership.** The Kernel owns the snapshot directory (under the
   Kernel data dir), not the desktop host, so the CLI and the desktop behave
   identically and the receipt path is portable across hosts. The host only
   supplies the data dir.

## Remaining question

One question stays open and is deliberately **not** answered by the importer:
how the legacy _plugin state_ blob is validated before it is stored in
`plugins.state`. Storing it opaquely is right (it is user data), but a plugin
that later becomes active under the Kernel executor must not receive a blob it
misreads. That answer belongs to the plugin executor work (program item 3,
clusters 19/20/21a), not to the migration — and it does not block the import
because the blobs are inert until an executor exists.
