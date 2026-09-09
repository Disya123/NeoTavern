# NeoTavern bounded patch — blitz-dom 0.3.0-beta.1

Upstream: <https://crates.io/crates/blitz-dom> (0.3.0-beta.1, vendored verbatim
except for the changes below).

## Changes

1. `DocumentMutator::remove_node_if_unparented` (`src/mutator.rs`): **arena
   GC disabled** — the call is a no-op.
2. `BaseDocument::node_count` (`src/document.rs`, new): read-only accessor
   for the live+detached node count, used by hosts for leak containment.
3. `DocumentMutator::add_children_to_parent` (`src/mutator.rs`): defensive
   guard — skip the old-parent damage cleanup when the old parent id is no
   longer in the arena (unreachable today; kept as a seatbelt for any future
   drop path, e.g. `set_inner_html`).

## Why

dioxus-native-dom 0.8.0-alpha.1 recycles `ElementId`s and GCs detached
nodes via `assign_node_id` → `remove_node_if_unparented` →
`remove_and_drop_node`, which drops ONE node from the arena while

- its descendants keep `parent` pointing at the now-dead id, and
- every `ElementId → NodeId` mapping that referenced the dropped subtree
  stays alive.

Later mutations then index arena-dead ids and panic with `invalid key`
(SlotMap) — reproducibly, whenever the virtualized chat message window
shifts rows (id recycling) after any structural change: a plain chat
wheel-scroll, a panel switch followed by a window-resize that grows the
visible window. Reproduced with scripted probes and live-window resizes
(PowerShell `SetWindowPos`); debug backtraces pin the panic sites at
`node_at_path` and `add_children_to_parent`.

With the GC disabled, nothing is ever dropped from the arena, so no id the
mutation stream references can be dead. Detached subtrees accumulate
instead — bounded by the host's cold re-open containment (see below).

## Leak accounting

Live DOM at desktop sizes is ~120–180 nodes (dom-dump). Measured growth on
this machine: ~33 detached nodes per landed wheel notch on a scrolling chat
(~1 row subtree). The desktop host caps the arena at 8192 nodes
(`ARENA_COLD_REOPEN_NODES`, overridable via `NEOTA_ARENA_COLD_REOPEN`):
past the cap the warm session is dropped and the next produce cold-opens a
fresh document (~90 ms release, one frame). At ~12 MB worst case for the
arena this stays deep inside the §24 RAM budget, and a soak test with the
cap forced to 250 crossed it five times over 30 notches with the arena
resetting after each cold open (1680 → 742 …) and the process healthy.

Note: upstream already leaked the descendants of every GC'd node; this
patch additionally retains the roots, ~5% more per removed subtree.

## Scope

Three small producer-seam changes; no layout, text, paint or style logic.
Remove this vendored crate when an upstream blitz-dom/dioxus-native-dom
release carries a real fix for the id-recycling GC.
