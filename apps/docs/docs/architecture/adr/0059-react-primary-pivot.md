---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0059-react-primary-pivot.md
---

# ADR-0059: React-primary pivot — the React contour is the product UI; the Dioxus/Blitz contour is removed; NeoCompositor stays experimental

Date: 2026-10-31. Status: **Accepted** (owner decision).
Related: [ADR-0057](0057-native-first-own-scene-platform.md) (superseded in
its product-UI goal), [ADR-0058](0058-no-web-plugin-ir-platform.md)
(end-state amended), [ADR-0038](0038-canonical-rust-kernel-core.md),
[ADR-0050](0050-visual-surface-ingress-vs-plugin.md),
[ADR-0056](0056-blueprint-canonical-chat-render.md).

## Context

ADR-0057 set the program on a native-first course: the product UI would move
to an own retained-scene platform (taffy/Parley/Vello) and the React contour
would be deleted at the Phase-4 gate, together with the Dioxus/Blitz contour.
Phases 0–2 delivered the platform core, the chat-screen pilot on the real
Kernel, panel migration and the state contracts, and the audit classes
UI-01..UI-08 were closed with roundtrip tests.

The owner reviewed the trajectory on 2026-10-31 and decided the cost/benefit
no longer holds: the React contour already carries a rich, working interface
ecosystem (components, themes, plugin SDK surface), while the native contour
duplicates it at high maintenance cost. The decision, verbatim:

| Component                             | Decision               | Rationale                                                                |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| Rust Runtime Kernel                   | Keep                   | Most key operations already implemented                                  |
| Rust SQLite / migrations / recovery   | Keep                   | Too much finished data-storage logic                                     |
| Rust Headless                         | Finish                 | A single backend for VPS and Desktop                                     |
| React + Theme SDK + Plugin SDK        | Keep as THE product UI | A rich interface ecosystem already exists                                |
| Dioxus + Blitz as a full UI           | Suspend and delete     | High maintenance cost; duplicates React                                  |
| NeoCompositor / wgpu                  | Keep experimentally    | Makes sense for Android live glass; not required for the whole interface |
| Fastify / Drizzle as a second backend | Delete gradually       | After the functional migration completes                                 |

## Decision

1. **The product UI is the React contour** (apps/web on the desktop shell,
   the Android WebView app, the remote Web Client under its ADR-0043
   remote-only rules). React is no longer a "legacy/migration plane with a
   sunset date": there is no native-contour takeover ahead of it. The
   ADR-0038 architecture stays otherwise unchanged — the canonical backend
   is the Rust Kernel over the Product Wire contracts.
2. **The Dioxus/Blitz presentation contour is removed now**, in the pivot
   commit, not at a future gate: the crates `presentation-m0`,
   `presentation-m0-d2`, `presentation-dioxus-shell`, `presentation-chat`,
   `presentation-session`, `presentation-kernel-wire`,
   `presentation-perf-probe`, `presentation-design-system`,
   `presentation-blueprint`, `presentation-scene`,
   `presentation-scene-chat-pilot`, `chat-viewport`; the vendor patches
   `vendor/anyrender`, `vendor/blitz-dom`, `vendor/blitz-paint`,
   `vendor/vello`; their capture/adjudicate/golden tooling under `scripts/`
   and `tools/`, and the CI jobs that built them. The audit-class fixes that
   landed on the removed session layer (UI-01..UI-08 commits) remain in
   history; they belonged to the removed contour. The TypeScript
   presentation contracts in `packages/contracts/src/presentation/`
   (blueprint documents, boundary, projection) are React-plane contracts and
   stay.
3. **NeoCompositor stays as an experimental crate** (pure production types,
   no product mounting): its potential use is the Android live-glass
   rendering path. It carries no product-UI obligation, no milestone gates
   and no claim on the interface. Its historical Milestone-B evidence
   (RFC records, captures) stays as history.
4. **Headless becomes the unified backend target**: the Rust Headless host
   is the single kernel-bearing backend for VPS and Desktop deployments.
   Work continues on finishing it (missing capability parity vs the legacy
   server, packaged defaults).
5. **Fastify/Drizzle keeps its ADR-0038 role** and gains a deletion path:
   it is removed gradually after the functional migration to the Kernel
   completes — the existing phase order, now without a competing UI-plane
   deadline.
