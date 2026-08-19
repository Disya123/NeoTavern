# Product chat route (`neotavern-presentation-chat`)

Live Product Wire chat workspace for the Android Rust host.
`PresentationChatActivity` is the home-screen launcher for this route.
The visible renderer is NeoCompositor `SurfaceView` (live Product Wire →
Dioxus → Blitz → presentation-session → Vulkan). Same Kernel store as the
WebView harness (`KernelHost` + `filesDir/neotavern`). Isolated 10k is a
harness profile only. Unmigrated rail panels render `NotYetMigrated`.
WebView is **not** a fallback. This crate is **not** an unguarded cutover
and **not** a second chat implementation. Cutover is **STARTED / CANARY**;
host canary `60a4d6a` is `HOST_CANARY_PASS`. Physical compositor scroll is
not yet proven.

## What this crate is

- Payload-level [`ProductWire`](src/lib.rs): `call` / `start_stream` /
  `poll_stream` / `cancel_stream` for registered Wire operations only.
- [`ChatSession`](src/session.rs) owns history, drafts, send, retry,
  prepend, streaming, and `ErrorDto` — no Kernel, SQLite, or network.
  `messageCount` is Kernel `chats.get`, never a local increment.
  Duplicate in-flight send callbacks coalesce because
  `chats.messages.create` is not idempotent. The visible window is
  virtualized through `neotavern-chat-viewport`. A stale `sceneEpoch`
  ack must not drop a newer durable revision.
- Isolated test profile `isolated-10k` seeds 10_000 messages through
  existing `characters.create` / `chats.create` / `chats.messages.create`
  into a separate store (`neotavern-isolated-10k`). It is not 10k VDOM
  nodes and not a production API. Host Kernel coverage is a
  `[dev-dependencies]` integration test.
- Host tests use in-memory [`FakeWire`](src/fake_wire.rs). Opaque list
  cursors are never parsed by the session.
- Android JNI (feature `android-jni` + `gpu`) calls a Kotlin host that already
  holds `KernelSession` + `EnvelopeBuilder`. Kernel stays in
  `libneotavern_android_jni.so`. GPU present uses the same `.so` and a
  `SurfaceView` lifecycle (`attachSurface` / `presentFrame` / `tryPush`).
  `attachSurface` takes physical width/height plus display density so CSS
  chrome maps onto the SurfaceView.

## What this crate is not

- Not linked into production `libneotavern_android_jni.so`.
- Not an unguarded `MainActivity` cutover (selector + kill switch + WebView rollback).
- Not a fixture-backed VDOM (Milestone A `canonical-chat.json` stays the
  A corpus in `presentation-dioxus-shell`).
- Not a PERF probe. M0/B fixtures remain a frozen regression corpus.

## Commands

```bash
cargo test -p neotavern-presentation-chat
cargo clippy -p neotavern-presentation-chat --all-targets -- -D warnings
```

See [presentation-boundary.md](../../docs/architecture/presentation-boundary.md).
