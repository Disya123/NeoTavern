---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0058-no-web-plugin-ir-platform.md
---

# ADR-0058: No-web end state — plugin UI is host-rendered IR; no browser engines in product clients

# ADR-0058: No-web end state — plugin UI is host-rendered IR; no browser engines in product clients

- Status: **Amended by [ADR-0059](0059-react-primary-pivot.md)
  (2026-10-31)**: the React contour is no longer transitional — the Web
  Client does not sunset "with the legacy contour" (it remains a product
  under ADR-0043 remote-only rules), and the shipped plugin UI path is the
  React contour's declarative slots + sandboxed iframe surface. The
  no-WebSurface-in-native-clients rule and the IR-as-data principle stand;
  the IR v1 schema remains a versioned SDK surface with host rendering
  bound to whatever native surface is actually built.
- Original status: Accepted (owner direction, 2026-10-04 — "web не будет
  больше"; execution is phased: no user-facing capability is removed before
  its replacement exists)
- Date: 2026-10-04

## Context

[ADR-0057](0057-native-first-own-scene-platform.md) fixed the product UI as
native-only and left WebView in three assigned roles: the remote Web Client
([ADR-0043](0043-web-client-remote-only.md)), the legacy migration plane
([ADR-0038](0038-canonical-rust-kernel-core.md)) and CONTAINED plugin
WebSurface islands
([ADR-0054](0054-plugin-visual-surface-contained.md)). The owner has now
closed the end state: **no browser engine in any product runtime after the
transition**.

Two arguments drive it:

1. **A plugin UI in a DOM island cannot satisfy "works identically
   everywhere" — structurally.** The island renders with whichever engine
   the OS provides (WebView2, WKWebView, WebKitGTK, Android WebView) — the
   same four-engine variance ADR-0057 rejected for the product UI, now
   inside every plugin. The native Theme SDK (§14: full shell replacement)
   cannot restyle island layout, components, focus or semantics — token
   bridging only recolors. Input, IME and accessibility are bridged by each
   island's engine, outside the platform's single input model (INV-4) and
   semantic tree. And any host without the island breaks the "everywhere"
   promise by construction.
2. **The Web Client is a second full product UI client** — every product
   feature would be built twice, which is exactly the multiplication the
   program removes. Remote access does not require a second client: the
   `remote-http` transport ([ADR-0030](0030-remote-http-adapter.md)) plus a
   native-client connection mode deliver it through the one product UI.

Facts that make the sunset cheap and honest:

- The native plugin path already exists: declarative semantic slots
  ([ADR-0037](0037-extension-hardening.md)) — plugins provide data, never
  markup; the host renders.
- A host-rendered plugin surface was already designed and deferred:
  `PluginVisualSurface` IR, permissions and untrusted isolation are
  Milestone D in [ADR-0050](0050-visual-surface-ingress-vs-plugin.md).
- SillyTavern web-extension compatibility is delivered today by the
  legacy/React contour (AGENTS §18 unmanaged DOM islands), not by native
  clients — native clients never shipped it. Killing the native WebSurface
  removes nothing that exists today.

## Decision

1. **The plugin UI platform of record is declarative slots + the
   `PluginVisualSurface` IR, pulled forward from Milestone D into the
   [ADR-0057 platform](../architecture/native-presentation-platform.md)
   (Phases 2–3).** IR is a versioned, bounded scene-fragment schema:
   containers, text, image asset refs, buttons and inputs wired to the
   plugin's RPC handlers. Styling references tokens only — the Theme SDK
   restyles plugins automatically, identically on every platform. Input
   goes through the single input model (INV-4), accessibility through the
   semantic tree, z-order stays under host chrome
   ([ADR-0022](0022-overlay-host-chrome-zorder.md)), capabilities are
   permission-gated with crash isolation. **Plugins ship data and
   handlers, never markup, pixels or engines.**
2. **No WebSurface in native clients.** ADR-0054's WebSurface provision is
   superseded: native clients never embed a browser engine. A plugin that
   needs surfaces beyond the current IR version either grows the IR (a
   versioned schema extension) or is not shown — an honest
   `CAPABILITY_UNAVAILABLE`, never a hidden engine.
