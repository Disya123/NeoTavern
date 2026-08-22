# Presentation boundary (Milestone A)

**Status:**

```text
Milestone A = PASS
A/Product Wire boundary = PASS
shared-device raster interop = PASS
platform gesture adapter = PASS
Milestone B = PASS
Milestone C = STARTED
core chat journey batch = PASS
production cutover = STARTED / CANARY
canary_batch = PASS
```

Milestone A **PASS** is the feature-flagged Product Wire shell, React ↔
Dioxus canonical projection parity, and presentation-path streaming tests.
Milestone B **PASS** is the independent physical PERF-01…22 / device-loss
registry. Neither is a production migration, Milestone C PASS, or an unguarded
`MainActivity` cutover. Cutover is **STARTED / CANARY**.

**Decisions:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md),
[ADR-0050](../adr/0050-visual-surface-ingress-vs-plugin.md),
[ADR-0051](../adr/0051-android-talkback-webview-fallback.md),
[ADR-0052](../adr/0052-webview-removal.md),
[ADR-0053](../adr/0053-android-120hz-release-budget.md),
[ADR-0054](../adr/0054-plugin-visual-surface-contained.md),
[d1-d2-decision.md](../rfc/d1-d2-decision.md).
**D3:** **DEFERRED** — Android may take a Rust presentation path; Web stays
React. Rollback is the acting React/WebView host.

This is not a production migration and not Milestone C PASS.

## Audit (RFC §49)

| Deliverable                              | Status                                        | Where                                                                                                       |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Product Wire                             | **present**                                   | `packages/contracts/src/wire/` (97 operations, kernel dispatch 1:1)                                         |
| Canonical view models                    | **present**; **React ↔ Dioxus parity tested** | Shared fixture `packages/contracts/src/presentation/fixtures/canonical-chat.json`                           |
| Typed commands                           | **PASS** (boundary)                           | Presentation may issue only Product Wire `operationId`s (`packages/contracts/src/presentation/boundary.ts`) |
| React Web adapter                        | **present**                                   | `apps/web` + `@neotavern/neobackend` over Product Wire                                                      |
| Dioxus presentation shell                | **present (flagged)**                         | `crates/presentation-dioxus-shell`. Not `MainActivity`. `NEOTA_DIOXUS_SHELL=1` is non-default               |
| Fixture recorder                         | **PASS** (boundary)                           | `recordPresentationFixture` in the boundary module                                                          |
| Generation / backpressure tests          | **present** (presentation-path)               | Stale generation drop + bounded stream cap; React ↔ Dioxus golden projection                                |
| PresentationCompatibilityMatrix          | **baseline**                                  | [presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md)                         |
| Theme / Plugin / i18n / legacy inventory | **baseline**                                  | same matrix; no silent supersede                                                                            |
| D3 plan                                  | **accepted as DEFERRED**                      | Android Rust path + Web React; no unification mandate                                                       |

## Rules

1. The Rust Kernel remains the only durable product authority (ADR-0038).
2. Presentation (React, WebView, future Dioxus/NeoCompositor) **consumes**
   Product Wire. It MUST NOT open SQLite, write `database.sqlite`, or bypass
   Wire for product mutations.
3. A presentation command is invalid unless its `wireOperationId` exists in
   `buildProductWireRegistry()`.
4. Production Android `MainActivity` stays WebView until the guarded canary
   selector allows Dioxus. That selector MUST run **before** a Rust
   presentation host (`System.loadLibrary` / JNI open). Default remains
   WebView. In a debuggable build, `NEOTA_DIOXUS_SHELL=1` is a
   **non-default** persisted canary opt-in (cleared by `=0`); launcher and
   notification starts then reuse it. Release ignores these extras pending
   a signed rollout config.
   `NEOTA_NEOCOMPOSITOR=1` is a **non-default** feature flag for
   `crates/neocompositor`, not a cutover switch.
   TalkBack / touch exploration MUST select WebView **before** a Rust
   presentation host is created ([ADR-0051](../adr/0051-android-talkback-webview-fallback.md)).
5. M0 probe crates stay probes and are not production JNI. Interchange
   types (`NeoDisplayList`, `compile_passes`) live in
   `neotavern-neocompositor`; probes re-export them.

