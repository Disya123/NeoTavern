# ADR-0062: legacy `app.db` import contract (draft)

- **Status:** Accepted (owner review of `react-primary`, round 15 of the
  legacy-removal program).
- **Supersedes:** the snapshot-based rollback in this ADR's first draft.
  **Amends:** nothing. **Related:**
  [ADR-0038](0038-canonical-rust-kernel-core.md) (canonical Kernel, no
  dual-write), [ADR-0041](0041-versioned-data-roots-activation.md) (versioned
  data roots, activation journal — the mechanism this import runs on),
  [ADR-0058](0058-no-web-plugin-ir-platform.md) (data compatibility outlives
  plugin compatibility),
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
   import must leave the **active data root** exactly as it was: the user never
   sees a half-imported library. The first draft phrased this as "both
   databases unchanged" while decision 2 committed per-family — a real
   contradiction, resolved below: the import writes into a **staged, not yet
   active** root (ADR-0041), so per-family commits are resumability inside a
   disposable copy, and the active root is untouched until validation passes.
2. **No dual-write** (ADR-0038): after the import the Kernel owns the data; the
   legacy file is evidence, not a peer.
3. **Re-runnable import** (AGENTS §11): running it twice must not duplicate
   characters, chats, messages or assets.

## Decision

1. **One-way copy, never a link.** The importer opens `app.db` with SQLite
   `readonly` and copies rows into a **new staged versioned data root**
   (`roots/root-<id>/database.sqlite`, ADR-0041), never into the active
   `database.sqlite`. It never writes to the source and never keeps a
   connection after the run.
2. **Per-family transactions inside the staged root.** Each entity family
   (characters, chats, messages, presets, lorebooks, personas, settings,
   plugins, asset metadata) commits its own transaction together with its
   import receipt, so a failure mid-run leaves _completed families committed
   inside the staged root and the rest untouched_ — resumable and inspectable.
   Because that root is not active, partial progress is never shown to the
   user; the activation step is what turns it into the library.
3. **Receipts, not guesswork, make it re-runnable.** The `import_receipts`
   ledger records one row per imported FAMILY — `(run id, entity family,
source fingerprint, target root, imported at)` — where the fingerprint is
   sha256 over the family's sorted source ids. (Amended in round 17: the first
   draft promised per-source-row receipts, but kernel ids are newly generated
   per row and a checksum of an arbitrary legacy row is undefined; at staged-
   root granularity the family fingerprint gives the same guarantees — a
   re-planned run against a changed source produces a different fingerprint,
   which is a detectable conflict, not a silent overwrite.)
4. **Dry-run is the default.** The importer always plans first and requires an
   explicit `commit` flag; the plan reports per-family counts, unknown columns
   and unsupported values. Unknown columns in the source are a **hard refusal**
   for that family — the alternative (silently dropping fields) violates
   AGENTS §11 ("do not lose unknown character card fields").
5. **Rollback is "keep the old root", not a snapshot and not an inverse
   script.** The staged root commits only through the ADR-0041 activation
   protocol: the journal entry (`kind: "import"`) moves `prepared` →
   `validated` → `activation_pending` → `committed` only after the mandatory
   run group passes its checks (foreign keys, per-family counts, re-import
   idempotency). Any failure before `committed` keeps `active-root.json`
   pointing at the previous root and the staged root is retained for
   inspection or deleted; after activation, ADR-0041 rollback retains the
   previous root until the first new mutation. Inverse-write scripts and
   snapshot restores are both rejected: the first is unprovable under partial
   failure, the second is redundant when the previous root still exists.
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

- The canonical schema gains `import_receipts` (schema migration,
  checksum-covered), so every staged root created from `FRESH_SCHEMA_SQL` has
  it; nothing about the legacy shape leaks into the Kernel schema.
- The contract is implemented as `neotavern_storage::legacy_import`
  (`plan` / `stage` / `validate_staged` / `activate_staged`) on top of the
  existing `convert_legacy` converter and the ADR-0041 journal.
- G7 verification becomes four tests, not a manual ritual: dry-run plan on an
  ST-era fixture, re-run idempotency inside the staged root, failed validation
  leaves the active root and its journal untouched, and a passing run flips
  `active-root.json` with a `kind: "import"` journal entry.
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
3. **Staged-root ownership.** The Kernel owns the staged root and the
   activation journal (ADR-0041 layout under the data root), not the desktop
   host, so the CLI and the desktop behave identically. The host only supplies
   the data dir. (Amended from the first draft's snapshot directory, which the
   staged-root decision above supersedes.)

## Plugin state: quarantine policy (owner decision, round 15)

Legacy `plugin_state` blobs are user data, but an unvalidated blob handed to an
active plugin is a code-execution-adjacent risk, so the owner fixed the policy
before any importer code exists:

1. Imported legacy state goes to a **quarantine store** that keeps the original
   bytes, the source plugin id and a checksum — it is never written straight
   into the live `plugins.state` table.
2. An imported blob is **never** delivered to an active plugin automatically,
   and a matching `pluginId` alone is not sufficient to claim it.
3. Restoration requires an identity/version/schema compatibility check against
   the installing plugin; if the plugin declares an explicit state migration,
   that migration is the only allowed transform.
4. Restoration happens **only by explicit user action**; it never auto-enables
   the plugin and never grants permissions.
5. If compatibility cannot be verified, the blob stays quarantined: it is not
   destroyed and not handed to the executor.

Because of this policy the first G7 stage **defers plugin state import
entirely** (the second run group): the blobs are inert until a Kernel executor
exists, and the quarantine gives that executor work (program item 3, clusters
19/20/21a) a well-defined, already-secured input.
