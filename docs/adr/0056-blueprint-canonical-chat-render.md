# ADR-0056: Blueprint as the canonical chat chrome renderer (staged flip)

- Status: Accepted (stage 1 flipped; stage-2 gates verified — public
  announcement remains an explicit product decision)
- Date: 2026-08-22

## Context

Since ADR-0055 the chat surface has TWO renderers for the same inner chrome —
header, viewport, composer:

1. the hand-written legacy RSX (`presentation-dioxus-shell/src/lib.rs`,
   `product_chat_app`), and
2. the document-driven blueprint path
   (`presentation-dioxus-shell/src/scene_chat.rs`, `--blueprint`), which
   materializes the authored `ui-blueprint-document-chat-v1.json` into a
   `UiSceneV1` and renders it.

The blueprint path is proven by hard gates:

- skeleton parity vs legacy (`blueprint_chrome_skeleton_matches_legacy_rsx`),
  three slots, geometry ±0.5 px;
- pixel goldens (`pnpm chat:golden:check`) — legacy raster vs blueprint render,
  0.0000% drift on the canonical size trio;
- live-edit tests (structure and presentation overrides hot-reload from JSON);
- M4 waves 1–3 made labels, icons, token styles and declarative `custom.*`
  intents part of the document contract.

Keeping both renderers authoritative costs a double edit for every structural
change of the canonical document (the parity test enforces it) and blocks the
M4 goal that a UI author edits data only.

Not every chrome variant was document-covered at flip time. Follow-up
(stage 2) closed the only product-reachable gap:

- **compact height (≤240 CSS px)** — now renders from the document path with
  the legacy breakpoint presentation (flat composer bar, tighter padding,
  smaller bubbles, no version controls) and is pinned by a golden-matrix row
  (`900×220`, 0.0000% drift);
- **overlay glass (`TripleGlass | PaintOrder`) and nested dialog
  (`NestedDialog | PaintOrder`)** — **retired from scope**: they are M0
  perf-probe glass-layering scenarios (`presentation-perf-probe`), never
  product UI — `ChatSession::shell_view` pins `HeaderComposer`. The blueprint
  path keeps returning `None` for them with a one-time stderr notice, and the
  probes keep exercising the legacy renderer by design.

## Decision

Stage the flip so the desktop host stops treating legacy RSX as the default,
without removing it:

1. **Stage 1 (this ADR, done)** — `neocompositor-desktop` renders the inner
   chat chrome from the **embedded canonical document by default**.
   Opt-outs, strongest first:
   - `--legacy-chrome` or `NEOTA_LEGACY_CHROME=1` — safe-mode escape back to
     legacy RSX (also used by the golden capture gate, which must keep
     photographing the legacy renderer);
   - `--blueprint <path|embedded>` — explicit source;
   - `NEOTA_CHAT_BLUEPRINT_DOC=<path>` — authoring loop override.
     Uncovered variants fall back to legacy per frame with a one-time notice.
2. **Stage 2 (gated)** — public builds announce the flip only after ALL of:
   - ✅ the only product-reachable uncovered variant (compact height) renders
     from documents and joins the golden matrix (`900×220`); overlay/nested
     are retired as probe-only scenarios;
   - ✅ release-artifact verification of the default/rollback matrix
     (`pnpm blueprint:packaged-check`,
     `scripts/blueprint-packaged-check.mjs`): default embedded render,
     `--legacy-chrome` / `NEOTA_LEGACY_CHROME=1` rollback, flag/env
     precedence, and broken-document fallback (exactly one stderr diagnostic
     across frames, rendering continues, no panic). Scope note: Tauri
     installers/portable bundles do not ship this internal host today, so
     there is no bundle-level flip to verify; if the compositor host ever
     enters shipped packages, the same script runs against the bundled
     binary unchanged;
   - no open P0 against the blueprint path, and an explicit product decision
     to announce the flip publicly.
3. **Post-flip test shape** — once stage 2 lands, the cross-implementation
   parity test converts into a committed-skeleton snapshot check (blueprint
   vs its own recorded geometry, still ±0.5 px); the legacy RSX stays compiled
   as the safe-mode fallback and is deleted only by a later, explicit ADR.

The shell library default does not change: `ChatBlueprintSource::Disabled`
remains the library-level default so every crate test keeps its explicit
source under lock. Only the internal desktop host flips its startup choice.

## Alternatives considered

- **Keep dual authoritative renderers forever** — rejected: every structural
  edit costs two implementations plus parity reconciliation; the M4 promise
  (UI edits are data) stays broken for structure.
- **Delete legacy RSX now** — rejected: legacy is the verified fallback for
  uncovered variants and broken documents; deleting it before stage-2 gates
  would turn every gap into a blank screen instead of a graceful degrade.
- **Flip behind a nightly channel flag only** — rejected for this host: the
  desktop bin is already an internal/diagnostics surface; flipping its default
  here is exactly the cheap nightly soak the staging needs, while public
  distribution remains gated by stage 2.

## Consequences

- Structural edits of the canonical document no longer require synchronized
  legacy RSX changes for the covered (default-glass, expanded) mode; the
  parity test continues to enforce equality while legacy exists, so any
  intentional divergence must update both sides consciously until stage 2.
- The golden capture gate explicitly opts out with `--legacy-chrome`;
  forgetting it cannot happen silently because capture and check would then
  compare identical rasters at 0% — the gate's purpose statement in
  `scripts/chat-golden.mjs` documents this trap.
- Compact-height frames render identically from both renderers (pinned by
  the `900×220` golden row); overlay/nested remain probe-only legacy
  territory with a one-time stderr notice if anything ever routes them
  through an active blueprint source.
- Rollback is one env var or flag (`NEOTA_LEGACY_CHROME=1`) — no rebuild.

## References

- [ADR-0055](0055-react-ui-oracle-blueprint-pilot.md) — oracle/blueprint pilot.
- `docs/desktop/chat-ui-recipe.md` — authoring loop.
- `docs/desktop/rust-ui-style-port.md` §5b — golden gate mechanics.
