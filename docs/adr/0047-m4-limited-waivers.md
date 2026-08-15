# ADR-0047: M4 limited waivers — slice-1 scope and full-cutover residual items

Date: 2026-08-15. Status: Proposed (awaiting the human M4 verdict).
Related documents: [ADR-0046](0046-m3-limited-waivers.md),
[ADR-0042](0042-m1-waiver-per-profile-export-scoping.md),
[ADR-0041](0041-versioned-data-roots-activation.md), ТЗ §8.1, §13.1, §21.

## Context

The M4 (full UI/API cutover, Этап 4) milestone lists nine requirements:
slice 1 (personas + full lorebook CRUD end-to-end), slices 2–7
(variants/revisions/drafts; memories and presets; remaining providers;
imports/exports/assets/thumbnails; plugins/themes; diagnostics and
remaining settings), a repository scan with no production `/api/v2` or
`legacyRaw` calls, and legacy Fastify no longer owning product data.

The re-cut (branch `pr-m4-slices`, base = accepted M3 head f58491d)
delivers **slice 1 complete**: personas and full lorebook CRUD
(book + entry level) from contract → kernel application → adapter/facade →
UI (wireBridge + NeoBackend LorebooksApi/PersonasApi) → wire corpus →
remote-http host parity, plus the SEC-01 (session SecretStore no longer
destroys legacy plaintext) and SEC-05 (entrypoints inside `signature/`
rejected) audit fixes. Slices 2–7 and the two full-cutover exit criteria
are NOT delivered in this slice; the ledger records them as open blockers
with the waivers below so the milestone acceptance is honest about scope.

## Decision

Each waiver is bounded by its exact issue text (must match the ledger
`blockingIssues` entry byte-for-byte), severity P1, and an expiry. Waivers
do not authorise silent data loss, direct canonical SQL, SecretStore
access, or any expansion of legacy/plugin authority — the unconditional
prohibitions of ТЗ §14.2.2 stay intact.

1. **Legacy `/api/v2/lorebooks` and `/api/v2/personas` route removal.**
   The kernel + facade deliver wire parity for these entities; the legacy
   routes themselves stay until the parity is exercised in the packaged
   flow. **Expiry:** next slice (route removal is the final step of slice 1
   parity).

2. **Character↔lorebook scoping not modeled in the kernel schema.** The
   legacy `character_lorebooks` link is not yet in the canonical schema;
   kernel-mode lorebooks are global. **Expiry:** release gate — the
   character-scope mapping is part of the full Library cutover before
   Stable.

3. **`chat.persona_id` linkage and prompt `{{user}}` injection from the
   personas table not wired.** Personas CRUD is delivered; the chat
   attachment + prompt interpolation uses the wire `chat.personaId` field
   with honest defaults. **Expiry:** release gate — the persona→prompt
   wiring lands before Stable. **Status: honored in Этап 4 slice 3**
   (schema migration 010 `chats.persona_id`, `chats.create/update`
   `personaId` with `PERSONA_NOT_FOUND`, plan `userName` + `{{user}}`
   substitution; kernel tests `kernel_persona_application.rs`; the ledger
   M5 `resolvedIssues` records the delivery). Remaining honest boundary: no
   global active-persona fallback in the kernel (legacy
   `resolveActive(chat, appSettings)` stays a legacy-server behavior).

4. **Per-profile export scoping (SEC-02, M1 waiver expiry).** The M1
   ADR-0042 waiver expired at this cutover; the canonical schema per-profile
   foreign keys and export filtering are NOT delivered in slice 1 (they
   belong to slice 5, imports/exports/assets). This waiver extends the
   SEC-02 item to the release gate, superseding the ADR-0042 M4-cutover
   expiry; the human M4 verdict ratifies the extension. **Expiry:** release
   gate — the export scoping lands with slice 5 before Stable.

5. **Slices 2–7 undelivered.** Message variants/revisions/drafts, memories
   and presets, remaining providers, imports/exports/assets/thumbnails,
   plugins/themes, diagnostics and remaining settings are not part of the
   delivered slice-1 scope; they remain the tracked remainder of Этап 4.
   **Expiry:** subsequent milestones — each slice is a separate delivery
   with its own verdict; M4 acceptance covers the slice-1 scope only.

6. **Repository scan finds no production `/api/v2` or `legacyRaw` calls.**
   The check-ui-api gate is green (67 recorded sites, every one carrying an
   owner/removalIssue/milestone/deadline record with M4-removal targets),
   but the literal zero-call state is not reached. **Expiry:** release gate.

7. **Legacy Fastify no longer owns product data.** The legacy server stays
   the fallback host (ADR-0038 sidecar) until the kernel owns every product
   path. **Expiry:** release gate — the legacy removal itself is Этап 6.

## Alternatives

- Hold M4 open until slices 2–7 land: turns the vertical-slice ordering
  (ТЗ §21) on its head — slice 1 was the agreed deliverable of this PR.
- Reclassify the undelivered items as non-blocking notes: hides real
  residual scope from the acceptance record; the waiver mechanism keeps
  them visible with expiries.

## Consequences

- M4 acceptance is honest: slice-1 scope accepted, the remaining Этап 4
  requirements stay in the ledger with exact texts, severities and
  expiries; an expired waiver re-opens its blocker via the gate.
- The M1 SEC-02 waiver's expiry is formally superseded by waiver 4 with a
  release-gate expiry, ratified by the human verdict.
- No P0 remains open; the audit findings addressed in the slice (SEC-01,
  SEC-05, clippy conformance) are fixed in the re-cut.