## Surfaces

```text
react-web                  — production Web / desktop UI (migration golden)
webview-android-rollback   — production Android default (retained until Character Manager visual golden PASS)
dioxus-android-canary      — MainActivity selector; STARTED / CANARY; not default
dioxus-android-chat-route  — PresentationChatActivity; NeoCompositor SurfaceView; same Kernel; canary + debug harness
dioxus-android-design-system — packed React fonts/tokens/icons/CSS; Character Manager RSX STARTED; visual golden NOT PASS
```

## Milestone B

`crates/neocompositor` holds production interchange types, a bounded
`FrameTransaction` mailbox, spatial/scroll/clip/effect property trees,
CPU scroll/animation fast paths, async hit-test / nested-scroll dispatch,
interaction-ready text snapshots, a cross-tile selection underlay (PERF-19
**PASS** on physical Vulkan, not production cutover), a PERF-18 effect-scope
backdrop capture (**PASS** on physical Vulkan, not production cutover), a CPU
device/surface recovery state machine (injection-tested, not production JNI,
not production cutover), bounded GPU telemetry (CPU snapshot; GPU timestamps
on that snapshot stay `Unavailable` and are not image readbacks; not
production cutover), and a shared-device raster interop CPU protocol
(`SharedGpuContext`; one `DeviceEpoch`; sampleable raster texture;
`image_readbacks=0`, `cross_device_copies=0`; not production JNI, not
production cutover). B-level
`VisualSurfaceFrameIngress` is the trusted VisualSurface queue
([ADR-0050](../adr/0050-visual-surface-ingress-vs-plugin.md)); it is not
Plugin SDK. Chat
virtualization lives
in `crates/chat-viewport` (height index, predictor, bounded tile cache,
geometry epochs / C0/C1 remap; compositor sees only the **active** tile
descriptors and geometry snapshot). PERF-20 is **PASS** on the physical
Vulkan multi-frame trace, not production cutover. The Blitz producer publishes `TextInteractionSnapshot`
from already-shaped Parley layouts (no compositor reshape). Viewport remap and
selection go through `crates/presentation-session` (one
`FrameTransaction`, logical selection, `DeltaToken`). Host product-path
corpus for PERF-01 / PERF-02 / PERF-16 lives in
`presentation-session` `tests/product_path_perf.rs`
(Wire → flagged Dioxus → Blitz → session → compositor). That host
corpus is **not** an independent PASS. Independent stamps:
[`docs/rfc/perf-18-20-adjudication.json`](../rfc/perf-18-20-adjudication.json).
Debug-only
`crates/presentation-perf-probe` / `PresentationPerfActivity` is the
physical capture vehicle (not production JNI), including debug
`PERF_SCENARIO=interop` (host **PASS** on physical Vulkan; not cutover). Neither crate is linked into
production JNI. Device/surface recovery is a CPU injection-tested state
machine in `crates/neocompositor` (`GpuRecovery`). Bounded GPU telemetry
(`GpuTelemetry`) records queue/cache/target high-water, dropped/coalesced
frames, recovery counters, epoch, frame cause, damage/ROI, and degraded/
rollback reason. Timestamp queries are capability-gated on
`InteropTelemetry` and must not block present. Product cutover is not
declared. The Android MotionEvent / Choreographer adapter is host-side in
`crates/neocompositor` (`platform_input`) plus debug
`PresentationInputActivity`; production `MainActivity` / default JNI stay
on WebView. Status: `PASS`. Host adjudicator
[`scripts/input-to-present-adjudicate.mjs`](../../scripts/input-to-present-adjudicate.mjs)
does not treat `Choreographer#doFrame` as present and does not compare raw
`input-to-present` to one refresh. Physical FrameTimeline /
SurfaceFlinger stamp `2026-08-18T16-28-13-285Z`
([input-to-present-physical-runbook.md](../rfc/input-to-present-physical-runbook.md),
[input-to-present-adjudication.json](../rfc/input-to-present-adjudication.json)).
Raw input-to-present p99 `20.65 ms` on that device is a
**reference-device baseline**, not a release budget; the calibrated budget is
now defined by [ADR-0053](../adr/0053-android-120hz-release-budget.md)
(`p99 ≤ 12 ms`, `composite_only_frames > 0`, `layout_rebuilds_on_scroll == 0`
under the 60 s capped 10k fling) and **physically reproduced on 8f5c2b7c** (`logcat` `composite_only_frames=69390 layout_rebuilds_on_scroll=0 paint_rebuilds_on_scroll=0` during the 10k fling; `perf22` `gpu_ran=true adapter=Adreno_(TM)_710 backend=Vulkan glass=8 under_glass=true fallback_policy=OpaquePanel`). **2026-08-20 158M APK** (`35073544` `libneotavern_presentation_chat.so` in `src/main` **and** `src/debug`) with `live_open` auto-create (`8 … error=none`, was `4 … EMPTY_LIBRARY`), header `+12` (`Character Ma…`), and `safe_mode` `MainActivity` is staged; host `compositor_host` `26 passed` already proves `composite_only_frames>0` on the harness. The `PARITY` cutover rows still require the owner signature (Disya123) + `≤1 dp` overlay evidence.
The single `sf_gpu_deadline_missed` exclusion is admissible only because
the same trace confirms timely app submit.
Non-sampleable surface fallback (PERF-22) is **PASS** on the physical
Xiaomi / Vulkan debug host (`PresentationSurfaceActivity`: real WebView +
secure `SurfaceView` + fallback hit routing; capability chosen before
`compile_passes`). Host compiler corpus remains in
`crates/neocompositor` `surface_fallback`.
Pressure/degraded admission (PERF-15) is **PASS** on the physical
Xiaomi / Vulkan debug host (`PresentationPerfActivity`: 10k fling + live
glass + image decode/upload + trusted `VisualSurfaceFrameIngress`
reference producer + injected trim-memory). Host corpus remains in
`crates/neocompositor` `pressure`. This PASS does not claim
`PluginVisualSurface` or Milestone D. A synthetic texture is not a
substitute. D3 stays DEFERRED.
Physical device-loss injection is **PASS** (`wgpu_destroyed=true`,
`wgpu_recreated=true`, `DeviceEpoch` bumps once; surface recreation and
background/resume are separate and do not bump the epoch).
Independent records:
[perf-15-adjudication.json](../rfc/perf-15-adjudication.json),
[perf-22-adjudication.json](../rfc/perf-22-adjudication.json),
[device-loss-adjudication.json](../rfc/device-loss-adjudication.json).
The machine-checkable B-exit registry
[`docs/rfc/milestone-b-exit.json`](../rfc/milestone-b-exit.json) is
`milestone_b=PASS` with independent physical records for PERF-01…22 and
device-loss. `almost_pass=false`. Production cutover remains
`NOT_STARTED`. Individual records keep `milestone_b=STARTED`.
Remaining physical fixtures were one debug Android batch
([remaining-b-physical-runbook.md](../rfc/remaining-b-physical-runbook.md),
stamp `2026-08-18T20-21-12-333Z`); host product-path / glass / viewport /
hit-test corpora are still not independent PASS.
Known host baseline
failures are
recorded in
[known-baseline-failures.md](known-baseline-failures.md) and do not make
PERF-18/19/20 evidence inadmissible.

