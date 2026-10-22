# Native presentation platform (ADR-0057) — invariants, scene model, gates

> **Normative companion to
> [ADR-0057](../adr/0057-native-first-own-scene-platform.md).** This
> document specifies the product native UI platform: the non-negotiable
> invariants, the retained-scene model, the native theme contract, the
> editor-core input model, the conformance suite and the phased delivery
> gates. The defect evidence motivating each invariant is the
> [2026-10-04 Rust-branch audit](../audits/rust-app/README.md).

## 1. Purpose and scope

The platform covers the **product native contour**: the shared
presentation core and its thin platform adapters (desktop, Android;
later platforms join through the same core). The following stay out of
scope and unchanged:

- the Kernel and Product Wire (canonical; audit stage-1/2 fixes remain
  mandatory independently of this platform);
- the legacy migration plane
  ([ADR-0038](../adr/0038-canonical-rust-kernel-core.md)) — the shipped
  desktop UI during the transition, together with the remote Web Client
  artifact that sunsets as a product with it
  ([ADR-0058](../adr/0058-no-web-plugin-ir-platform.md)).

**Plugin UI (per [ADR-0058](../adr/0058-no-web-plugin-ir-platform.md))**:
native clients host no WebSurface and embed no browser engine. Plugin UI
renders only through declarative slots and the `PluginVisualSurface` IR
(§11) — host-rendered, theme-conformant, identical on every platform.
Legacy ST web-extension compatibility lives only in the React/legacy
contour and sunsets with it.

**Replaced by this platform** (product path only): Dioxus/native-dom
(VDOM), blitz-dom (DOM arena + stylo cascade), the hand-rolled CSS
baking in `presentation-design-system`, the `shell_hit` parallel
geometry, the Blueprint/legacy-RSX guard duality, the four vendor
patches, and FakeWire's role as the default test transport.

**Kept as mature primitives**: taffy (layout), Parley (text shaping and
measurement), Vello/wgpu (paint), the `chat-viewport` virtualization
and geometry mathematics
([crates/chat-viewport](../../crates/chat-viewport/README.md)), the
packed design tokens (sourced from the React golden design system), the
ChatSession command surface over Product Wire, and the
`neotavern-neocompositor` production types (display list, pass graph,
frame mailbox, hit/scroll/clip property trees — the scene platform is
their product consumer).

## 2. The seven invariants (normative)

Each invariant states the rule, what it forbids, and how it is tested.
An invariant violation is a defect at any phase, under any deadline;
waivers follow the existing
[exceptions process](exceptions.json) with explicit expiry.

### INV-1 — Single state truth

- **Rule**: all durable product state is hydrated from Kernel DTOs over
  Product Wire; the UI layer is a pure projection plus local transient
  input (caret, drag, hover). Every editable field is either a real
  canonical mutation with a verified durable postcondition, or renders
  explicitly `readonly`/`disabled` with a localized reason. A save action
  may never report success without re-reading (or otherwise verifying)
  the persisted value.
- **Forbids**: synthetic defaults replacing hydrated data; local
  "shadow" product settings; fabricated greeting/notes in the card
  editor; success states without a durable write
  (audit UI-01, UI-02, UI-04, UI-06..UI-08).
- **Test**: per-feature roundtrip harness — mutate → Wire → restart →
  re-hydrate → compare; synthetic-value sentinel (no view code path may
  generate product content); settings-hydration ordering test
  (defaults applied before hydration, never after).

### INV-2 — Single geometry truth

- **Rule**: one layout snapshot per frame is produced by the scene
  pipeline and is the only source of rects for painting, hit-testing,
  focus order, IME target placement and accessibility bounds.
- **Forbids**: manually reconstructed coordinate tables
  (`shell_hit`-style strides/offsets), per-control magic geometry, and
  test fixtures that pin a screenshot coordinate instead of reading the
  DOM/scene rect (audit UI-15).
