# Vendored M0-D2 paint-seam patches

Local `[patch.crates-io]` snapshots of:

- `anyrender` **0.11.0** — default `PaintScene::host_node_marker`
- `blitz-paint` **0.3.0-beta.1** — emit a glass marker from `render_element`

These are **not** a private layout/text fork. The exact diffs live in
[`../presentation-m0-d2/upstream/`](../presentation-m0-d2/upstream/).

Do not edit layout, Styło, Parley, or inline text here. If a glass barrier
cannot be inserted at this paint-order point, that is `M0-D2 FAIL`.
