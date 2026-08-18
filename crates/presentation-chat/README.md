# Product chat route (`neotavern-presentation-chat`)

Live Product Wire chat workspace for the flagged Dioxus Android host.
`PresentationChatActivity` is a temporary harness around **this** route; the
same session later attaches to production `MainActivity` behind a canary.
This crate is **not** production JNI cutover and **not** a second chat
implementation.

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
- Host tests use in-memory [`FakeWire`](src/fake_wire.rs). Opaque list
  cursors are never parsed by the session.
- Android JNI (feature `android-jni`) calls a Kotlin host that already
  holds `KernelSession` + `EnvelopeBuilder`. Kernel stays in
  `libneotavern_android_jni.so`.

## What this crate is not

- Not linked into production `libneotavern_android_jni.so`.
- Not a production `MainActivity` cutover.
- Not a fixture-backed VDOM (Milestone A `canonical-chat.json` stays the
  A corpus in `presentation-dioxus-shell`).
- Not a PERF probe. M0/B fixtures remain a frozen regression corpus.

## Commands

```bash
cargo test -p neotavern-presentation-chat
cargo clippy -p neotavern-presentation-chat --all-targets -- -D warnings
```

See [presentation-boundary.md](../../docs/architecture/presentation-boundary.md).