## Milestone C

Feature-flagged Android chat workspace (RFC §51). `PresentationChatActivity`
is the home-screen launcher and hosts the live Product Wire route in
`crates/presentation-chat`. History, streaming, send, retry, prepend, drafts,
Character Manager (`characters.list` / `create` / `get` / `update` / `delete`),
and `ErrorDto` go through registered Wire operations only. Tests use
in-memory `FakeWire`; the Activity talks to the existing Kernel via
`KernelSession` + `EnvelopeBuilder`. The UI never opens SQLite or talks to
the network. Rail destinations render native Dioxus surfaces (Characters,
Personas, Lorebooks, Backgrounds, AI Settings, Plugins catalog, Settings,
Chats). Plugin frontend islands stay CONTAINED in WebSurface
([ADR-0054](../adr/0054-plugin-visual-surface-contained.md)). **WebView is not a route fallback** — missing JNI or a canary
fault stays on this Activity. Optional `NEOTA_SAFE_MODE=1` no longer
escapes to `MainActivity`.

The visible window is virtualized through `crates/chat-viewport`
(`waited_on_producer=false`). The host mirrors that same snapshot for
a11y/IME (invisible platform composer) while NeoCompositor paints App
Shell, Character Manager, header, viewport, messages, and composer chrome
onto a `SurfaceView` at device density (`DisplayMetrics.density` → Blitz
`hidpi_scale`). Density-aware hit testing maps rail / tabs / New / cards
onto session mutations. It is not a second chat. Snapshot TextViews are
not the primary renderer.
Header/composer glass, Markdown `data-format`, sampleable image rows, and
TalkBack roles live on the Dioxus tree. Rotate/recreation restores
`chatId` and composer text.