3. **SillyTavern web-extension compatibility is a property of the
   legacy/React contour only**, alive exactly as long as that contour
   (the ADR-0038 release-gate timeline and the ADR-0057 Phase-4 gate). It
   ends with a mandatory migration guide: porting an ST extension to the
   native Plugin SDK. AGENTS priority #2 is re-scoped accordingly
   (compatibility through the transition; the native Plugin SDK is the
   target platform).
4. **The Remote Web Client (ADR-0043) sunsets as a product.** It remains
   installable only while the legacy contour is the shipped desktop UI
   (the honest default) and is not part of the Kernel-native era.
   `remote-http`, the Headless host and the CLI remain — they are Kernel
   surfaces. Remote access after the transition is a **native-client
   connection mode** over the same transport: a recorded future capability,
   not a shipped claim.
5. **React assets retained during the transition:** `apps/web` remains the
   legacy/migration UI and the design oracle
   ([ADR-0055](0055-react-ui-oracle-blueprint-pilot.md)) until the
   ADR-0057 Phase-4 gate; deletion then happens by explicit gate, exactly
   like the Dioxus/Blitz contour.
6. **Transitional truth:** the
   [presentation compatibility matrix](../rfc/presentation-compatibility-matrix.md)
   CONTAINED rows remain the transitional record and change only when code
   changes; no document may claim the native remote mode or IR-based
   plugin surfaces before they ship.

## Alternatives considered

- **Keep WebSurface as a deprecated tier inside native clients** —
  rejected: four engines in every plugin pocket, theme-blind islands, a
  permanent second surface to maintain; the "identical everywhere" plugin
  promise stays broken.
- **Keep the Web Client as a product** — rejected: it is the second product
  UI client the program removes; its unique value (access from any browser)
  is replaceable by a native remote-connection mode.
- **Remove ST extension compatibility immediately** — rejected: priority #2
  must degrade honestly; the legacy contour is the shipped product today,
  and the migration window ends only at its documented sunset.

## Consequences

- After the transition no product runtime embeds a browser engine; plugin
  UI uniformity, theming and accessibility hold by construction (host
  renders; islands cannot diverge because they do not exist).
- IR v1 is deliberately less expressive than DOM (no arbitrary
  canvas/JS UI) — a documented limitation that grows through versioned
  schema extensions, never through embedded engines.
- ST extensions must be ported before the legacy sunset; the migration
  guide is part of this program, not an afterthought.
- [ADR-0052](0052-webview-removal.md): the main-screen cutover contract
  stands; its "retain a scoped WebSurface if a shipped plugin needs it"
  clause is superseded by this ADR.
- New platform work lands in ADR-0057 Phases 2–3: the IR schema, its
  security review (untrusted fragments: bounds, counts, permissions,
  crash isolation) and plugin-slot conformance scenarios on every adapter.
  Status: the schema v1 and its security review shipped at Phase 2
  (`packages/plugin-sdk/src/visual-surface.ts`,
  [visual-surface-ir.md](../plugin-sdk/visual-surface-ir.md)); host
  rendering and conformance scenarios remain the Phase 3 deliverable.
- ARC-12 concerns disappear with the surface itself; while the Web Client
  exists it keeps the ADR-0043 truthfulness rules unchanged.

## References

- [ADR-0057](0057-native-first-own-scene-platform.md) — the native-first
  platform this decision completes;
  [native-presentation-platform.md](../architecture/native-presentation-platform.md)
  §11 — the plugin UI surface spec.
- [ADR-0037](0037-extension-hardening.md),
  [ADR-0050](0050-visual-surface-ingress-vs-plugin.md),
  [ADR-0039](0039-legacy-compatibility-authority-boundary.md),
  [ADR-0022](0022-overlay-host-chrome-zorder.md),
  [ADR-0054](0054-plugin-visual-surface-contained.md),
  [ADR-0043](0043-web-client-remote-only.md),
  [ADR-0052](0052-webview-removal.md),
  [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0030](0030-remote-http-adapter.md).
