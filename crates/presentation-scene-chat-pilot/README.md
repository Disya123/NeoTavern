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

## Dependencies

- `neotavern-presentation-scene` (platform core — product-free)
- `neotavern-presentation-chat` (`ChatSession` — command surface)
- dev: `neotavern-presentation-kernel-wire` (real-Kernel journey tests),
  `tempfile`

No dependency guard inversions: the pilot depends on the session crate;
the scene core depends on neither (see its README).

## Development commands

```bash
cargo test -p neotavern-presentation-scene-chat-pilot
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

Phase 1 gate green (journey + hit tests on the real Kernel). Not yet:
winit desktop bridge (`desktop-host` feature — next increment), GPU
raster goldens (local-only), Android adapter.
