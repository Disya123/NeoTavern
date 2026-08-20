# ADR-0054: Plugin frontend stays CONTAINED in WebSurface (no silent Dioxus rewrite)

Date: 2026-08-20. Status: **Accepted**.

Related: [ADR-0039](0039-legacy-compatibility-authority-boundary.md)
(legacy authority boundary), [ADR-0050](0050-visual-surface-ingress-vs-plugin.md)
(`VisualSurfaceFrameIngress` is Milestone B; public `PluginVisualSurface` is
Milestone D), [ADR-0052](0052-webview-removal.md) (production no-WebView
cutover of the *main screen*),
[presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md).

This ADR is the **PluginVisualSurface** contract the Android Rust cutover
plan required: plugin frontend slots and legacy `window.SillyTavern` islands
are **CONTAINED**, not rewritten into Dioxus RSX.

## Context

The Android Dioxus/NeoCompositor host is becoming the main-screen renderer
(ADR-0052). The React Plugin SDK still registers:

- pages, settings panels, toolbar / message actions, DOM islands;
- legacy `window.SillyTavern` / `window.eventSource` unmanaged islands.

Silently reimplementing those surfaces as Rust RSX would be a Plugin SDK
rewrite. ADR-0050 already forbids claiming public `PluginVisualSurface` as
part of Milestone B. The cutover still needs an honest *host* answer: where
do plugin UIs live after the main Activity no longer mounts a product
WebView?

## Decision

1. **Product chrome is native.** App Shell, Character Manager, Personas,
   Lorebooks, Backgrounds, AI Settings, Settings, and the chat workspace
   render through Dioxus → Blitz → NeoCompositor. They consume Product Wire
   only (`plugins.list` / `enable` / `disable` / `install` / `uninstall`
   included).
2. **Plugin *frontend* slots stay CONTAINED.** Arbitrary plugin DOM, iframe
   RPC, and legacy `window.SillyTavern` run only in a sandboxed
   `WebSurface` (separate process when shipped). Dioxus must not execute
   plugin HTML/JS or mount unmanaged islands.
3. **`PluginVisualSurface` remains Milestone D.** Trusted
   `VisualSurfaceFrameIngress` (ADR-0050, PERF-15) is not a plugin API.
   Untrusted plugin producers, IR, permissions, and crash isolation stay on
   the D milestone. Until D ships, plugin visual surfaces are the contained
   WebSurface path or they are not shown.
4. **The Plugins rail panel is a native catalog, not a plugin runtime.**
   The Dioxus Plugins surface lists Wire `plugins.*` rows and states that
   frontend slots are contained. Opening a plugin page/island is a
   WebSurface intent, not an RSX rewrite.
5. **No native Plugin SDK ABI in this cutover.** Themes stay packed CSS
   tokens (no native theme ABI). D3 stays **DEFERRED**: Web remains React.

## Alternatives

1. **Rewrite plugin UI in Dioxus.** Rejected: breaks the Plugin SDK contract
   and the legacy island model (ADR-0039).
2. **Keep a product WebView as the plugin host in the same Activity.**
   Rejected for the main screen (ADR-0052); a scoped WebSurface process is
   the containment boundary.
3. **Drop plugin frontend until Milestone D.** Rejected as a silent
   removal. CONTAINED with an explicit surface is the honest status.

## Consequences

- Compatibility matrix: `Plugin frontend slots / DOM islands` and
  `Legacy window.SillyTavern` are `CONTAINED (WebSurface)`, not `PARITY`
  and not a silent `DEFERRED`.
- Main-screen `WebView` removal (ADR-0052) may still leave the WebView
  engine linked **only** for WebSurface. If no shipped plugin needs it at
  cutover, the dependency can drop later without a Plugin SDK change.
- Dioxus TalkBack (ADR-0051) is unchanged: product a11y stays
  `WEBVIEW_FALLBACK` until native TalkBack exists.

**Owner:** Disya123 `<gamedisya@gmail.com>`
**Target date:** same gate as ADR-0052. The WebSurface process is a
follow-up host slice; this ADR freezes the *boundary*, not the process
implementation.
