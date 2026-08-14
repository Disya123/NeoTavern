---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0041-versioned-data-roots-activation.md
---

# ADR-0041: Versioned Data Roots — Activation Journal and Windows Restart-to-Complete

Date: 2026-08-13. Status: Accepted (M3 / Этап 3, DATA-ACTIVATE).
Related documents: [Portable data](../architecture/portable-data.md),
[Data and SQLite](../data/README.md),
[ADR-0032](0032-portable-data.md),
[ADR-0038](0038-canonical-rust-kernel-core.md), ТЗ §10.2–§10.4, §19.2 ADR #8.

## Context

ADR-0038 fixed `database.sqlite` as the canonical filename and promised
"immutable versioned roots with a small active-root pointer and a durable
activation journal" without pinning the layout. ADR-0032 delivered a kill-safe
**candidate swap** (`.neotavern-candidate-*` + pending marker + directory
rename) for restore/import, but that mechanism is restore-specific: it has no
durable status journal, no rollback pointer, and its single `std::fs::rename`
commit point is exactly the primitive ТЗ §10.3.1 forbids relying on for
Windows data-root replacement (sharing violation / access denied from third
parties, antivirus, indexers, backup/sync clients or NeoTavern itself).

Этап 3 (Data cutover) requires a general data-root activation protocol:

- versioned data roots (`roots/root-<id>/`) so a new root is never written
  over the open canonical root in place;
- a durable `activation-journal.json` recording every stage with the ТЗ §10.3
  statuses `prepared`, `validated`, `activation_pending`, `committed`,
  `rolled_back`;
- a Windows activation path with bounded retry (exponential backoff + jitter)
  for classified transient sharing/lock errors, `activation_pending` after the
  retry budget is exhausted, and **restart-to-complete** on the next bootstrap
  (complete the activation before plugins, UI data queries, SQLite and
  background services start);
- documented rollback until the first new mutation after activation, with the
  previous root retained;
- the same protocol reused by migration, restore and import so every staged
  activation of the data root shares one journal and one recovery story.

## Decision

### Layout (canonical v2; v1 flat layout remains a valid input)

```text
<data-root>/
├── roots/
│   ├── root-<id>/          # immutable versioned root: database.sqlite + assets/ + ...
│   └── root-<id2>/
├── active-root.json        # small pointer, written atomically (temp+rename)
└── activation-journal.json # durable stage history, written atomically
```

- **v1 flat layout** (a data root without `active-root.json`, i.e. the layout
  ADR-0032/0038 operate on today) remains fully supported: when
  `active-root.json` is absent, the active root IS the data root itself and
  the existing candidate-swap restore path keeps working unchanged.
- **v2 versioned layout** is introduced by the first versioned activation: a
  new root is staged at `roots/root-<id>/`, and activation commits by
  atomically rewriting `active-root.json` to point at it. The pointer file is
  the commit point — a small replace, not a directory rename, so Windows
  lock contention targets one tiny file instead of a whole tree.
- `activation-journal.json` is append-mostly but rewritten atomically
  (temp+rename in the same directory); its `latest` entry is the source of
  truth for recovery. Unknown future journal format versions fail closed.

### Activation journal

Each entry:

```json
{
  "id": "<uuid>",
  "kind": "restore" | "migration" | "import" | "rollback",
  "status": "prepared" | "validated" | "activation_pending" | "committed" | "rolled_back",
  "fromRoot": "<abs path>",
  "toRoot": "<abs path>",
  "createdAt": "<rfc3339>",
  "updatedAt": "<rfc3339>",
  "error": null | "<message>"
}
```

Protocol: `prepared` (staging intent, written before any mutation) →
`validated` (schema/FK/checksums verified on the staged root) →
`activation_pending` (written immediately before the pointer switch) →
`committed` (pointer switched, verified) or `rolled_back` (activation
abandoned, previous root stays active). Every transition is idempotent;
re-running the protocol after a kill resumes from the journal, never
duplicates a committed pointer switch.

### Windows activation protocol (ТЗ §10.3.1)

1. The host closes DB/WAL/SHM handles, file mappings, thumbnails and plugin
   runtime handles before activation (the data-root lease already serializes
   writable kernels; the journal records intent before the pointer switch).
2. The pointer switch uses a bounded retry with exponential backoff and
   jitter, applied **only** to classified transient errors: Windows
   `ERROR_SHARING_VIOLATION` (32), `ERROR_LOCK_VIOLATION` (33), and POSIX
   `WouldBlock`. Everything else fails immediately.
3. When the retry budget is exhausted the journal stays at
   `activation_pending` and activation returns a stable recoverable error
   (`activation_pending`): the host shuts down cleanly and offers
   **Restart to finish migration**.
4. On the next bootstrap, `resolve_pending_activation` runs inside
   `open::open` right after the data-root lease is acquired and before any
   SQLite open: it completes a pending pointer switch (restart-to-complete)
   when the target root is present and validated, or records `rolled_back`
   and keeps the previous root when the target is missing/corrupt. It never
   opens the old and the new roots writable simultaneously.
5. The previous root is never deleted before the pointer switch is confirmed;
   it is retained at `roots/root-<id>/` until the first successful open after
   activation (rollback point), then pruned by the same retention rule as the
   restore previous-root policy (keep the newest one only).

### Rollback

Until the first new mutation after activation, rollback is a documented
pointer switch back to the previous root (journal `rollback` kind, same
activation protocol). After the first new mutation the previous root is
retained as an immutable safety copy by policy (ADR-0032 restore retention)
rather than silently deleted.

## Alternatives

- **Directory rename as the commit point (status quo).** Rejected as the
  only path: exactly the Windows failure mode ТЗ §10.3.1 calls out, and it
  gives no durable stage history to resume from after a kill.
- **Copy-on-write single file with sidecar journal.** Rejected: the database
  is a directory of files (`database.sqlite`, WAL/SHM, assets, snapshots), so
  the unit of atomicity has to be the root directory, and the pointer switch
  keeps that atomicity at a single small file.
- **Migration inside the open transaction.** Rejected: ТЗ §10.3 requires
  staged conversion with validation and cancel before any commit; in-place
  migration would violate "never overwrite the open canonical root".
- **SQLite-based journal.** Rejected: the journal must be readable before
  SQLite is available (recovery bootstrap opens it first) and must survive
  even when the database itself is corrupt; a plain JSON file beside the root
  satisfies both with std-only code.

## Consequences

- One activation protocol (journal + pointer switch + restart-to-complete)
  serves migration, restore and import; the v1 candidate-swap path remains
  operational for flat roots, so Этап 3 does not invalidate Phase 11 tests.
- A kill at any point leaves exactly one fully-verified root active:
  `committed` means the pointer was switched; `rolled_back` means the
  previous root stayed active; `activation_pending` is resumed or rolled back
  at the next bootstrap — nothing in between is ever presented as active.
- Windows lock contention degrades to a bounded retry and a clean
  restart-to-complete, never to corruption or a hang; the user is never asked
  to disable protection as the only recovery path.
- The journal and pointer live inside the data root, so they are covered by
  the same backup/export/diagnostic rules as the database (never excluded
  from recovery, never treated as user content).
- The staged converter (Этап 3) and the migration corpus tests build on these
  primitives; the v2 layout becomes the canonical root layout once the first
  migration activates it.
