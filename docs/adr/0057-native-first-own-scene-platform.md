# ADR-0057: Native-first product UI — own retained-scene platform over mature primitives

- Status: Accepted (owner direction, 2026-10-04; execution is phased with
  explicit kill-gates — the legacy Dioxus/Blitz contour is deleted only by
  the Phase-4 gate, never kept as a second product path)
- Date: 2026-10-04

## Context

The owner set the product requirement explicitly: **the product UI is
native and only native** — one Rust presentation core with thin
platform adapters, one plugin/theme UI SDK surface, no browser engine in
the product UI path. React-in-WebView was rejected as the product path:
it is not "one UI everywhere" but four engines (WebView2, WKWebView,
WebKitGTK, Android WebView) with platform-specific text, IME, scroll and
accessibility behavior, plus a browser process in every product runtime.
WebView stays only in the roles already assigned elsewhere: the remote
Web Client ([ADR-0043](0043-web-client-remote-only.md)), the legacy
migration plane ([ADR-0038](0038-canonical-rust-kernel-core.md)) and
CONTAINED plugin WebSurface islands
([ADR-0054](0054-plugin-visual-surface-contained.md)) — all three web roles
are then closed by [ADR-0058](0058-no-web-plugin-ir-platform.md): after the
transition no product runtime embeds a browser engine, and the plugin UI
platform is host-rendered slots + IR.

The current native contour (D1/D2 GO,
[ADR-0049](0049-track-d-dioxus-presentation.md)) renders through
browser-form emulation: Dioxus/native-dom `0.8.0-alpha.1` (VDOM),
Blitz `0.3.0-beta.1` (DOM arena + stylo CSS cascade), plus taffy, Parley,
Vello and four local vendor patches. The 2026-10-04 audit
([docs/audits/rust-app/](../audits/rust-app/README.md)) shows the
fragility is structural, not incidental:

- The **emulation layers are the defect surface**: a hand-rolled CSS
  baking step computes subtraction as addition (UI-05); hit-testing is a
  second, manually reconstructed coordinate table that opens the wrong
  panel (UI-15); text input is append-only with no caret/selection/IME
  (PL-01) and an invisible 1×1 `EditText` on Android (PL-03); there is no
  accessibility tree (PL-06); the blitz-dom patch disables arena GC
  (PL-L03).
- **Parallel truths** exist for state (synthetic fields, lost drafts and
  settings — UI-01..08), geometry (paint vs `shell_hit`), render paths
  (Blueprint vs legacy RSX behind a guard) and stream drivers (three
  independent ones — PL-04/05). Local fixes drift instead of
  accumulating; the audit describes this exact mechanism.
- FakeWire passes where the real Kernel fails (UI-03), so green tests
  do not prove product behavior.

The owner's conclusion after months of UI work on this contour: the
"patch → partial fix → regression" mode is a property of the
construction, and the browser-shape tax is permanent for a team of this
size. The mature primitives underneath (taffy, Parley, Vello/wgpu) are
not the problem; the VDOM/DOM/CSS-cascade emulation on top of them is.

## Decision

1. **The native Rust presentation is the product UI path** for desktop
   and Android (later: other platforms through the same core). The
   React contour is not the product UI target anymore; it keeps the
   transitional legacy-UI and design-oracle roles, while the Web Client
   and plugin WebSurface roles are sunset by
   [ADR-0058](0058-no-web-plugin-ir-platform.md).

2. **Replace the browser-form emulation with an own retained-scene
   platform** (working name `neotavern-presentation-scene`), built
   only over mature primitives: taffy (layout), Parley (text),
   Vello/wgpu (paint). Dioxus/native-dom, blitz-dom, the hand-rolled CSS
   baking and the stylo cascade leave the product path in the phases
   below. This is a model change, not a dependency minimalism exercise:
   layout and text shaping are not rewritten from scratch.

3. **Seven non-negotiable platform invariants** become the normative
   core of the platform (full text with tests and acceptance:
   [native-presentation-platform.md](../architecture/native-presentation-platform.md)):

   - INV-1 single state truth — UI is a projection of Kernel DTOs; no
     synthetic values; unsupported capabilities render explicitly
     disabled; no success without a verified durable postcondition.
   - INV-2 single geometry truth — one per-frame layout snapshot feeds
     paint, hit-test, focus order and accessibility bounds; no parallel
     coordinate tables.
   - INV-3 single render path — one scene graph; no guard-switched
     renderer alternatives in the product path.
   - INV-4 single input model — one editor-core (stable field IDs,
     caret, selection, grapheme-aware editing, composition); platforms
     are thin bridges to it.
   - INV-5 single stream/lifecycle driver — one owner for
     subscribe/re-arm/terminal/unsubscribe; deadline and cancellation
     are checked outside blocking I/O.
   - INV-6 adapters are bridges only — product decisions live in shared
     code; every adapter passes the same conformance scenarios.
   - INV-7 behavioral evidence — conformance runs against the real
     Kernel in isolated data roots; PASS binds to commit + binary +
     scenario; FakeWire is an explicitly labeled demo fixture, never
     evidence.