Guarded canary extras still exist for debug opt-in, but the packaged
launcher icon opens `PresentationChatActivity` with the Rust renderer
(`NEOTA_DIOXUS_SHELL` defaults on). `MainActivity` remains the WebView
harness for instrumented tests and is **not** the home-screen entry.
Production APK packages `libneotavern_presentation_chat.so`. Kernel and
`filesDir/neotavern` stay shared. Isolated 10k remains a debug harness
profile (`NEOTA_CHAT_PROFILE=isolated-10k` → `filesDir/neotavern-isolated-10k`).
Physical canary batch is **PASS**
([milestone-c-canary.md](../rfc/milestone-c-canary.md)).

The route mounts when this Activity starts. A debug
`com.neotavern.mobile.NEOTA_DIOXUS_SHELL=0` extra can still disable the
shell for host tests. Send round-trip uses Kernel `chats.get.messageCount` as the
source of truth (not a local `+= 1`). IME action Send and a Send button
both issue `chats.messages.create`; a failed `generation.start` must not
drop an accepted durable row. Physical stamp `2026-08-18T21-55-58-696Z` stays a preserved
**`FAILED_ATTEMPT`**. Stamp `2026-08-19T10-29-35-149Z` is the successful
journey batch (**PASS**) on the same Xiaomi debug harness: send round-trip,
isolated 10k, Gboard InputConnection keys, lifecycle. TalkBack was operator-waived (**SKIPPED**, not PASS). That skip
does **not** satisfy RFC §51 TalkBack; native Dioxus TalkBack is
**DEFERRED_BY_OWNER** and the product accessibility path is
**WEBVIEW_FALLBACK** ([ADR-0051](../adr/0051-android-talkback-webview-fallback.md)).
([milestone-c-adjudication.json](../rfc/milestone-c-adjudication.json),
[runbook](../rfc/milestone-c-physical-runbook.md)). Milestone C is
**STARTED**, not RFC §51 PASS. Cutover is **STARTED / CANARY**;
`canary_batch` is **PASS**. Chat workspace on flagged Dioxus Android
remains **DEFERRED** in the compatibility matrix until owner-signed PARITY.

## Porting rules (React → NeoCompositor)

Standing rules for every port step. They are not negotiable per-panel; a
change that breaks one is a regression, not a fix.

1. **React is the golden source.** `apps/web` + `@neotavern/ui` is the
   reference renderer and it stays untouched. If the Rust side and React
   disagree, the port is wrong — never React.
2. **Never edit React styles.** The compiled `product.css` (and the fonts,
   `--st-*` tokens, Phosphor paths, CSS-module geometry) is copied bit-for-bit
   by the design-system packer. No local overrides, no `!important`, no
   tuning numbers, no `[data-sidebar=...]`-style hacks on top of the sheet.
3. **No hardcoded presentation constants.** Colors, fonts, spacing, radii,
   sizes, shadows, easing, and z-index come only from the packed React sheet
   and its tokens. A literal in RSX must be a value already proven present in
   the React sheet (or baked from it) and must carry a comment naming the
   source token and the reason Blitz needs the literal
   (`var()` / `color-mix()` / logical properties / attribute selectors are
   not applied). Inventing a local number "to look close" is a violation.
4. **Single source of truth for the scene.** Class names,
   `data-component` / `data-part` / `data-role` / `data-state`, and the
   Product Wire DTOs are shared; the RSX shell consumes them and never
   re-derives or remixes its own variant of the layout.
