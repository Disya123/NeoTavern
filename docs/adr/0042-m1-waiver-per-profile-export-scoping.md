# ADR-0042: Limited waiver — per-profile export scoping (M1, SEC-02)

- **Status:** proposed (accepted together with milestone M1; the waiver is a
  bounded exception, not a permanent deviation)
- **Date:** 2026-08-14
- **Related:** [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0040](0040-secret-store-port-format.md),
  [ТЗ 10/10 rev2 §SEC-02](../../NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
  acceptance ledger `docs/architecture/acceptance-ledger.json` (M1 waiver entry)

## Context

The M1 milestone (Этап 1 / Security blockers) requires a logical profile
export (SEC-02): the export archive is built from an explicit per-table column
allowlist inside one snapshot transaction, and secret material is excluded.
That part is implemented and proven by negative tests.

The audit additionally identified **per-profile export scoping** as part of the
full SEC-02 requirement: in a multi-profile installation, the export must be
limited to the caller's own profiles, and the canonical schema must carry
per-profile foreign keys so the export can filter by them. In the legacy
contour (`apps/server`, feature-frozen per ADR-0038) the profile model has no
per-profile ownership columns to filter on, and the canonical plane
(`database.sqlite` owned by the Rust Kernel) is where the schema change
belongs — the legacy contour must not grow a parallel implementation of a
canonical feature (double ownership, authority-non-expanding boundary).

## Decision

M1 waives **one and only one** blocking issue:

> `P1: per-profile export scoping — the canonical schema must add per-profile
foreign keys and the export must filter by them (waived in M1 until this
cutover, SEC-02)`

under the following bounded conditions:

1. **Severity:** P1 — not a P0. Secrets are already excluded from every export
   today; the waived item is isolation _between profiles_, not secret leakage.
2. **Scope:** the single issue above and nothing else. No other M1 blocker may
   use this waiver mechanism.
3. **Expiry:** the waiver expires at the **M4 cutover** — the canonical schema
   must add the per-profile foreign keys and the export must filter by them
   before M4 can be accepted. The ledger records this expiry and the gate
   checks the waiver's fields; an expired waiver re-opens the blocker.
4. **No silent fallback:** until the cutover, the export keeps its current
   fail-closed behavior (allowlist + snapshot + secrets excluded); the waiver
   does not degrade SEC-02, it only postpones the per-profile isolation.
5. **Human sign-off:** the waiver is approved by the same person who accepts
   M1 (the ledger's `acceptedBy`), not by the implementing agent.

## Alternatives considered

- **Hold M1 open until per-profile scoping is implemented in the legacy
  contour.** Rejected: it would force a canonical-schema feature into the
  feature-frozen legacy contour, duplicating the M4 canonical work and
  violating the two-plane authority rule (ADR-0038).
- **Implement per-profile scoping in the legacy contour now.** Rejected: the
  legacy contour is feature-frozen except security fixes and migration
  bridges; this is a canonical-plane schema feature scheduled for M4.
- **Waive without bounds.** Rejected: an unbounded waiver would not be an
  exception. The conditions above (single issue, P1, M4 expiry, human
  sign-off) keep it a _limited_ waiver as required by ТЗ.

## Consequences

- M1 acceptance does not claim per-profile export isolation; the acceptance
  ledger records the waiver with its exact issue string, severity, expiry and
  this ADR link, and the gate validates those fields.
- The M1 ledger's `blockingIssues` contains only this single waived item; all
  other M1 blockers are resolved with negative-test evidence.
- M4 acceptance is blocked on the cutover (per-profile foreign keys +
  export filtering); if M4 slips, the waiver expires and the blocker re-opens
  on M1, which keeps the exception honest.
