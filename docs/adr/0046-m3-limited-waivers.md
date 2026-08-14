# ADR-0046: M3 limited waivers — data-cutover residual P1 items

Date: 2026-08-15. Status: Accepted (M3 / Этап 3, DATA-ACTIVATE).
Related documents: [ADR-0041](0041-versioned-data-roots-activation.md),
[ADR-0032](0032-portable-data.md),
[ADR-0042](0042-m1-waiver-per-profile-export-scoping.md), ТЗ §10.3–§10.4,
§18.2, §22.

## Context

The M3 (data cutover) slice implements ТЗ §10.3–§10.4: a staged
legacy→kernel converter with a verified safety copy, versioned data roots,
a durable activation journal, a Windows restart-to-complete protocol and a
canonical data-root switch. The audit-reviewed implementation closes the
P0 findings (single-writer lease held across the whole sequence, pointer
write/read validation with out-of-root refusal, fail-closed unreadable
journal/pointer, verified online-backup safety copy, fsync'd atomic
pointer/journal writes, portable relative pointer/journal references).
Eight P1 items remain open after the slice; each is a limited, documented
limitation that does not endanger user data, does not permit a second
product-data writer, and has a concrete expiry. The milestone gate requires
an exact-text waiver with an ADR for every open blocking issue; this ADR is
that record.

## Decision

Each waiver below is bounded by its exact issue text (must match the ledger
`blockingIssues` entry byte-for-byte), severity P1, and an expiry. Waivers
do not authorise silent data loss, direct canonical SQL, SecretStore access,
or any expansion of legacy/plugin authority — the unconditional prohibitions
of ТЗ §14.2.2 stay intact.

1. **Parent directory fsync after the pointer rename.** `write_atomic`
   fsyncs the temp file before the rename and the target file after it
   (ТЗ §10.3 flush/sync); the parent directory entry is not synced, which is
   a documented platform best-effort. The bounded-retry +
   `activation_pending` + restart-to-complete protocol covers the failure
   window deterministically. **Expiry:** release gate — the §18.2 packaged
   crash/restart suite re-verifies the pointer-switch crash matrix on real
   artifacts.

2. **Path containment without canonicalization.** The pointer refuses any
   target outside the data root on both write and read
   (`validate_active_root_candidate`), so a crafted pointer cannot redirect
   the kernel to an arbitrary directory; symlink/`..` escape defense inside
   the root is defense-in-depth. **Expiry:** release gate (SEC hardening
   sweep) — containment hardening with canonicalization before Stable.

3. **`--no-backup` escape hatch.** The CLI allows disabling the
   pre-migration safety copy for constrained environments. It is an
   explicit opt-out, not a silent fallback; the default flow always creates
   the verified snapshot. **Expiry:** permanent product option, documented.

4. **Legacy sidecar not stopped/blocked during activation.** The CLI
   migration is an offline operation run with the app closed; the converter
   reads the verified safety copy (a consistent snapshot) rather than the
   live source, so a concurrent legacy writer cannot corrupt the
   conversion. Host-level sidecar coordination lands with the in-app
   migration UX. **Expiry:** M4 cutover.

5. **Recovery checks only for the target database file.** The staged target
   was fully validated during staging; restart-to-complete recovery
   re-checks the file's presence before the pointer switch. Full
   schema/integrity re-verification of the target at recovery time is a
   hardening item. **Expiry:** release gate — §18.2 packaged recovery suite.

6. **Restore uses a second activation system.** The restore path works
   (kill-safe staging) but predates the shared activation module.
   **Expiry:** M4 cutover — restore converges on the shared platform-aware
   activation protocol (ТЗ §10.4).

7. **Desktop migration is CLI-only.** The migration protocol, journal and
   restart-to-complete recovery are fully implemented and tested; the UI
   surface (progress, Retry/Restart/Open help/Export diagnostics, ТЗ
   §10.3.1) is wired in the M4 Desktop slice. **Expiry:** M4 cutover.

8. **Settings/branches/revisions/assets conversion.** The converter
   preserves unknown character metadata (ТЗ §10.3) and converts
   characters/chats/messages/lorebooks/presets/personas now; the remaining
   entity classes are explicitly tracked as the next conversion slices so
   no legacy entity class is silently dropped (mirrors the M1 SEC-02 waiver
   expiry pattern). **Expiry:** M4 cutover.

## Alternatives

- Hold M3 open until all eight P1 items are fixed: forces M4-scoped work
  (in-app UX, restore convergence, asset conversion) into the data-cutover
  milestone, violating the vertical-slice ordering (ТЗ §21).
- Reclassify as non-blocking notes: would hide real residual gaps from the
  acceptance record; the waiver mechanism keeps them visible with expiries.

## Consequences

- M3 acceptance is honest: the open items stay recorded with exact texts,
  severities and expiries; an expired waiver re-opens its blocker via the
  gate.
- The remaining work is tracked against concrete milestones (M4 cutover or
  the release gate) rather than disappearing from the ledger.
- No P0 remains open: the P0 findings of the audit are fixed in the M3
  slice (see ADR-0041 and the ledger evidence).
