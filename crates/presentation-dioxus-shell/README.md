# Dioxus Product Wire shell (`neotavern-presentation-dioxus-shell`)

Feature-flagged **Milestone A** presentation shell. It consumes the same
Product Wire fixture as React tests, builds a Dioxus `VirtualDom`, and
issues only registered Wire commands.

## What this crate is

- A host-side / unit-tested shell on Dioxus `VirtualDom` 0.8.0-alpha.1.
- Canonical view models are Wire DTOs (`contracts-generated`).
- Streaming applies stale-generation rejection and a bounded backpressure cap.
- Product-path 10k mixed catalog (`product_path.rs`) mounts only the
  visible window plus header/composer glass. Blitz consumes this tree.
- Chat bubbles render the React ST1 markdown contract as RSX
  (`markdown.rs`), not as HTML.
- App Shell rail panels (Characters, Personas, Lorebooks, Backgrounds,
  AI Settings, Plugins catalog, Settings, Chats) are native RSX.

## What this crate is not

- Not linked into `libneotavern_android_jni.so`.
- Not a Kernel, SQLite, or network client. Those stay behind Product Wire.
- `NEOTA_DIOXUS_SHELL=1` is a **non-default** flag, not a cutover switch.
- `PresentationChatActivity` is the Android launcher around
  `crates/presentation-chat` (live Product Wire). `MainActivity` is the
  WebView rollback.
- The Android MotionEvent adapter attaches to debug
  `PresentationInputActivity`, not this crate and not default JNI.

See [presentation-boundary.md](../../docs/architecture/presentation-boundary.md).
