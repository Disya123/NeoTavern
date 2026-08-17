# Chat viewport (`neotavern-chat-viewport`)

Virtualization foundation for the chat list (RFC T19). This crate owns
the height index, range predictor, bounded preparation queue, and tile
cache. It is **not** `neocompositor`, **not** production JNI, and **not**
an Android cutover.

## What this crate is

- `HeightIndex`: `O(log n)` offset ↔ stable `LogicalItemId` (not an array
  index). Heights are estimated or exact and carry `GeometryEpoch`.
- `VisibleRange` / `PreparedRange` / `FallbackReadyRange` from a deadline-aware
  predictor (velocity, direction, preparation latency, reversal).
- Overscan clamped by item/byte/time budgets.
- Bounded preparation queue: latest range wins, stale work is cancelled.
- Tile cache with hard item/byte caps, high-water telemetry, and a pinned
  viewport/protected band during fling.
- Overscan miss presents immediately from known/estimated geometry. It does
  not wait on Dioxus/layout/raster and must not open a transparent gap.
- The compositor handoff is `GeometrySnapshot`: ready tile descriptors and
  geometry only. No chat/model payload.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a place for generic compositor types (those stay in
  `neotavern-neocompositor`).
- Geometry C0/C1 continuity is a follow-up commit, not this slice. Exact
  height commits that still need remap are `GeometryCorrection::PendingDebt`.
- Interaction-ready text and cross-tile selection are later.

## Commands

```bash
cargo test -p neotavern-chat-viewport
cargo clippy -p neotavern-chat-viewport --all-targets -- -D warnings
```

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
