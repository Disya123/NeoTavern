---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0052-webview-removal.md
---

# ADR-0052: Production no-WebView cutover (Android Rust presentation is the default)

Date: 2026-08-20. Status: **Proposed** — pending product-owner signature and
the Milestone C/Dod acceptance listed in this record. Not active until the
compatibility-matrix `PARITY` rows below are owner-signed.

Related: [RFC 4.6](../rfc/neoui-v4-android-presentation-backend.md) §0.3/§2.4,
[presentation-boundary.md](../architecture/presentation-boundary.md),
[presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md),
[ADR-0049](0049-track-d-dioxus-presentation.md) (D1/D2 GO, D3 DEFERRED),
[ADR-0051](0051-android-talkback-webview-fallback.md) (native TalkBack
DEFERRED_BY_OWNER / product a11y WEBVIEW_FALLBACK),
[milestone-c-canary.md](../rfc/milestone-c-canary.md).

This ADR is the **WEBVIEW_REMOVAL milestone** the `audit-neoui-v4` README and
`01-COMPLIANCE-MATRIX.md` called for: it sets the owner, the date, and the
exit criteria so the Android `WebView` main renderer is no longer a permanent
canary fallback.

## Context

The Android host shipped with two renderers:

- `MainActivity` — `WebView` (production default, rollback, instrumented-test
  harness).
- `PresentationChatActivity` — Rust `SurfaceView` (`Dioxus → Blitz →
  NeoCompositor → Vello-GPU`), guarded canary, `NEOTA_DIOXUS_SHELL` opt-in.

`audit-neoui-v4` (2026-08-19) found the migration architecturally honest but
flagged **one open structural risk**: `WebView` removal had no owner/date, so
the canary could stay forever. The compatibility matrix still lists
`Production no-WebView cutover = DEFERRED` and eight other `DEFERRED` Android
rows (`presentation-compatibility-matrix.md:20-35`).

`milestone-c-adjudication.json` keeps `milestone_c = STARTED` (not RFC §51
PASS) and `compatibility_matrix = DEFERRED`. The Rust chat path has since
reached `HOST_CANARY_PASS` (8/8 cases) and the `P0/P1` audit items are
already fixed in-tree (see Consequences). The remaining work is to close the
`DEFERRED` rows with owner signatures and then flip the production default.

The Rust Kernel remains the only durable product authority (ADR-0038). This
ADR changes only the **Android presentation host default**, not the Kernel,
Product Wire, `database.sqlite`, or the `React`/`WebView` Web client.

## Decision

1. **Android production default becomes the Rust `SurfaceView` renderer.**
   - `PresentationChatActivity` is the `LAUNCHER` (`singleTask`). `MainActivity`
     is retained only as the guarded WebView fallback host (instrumented
     tests, TalkBack/touch-exploration rollback per ADR-0051, and
     crash-loop/forced-init-failure rollback).
   - The guarded `MainActivity` selector (safe mode ∨ crash-loop ∨
     accessibility/touch-exploration ∨ unqualified GPU ∨ flag-off → WebView;
     else Rust) stays as a **fallback**, not the default, until the rows below
     are signed. After signature, the default path is Rust and the WebView
     fallback is reached only via ADR-0051 accessibility / explicit safe-mode.

2. **Release ignores debug extras.** `NEOTA_DIOXUS_SHELL` and
   `NEOTA_SAFE_MODE` debug extras are ignored in release builds (already the
   case); release uses the signed rollout config / this ADR's default.

3. **`WebView` is removed from the released `APK` as a *main-screen* renderer.**
   The WebView engine may remain linked **only** for the `CONTAINED`
   `PluginVisualSurface` / legacy `window.SillyTavern` island path
   (ADR-0039/ADR-0050), scoped to a sandboxed `WebSurface` process. If no
   shipped plugin requires a WebSurface at cutover, the WebView dependency is
   dropped from the release artifact entirely.

4. **Visual parity is signed, not assumed.** The switch requires
   owner-signed `PARITY` (or `DEFERRED_BY_OWNER` with a dated re-confirmation)
   on every row of `presentation-compatibility-matrix.md`. The `Chat
   workspace`, `10k virtualization`, `Gboard typing/insets/editor-send`,
   `Theme SDK`, `i18n/RTL`, `Deep links/HostConnect`, `Safe mode` rows move to
   `PARITY`. `Live backdrop glass` moves to `PARITY` on `GateP:P1`
   qualified devices (CONTAINED degraded mode on the rest). `Plugin frontend`
   and `Legacy window.SillyTavern` move to `CONTAINED (WebSurface)` with a
   documented boundary.