- **Test**: probe harness resolves the center of every visible control
  from the snapshot and asserts each dispatches its own action across
  resize/DPI/long-translation/RTL; static gate: no hit-test arithmetic
  outside the snapshot module.

### INV-3 — Single render path

- **Rule**: exactly one scene graph and renderer exist in the product
  path. Document-driven variants (the blueprint JSON concept) change
  _data consumed by the scene_, not the renderer.
- **Forbids**: guard-switched renderer alternatives
  (Blueprint-vs-legacy-RSX pattern, audit UI-05/§systemic cause 4),
  pixel-diff parity gates between two internal native renderers as a
  substitute for behavioral correctness.
- **Test**: refactor-stability suite — mechanical refactors (renames,
  internal reorders) produce zero visual and behavioral diff on the
  scenario corpus; snapshot (not cross-renderer) goldens.

### INV-4 — Single input model

- **Rule**: one editor-core owns text fields by stable field ID:
  buffer, caret, selection, grapheme-aware editing, undo, composition
  (preedit), and the full key map (Enter, Tab, arrows, Home/End,
  Delete, shortcuts, clipboard). Platform hosts are bridges that
  translate OS input (winit events, Android `InputConnection`) into the
  model — nothing else.
- **Forbids**: append-only keystroke handling; per-screen input
  patches; a fake invisible field standing in for focus
  (audit PL-01, PL-03); per-field manual focus handoffs.
- **Test**: input conformance corpus runs identically on every adapter:
  mid-string insertion, selection replacement, multiline, emoji
  deletion, Ctrl+A/C/X/V, Tab/Escape navigation, IME commit/preedit,
  focus retention across panel switches.

### INV-5 — Single stream/lifecycle driver

- **Rule**: one driver owns generation-stream subscriptions: subscribe
  before dispatch, bounded work per wake with re-arm until terminal,
  explicit unsubscribe on route change, cancellation independent of
  provider I/O, and absolute deadlines checked outside blocking waits.
