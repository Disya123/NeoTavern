---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/plugin-sdk/examples/rev4-overlay-game.md
---

# Example: canvas overlay in `proxy` mode (rev4)

Source: [`plugins/rev4-overlay/`](https://github.com/Disya123/NeoTavern/blob/main/plugins/rev4-overlay/)
(plugin.json + frontend.js). API contract: [rev4-api](../rev4-api.md); the
§G3/G5/G6 overlay models are described in the revision 4 plan.

## What the example shows

- Overlay registration via
  `api.overlays.register('proxy', { initialRect, hitShapes })`. The returned
  handle: `{ registrationId, update(rect?, hitShapes?), dispose(), onPointer(cb) }`.
- The visual layer is **not clipped**: the canvas fills the entire sandbox
  document and draws particles over the whole area, including the region
  beyond the hit region; the host keeps the proxy-rect inside the clip union.
- `hitShapes` narrow the interactive area to a circle in the center of the
  rect: a pointer inside the rect but outside the circle does not generate
  packets. Shapes are in overlay-local pixels (`circle` in the example; rect/
  ellipse/polygon are also supported).
- Input arrives as normalized packets (`OverlayPointerPacket`), not synthetic
  `PointerEvent`s: the browser's `isTrusted` semantics are neither promised
  nor faked. Packets contain `type` (`down`/`move`/`up`/`cancel`), normalized
  `x`/`y`, `button`, `pressure`, `pointerId`, `sequence`, `timestamp`.
- Geometry and shapes are updated via `overlay.update(rect, shapes)`; the host
  coalesces updates to one per frame and ignores out-of-order revisions.
- Explicit degradation: without `api.runtime.supports('ui.overlays', 3)` the
  plugin renders nothing instead of silently substituting native input.

## Behavior

- 48 particles drift and bounce off the viewport bounds.
- `down`/`move` inside the circle set an attractor — particles are pulled
  toward the cursor (coordinates are denormalized from 0..1 into canvas
  pixels); `up`/`cancel` release it.
- On window resize the plugin recomputes the rect (clamp 240×180…480×320) and
  the circle, and sends `overlay.update(rect, shapes)` so the host hit surface
  follows the visuals.
- On `neotavern.plugin.deactivate` the rAF loop stops, listeners are removed,
  and `overlay.dispose()` is called (the host closes the handle on disable
  anyway, but the explicit dispose demonstrates the lifecycle contract).

## Why `proxy` and not `native-regions`

`native-regions` is implemented via `clip-path` on the iframe: browser
hit-testing is real, but everything outside the shapes is **visually
clipped**. For particles, trails, and shadows this is unacceptable. `proxy`
keeps the visuals intact while the host receives real pointer events on its
own hit surface and forwards packets to the plugin — an honest model for
canvas games and 2D characters.

## Manifest

```json
{
  "requiredCapabilities": ["ui.overlay"]
}
```

The `ui.overlay` capability is granted at install time; without it
`api.overlays.register` returns `CAPABILITY_DENIED`, so the example also
checks `api.runtime.supports` before use.