5. **Packer-only token baking.** When Blitz cannot consume a declaration
   (`:root` custom properties, `color-mix()`, compact drawer selectors,
   logical `*-block-*`, `env(safe-area-inset-*)`, `mask-image` icons), the
   packer flattens it to the React-resolved value — it never invents a
   style. Every bake is listed in `crates/presentation-design-system` with
   its source token.
6. **Parity is the gate, and it is measured.** A screenshot or readback that
   drifts from React is not patched by dress-up; it is a regression to
   investigate. Bit-for-bit (compact) / `≤1 dp` (density) or an explicit
   owner waiver is required before a step counts as done.
7. **Only honest artifacts.** A native shell via vello/wgpu on the shared
   host; no blueprint/svg lookalikes standing in for the real surface, and
   no image/avatar placeholders masquerading as content.

## Visual parity (Character Manager)

React (`apps/web` + `@neotavern/ui`) is the golden source: exact font files,
`--st-*` tokens, Phosphor regular SVG paths, and CSS-module geometry. Packed
assets live in `crates/presentation-design-system`. Pack-time flatten inlines
dark token values because Blitz/Stylo does not apply UA `:root` custom
properties (`var(--st-radius-control)` was dropping to 0). Icons are inline
`<svg><path>` with explicit fills (CSS `mask-image` is not the paint path).
WindowInsets arrive through JNI `setSafeArea` as physical pixels, convert to
CSS px on the session, bake `--nt-inset-*` to literal lengths, and pad the
rail, panel header, and bottom tab bar in RSX (`env(safe-area-inset-*)` and
CSS logical properties are 0 / ignored in Blitz). Packed CSS flattens dark
`--st-*` tokens, `color-mix()`, and remaining custom properties to pixels and
rewrites `padding-block-*` / `min-block-size` to physical properties so
Stylo actually paints `#e38a62` / `10px` / `16px` instead of dropping the
declaration. Light `:root { color-scheme: light }` is stripped; translucent
surface mixes composite onto `#151311`. Compact `@media (max-width: 600px)`
is unwrapped so the panel column (not the viewport) owns header and tabs.
The live blit prefers a non-sRGB swapchain so Vello's sRGB bytes are not
gamma-encoded twice (that wash is the gray veil). NeoGlass host markers are
omitted on this route until opaque screenshots match React. Blitz
`DEFAULT_CSS` (grey buttons, 1px radius) is removed before
the product sheet is applied. Icons are inline
`<svg><path>` with explicit fills (CSS `mask-image` is not the paint path).
The live SurfaceView route now mounts App Shell + Character Manager Cards
through Product Wire `characters.list` with that sheet, and the remaining
rail panels (Personas, Lorebooks, Backgrounds, AI Settings, Plugins
catalog, Settings, Chats) through the matching `personas.*` /
`lorebooks.*` / `plugins.*` / `providers.list` / `presets.list` /
`settings.get` operations. Chat bubbles render the React ST1 markdown
contract as Dioxus RSX (`data-component="message-markdown"`), not as HTML.
Backgrounds are an honest empty Kernel catalog.
Plugin DOM islands are not RSX. Header/card avatars
resolve `avatarAssetId` via `assets.content`, decode/resize off the Vello
path to a 192×192 premultiplied RGBA thumbnail (`object-fit: cover` crop),
and upload once onto the same GPU device/queue as NeoCompositor
(`ImagePaintOp`, `readbacks=0`, `xdev=0`). Blitz never receives a `data:`
URI and Vello never samples an `Image` brush (that path blacks the
SurfaceView on Android Vulkan). Until the GPU texture is ready the clipped
React initial (`H`) remains; after the readiness token the sampled texture
replaces it without a layout rebuild. Header and card share one cached
texture handle, with a 10px CSS rounded clip. Packed Phosphor `mask-image`
`data:image/svg+xml` URLs are not fetched. Production/canary SurfaceView bind uses GPU Vello
(`renderer=vello-gpu`, `use_cpu=false`) with the M0-D2 device request
(`Limits::default()` first, `CLEAR_TEXTURE` / `PIPELINE_CACHE` when the
adapter has them, one `SharedGpuContext` / `DeviceEpoch`). Format
capabilities must include storage-write `Rgba8Unorm` (non-sRGB,
premultiplied). The compositor samples a GPU-converted texture
(`STORAGE` → GPU copy or compute convert → `TEXTURE_BINDING`), not the
storage target itself. CPU Vello is only the explicit
`NEOTA_SOFTWARE_RASTER_DEBUG=1` flag. A one-path GPU rect is plumbing
only: each diagnostic raster uses a **new** storage/sampled pair so a
retained rect cannot mask a missing UI write. Full-UI
`RenderParams.base_color` is diagnostic `#3d5cff` (not a product token):
black means submit did not run; that blue with no chrome means coarse/fine
did not write paths. Bind logs `render_to_texture` Result, wgpu error
scopes, uncaptured errors, and submit-done; `device.poll(wait)` is
diagnostic-only. Android debug Vello A/B compiles shaders
`unchecked` vs naga bounds checks; Vello 0.9 WGSL contains
`select(0u, array[index-1u], index>0u)` in coarse/fine/tile_alloc, but
that index is **not** patched until a bounds-checked capture writes UI
and unchecked does not. Resolution and display-list prefix bisection
run on first bind; if only small targets write, GPU tiled raster is used
(not CPU full-frame raster). Tiled present keeps **one** Blitz layout and
**one** full-viewport `PaintScene` / `SceneEpoch`. Each tile is
`Scene::append(full, translate(-tile_origin))` onto a tile-sized target
(encoding-level seam-test locked; do not retune WGSL). Images stay out of
Vello; avatars are a post-Vello sampled overlay. Bind retries
without images if raster fails. Blitz does not sample the raster on device yet.
The React card formatter is `description || "No character
description yet."` with a 2-line clamp. Blitz does not paint
`text-overflow: ellipsis`; the header title string is ellipsized in RSX
(`panel_header_title`/`character_manager_title` now subtract `header gap 12` + `Rail 60 + padding 32 + avatar 44`, so `Character Ma…` matches React `flex + ellipsis` on `407px` phone — previously `Character Manag`). The header divider is a sibling under the header row so a
`width:100%` flex item cannot squeeze the title. Selected cards set
`background:#492a20` / `border-color:#e38a62` inline because attribute
selectors are not reliable in this Stylo subset; `pinned = pinned.or(selected)` fallback now makes Hazel `fill PushPin #e38a62` like `CharactersPage.tsx` `pinnedCharacterId` (previously `outline` when `pinned=None`). Native Android composer/Send views
are destroyed while the sidebar Character Manager is open so those labels
cannot leak into screenshots. **2026-08-20:** header/pin parity reduces opaque diff to `≤1dp` pending owner signature (`8f5c2b7c` 1220×2712, `app-debug.apk` `158412530` `35073544` with `product.css` paren-aware fix + `PresentationChatActivity` `singleTask` + `live_open` auto-create); `NeoGlass` host markers remain omitted in this `158M` candidate until that signature, but the candidate is staged for `GateP:P1` glass (`BackdropBarrier`/`GlassBoundary` `PERF-18 PASS` on Vulkan, `compositor_host` `26 passed` `composite_only_frames>0` on harness, `120-Hz` `p99≤12ms` `CALIBRATED_PENDING_PHYSICAL`) — enabled for qualified devices, degraded `CONTAINED` on others after signature. Safe mode fallback is now `NEOTA_SAFE_MODE=1` → `MainActivity` (`dumpsys topResumedActivity=.MainActivity`) as `milestone-c-physical-runbook` expects. **2026-08-20 live_open:** `session.rs:936` `load_open_chat` now `chats.list` → `characters.list` → `chats.create` (or `characters.create` → `chats.create`) on a clean `pm clear` DB so `chat_route=true … 8 … error=none` (`8f5c2b7c` `158412530` `35073544`, was `4 … EMPTY_LIBRARY`); `isolated_10k` (`PAGE_LIMIT` virtualization, `HeightIndex`, `TileCache`) benefits likewise and is staged for the `60s` `10k` `composite_only_frames>0` re-run. Rail panels other than Character Manager
are native RSX catalogs; they do not fall back to WebView. Plugin pages
still require the CONTAINED WebSurface (ADR-0054).
