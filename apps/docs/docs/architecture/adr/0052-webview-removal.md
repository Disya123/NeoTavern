---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0052-webview-removal.md
---

# ADR-0052: Production no-WebView cutover (Android Rust presentation is the default)

Date: 2026-08-20. Updated: 2026-08-21. Status: **Accepted (platform prerequisites done, cutover remains CANARY)** — implementation prerequisites landed (see Consequences 2026-08-21). Production cutover stays **STARTED / CANARY** until compatibility-matrix `PARITY` rows are owner-signed with physical evidence (≤1 dp, 120-Hz budget re-run).

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
- **2026-08-21 platform checklist (this update):**
  - `AndroidManifest.xml` `PresentationChatActivity` `launchMode` → `singleTask` (was `singleTop`).
  - `network_security_config.xml` broad `base-config cleartext=true` documented as intentional for LAN HostConnect (ADR-0030) + explicit `domain-config` for localhost/10.0.2.2/10.0.3.2 for audit clarity.
  - `crates/presentation-design-system/scripts/pack_design_system.py` `expand_axis_shorthand` fixed to paren-aware top-level split; regenerated `generated/product.css` — `host-connect` `padding-block/inline` and `AppShell_statusArea` `inset-inline` no longer corrupt (`max(32px,;` / `calc(;` fixed, verified `NO_CORRUPTION_FOUND`).
  - `docs/rfc/milestone-b-exit.json` `release_budget_calibration_adr` → `docs/adr/0053-android-120hz-release-budget.md`, `release_budget_status=CALIBRATED_PENDING_PHYSICAL`.
  - **2026-08-20 shell parity (≤1dp):** `crates/presentation-dioxus-shell/src/product_shell.rs:180-192` `panel_header_title`/`character_manager_title` now subtract `header gap 12` (was `8`) — `Character Ma…` ellipsizes like React `flex + ellipsis` on `407px` phone (was `Character Manag`); `cards_tab` `pinned = pinned.or(selected)` fallback — Hazel `fill PushPin` matches `CharactersPage.tsx` `pinnedCharacterId`; verified `neotavern-presentation-dioxus-shell` `15/15`, `app-debug.apk` on `8f5c2b7c`.
  - **2026-08-20 safe mode fallback:** `PresentationChatActivity.kt:94-112` `NEOTA_SAFE_MODE=1` (extrasTrusted) now logs `renderer=webview webview_fallback=true` and `startActivity(MainActivity + EXTRA_SAFE_MODE=1, CLEAR_TOP|SINGLE_TOP)` + `finish()` — `dumpsys activity activities` `topResumedActivity=.MainActivity` as `milestone-c-physical-runbook` expects (`safe_mode` → `MainActivity`), previously only logged `renderer=rust` and stayed in `PresentationChatActivity`.
  - **2026-08-20 live_open on clean DB (`EMPTY_LIBRARY` → `PARITY`):** `crates/presentation-chat/src/session.rs:936` `load_open_chat` now `chats.list` → `characters.list` → `chats.create` (or `characters.create` → `chats.create`) on a fresh `pm clear` DB so `chat_route=true … 8 … error=none` on `8f5c2b7c` (`app-debug.apk` `158412530` `libneotavern_presentation_chat.so` `35073544` in `src/main` **and** `src/debug` `arm64-v8a`, `gradle clean` flushes `merged_jni_libs` `23904264` → `35073544`), previously `4 … EMPTY_LIBRARY`. `FakeWire::empty()` test updated (`26 passed`). `milestone-c-physical-capture` `live_open` now `PASS` (title `Hazel`/`Live wire chat`, `messageCount 0`, `error none`).
  - Cutover remains **CANARY**: `MainActivity` stays without `LAUNCHER` intent; `PresentationChatActivity` is `LAUNCHER singleTask`; `hasWebView()` still logs `webview_in_tree=false` for instrumented checks; physical `live_open` `PASS` on clean DB, `120-Hz` `composite_only_frames>0` re-run `PASS` on `8f5c2b7c` (`composite_only_frames=69390 layout_rebuilds_on_scroll=0`, `perf22` Vulkan live glass `under_glass=true`). Remaining gate: `≤1 dp` overlay signature (Disya123) before flipping `PARITY` rows; glass `GateP:P1` stays `qualified PARITY`/`degraded CONTAINED` pending that signature (ADR-0053 budget now `physical PASS`).
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
