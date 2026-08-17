# neotavern-presentation-m0-d2

Non-production **M0-D2 producer-seam probe** for NeoUI v4 RFC 4.5 stage 3.
Program D2 is **STARTED**, not PASS. Normative M0 stays `ENTERED`.
`D1=Track D GO` is not granted.

This crate is not linked into the production WebView kernel `.so`. It does
not replace [`presentation-m0`](../presentation-m0/README.md) (D1a/D1b host
admission). D1a evidence JSON is unchanged.

## What it proves so far

- A D1a-shaped static scene is authored as Dioxus `rsx!` and rebuilt through
  `VirtualDom`.
- Pinned Blitz `BaseDocument::resolve` lays out that tree.
- `blitz_paint::paint_scene` drives a `ProducerSink`. Glass barriers are
  emitted from `render_element` via `PaintScene::host_node_marker` (**65**
  inserted lines; see [`upstream/`](upstream/README.md)).
- Canonical z-order is the paint stream. A second DOM walk is diagnostics
  only (`z-index` fixture: later sibling paints before hoisted glass).
- Glass B stays inside Blitz opacity/clip layers; scopes balance.

## What it does not prove

See [`missing_upstream_capabilities`](src/lib.rs) and
[`docs/rfc/m0-d2-probe.md`](../../docs/rfc/m0-d2-probe.md). D2 cannot PASS on
this static seam alone. The patch is not upstreamed.

## Pins (experimental)

```text
dioxus-core / dioxus-core-macro / dioxus-hooks / dioxus-html / dioxus-native-dom = 0.8.0-alpha.1
blitz-dom / blitz-paint / blitz-traits = 0.3.0-beta.1
anyrender = 0.11.0 (patched)
```

Chosen to share Vello 0.9 / wgpu 29 with `presentation-m0`. Rejected:
`dioxus-native 0.7.10` (Blitz 0.2 / anyrender 0.6 / old wgpu) and the full
`dioxus-native 0.8` window shell (winit 0.31). Alpha/beta pins are not a
production Dioxus adoption.

## Commands

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2
```

## Constraints

- RFC 4.5: Gate P is `GateP:P1`. Host-side D1a and D1b are PASS. D2 is
  STARTED. This crate is not a compositor GO.
- Do not treat a green unit test as M0-D2 PASS.
- Do not paste `static_d1a_scene()` after layout and call that a producer.
- Do not restore a post-layout scene builder for glass z-order.
