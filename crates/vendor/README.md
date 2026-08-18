# Vendored M0-D2 paint-seam patches

Local `[patch.crates-io]` snapshots of:

- `anyrender` **0.11.0** — default `PaintScene::host_node_marker` and
  `PaintScene::host_text_fragment`
- `blitz-paint` **0.3.0-beta.1** — emit a glass marker from `render_element`
  and replay already-shaped Parley layouts as host text fragments

These are **not** a private layout/text fork. The exact diffs live in
[`../presentation-m0-d2/upstream/`](../presentation-m0-d2/upstream/).

Do not edit layout, Styło, Parley, or re-shape text here. If a glass barrier
cannot be inserted at this paint-order point, that is `M0-D2 FAIL`. If
clusters/bidi/glyph geometry cannot be copied from the existing Parley
layout, that is a bounded-hook gap — not a compositor shaper.
