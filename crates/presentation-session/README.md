# presentation-session (`neotavern-presentation-session`)

Host integration between `crates/chat-viewport` and
`crates/neocompositor`. Not production JNI, not `MainActivity`, not an
Android cutover.

## What this crate is

- Maps the viewport's active `GeometrySnapshot` into a compositor
  `GeometryTileSnapshot`.
- Publishes geometry, hit-test, semantics, text, and tiles in **one**
  `FrameTransaction`. Mixed `SceneGeneration` is rejected.
- `DeltaToken` is applied once: a second scroll ack or remap with the same
  token is `IgnoredAlreadyApplied` and does not double-apply compositor
  scroll.
- Selection is a logical text position (`LogicalItemId` + `TextOffset` +
  `StableSemanticId`), not a tile coordinate. Remap during drag/fling keeps
  that position relative to the text.
- Deleting the selected message yields `Cancel` and does not retarget
  another row.
- Autoscroll nudges the existing compositor `ScrollId` / latch.
- A selection change damages only old/new underlay and dependent glass ROI
  (`SELECTION_ONLY`). Glyph tiles stay valid.
- Fallback tiles without a text snapshot stay `NotInteractionReady`.
- Owns a B-level `VisualSurfaceFrameIngress` (ADR-0050): logical declare
  plus bounded latest-ready-frame-wins queue. Not Plugin SDK.
- Host product-path corpus for PERF-01 / PERF-02 / PERF-16
  (`tests/product_path_perf.rs`): Product Wire → flagged Dioxus shell →
  Blitz producer → this session → compositor ticks. Not a physical PASS.
  Callers bind a Blitz `NeoDisplayList`; they must not assemble one by
  hand. Host reports do not publish p99.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a place to dump compositor types into `chat-viewport`.
- PERF-19 and PERF-20 are **PASS** on physical Vulkan (independent host
  stamps). Registry Milestone B is PASS. Not production cutover. See
  [`docs/rfc/perf-18-20-adjudication.json`](../../docs/rfc/perf-18-20-adjudication.json).

## Commands

```bash
cargo test -p neotavern-presentation-session
cargo clippy -p neotavern-presentation-session --all-targets -- -D warnings
```