4. **A native theme contract replaces CSS for the native contour**: the
   three theme levels of AGENTS §14 (design tokens, component skin,
   shell layout) are applied by the platform from data — themes remain
   declarative and never execute code; `data-component`/`data-part`/
   `data-state` semantics remain the stable styling API. The React
   contour keeps the CSS stack as written; the native contract is
   specified in the platform document.

5. **Phased delivery with kill-gates** (normative gates in the platform
   document): Phase 0 — decision, spec, AGENTS amendments, feature-freeze
   of the old contour; Phase 1 — chat-screen pilot on the new scene;
   Phase 2 — panel migration plus the state contracts; Phase 3 — thin
   Android adapter, IME and accessibility; Phase 4 — deletion of
   Dioxus/Blitz and all four vendor patches, performance gates. The
   old contour is immediately limited to defect/security fixes and the
   pilot's comparison baseline, with a dated sunset.

6. **Supersession map**:
   [ADR-0049](0049-track-d-dioxus-presentation.md) D2 (Dioxus+Blitz as
   the product producer) is superseded at the Phase-4 gate;
   [ADR-0056](0056-blueprint-canonical-chat-render.md) (Blueprint
   canonical flip) is superseded at the Phase-4 gate — the blueprint
   document/scene concepts are absorbed into the scene model;
   [ADR-0051](0051-android-talkback-webview-fallback.md) remains the
   transitional accessibility posture until Phase 3, after which
   native accessibility is delivered by the semantic-tree export;
   [ADR-0052](0052-webview-removal.md) continues, with the scene
   platform as the target renderer; the React oracle
   ([ADR-0055](0055-react-ui-oracle-blueprint-pilot.md)) remains
   design-reference tooling, not a production ABI;
   [ADR-0054](0054-plugin-visual-surface-contained.md) is superseded in
   its end-state by
   [ADR-0058](0058-no-web-plugin-ir-platform.md) (no WebSurface in native
   clients; plugin UI is host-rendered slots + IR).

7. **Kernel data integrity is not deferred**: the audit's stage-1/2
   Kernel fixes (KR-01..KR-07, KR-11, KR-13, KR-14) are mandatory
   prerequisites and companions of Phases 1–2 — UI hydration is
   meaningless over a Kernel that loses data. They are
   paradigm-independent and stay in force regardless of renderer
   progress.

## Alternatives considered

- **Finish the current Dioxus+Blitz platform** — rejected: permanent
  mini-browser maintenance (the AGENTS §14 CSS surface — cascade
  layers, container queries — is a browser-team workload), alpha/beta
  upstream churn, four vendor patches, and the audit-documented drift of
  local fixes without invariants.
- **Adopt a ready non-DOM framework (egui/iced/slint)** — rejected:
  Android IME and accessibility depth required by AGENTS §22 is weak
  across the ecosystem; theming depth for full shell replacement
  (§14) is unproven; the seams would still be someone else's, which is
  where the current pain started; one candidate needs a licensing review.
- **Keep React/WebView as the product UI** — rejected by the owner as
  an explicit assignment (see Context): per-platform engine behavior is
  the multiplication the owner wants to remove.
- **Rewrite on raw wgpu without taffy/Parley** — rejected: radical in
  effort, not in correctness; layout and text shaping from scratch is a
  multi-year program, and the primitives are already mature.

## Consequences

- **Positive**: the fix-drift mode ends by construction — each truth has
  exactly one owner; the CSS/DOM conformance defect class disappears
  with the CSS engine; vendor patches go to zero; one codebase serves
  every platform through thin adapters enforced by the conformance
  suite.
- **Cost (accepted)**: months of platform work before product-UI
  velocity resumes; the editor-core with IME and the accessibility
  tree are the hardest deliverables; React-parity gates convert into
  design-reference checks (React goldens remain the visual reference;
  the design tokens are already packed from them).
- **Transitional**: two contours exist until Phase 4. The old
  Dioxus/Blitz contour must not receive new product features; it stays
  compilable as the comparison/safe-mode baseline with a dated sunset.
  Abandoning the program mid-phase without an ADR is the one
  prohibited outcome — five parallel truths were worse than one.
- **Documentation**: the owner applied the required AGENTS.md amendments
  (§2 approved stack, §13 frontend, §14 theme stack, §21 desktop, §23
  testing) in the same change — recorded as applied in the platform
  document §9. ADR-0038's React/Tauri product-shell statements are
  superseded for the product-UI plane by this ADR.
- **Risks**: editor-core/IME on Android is the highest-risk deliverable;
  the Phase-1 pilot gate and the kill criteria exist to make failure
  cheap and honest instead of silent.

## References

- [Native presentation platform spec](../architecture/native-presentation-platform.md)
  — normative invariants, scene model, theme contract, input model,
  conformance gates, phase plan.
- [Rust-branch audit, 2026-10-04](../audits/rust-app/README.md) —
  defect catalog and reproduced evidence backing this decision.
- [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0043](0043-web-client-remote-only.md),
  [ADR-0049](0049-track-d-dioxus-presentation.md),
  [ADR-0051](0051-android-talkback-webview-fallback.md),
  [ADR-0052](0052-webview-removal.md),
  [ADR-0054](0054-plugin-visual-surface-contained.md),
  [ADR-0055](0055-react-ui-oracle-blueprint-pilot.md),
  [ADR-0056](0056-blueprint-canonical-chat-render.md).