5. **`opaque screenshots match React` is a hard gate.** The Rust route may be
   declared `PARITY` only after device-overlay `≤1 dp` diff versus the React
   golden is signed on at least one physical `120-Hz` qualified device (the
   existing Xiaomi `8f5c2b7c` reference) and one reference emulator, without
   hidden `NeoGlass` markers (the current
   `NeoGlass host markers are omitted until opaque screenshots match React`
   clause is lifted only on signed parity).

6. **`120-Hz` release budget is calibrated** by a companion ADR
   (`0053-android-120hz-release-budget.md`): `p99 input-to-present` budget is
   set, `thermal` and `sf_gpu_deadline_missed` admissibility are recorded, and
   `composite_only_frames > 0 && layout_rebuilds_on_scroll == 0` is closed as
   physical `PASS` (currently `PENDING_PHYSICAL`).

7. **Rollback is preserved.** The WebView `MainActivity` + `KernelHost` +
   `filesDir/neotavern` shared data-root remain the rollback. A release can be
   reverted to the WebView default via a signed config without a data
   migration. Durable product state is never migrated away from Product Wire.

## Alternatives

1. **Keep WebView as permanent default.** Rejected: violates the approved plan
   and leaves the `audit-neoui-v4` "eternal canary" risk open; contradicts
   D1/D2 GO direction.
2. **Remove WebView entirely including the plugin WebSurface.** Rejected now:
   `CONTAINED` plugin DOM islands and legacy `window.SillyTavern` still need a
   sandboxed surface; removing it would break the plugin compatibility boundary
   (ADR-0039). Scoped removal is tracked as a later hardening step.
3. **Declare cutover without signed parity.** Rejected: the whole NeoUI v4
   methodology forbids claiming `PARITY`/`PASS` without owner signature and
   `≤1 dp` evidence (`presentation-boundary.md`, `audit-neoui-v4`).

## Consequences

- `presentation-compatibility-matrix.md` is updated from `DEFERRED` to the
  signed `PARITY`/`CONTAINED` states in this ADR; `Production no-WebView
  cutover` moves from `DEFERRED` to `PARITY` (or `CONTAINED` if WebSurface is
  retained).
- `docs/architecture/presentation-boundary.md` `Visual parity` section is
  amended: the "not a visual golden PASS" / "not WebView runtime removal"
  language is lifted once parity is signed; until then it stays.
- The Rust chat host benefits from the already-merged `P0/P1` audit fixes, so
  this ADR does **not** re-open them:
  - `P0-01` hidden native `alpha 0.01` views → single `1×1 INVISIBLE`
    `PresentationChatComposer` IME bridge (`PresentationChatActivity.kt:131-167`);
  - `P1-02` naive CSS flatten → structured `collapse_css_math` +
    `measure_text_width`/`ellipsize_to_width` Parley path
    (`crates/presentation-design-system/src/lib.rs:50-310`);
  - `P1-03` unbounded avatar cache → LRU `AVATAR_GPU_MAX_ENTRIES=64` /
    `AVATAR_GPU_MAX_BYTES=8 MiB` (`avatar_gpu.rs:15-17,234-247`);
  - `P1-04` OOM image decode → header-only preflight
    `THUMBNAIL_INPUT_MAX_BYTES/DIMENSION/PIXELS` (`avatar.rs:24-63`);
  - `P1-05` HOL executor → bounded `pollStreamingBounded` yield +
    `onTrimMemory` `evictForPressure` (`PresentationChatActivity.kt:687-724`,
    `407-416`).
- Remaining implementation work (panel routes, markdown, sampleable media,
  glass enable, theme/i18n/RTL) is tracked in the companion migration plan and
  the matrix owner list; this ADR only sets the cutover contract and gate.
- `D3 = DEFERRED` is unchanged: Web stays React; no Web-Dioxus unification is
  implied.
- `CHANGELOG.md` records the cutover; a migration guide notes the WebView
  rollback path remains for accessibility/safe-mode.

**Owner:** Disya123 `<gamedisya@gmail.com>`
**Target date:** signed `PARITY` rows + physical `120-Hz` budget PASS before
the next packaged release gate (Milestone B/C PASS).
**Kill / revert trigger:** any `P0` parity regression, a `DEFERRED` row
re-opening without re-confirmation, or a failed physical `canary_batch`.