- **Forbids**: poll-count heuristics (Android's 40-poll cap),
  synchronous first-event waits inside present callbacks, per-platform
  retry semantics (audit PL-04, PL-05; Kernel companions KR-06, KR-11,
  KR-14).
- **Test**: slow-first-token, long-run, cancel-latency and
  route-change-during-stream scenarios against a deterministic mock
  provider on every adapter.

### INV-6 — Adapters are bridges only

- **Rule**: product decisions (what a control does, what a panel shows,
  how a stream is driven) live in shared code exactly once. A platform
  adapter contains only translation: window/surface lifecycle, OS input
  bridges, clipboard/export sinks, accessibility backend, insets.
- **Forbids**: duplicated host pipelines that re-decide product
  behavior (audit PL-L02); "desktop fix, Android still broken"
  outcomes — a shared-layer fix must be inherited by all adapters and
  proven by the same suite.
- **Test**: the conformance suite is adapter-parameterized: identical
  scenarios, identical assertions; a green desktop run grants nothing
  for Android (and vice versa).

### INV-7 — Behavioral evidence

- **Rule**: behavioral tests run against the real Kernel in isolated
  data roots. PASS records commit, binary, data seed and scenario.
  FakeWire is an explicitly labeled demo fixture for renderer
  development only — it may never gate a product claim.
- **Forbids**: green-on-fake/red-on-real gaps (audit UI-03), stale
  "FIXED/PASS" claims detached from the current revision.
- **Test**: conformance scenarios parameterize the transport: real
  Kernel first; FakeWire runs carry an explicit `fake` marker in
  reports.

## 3. Scene model (retained scene)

- **Node tree**: `SceneNode` with a stable `id` (survives reorders),
  role (`data-role`), component/part/state semantics
  (`data-component`/`data-part`/`data-state`), and declared layout
  intent (roles and slots, never absolute coordinates).
- **Slots**: the AGENTS §15 shell map (`navigation.primary`,
  `chat.viewport`, `panel.left`, `modal.layer`, …) is the structural
  contract; shell themes arrange slots, components fill them.
- **Arena lifecycle**: a bounded retained arena with epoch-based
  recycling; node death is explicit at transaction boundaries — no
  tracing GC, no no-op-GC patches (replaces PL-L03 containment).
- **Frame pipeline**:
  `state → projection (INV-1) → scene diff → taffy layout → Parley text → snapshot (INV-2) → Vello paint`;
  the snapshot is immutable for the frame and feeds paint, hit-test,
  focus and accessibility together.
- **Virtualization**: chat lists bind to
  [chat-viewport](../../crates/chat-viewport/README.md) windows; the
  scene materializes only the active window plus overscan; scroll
  anchors and focus survive window slides by construction.
- **Text**: Parley for shaping, measurement and ellipsizing; the
  editor-core (INV-4) shares the same layout data for caret/selection
  geometry — there is exactly one text geometry.
- **Effects**: the compositor pass graph (from `neotavern-neocompositor`)
  executes declared effects (blur/backdrop) or reports the capability
  as unsupported — no unexecuted marker paths (audit PL-L01 lesson).

## 4. Native theme contract

The three theme levels of AGENTS §14 are preserved as _concepts_, moved
off CSS in the native contour:

1. **Design tokens** — the packed golden tokens (colors, spacing,
   radii, typography, motion) consumed by name from the token registry;
   hardcoding values in components remains forbidden.
2. **Component skin** — per-component presentations defined as data
   (token bindings, effect declarations), addressable through the
   stable `data-*` semantics.
3. **Shell layout** — a shell theme arranges the §15 slots (whole-visual
   replacement: Wii U, console, mobile-client styles) without touching
   product logic; layout rules are slot-relative, RTL- and
   container-aware by construction.

- Themes are declarative data, never executed code; install/activate is
  atomic with rollback to the last-working boot theme; safe mode boots
  the built-in theme and a reset is always reachable.
- Internationalization: all user-visible strings come through the i18n
  layer; `lang`/`dir` are scene-global inputs; pseudo-locale and
  long-translation runs are part of the theme conformance corpus.
- Accessibility is part of the theme contract only in density/motion
  semantics; WCAG conformance is delivered by the semantic-tree export
  (§6), not by visual styling.

## 5. Editor-core and input bridges

- **Field model**: `FieldId`-addressable instances holding buffer,
  caret, selection, undo stack; grapheme-cluster-aware operations;
  multiline and single-line modes; read-only and disabled states.
- **Composition**: preedit spans with committed-boundary semantics; the
  visible caret/selection during composition come from the same text
  geometry as rendering.
- **Desktop bridge**: winit `WindowEvent::Ime` + keyboard events
  (including modifiers) routed to the editor-core; OS clipboard sink.
- **Android bridge**: a focusable platform view per active field (driven
  by the frame's focus owner from INV-2), `InputConnection`
  commit/setComposingText, back-key routing, insets-driven layout —
  replacing the invisible-bridge pattern (audit PL-03).
- **Acceptance** is the input conformance corpus of INV-4, plus Gboard
  composition/selection and TalkBack focus retention on a physical
  device (Phase-3 gate).

## 6. Accessibility and semantic tree

- The layout snapshot exports a semantic tree: role, name (localized),
  bounds, states, actions, focus order — the same data that paints and
  hit-tests (INV-2).
- Desktop: UIA/IA2 through the host adapter; Android:
  `AccessibilityNodeProvider` with both scroll directions actually
  moving the viewport (audit PL-06).
- No adapter may claim accessibility PASS from rendered pixels or
  attribute presence alone; the gate is a TalkBack/UIA walkthrough of
  the conformance scenarios.

## 7. Phases, gates and kill criteria

| Phase | Content                                                                                                                                                                                           | Gate (exit)                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | This ADR + spec; AGENTS amendments (§9); old contour feature-frozen                                                                                                                               | Docs accepted; sunset date recorded                                                                                                                                                                                              |
| 1     | Platform core + chat-screen pilot: scene pipeline, editor-core, single geometry, desktop bridge                                                                                                   | Full journey on the new scene: open chat → caret/selection editing → send → stream render → durable state verified in SQLite → restart restores draft; refactor-stability suite green; no parallel geometry in the pilot surface |
| 2     | All panels migrated; state contracts (INV-1) applied to session code; `PluginVisualSurface` IR schema v1 + security review (ADR-0058); conformance suite green on desktop against the real Kernel | Audit UI-01..UI-08 class closed with roundtrip tests; no synthetic-value sentinels; paginated catalogs (UI-03 class) reach item 101+; IR reviewed for bounds, counts, permissions, crash isolation                               |
| 3     | Thin Android adapter; IME bridge; semantic tree export; plugin-slot scenarios in the conformance corpus; physical-device runs                                                                     | Same conformance suite green on a physical device (plugin slots included); Gboard composition/selection; TalkBack walkthrough; the ADR-0051 WebView-fallback posture is retired by evidence, not by promise                      |
| 4     | Delete Dioxus/native-dom, blitz-dom, CSS baking, vendor patches; native theme contract finalized; legacy/React contour and Web Client sunset executed per ADR-0058; performance gates             | Zero browser-form dependencies and zero embedded browser engines in product runtimes; §24 performance targets measured (startup, idle memory, 10k chat open, streaming update rate); ADR-0056/0049-D2 supersession executed      |

- **Kill criteria (owner decision, honest exit)**: if the Phase-1 pilot
  cannot pass its gate within the owner-approved budget, the program
  stops by ADR, the old contour resumes maintenance, and this platform
  doc records the measured failure. The prohibited outcome is drifting
  between two half-owned contours.
- **Old-contour rules (Phases 0–4)**: defect/security fixes and the
  pilot's comparison baseline only; no new product features; no new
  parallel truths (an invariant violation in the old contour is fixed by
  deletion, not by a fifth copy).

## 8. What survives, what is deleted

| Survives                                                                    | Deleted at/before Phase 4                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Kernel, Product Wire, envelope transports                                   | —                                                                                              |
| `chat-viewport` virtualization math                                         | `shell_hit` tables and manual strides                                                          |
| Parley/Vello/taffy plumbing                                                 | Dioxus/native-dom VDOM                                                                         |
| Design tokens packed from React goldens                                     | blitz-dom arena + no-op GC patch                                                               |
| ChatSession command surface (rewired to INV-1)                              | hand-rolled CSS baking + stylo cascade in the product path                                     |
| `neocompositor` production types (display list, pass graph)                 | Blueprint-vs-RSX guard; remaining vendor patches                                               |
| React contour as the transitional legacy UI + design oracle (ADR-0038/0055) | React as the _product UI_ target; Web Client as a product and any native WebSurface (ADR-0058) |
| React oracle as design reference (ADR-0055)                                 | React-parity as a _release gate_                                                               |

## 9. AGENTS.md amendments (applied 2026-10-04)

This ADR changes the approved-stack statements; the owner applied the
corresponding [AGENTS.md](../../AGENTS.md) amendments in the same change.
They are recorded here as the standing norm for agents:

1. **§2 approved stack** — the native presentation platform (ADR-0057) is
   the product UI plane for desktop/Android; React remains for the
   transitional legacy plane and the design oracle (React contour); the
   Web Client and plugin WebSurface roles are sunset by ADR-0058.
2. **§13 frontend** — the React-specific rules (TanStack
   Query/Zustand/virtualization) are scoped to the React contour; the
   native contour references this platform document and its invariants.
3. **§14 theme stack** — the CSS Modules/Cascade-Layers stack is the
   React-contour implementation; native themes follow §4 here
   (tokens + data-driven skins + slot shells); hardcoding bans apply to
   both contours.
4. **§21 desktop** — the product desktop shell target is the native host;
   Tauri/WebView remains the transitional packaging until the Phase-4
   gate (honest default rules unchanged).
5. **§23 testing** — the conformance suite is adapter-parameterized
   (INV-6/INV-7): identical scenarios per adapter and against the real
   Kernel; FakeWire runs never gate product claims.

## 10. Evidence cross-reference

The audit IDs referenced throughout live in
[KERNEL.md](../audits/rust-app/KERNEL.md),
[PRESENTATION.md](../audits/rust-app/PRESENTATION.md) and
[PLATFORMS.md](../audits/rust-app/PLATFORMS.md); the run protocol and
limitations are in
[VERIFICATION.md](../audits/rust-app/VERIFICATION.md). This platform
document is the response plan for the presentation-layer findings; the
Kernel findings follow the audit's own stage 1–2 ordering.

## 11. Plugin UI surface (slots + PluginVisualSurface IR, ADR-0058)

Native clients host no WebSurface and embed no browser engine
([ADR-0058](../adr/0058-no-web-plugin-ir-platform.md)). A plugin's UI
reaches the user through exactly two mechanisms, both **host-rendered**:

1. **Declarative semantic slots** (ADR-0037, shipped): the plugin
   registers data (labels, rows, actions, renderer declarations) for the
   five semantic slots; the host re-validates, permission-gates and
   renders with its own components.
2. **`PluginVisualSurface` IR** (pulled forward from
   [ADR-0050](../adr/0050-visual-surface-ingress-vs-plugin.md)
   Milestone D into Phases 2–3): a versioned, bounded scene-fragment
   schema — containers, text, image asset refs, buttons and inputs wired
   to the plugin's RPC handlers over the Product Wire plugin surface.
   Schema v1 shipped at Phase 2:
   `packages/plugin-sdk/src/visual-surface.ts` (fail-fast validation,
   stable error codes, enforced bounds/counts) with its security review at
   [docs/plugin-sdk/visual-surface-ir.md](../plugin-sdk/visual-surface-ir.md);
   host rendering of fragments and the conformance scenarios remain the
   Phase 3 deliverable.

Platform rules for plugin fragments (normative):

- **Styling references tokens only** — the Theme SDK restyles plugin UI
  automatically and identically on every platform; raw colors, fonts and
  spacing in a fragment are a schema violation, not a style hint.
- **Input** flows through the single input model (INV-4): plugin fields
  are `FieldId`-addressable like product fields; focus follows the frame
  snapshot focus order (INV-2).
- **Accessibility** exports through the same semantic tree (§6): plugin
  nodes carry role, name, bounds, states and actions like product nodes.
- **Z-order stays under host chrome** (ADR-0022): a fragment never
  overlays app chrome, modals or the notification layer.
- **Bounds, counts and permissions**: fragment size, node count, nesting
  depth and asset refs are capped by the IR schema; capabilities are
  permission-gated; a crashing or stalling plugin handler degrades to an
  honest per-fragment error, never to a host freeze (crash isolation per
  ADR-0024).
- **Conformance**: plugin-slot scenarios are part of the adapter-parameterized
  suite — a plugin renders and behaves identically on desktop and Android
  by construction; any divergence is a defect, not a platform difference.
- **Expressiveness honesty**: IR v1 is bounded by its schema; a plugin
  needing more either grows the IR through a versioned extension or shows
  an honest `CAPABILITY_UNAVAILABLE` — never an embedded engine.

Legacy SillyTavern web extensions (DOM/JQuery/`window.SillyTavern`) run
only in the React/legacy contour (AGENTS §18) for its remaining lifetime;
the migration guide to this surface is part of the ADR-0058 program.
