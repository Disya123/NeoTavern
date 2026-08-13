---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0022-overlay-host-chrome-zorder.md
---

# ADR-0022: Host overlay chrome and z-order protection for `full`-overlay (rev4 stage 6)

## Context

A `full`-overlay is a full-screen plugin iframe with `hitPolicy: 'full'`. Without host chrome, it is indistinguishable from the application's own UI: the user does not know that an overlay is active, cannot close it (focus inside the sandbox does not produce a `keydown` in the host window), and the application background keeps accepting focus/input. Revision §G7 requires:

- a mandatory host-controlled close affordance;
- Escape, including when focus is inside the iframe;
- restoration of the previous focus;
- `inert` for the background application;
- the plugin name in the shell indicator;
- a prohibition on the plugin covering host permission/security UI.

Alternatives:

1. **Put the responsibility on the plugin** ("it will draw its own close button") — the plugin may not draw it, may draw it incorrectly, or may cover host dialogs; this contradicts invariant 10 ("host security/permission UI is always above any plugin overlay").
2. **Host wrapper inside the plugin DOM via postMessage** — chrome is rendered in the sandbox document and is not protected from the plugin; z-order in a foreign document does not guarantee a position above host modals.
3. **Chrome in the host DOM on its own layer** (chosen) — a `PluginRuntimeUi` React component on the runtime singleton, layer `--st-layer-plugin-chrome` (300) between the plugin layers (200) and host modals (1000); Escape from the iframe is relayed by the sandbox over RPC.

## Decision

1. **State**: `OverlayChromeState {active, pluginId, pluginName, registrationId, frameId}` on `FrontendPluginRuntime`; published into `publishLayout` on every flush from live `frame.overlays` (`hitPolicy: 'full'`), cleared synchronously in `closeFullOverlay()`, `clearOverlays()`, and when the frame is removed. `subscribeOverlayChrome`/`getOverlayChrome` — `useSyncExternalStore` in `PluginRuntimeUi`.
2. **Ownership by frameId, not pluginId**: a stale layout flush from a replaced frame cannot close the chrome of a new frame of the same plugin (protection against the unmount/remount race).
3. **UI**: `<aside role="status" data-component="plugin-overlay-chrome">` with the plugin name and a `data-part="overlay-chrome-close"` button; i18n via `plugins:overlayActiveLabel`/`plugins:closeOverlay`.
4. **Inert + focus**: on activation, `document.activeElement` is remembered, the background (`main-area`, navigation-rail/panel, legacy-island-layer, `status.area`) gets `inert`; on close the values are restored and focus returns in a `queueMicrotask`. The `modal.layer` and the runtime layer itself are excluded from inert.
5. **Escape**: the host window listens for `keydown`; for focus inside the sandbox, the sandbox document (capture listener) sends `ui.overlay.escape` — fire-and-forget, without a capability gate (only the overlay of the plugin's own frame can be closed).
6. **Teardown**: `ui.surface.unmount` in the sandbox additionally releases the overlay container (key = registrationId) — host-driven closing does not leave plugin DOM behind.
7. **Tokens**: `--st-layer-plugin-overlay: 200` (iframe + host hit layer), `--st-layer-plugin-chrome: 300`; the canonical theme-sdk set is extended, the values match in `tokens.css` and `DEFAULT_*_TOKENS`.

## Consequences

- The user always sees an active plugin overlay and can close it; the application background is isolated from input; focus returns to where it was.
- Host permission/security UI (`layer-modal` 1000) stays above the chrome (300) — the §G7 invariant is upheld by layer composition.
- Cost: ~120 lines of runtime state, a chrome component, a sandbox relay, two CSS tokens, four test files.
- Backward compatibility: the new behavior applies only to `full`-overlay; `proxy`/`native`/`none` are unchanged. Rollback — removal of the chrome code and tokens; the tokens are absent from old themes (cascade variables have defaults in `tokens.css`).