6. **Supersession and amendments**:
   - ADR-0057 is superseded in its product-UI goal (the native presentation
     platform is not the product UI target; Phases 3–4 and their gates are
     void). Its Kernel-side findings (KR-01..KR-07, KR-11, KR-13, KR-14 —
     data integrity) and its audit-response role remain valid history: the
     Kernel fixes landed regardless of renderer.
   - ADR-0058's end-state is amended: the React contour is no longer
     transitional, so the Web Client does not sunset "with the legacy
     contour" — it remains a product under its ADR-0043 remote-only rules.
     Native clients never host a plugin WebSurface (unchanged); the
     declarative slots remain the shipped plugin UI path; the
     `PluginVisualSurface` IR v1 schema stays a versioned SDK surface
     (packages/plugin-sdk) — data and handlers, never markup — with host
     rendering bound to whatever native surface is actually built
     (the Android live-glass experiment is the candidate).
   - ADR-0051 (TalkBack WebView fallback) is no longer transitional-only:
     the Android app remains a WebView host; its accessibility posture is
     the product posture. ADR-0052's WebView-removal target is void.
   - ADR-0056 (blueprint canonical chat render) is restored as the React
     contour's own rendering contract — it was "superseded at the Phase-4
     gate" by ADR-0057; that supersession is void with the gate.

## Alternatives considered

- **Continue ADR-0057 to Phase 4** (delete React, ship native): rejected by
  the owner — the remaining cost (all panels, Android adapter, IME,
  accessibility, performance gates) buys parity with an interface that
  already works in React.
- **Keep both contours side by side** (freeze Dioxus, delete later):
  rejected — the "suspend" state is the drifting-two-contours state the
  ADR-0057 kill criteria themselves warn about; deletion is immediate and
  complete, history preserves everything.

## Consequences

- The workspace drops from 31 to 19 crates; the Rust plane is the Kernel,
  storage, adapters, provider SDK and the experimental compositor.
- The AGENTS.md stack section (§2), the frontend rules (§13), the plugin UI
  wording (§17) and the desktop section (§21) are amended by this ADR.
- The presentation conformance suite (INV-1..INV-7 adapter-parameterized
  scenarios) and the ADR-0057 phase gates are retired with the contour;
  React-plane gates (Playwright E2E, accessibility, visual regression,
  plugin contract tests, legacy compatibility) are the UI gates.
- Plugin UI on every shipped host is host-rendered data: declarative
  semantic slots (ADR-0037) and the sandboxed iframe surface (ADR-0007) in
  the React contour; the IR v1 schema remains the versioned contract for
  data-driven plugin UI on any future native surface.

## Amendment 1 (2026-10-31, same day): SillyTavern-era plugin compatibility removed

Owner decision: "SillyTavern-плагины… это даже думать о них не стоит". The
compatibility layer this repo carried for SillyTavern extensions is removed
outright — no freeze period, no migration guide (the ADR-0058 clause that
made the guide mandatory is amended to void):

- removed: the Express compatibility host (`apps/server/src/legacy/`), the
  trusted `legacy.js` frontend loader and its app gate, the
  `window.SillyTavern` / `window.eventSource` / `window.event_types` /
  `window.extension_settings` / jQuery globals and the unmanaged DOM
  islands (`packages/legacy-compat` deleted), the `legacy` manifest block
  and the `legacy.trusted` permission (a manifest carrying them is
  rejected at install), `@fastify/express` from the server, and the
  ST-plugin E2E/unit specs;
- kept: SillyTavern DATA import (character cards, chats, ZIP backup
  migration through Settings → Data) — user data, not plugins; the Plugin
  SDK runtime (slots, sandboxed iframe, IR v1); the authority-non-expanding
  rule of ADR-0039 as a standing norm (its subject is gone; the ADR is
  marked obsolete);
- consequences: AGENTS §1/§3/§18/§23 amended; capability-matrix row
  `compat.authority-boundary` → Deprecated; the Этап-6 "preserve the
  versioned ST Compatibility API if needed" item collapses to nothing —
  the legacy removal stage now covers only the Fastify/Drizzle sidecar and
  the `app.db` contour.

## Delivery note (round 64)

The pivot's last consequence is now real in the tree: the Fastify/Drizzle
contour, the sidecar mode and the last `app.db`-era transport are gone
(rounds 60a/60b), and so is the web build's `/api/v2` client. `LegacyBackend`
and `legacyRaw()` were deleted; a page without a host gets
`createClosedBackend()`, which constructs and rejects every call with a typed
`UnsupportedError` naming the surface. `streamGeneration` has one transport.
The product serves exactly one plane — the Runtime Kernel over Product Wire —
and the packaged portable artifact boots without a sidecar
(`scripts/smoke-desktop-shell.mjs`, `run_golden_smoke`).
