# ADR-0048: M5 slice-2 limited waiver — message swipe/draft/revision legacy routes

Date: 2026-08-15. Status: Proposed (awaiting the human M5 verdict).
Related documents: [ADR-0047](0047-m4-limited-waivers.md),
[ADR-0038](0038-canonical-rust-kernel-core.md), ТЗ §13.1, §14.2, §20
(Этап 4 slice 2), §21.

## Context

Этап 4 slice 2 (message variants/revisions/drafts) delivers the vertical
contract → application → adapter/facade → UI → E2E and, as its final step,
the removal of the replaced legacy `/api/v2` routes. The slice now delivers:

- kernel wire ops `chats.messages.variants.*`, `chats.messages.revisions.*`
  and `chats.messages.drafts.*` (896656a);
- the legacy converter mapping the three entity families (5f54bb5);
- the `NeoBackend.ChatsApi` facade + wireBridge routing, with kernel-mode
  translation and `CAPABILITY_UNAVAILABLE` for browser-only gaps (d2a3471);
- the UI cutover: ChatPage swipe controls, the variants/revisions hooks, the
  variant picker and the kernel-plugin draft streaming all route through the
  facade in kernel mode (78adff2). `check-ui-api` shows the swipe/draft
  legacy surface gone from the product UI: 68 → 61 recorded sites.

The remaining piece of the slice is deleting the legacy
`/api/v2/chats/:id/messages/:messageId/swipe`, `.../revisions`,
`.../revisions/:revisionId/restore` and `.../drafts*` routes. They cannot be
deleted yet: the browser-mode transport of the facade still calls them, and
browser mode is a shipped surface.

## Decision

Keep the legacy message swipe/draft/revision routes as the browser-mode and
legacy-sidecar transport of the facade, with the following bounds:

1. **No production UI call reaches these routes directly.** Every product
   call goes through `wireBridge`/`NeoBackend`; the kernel-mode path uses the
   wire ops exclusively. The only remaining callers of the routes are the
   facade's browser branches (`swipeMessageToPosition`, `saveMessageDraft`,
   `commitMessageDraft`, `discardMessageDraft`, `readMessageRevisions`,
   `restoreMessageRevision`), which serve the Web Client (M6) and the
   legacy-sidecar desktop default (ADR-0038) until the kernel owns every
   product path.
2. **The routes add no new product behavior.** They stay feature-frozen
   (ADR-0038): no new fields, no new semantics beyond the documented
   translations in `docs/architecture/operations-inventory.md` (restore maps
   onto `chats.messages.update` in kernel mode; drafts commit exactly once via
   `committedMessageId`).
3. **Removal lands with Этап 6 (legacy removal),** superseding the
   slice-2 expiry of the analogous ADR-0047 waiver-1 item for
   messages/swipes/drafts. This is the same boundary ADR-0047 waiver 7
   (legacy Fastify no longer owns product data) already draws; ADR-0048
   makes the slice-2 item explicit so no expired waiver re-opens the gate.
4. **Expiry:** release gate — the routes are deleted when the legacy server
   stops serving product data (Этап 6), alongside the rest of the `/api/v2`
   product surface.

## Alternatives

- Delete the routes now: breaks browser mode (Web Client and the
  legacy-sidecar default) — the facade's browser branches would have no
  transport. Rejected.
- Rewrite the routes as a kernel compat-proxy now: creates a second
  transport path before the remote-http headless adapter (M6) exists.
  Rejected — the thin kernel HTTP adapter is the М6 deliverable.
- Reclassify the routes as non-blocking: hides the residual surface; the
  waiver mechanism keeps it visible with an expiry. The decision above
  documents the exact caller set instead.

## Consequences

- The M5 slice-2 blocker "legacy route removal for messages/swipes/drafts"
  is re-waived with a release-gate expiry; the ledger entry records ADR-0048.
- `check-ui-api` continues to track every remaining `/api/v2` and
  `legacyRaw` site with owner/removalIssue/milestone/deadline; the swipe/
  draft feature sites are gone from the product UI.
- No authority expansion: the routes translate onto the native capabilities
  the same way the facade does, and stay feature-frozen (ТЗ §14.2.1).
