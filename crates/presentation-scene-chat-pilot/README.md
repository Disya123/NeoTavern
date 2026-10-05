# neotavern-presentation-scene-chat-pilot

ADR-0057 Phase 1 chat-screen pilot: the first product surface mounted on
the [`presentation-scene`] platform core. It proves the platform's
invariants on a real screen — not the shipped desktop UI (the legacy
contour still ships until the ADR-0057 phase gates).

## What it is

A thin projection + input router over `ChatSession`:

```
ChatSession route state (single product truth, INV-1)
   → ChatPilot::project  (retained Scene: stable per-message scene ids)
   → ChatPilot::frame     (layout → FrameSnapshot — the single geometry, INV-2)
   → render::render_frame / hit_test / semantic_items (all read the one snapshot)
```

Host input routes back through the session's existing command surface
(platform spec §8):

- `apply_composer_op(session, op)` — editor-core op → text syncs to the
  session (`set_composer_text` persists the wire draft on every edit);
  caret/selection state never leaves the scene's editor core (INV-4).
- `handle_hit(session, snapshot, x, y)` — the send button sends;
  composer clicks position the caret through the snapshot's shaped text
  (INV-2: the same geometry that paints).

## Phase 1 gate (behavioral, INV-7)

`tests/phase1_gate.rs` runs the full journey against the REAL Kernel in
an isolated tempdir data root:

- open → seeded history visible;
- caret/selection editing (type, select-all, replace — the PL-01 failure
  mode stays fixed at the pilot level);
- caret geometry round-trips through the snapshot (click at the caret
  resolves to the caret byte — hit-test reads the same shaped text);
- send via the hit-tested button → stream completes → durable assistant row;
- reopen the SQLite root: both messages verified durable;
- restart rehydration: the unsent composer draft restores through
  `chats.messages.drafts.list` (ADR-0057 Phase 1 wire op);
- snapshot invariants: no NaN/inf rects, same state → same digest,
  changed state → changed digest (refactor-stability seam).

## Desktop bridge (feature `desktop-host`, dev evidence host)

`scene-pilot` mounts the pilot in a winit 0.30 window with a minimal
wgpu present: one vello render of the snapshot into an `Rgba8Unorm`
raster, then a fullscreen-triangle blit onto the swapchain — NOT the
legacy `PresentSurface` (that pipeline carries the frozen contour's
chrome/wallpaper/overscan contracts; the pilot owns its ~200-line
present, INV-3).

```bash
cargo run --manifest-path crates/Cargo.toml \
  -p neotavern-presentation-scene-chat-pilot \
  --features desktop-host --bin scene-pilot
```

- default: FakeWire demo chat — the window title carries the INV-7
  `— FAKE WIRE (dev)` label;
- `--root <dir>`: the real Rust Kernel over a SQLite data root (seeds a
  demo chat only when the workspace is empty; existing workspaces open
  as-is);
- keyboard → editor-core `CursorOp`s (type, backspace/delete, arrows +
  Shift select, Home/End, Ctrl+A; plain `Enter` sends, `Shift+Enter`
  inserts a newline); mouse clicks hit-test through the one snapshot;
- stream pumping runs in `about_to_wait` at ≤30 updates/s (AGENTS §24)
  until the terminal event;
- resize reconfigures at frame time (events only record the size); DPI
  changes re-produce cold.

Known bridge limits (honest scope): the wheel is not mapped (the pilot's
message column is not scrollable yet — no parallel geometry may fake
it); only `Ctrl+A` of the clipboard shortcuts is mapped (paste/cut need
an arboard seam with the Phase-3 IME seam); DPI > 1 stretches the
CSS-px raster linearly (crispness waits for the physical-scale layout
pass).

## Local raster harness (never CI)

```bash
cargo run --manifest-path crates/Cargo.toml \
  -p neotavern-presentation-scene-chat-pilot \
  --features desktop-host --bin scene-pilot -- --golden artifacts/scene-pilot-goldens
```

Writes one PNG per golden-corpus size (1100×760, 900×700, 620×800,
900×220 — the m0-d2 `chat-golden` corpus) on an offscreen wgpu device,
with the wire label in the filename (`fake-wire-dev` / `kernel`).
Developer evidence only: `artifacts/` is gitignored, CI gates stay
behavioral (INV-6/INV-7).

## Dependencies

- `neotavern-presentation-scene` (platform core — product-free)
- `neotavern-presentation-chat` (`ChatSession` — command surface)
- feature `desktop-host`: `winit`, `wgpu`, `vello`, `pollster`, `png`,
  `serde_json`, `neotavern-presentation-kernel-wire` (the `--root` mode)
- dev: `neotavern-presentation-kernel-wire` (real-Kernel journey tests),
  `tempfile`

No dependency guard inversions: the pilot depends on the session crate;
the scene core depends on neither (see its README).

## Development commands

```bash
cargo test -p neotavern-presentation-scene-chat-pilot
cargo clippy -p neotavern-presentation-scene-chat-pilot --features desktop-host
cargo run -p neotavern-presentation-scene-chat-pilot --features desktop-host \
  --bin scene-pilot            # windowed dev host (see above)
```

## Constraints

- The pilot must not grow product logic: it projects state and routes
  input; anything smarter belongs in the session or the platform core.
- One geometry: never derive rects outside `FrameSnapshot`.
- The pilot does NOT render through Dioxus/Blitz — the vendored stack is
  transitively compiled via `presentation-chat` but never paints here.
- GPU rasters/goldens are local-only; the gate is behavioral
  (INV-6/INV-7).

## Status (2026-10)

Phase 1 gate green (journey + hit tests on the real Kernel); the winit
desktop bridge and the local raster harness are in (FakeWire + Kernel
modes; rasters verified pixel-level against the theme tokens). Not yet:
Android adapter, IME composition seam, message-list scrolling.
