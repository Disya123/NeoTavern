# Chat viewport (`neotavern-chat-viewport`)

Virtualization and fling-continuous geometry remap for the chat list
(RFC T19 / T26). This crate owns the height index, range predictor,
bounded preparation queue, tile cache, and geometry epochs. It is **not**
`neocompositor`, **not** production JNI, and **not** an Android cutover.

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
- Active and shadow `GeometrySnapshot`s exist together. Exact-height updates
  collect in a bounded `PrefixDeltaMap`. A geometry commit switches tiles,
  geometry, hit-test, and semantics generations atomically.
- C0: scroll origin is remapped so the `ScrollAnchor`
  (`LogicalItemId` + intra-item offset) keeps its screen position. Touch
  picks the point under the finger; fling uses the protected motion band.
- C1: screen velocity is unchanged by geometry delta (no fling impulse).
  Velocity changes only at new hard bounds. Grow/shrink retargets bounds
  deterministically. In-band corrections may stay as bounded `GeometryDebt`
  (item/byte/pixel caps, telemetry, deterministic settlement).
- Fallback → full-fidelity replacement does not mix epochs. Stale/out-of-order
  shadow commits are rejected. Scroll ack and geometry correction do not
  apply the same `DeltaToken` twice. A removed anchor is replaced by the
  nearest stable neighbour. Origin rebase does not change screen
  position/velocity.
- The compositor handoff is the **active** `GeometrySnapshot` only: ready
  tile descriptors and geometry. No chat/model payload.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a place for generic compositor types (those stay in
  `neotavern-neocompositor`).
- PERF-20 is **IMPLEMENTED** on the host corpus, not PASS. Final PASS
  still needs compositor integration and an Android high-velocity trace.
- Interaction-ready text and cross-tile selection are later.

## Commands

```bash
cargo test -p neotavern-chat-viewport
cargo clippy -p neotavern-chat-viewport --all-targets -- -D warnings
```

See [presentation boundary](../../docs/architecture/presentation-boundary.md)
and [ADR-0049](../../docs/adr/0049-track-d-dioxus-presentation.md).
