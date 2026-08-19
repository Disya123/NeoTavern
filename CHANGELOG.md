# Changelog

## Unreleased
### Fixed

- **Generation diagnostics waiting count is deterministic.**
  `diagnostics.export` counts `waiting` as the derived lifecycle
  `streaming` + `pending_tool_call_json`, not a racy marker-only scan.
  The kernel test waits on `generation.get` after startup recovery
  instead of sampling against an expired lease.

- **Prettier baseline restored.** Generated/vendor/capture paths are
  ignored with a documented reason; maintained source and `docs/` are
  formatted. `pnpm format:check` is green. Not production cutover.

### Added

- **Native Dioxus TalkBack deferred; product a11y is WebView (ADR-0051).**
  `talkback_journey=SKIPPED` is not RFC §51. TalkBack / touch exploration
  must select WebView before a Rust presentation host. Gboard typing/insets
  /editor-send stays a physical PASS; IME composition is a MockIme
  conformance test. Production `MainActivity` / canary unchanged.

- **Milestone C physical journey batch PASS (not RFC C PASS, not cutover).**
  Xiaomi `8f5c2b7c` stamp `2026-08-19T10-29-35-149Z` on debug
  `PresentationChatActivity`: send round-trip via Gboard keys, isolated
  10k, lifecycle, and `NEOTA_SAFE_MODE=1` WebView escape. TalkBack was
  not enabled (`talkback_journey=SKIPPED`, operator waived). Stamp
  `2026-08-18T21-55-58-696Z` stays in `failed_attempts`. Record:
  [`docs/rfc/milestone-c-adjudication.json`](docs/rfc/milestone-c-adjudication.json).
  Production `MainActivity` / canary unchanged.

- **Isolated 10k Product Wire chat workspace (not cutover).** Debug
  profile `NEOTA_CHAT_PROFILE=isolated-10k` seeds 10_000 messages through
  existing `characters.create` / `chats.create` / `chats.messages.create`
  into `filesDir/neotavern-isolated-10k`. The session still pages `limit=50`
  and virtualizes the visible window. Host Kernel integration is a
  `presentation-chat` `[dev-dependencies]` test. No production operation
  or `MainActivity` canary.

- **Live Product Wire send round-trip (not cutover).** Composer IME
  action and the Send button issue `chats.messages.create`. The header
  `messageCount` is Kernel `chats.get`, not a local increment. In-flight
  callbacks coalesce. A rejected create keeps the composer and shows
  `ErrorDto`. A failed `generation.start` does not drop an accepted
  durable row. Debug traces log ids/counts/epoch only. Stamp
  `2026-08-18T21-55-58-696Z` stays a `FAILED_ATTEMPT` in
  [`docs/rfc/milestone-c-adjudication.json`](docs/rfc/milestone-c-adjudication.json).
  Production `MainActivity` / canary unchanged.

- **Milestone C physical journey batch FAILED_ATTEMPT (not RFC C PASS, not cutover).**
  Xiaomi `8f5c2b7c` stamp `2026-08-18T21-55-58-696Z` opened the live
  Product Wire chat (Kernel chat `Hazel`) on debug
  `PresentationChatActivity`, with flag-off, Gboard as default IME,
  TalkBack semantics, rotate, background/resume, and `NEOTA_SAFE_MODE=1`
  WebView escape. Send did not grow Kernel `messageCount`. 10k was not
  run on device. Gboard composing and TalkBack focus/actions remain
  unproven. Record:
  [`docs/rfc/milestone-c-adjudication.json`](docs/rfc/milestone-c-adjudication.json).
  Production `MainActivity` / canary unchanged.

- **Live Product Wire Dioxus chat route (Milestone C, not cutover).**
  `crates/presentation-chat` binds history, streaming, send, retry,
  prepend, drafts, and errors to registered Product Wire operations.
  The visible window is virtualized through `chat-viewport`
  (`waited_on_producer=false`). Debug `PresentationChatActivity` is a
  harness around that same route (snapshot of the live view, Kernel via
  `KernelSession` + `EnvelopeBuilder`, Gboard composer, IME inset,
  TalkBack roles, rotate/composer restore, `NEOTA_SAFE_MODE=1` WebView
  escape). Not the compositor `SurfaceView` paint path.
  Production `MainActivity` / default JNI / WebView stay the launcher.
  Compatibility matrix chat-workspace / Gboard / 10k / a11y / safe-mode
  rows remain **DEFERRED** (not PARITY).

- **Milestone B PASS (not production cutover).** Independent Xiaomi /
  Vulkan records for PERF-01…05 / 11–14 / 16 / 17 / 21 on stamp
  `2026-08-18T20-21-12-333Z`. Registry
  [`docs/rfc/milestone-b-exit.json`](docs/rfc/milestone-b-exit.json) is
  `milestone_b=PASS`, `almost_pass=false`,
  `production_cutover=NOT_STARTED`. Individual records keep
  `milestone_b=STARTED`. Host corpora remain `HOST_CORPUS`, not PASS.
  Production `MainActivity` / default JNI unchanged.

- **Product-path host corpus for PERF-01 / PERF-02 / PERF-16 (not PASS).**
  `crates/presentation-session` `tests/product_path_perf.rs` drives
  Product Wire → flagged Dioxus shell → Blitz → presentation-session →
  compositor. 10k mixed Markdown/image rows, 60 s bidirectional 120 Hz
  ticks (warm and cold-near-range), streaming coalesce, 100 cold
  contentful vs interaction samples with host p99 omitted. Unified
  runner `scripts/presentation-perf-bench-runner.mjs` records
  `HOST_CORPUS`, never `PASS`. Tile cache `pin_span` now unpins tiles
  that left the protected band. Milestone B remains STARTED.

- **Remaining Milestone B physical fixtures (one debug batch, not PASS).**
  `presentation-perf-probe` adds product-path scenarios PERF-01…05 /
  11–14 / 16 / 17 / 21. Capture:
  `node scripts/b-exit-physical-capture.mjs --batch=remaining`.
  Independent adjudicator:
  `scripts/remaining-b-physical-adjudicate.mjs`. Production
  `MainActivity` / default JNI unchanged. Milestone B remains STARTED.

- **PERF-15 PASS (not B PASS, not PluginVisualSurface).** Independent
  Xiaomi / Vulkan stamp on a BOUND debug APK:
  [perf-15-adjudication.json](docs/rfc/perf-15-adjudication.json)
  (`visual_surface=present`, `producer=reference-visual-surface`,
  `plugin_runtime=false`). Milestone B remains STARTED. D3 stays deferred.

- **Bounded VisualSurfaceFrameIngress (not Plugin SDK).** Presentation
  session owns a generation-safe latest-ready-frame-wins queue. Product
  Wire carries only the logical surface declare and policy. GPU handles
  stay off the wire. Late/not-ready frames do not block present.
  Recovery bumps generation. D3 / PluginVisualSurface stay deferred.

- **Reference VisualSurface producer.** A trusted deforming textured
  mesh/rig with atlas and alpha layers submits only through
  `VisualSurfaceFrameIngress`. Not D1b checkerboard, not a synthetic fill,
  not Plugin SDK.

- **PERF-22 and physical device-loss PASS (not B PASS).** Independent
  Xiaomi / Vulkan stamps on a BOUND debug APK: PERF-22
  [perf-22-adjudication.json](docs/rfc/perf-22-adjudication.json)
  (`PASS`; real WebView + secure `SurfaceView` + fallback tap),
  device-loss
  [device-loss-adjudication.json](docs/rfc/device-loss-adjudication.json)
  (`PASS`; wgpu `Device::destroy` + recreate, `DeviceEpoch` +1).
  PERF-15 stays **IMPLEMENTED** without a VisualSurface /
  Product Wire surface
  ([perf-15-adjudication.json](docs/rfc/perf-15-adjudication.json)).
  Milestone B remains STARTED. Production `MainActivity` / kernel JNI
  unchanged. Unified host bench runner for remaining PERF-01…05 and
  PERF-11…17/21 (`scripts/presentation-perf-bench-runner.mjs --execute`)
  does not need the phone; host corpora are not independent PASS.

- **B-exit physical fixtures (no PASS).** Debug
  `PresentationSurfaceActivity` hosts a real WebView, a secure
  `SurfaceView`, glass, and fallback hit-routing for PERF-22.
  `presentation-perf-probe` adds `perf15` / `perf22` / `recovery`
  scenarios: 10k fling + live glass + decoded image upload + trim-memory
  (PERF-15 stays **IMPLEMENTED** without VisualSurface), capability
  compile before `compile_passes`, and a real wgpu `Device::destroy` +
  recreate for device-loss (CPU `LossDetected` is not physical).
  Independent records:
  [perf-15-adjudication.json](docs/rfc/perf-15-adjudication.json),
  [perf-22-adjudication.json](docs/rfc/perf-22-adjudication.json),
  [device-loss-adjudication.json](docs/rfc/device-loss-adjudication.json).
  Milestone B remains STARTED. Production `MainActivity` / kernel JNI
  unchanged.

- **D1/D2 GO (not production cutover).** Owner `Disya123` signed
  [d1-d2-decision.md](docs/rfc/d1-d2-decision.md) / [ADR-0049](docs/adr/0049-track-d-dioxus-presentation.md):
  `D1=Track D GO`, `D2=Dioxus+pinned Blitz GO`, `D3=DEFERRED` (Android Rust
  presentation path, Web stays React). Waiver: Track D is technically proven,
  not proven cheapest vs A/B/C. Scope: feature-flagged staged implementation.
  Rollback: acting React/WebView. Kill trigger: production DoD miss,
  foundational fork, unsupported device matrix, or budget overrun. M0 is not
  re-run.

- **Product Wire presentation boundary (Milestone A STARTED, not A PASS).**
  Presentation commands must be Product Wire `operationId`s
  (`packages/contracts/src/presentation/boundary.ts`). Fixture recorder
  and boundary tests land with this change. Baseline
  [PresentationCompatibilityMatrix](docs/rfc/presentation-compatibility-matrix.md).
  A PASS still requires a feature-flagged Dioxus product shell, React ↔
  Dioxus view-model parity, and presentation-path generation/backpressure
  tests.

- **Milestone B STARTED (not B PASS, not cutover).** Production compositor
  types start in `crates/neocompositor` (`NeoDisplayList`, `compile_passes`,
  `FrameTransaction`, bounded layer cache / target pool). Default host
  remains WebView rollback. `NEOTA_NEOCOMPOSITOR=1` is a non-default flag.
  M0 probes re-export the interchange types and stay probes. Production
  `MainActivity` is unchanged.

- **Feature-flagged Dioxus Product Wire shell.** Crate
  `crates/presentation-dioxus-shell` consumes the same canonical Wire fixture
  as React tests, builds a Dioxus `VirtualDom`, rejects unregistered
  commands, drops stale generation, and bounds streaming. Not linked to
  `MainActivity`. `NEOTA_DIOXUS_SHELL=1` is non-default. Milestone A stamp
  is still STARTED until the evidence record.

- **Milestone A PASS (not production cutover).** Evidence: shared Product
  Wire fixture, Dioxus `VirtualDom` shell, React ↔ Dioxus projection
  parity, stale-generation drop, bounded streaming. `MainActivity` remains
  WebView. Milestone B remains STARTED.

- **Chat viewport height index, predictor, and bounded tile cache.** Crate
  `crates/chat-viewport` (not `neocompositor`) maps offset ↔ stable logical
  item in `O(log n)`, predicts visible/prepared/fallback-ready ranges under
  item/byte/time overscan budgets, cancels stale preparation (latest range
  wins), and pins the viewport/protected band in a hard-capped tile cache.
  Overscan miss presents estimated/known geometry without waiting on
  Dioxus/layout/raster and without a transparent gap. The compositor
  handoff is ready tile descriptors plus a geometry snapshot only. Exact
  `+350 px` height commits are `PendingDebt` until the follow-up geometry
  epoch / fling-continuous remap. `MainActivity` / WebView rollback
  unchanged. PERF-18 stays **IMPLEMENTED / GPU_PENDING**.

- **Chat viewport geometry epochs and fling-continuous remap (PERF-20
  IMPLEMENTED, not PASS).** `crates/chat-viewport` keeps active and shadow
  `GeometrySnapshot`s, stages exact-height updates in a bounded
  `PrefixDeltaMap`, and commits tiles / geometry / hit-test / semantics
  as one generation. C0 keeps the `ScrollAnchor` on screen; C1 preserves
  screen velocity except at new hard bounds. Protected-band corrections
  may stay as bounded `GeometryDebt`. Fallback → full replacement does
  not mix epochs. Stale shadow commits are rejected; scroll ack and
  geometry correction share a `DeltaToken` so a delta is not applied
  twice. PERF-20 PASS still needs an Android high-velocity trace (host
  compositor integration now lives in `presentation-session`).
  Interaction-ready text is not in this change.
  `MainActivity` / WebView rollback unchanged. PERF-18 stays
  **IMPLEMENTED / GPU_PENDING**.

- **Interaction-ready text snapshots (not PERF-19).** `crates/neocompositor`
  publishes an immutable `TextInteractionSnapshot` bound to `SceneEpoch`
  with generation-safe `TextFragmentId`, producer bidi/cluster/line/glyph
  geometry, and multi-tile coverage. The compositor does not shape, layout,
  or fall back fonts. Text, geometry, and property snapshots switch
  atomically. A stale or recycled fragment cancels instead of selecting
  another message. Cross-tile selection underlay is not in this change.
  `MainActivity` / WebView rollback unchanged. PERF-18 stays
  **IMPLEMENTED / GPU_PENDING**. Milestone B remains STARTED.

- **Cross-tile selection underlay (PERF-19 IMPLEMENTED, not PASS).**
  `crates/neocompositor` paints `SelectionPaintOp` between the
  box/background chunk and transparent glyph/emoji chunks. Highlight is
  not baked into background or glyph tiles. Drag updates only selection
  ops and bounded damage (`SELECTION_ONLY`): no shaping, layout, or
  glyph/background raster invalidation. Rects clip per tile from one
  logical geometry with shared snapping/apron rules. Color emoji and
  syntax colors do not go through a selection blend-mode. Old and new
  selection damage is unioned. Selection under subsequent glass
  invalidates the dependent glass ROI. Handles and caret use the same
  property snapshot and async scroll state; autoscroll sends a delta to
  an existing `ScrollId`. A fallback tile without an interaction snapshot
  is not a text target. PERF-19 PASS still needs an Android
  selection/autoscroll capture. `MainActivity` / WebView
  rollback unchanged. PERF-18 stays **IMPLEMENTED / GPU_PENDING**.
  Milestone B remains STARTED.

- **Blitz producer text interaction snapshots (not PERF-19 PASS).**
  `VirtualDom` → Blitz layout/paint publishes `TextInteractionSnapshot`
  through a bounded `PaintScene::host_text_fragment` hook that copies
  already-shaped Parley clusters, bidi maps, caret stops, and glyph
  geometry. Glyph/emoji output is a separate raster family from
  box/background. `TextInteractionSnapshot`, `GeometrySnapshot`,
  `PropertySnapshot`, and the display list commit in one
  `FrameTransaction`; a mixed/partial epoch is `InvalidGraph`. Fallback
  without a snapshot is `NotInteractionReady`, not an approximate hit.
  IME composition uses separate underline/background ops and does not
  redraw glyph tiles. Drag counters stay
  `shape_calls_after_commit=0`, `layout_rebuilds_during_drag=0`,
  `glyph_rasters_during_drag=0`. PERF-19 remains **IMPLEMENTED**, not
  PASS. `MainActivity` / WebView rollback unchanged. Milestone B remains
  STARTED.

- **Viewport remap and selection transactions (not PERF-19/20 PASS).**
  `crates/presentation-session` connects `chat-viewport` to the compositor:
  geometry remap, hit-test, semantics, text, and tiles switch in one
  `FrameTransaction`. `DeltaToken` is applied once. The selection anchor is
  a logical text position, so remap during drag/fling does not move the
  highlight relative to the text. Deleting the selected message yields
  `Cancel`. Autoscroll uses the existing `ScrollId` latch. Selection
  damage stays underlay-only. PERF-19 and PERF-20 remain **IMPLEMENTED**,
  not PASS. `MainActivity` / WebView rollback unchanged. Milestone B
  remains STARTED.

- **Android PERF-18/19/20 debug probe (not PASS).** Debug-only
  `PresentationPerfActivity` + `crates/presentation-perf-probe` run the
  three scenarios on a physical device. The host adjudicator stamps each
  of PERF-18/19/20 independently as PASS or BLOCKED. Milestone B remains
  STARTED even if all three pass. `MainActivity` / WebView rollback
  unchanged.

- **Android PERF-18/19/20 host adjudication (independent PASS, Milestone B STARTED).**
  Physical Xiaomi / Vulkan evidence in
  [perf-18-20-adjudication.json](docs/rfc/perf-18-20-adjudication.json):
  `PERF-18=PASS`, `PERF-19=PASS`, `PERF-20=PASS`, `almost_pass=false`.
  Milestone B remains STARTED (bounded queue/thermal/120 Hz, remaining
  PERF-01..22; device/surface recovery and bounded GPU telemetry are now
  CPU host slices, not production JNI). Not a production
  cutover. `MainActivity` / WebView rollback unchanged.

- **Device/surface recovery state machine (CPU, not B PASS).**
  `crates/neocompositor` `GpuRecovery` implements RFC §36 phases, timeout skip,
  surface recreate, device-epoch bump with device-bound cache/target/pipeline
  destroy, last-known-good logical rehydrate, bounded mailbox during rebuild,
  stale epoch reject, attempt cap then `Degraded` + acting WebView rollback,
  and OOM-without-recreate-loop. Injection tests live in
  `crates/neocompositor/tests/recovery.rs`. Not production JNI. Not a cutover.
  GPU telemetry is not in this change. Milestone B remains STARTED.

- **Bounded GPU telemetry and recovery counters (CPU, not B PASS).**
  `GpuTelemetry` is a copy-sized snapshot: queue/cache/target bytes and
  high-water, dropped/coalesced frames, recovery reason/duration/attempt,
  epoch, frame cause, damage/ROI, GPU timing availability (`Unavailable`
  on this snapshot; timestamp queries are not image readbacks), and
  degraded/rollback reason. Not an
  event log. Not production JNI. Not a cutover. Milestone B remains STARTED.

- **Shared-device raster compositor interop (CPU protocol + debug probe, not B PASS).**
  One `SharedGpuContext` for raster and compositor (`DeviceEpoch`, typed
  handles, sampleable raster texture). `image_readbacks = 0`,
  `cross_device_copies = 0`. Timestamp resolves are bounded/async/
  capability-gated (`GpuTiming::Unavailable` without the cap) and do not
  block present. Device loss uses `GpuRecovery`. Unsupported compute
  degrades to WebView rollback without a second device. Debug
  `PERF_SCENARIO=interop` is not a production cutover. Milestone B remains
  STARTED.

- **Android shared-device interop host adjudication (PASS, Milestone B STARTED).**
  Physical Xiaomi / Vulkan RenderDoc v1.45 evidence in
  [shared-device-interop-adjudication.json](docs/rfc/shared-device-interop-adjudication.json):
  `shared_device_interop=PASS`, `almost_pass=false`. Capture
  `2026-08-18T13-21-28-777Z`, control `2026-08-18T13-20-53-169Z`, APK
  `BOUND`. One `VkDevice`; Vello raster texture is sampled by the
  compositor/glass; bounded ROI; no `vkMapMemory` / image-to-buffer /
  cross-device copy; `devices=1`, `image_readbacks=0`, `xdev=0`. Not a
  production cutover. `MainActivity` / WebView rollback unchanged.
  Milestone B remains STARTED.

- **Android MotionEvent / Choreographer adapter (host-side, not cutover).**
  `PlatformInputAdapter` in `crates/neocompositor` plus debug
  `PresentationInputActivity`: raw screen coordinates, `eventTimeNanos`,
  stable pointer ids, bounded MOVE-coalescing queue, Choreographer →
  `PresentationTime`. Host tests live in `crates/neocompositor/tests/platform_input.rs`
  and JVM `PresentationInputMappingTest`. Instrumented coverage is
  `PresentationInputInstrumentedTest` (debug `PresentationInputActivity`, not
  `MainActivity`).   Status: **PASS**. Host
  adjudicator
  [input-to-present-adjudication.json](docs/rfc/input-to-present-adjudication.json)
  uses RFC §14 renderer-controlled present deadlines
  (`deadline_miss = rendererControlled && actualPresentTime > targetPresentDeadline`).
  Raw `input-to-present` p50/p95/p99 are reported and are not gated against
  one refresh. `Choreographer#doFrame` is not present.
  Physical stamp `2026-08-18T16-28-13-285Z` (Xiaomi / Vulkan / locked 120 Hz).
  The debug host presents a retained texture to a window swapchain on a
  compositor thread; `actualPresentTime` comes from
  FrameTimeline/SurfaceFlinger. Raw input-to-present p99 `20.65 ms` is a
  **reference-device baseline**, not a release budget (no calibration ADR).
  The single `sf_gpu_deadline_missed` exclusion is admissible only because
  the trace confirms timely app submit. Milestone B remains STARTED.

- **Non-sampleable surface fallback (PERF-22 IMPLEMENTED, not PASS).**
  `crates/neocompositor` assigns every surface a capability
  (`SampleableTexture` / `NonSampleableWebView` /
  `NonSampleableSecureVideo` / `ProtectedOverlay` / `Unavailable`) before
  `compile_passes`. A non-sampleable node is replaced atomically by
  `OpaquePanel` / `PosterFrame` / `FullscreenSurface` / `ExplicitError`.
  Non-sampleable content is never a glass backdrop source; secure surfaces
  are not copied or read back (`image_readbacks=0`, `xdev=0`);
  opacity/mask/filter apply only to the whole fallback; the fallback owns
  paint order, clip, and hit-test bounds; the hidden original does not
  take input through the fallback. Capability and fallback share one
  `SceneEpoch`; a capability change is a new atomic transaction.
  Unsupported combinations reject with last-known-good and do not panic.
  Host corpus: `crates/neocompositor/tests/surface_fallback.rs`. PASS still
  requires an Android platform-surface + input-routing fixture.
  `MainActivity` / WebView rollback unchanged. Milestone B remains STARTED.

- **Pressure and degraded admission (PERF-15 IMPLEMENTED, not PASS).**
  `crates/neocompositor` `PressureController` walks
  `Normal → Constrained → Critical → Degraded`. Eviction order is
  deterministic. Viewport tiles, the protected band, and last-known-good
  are never evicted. Image uploads throttle under Constrained+. Allocation
  retries are bounded; OOM does not start an alloc loop. Host corpus:
  `crates/neocompositor/tests/pressure.rs`. Not production JNI. Milestone B
  remains STARTED.

- **Milestone B-exit registry (machine-checkable, not B PASS).**
  [`docs/rfc/milestone-b-exit.json`](docs/rfc/milestone-b-exit.json) plus
  [`scripts/milestone-b-exit.mjs`](scripts/milestone-b-exit.mjs) refuse
  `Milestone B = PASS` until PERF-01…05 and PERF-11…22 have independent
  admissible evidence records, device-loss injection is physical, and
  known baseline failures are fixed or explicitly waived. PERF-22 remains
  **IMPLEMENTED**. Raw input-to-present p99 `20.65 ms` is a
  reference-device baseline, not a release budget.

- **Known baseline failures (not a green full baseline).** Recorded as
  `KNOWN_BASELINE_FAILURE` in
  [known-baseline-failures.md](docs/architecture/known-baseline-failures.md):
  mass existing Prettier drift (`pnpm format:check`) and
  `runtime-kernel::diagnostics_export_counts_generation_runs`. They do not
  make PERF-18/19/20 evidence inadmissible. They are not a waiver: each must
  be fixed or given an explicit owner/waiver before Milestone B PASS.

- **PERF-18 effect-scope backdrop host golden (IMPLEMENTED / GPU_PENDING,
  not PASS).** Canonical scene: parent backdrop root →
  `BeginEffect(opacity=0.5, transform, rounded clip)` → prefix →
  `GlassSurface` → foreground text/media → `EndEffect` → following sibling.
  Host tests prove backdrop sampling at the barrier, one group opacity
  application, bounded transformed/rounded ROI, no sibling leak, nested
  glass acyclicity, foreground vs backdrop invalidation, and malformed
  scope reject with last-known-good. This is **not** PERF-18 PASS: RFC
  still requires an Android Vulkan capture. `compile_passes` did not need
  a correctness fix. `MainActivity` / WebView rollback unchanged.

- **Async hit-test and nested-scroll dispatch (Milestone B, not B PASS).**
  `HitTestSnapshot` is bound to the same `SceneEpoch` / `PropertySnapshot`
  as render. Hit-test walks paint order front-to-back, maps the screen
  point through each candidate's inverse (sticky/fixed use the sampled
  compositor transform; no global scroll inverse), checks the clip chain
  before a hit, and treats a singular transform as non-hittable. The
  target is a stable logical id plus generation. Pointer capture keeps
  that target during async scroll; a removed or recycled target gets
  `Cancel` and does not fall through to another message. Gesture latch and
  nested handoff reuse the same `ScrollId`. Events carry scene/scroll
  sequence and local coordinates. Targeting does not round-trip through
  Dioxus/layout. PERF-18, virtualization, and the gesture-platform adapter
  are not in this change. `MainActivity` / WebView rollback unchanged.

- **Compositor scroll/animation fast paths (Milestone B, not B PASS).**
  `AsyncScrollState` lives on the compositor thread, apart from the
  immutable property snapshot. Input updates delta/velocity only; producer
  `scroll_sequence` acks rebase without teleport or double-apply. Nested
  gesture latch/handoff passes unused delta. Transform/opacity animations
  sample monotonic presentation time (same result at 60/90/120 Hz;
  retarget keeps the current value). Layout/paint/text animations return
  `NeedsProducer`. Transform-only present does not rasterize, allocate, or
  call Dioxus/layout. Hit-test dispatch, virtualization, and PERF-14/17/18/21
  are not in this change. `MainActivity` / WebView rollback unchanged.

- **Spatial/scroll/clip/effect property trees (Milestone B, not B PASS).**
  `crates/neocompositor` publishes an immutable `PropertySnapshot` inside
  `FrameTransaction`: generation-safe `SpatialId`/`ScrollId`/`ClipId`/
  `EffectId`, parent/cycle checks before commit, dense present-loop
  sampling, sticky clamp, viewport-fixed and fixed-in-transform containing
  blocks, clip/effect chains, explicit backdrop roots. Hit-test and
  rendering share one snapshot/epoch. Scroll/animation fast paths are not
  in this change. `MainActivity` / WebView rollback unchanged.

- **Bounded FrameTransaction mailbox (Milestone B spine, not B PASS).**
  `crates/neocompositor` publishes immutable transactions over a latest-wins
  UI→render mailbox with item/byte caps, stale/device-epoch reject, resource
  retirement, and last-known-good on invalid graphs. Render `try_dequeue`
  never waits on producer/layout/raster. `MainActivity` / WebView rollback
  unchanged. M0 lab is not re-run; the D1a pass-order corpus is a production
  regression.

- **M0-D2 host-side Vulkan capture admission.** Program **M0-D2 PASS**.
  Adjudicator `scripts/m0-d2-adjudicate.mjs` hashed the physical RenderDoc
  `.rdc` / XML / control+capture logs / BOUND APK (`3036422`, SHA-256
  `ff425359…`), checked `apk_linkage=BOUND`, `evidence_dirty=false`,
  producer source `dioxus-virtualdom+blitz-paint-traversal+host-node-marker`,
  `glass_from_hook=2`, `moving-blit:g120 → roi:2 → glass:2:g120`,
  compile-once (`pass_compiles=1`, `layout_rebuilds=0`,
  `paint_scene_rebuilds=0`), `sampled_gen=999`, `capture_gen=120`,
  `devices=1` / `readbacks=0` / `xdev=0`, `capture_driver=Vulkan`. Probe
  logcat stays `capture=false`. Dirty-tree stamps
  `2026-08-17T19-34-27-050Z` / `2026-08-17T19-41-18-304Z` are
  **REHEARSAL / NON-ADMISSIBLE**. D1a/D1b JSON unchanged. Technical M0 is
  **PASS**. Final [TrackComparison](docs/rfc/m0-track-comparison.md) is
  published and **opens** `D1=Track D GO`; that decision is **not** granted.

- **M0-D2 dynamic sample after the producer paint seam.** The moving sample
  is inserted into the Dioxus/Blitz `NeoDisplayList` immediately before
  Glass B — not via `static_d1b_scene()`. Compile-once motion:
  `pass_compiles=1`, `layout_rebuilds=0`, `paint_scene_rebuilds=0`; per
  frame only compositor blit/damage/generation. Glass B samples current
  `gN`. Debug Activity `M0D2Activity` /
  `libneotavern_presentation_m0_d2.so`. Host schema
  `scripts/m0-d2-adjudicate.mjs`. Xiaomi Adreno 710 rehearsal control
  (`2026-08-17T19-34-27-050Z`) and generation-120 capture
  (`2026-08-17T19-41-18-304Z`) reproduced the golden counters; they are
  **REHEARSAL / NON-ADMISSIBLE** (dirty/unbound APK) and MUST NOT be reused
  for PASS. D1a/D1b JSON unchanged. `D1=Track D GO` is not granted.

- **M0-D2 glass barriers in Blitz paint order (still STARTED, not PASS).**
  Bounded crates.io patches: `PaintScene::host_node_marker` (anyrender
  0.11.0, 35 lines) and `render_element` glass emit (blitz-paint
  0.3.0-beta.1, 30 lines). Canonical z-order is the paint stream;
  `BackdropBarrier` carries the Blitz `NodeId`. Rebase: patch applies to
  anyrender 0.11.1 (`git apply --check`, lib.rs offset 3). D1a JSON
  unchanged. Moving sample is not added yet.

- **M0-D2 producer seam STARTED (not PASS).** Crate
  `crates/presentation-m0-d2` rebuilds a D1a-shaped static scene through
  Dioxus `VirtualDom` 0.8.0-alpha.1, Blitz 0.3.0-beta.1 layout/paint, and
  the public `anyrender::Scene` recording sink. Glass is a host
  `data-neoui="glass"` hook on the laid-out DOM (not a typed Blitz paint
  node). One bounded opacity/clip ancestor keeps Glass B in scope.
  Missing capabilities are listed in `docs/rfc/m0-d2-probe.md`. D1a/D1b
  admission JSON is unchanged. Normative M0 stays `ENTERED`.
  `D1=Track D GO` is not granted.

- **M0-D1b host-side Vulkan capture admission.** Program **M0-D1b PASS**.
  Adjudicator `scripts/m0-d1b-adjudicate.mjs` hashed the physical
  RenderDoc `.rdc` / XML / control+capture logs / bound APK (`21b38c0`,
  SHA-256 `089744f3…`), checked
  `moving-blit:g120 → roi:2 → glass:2:g120`, bounded Glass B ROI, no
  stale generation, no `vkMapMemory`, one `VkDevice`, 1000-frame golden
  counters, `render_polls=0` vs capture-only poll, and stable
  `acc_bytes=1046528`. Host manifest: `android_gpu_capture=true`,
  `capture_driver=Vulkan`, `d1b_verdict=PASS`
  (`docs/rfc/m0-d1b-adjudication.json`). Probe logcat stays
  `capture=false`. D1a evidence/verdict unchanged. Normative M0 stays
  `ENTERED`. `D1=Track D GO` is not granted. M0-D2 may start.

- **M0-D1a host-side Vulkan capture admission.** Program **M0-D1a PASS**.
  Adjudicator `scripts/m0-d1a-adjudicate.mjs` hashed the physical
  RenderDoc `.rdc` / XML / control+capture logs / bound APK, checked
  `ROI-1 → glass-1 → raster/blit → ROI-2 → glass-2`, bounded 140×80 ROI
  copies, no full-scene flatten, no `vkMapMemory` / image-to-buffer, one
  `VkDevice`, stable 100-frame `acc_bytes`, and golden counters vs the
  control run. Host manifest:
  `android_gpu_capture=true`, `capture_driver=Vulkan`,
  `capture_admissible=true`, `d1a_verdict=PASS`
  (`docs/rfc/m0-d1a-adjudication.json`). Probe logcat stays
  `capture=false`. GLES 1437-byte file stays `WRONG_API_CAPTURE`.
  Normative M0 stays `ENTERED`. `D1=Track D GO` is not granted. D1b may
  start.

- **M0-D1a VkDevice-bound RenderDoc in-app capture.** Feature
  `renderdoc-capture` is probe-only (`neotavern-presentation-m0`);
  `android-jni` does not enable it. Vendored `renderdoc_app.h` (v1.45,
  SHA-256 in `tools/renderdoc.pin.json`) is loaded via `RENDERDOC_GetAPI`;
  librenderdoc is not packaged. After pipelines exist, the first measured
  D1a frame is `StartFrameCapture` (wgpu-hal `VkDevice` / instance dispatch
  table) → encode → `queue.submit` → `device.poll` → `EndFrameCapture`.
  A NULL/wildcard device pointer is forbidden: the 1437-byte
  `2026-08-17T16-53-54-457Z-d1a.rdc` is `WRONG_API_CAPTURE / NON-ADMISSIBLE`
  (OpenGLES / HWUI). Control (`--mode=control`, feature off) and capture
  (`--mode=capture`) launches keep golden counters/timeline. Physical Vulkan
  capture `2026-08-17T17-18-59-431Z-d1a.rdc` contains Vulkan commands and
  both `m0-d1a-roi-read:1/2` (accumulator → glass-roi `vkCmdCopyImage`).
  `android_gpu_capture` stays **false**; D1a is not auto-PASS; D1b is not
  started. Runbook: `docs/rfc/m0-d1a-physical-runbook.md`.

- **M0-D1a debug Vulkan `uses-feature` (probe variant only).**
  `apps/android/app/src/debug/AndroidManifest.xml` declares optional
  `android.hardware.vulkan.level` / `version` (`required=false`) next to
  `M0D1aActivity` with MAIN+DEFAULT (no LAUNCHER) so AGI can resolve the
  probe URI. The probe instance ORs wgpu `InstanceFlags::DEBUG` so a
  release NDK `.so` still emits `m0-d1a-*` debug utils labels. Capture
  uses `-capture-frames 0 -for 15s` because the probe is offscreen.
  Production `main`/`release` manifests do not. Merged
  debug vs release manifests were checked with Gradle
  `processDebugMainManifest` / `processReleaseMainManifest`.
  `capture_tooling_commit` stays `5df24c8`. A new debug APK from this
  commit is rebound; that does not admit D1a PASS.

- **M0-D1a capture host (AGI 3.3.3 at `E:\agi`).** Pin
  `tools/agi.pin.json`, frame-capture preset
  `tools/agi-frame-capture.preset.json`, one-command preflight
  `node scripts/m0-d1a-capture-preflight.mjs --host-only`, completeness
  check `node scripts/m0-d1a-capture-check.mjs`. `capture_host` is
  **READY** after the tooling commit `5df24c8`. APK provenance is the
  latest BOUND bundle (`apk_source_commit` ≠ tooling commit).
  `physical_device` stays **BLOCKED_EXTERNAL** until a phone is on USB.
  This does not admit D1a PASS, does not flip `android_gpu_capture`, and
  does not start D1b. Runbook: `docs/rfc/m0-d1a-physical-runbook.md`.

- **M0-D1a API timeline + source-bundle helper (still PRE-GATE / BLOCKED).**
  The probe now records a first-frame wgpu API timeline
  (`clear,raster,blit,roi:1,glass:1,…`) and compositor-owned texture bytes.
  That log is not AGI/RenderDoc capture and does not raise the runner
  verdict. Helper: `node scripts/m0-d1a-source-bundle.mjs` (gitignored
  JSON + binary diff). Gate P is now signed `GateP:P1` in
  `docs/rfc/gate-p-decision-draft.md` (M0 `ENTERED`, not PASS). Evening M-1
  A/A0/B remains **`INVALID_FOR_COMPARISON`**. Evening AVD D1a remains
  **`BLOCKED / NON-ADMISSIBLE`**. D1b is not started.

- **M0-D1a paint-seam probe (NeoUI v4 RFC 4.5 PRE-GATE, not a compositor).**
  Crate `crates/presentation-m0` compiled a host-authored static display list
  into `PaintChunk` raster passes and `BackdropBarrier` glass passes on one
  wgpu `Device`/`Queue` (Vello 0.9). Debug-only `M0D1aActivity` ran 100 frames
  on AVD API 36.1 (`-gpu host`, GLES 3.1): 1 device, 0 readbacks, 0 xdev,
  200 ROI copies. Goldfish/GFXStream Vulkan is skipped (SIGSEGV on Vello
  submit). RFC 4.5 classifies this as **PRE-GATE / BLOCKED**; those runs
  are not admitted. Gate P is `GateP:P1`; normative M0 is `ENTERED`, not
  PASS. D1b is not started. Production `MainActivity` / kernel JNI are
  unchanged. Fill-in: `docs/rfc/m0-d1a-probe.md`.

- **M-1 Android presentation measurement (NeoUI v4 RFC, not a compositor).**
  The packaged WebView host now requests the highest same-resolution display
  mode and logs `m1-refresh` / `m1-env` / `m1-memory` / `m1-thermal`
  telemetry. Live glass on `file://` stays the production default. Track A0
  (glass off) is opt-in via `com.neotavern.mobile.MEASUREMENT_GLASS=off`.
  Track B is opt-in via `MEASUREMENT_ORIGIN=asset-loader` (same APK assets
  through `WebViewAssetLoader` HTTPS; the SPA already recognizes
  `appassets.androidplatform.net`). An opt-in 30 s rAF sampler
  (`MEASUREMENT_FRAMES=on`) logs one `m1-frames` summary and a parallel
  UI-thread `m1-choreographer` sample. On API 35+ the WebView votes
  `setRequestedFrameRate`. Capture helper:
  `node scripts/m1-android-capture.mjs --track a --phase cold`. Fill-in
  evidence: `docs/rfc/m1-baseline-report.md` (emulator-only capture
  2026-08-17; physical M-1 remains BLOCKED; Gate P later signed `GateP:P1`
  with an owner waiver that does not raise this report). The proposal at
  `docs/rfc/neoui-v4-android-presentation-backend.md` is **not** canonical.
  Track D / Dioxus / NeoCompositor are not started.

### Changed

- **M0-D1a source-bundle helper requires explicit `--bind-apk`.** Default
  `apk_linkage` is `UNBOUND`. Schema `m0-d1a-source-bundle/v3` records
  `helper_sha256` / `helper_git_blob` / `helper_matches_head` so a clean
  bundle is replayable from the committed helper. Unrelated root TZ stays
  in `excluded_unrelated_paths` and does not hide task-relevant dirty files.

- **M0-D1a source-bundle helper records signed GateP:P1.** Bundle JSON
  `program.gate_p` is `GateP:P1 / PASSED` and `normative_m0` is `ENTERED`.
  That does not admit D1a PASS.

- **M0-D1a capture debug groups after GateP:P1.** The probe names
  `m0-d1a-roi-read:{barrier}` and glass/blit passes for AGI/RenderDoc.
  Labels do not flip `android_gpu_capture` and do not admit D1a PASS.
  Runbook: `docs/rfc/m0-d1a-physical-runbook.md`.

- **GateP:P1 signed (2026-08-17).** Product owner `Disya123
  <gamedisya@gmail.com>` signed live glass as MUST only on
  capability-qualified devices. Record:
  `docs/rfc/gate-p-decision-draft.md`. Normative M0 is `ENTERED`, not PASS.
  Incomplete physical M-1 is an explicit owner waiver and does **not**
  raise M-1 or PRE-GATE D1a. Production migration budget stays zero until
  M0 PASS and D1/D2. React/WebView, Theme SDK, and Plugin SDK are unchanged.

- **NeoUI v4 RFC 4.5 (pre-gate evidence admission).** The draft at
  `docs/rfc/neoui-v4-android-presentation-backend.md` separates runner
  verdict from program verdict. Existing `M0-D1a` AVD run stays
  `PRE-GATE / BLOCKED` and is not admitted. Repository migration of the
  root TZ copy remains OPEN. Gate P / M0 program status is in the
  GateP:P1 signature entry above.

- **M7 slice 1 — Playwright default is Kernel.** `pnpm test:e2e` boots
  `neotavern-headless` and seeds fixtures over Product Wire (`e2e/wire.ts`).
  The Fastify `/api/v2` suite is quarantined as `pnpm test:e2e:legacy`
  (`e2e/legacy/`, `playwright.legacy.config.ts`) until plugins, theme ZIP
  install, echo, and context-audit are ported or deleted. A saved remote
  `neotavern.hostSession` in the browser now constructs `RemoteBackend`
  (Web Client reload no longer falls back to same-origin `/api/v2`).

### Security

- **SSRF-resolved-IP policy for the legacy plugin `network.fetch` (M5 slice
  45, ТЗ §SEC-03).** The legacy (Rev4) `network.fetch` RPC previously
  resolved DNS inside the fetch implementation and checked only the
  hostname allowlist — a plugin holding `network:*` could reach loopback /
  cloud-metadata endpoints through a hostname or an IPv4-mapped literal.
  It now runs the same resolved-IP policy as the vNext broker (§29.1) via
  `safePluginFetch` (`apps/server/src/lib/safePluginFetch.ts`):
  - ALL DNS answers are classified; if ANY answer is forbidden the hop is
    refused (DNS-rebinding safe);
  - bracketed IPv6 and IPv4-mapped IPv6 are normalized — both the dotted
    (`::ffff:127.0.0.1`) and the URL-normalized hex spelling
    (`::ffff:7f00:1`) of mapped addresses are unwrapped, so mapped
    loopback/link-local/metadata cannot slip through as public;
  - the connection is made to the pre-verified IP; the hostname is kept
    only for the `Host` header and TLS `servername` (SNI);
  - the connected socket's `remoteAddress` is re-checked after connect
    (defense in depth against a lookup/connect race);
  - every redirect (≤ 5) re-runs the full policy;
  - response bodies are bounded in bytes (10 MiB) and the request is torn
    down on exceed (SEC-04); a 30 s deadline applies.
  Private ranges (10/8, 172.16/12, 192.168/16, fc00::/7, CGNAT 100.64/10)
  stay allowed — self-hosted LAN endpoints are a supported use case, the
  same stance as the plugin-installer download policy. Tests
  `safePluginFetch.spec.ts` (18): classification (incl. hex-mapped),
  all-answers fail-closed, verified-IP connect, post-connect race destroy,
  redirect re-policing, oversized bodies, and `fetchRpc` integration —
  loopback/link-local/mapped/metadata denied even with `network:*`,
  `localhost` denied via DNS, allowlist/scheme/method validation kept.

### Fixed

- **Android WebView under the status bar (safe-area).** `targetSdk 35` draws
  the activity edge-to-edge. CSS `env(safe-area-inset-*)` stays 0 in Android
  WebView, and **WebView ignores `View.setPadding` for HTML**. Native padding
  around the WebView created a dead strip that was not part of the document.
  The WebView now fills the display; `MainActivity` publishes `WindowInsets`
  as `--nt-safe-area-*`. Chrome (headers, rail, composer) uses `--nt-inset-*`;
  wallpaper and **scrollable content** pass under the transparent status bar
  (Telegram-style overlay header). `--nt-inset-*` is written inline from
  `WindowInsets` (WebView often leaves CSS `max(env(), var())` at 0).
  Character-manager chrome (header, rail, bottom tabs) uses those insets so
  titles and the Cards/Edit tabs stay clear of the clock and gesture pill.
  The leading rail toggle no longer zeroes `padding-block-start` (that put
  the icon under the clock). Narrow viewports also floor chrome at
  `--st-space-2xl` so a late 0-inset publish cannot leave Cards/Edit on the
  gesture pill. The instrumented test asserts the WebView on-screen Y is 0
  and both `--nt-safe-area-top` and `--nt-inset-top` are non-zero.
- **Android Character Manager on the kernel plane.** The panel's default
  A–Z sort (`characters.list.sort.name`) was rejected as unsupported, so the
  catalog showed an error instead of the list (or an empty state). Kernel
  mode now lists then sorts the returned page by name; search / random /
  includeDeleted stay honest `UNSUPPORTED`.
- **Android Home with an empty kernel library.** `HomePage` called `useUiStore`
  / `useMemo` after the empty-catalog early return, so React threw
  "Rendered fewer hooks than expected" (#300) and the main region showed
  the generic ErrorBoundary instead of onboarding.
- **Android host switch after first connect.** A saved
  `neotavern.hostSession` hid HostConnect with no way back to local / link /
  QR. Settings → General → Host and the Home onboarding **Use another host**
  button reopen the gate (`openHostConnect`) after the settings overlay
  closes; Cancel keeps the current session. Reopen lands on the other
  method (local → Link, remote → This device) so the two backends stay
  interchangeable.
- **Android generation Stop on API 34+/36.** The notification Stop action
  used `PendingIntent.getBroadcast` with a package-scoped implicit intent
  and a context-registered `RECEIVER_NOT_EXPORTED` receiver. On API 36
  (and other 34+ devices) that broadcast never reached `GenerationService`,
  so the user Stop button and
  `BackgroundExecutionInstrumentedTest.foregroundService_pumpsGeneration_andUserStopEndsIt`
  hung until timeout. Stop is now an explicit `PendingIntent.getService`
  targeting `GenerationService` (`ACTION_STOP` → `onStartCommand`);
  dismissing the notification also `NotificationManager.cancel`s the id
  after `updateTitle` posted it via `notify()`. Verified on the API 36.1
  emulator; nightly remains API 26 + 34.

- **Android WebView catalog / settings / composer + generation process-death
  (M6).** After HostConnect local, the instrumented suite opens the
  character catalog (Hazel), Settings (change-host) and asserts the Home
  composer, then starts `generation.start` through
  `window.__neotavernMobile.call` (fake provider) and recovers
  interrupted → retry after a simulated process death on
  `<filesDir>/neotavern`. CI `assembleRelease` (debug-signed) plus the APK
  ZIP gate mark `host.android-web-assets` **Packaged**. Store-signed
  Released artifacts stay the release gate. M6/M7 are **not** accepted;
  Fastify/legacyRaw deletion remains M7.

  seed the bundled Hazel character and Vesper lorebook on first open
  (`NEOTA_SEED_STARTER=1`), using the same files as the Fastify pack. The
  2.2 MiB avatar bypasses the wire `assets.put` 1 MiB cap via the writer
  thread. After `starter.hazel.v1.complete`, a deleted Hazel is not
  restored. Kernel unit tests keep an empty library unless they set the
  env.
- **Themed HostConnect + remote Product Wire on Android/Web Client (M6).**
  The packaged Android UI no longer uses a one-off connect HTML: the gate is
  `data-component="host-connect"` skinned in `@neotavern/ui`
  (`components.css` `@layer components`, `--st-*` tokens, Card / Button /
  TextField / Segmented). `ThemeSync` mounts above the gate so an installed
  kernel theme paints the first frame. Three modes: **this device** (JNI
  `LocalBackend`), **link**, **QR** (camera scan or paste). Vite `base: './'`
  so APK `file:///android_asset/web` loads CSS/JS. `HttpTransport` speaks
  `POST /rpc/stream` SSE (NDJSON kept for stubs) and calls `globalThis.fetch`
  so Chromium does not throw `Illegal invocation` on an unbound `window.fetch`.
  The web app aliases `@neotavern/client-sdk` / `@neotavern/neobackend` from
  source (same DUP-25 path as the other frontend packages). Remote profiles
  are selectable (ADR-0034 Phase-9 deferral lifted for this gate). Pairing
  tokens stay in sessionStorage. Android: INTERNET + optional CAMERA,
  dark native chrome matching the web `theme-color`, Keystore instrumented
  round-trip, WebView user-flow + Activity recreate tests. Playwright
  `test:e2e:headless` drives the Web Client against `neotavern-headless`.
  Opaque `Origin: null` is CORS-admitted only when pairing auth is on.
  M6/M7 are **not** accepted.
- **Android web assets fail-closed packaging + Tauri Android path removed
  (M6 slice 2, ТЗ §11.4 / §18.3 / Этап 5 items 4+8).** Gradle stages
  `apps/web/dist` into APK `assets/web/` and refuses `assembleDebug` /
  `assembleRelease` without `index.html` (JVM unit tests stay independent
  of Vite). CI builds the web client before assemble and fails if the
  debug APK ZIP lacks `assets/web/index.html`; nightly emulator jobs get
  the same web build. The conflicting Tauri Android remote-connect APK
  (`pnpm desktop:android:*`, `tauri.android.conf.json`,
  `apps/desktop/mobile-connect`) is removed — the canonical host is
  `apps/android` (JNI). Ledger **M7** is registered as *not started*
  (no `deliveredCommit`) so ui:api:check M7/release-gate records have a
  ledger identity; M6 `blockingIssues` list the remaining Этап 5 work
  (Web Client remote-flow E2E, Android WebView user-flow, UI
  process-death, Keystore device round-trip, matrix Packaged/E2E exit).
  M6 and M7 are **not** accepted.
- **Headless host composition root (M6 slice 1, ТЗ §11.3).** New crate
  `crates/adapters/headless` (`neotavern-headless`): the long-running server
  the Phase 4 `remote-http-adapter` library never was. It opens a canonical
  data-root, wires an explicit SecretStore backend (`env` default /
  `session` / `unavailable`, SEC-01, never plaintext) and binds
  `RemoteAdapter` — loopback `127.0.0.1:8080` by default, non-loopback only
  with `--remote-exposure`, public bind still requires `--auth` (fail-closed
  `InsecureBind` / `PublicBindRequiresAuth` before any listener). Stdout is
  a single `listening <ip:port>` line; stdin EOF drains in-flight HTTP.
  `--auth` prints a one-time pairing token on stderr. Tests spawn the real
  binary: `/meta`, character create/get over `/rpc`, both bind gates, the
  auth gate, `--help` and missing `--root`. The ui:api legacy-compat removal
  milestone is relabeled **M7** (ТЗ Этап 6 / release gate) so ledger **M6**
  can mean Этап 5 (Headless/Web Client/Android) without colliding with
  facade retirement.
- **ui:api:check three-class legacy-surface gate (M5 slice 63, ТЗ §13.1 /
  ARC-02/ARC-03).** The scanner now classifies legacy UI sites into three
  classes instead of two: `product` (React feature code — components, pages,
  hooks — that must migrate; currently **0 sites**), `legacy-compat` (the six
  facade transport shims `apps/web/src/api/{backend,client,events,generate,
  legacyExtensionSettings,wireBridge}.ts` — the browser/legacy-sidecar
  transport of the NeoBackend facade, feature-frozen until the legacy server
  stops serving product data at Этап 6, ADR-0038/0048; 26 sites with full
  `owner`/`removalIssue`/`milestone=M6`/`deadline=release gate` records, not
  `n/a` because they are a temporary shim with a deletion condition, ARC-09)
  and `plugin-compat` (the long-lived ADR-0039 plugin-sandbox bridge; 27
  sites, `n/a`). No transport code was removed: every site stays tracked and
  `--check` still fails on any NEW site or fingerprint drift; the change
  aligns the removal milestone with ADR-0048 (previously self-contradicting
  M4/2026-12-31 records) and makes the M5 exit `product sites = 0` honest
  and measurable.
- **Plugin package verifier (M5 slice 60, ТЗ §SEC-05).** New
  `crates/adapters/package-verify` (`neotavern-package-verify`): the
  host-side verifier the kernel's `plugins.install` already assumes — ZIP
  safety (traversal/absolute-path/symlink/duplicate-path rejection, bounded
  entry count, declared-size and compression-ratio caps before any read),
  per-file SHA-256 digest equality with no unlisted payload, and Ed25519
  publisher signature over `manifest.json` via `manifest.json.sig` (ring).
  Trust classification matches the kernel rank order (verified-publisher /
  locally-trusted / unsigned-untrusted); a declared signature that fails
  against every held key fails closed, an unsigned manifest stays
  unsigned-untrusted, and permissions are left to the install consent
  moment (ARC-08). 14 unit tests incl. signed/unsigned/bad-signature
  packages, traversal, absolute path, duplicate path, symlink-mode
  boundary, unlisted/missing files, digest mismatch and a zip-bomb
  fixture.
- **Headless host tool executor (M5 slice 59, ТЗ §8.3/§9.3).** The host
  executor seam moves into the shared `crates/adapters/host-tools`
  (`neotavern-host-tools`): `ToolExecutor` trait, `NoopToolExecutor`,
  `BuiltinToolExecutor` (`app_now` — side-effect-free, consent-free),
  `step_tool_call` extraction and `offer_tool_call` dispatch (SEC-07: only
  the tool NAME ever reaches diagnostics). Tauri-local re-uses the crate;
  the remote-http SSE worker now mirrors the desktop poller — the headless
  host performs safe built-in tool effects, submits `generation.tool.result`
  and keeps streaming the durable journal through the resumed turn
  (`NEOTA_TOOL_EXECUTOR=none` opts out; runs then stay durably waiting as
  before). Integration test completes the safe `app_now` round trip over a
  live SSE stream with no external actor. Previously this headless mirror
  was promised as follow-up to slice 57.
- **Machine-bound OS credential vault (M5 slice 58, ТЗ §SEC-01/SEC-01.1).**
  New `os-vault` feature in `crates/secret-store` + `OsVaultSecretStore`
  (via `keyring`: Windows Credential Manager / macOS Keychain / Linux Secret
  Service). Installed (non-portable) kernel mode now wires the OS vault by
  default (`KernelHostConfig::secret_backend`; `NEOTA_SECRET_BACKEND` and
  smoke/portable overrides); `osvault:<namespace>:<id>` references are
  machine-bound — credentials never travel with the data folder, an
  unreachable vault reports `SECRET_UNAVAILABLE_ON_THIS_DEVICE`, there is
  never a plaintext fallback. Fail-closed limits: 2560-byte credential blob,
  500-byte key; writes are serialized in-process (Windows Credential Manager
  race caveat); `list()` is honest about OS vaults having no portable
  enumeration (per-record `has`/`get`/`delete`). Tests: secret-store unit
  incl. a real-vault round trip (skipped on runners whose vault accepts but
  does not persist writes) and tauri-local resolver/seam wiring tests.
- **Desktop host tool executor (M5 slice 57, ТЗ §8.3/§9.3).** The desktop
  kernel host now performs the effects of registered safe tools — the kernel
  still never executes them. `setup_local_kernel_mode` wires the declarative
  `app_now` contract (UTC clock; side-effect-free, consent-free) and the new
  `BuiltinToolExecutor` seam (`crates/adapters/tauri-local/src/executor.rs`);
  the stream poller offers every durably `waiting` `tool_call` step to the
  executor and, when handled, submits `generation.tool.result` itself and
  keeps polling the durable journal through the resumed turn. Failures stay
  recoverable (executor error / failed submission leaves the run durably
  waiting; the kernel stale-result guard makes double submission harmless);
  unhandled tools behave exactly as before. SEC-07: only the tool NAME
  reaches diagnostics — never arguments or result content. Tests: executor
  unit (app_now answered, unknown tools stay waiting, extraction only on
  waiting `tool_call` steps, RFC3339 conversion) + `host_tool_executor.rs`
  integration (full host-completed tool round trip with resumed final text;
  no-executor control keeps `waiting_for_tool`).
- **ARC-10 `library.assets` raise (M5 slice 56).** Content-addressed asset
  store raised Implemented → Integrated (desktop + webClient): the live
  kernel-plane flows exercise `assets.put`/`assets.content` — CharacterManagementPanel
  avatar upload (`assets.put` kind avatar + `characters.update
  avatarAssetId`), character-card import staging (`assets.put` kind card),
  theme CSS resolution (`assets.content`) — and the RemoteBackend Web Client
  uses the same wire path. `ui.card-exports` and `ui.prompt-pipeline` stay
  honestly Implemented (character/chat EXPORT remains legacy-only until
  Этап 4.5; the pipeline UI is plan view-only).
- **ARC-10 status roundup part 2 (M5 slice 55).** `generation.prompt.plan`,
  `providers.config`, `providers.list`, `ui.secrets`, `ui.diagnostics` and
  `ui.portable-data` raised Implemented → Integrated (desktop + webClient)
  with code-path evidence: PromptPlanPanel renders the durable wire
  PromptPlan; ProviderProfileEditor persists configs via
  `backend.providers.config.*` (desktop session SecretStore seam makes apiKey
  writes succeed, M5 slice 49) and generation.start carries provider/model
  (slice 48); `useProviderCatalog` powers provider selects + honest
  CAPABILITY_UNAVAILABLE pre-negotiation; the Secrets panel manages
  status/lock through `backend.secrets.*`; DiagnosticsPanel runs on the
  kernel plane (Kernel Preview marking); ActivationStatusPanel reads durable
  activation status via `backend.data.activationStatus`. Honest boundaries
  stay documented (approximate tokenizer, host-side auto-lock, host SecretStore
  backends in M3).
- **ARC-10 webClient status roundup (M5 slice 54).** `personas.crud`,
  `lorebooks.crud`, `presets.crud` and `settings` raised Implemented →
  Integrated on webClient with code-path evidence appended to each note:
  PersonasPanel (persona CRUD + active-persona writes), LorebookPanel +
  CharacterManagementPanel lorebook tab (scoped/all lorebook CRUD),
  GenerationPresetEditor + PromptTemplateEditor (preset CRUD + activation),
  and Settings/AiSettings/AutoConnectSync (settings get/update) all route
  through the NeoBackend facade wire ops on the kernel plane — the
  RemoteBackend Web Client exercises the same wire path as desktop.
- **generation.tool-loop notes accuracy fix (M5 slice 53).** The
  release-manifest note for `generation.tool-loop` no longer lists transcript
  step rendering as remaining work: the durable run-step UI (M5 slice 47,
  RunTranscriptPanel over `generation.events`) renders `tool_call` and
  `tool_result` steps (sequence badge, status, attempt marker, i18n en/ru).
  The honest remaining boundary narrows to UI-side `generation.tool.result`
  submission and the dangerous-tool consent modal (Этап 4).
- **SEC-05 kernel trust-state roundup (M5 slice 52).** Documented evidence in
  `security.plugin-package-trust`: the canonical plugin/theme registry
  records the four trust states with a fixed rank order
  (`built-in`(3) > `verified-publisher`(2) > `locally-trusted`(1) >
  `unsigned-untrusted`(0)); re-install that would lower the recorded rank is
  rejected (TRUST_DOWNGRADE), unknown states violate the closed wire enum
  (`ContractViolation`), and `trustState` surfaces through
  `translatePlugin`/`translateTheme` into the PluginsPanel/themes UI.
  `built-in` is rank-protected for future bundled extensions; no bundled
  plugins ship yet, so no row carries it — the host-side package verifier
  feeding the web transport remains the documented boundary.
- **Web Client offline truthfulness capability (M5 slice 51, ARC-12).** New
  release-manifest row `web-client.offline-truthfulness` (Integrated on
  webClient): the remote-only Web Client shows an honest connection/offline
  screen (AuthGate offline banner with `role=status` / full-screen
  connectionRequired + Retry, ConnectivityStatus `data-state=offline`
  indicator) and performs no local product mutations — all operations flow
  through the NeoBackend facade and fail with a network error when the
  backend is unreachable. The production-only service worker caches only the
  versioned app shell (`SHELL_URL`); `/api/` requests pass through un-cached,
  so API/SSE/prompt/secret data never enters Cache Storage (AGENTS.md §20).
  Capability matrix now 38 rows (no wire ops added).
- **ARC-10 status honesty roundup (M5 slice 50).** Five capabilities raised
  Implemented → Integrated on desktop/webClient with code-path evidence:
  `library.characterImport` (CharacterManagementPanel + Characters page →
  wire `assets.put` + `imports.character.card`), `ui.themes` (Settings themes
  section + ThemeSync → wire list/activate/deactivate/uninstall), `ui.plugins`
  (Sidebar PluginsPanel + PluginSync → wire list/enable/disable/uninstall),
  `ui.profile-export` and `ui.profiles` (Settings Profiles tab → wire
  `profile.export`/`profile.import` + profiles CRUD). Honest boundaries stay
  documented in each note: theme/plugin package INSTALL, git install, runtime
  safe mode and OAuth connections remain `CAPABILITY_UNAVAILABLE` on the
  kernel plane (no host SEC-05 verifier / SEC-06 executor yet); the legacy
  contour keeps honest `UnsupportedError` for profiles/themes facade ops.
  Capability matrix still 37 rows.
- **Desktop kernel host secret seams (M5 slice 49, ТЗ §SEC-01).** The Tauri
  host now wires the kernel's `SecretStore`/`SecretResolver` port handles:
  a session-only `MemorySecretStore` plus a resolver that serves exactly the
  `session:` references that store produces (`crates/adapters/tauri-local`
  `secrets` module). `providers.config.set apiKey` now commits on the kernel
  plane for the session, and a generation resolves the key at execution time.
  Explicit SEC-01 session-only interim: values live in process memory only —
  a restart clears them and the runtime reports the stable unavailable state
  until the key is re-entered; `portable:`/`env:` references and missing
  records fail closed with typed `Unavailable`, never a plaintext fallback.
  Host tests 3 (session round trip, fail-closed kinds, kernel store
  writability; tauri-local 12/12). The OS-vault / Android Keystore adapters
  remain M3 — when the vault lands, only `wire_session_secrets` changes.
- **Production provider selection on the kernel plane (M5 slice 48, Этап 2.5).**
  A stored OpenAI-compatible config is now generatable without any host-side
  adapter wiring: `providers.config.set` materializes the adapter into the
  kernel registry right after its commit (replacing by adapter id — no
  duplicates), and startup hydration re-registers every saved config, so the
  provider survives restarts. The web transport resolves the selected provider
  config id (settings `active-provider-config-id`) into the `provider`/`model`
  pair handed to `generation.start` — a vanished config is an honest
  `PROVIDER_CONFIG_NOT_FOUND`, never a silent fake fallback. Kernel tests:
  config hydration survives a restart and drives a full generation run on the
  restarted kernel, re-save replaces the adapter (providers_openai 6/6);
  generate.test 9/9. Honest boundary: executing a configured key still needs
  the host SecretStore/SecretResolver seams (desktop host wiring is a follow-up
  slice); without a seam, setting a key fails closed (`SECRET_UNAVAILABLE`)
  and a run resolves fail closed (`ProviderError::Unavailable`).
- **Durable run-step transcript — generation timeline in the UI (M5 slice 47,
  ТЗ §8.3/§13.2, §15).** Messages that carry a durable generation run id gain
  a «Steps» footer action in the details card, opening `RunTranscriptPanel`:
  the immutable step journal of the run — provider turns, tool calls, tool
  results and the final commit — in document order with per-step status and
  time (attempt markers on retried steps). Kernel plane: wire
  `generation.events` envelopes, keeping ONLY the `generation.step` payloads;
  tool arguments/results never reach the UI shape (SEC-07). Legacy plane:
  honest `UnsupportedError` → empty state (ARC-02). wireBridge
  `listGenerationSteps` (`afterSequence` paging + `hasMore`),
  `useGenerationRunSteps` hook; tests: wireBridge 4, RunTranscriptPanel 4.
- **ARC-10 status honesty (M5 slice 47).** `chats.messages.variants-
  revisions-drafts` and `memories.crud` raised from Implemented to
  Integrated: the production UI (variant picker/swipes, revision history,
  content edits; memory settings editor) routes every operation through the
  wire facade in kernel mode. Capability matrix now 37 rows
  (`ui.run-transcript` added).
- **`chats.snapshots.list` — snapshot (checkpoint/branch) listing for one
  chat (M5 slice 46, ТЗ §8.1 Conversations).** The child chats of a chat are
  now first-class over Product Wire: the kernel returns them newest-first,
  each with its message count and the `parentChatId`/`origin`/
  `sourceMessageId` markers, walking the opaque `(createdAt, id)` cursor; the
  parent must exist (`CHAT_NOT_FOUND`); the rollback auto-checkpoint appears
  in the list too. Wire: 97 ops total; fixtures + neg; `WIRE_SCHEMA_HASH`
  `55af3aab...`; wire_corpus decoders 77. Kernel suite 4 (newest-first
  markers, rollback checkpoint listed, missing parent, cursor walk without
  duplicates); remote-http `snapshots_list_over_http` (host parity incl. the
  stable `CHAT_NOT_FOUND` over HTTP). Facade: `listChatSnapshots` wireBridge
  (kernel plane; legacy plane honest `UnsupportedError` — the frozen sidecar
  has no snapshot-list contract, ARC-02). UI: `ChatSnapshotsMenu` header
  trigger lists the snapshots of the active chat and navigates into a child
  chat; hidden entirely on the legacy plane; i18n en/ru.

- **`chats.snapshots.rollback` — atomic chat rollback with an automatic
  safety checkpoint (M5 slice 44, ТЗ §8.1 Conversations).** Rolling a chat
  back to a kept message now works end-to-end: the kernel removes everything
  with a higher `sequence` in ONE transaction, but FIRST freezes the removed
  suffix into an auto-created checkpoint child chat (`origin=checkpoint`,
  `sourceMessageId` = kept message; variants/revisions cascade into it) so
  the user always keeps a recoverable copy. A no-op rollback (nothing after
  the target) creates no checkpoint and returns `deleted: 0` — repeating it
  is safe. Missing chat/message → `CHAT_NOT_FOUND`/`MESSAGE_NOT_FOUND`. Wire:
  96 ops total; fixtures + neg; `WIRE_SCHEMA_HASH` `28b9f195...`; wire_corpus
  decoders 75. Kernel suite 5 (suffix removal + kept message, no-op repeat,
  rollback-after-rollback, variant/revision cascade, honest errors);
  remote-http `snapshots_rollback_over_http` (37 scenarios). Facade:
  `chats.rollbackSnapshot` on Local/Remote, honest `UnsupportedError` on
  legacy; parity +1 (85). UI: "Roll back to this message" action with a
  confirm dialog (danger), `rollbackChatToMessage` wireBridge (kernel plane;
  legacy plane honest `UnsupportedError`), ChatPage notification with an
  "Open" action into the checkpoint; i18n en/ru; wireBridge +2, MessageBubble
  +1. Honest boundary: the legacy contour has no rollback semantics (ARC-02).

- **Tool registry UI in Settings (M5 slice 43, ТЗ §8.3/§13.2).** The Settings
  panel gains a Tools tab rendering the declarative tool contracts the host
  registered with the kernel (`generation.tools.list`): name, description
  and the required argument names from each input JSON-Schema, plus an
  honest empty state ("No tools registered by this host") — arguments and
  results never reach the panel. `useGenerationTools` hook
  (queryKey `generation-tools`), `ToolsPanel` component (2 tests), i18n
  en/ru (`settings:tools`, `tools:*`). Honest boundary: transcript step
  rendering, `generation.tool.result` submission and the dangerous-tool
  consent modal remain Этап 4.

- **`profile.import` — logical profile import over Product Wire (M5 slice 42,
  SEC-02 round trip).** Applies a verified profile export container into the
  library through the storage `apply_import` primitive: the container is
  fully verified and ALL records are parsed and validated before any write,
  then applied in ONE transaction or nothing is. The wire request carries
  the host-staged `containerPath` (relative to the data root) plus the
  duplicate policy (`reject` skips existing ids — re-running adds nothing,
  `replace` updates them, `remap` assigns fresh ids and remaps child
  references); the response reports `inserted`/`updated`/`skipped` and every
  skipped orphan (never invented). Path resolution is fail-closed (managed
  relative-key grammar + lexical containment — no traversal, no absolute
  paths; missing container → `NOT_FOUND`; corrupted container rejected
  before any write). Storage fix: the remap `uuid_v7` helper now pins the
  version nibble to 4 exactly like the kernel's id generator, so remapped
  ids pass the wire uuid format. Facade: `ProfilesApi.import` on
  LocalBackend/RemoteBackend, honest `UnsupportedError` on LegacyBackend.
  UI: the Settings Profiles tab gains an Import action (container path +
  duplicate-policy select) wired through `useProfileImport` with library
  query invalidation; i18n en/ru. Tests: kernel suite 5 (round trip, reject
  idempotency, replace update, traversal + missing, corrupted-before-write),
  remote-http `profile_import_over_http` (35 → 36 scenarios), neobackend
  parity +1 (84), ProfilesPanel +1 (5). Wire: 95 ops total; fixtures
  `profile-import-request`/`-request-remap`/`-response`/neg; wire_corpus
  decoders 73; `WIRE_SCHEMA_HASH` `6fc65aec...`.

- **Tool-execution indicator in the web chat (M5 slice 41, ТЗ §13.2).** The
  UI now distinguishes tool execution / waiting-for-tool from text
  streaming: `streamWireGeneration` forwards the durable
  `generation.step` announcements (`provider_turn` / `tool_call` /
  `tool_result`) to a new `onStep` handler, ChatPage derives the active
  tool from `tool_call` steps (only `step.input.toolCall.name` — arguments
  and results never reach the UI) and renders a `ToolActivityBadge` while
  the run is waiting, clearing it on the next `provider_turn` /
  `tool_result` step and on done/error/stop. Tests: `generate.test` proves
  the step forwarding (provider turn → tool_call waiting → delta → done
  ordering), `ToolActivityBadge` component tests (2); i18n en/ru
  (`chat:toolRunning`). Honest boundary: step rendering in the transcript
  and result submission (`generation.tool.result`) remain Этап 4.

- **`secrets.lock` — manual secret-store lock over Product Wire (M5 slice 40,
  ТЗ §SEC-01.1).** The portable `secrets.enc` store now supports the manual
  lock end-to-end: wire `secrets.lock` (transactional, idempotent,
  `app.write`; response `{ locked: true }`; fail-closed
  `CAPABILITY_UNAVAILABLE` when no store seam is wired), a kernel stateless
  arm that drops the derived key material in memory (best-effort
  zeroization), and honest post-lock semantics: `secrets.status` flips to
  `available: false` and subsequent provider-key writes fail with
  `SECRET_STORE_LOCKED` until the host re-opens the store with the master
  passphrase (records survive the lock/reopen cycle). Host parity:
  `secrets_lock_over_http` (fail-closed without a store, lock over HTTP,
  idempotent second lock, status flip). Facade: `SecretsApi.lock` —
  Local/Remote over the wire, Legacy honest `UnsupportedError` (parity
  83/83). UI: `useLockSecrets` + a Lock-now action in the Settings Security
  tab shown only for an available portable store; after invalidation the
  panel flips to the honest locked hint (i18n en/ru). Tests: kernel secrets
  5 (fail-closed, lock/reopen round trip, `SECRET_STORE_LOCKED` on key
  write, idempotency), remote-http over HTTP, contracts 15/15 with the lock
  fixtures (94 ops). Honest boundary: auto-lock (timer-based) and the
  first-launch mode onboarding remain host-side flows; the manual lock is
  now wire-covered. `wire_corpus` also regains the previously missing
  `decode_result_secrets_status` fuzz decoder (71 decoders).

- **`backups.restore` over Product Wire (M5 slice 39, ТЗ §10.4).** Restore is
  now reachable end-to-end on the kernel plane: the writer thread closes the
  database (WAL checkpoint) and releases the data-root lease, runs the
  storage staged-restore + activation protocol (verify → candidate sibling →
  migrations inside the candidate → `foreign_key_check`/`integrity_check` →
  finalize → pending-marker swap with previous-root retention), re-opens the
  database on the active root and appends the durable activation-journal
  entry (`kind = restore`, `status = committed`) — the same kernel keeps
  serving afterwards. Wire: `backups.restore` (workflow, non-idempotent,
  `app.write`; strict `{ backupId }` request; response
  `{ status: 'committed' | 'activation_pending' }`; `NOT_FOUND` for an
  unknown id). Host parity: `backups_restore_over_http` (create → backup →
  delete → restore → snapshot back, plus the `NOT_FOUND` error envelope).
  Facade: `BackupsApi.restore` — Local/Remote over the wire, Legacy translates
  to the sidecar `POST /backups/{id}/restore` mapping `restartRequired` onto
  `activation_pending` (a boundary translation, no added authority; parity
  82/82). UI: `useRestoreBackup` now routes the kernel plane through the wire
  op and maps `activation_pending` onto the existing restart prompt in the
  Settings Data tab. Tests: kernel backups 7 (restore round trip through the
  same kernel, `NOT_FOUND` product error, non-uuid contract violation,
  stateless rejection, quota), remote-http restore over HTTP, hooks (wire
  restore without a network call, `activation_pending` mapping), contracts
  62/62 with the restore fixtures (93 ops). Honest boundary: the swap is
  synchronous in the writer, so `activation_pending` is only produced when a
  Windows sharing violation survives the activation attempt and must be
  finished at next open.

- **Durable data-root activation status over Product Wire (M5 slice 38,
  ТЗ §10.2–§10.3).** The kernel already owned versioned data roots
  (`roots/root-<id>/` + `active-root.json`), the durable activation journal
  (`prepared`/`validated`/`activation_pending`/`committed`/`rolled_back`)
  and the Windows restart-to-complete protocol at the storage/bootstrap
  layer; this slice exposes the honest state end-to-end: wire op
  `data.activation.status` (idempotent, safe, `app.read`; strict empty
  request; response carries `layoutVersion` 1|2, `activeRoot` +
  `activeRootId`, `journalFormat`/`journalFormatVersion`, the full journal
  entries array and the newest `activation_pending` entry as `pending`),
  the kernel handler `data_activation_status` (reads the journal through
  `neotavern_storage::activation`; `Database` now exposes its `data_root`),
  loopback-HTTP host parity (`data_activation_status_over_http`), facade
  `NeoBackend.data.activationStatus` (Local/Remote wire, Legacy honest
  `UnsupportedError`; parity 78/78), `wireBridge getDataActivationStatus`,
  a `useDataActivationStatus` hook, and the ActivationStatusPanel in the
  Settings Data tab (layout badge, active root path/id, pending warning
  framed as restart-to-complete, journal table with kind/status/times/
  error/from→to roots, honest empty and error states). Tests: kernel_data 4
  (v1 empty journal, pending surfaced from the journal, v2 detection,
  stateless rejection), wireBridge (kernel + legacy refusal), hooks (kernel
  resolve, legacy honest error without a network call), ActivationStatusPanel
  (plan, pending, empty, error). Honest boundary: the write side of
  activation/restore remains offline (CLI `--migrate-legacy` / storage
  suites); the UI reports state, it does not perform switches from the
  browser.

- **Durable PromptPlan viewer over Product Wire (M5 slice 37, ТЗ §9.2).**
  The kernel already stores one immutable prompt plan per generation run;
  this slice exposes it end-to-end: `NeoBackend GenerationApi.promptPlan(runId)`
  (Local/Remote wire, Legacy honest `UnsupportedError`), `wireBridge
  getPromptPlan`, a `usePromptPlan` TanStack hook (unknown run /
  `PROMPT_PLAN_NOT_FOUND` / legacy refusal resolve to an honest empty state,
  never an error), and the PromptPlanPanel dialog opened from the message
  details card footer (shown only for messages carrying a durable run id,
  which `translateMessage` now surfaces in `meta.generationRunId`). The panel
  renders provider/model, instruct format, tokenizer profile (approximate
  badge), input/response-reserve/context-limit tokens, the over-budget
  warning, system blocks by source, selected messages and every excluded
  message with its reason — the user can inspect what context entered the
  provider request and what was cut. Tests: wireBridge getPromptPlan (kernel
  + legacy refusal), hooks usePromptPlan (plan / NOT_FOUND → null / refusal →
  null), PromptPlanPanel (plan, over-budget, empty state, close),
  MessageDetailsCard prompt footer action, parity 77/77 (routing + non-uuid
  rejection). Honest boundary: the live pre-generation context preview and
  the sidecar-pipeline context audit stay legacy-only (kernel
  `CAPABILITY_UNAVAILABLE`); the canonical ТЗ §9.2 record is the per-run
  durable plan.

- **Chat snapshot export over Product Wire (M5 slice 36).** New wire
  operation `chats.export` (91 ops total): request `{ chatId }`, result
  `{ filename, contentType, contentBase64, warnings[] }` with a 4 MiB
  response budget (long chats legitimately exceed the 256 KiB default cap;
  over-limit surfaces as a transport error, never truncation). The kernel
  (`crates/runtime-kernel/src/exports.rs`) dumps the canonical
  `neotavern-chat-export` v2 container — chat metadata + character name +
  full message/variant/revision dump, wire-visible fields only (nothing
  fabricated), with an honest warning for empty chats and the stable
  `CHAT_NOT_FOUND` error. The last chat-related export refusal is gone:
  `exportChat` now downloads the decoded container on the kernel plane
  instead of throwing `UnsupportedError`. Tests: kernel_exports.rs +3
  (dump with variants/revisions incl. the activated-swipe transition,
  empty-chat warning, CHAT_NOT_FOUND; 8 total), wire_corpus arms, remote-http
  host parity `chat_export_over_http` (32 scenarios), wireBridge 98/98,
  parity 75/75 (`ChatsApi.export` routed identically local/remote, non-uuid
  rejected pre-transport). UI: the chat export menu (ChatManagementPanel)
  works on the kernel plane.

- **Character-card export over Product Wire (M5 slice 35, Этап 4.5).** New
  wire operation `characters.export.card` (90 ops total): request
  `{ characterId, format: json | png }`, result
  `{ filename, contentType, contentBase64, warnings[] }`. The kernel
  (`crates/runtime-kernel/src/exports.rs`) builds the SillyTavern card
  container: an imported character round-trips its original card object
  verbatim (preserved under `ext_json._card`, AGENTS.md §11); a character
  created without a container is rebuilt from the canonical columns with an
  honest warning; the PNG format emits a minimal PNG whose `chara` tEXt
  chunk carries base64-encoded JSON — exactly the container
  `imports.character.card` parses, so exports re-import (container data
  round trip, std-only writer: zlib stored block + CRC-32/Adler-32, no new
  dependencies). Stable `CHARACTER_NOT_FOUND` (`characterId` param). Tests:
  kernel_exports.rs 5/5 (verbatim round trip, rebuilt+warning, PNG re-import
  cycle, NOT_FOUND, PNG field fidelity), wire_corpus arms, remote-http host
  parity `character_card_export_over_http` (JSON round trip, PNG signature,
  NOT_FOUND — 31 scenarios total), wireBridge 98/98 (export now downloads a
  decoded Blob object URL on the kernel plane instead of refusing), parity
  73/73 (`CharactersApi.exportCard` routed identically local/remote, bad
  format rejected before transport). UI: the CharacterManagementPanel export
  menu now works on the kernel plane. Remaining honest refusal: chat
  snapshot export (`chats.export`) still has no wire op.

- **Honest status: message edit/delete UI is wire-integrated (M5 slice 34,
  ARC-10).** `ui.message-editing` rises from Designed to **Integrated** on
  desktop/headless/Web Client (android stays Designed until JNI parity is
  packaged). Every message-editing surface already routes through the wire
  facade with no `/api/v2` in feature code: the MessageBubble inline editor
  saves via content-only `chats.messages.update` (last-write-wins by
  contract; the legacy `expectedRevision` CAS remains legacy-only), delete
  via `chats.messages.delete`, context toggle / greeting swipe via
  content+meta through `updateChatMessage`, and checkpoint removal via
  `clearCheckpointChatId`. Evidence is the existing coverage:
  MessageBubble.test (draft preserved on edit failure), MessageDetailsCard
  tests (edit dialog), wireBridge.test (`updateChatMessage`
  content/meta/clearCheckpointChatId, `deleteMessageVariant`) — the slice
  is a documentation/capability-matrix correction, no code change was
  needed. Capability matrix regenerated (36 rows).

- **Character-card import host parity over HTTP (M5 slice 33, Этап 5
  foundation).** `remote_http.rs` gains `character_card_import_over_http` —
  the full Этап 4.5 flow over the loopback `remote-http-adapter`: `assets.put`
  (kind `card`) → `imports.character.card` (created, wire-valid result) →
  re-import of the same bytes dedupes (`created: false`, same character id,
  AGENTS.md §11) → unknown asset answers the stable `ASSET_NOT_FOUND`
  product error with the `assetId` param → unparseable bytes answer
  `CHARACTER_CARD_INVALID` with the `reason` param. Every payload crosses the
  generated decoders/validators (`validate_result_imports_character_card` …),
  so the same contract semantics hold over direct kernel dispatch, the wire
  corpus and the HTTP transport (host parity suite, ТЗ §17.3). Remote-http
  suite green (30 scenario tests incl. the new one), fmt/clippy clean.

- **Character-card import UI flow on the kernel plane (M5 slice 32, Этап
  4.5).** The web transport's `importCharacter` now returns a fully typed
  `CharacterImportResult` on both planes: the kernel branch maps the wire
  result of `imports.character.card` onto the legacy shape via
  `translateCharacter` (`name`/`id`/`created`/`sourceHash`/`warnings` flow
  through; full card fields beyond the canonical columns live in
  `ext_json._card` and are not modelled by the wire DTO, so the editor sees
  honest defaults — it must not fabricate persona text), and
  `useImportCharacter` drops the `as` cast. Both import entry points —
  `CharactersPage` ("imported / already exists" status) and
  `CharacterManagementPanel` (select + jump to the edit tab) — now work
  unchanged on the kernel plane because they consume only
  `name`/`id`/`created`. Re-import of the same card shows the honest
  "already exists" state (dedupe by content hash, AGENTS.md §11). Tests:
  wireBridge 97/97 (import test now asserts the full translated shape),
  hooks.test +1 (kernel two-step flow: `assets.put` → `imports.character.card`,
  no network), full web vitest 703/703 (68 files).

- **Character-card import over Product Wire (M5 slice 31, Этап 4.5).** New
  wire operation `imports.character.card` (89 ops total): the card file
  (SillyTavern-compatible V2 JSON, or a PNG carrying the `chara` tEXt chunk
  with base64-encoded JSON) is staged through `assets.put` (kind `card`,
  content-addressed, idempotent) and parsed by the kernel — sha256 of the
  original bytes deduplicates against the new `characters.import_hash`
  column (schema migration 019, indexed) so re-running an import returns the
  existing character with `created: false` (AGENTS.md §11: import must not
  create duplicates). Card fields beyond the canonical columns — personality,
  scenario, first message, example dialogue, system prompt, post-history
  instructions, creator, character version, extensions and any unknown
  fields — survive verbatim under `ext_json._card` (AGENTS.md §11: unknown
  character card fields and extension metadata must not be lost);
  over-length scalar columns are truncated with an honest warning. PNG cards
  link the staged asset as the avatar; JSON cards carry none. Missing asset →
  stable `ASSET_NOT_FOUND`; unparseable card → `CHARACTER_CARD_INVALID` with
  a `reason` param. Facade: `NeoBackend.imports.characterCard` (Local
  forwards with request/response validation, Remote via ClientSdk, Legacy
  throws `UnsupportedError`); the web transport's `importCharacter` now runs
  `assets.put` + `imports.character.card` on the kernel plane (UI wiring in
  the import panels is slice 32). Tests: kernel_imports.rs 5/5, wire corpus
  dispatch (4 new fixtures), neobackend parity 71/71, wireBridge 97/97.

- **Product Wire ↔ Kernel dispatch parity gate (M5 slice 30).** New
  `scripts/check-kernel-dispatch.mjs` verifies ARC-01/ARC-07 structurally:
  every operation registered in `packages/contracts/src/wire/registry.ts`
  (89 today) must have a kernel dispatch arm in
  `crates/runtime-kernel/src/lib.rs` — either a unary arm of the main
  `match op` block or the `dispatch_stream` streaming path
  (`generation.start`/`generation.retry`) — and every dispatch arm must
  be a registered operation. A registered operation without an arm means
  the kernel answers `OperationNotFound` to a valid contract; an arm
  without a registered operation is dead surface. The check is wired into
  `docs:check` (alongside the capability-matrix freshness gate) and exposed
  as `pnpm kernel:dispatch:check`. Verified: 89/89 operations covered,
  docs:check + docs:sync:check green, eslint/prettier clean.

- **Provider editors report the catalog-unavailable state honestly (M5
  slice 29).** The provider catalog has no honest wire equivalent
  (ProviderDto carries no adapterKind/defaultBaseUrl/apiKeyRequired), so
  the catalog query rejects with a typed `UnsupportedError` on the kernel
  plane — the panels previously swallowed that error and silently hid the
  API-mode/source selects, suggesting the catalog was simply empty. Both
  `ProviderProfileEditor` and `GenerationPresetEditor` now render the
  localized query error (errors:UNSUPPORTED with the raw feature code)
  through a dedicated `catalog-error` region whenever the catalog query is
  in error, on BOTH planes (a legacy network failure is reported just as
  honestly); the manual path (typed name/base URL, openai-compatible
  default) still works without the catalog. Tests: ProviderProfileEditor
  2/2 (+1 kernel-plane case: honest catalog error, no fetch, manual
  connect still saves through `providers.config.set`), full web vitest
  green (68 files, 702 tests), typecheck/eslint/prettier clean,
  ui:api:check 53, docs:check + gates GATE PASS.

- **ApiKeysModal reports the honest secrets-unavailable state on the
  kernel plane (M5 slice 28).** The multi-key secrets manager previously
  rendered the empty state ("No keys yet") when the secrets list query
  failed — on the kernel plane that silently suggested there were no keys,
  when in fact the wire plane has no secrets CRUD at all (SEC-01: the API
  key lives inside the provider config and its value never crosses a DTO).
  The panel now renders the localized query error (typed
  `UnsupportedError` → errors:UNSUPPORTED with the raw feature code) via a
  dedicated `secrets-error` region whenever the list query is in error, on
  BOTH planes (a legacy network failure is reported just as honestly);
  the empty state appears only when the list actually loaded empty. Tests:
  ApiKeysModal 8/8 (+1 kernel-plane case: no fetch, honest error instead of
  empty state), full web vitest green (68 files, 701 tests),
  typecheck/eslint/prettier clean, ui:api:check 53, docs:check + gates
  GATE PASS.

- **Provider connect no longer reports discovery as a failed connection on
  the kernel plane (M5 slice 27).** After slice 26 made the provider list
  wire-backed, `ProviderProfileEditor.connect()`/`loadModels()` hit the
  honest `UnsupportedError` from model discovery (`providers.models.discovery`
  — a kernel-side capability with no wire operation) and showed a
  localized "connection failed" error even though the connection itself had
  already persisted. Now the discovery refusal (typed `UnsupportedError`) is
  absorbed into the honest `saved` status — the same optional-warm-up
  boundary as the AutoConnectSync refresh — while real discovery failures on
  the legacy plane still surface as before. Tests: ProviderProfileEditor 1/1
  (kernel connect: wire config.set + settings.update called, 'Saved' status,
  no alert, no fetch), full web vitest green (68 files, 700 tests),
  typecheck/eslint/prettier clean, ui:api:check 53, docs:check + gates GATE
  PASS.

- **Provider and secret hooks are honest on the kernel plane (M5 slice
  26, ARC-02).** `api/providerHooks.ts` — 15 hooks
  (`useProviders`/`useProviderCatalog`/`useCreateProvider`/
  `useUpdateProvider`/`useDeleteProvider`/`useDiscoverProviderModels`/
  `useProviderSecrets`/`useSecretsExposure`/the four secret mutations) —
  previously hit the legacy surface on EVERY backend: on the kernel plane
  useless network calls to dead `/api/v2/providers*` routes. Now every hook
  gates on `isKernelMode()`: `useProviders` maps the wire
  `providers.config.list` result into the legacy UI shape (RFC3339 →
  epoch-ms, connection fields hoisted from the opaque `config` blob);
  create/update/delete route through `providers.config.set/del` with the
  legacy one-config-per-provider model spelled as a single `default` named
  config; the static provider catalog, model discovery and the separate
  secrets CRUD/reveal reject with a typed `UnsupportedError`
  (CAPABILITY_UNAVAILABLE — the wire stores the API key inside the config
  and its value never crosses a DTO, SEC-01); `useSecretsExposure`
  resolves the honest fail-closed `{ allowSecretsExposure: false }`. Never
  a silent legacy request from kernel mode (ARC-02). Legacy contour
  (sidecar / remote Web Client) keeps the real routes. Tests:
  providerHooks 17/17 (+12 kernel-honesty cases + translator unit tests),
  full web vitest green, eslint/typecheck/prettier clean, ui:api:check 53
  sites, docs:check + gates GATE PASS.

- **Wire corpus dispatcher covers the snapshot DTOs (M5 slice 25,
  ARC-07).** The full `cargo test --workspace` sweep found
  `wire_corpus.rs::dispatch` panicked on `wire.request.create-chat-snapshot`
  and `wire.result.chat-snapshot` — the corpus fixtures emitted for
  `chats.snapshots.create` (slice 14) referenced two schemaIds the hand-
  maintained dispatcher had never been taught, so the generated
  request/response decoders were silently untested by the corpus (the
  snapshot op's kernels tests passed, masking the gap). The dispatcher now
  routes both ids to `decode_request_create_chat_snapshot` /
  `decode_result_chat_snapshot`, so the full wire corpus round-trips every
  op end-to-end. Verified: `wire_corpus` 3/3, full `cargo test --workspace`
  green, contracts:check clean.

- **Prompt context preview hook is honest on the kernel plane (M5 slice
  24, ARC-02).** `usePromptContextPreview` (the live context meter used by
  Home and existing chats) hit the legacy `/api/v2/context-preview`
  surface on EVERY backend. Now the transport gate lives in the hook: on
  the kernel plane it rejects with a typed `UnsupportedError` (the kernel
  exposes `generation.prompt.plan` with a different contract; the legacy
  preview stays a sidecar contour — honest CAPABILITY_UNAVAILABLE, ТЗ
  §13.1), never a silent legacy request from kernel mode (ARC-02). This
  completes the M5 sweep: every legacy-call site in `api/hooks.ts` is now
  behind an explicit `isKernelMode` transport gate. The legacy contour
  (sidecar / remote Web Client) keeps the real routes. Tests: hooks 31/31
  (+2 kernel-honesty cases), full web vitest green, eslint/typecheck/
  prettier clean, ui:api:check 53, gates GATE PASS.

- **Auth hooks are honest on the kernel plane (M5 slice 23, ARC-02).**
  `useAuthSession` / `useLogin` / `useLogout` hit the legacy
  `/api/v2/auth/session` surface on EVERY backend — on the kernel plane the
  AuthGate hung on a useless network call to a dead route. Now the
  transport gate lives in the hooks: `useAuthSession` resolves the honest
  local session `{ required: false, authenticated: true }` (the kernel
  transport — Tauri IPC / local — has no remote-token session layer; auth
  applies only to non-loopback legacy exposure, ТЗ §11.3), and login/logout
  reject with a typed `UnsupportedError` (honest CAPABILITY_UNAVAILABLE) —
  never a silent legacy request from kernel mode (ARC-02). Kernel Desktop no
  longer renders the remote-token form. The legacy contour (sidecar /
  remote Web Client) keeps the real routes. Tests: hooks 29/29 (+3
  kernel-honesty cases), full web vitest green, eslint/typecheck/prettier
  clean, ui:api:check 53, gates GATE PASS.

- **Remaining legacy hooks are honest on the kernel plane (M5 slice 22,
  ARC-02).** Seven hooks still hit the legacy surface on EVERY backend:
  `useReorderChats`, `usePromptContextAudit`, `useInstructFormats`,
  `useAnalyzeSillyTavern`, `useExecuteSillyTavernImport` and
  `useDiscardSillyTavernAnalysis`. Now the transport gate lives in the
  hooks: `useReorderChats` / `usePromptContextAudit` / the SillyTavern
  import triplet reject with a typed `UnsupportedError` (the wire contract
  has no reorder op, the kernel exposes `generation.prompt.plan` with a
  different contract, and SillyTavern archive import is a legacy sidecar
  staged analyze/execute contour — honest CAPABILITY_UNAVAILABLE, ТЗ
  §13.1), and `useInstructFormats` resolves an honest empty catalog (the
  kernel pipeline owns its own rendering). Never a silent legacy request
  from kernel mode (ARC-02). The legacy contour (sidecar / remote Web
  Client) keeps the real routes. Tests: hooks 26/26 (+7 kernel-honesty
  cases), full web vitest green, eslint/typecheck/prettier clean,
  ui:api:check 53, gates GATE PASS.

- **Character gallery hooks are honest on the kernel plane (M5 slice 21,
  ARC-02).** `useCharacterGallery` / `useUploadCharacterImage` /
  `useDeleteCharacterImage` hit the legacy `/api/v2/characters/:id/gallery`
  surface on EVERY backend. Now the transport gate lives in the hooks:
  `useCharacterGallery` resolves an honest empty list (the gallery is a
  legacy image contour, `data/images/characters/<id>/` sidecar-owned; the
  kernel models character images only as content-addressed `assets.put`
  records, ТЗ §13.1), and upload/delete reject with a typed
  `UnsupportedError` (honest CAPABILITY_UNAVAILABLE) — never a silent
  legacy request from kernel mode (ARC-02). Kernel avatars keep their own
  path (`useUploadCharacterAvatar` → `assets.put` +
  `characters.update(avatarAssetId)`). The legacy contour (sidecar / remote
  Web Client) keeps the real routes. Tests: hooks 19/19 (+4 kernel-honesty
  cases: empty gallery without fetch, upload/delete UnsupportedError,
  legacy fetch unchanged), full web vitest green, eslint/typecheck/prettier
  clean, ui:api:check 53, gates GATE PASS.

- **Backgrounds hooks are honest on the kernel plane (M5 slice 20, ARC-02).**
  `useBackgrounds` / `useUploadBackground` / `useDeleteBackground` hit the
  legacy `/api/v2/backgrounds` surface on EVERY backend — on the kernel
  plane useless network calls to a dead route. Now the transport gate lives
  in the hooks: `useBackgrounds` resolves an honest empty list (the
  wallpaper catalog is a legacy filesystem contour, `data/files/backgrounds/`
  sidecar-owned; the kernel owns no backgrounds capability, ТЗ §13.1), and
  upload/delete reject with a typed `UnsupportedError` (honest
  CAPABILITY_UNAVAILABLE) — never a silent legacy request from kernel mode
  (ARC-02). Applying a background was already kernel-honest (`updateChat`
  throws for `backgroundId`, М5 slice 3), so the panel degrades gracefully:
  empty catalog, localized error on upload/apply. The legacy contour
  (sidecar / remote Web Client) keeps the real routes. Tests: hooks 15/15
  (+4 kernel-honesty cases: empty list without fetch, upload/delete
  UnsupportedError, legacy fetch unchanged), full web vitest green,
  eslint/typecheck/prettier clean, ui:api:check 53, gates GATE PASS.

- **Backup hooks are honest on the kernel plane (M5 slice 19, ARC-02).**
  `useBackups` / `useCreateBackup` / `useRestoreBackup` consulted the legacy
  `/api/v2/backups` surface on EVERY backend — on the kernel plane that meant
  useless network calls to a dead legacy route. Now the transport gate lives
  in the hooks: `useBackups` maps the wire `backups.list` result (createdAt
  RFC3339 → epoch ms; `kind` maps to the honest `'manual'` — the kernel
  models no auto/manual split and every kernel backup is user-initiated
  `backups.create`), `useCreateBackup` calls the wire op, and
  `useRestoreBackup` rejects with a typed `UnsupportedError` (restore is the
  maintenance-lock operation, ТЗ §10.4 — no wire restore op yet, honest
  CAPABILITY_UNAVAILABLE) — never a silent legacy request from kernel mode
  (ARC-02). The legacy contour (sidecar / remote Web Client) keeps the real
  routes. Tests: hooks 11/11 (+4 kernel-honesty cases: wire list mapping
  without fetch, wire create without fetch, restore UnsupportedError, legacy
  fetch unchanged), full web vitest green, eslint/typecheck/prettier clean,
  ui:api:check 53, gates GATE PASS.

- **New Product Wire op `themes.deactivate` — clear the active theme
  (M5 slice 18).** The wire contract previously had no way to stop applying
  a theme on the kernel plane: `resetActiveTheme` was an honest
  `UnsupportedError` (legacy `DELETE /themes/active` had no kernel
  equivalent). The new op clears the single `active` flag — idempotent, no
  active theme is a successful no-op — and the shell falls back to the
  default theme (AGENTS.md §19), distinct from `themes.uninstall` which also
  removes the row. Contract → kernel → facade → web transport, full
  vertical: `themes.deactivate` (empty request/result, app.write, 88 ops
  total, new schema hash `501fa37f…`), kernel handler in `themes.rs`
  (transactional UPDATE, idempotent), `ThemesApi.deactivate` on
  Local/Remote/Legacy backends, and the web `resetActiveTheme` kernel branch
  now calls the op and reports the truthful `activeThemeId: null` (the
  legacy contour keeps `DELETE /themes/active`). Tests: kernel_themes 6/6
  (+1 deactivate round-trip + idempotency), wire.test 88 ops, wireBridge
  (+1 deactivate routing), neobackend 69/69, full web vitest green,
  contracts:check/codegen clean, eslint/typecheck/prettier clean,
  ui:api:check 53, docs:check + gates GATE PASS.

- **Diagnostics hooks are honest on the kernel plane (M5 slice 17,
  ARC-02).** `useDiagnostics`, `useRebuildSearch` and
  `useClearDiagnosticCache` consulted the legacy `/api/v2` surface on EVERY
  backend — on the kernel plane that meant useless network calls to a dead
  legacy route (the kernel has no legacy `DiagnosticsSnapshot`, search-rebuild
  or diagnostic-cache routes). Now the transport gate lives in the hooks:
  `useDiagnostics` resolves `null` without a network call on the kernel (the
  DiagnosticsPanel maps the kernel bundle via `useKernelDiagnostics`
  instead), and the two maintenance mutations reject with a typed
  `UnsupportedError` (honest CAPABILITY_UNAVAILABLE, ТЗ §13.1) — never a
  silent legacy request from kernel mode (ARC-02). The legacy contour
  (sidecar / remote Web Client) keeps the real routes; the DiagnosticsPanel
  already disables the maintenance actions in kernel mode. Tests: hooks 7/7
  (+4 kernel-honesty cases: no fetch on kernel, UnsupportedError for both
  mutations), full web vitest green, eslint/typecheck/prettier clean,
  ui:api:check 53, gates GATE PASS.

- **Legacy extension-settings bridge moved behind a transport module
  (M5 slice 16, ARC-03).** The last production component holding
  `legacyRaw()` — `LegacyBridgeSync.tsx` (the documented
  `window.extension_settings` SillyTavern plugin contour, ТЗ §14) — now goes
  through `api/legacyExtensionSettings.ts`, the same transport pattern as
  `wireBridge.ts`. On the legacy contour (sidecar / remote Web Client) the
  module keeps the real `GET /legacy/extension-settings` /
  `PATCH /legacy/extension-settings/:namespace` store. On the kernel plane it
  is an honest empty no-op: the kernel has no legacy extension-settings
  store (a feature-frozen legacy `app.db` keyspace, ADR-0038), so plugins
  keep session-local settings through the bridge and nothing opens a legacy
  call from kernel mode (ARC-02). No production component carries
  `legacyRaw()` or `/api/v2` literals anymore (scanner + ESLint gate green);
  the 3 component sites moved to the tracked transport table
  (`ui-legacy-surface.md`, same M4 sidecar-removal deadline). Tests:
  legacyExtensionSettings 5/5 (+ kernel no-op cases), events 15/15, full web
  vitest green, eslint/typecheck/prettier clean, ui:api:check 53, gates GATE
  PASS.

- **`connectAppEvents` is an honest no-op on the kernel plane (M5 slice 15,
  ARC-02 kernel-mode truthfulness).** The app-level SSE subscriber
  (`GET /api/v2/events`) existed to invalidate TanStack Query caches on
  backend-driven changes (other tabs, the legacy bridge, server plugins).
  In kernel mode that channel does not exist — the kernel is the single
  writer and every mutation flows through the same in-process query caches —
  so the subscriber silently opened `/api/v2/events` anyway (a direct legacy
  call from kernel mode, ARC-02). `connectAppEvents` now returns a no-op
  teardown on the kernel plane (ТЗ §13.1: never silently touch the other
  backend) and keeps the real stream on the legacy contour (sidecar / remote
  Web Client). Tests: events 15/15 (+1 kernel no-op: no EventSource is
  constructed, teardown is safe), full web vitest green.

- **Kernel chat snapshots (checkpoint/branch) — `chats.snapshots.create`
  (M5 slice 14, Этап 4 context 5 closure).** The canonical Conversations
  model (ТЗ §8.1) now owns the snapshot capability instead of refusing it: a
  new wire operation (87 ops, schema hash `0ab89557…`) freezes the chat
  prefix up to and including the source message into a fresh child chat
  (schema migration 018: `chats.parent_chat_id`/`origin`/`source_message_id`
  trio + `messages.checkpoint_chat_id`). Swipe variants and content revisions
  are copied with remapped ids, `meta_json` survives verbatim, and
  `kind = checkpoint` links the source message (`MessageDto.checkpointChatId`)
  — which the UI's "open checkpoint" now reads on both planes. Additive wire
  fields: `MessageDto.checkpointChatId`, `ChatDto.parentChatId/origin/
  sourceMessageId`, `UpdateMessageRequestDto.clearCheckpointChatId` (honest
  wire spelling of the legacy delete-checkpoint `null` patch — the wire has
  no nullable field). ChatPage `createSnapshot` routes through the wire on
  the kernel plane (slice 13 removed the last `legacyRaw`; slice 14 replaced
  the `UnsupportedError` with the real op), and `deleteCheckpoint` now clears
  the real link instead of writing extension metadata. Kernel tests:
  checkpoint/branch round trip (prefix freeze, child provenance, checkpoint
  link, branch does not overwrite the link, CHAT/MESSAGE_NOT_FOUND) +
  clear-checkpoint-link update — kernel_crud 20/20; runtime-kernel suite
  green. Web: wireBridge 96/96 (+1 kernel snapshot routing test), neobackend
  69/69 (facade `chats.createSnapshot` on Local/Remote, legacy contour keeps
  its full snapshot flow), full web vitest green; ui:api:check stays at 54
  sites. Capability matrix: +1 row (`chats.snapshots`, 35 rows).

- **Chat snapshots route through the transport; ChatPage is free of
  `legacyRaw` (M5 slice 13, Этап 4 context 5 part).** `createChatSnapshot`
  in `wireBridge` replaces the last `legacyRaw()` call in `ChatPage`
  (checkpoint/branch snapshot creation): the legacy plane keeps the real
  snapshot flow via `/chats/:id/snapshots` (new child chat + prefix copy +
  checkpoint link), the kernel plane refuses honestly with
  `UnsupportedError('chats.snapshots.create')` — the canonical Conversations
  model (ТЗ §8.1) has no snapshot/checkpoint entity and no wire operation,
  so the UI shows the localized CAPABILITY_UNAVAILABLE instead of a fake
  result. ui:api:check drops to 54 sites (ChatPage legacyRaw import +
  createSnapshot gone, wireBridge +1 transport site). Tests: wireBridge 96/96
  (+2 snapshot tests: kernel refusal + legacy routing with fetch stub), web
  typecheck clean.

- **Wallpaper URLs leave the components (M5 slice 12, Этап 4 context 5
  part).** `wallpaperBackgroundUrl(backgroundId)` in `wireBridge` replaces
  the inline `/api/v2/assets/backgrounds/:id` literals in `ChatPage` and
  `HomePage`: the legacy plane keeps the asset-route URL (transport detail),
  the kernel plane honestly returns `null` — backgrounds are a legacy file
  contour with no kernel store, so the wallpaper simply does not render
  instead of fabricating a URL. ui:api:check drops to 56 sites (two
  component sites gone, one transport site tracked). Tests: wireBridge 95/95
  (+1 wallpaper routing test), web typecheck clean.

- **Message metadata rides the wire; edit flows leave the legacy surface
  (M5 slice 11, Этап 4 context 5 part).** Wire `chats.messages.update` now
  accepts optional `content` and `meta` (a new `wire.free-object` schema) and
  `MessageDto` carries `meta` verbatim, backed by storage migration v17
  (`messages.meta_json`, `ALTER TABLE` + fresh-schema concat, ledger
  checksum); the kernel persists meta-only and content+meta edits (content
  revisions unchanged) and returns meta on every message projection
  (create/list/update). `updateChatMessage(chatId, messageId, patch)` in
  `wireBridge` routes toggleMessageContext / swipeGreeting / deleteCheckpoint
  on `ChatPage` through the transport on both planes (kernel
  `chats.messages.update` → translated with meta carried; legacy partial
  PATCH kept), so those three component sites leave the legacy surface:
  ui:api:check drops to 57 sites. createSnapshot and the checkpoint
  navigation stay legacy-documented (no wire snapshot op yet); kernel
  `MessageDto` still carries no checkpoint id, so deleteCheckpoint writes
  `meta.checkpointChatId: null` on the kernel plane. Wire schema hash
  `9bd67389…`, codegen regenerated, generated Rust rebuilt. Tests: wireBridge
  94/94 (+3 meta patch tests), kernel messages meta round trip in
  `kernel_crud`, storage migration ledger v17, web vitest 644/644, web
  typecheck clean.

- **Legacy bridge `sendChatMessage` routes through the Product Wire transport
  (M5 slice 10, Этап 4 context 5 part).** `createBridgeChatMessage(chatId,
  text)` in `wireBridge` replaces the `legacyRaw()` POST in
  `LegacyBridgeSync`: the kernel plane creates the message via wire
  `chats.messages.create` and returns the lean `MessageDto` projected onto
  the documented `BridgeChatMessage` surface (id/chatId/role/content +
  createdAt — RFC3339 on the kernel plane vs epoch-ms on the legacy plane,
  never fabricated); the legacy plane keeps the full legacy message.
  ui:api:check drops to 60 sites. Remaining legacy-bridge calls are
  extension-settings reads/writes — a plugin-facing legacy contour, not
  product UI. Tests: wireBridge 91/91 (+1 bridge test).

- **Provider model discovery moves out of the component; kernel diagnostics
  are shown honestly (M5 slice 9, Этап 4 contexts 4/7 part).**
  `AutoConnectSync` no longer calls `legacyRaw()` (ARC-03): the warm-up now
  routes through `warmProviderModels(providerId)` in `wireBridge`, which
  throws `UnsupportedError('providers.models.discovery')` on the kernel plane
  (model discovery is a kernel-side capability with no wire operation yet)
  and keeps the legacy `/providers/:id/models` read on the legacy plane;
  the optional warm-up failure is ignored as before. ui:api:check drops to 61
  sites (two component sites gone). The diagnostics panel now maps the kernel
  `diagnostics.export` SEC-07 allowlist bundle honestly: schema revision +
  hash prefix, storage format, SQLite version, stored-settings count and
  generation-run totals appear in the kernel section (browser does not get
  the bundle, so the legacy snapshot section stays untouched there), and in
  kernel mode the search-index/cache maintenance buttons are disabled with an
  explicit explanation that those are legacy-sidecar actions with no kernel
  equivalent — no fabricated legacy fields. Tests: wireBridge 91/91 (+1
  refusal).

- **Imports/exports report CAPABILITY_UNAVAILABLE honestly (M5 slice 8,
  Этап 4 context 5 part).** `exportCharacterCard`/`exportChat`/`importCharacter`
  in `wireBridge` route through the transport: on the legacy plane they keep
  the download/upload behaviour (downloads now trigger programmatically), on
  the kernel plane they throw `UnsupportedError` (card containers and card
  parsing have no wire operation). `useErrorText` now localizes
  `UnsupportedError` via the new `errors:UNSUPPORTED` string (en/ru) with the
  feature name instead of degrading to INTERNAL — every honest refusal
  (themes install, plugins install, imports/exports) is now user-visible.
  `useImportCharacter` routes through the transport. ExportMenu and the chat
  export menu item became buttons that surface the refusal. ui:api:check 63
  sites (the two character-export sites moved into the wireBridge migration
  routing table; the chat-export site is gone). Tests: wireBridge 90/90 (+3
  refusals), useErrorText 2/2.

- **Settings reach the kernel plane (M5 slice 7 part 2, Этап 4 context 7).**
  `readSettings`/`updateSettings` in `wireBridge` map the typed
  `AppSettings` projection onto the canonical wire `settings.get`/`update`
  store: `AppSettings` camelCase fields map to wire-valid kebab keys
  (`maxContextTokens` → `max-context-tokens`, `extensions.legacyFrontend` →
  `extensions.legacy-frontend`), scalar preferences round-trip in the
  documented `{ "value": X }` wire form, and the legacy `PATCH /settings`
  post-update snapshot contract is preserved. Kernel: `settings.get` now
  wraps non-object stored values (legacy bare scalars) in the wire form, and
  the legacy converter normalizes camelCase settings keys to kebab form so
  converted stores stay wire-readable — both edges verified by new kernel
  tests. `useSettings`/`useUpdateSettings` now route through the transport
  (this also moves the AutoConnectSync last-server/auto-connect writes onto
  the kernel plane). Tests: wireBridge 86/86 (+3 settings), kernel settings
  suite 5/5, legacy conversion 2/2.

- **App version reads the kernel wire metadata (M5 slice 7 part 1, Этап 4
  context 7 start).** `readAppVersion` in `wireBridge` maps `meta.get`
  (app version + API major) onto the legacy `VersionResponse`; the static
  product name is identity (the UI renders only the version string), never
  fabricated data. `useAppVersion` now goes through the transport. Tests:
  wireBridge 83/83 (+1 meta mapping).

- **Plugins reach the kernel plane (M5 slice 6 part 4, Этап 4 context 6,
  ТЗ §SEC-05/§SEC-06).** `readPlugins`/`activatePlugin`/`disablePlugin`/
  `deletePlugin` in `wireBridge` call the wire `plugins.*` operations and
  map the durable record (trust state + granted permission set, both fixed
  at the install consent moment) onto the legacy `InstalledPlugin` shape
  with honest neutral fields for what the wire row does not model
  (apiVersion, frontend/backend presence, SDK compatibility level).
  Activation applies the recorded permissions; requesting a different
  permission set is an honest `CAPABILITY_UNAVAILABLE` rather than
  silently enabling with different rights. Flows that need the host
  package verifier or the plugin executor (package install, git install,
  runtime safe mode, OAuth auth connections) are honest refusals — never
  a silent skip of SEC-05 verification or SEC-06 cleanup. All ten plugin
  hooks now go through the transport. ui:api:check stays 64 sites (the
  plugin routes were already parameterized through the client base). Tests:
  wireBridge 82/82 (+6 plugins: list translation, error status, matching
  activation, permission-change refusal, disable/delete, host/executor
  refusals).

- **Themes reach the kernel plane (M5 slice 6 part 3, Этап 4 context 6,
  ТЗ §5.2 theme-sdk).** `readThemes`/`activateTheme`/`deleteTheme` in
  `wireBridge` call the wire `themes.*` operations and map the durable
  theme row (opaque manifest + content-addressed `cssAssetId`) onto the
  legacy `InstalledTheme` shape, resolving the CSS asset to a `data:` URI
  so the shell keeps loading it through the plain `componentsCssUrl` slot.
  The web transport honestly reports `CAPABILITY_UNAVAILABLE` where the
  wire contract cannot express the legacy flow: theme-package install
  needs host-side SEC-05 verification before `themes.install`, and
  clearing the active theme has no deactivate op. Theme-owned settings
  (`readThemeSettings`) and the user stylesheet (`userCssUrl`) moved from
  direct `fetch` in ThemeSync into transport helpers — the kernel plane
  reports none (the wire contract does not model them yet) so the theme
  applies its defaults. ui:api:check stays 64 sites: the two ThemeSync
  sites moved into the transport layer. Tests: wireBridge 76/76 (+6
  themes: list/active-id resolution, honest css-read degradation, activate,
  delete truthfulness, install/reset refusal, settings/user.css kernel
  emptiness).

- **Kernel avatar upload (M5 slice 6 remainder web, ТЗ §34 avatar→asset).**
  The character editor can now set an avatar on the kernel plane: the new
  `uploadCharacterAvatar` transport helper publishes the file as an
  immutable `avatar` asset (`assets.put`, content-addressed + idempotent)
  and links it through `characters.update(avatarAssetId)`; the legacy plane
  keeps the gallery upload path. `updateCharacter` forwards a non-null
  `avatarAssetId` to the wire patch, and `CharacterCreate`/`CharacterUpdate`
  gained the additive optional `avatarAssetId` field. The wire `assets.put`
  request cap (~786 KiB of image bytes) surfaces as a transport error —
  never a silent downgrade. Tests: wireBridge kernel publish+link round
  trip and avatarAssetId patch forwarding (70/70).

- **SEC-02 per-profile export scoping declared delivered (ADR-0047
  waiver 4).** The canonical schema (profiles v14 + `characters.profile_id`
  v15), the profile-scoped kernel export (characters → chats → messages
  transitively, container verification cross-checks profile references),
  the `profiles.*` wire surface and the facade `ProfilesApi.export(profileId)`
  were already shipped; the ledger now records waiver 4 as honored (the
  remaining UI profile picker is a host-side follow-up).

- **Legacy settings convert into the canonical settings store (M5 slice 6
  remainder, ADR-0046 waiver 8 settings part).** The legacy converter now
  maps the legacy `settings` table (`key → value` JSON text) into the kernel
  `settings` table verbatim; a non-JSON legacy value is preserved as a JSON
  string (fail-closed — no setting is silently dropped) and each row carries
  the conversion timestamp. `ConversionReport.settings` and the committed
  migration report count the rows. Branches are resolved as a documented
  limitation: the legacy `messages.branch_id` has no kernel equivalent, so
  ALL messages (active and side branches) are preserved flattened into the
  chat sequence — no message data is dropped, branch semantics are not
  reproduced (kernel has no branch entity). Tests: legacy settings round
  trip (object / JSON-string / raw value) + storage suite green.

- **Kernel avatar display surface (M5 slice 6 remainder web, ТЗ §13.1).**
  Characters converted from legacy data (or linked to a canonical asset)
  now render their avatar in the kernel plane: `CharacterSummary`/`Character`
  carry the canonical `avatarAssetId`, and the UI resolves it through the
  new `readAssetContentDataUrl` transport helper (`assets.content` →
  `data:` URI; the legacy plane has no asset store and refuses honestly).
  The legacy avatar-original route moved out of React components into the
  `avatarOriginalUrl` transport helper — components no longer build `/api/v2`
  URLs (ui:api:check product sites 38 → 37). `useAvatarDataUrl` hook keeps
  the resolved bytes in server state. Tests: wireBridge translation +
  asset data-URI round trip + legacy refusal (68/68).

- **Legacy avatar originals convert into canonical assets (M5 slice 6,
  ADR-0046 waiver 8 assets part).** The legacy converter now maps
  `characters.avatar` — a content-addressed URL
  (`/api/v2/assets/avatars/<sha256>.<ext>` or the thumbnail variant) — to
  the original file under `<data-dir>/files/avatars/`, publishes it into the
  canonical asset store as an `avatar` asset (crash-safe publisher, same
  temp-write + sync + atomic-rename contract as `assets.put`) inside the
  conversion transaction, and links `characters.avatar_asset_id`. A missing
  file or an unrecognizable avatar string is reported as an orphan (the
  character stays unlinked — no silent loss), pre-avatar legacy schemas
  contribute 0, and the legacy avatar string itself is still not copied
  verbatim (ТЗ §34 avatar→asset). `ConversionReport.assets` reports the
  converted count. Storage tests: avatar conversion round trip +
  missing-original orphan.

- **Character↔lorebook scoping (M5 slice 6, ADR-0047 waiver 2 closed).**
  The canonical schema now models the character↔lorebook link: migration 016
  adds the STRICT `character_lorebooks` table (one optional owner per book —
  a book is either shared-library or bound to exactly one character).
  `LorebookDto` gained an optional `characterId`; `lorebooks.create/update`
  bind it (unknown character → `CHARACTER_NOT_FOUND`) and
  `lorebooks.list` accepts an optional `characterId` filter. Prompt retrieval
  is scoped by the chat's character while books without a link stay global.
  The legacy converter maps `lorebooks.metadata.characterId` into the
  canonical link (orphaned links are reported, the book stays shared). The
  NeoBackend `LorebooksApi.list` forwards the scoped request (Local/Remote
  parity-tested) and `wireBridge` no longer throws CAPABILITY_UNAVAILABLE
  for scoped lorebook catalogs. Kernel tests: scoping round trip + prompt
  scoping; neobackend parity 69.

- **AssetsApi in the NeoBackend facade (M5 slice 7 remainder web).** The
  facade gained `assets.get`/`assets.content`/`assets.put`/`assets.del` —
  the last Product Wire domain without a facade surface, so every wire
  operation is now reachable through the typed `NeoBackend` (ТЗ §13.1).
  LocalBackend forwards over the kernel transport with request/response
  validation, RemoteBackend forwards over the ClientSdk, LegacyBackend
  throws `UnsupportedError` (the legacy plane has no assets route; avatars
  and backgrounds remain on the legacy-raw path until their own cutover).
  Tests: Local/Remote parity + validation + LegacyBackend unsupported
  (neobackend vitest 68/68).
- **ui:api:check regression fix (ARC-02).** A doc comment in
  `apps/web/src/api/profilesHooks.ts` mentioned `/api/v2` and tripped the
  legacy-surface scanner; the wording was removed and `ui:api:check` is
  green again (65 baseline sites, all carrying owner/removalIssue/milestone).
- **Secret-store status panel (SEC-01.1, M5 slice 7 remainder web).** The
  Settings panel gained a Security tab (`SecretsPanel`) rendering the honest
  value-free store mode from the canonical `secrets.status` DTO via the
  NeoBackend facade (LocalBackend/RemoteBackend forward, LegacyBackend
  throws `UnsupportedError` — parity-tested). The panel shows the explicit
  SEC-01.1 mode — portable encrypted (`secrets.enc` + format version),
  machine-bound environment, session-only, or the fail-closed unavailable
  state — plus persistent/writable/available flags and the record count,
  wired through `useSecretsStatus`. There is no reveal operation by design:
  the panel states that values never leave the store. i18n en/ru.
  Tests: SecretsPanel component tests (portable + unavailable modes);
  web vitest 612/612.
- **Profiles UI + facade export (M5 slice 5 remainder web).** The NeoBackend
  facade now covers the full Configuration profile surface: `profiles.export`
  was added to `ProfilesApi` (LocalBackend forwards `profile.export` over the
  kernel transport, RemoteBackend over ClientSdk, LegacyBackend throws
  `UnsupportedError` — the legacy plane must never fake a canonical
  capability, ТЗ §13.1), and the Settings panel gained a Profiles tab:
  list/create/rename/delete with confirmation plus a per-profile scoped
  export action wired through TanStack Query hooks (`useProfiles`,
  `useCreateProfile`, `useRenameProfile`, `useDeleteProfile`,
  `useProfileExport`). The export action calls `profile.export` with the
  profile's `profileId`, so the produced container carries only that
  profile's characters and their chats/messages (lorebooks and presets are
  always the shared library, SEC-02, ADR-0047 waiver 4) and reports the
  per-section counts. `PROFILE_NOT_FOUND` error text added to i18n (en/ru).
  Tests: facade parity (`profile.export` scoped/unscoped forwarding +
  deep-equal Local/Remote, LegacyBackend UnsupportedError), ProfilesPanel
  component tests (list, create, export, delete-with-confirm). Web vitest
  610/610.
- **Per-profile scoped profile export (SEC-02, ADR-0047 waiver 4, M5 slice 5
  remainder, schema v15).** The canonical Configuration profiles model now
  binds the character library: schema v15 adds the nullable `profile_id` FK
  on `characters` (`ON DELETE SET NULL` — deleting a profile keeps the
  characters, they just become unassigned) plus a backing index; wire
  `characters.create`/`characters.update` accept an optional `profileId`
  (an explicitly named profile must exist, else `PROFILE_NOT_FOUND` with the
  `profileId` param) and `CharacterDto` carries it back.
  `profile.export` accepts an optional `profileId` (wire request/result DTOs
  extended, result echoes the scope): a scoped container carries only that
  profile's characters and, transitively, their chats and messages — the
  manifest records `profileId`; lorebooks and presets are the shared library
  and always included in full. An unknown profile id is rejected with
  `PROFILE_NOT_FOUND` before any container directory is created. Import
  preserves a binding only when the profile already exists in the target;
  otherwise the character lands unassigned (NULL) and is reported in
  `ImportReport::orphans` — data is never dropped for a missing binding.
  Storage export tests (scoped filtering + manifest marker + import binding
  preservation/unassignment) and kernel tests (scoped export echoes the
  scope and filters by profile, rebind via update, unknown-profile
  `PROFILE_NOT_FOUND`, `characters.create` rejects an unknown profile) prove
  the behavior. Full `cargo test --workspace` now green, including the
  contract corpus (see CI fixes below).
- **CI fixes surfaced by an independent verification (all were real
  merge-blockers on the branch).**
  1. `crates/contracts-generated/tests/wire_corpus.rs` covered only 115 of
     the 124 schemaIds in the canonical corpus — the 33 assets/plugins/
     themes/profiles/settings/diagnostics/secrets/profile-export decoders
     were missing from the dispatch match, which made the real CI job
     `cargo test --workspace` (ci.yml contracts-rust) fail. All 33 arms now
     resolve to their generated decoders; the corpus test passes.
  2. `--st-color-border-subtle` was used in `AiSettings.module.css` but not
     part of the canonical theme-sdk token set, failing the token-contract
     test. The token is now canonical: added to `TOKEN_NAMES`,
     `DEFAULT_LIGHT_TOKENS`/`DEFAULT_DARK_TOKENS` and the `tokens.css`
     light/dark/`prefers-color-scheme` blocks (theme-sdk 45/45).
  3. `docs:sync:check` was out of date (the committed mirror missed the
     capability-matrix changes of the profiles slice). Resynced 70 mirrored
     files; `docs:sync:check` passes.
- **NeoBackend facade for the canonical kernel domains (M5 web-facade
  foundation, ТЗ §15/§13.1).** The single UI-facing surface now covers
  `plugins` (list/install/uninstall/enable/disable — SEC-05 trust +
  granted-permission consent), `themes` (list/install/uninstall/activate —
  CSS as content-addressed asset, single active theme), `profiles`
  (list/create/rename/delete — Configuration bounded context), `settings`
  (get/update — non-secret JSON upserts), `diagnostics` (export — SEC-07
  redacted allowlist bundle) and `secrets` (status — SEC-01.1 value-free
  store-mode report). Implemented in `LocalBackend` (kernel transport with
  per-request schema validation) and `RemoteBackend` (SDK delegation);
  `LegacyBackend` throws `UnsupportedError` for every one of them — the
  legacy plane must never fake a canonical capability (ТЗ §13.1), it stays
  an explicit temporary bridge. 11 new parity tests
  (`packages/neobackend/test/parity.test.ts`): Local/Remote deep-equal
  results + exact payload forwarding for all six domains, outbound
  `ValidationError` before any transport call, legacy `UnsupportedError`;
  the pre-existing providers fixture gained the required
  `capabilities` declaration (ТЗ §9.3). 65/65 neobackend tests; README
  updated.
- **Canonical Configuration profiles (ТЗ §8.1 Configuration, M5 slice 5
  remainder part 2).** Schema v14 (STRICT `profiles` table) + four new wire
  operations (86 total): `profiles.list` / `profiles.create` /
  `profiles.rename` / `profiles.delete`. Mirrors the legacy minimal shape
  (`profiles.id/name/created_at`) plus `updated_at` for renames; a profile
  row is a named user context and nothing references it yet. This model
  unblocks the per-profile FK columns on product tables and the SEC-02
  per-profile export filtering (ADR-0047 waiver 4) — the slice-5 remainder
  follow-up. Fail-closed: rename/delete of an unknown profile is the stable
  `PROFILE_NOT_FOUND` product code with a `profileId` param; wire
  validation rejects empty names, non-uuid ids and unknown fields. 3 kernel
  tests (`kernel_profiles.rs`). New capability row `ui.profiles` in the
  matrix; 33 rows.
- **Canonical Theme-SDK registry (ТЗ §5.2 theme-sdk, §SEC-05, AGENTS.md
  §19, M5 slice 6 part 2).** Schema v13 (STRICT `themes` table) + four new
  wire operations (82 total): `themes.list` / `themes.install` /
  `themes.uninstall` / `themes.activate`. A theme is DATA, never code: the
  opaque manifest plus a content-addressed CSS asset reference
  (`cssAssetId` published through `assets.put` with kind `theme-css`,
  existence validated by the kernel at install — the table holds no CSS
  bytes, no chats access and no keys). The single `active` flag names the
  applied theme; uninstalling the ACTIVE theme clears it so the shell falls
  back to the default (a broken theme must never block the interface
  reset). Fail-closed rules mirror plugins: a version change that would
  LOWER the recorded SEC-05 trust rank is rejected with the stable
  `THEME_TRUST_DOWNGRADE` product code, same id+version re-install is
  idempotent, install never activates (activation is an explicit separate
  consent), uninstall/activate of an unknown theme is `THEME_NOT_FOUND`.
  5 kernel tests (`kernel_themes.rs`); the diagnostics `schemaRevision`
  assertion now reads `neotavern_storage::CURRENT_SCHEMA` instead of a
  hard-coded revision. Capability matrix `ui.themes` updated (wireOps +
  notes); legacy theme routes and the Theme SDK v1 translation remain
  slice 6 part 3.
- **Canonical Extensions-context registry (ТЗ §8.1 Extensions, §SEC-05,
  ARC-08, M5 slice 6 part 1).** Schema v12 (STRICT `plugins` table) + five
  new wire operations (78 total): `plugins.list` /
  `plugins.install` / `plugins.uninstall` / `plugins.enable` /
  `plugins.disable`. The kernel durably records what the host ALREADY
  verified (SEC-05 signature + per-file digest + ZIP traversal/symlink/
  bomb rejection stays in the legacy host `packageTrust.ts`) and what the
  user consented to: version, trust state (`built-in` /
  `verified-publisher` / `locally-trusted` / `unsigned-untrusted`),
  publisher key fingerprint and the GRANTED permission set — the
  install/update request IS the consent moment. Fail-closed: an install
  that would LOWER the recorded trust rank is rejected with the stable
  `PLUGIN_TRUST_DOWNGRADE` product code (an unsigned package can never
  silently replace a verified one), same id+version re-install is
  idempotent, enable/disable are idempotent flag transitions, uninstall
  of an unknown plugin is `PLUGIN_NOT_FOUND`. The table holds NO code,
  NO secrets and NO runtime handles — execution and cleanup (SEC-06) live
  in the isolated host executor behind the versioned capability protocol
  (ТЗ §14.1). 4 kernel tests (`kernel_plugins.rs`). Capability matrix
  `ui.plugins` updated (wireOps + notes); themes and the legacy ST v1
  translation remain slice 6 parts 2–3.
- **Canonical content-addressed AssetStore (ТЗ §5.1, AGENTS.md §11/§12, M5
  slice 5 remainder).** Four new wire operations (73 total) over the
  crash-safe `neotavern_storage::assets` publisher: `assets.put` publishes
  immutable bytes under a content-derived managed key
  `<kind>/<sha256>[.<ext>]` and is an **idempotent re-import** — identical
  bytes under the same kind return the existing record with
  `deduplicated: true` (no duplicate); `assets.get` returns metadata;
  `assets.content` returns the ORIGINAL bytes (base64, never lossy; the
  4 MiB wire response limit caps the servable size); `assets.delete`
  removes the registry row first (orphan GC reclaims the file). Avatar
  linkage is now writable: `characters.create`/`characters.update` accept
  `avatarAssetId` and the kernel verifies the asset exists (stable
  `ASSET_NOT_FOUND` product code; 3 new character fixtures + 1 negative).
  Kernel tests (`kernel_assets.rs`, 5): put/get/content round-trip with
  the file verified on disk, idempotent re-import (same bytes → same id,
  deduplicated; different kind/bytes → distinct), character avatar
  linkage round-trip + missing-asset rejection, delete → not-found, and
  wire validation (bad base64, uppercase kind). Thumbnail cache
  GENERATION stays the web/legacy side (canonical plane has no image
  codec dependency by design); the key contract is documented in the
  release manifest. Capability matrix row `library.assets` added.
- **Value-free secret-backend surface `secrets.status` (SEC-01.1, M5 slice
  7).** New wire operation (69 total) `secrets.status`
  (`wire.result.secrets-status`) reports the explicit secret-store MODE
  without ever invoking `get`: kind `portable` (encrypted `secrets.enc` with
  its formatVersion), `env`, `session` (session-only) or `unavailable`,
  plus persistent/writable/available flags and the record count. The UI
  renders the honest SEC-01.1 state (portable encrypted / machine-bound /
  session-only / fail-closed unavailable) from this DTO; a value cannot
  cross it. Kernel tests (`kernel_secrets_status.rs`, 3): unavailable
  without a store, session-mode reporting with a sentinel value proven
  absent from the response bytes, and a REAL portable store (create +
  put) reporting kind portable + formatVersion 2. Capability matrix rows
  updated (ui.secrets, ui.portable-data).
- **Canonical non-secret settings + SEC-07 diagnostics export (ТЗ §8.1,
  §15, M5 slice 7).** Two new wire operations — `settings.get` /
  `settings.update` (`wire.request.settings.get` / `wire.request.settings.update`
  / `wire.result.settings`, capability `settings`) backed by the STRICT
  `settings` table (schema migration 11, `CURRENT_SCHEMA` 11): a key →
  JSON-object store; `settings.update` is a transactional upsert returning
  the post-update snapshot, `settings.get` reads a key subset or all keys.
  Secrets never live here — provider keys stay in the SecretStore (ТЗ §9.4).
  `diagnostics.export` (capability `ui.diagnostics`) returns a redacted
  ALLOWLIST bundle pinned to `redaction: 'allowlist'`: app/wire versions,
  schema hash + revision, storage format, SQLite version, setting count and
  generation-run counters (total/completed/failed/waiting, derived
  waiting-for-tool). Provider configs, secret refs, setting values and
  message content are never read (structural redaction, fail-closed by
  omission). Behavioral proof
  `crates/runtime-kernel/tests/kernel_settings_diagnostics.rs` (4 tests):
  settings round trip incl. idempotent upsert, wire validation, sentinel
  redaction (a sentinel API key + message token never appear in the bundle)
  and run counters. Capability matrix rows updated (ui.diagnostics,
  settings).
- **Provider capability declaration + `CAPABILITY_UNAVAILABLE` pre-negotiation
  (ТЗ §9.3, M5 slice 4).** The provider port (`ProviderAdapter`) now declares
  capabilities (`ProviderCapabilities`: tools/vision/thinking/jsonMode/
  streaming); the OpenAI-compatible adapter declares tools+streaming honestly
  and no vision/thinking/json. `providers.list` surfaces the declaration as
  `wire.provider.capabilities` on every provider DTO. The generation path
  negotiates BEFORE any network request: a run that would send tool calls to
  a provider without tool support terminates durably `failed` with the new
  wire code `CAPABILITY_UNAVAILABLE` (allowed on `generation.start`/`retry`/
  `tool.result`), never a silent no-tools downgrade. Behavioral proof
  `crates/runtime-kernel/tests/kernel_capability_negotiation.rs` (3 tests):
  honest list declarations, fail-before-generate (adapter probe counter
  stays 0), tools-capable pass-through to `waiting_for_tool`. Capability
  matrix rows updated (providers.list, providers.openai, generation.tool-loop).
- **Logical profile export over Product Wire (SEC-02, M5 slice 5).** New wire
  operation `profile.export` (`wire.request.profile-export` /
  `wire.result.profile-export`, capability `ui.profile-export`): the kernel
  builds a fresh, **verified** logical allowlist container under the data
  root's `exports/` via `neotavern_storage::export::create_export` +
  `verify_export` (characters/chats/messages/lorebooks/presets NDJSON +
  optional asset bytes + `manifest.json` written last atomically) and returns
  the report with a data-root-relative `containerPath` and manifest sha256.
  Provider configs and secrets are not export sections by construction; the
  kernel negative test (`kernel_profile_export.rs`) stores a sentinel API key
  through the SecretStore seam and proves it never appears in any container
  byte. `create_export` gains an `include_assets` flag (data-only exports);
  `storage::snapshot::sha256_file_hex` and `storage::paths::exports_dir` are
  now public. Capability matrix `ui.profile-export` updated to `profile.export`
  (Implemented; UI/facade cutover and per-profile FK filtering tracked in M5).
- **Resource containment (plan rev 2.2).** Two halves so pathological fuzz /
  bench inputs can never take the host down again (root cause fixed:
  uncontrolled combined resource pressure from heavy suites without
  process-tree containment — see
  [docs/architecture/resource-containment.md](docs/architecture/resource-containment.md)):
  - **Bounded wire pipeline.** New `PAYLOAD_TOO_LARGE` product error, gated
    BEFORE any parse in `runtime-kernel` dispatch (`dispatch`,
    `dispatch_stream`, `handle_unary`, `stream_start`) using **generated**
    per-operation byte limits (`operation_request_limit` /
    `operation_response_limit` emitted by `codegen.mjs` into
    `generated.rs` from the same registry as `contract-manifest.json`).
    Serialization is now bounded during the write: `product::encode` →
    `LimitedWriter` (`serde_json::to_writer`, stops mid-write past the
    limit) replaces `serde_json::to_vec` in every kernel response path
    (product, providers, providers_config, meta). `remote-http` already
    answered over-limit bodies with 413 before reading; a new behavioral
    test proves 413 arrives without polling the body (declared
    Content-Length 1 MiB, zero body bytes sent).
  - **Spec-first heavy suites.** New `packages/contracts/test/_budget.ts`:
    `assertPayloadSpecCap(spec)` guards a DECLARED spec (never a
    materialized payload) before any builder allocation; hard caps 16 MiB
    payload / 64 MiB batch / depth 1024 / 200k array items / 100k object
    keys. `bench.test.ts` rewritten to run each heavy case in its own
    `node --expose-gc` child (`_bench-child.mjs`) that builds the payload
    inside itself from a small spec over argv — the old in-process
    16 MiB × 50 pattern that crashed the machine is gone. `fuzz.test.ts`
    (fast-check, `SEED=20260815`) pathological payloads now carry spec
    caps; new corpus fixture `neg-request-message-too-large`.
  - **Native process-tree containment.** New `crates/resource-runner`
    (Windows): `CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject`
    (failure → terminate + refuse, never uncontained) → `ResumeThread`;
    two-threshold memory (soft notification limit ~90% → `TerminateJobObject`
    → `RESOURCE_LIMIT`, hard `JOB_OBJECT_LIMIT_JOB_MEMORY` backstop);
    host-headroom gate via `GetPerformanceInfo`
    (`min(configured, available_commit − max(4 GiB, 25% limit))`, exit
    `SKIPPED` below the suite minimum); `ActiveProcessLimit`,
    `KILL_ON_JOB_CLOSE`, wall-clock deadline (`TIMEOUT`), inherited stdout/
    stderr; named-mutex global scheduler (auto-released on owner death);
    `RESOURCE_BUDGET_MODE=contained` fail-safe. JS wrapper
    `scripts/contained-run.mjs` + root scripts `test:contracts:heavy`,
    `test:rust-fuzz:contained`. vitest bounded to `maxWorkers: 2` +
    `--max-old-space-size=2048` (root and `apps/web`); Playwright stays
    `workers: 1`. Behavioral (non-grep) coverage:
    `kernel_payload_gates.rs`, `LimitedWriter` unit tests,
    `generated_limits_vs_manifest.rs`, `budget-guard.test.ts`.
  - **Test-infra fixes surfaced by the contained runs.** The Rust fuzz
    `random_tree` generator was a supercritical branching process (tens of
    GiB on a fixed seed — clipped by the Job Object, proving the cap works);
    it is now hard-bounded to 5k nodes/tree. `wire_corpus.rs` was missing 24
    match arms for presets/memories/drafts/variants schemaIds added in
    earlier slices (a latent failure; the arms and decoder imports are added
    — all 91 corpus schemaIds now resolve). The runner's fail-safe guard is
    extracted into `fail_safe_mode_ok` so its unit test is deterministic in
    any environment (the test binary itself runs inside the runner).
  - New docs page [Resource containment](docs/architecture/resource-containment.md),
    `crates/resource-runner/README.md`, AGENTS.md §23 resource-containment
    rules.

- **Memory settings editor UI (M5 / Этап 4, slice 3).** A new
  `MemoryEditor` tab inside AI settings delivers memory CRUD over the wire
  ops in kernel mode: create/edit content, comma-separated activation keys,
  scope (global / character with a character picker), enabled toggle and
  delete with confirmation. Component tests cover list rendering, create
  through the API and the enabled toggle (2/2). New i18n keys (en/ru).

- **Memory/RAG retrieval into the prompt plan (M5 / Этап 4, slice 3, ТЗ
  §4.4).** The kernel prompt pipeline now injects keyword-activated memory
  blocks between the lorebook stage and the history: rows scoped to the
  chat's character (`global` or `character` matching the chat's character)
  activate when any non-empty `keys` value appears in the user message +
  history tail (honest `memory-keyword-v1` heuristic — the kernel has no FTS
  yet; `memories_fts` stays unconverted and semantic/vector retrieval remains
  a later slice). Disabled rows, other characters' memories and key-less
  notes never activate; blocks are `source: 'memory'` system blocks (new
  member of the `wire.prompt.block` source union), bounded at 1000 rows
  scanned / 24 blocks injected. Wire registry hash updated; test:
  `kernel_persona_application` prompt-plan memory retrieval (5/5).

- **User persona application: `chat.personaId` + prompt `{{user}}` (M5 /
  Этап 4, slice 3, closes ADR-0047 waiver 3).** Schema migration 010 adds
  `chats.persona_id` (FK to `personas`, `ON DELETE SET NULL`);
  `CURRENT_SCHEMA` is now 10. `chats.create` and `chats.update` accept an
  optional `personaId` (stable `PERSONA_NOT_FOUND` with a `personaId` param
  for an unknown reference); `chats.update` no longer requires `title` — an
  empty update is a no-op returning the unchanged chat. The prompt pipeline
  resolves the chat's linked persona name into the plan as `userName` and
  substitutes it for the `{{user}}` macro across the selected history and the
  current input (a chat without a persona passes messages through verbatim;
  the kernel has no global active-persona fallback — documented honest
  boundary). No new wire operations — additive optional fields only
  (`wire.chat.dto.personaId`, `chats.create/update.personaId`,
  `wire.prompt.plan.userName`); registry stays at 64 ops. The legacy converter
  maps `chats.persona_id` (personas convert before chats so the FK holds;
  pre-persona sources convert with NULL) and the facade/wireBridge pass
  `personaId` through for create/update/continue-chat in kernel mode (a `null`
  persona clear is not expressible on the wire → `CAPABILITY_UNAVAILABLE`).
  Tests: kernel `kernel_persona_application.rs` 4/4 (chat linkage round trip,
  `PERSONA_NOT_FOUND`, `ON DELETE SET NULL`, plan `userName` + macro
  substitution, verbatim pass-through), legacy conversion fixture with
  personas + chat persona reference, wire corpus 2 new negative fixtures,
  web wireBridge chat create/update persona tests.

- **Memories + presets CRUD over Product Wire (M5 / Этап 4, slice 3,
  kernel + contract part).** Eight new wire operations — `presets.get`,
  `presets.create`, `presets.update`, `presets.delete` and
  `memories.list/create/update/delete` — plus `presets.list` moving onto the
  filtered `wire.request.list-presets` schema (kind filter); registry
  56 → 64 ops. `presets.create/update` additionally admit `CONFLICT`
  (`PRESET_CONFLICT`, duplicate `(kind,name)`), pre-checked outside the
  transaction. Schema migration 009 adds `presets.kind` with the unique
  `(kind,name)` index and the STRICT `memories` table
  (scope global|character, keys, content, enabled, position, metadata);
  `CURRENT_SCHEMA` is now 9. The kernel selects back every write through the
  wire validators; error params follow the wire truth
  (`presetId`/`memoryId`, `PRESET_CONFLICT` → Conflict class). The wire DTOs
  keep free-form `data`/`metadata` as `additionalProperties: true` objects
  (never `Type.Unknown()` — wire-safety rules) and characterId optional
  (no null unions). Tests: kernel `kernel_memories_presets.rs`
  (preset CRUD round-trip + conflict/error paths, memory CRUD round-trip +
  error paths), wire corpus (8 positive + 4 negative fixtures), contracts
  wire suite 15/15.

- **Legacy converter: memories + presets (M5 / Этап 4, slice 3).** The
  legacy `app.db` converter now maps the optional `presets` table
  (kind/name/data → kind/name/settings_json; kinds violating the wire
  pattern are skipped and reported) and the `memories` table (scope
  validated, keys/content/enabled/position/metadata copied, dangling
  `character_id` preserved — the kernel memories table has no FK by design;
  `memories_fts` is not converted, the kernel retrieval stage is a later
  slice). Per-table counts were added to the conversion report
  (`presets`/`memories`) and to the CLI migrate output line.

- **Facade + wireBridge for memories/presets (M5 / Этап 4, slice 3).**
  `NeoBackend.PresetsApi` gains `get/create/update/del`, `NeoBackend` gains
  `MemoriesApi` (`list/create/update/del`) on the Local and Remote backends;
  `LegacyBackend` maps all nine operations onto the legacy `/api/v2/presets`
  and `/api/v2/memories` routes (ms timestamps → RFC 3339; `null`
  characterId → omitted). `wireBridge` routes the UI shapes through the
  facade in kernel mode with honest translation; the existing preset editors
  (GenerationPresetEditor/PromptTemplateEditor) now load through the wire ops
  in kernel mode. A `characterId: null` update (un-scoping) is not
  expressible on the wire and surfaces `CAPABILITY_UNAVAILABLE`, never a
  silent no-op. Tests: Local/Remote parity + LegacyBackend mapping for the
  nine ops (neobackend `parity.test.ts` 55 tests), kernel-mode wireBridge
  routing/translation coverage (web `wireBridge.test.ts`).

- **Message variants/revisions/drafts over Product Wire (M5 / Этап 4, slice
  2, kernel + contract part).** Nine new wire operations
  `chats.messages.variants.list/create/delete/activate`,
  `chats.messages.revisions.list` and
  `chats.messages.drafts.get/save/commit/discard` (registry 47 → 56 ops).
  Schema migration 008 adds the STRICT `message_variants`,
  `message_content_revisions` and `message_drafts` tables plus
  `messages.updated_at` (variant/revision counts are derived, no counter
  columns). The kernel models the message text as the active variant:
  `activate` copies the variant content into the message and records the
  replaced text as an immutable revision; `chats.messages.update` records
  the previous text before applying a real change (no-op edits add nothing);
  `drafts.commit` materializes a message exactly once and is replay-safe via
  `committed_message_id` (the outbox contract), with the chat sequence
  allocated atomically at commit. Error paths are scoped and stable:
  `MESSAGE_VARIANT_NOT_FOUND`/`MESSAGE_DRAFT_NOT_FOUND` with
  `variantId`/`draftId` params.
  Tests: kernel `message_variants_revisions_drafts_round_trip` + error-path
  suite in `kernel_crud`; storage migration corpus accepts migration 008.
  The UI cutover and legacy swipe/draft route removal are the remaining
  slice-2 work within M5.

- **Legacy converter: message variants/revisions/drafts (M5 / Этап 4,
  slice 2).** The legacy `app.db` converter now maps the optional
  `message_variants` (swipes), `message_content_revisions` and
  `message_drafts` tables into the canonical schema-008 tables inside the
  same single conversion transaction: positions preserved, ms timestamps
  normalized, drafts lose only the no-kernel-equivalent
  `branch_id`/`name`/`meta` columns and keep the outbox
  `committed_message_id` exactly when the referenced message converted
  (a dangling outbox reference would let a commit replay point at a missing
  message — such drafts are skipped and reported). Per-table counts were
  added to the conversion report and to the committed-root re-read
  (`message_variants`/`message_content_revisions`/`message_drafts`). Tests:
  extended `legacy_conversion_maps_rows_skips_orphans_and_never_copies_secrets`
  fixture/assertions and a new kernel end-to-end test
  `converted_legacy_variants_usable_over_wire` (convert a legacy db with
  swipes/revisions/drafts, open the Kernel over the candidate root and serve
  the rows through the wire ops).

- **Facade + wireBridge for message variants/revisions/drafts (M5 / Этап 4,
  slice 2).** `NeoBackend.ChatsApi` gains the nine wire operations
  (`listMessageVariants/createMessageVariant/delMessageVariant/
  activateMessageVariant/listMessageRevisions/getMessageDraft/
  saveMessageDraft/commitMessageDraft/discardMessageDraft`) on the Local and
  Remote backends (LegacyBackend keeps them unsupported — browser mode keeps
  the `/api/v2` routes). `wireBridge` routes the UI shapes through the
  facade in kernel mode with honest translation (kernel drafts have no
  `branchId`/`name`/`meta` — neutral defaults), maps `revisions.restore`
  onto the canonical `chats.messages.update` op, and reports
  `CAPABILITY_UNAVAILABLE` for the operations the legacy server has no route
  for (`variants.create`, `variants.delete`, `drafts.get`). Tests: Local/
  Remote parity + validation for the nine ops (neobackend `parity.test.ts`),
  and kernel-mode wireBridge routing/translation coverage.

- **Chat UI cutover for variants/revisions/drafts (M5 / Этап 4, slice 2).**
  `ChatPage` swipe controls route through `swipeMessageToPosition`: kernel
  mode resolves the legacy swipe position onto the canonical variant
  (`variants.activate`, the active text is the implicit last item — swiping
  onto it is a no-op), browser mode keeps `POST .../swipe {position}`. The
  variants/revisions hooks now load through the facade in kernel mode
  (revisions restore maps onto `chats.messages.update` with the archived
  content; the legacy CAS `expectedRevision` stays legacy-only). The variants
  query drives the swipe counter when the message carries no permutation
  fields (kernel mode), eagerly only for the newest message so a long history
  does not fan out one request per assistant row (older rows load lazily via
  the picker). Kernel-plugin draft streaming (`plugins/kernel/chat.ts`)
  streams through `saveMessageDraft`/`commitMessageDraft`/
  `discardMessageDraft` instead of the legacy draft routes. The legacy UI
  surface shrinks from 68 to 61 allowed sites (`check-ui-api` regenerated);
  the legacy message swipe/draft/revision routes stay as the facade's
  browser/legacy-sidecar transport until Этап 6 (ADR-0048).

- **Fix: `/api/v2` double-prefix broke typed legacy calls in browser mode.**
  `LegacyBackend` passes full `/api/v2/...` paths (its contract), while the
  web same-origin transport prepends its own `/api/v2` BASE — every typed
  legacy call (`chats.messages.update` edit-save, `chats.messages.delete`)
  hit `/api/v2/api/v2/...` and 404'd, leaving the message edit/delete flows
  broken in the browser/legacy-sidecar modes. The web transport now strips
  the prefix before delegating (`apps/web/src/api/backend.ts`), with a
  regression test; the previously red `flows.spec.ts` edit test and
  `message-card-mobile.spec.ts` edit/restore test are green again.

- **Entry-level lorebook CRUD over Product Wire (M4 / Этап 4.1, slice
  follow-up).** Four new wire operations `lorebooks.entries.list/create/
  update/delete` join the `lorebooks.*` book ops: the kernel owns each
  entry's `id`/`position`/`metadata`/timestamps (stored rows now always
  satisfy the portable `ExportLoreEntry` shape), batch create/update writes
  the full stored entry shape, and the stable `LOREBOOK_ENTRY_NOT_FOUND`
  error carries `entryId`. The facade exposes
  `LorebooksApi.listEntries/createEntry/updateEntry/deleteEntry` in Local/
  Remote backends (legacy stays unsupported — the UI keeps `/api/v2` nested
  there); `wireBridge` routes the entry ops through the facade in kernel
  mode with honest translation (wire DTO has no position/metadata — neutral
  defaults, an explicit position/metadata patch is `CAPABILITY_UNAVAILABLE`).
  Tests at three levels: kernel `lorebook_entries_crud_round_trip` + error
  paths (14 kernel CRUD tests), wire corpus (+4 positive, +7 negative
  fixtures), remote-http host parity with the entry cycle.
- **Lorebook and persona UI cutover over the facade (M4 / Этап 4.1, ТЗ
  §8.1 Library context).** `wireBridge` gains
  `readLorebooks/readLorebook/createLorebook/updateLorebook/deleteLorebook`
  and `readPersonas/readPersona/createPersona/updatePersona/deletePersona`
  with honest wire-to-UI translators and `UnsupportedError` for unimodelled
  inputs (character scope, entry-level CRUD on the book shape, avatar
  clear); `NeoBackend`'s `LorebooksApi` gains get/create/update/del and a
  new `PersonasApi` exists on Local/Remote/Legacy backends; UI hooks route
  through the facade in kernel mode.
- **SEC-01 data-preservation fix: non-persistent backends no longer
  destroy legacy plaintext.** The session (non-persistent) SecretStore
  keeps legacy plaintext rows until a persistent backend is configured
  instead of destroying them at bootstrap.
- **SEC-05 fix: plugin entrypoints inside `signature/` are rejected.** A
  plugin manifest whose entrypoints live under `signature/` is refused at
  install and at host activation (the signature digest would not cover
  them); negative test added.
- **Full lorebook CRUD in the kernel (M4 / Этап 4.1, ТЗ §8.1 Library
  context).** Product Wire gains `lorebooks.get/create/update/delete`
  alongside `lorebooks.list`; the kernel implements all five with the same
  transaction/validation pattern as character CRUD. Entries travel as the
  `wire.lorebook.entry.input` object, are stored into `entries_json`,
  `entryCount` derives from `json_array_length`, and the prompt pipeline
  activates the stored entries (constant always, keyword substring,
  selective primary+secondary). Stable errors: `LOREBOOK_NOT_FOUND` with
  `lorebookId`; strict unknown-field/empty-name rejection
  (`CONTRACT_VIOLATION`). `lorebooks.read` capability becomes
  `lorebooks.crud` (5 wire ops).
- **Persona CRUD in the kernel (M4 / Этап 4.1, ТЗ §8.1 Library context).**
  Product Wire gains `personas.list/get/create/update/delete` backed by the
  STRICT `personas` table (canonical schema migration 7 `007_personas`,
  delivered with the Этап 3 cutover so migrated personas are never
  dropped). The single-default invariant matches the legacy
  `PersonaRepository`: create/update with `isDefault` clears the previous
  default in the same transaction. Stable errors: `PERSONA_NOT_FOUND` with
  `personaId`; `CONTRACT_VIOLATION` for strict unknown-field/empty-name
  rejection.
- **`check-ui-api` baseline regenerated (M4 / legacy-UI surface gate).**
  The 65-site M1-era baseline was regenerated to the current surface (68
  sites at the M3 head, 67 after the M4 slice) with full
  owner/removalIssue/milestone/deadline records; `wireBridge.ts` gained its
  removal record and the `generate.ts` record was corrected to milestone M4
  (the generation-stream cut did not land in M2). `pnpm ui:api:check`
  passes at every re-cut head.
- **Migration single-writer and pointer integrity fixes (audit P0 #3,
  ТЗ §10.3/§22.3).** `neotavern_storage::migration` is now session-based:
  `MigrationSession::begin` acquires the data-root lease and holds it for
  the whole staging→commit/cancel sequence (`session.commit()` /
  `session.cancel()`), so no second writer can enter between the phases —
  the old free `prepare`/`commit`/`cancel` split released the lease before
  commit. The active-root pointer is only ever written/read for the data
  root itself or a versioned root under `<data-root>/roots/` (an arbitrary
  absolute path is refused with `IntegrityViolation` on both write and
  read), and a pointer/journal that exists but cannot be read fails closed
  with `Corrupt` instead of being treated as missing (v1-flat fallback).
  `write_atomic` now fsyncs the temp file before the rename and the target
  after it (ТЗ §10.3 flush/sync requirement). The pre-migration safety copy
  is created with the SQLite online-backup API (not a plain `fs::copy`), so
  committed WAL frames are included and the copy passes `quick_check`
  before its checksum is written. The legacy→kernel converter now migrates
  the `personas` table (canonical schema migration 7 — added to the Этап 3
  cutover so migrated personas are never dropped; the Этап 4.1 kernel CRUD
  builds on the same table) with honest description/avatar defaults and the
  single-default invariant enforced on insert. Tests: migration suite 24
  tests (new: session holds the lease between phases, WAL commits included
  in the safety copy, unreadable pointer is not missing, out-of-root
  pointer refused on read and write, personas migrate with a single
  default), full `cargo test --workspace` green, clippy + rustfmt clean.

- **Durable run/step journal and the tool-call loop (M2 / Этап 2.7, ТЗ
  §8.3).** The kernel now journals every generation step in the new
  `generation_steps` table (schema migration 6 — `ALTER TABLE` + `CREATE
  TABLE`, no rebuild) and streams `generation.step` wire events
  (`provider_turn` / `tool_call` / `tool_result` / `final_commit`; DTOs
  `wire.generation.step` / `.type` / `.status`). A provider turn that emits a
  normalized tool call is validated against the **declarative tool registry**
  (capability + minimal JSON-Schema argument check; `Kernel::register_tool`,
  `generation.tools.list` `app.read`) and durably transitions the run to the
  derived wire status **`waiting_for_tool`** (DB `status` stays `streaming`;
  the marker column `pending_tool_call_json` is the source of truth — the v3
  CHECK is untouched). The kernel **never executes tools**: the host performs
  the effect once and submits `generation.tool.result` (non-idempotent,
  `app.write`), which journals the `tool_result` step, clears the marker and
  resumes the provider turn with the assistant `tool_calls` + `tool`-role
  result messages. Stable terminal codes: `TOOL_NOT_FOUND`,
  `TOOL_ARGS_INVALID`, `TOOL_LOOP_LIMIT` (max 8 tool calls per run),
  `TOOL_RESULT_STALE` (replay/foreign submission). Crash-at-wait: the waiting
  transition refreshed the run lease, so a reopen with a fresh lease resumes;
  an expired lease → `interrupted` (retry-safe — no external effect ever ran).
  Provider SDK: `ProviderEvent::ToolCall`, `PromptMessage.tool_calls` /
  `.tool_call_id`, `ProviderRequest.tools`. OpenAI-compatible adapter
  serializes `tools` and the resumed-turn context and accumulates SSE
  `delta.tool_calls[]` fragments into a normalized `ToolCall`. Fake provider
  gains `tool=<name>` and `tool-loop=<name>` grammar. Tests: 7 `tools.rs`
  unit (registry + schema subset), 2 fake unit, 2 adapter (fragmented
  arguments, mixed text+call), 8 `tool_loop.rs` kernel integration (golden
  round trip, listing, rejections, loop limit, crash-at-wait reopen-resume),
  1 storage migration test (v5→v6 with data). Honest boundary: JSON-Schema
  validation covers a documented subset (object/required/additionalProperties
  + scalar/array/object types); the full schema engine is a follow-up.

- **Waiting-run cancel/retry semantics and the OpenAI tool round trip (M2 /
  Этап 2.8, ТЗ §8.3).** `generation.cancel` on a **waiting-for-tool** run now
  finalizes the `cancelled` terminal itself (no live executor exists to
  observe the flag — `WaitingForTool → Cancelling → Cancelled`); all terminal
  writers (`completed` / `failed` / `cancelled` / startup `interrupted`
  recovery) clear `pending_tool_call_json`, so a terminal run never reports a
  derived waiting status and a late `generation.tool.result` is
  `TOOL_RESULT_STALE`. `generation.discard` on a terminal run clears the
  marker too. `generation.retry` from a cancelled waiting run starts attempt 2
  with a full tool round trip; retry on a still-waiting run is
  `GENERATION_RUN_STATE_CONFLICT`. New kernel integration test drives the
  **real OpenAI-compatible adapter over raw TCP**: turn 1 streams a
  normalized tool call (SSE `delta.tool_calls[]`), the kernel validates and
  waits, `generation.tool.result` resumes turn 2 with the tool context, and
  the run completes with exactly one assistant message; both HTTP bodies are
  asserted (`tools` serialization + resumed `tool_call_id`).

- **Packaged golden slice on the Desktop host (M2 / Этап 2.9, ТЗ §17.2).**
  `NEOTA_DESKTOP_SMOKE=1` on the packaged shell now runs the full user flow
  headless over the real Tauri host path (`shell → KernelHost envelope →
  kernel → SQLite`): handshake + `meta.get` + `characters.list` +
  `backups.list`, then character → chat → user message, `generation.start`
  (deterministic fake grammar) → `completed` with exactly one 24-char
  assistant message, then a complete tool round trip — `KernelHost::
  register_tool` (new host seam), a second run durably waits
  (`waiting_for_tool`), `generation.tools.list` serves the contract,
  `generation.tool.result` resumes and completes it with a second assistant
  message. The smoke exits 0 only when every step and assertion holds.
  Bug fix found by the smoke: the **Tauri-local and remote-http stream
  pollers now close the consumer stream when a run's session ends durably
  waiting for a tool result** (previously an unbounded poll loop — the
  kernel's `Terminal` notice was ignored); a new adapter integration test
  covers the waiting-run closure, and the remote-http live SSE worker gets
  the same `stream.closed` handling. Capability matrix: desktop host →
  `Integrated` for `characters.crud`, `chats.crud`, `chats.messages.crud`,
  `generation.workflow`, `generation.tool-loop`.

- **UI generation + message edit/delete over the Product Wire (M2 / Этап
  2.10, ТЗ §13.1/§11.2).** The chat page's golden path now runs through the
  `NeoBackend` facade instead of raw `/api/v2` calls: in kernel mode the send
  flow durably persists the user message via `chats.messages.create` and
  streams `generation.start` wire events (`generation.delta` /
  `generation.completed` / `generation.failed` / `generation.cancelled`)
  through `LocalBackend` over Tauri IPC — no `/api/v2` on that path; the
  browser/sidecar mode keeps the legacy SSE route. Regeneration and frontend
  prompt interceptors are legacy-only and surface an honest
  `UnsupportedError` on the kernel instead of a silent downgrade (kernel
  prompt pipeline owns the prompt; interceptors deferred to the plugin
  cutover). Message edit/delete run through
  `backend.chats.updateMessage`/`delMessage` in both modes (the legacy
  `expectedRevision` CAS is not part of the wire contract — kernel updates
  are last-write-wins). Facade additions: `GenerationApi.tools` —
  `generation.tools.list` / `generation.tool.result` implemented on
  `LocalBackend` (wire) and `RemoteBackend` (SDK); `LegacyBackend` throws an
  honest `UnsupportedError` (no legacy route) and gains migration shims for
  `chats.messages.update`/`delete` over the existing legacy routes. Tests:
  4 new neobackend parity/shim tests (34 total), 6 new web unit tests for the
  wire generation path; full web suite green. Docs:
  `docs/architecture/operations-inventory.md` routing table (golden-flow ops
  + tools), release-manifest notes (webClient `generation.workflow` →
  `Integrated`; `generation.tool-loop` desktop → `Integrated`), capability
  matrix, CHANGELOG.

- **Library/chat CRUD over the Product Wire (M2 / Этап 2.10, шаг 2, ТЗ
  §13.1/§14.3).** The golden-flow library/chat hooks now route through the
  facade via the new `apps/web/src/api/wireBridge.ts` data plane: in kernel
  mode every read/write goes over the canonical wire ops
  (`characters.list/get/create/update/delete`, `chats.list/get/create/update/
  delete`, `chats.messages.list`) with wire→UI translation onto the legacy
  shapes (honest defaults: `avatar: null`, card fields `''`/`null`, `meta: {}`,
  `variantCount: 0`, `activeVariantPosition: null`, `checkpointChatId: null`,
  `branchId: chatId` — the kernel keeps one linear sequence per chat);
  browser/sidecar mode keeps the legacy `/api/v2` routes byte-for-byte.
  Unsupported inputs surface a typed `UnsupportedError`
  (CAPABILITY_UNAVAILABLE) instead of a silent downgrade: character search/
  tag/non-default sorts, chat search, personaId/greetingIndex on chat create,
  persona/card fields on character create/update, branchId on message list,
  non-title chat updates. Kernel `chats.create` makes an **empty** chat
  (greeting insertion is a legacy pipeline feature; the continue hook already
  reproduced the `reuseUnstarted` guard client-side), and kernel chat delete
  is **permanent** (cascade; legacy soft-delete/trash is Этап 4). The wire
  `chats.messages.list` request gains an additive `order: 'asc'|'desc'` field
  (Этап 2.10): `desc` walks the durable `(sequence,id)` cursor backward from
  the newest message, matching the UI history loading (`useMessages` pages
  arrive newest-first; kernel was asc-only). Tests: 25 new web unit tests for
  the bridge (translation + kernel branch); hooks suite green.
  Docs: `operations-inventory.md` (list-messages order + UI cutover note),
  release-manifest notes (characters.crud / chats.crud / chats.messages.crud),
  CHANGELOG.

- **Versioned data roots, activation journal and Windows restart-to-complete
  (M3 / Этап 3, DATA-ACTIVATE, ТЗ §10.2–§10.4, ADR-0041).** The storage
  foundation for the data cutover: a new `neotavern_storage::activation`
  module implements the canonical v2 layout (versions under
  `roots/root-<id>/`, a small `active-root.json` pointer written atomically
  as the commit point), the durable `activation-journal.json` with the ТЗ
  §10.3 statuses `prepared` → `validated` → `activation_pending` →
  `committed` / `rolled_back`, and the Windows activation protocol: the
  pointer switch runs through bounded retry with exponential backoff + jitter
  for classified transient errors only (`ERROR_SHARING_VIOLATION` 32,
  `ERROR_LOCK_VIOLATION` 33, POSIX `WouldBlock`; access-denied is never
  retried), and after the budget is exhausted the journal stays at
  `activation_pending` with a stable recoverable error
  (`activation_pending`) so the host can offer **Restart to finish
  migration**. `open::open` runs `resolve_pending_activation` right after the
  data-root lease and before any SQLite open: a pending switch completes
  (restart-to-complete) when the target carries a database, or records
  `rolled_back` and keeps the previous root active when the target is
  missing; the old and new roots are never opened writable simultaneously.
  The v1 flat layout remains fully supported (a data root without
  `active-root.json` — the active root IS the data root, and the ADR-0032
  candidate-swap restore path is unchanged), and `open`/`open_read_only` now
  resolve the active root first so product reads/writes always hit the
  current version. Unknown future journal/pointer formats fail closed.
  Tests: 21 new `tests/activation.rs` integration tests (journal
  round-trip/transitions/idempotency, corrupt & future-format rejection,
  pointer round-trip and missing-target failure, the kill-matrix recovery
  — complete / roll back / no-op, transient-error classification and bounded
  retry, full `activate` lifecycle, open-path integration on the active
  root); storage suite and full cargo workspace green; clippy/rustfmt clean.
  Docs: ADR-0041, `portable-data.md` (versioned roots + journal + Windows
  protocol), CHANGELOG. The staged converter wiring this protocol into the
  application flow and the migration corpus are the next Этап 3 slices.

- **Staged legacy→kernel migration in the application flow (M3 / Этап 3,
  ТЗ §10.3, ADR-0041).** A new `neotavern_storage::migration` module
  orchestrates the full ТЗ §10.3 sequence for converting a legacy
  (pre-kernel Drizzle) database into a fresh versioned kernel root:
  detect → acquire the data-root lease as the exclusive maintenance lock →
  preflight (missing/non-file source → `NotFound`, non-legacy source →
  `UnsupportedStorageFormat`, free space below 3× source + 64 MiB →
  `DiskFull`, all before any write) → verified safety copy
  (`backups/pre-migration-*/database.sqlite` + `checksum.sha256`) →
  convert through the existing read-only `convert_legacy` into a staging
  versioned root (`roots/root-<id>/`, same volume by construction) →
  validate (normal kernel open + `foreign_key_check` + current schema
  revision) → human-readable report (per-table counts + skipped orphans) →
  platform-aware commit via the ADR-0041 activation journal (bounded
  transient retry on the pointer switch; `activation_pending` +
  restart-to-complete on budget exhaustion) → previous root retained as the
  rollback pointer. `prepare`/`commit`/`cancel` split the lifecycle so the
  user can cancel before activation (`rolled_back`, staging removed, safety
  copy retained); re-running is idempotent (a committed entry is reported,
  no second staging root); provider configs/secrets are never copied.
  **Migration corpus (ТЗ §17.4)** in `tests/migration.rs`: kernel databases
  at every released schema revision (1..6) open and upgrade with seeds
  preserved, a future schema fails closed (`SchemaTooNew`), a corrupted
  database is detected (`Corrupt`), and an interrupted legacy migration
  recovers with a fresh staging root. Tests: 15 new migration integration
  tests; storage suite and full cargo workspace green; clippy/rustfmt clean.
  Docs: `portable-data.md` (staged migration section), CHANGELOG. The
  Windows lock-contention E2E on packaged artifacts and the switch of the
  canonical data-root remain the later Этап 3 slices.

- **Migration corpus and real-schema mapping completeness (M3 / Этап 3,
  ТЗ §17.4, §10.3).** The legacy converter now maps the REAL Drizzle layout
  (`packages/db` migrations 0000…0024), not just the minimal fixture:
  known character-card fields (`personality`, `scenario`, `first_message`,
  `example_dialogues`, `system_prompt`, `post_history_instructions`,
  `creator`, `creator_notes`) survive into the kernel `ext_json` under
  stable keys — the Kernel prompt pipeline already reads
  `ext_json.personality`/`persona` for the persona block, so converted
  characters keep their persona; tags are read from the real
  `character_tags`/`tags` join tables and merged, sorted and deduplicated
  into `tags_json`; unknown `ext` fields are preserved verbatim; soft-deleted
  rows (`deleted_at IS NOT NULL`) are skipped and reported as orphans
  (the kernel has no `deleted_at`, so deleted characters/chats are not
  resurrected); legacy `messages.branch_id`/`parent_id`/`meta`/`name` are
  flattened (no kernel columns — rows keep chat ordering). **Migration
  corpus (ТЗ §17.4)** extends `tests/migration.rs` with: the real Drizzle
  schema mapping test (card fields → ext_json, join tags → tags_json,
  unknown ext preserved, soft-delete skipped, unicode/RTL/20k-char values
  round-trip), a 1000-character/1000-chat/3000-message library with exact
  counts, branch-flattening, and the **Windows platform corpus**: a real
  file handle held without `FILE_SHARE_DELETE` makes the pointer switch
  exhaust the bounded retry budget, `commit` returns the stable recoverable
  `ActivationPending`, the journal stays `activation_pending` with the
  previous root active, and releasing the handle lets the next `open`
  resolve the pending activation (restart-to-complete). Tests: 19 migration
  integration tests; storage suite and full cargo workspace green;
  clippy/rustfmt clean. Docs: `portable-data.md` (schema mapping + corpus
  sections), CHANGELOG. The Windows E2E on packaged artifacts and the
  canonical data-root switch remain the later Этап 3 slices.

- **CLI host flow for the data cutover (M3 / Этап 3, ТЗ §10.3 work 7–8).**
  `neotavern-cli --root <data-root> --migrate-legacy <legacy.db> [--no-backup]`
  is now the maintenance-mode host that runs the staged legacy→kernel
  converter with the kernel **closed**, then opens the kernel on the
  activated root — the canonical data-root switch. Progress stages
  (`preflight`/`backup`/`convert`/`validate`/`activate`) go to stderr; the
  committed report (entry id, active root, retained previous root, per-table
  counts, skipped orphans) and the kernel-open confirmation go to stdout.
  Missing `--root` → usage error (exit 2); a non-legacy/missing source →
  controlled storage diagnostic on stderr and exit 1 with no journal written
  (fail-closed before any write). The CLI's `neotavern-storage` dependency
  moves from dev-only to runtime (the CLI now owns the offline migration
  entry point). Tests: `crates/adapters/cli/tests/cli.rs` spawns the real
  binary — full migration + `characters.get` round-trip over the versioned
  root, missing-`--root` usage error, non-legacy rejection; 13 CLI tests
  total; full cargo workspace green; clippy/rustfmt clean. Docs:
  `portable-data.md` (host-flow section), CHANGELOG. Remaining Этап 3
  slices: Windows/macOS/Linux upgrade drills on packaged artifacts.

- **Cross-platform upgrade drill (M3 / Этап 3 work 7, ТЗ §10.3).**
  `node scripts/upgrade-drill.mjs` (`pnpm upgrade:drill`) proves the upgrade
  cycle on the real CLI artifact on Windows/macOS/Linux (Node 24 built-in
  `node:sqlite`, no external dependencies): builds a Drizzle-style legacy
  fixture, runs `neotavern-cli --migrate-legacy`, and asserts the migration
  commits with the kernel opening on the active root, `characters.get`
  returns the migrated character, the legacy database stays byte-identical
  (immutable source), re-running is idempotent (one committed entry, one
  staging root), the pre-migration safety copy matches the source checksum,
  and the activation journal ends `committed` with the rollback pointer
  retained. PASS on Windows in this session; macOS/Linux runs gate the
  release branch in CI. The Windows lock-contention/restart-to-complete
  corpus remains the Rust held-handle test. Docs: `portable-data.md`
  (upgrade-drill section), `package.json` (`upgrade:drill` script),
  CHANGELOG.

- **Prompt pipeline in the Kernel (M2 / Этап 2.6, ТЗ §9.1–§9.2).** Every
  generation run now builds an immutable **PromptPlan** before the provider
  attempt: character/persona system blocks (from the chat's character card,
  including the `ext_json.personality` persona field), lorebook keyword
  activation (constant/selective rules mirroring the legacy retrieval,
  disabled entries skipped, defensive parsing), bounded history selection
  (last 128 non-tool messages), a local heuristic token budget
  (`heuristic-v1`, explicitly flagged approximate) with response-room
  reservation and oldest-unpinned truncation that records every excluded
  message id with reason. The plan is stored durably in the new
  `prompt_plans` table (schema migration 5) and served by the new wire op
  `generation.prompt.plan` (`app.read`; DTOs `wire.prompt.plan` /
  `wire.prompt.message` / `wire.prompt.block` / `wire.prompt.excluded`;
  stable `PROMPT_PLAN_NOT_FOUND`). The instruct-neutral message array is
  passed to adapters via the new `ProviderRequest.messages` field
  (`provider-sdk::PromptMessage`); the OpenAI-compatible adapter serializes
  it verbatim as the chat-completions `messages` (falling back to the single
  `input` message for plan-less calls). A plan that cannot be built or
  stored fails the run with the stable terminal `PROMPT_PLAN_FAILED`. Tests:
  5 unit tests in `crates/runtime-kernel/src/prompt.rs` (estimator,
  system-block merging, budget truncation with excluded ids, lorebook
  activation, camelCase plan shape), 2 kernel integration tests
  (`tests/prompt_plan.rs`: golden path proves the durable plan row survives
  a kernel reopen and `generation.prompt.plan` serves character+persona
  blocks, history + pinned user message, empty `excluded` at the default
  budget; unknown run → `PROMPT_PLAN_NOT_FOUND`), plus an adapter test for
  plan serialization. Honest boundaries: tokenization is approximate
  (model-specific registry is future work), instruct-format template
  rendering is deferred, and lorebook scoping to characters awaits the
  lorebook cutover.

- **OpenAI-compatible production provider (M2 / Этап 2.5, ТЗ §9.3/§9.4).**
  New crate `crates/provider-openai-compat`: a `ProviderAdapter` speaking the
  OpenAI chat-completions streaming protocol (`POST {baseUrl}/chat/completions`,
  SSE `data:` frames) against OpenAI and OpenAI-compatible endpoints (vLLM,
  llama.cpp, LocalAI, gateways). Config-driven from the non-secret
  `provider_configs.config_json` (`baseUrl`, `models`, `timeoutMs`,
  `maxResponseBytes`, `organization`, `maxTokens`). Transport is a minimal
  blocking HTTP/1.1 client over `std::net::TcpStream` with rustls TLS verified
  against the OS trust store (`rustls-platform-verifier`), bounded SSE reads
  (SEC-04: body capped at `maxResponseBytes`, connection destroyed on breach)
  and normalized errors (HTTP statuses + SSE error events → stable
  `ProviderErrorCode`s with advisory retryable flags). **Secret handling at
  execution time (§9.4):** the kernel executor now resolves the run provider's
  `secret_ref` (first config alphabetically by name) through the host
  `SecretResolver` seam just-in-time and hands the value via
  `ProviderRequest::api_key`; the adapter uses it only for the
  `Authorization` header — never in the body, errors, logs, snapshots or the
  DB; a `secret_ref` without a resolver fails closed (`PROVIDER_UNAVAILABLE`).
  New kernel seam `Kernel::register_provider` (Command::RegisterProvider) for
  hosts to register config-built adapters. 12 adapter unit tests against a
  raw-TCP mock endpoint (chunked/content-length SSE, HTTP errors, cancel
  mid-stream, deadline, byte budget, key-not-in-body) + 3 kernel integration
  tests proving config → SecretStore → register → `providers.list` →
  `generation.start` streams deltas and saves the assistant message durably
  with the resolved key on the wire and no plaintext in `database.sqlite`.

- **Provider configuration with secrets out of the database (M2 / Этап 2,
  ТЗ §9.4, §SEC-01).** New wire operations `providers.config.set/get/list/
  delete` with `wire.provider.config.dto` (non-secret `config` object plus
  `hasApiKey` — never the value). The kernel implements them over the
  `provider_configs` table (v4 migration): an API key passed to `set` is
  stored through the host-provided SecretStore seam
  (`Kernel::set_secret_store`, namespace `provider:<provider>` / id `<name>`)
  and the row keeps only the opaque reference; `set` without `apiKey`
  updates `config` and leaves the stored secret untouched; `delete` removes
  the row and revokes the secret (best-effort). Fail-closed boundary: no
  wired store → `SECRET_UNAVAILABLE` product error, no plaintext fallback;
  read-only backends → `SECRET_STORE_READ_ONLY`; missing config →
  `PROVIDER_CONFIG_NOT_FOUND` with `{provider, name}`. Config names are
  wire-constrained slugs so the derived secret id stays colon-free and the
  reference round-trips through the last-colon parse contract (ADR-0040).
  `packages/neobackend` exposes `ProvidersApi.config` (set/get/list/del)
  across LocalBackend (kernel), RemoteBackend (wire) and LegacyBackend
  (typed UnsupportedError). 5 integration tests incl. plaintext-absence in
  the raw database file, fail-closed without a seam, key replacement and
  revocation.

- **Chat and message CRUD in the Runtime Kernel (M2 / Этап 2, ТЗ §8.1
  Conversations, §78 Фаза 3).** The Product Wire registry grows six write
  operations — `chats.create/update/delete` and
  `chats.messages.create/update/delete` (request DTOs
  `wire.request.create-chat` / `update-chat` / `delete-chat` /
  `create-message` / `update-message` / `delete-message`; schema hash
  bumped). The kernel implements them over the canonical SQLite schema:
  chats carry `messageCount` via subquery, message `sequence` is allocated
  atomically as `MAX(sequence)+1` inside the transaction, message
  update/delete are chat-scoped, chat delete cascades to messages, missing
  entities surface stable product errors (`CHARACTER_NOT_FOUND` for a create
  against an unknown character, `CHAT_NOT_FOUND`, `MESSAGE_NOT_FOUND` with
  the request's id in `params`). `packages/neobackend` exposes the new
  operations on the `NeoBackend` facade (`ChatsApi.create/update/del`,
  `createMessage/updateMessage/delMessage`) across `LocalBackend` (kernel
  transport), `RemoteBackend` (wire) and `LegacyBackend` (typed
  `UnsupportedError` until cutover). Integration tests cover the full
  round-trip, sequence ordering, scoped not-found and cascade semantics.

- **M1 governance — ADR-0043 records the Web Client remote-only decision.**
  The installable web artifact is documented as a Remote/Installable Web
  Client to a user-controlled Headless/Desktop host, not a standalone
  offline runtime: the service worker caches only the app shell and public
  static assets, and the offline state is an honest connection screen with no
  product mutations. The standalone browser/WASM runtime remains a separate
  product track (ТЗ §11.3.2) requiring its own ADR; until then standalone
  capability stays `Not supported` (ARC-12). The decision was already
  referenced by ADR-0038 and `AGENTS.md`; this ADR closes the dangling
  reference.

- **M1 review round 2 — WS handshake bounds, compressed wire accounting,
  crash-safe install journal v2, owner-aware secret cleanup (ТЗ §SEC-01 /
  §SEC-04 / §SEC-05).** The plugin-runtime WebSocket upgrade handshake is now
  bounded: `WS_MAX_HANDSHAKE_BYTES` (16 KiB) and `WS_HANDSHAKE_TIMEOUT_MS`
  (10 s) reject an oversized or stalled upgrade with
  `NETWORK_DESTINATION_DENIED` (timer cleared on cleanup).
  `networkPool` counts the **compressed wire bytes** against the same cap as
  the decompressed result, and `decoder.write()` backpressure pauses the
  response (`drain` resumes it), so a gzip bomb cannot expand past the budget
  on either side. The install journal is now written **before** the first
  filesystem mutation with the exact `.incoming-*`/`.rollback-*` paths and
  the previous registry row; startup recovery restores a consistent
  DB+FS pair from every intermediate crash state (rolled-back updates,
  fresh-install cleanup, pre-mutation crashes dropped untouched) and never
  deletes both versions. Secret cleanup is owner-aware: `deleteRef` routes by
  the **saved** opaque reference (`portable:`/`session:`/`env:`) to the
  backend that owns the value, provider/plugin DELETE revokes the store value
  before deleting the row (a failed revocation keeps the row for a retry),
  and provider/plugin deletion cascades revocation to every referenced value.
  Tests: `socketHandles.test.ts` (18), `networkPool.test.ts` (14),
  `packageIntegrity.spec.ts` (12), `secretStore.spec.ts` (14) incl. the
  negative end-to-end cases for each fix.

- **M1 governance — limited ADR waiver (ADR-0042) and a gate that validates
  it.** `docs/adr/0042-m1-waiver-per-profile-export-scoping.md` records the
  single limited waiver the ТЗ allows (one P1 issue: per-profile export
  scoping is a canonical-plane schema change, expiry at the M4 cutover,
  human sign-off at M1 acceptance). `scripts/check-milestone-gates.mjs` now
  validates every waiver's `by` (automated actors rejected), `reason`,
  `severity` (must match the blocker's P-level), `expiry`, `date` and `adr`
  (must link a real document in `docs/adr/`); accepted milestones must carry
  **structured, reproducible evidence** (`{type, command, result, commit,
  ciRun, artifact}` — test-run items need the exact command and a commit in
  HEAD ancestry; bare "597/597" strings are rejected); `acceptedBy` must be a
  person or an explicit human-ratified signature; the `--acceptance-drill`
  now validates the proposal's exit-criteria evidence map. Self-test: 17
  cases.

- **Clean M1 PR branch.** Per the audit directive the M1 work was split onto
  `m1-w1-security-clean` (rooted at `ec127a4` — origin/main plus the accepted
  M0 governance commits, so the gate's M0 ancestry check holds) containing
  only M1 commits; `origin/main` was never touched. The acceptance ledger now
  records this branch honestly: M2/M3/M4 carry no `deliveredCommit` here, the
  M1 waiver has real `by`/`severity`/`expiry`/`adr` fields, and the
  acceptance proposal's evidence is reproducible (commands + commits).

- **Logical profile export hardening (SEC-02 audit findings, ТЗ §SEC-02).**
  `apps/server/src/lib/profileExport.ts` now reads every allowlisted table
  inside ONE SQLite snapshot transaction (manifest records
  `snapshotTransaction: true`), so a concurrent mutation can no longer split
  the archive across two database states. `SELECT *` is gone: each table is
  read through an explicit per-table column allowlist recorded in the
  manifest, and the SEC-02 suite verifies the allowlist against the live
  schema (`PRAGMA table_info`) — a column added by a future migration cannot
  silently enter or silently drop out of the archive; only
  `provider_configs.api_key` is an intentional partial allowlist (secret).
  A failure inside the transaction rolls back and never leaks a temp
  directory. Tests: `apps/server/test/profileExport.spec.ts` now 11 tests
  (sentinels absent, per-table column allowlist exact-match, allowlist vs
  schema, snapshot-transaction flag, rollback/no-dangling-transaction).

- **Acceptance-ledger ordering gate (audit directive) and honest milestone
  statuses.** New `scripts/check-milestone-gates.mjs` (wired into
  `.github/workflows/ci.yml` and `pnpm milestone:gates:check`, with a
  fixture self-test) fails CI when a milestone is marked `accepted` while an
  earlier milestone is not — the audit's "CI gate blocking M2 while
  M1.status != accepted". The ledger records later-stage milestones as
  `in_progress` until their predecessors are formally accepted; M0 stays
  `accepted`.

- **SEC-01 kernel-plane SecretStore port (M1 / Wave 1, ТЗ §SEC-01.1 /
  ADR-0040).** New `crates/secret-store` implements the canonical portable
  `secrets.enc` **v2** format: AES-256-GCM over a JSON envelope with an
  Argon2id key (m=64 MiB / t=3 / p=1, fixed provisionally by ADR-0040 and
  gated by a pre-Stable benchmark), authenticated header (magic, formatVer,
  KDF id/params, salt) so a tampered header can never downgrade the KDF,
  fresh nonce per write, salt stable per passphrase, atomic temp+rename
  writes, machine-independent derivation (file + passphrase only), `lock()`
  and staged re-encryption (the new file is verified before the old one is
  replaced). Session (`MemorySecretStore`), read-only env
  (`EnvSecretStore`, `NEOTA_SECRET_*`) and explicit unavailable backends;
  opaque references (`portable:`/`session:`/`env:` with last-colon split
  mirroring the legacy contract); stable error codes
  (`SECRET_STORE_LOCKED`/`CORRUPT`/`AUTH_FAILED`/`READ_ONLY`). Legacy v1
  (scrypt) files are rejected with an explicit code until the Этап 3
  converter. 15 tests including cross-machine portability, tamper
  detection, wrong-passphrase fail-closed and re-encryption.

- **SEC-01 — SecretStore, secrets out of the main DB (M1 / Wave 1, ТЗ §SEC-01 /
  §SEC-01.1).** New `packages/secret-store` port with three explicit backends —
  no silent plaintext fallback: **portable** `secrets.enc` in the data root
  (`NEOTA_SECRET_MODE=portable` + `NEOTA_SECRET_PASSPHRASE[_FILE]`; AES-256-GCM,
  versioned scrypt KDF with salt/parameters authenticated as AAD so a tampered
  header can never downgrade, fresh nonce per write, atomic temp+rename,
  machine-independent derivation, `lock()` and staged `reEncrypt()`),
  **session** (process memory only, the default without a passphrase) and
  **env** (read-only `NEOTA_SECRET_*`, headless policy). Provider and plugin
  secrets no longer live in `app.db`: migration 0024 adds `value_ref` and the
  DB stores opaque references (`portable:`/`session:`/`env:`), resolved at
  runtime via `ctx.secrets` (`apps/server/src/lib/secretStore.ts`); the reveal
  routes and the provider runtime (`getFullConfig`, plugin auth, connection
  profiles) resolve through the store. Pre-migration plaintext rows are
  imported at bootstrap (idempotent, skipped while locked). A reference whose
  backend cannot produce the value surfaces the stable
  `SECRET_UNAVAILABLE_ON_THIS_DEVICE` error (422) — never a fallback; backups
  and profile exports contain no secrets (tests in
  `apps/server/test/secretStore.spec.ts`, 16 package unit tests). Capability
  `security.secret-store` is now `Implemented` on desktop/headless/web-client
  hosts (`docs/release-manifest.json`); OS vault / Android Keystore adapters
  and the portable passphrase UX remain kernel-plane M3.
- **Legacy compatibility authority boundary (ARC-11, M1 / Wave 1, ТЗ §14.2 /
  ADR-0039).** The per-legacy-API authority map
  (`packages/legacy-compat/COMPATIBILITY.md`) and its enforcement suite
  (`apps/server/test/legacyAuthority.spec.ts`) are now shipped: legacy Express
  routers are confined to `/api/plugins/{id}/...` and can never shadow core
  `/api/v2` routes; legacy extension settings stay namespaced per installed
  plugin (unknown namespace → `PLUGIN_NOT_FOUND`, >1 MiB → `FILE_TOO_LARGE`);
  the scoped plugin VFS is wired to `<data-root>/plugins/{id}/data` — outside
  the canonical DB and secrets — with `../` and backslash escapes rejected
  (fail-closed) and `files.plugin` required (`PLUGIN_PERMISSION_DENIED`
  without it). Capability `compat.authority-boundary` is now `Implemented` on
  desktop/headless/web-client hosts (`docs/release-manifest.json`).
- **Restore maintenance lock (M1 / Wave 1, ТЗ §10.4).** `POST
  /api/v2/backups/:id/restore` now runs exclusively under a global
  maintenance lock (`apps/server/src/lib/maintenance.ts`): while a restore is
  in progress, new product mutations — including plugin activation — are
  rejected with the stable `MAINTENANCE_MODE` error (503) via a Fastify
  `onRequest` gate, and a second restore is refused. Read-only requests and
  backup/diagnostics tooling keep working so the UI can show an honest
  maintenance state. The lock is released on every exit path (success and
  failure). Tests: `maintenance.test.ts` (exclusive acquire, mutation gate,
  restore-under-lock, release after success and after failure). Capability
  `security.restore-maintenance-lock` is now `Implemented` on
  desktop/headless/web-client hosts (`docs/release-manifest.json`).
- **SEC-05 — plugin package trust (M1 / Wave 1, Immediate security).**
  Publisher signature + per-file digest verification runs BEFORE consent or
  filesystem promotion: a signed package carries
  `signature/manifest.json` (format `neotavern.package-signature.v1`,
  Ed25519) pinning the sha256 of every file plus `signature/package.sig`
  over the manifest bytes. Verification is fail-closed — a broken signature
  (`PLUGIN_SIGNATURE_INVALID`) or a signature from an unknown publisher
  (`PLUGIN_SIGNATURE_UNTRUSTED`) rejects the install. Trust states
  (`built-in` / `verified-publisher` / `locally-trusted` /
  `unsigned-untrusted`) are recorded in the plugin registry (migration 0023)
  and surfaced as `InstalledPlugin.trust`; enabling an unsigned package via
  the consent flow records `locally-trusted`. Policy knobs:
  `NEOTA_PLUGIN_PUBLISHER_KEYS` (comma-separated base64 Ed25519 public keys)
  and `NEOTA_PLUGIN_REQUIRE_SIGNATURE`. ZIP and tar.gz extraction now also
  reject duplicate normalized paths (a later entry can never overwrite an
  earlier one); traversal, symlinks, encrypted entries, native payloads and
  bounded zip bombs were already rejected. Tests: `packageTrust.test.ts`,
  duplicate-path cases in `packageArchive.test.ts`, install-flow trust tests
  in `extensions-hardening.spec.ts`. Capability
  `security.plugin-package-trust` is now `Implemented` on
  desktop/headless/web-client hosts (`docs/release-manifest.json`).
- **SEC-03/SEC-04 — plugin network broker hardening (M1 / Wave 1).** The
  plugin `network.http.fetch` transport now connects to the policy-approved
  IP (no DNS in the connect path) with the hostname preserved only in `Host` /
  TLS `servername`, and verifies the connected `remoteAddress` against the
  approved set after connect (ТЗ §SEC-03: "после connect проверяется
  remoteAddress"); TCP connects do the same post-connect check. IP literal
  normalization now handles the bracket form WHATWG URL produces for IPv6
  (`[::1]`) and both IPv4-mapped spellings (`::ffff:127.0.0.1` and the hex
  `::ffff:7f00:1`) — previously `[::1]` was misclassified as public, a
  loopback SSRF bypass. Response bodies are capped while streaming and the
  connection is destroyed immediately on exceed (ТЗ §SEC-04), instead of
  buffering an unbounded body to truncate later. New coverage:
  `netPolicy.test.ts` (normalization + post-connect verification),
  bracketed-IPv6 deny/allow tests in `memoryHost.test.ts`, verified-connect +
  bounded-body integration tests in `networkPool.test.ts`. Capability
  `security.plugin-network` is now `Implemented` on desktop/headless/web-client
  hosts (`docs/release-manifest.json`). WebSocket post-connect verification is
  a documented follow-up (undici WebSocket does not expose the socket).
- **SEC-02 — logical profile export (M1 / Wave 1, Immediate security).**
  `apps/server/src/lib/profileExport.ts` no longer snapshots the full
  `app.db` into the archive (ТЗ §SEC-02 forbids a DB snapshot as a profile
  export). Export format is now **v2**: `manifest.json` records the envelope,
  `schemaVersion`, per-table row counts, the exclusion list with reasons
  (secret stores, plugin/theme installations, cache, diagnostics, import
  bookkeeping) and the applied field redactions
  (`provider_configs.api_key`, `provider_configs.settings.customIncludeHeaders`,
  `connection_profiles.payload.includeHeaders`); product data is streamed as
  one `data/<table>.jsonl` per allowlisted table; original files stay under
  `files/`. New SEC-02 acceptance suite
  (`apps/server/test/profileExport.spec.ts`) plants unique sentinel secrets in
  every secret-bearing store and proves none appears anywhere in the archive,
  plus route-level coverage of `GET /api/v2/profiles/export`. Export-format
  axis bumped to 2 (`docs/architecture/version-axes.md`); v1 archives are
  retired. Capability `ui.profile-export` is now `Implemented` on
  desktop/headless/web-client hosts (`docs/release-manifest.json`).
- **Architecture Convergence program — M1/Wave 0 governance (ТЗ 10/10 rev2).**
  The target-architecture
  [ТЗ 10/10 rev2](NeoTavern_architecture_10_of_10_spec_2026-08-13.md) is the
  governing requirements document (supersedes ТЗ 7.2 where they conflict).
  [ADR-0038](docs/adr/0038-canonical-rust-kernel-core.md) makes the Rust
  Runtime Kernel the canonical application core (single owner of product
  logic and persistent state) and freezes Fastify/Drizzle as the
  legacy/migration contour; [ADR-0039](docs/adr/0039-legacy-compatibility-authority-boundary.md)
  defines the authority-non-expanding compatibility boundary (legacy code
  may translate/restrict, never grant more authority). The web artifact is
  now an **installable Web Client** (remote-only, ARC-12): "PWA" wording was
  swept from the repo, and docs, AGENTS.md §2/§6/§21 and the desktop README
  describe the honest staged default (public builds use the tested legacy
  sidecar; the Kernel becomes the public default only after the release
  gate). New governance tooling: the generated
  [capability matrix](docs/capability-matrix.md) with
  `docs/release-manifest.json` (ARC-10, `pnpm capability:matrix:check`),
  `docs/architecture/exceptions.json` for temporary architectural exceptions
  (ARC-09, expiry checked by docs:check), and a new CI gate
  `scripts/check-ui-api.mjs` + ESLint rule `@neotavern/no-legacy-api-surface`
  that forbids NEW `/api/v2`/`legacyRaw` calls in production UI while the
  existing 65 call sites are tracked in
  [ui-legacy-surface.md](docs/architecture/ui-legacy-surface.md) with
  baseline-disable comments (ARC-02/ARC-03).
- **Wave 0 verification hardening (M1 acceptance).** The honest Desktop
  default is now **code, not docs**: `desktop_mode()` in
  `apps/desktop/src-tauri/src/lib.rs` selects the legacy sidecar for public
  release builds (`NEOTA_DESKTOP_CHANNEL=release`, baked by
  `desktop:release`), the Kernel for nightly/internal and debug builds, with
  explicit `NEOTA_LEGACY_SERVER=1` / `NEOTA_KERNEL=1` overrides (the portable
  shell smoke pins `NEOTA_KERNEL=1`). Docs are a **single source tree**:
  `scripts/docs-sync.mjs` deterministically mirrors `docs/` into
  `apps/docs/docs/architecture/` (escaping links rewritten to GitHub URLs,
  `editUrl` pointing at the canonical file), `pnpm docs:site:build` syncs
  before building, and CI runs `pnpm docs:sync:check` (byte-for-byte
  divergence gate). The capability generator now **fails** on any Product
  Wire operation that is unreferenced, referenced by two capabilities, or has
  an unknown status/host. The legacy-surface gate compares **per-site
  fingerprints** (`file:line:kind:detail`, not a bare count) and the CRLF
  ESLint exemption is registered in `docs/architecture/exceptions.json`
  (ARC-09, id `M1-crlf-blob-eslint-exemption`, deadline 2026-09-30).
- **M1 review follow-up (Changes requested — re-scoped to M1a).** Reviewer
  findings from the M1 acceptance check addressed in one follow-up commit:
  - `.github/workflows/docs.yml` — the unquoted `name:` scalar (invalid YAML)
    is quoted; the `pnpm docs:site:build` path in Actions is now provable.
  - `scripts/docs-sync.mjs` treats the mirror as a **closed tree**: `--check`
    enumerates the actual target directory and fails on any file a fresh sync
    would not produce (a page smuggled into `apps/docs/docs/architecture/`
    can no longer reach Docusaurus), and a plain sync deletes stale generated
    files. Negative scenarios are covered by `scripts/docs-sync.test.mjs`.
  - Honest Desktop default docs synced to code: root `README.md`,
    `apps/desktop/README.md`, `docs/architecture/operations-inventory.md` and
    ADR-0038 no longer call the Kernel the default or the sidecar "opt-in".
    Explicit **conflict policy**: with both `NEOTA_LEGACY_SERVER=1` and
    `NEOTA_KERNEL=1` set, `NEOTA_KERNEL=1` wins and a warning is printed; the
    full mode matrix is unit-tested (`resolve_desktop_mode` in
    `apps/desktop/src-tauri/src/lib.rs`). The DiagnosticsPanel marks an active
    Kernel as **Kernel Preview** (ADR-0038) through a truthful
    `desktop_backend_mode` probe — release builds on the sidecar show no
    kernel marking.
  - **M1 boundary fixed:** the accepted scope is **M1a / Wave 0 Governance**;
    M1 (Wave 1 Immediate security) remains open, and SEC-02 (the legacy
    profile export must stop snapshotting the full `app.db`, ТЗ §SEC-02) is
    **Pending** in `docs/release-manifest.json` — it was incorrectly claimed
    fixed in M1.
  - `docs/architecture/ui-legacy-surface.md` product sites now carry a
    structured record (Owner / Removal issue / Milestone / Deadline);
    `--check` fails on any product row with empty fields, so `--update` alone
    can no longer legitimize a new legacy call. `plugin-compat` rows stay `n/a`
    (long-lived public adapter, ARC-09).
- **Root README rewritten** to match the shipped ТЗ 7.2 architecture: Rust
  Runtime Kernel (crates/), Product Wire Contracts + generated Rust DTOs, Android
  host, headless/server role, extension-hardening surface, and the docs site
  locales (EN/zh-Hans/ja).
- **Extension hardening (ТЗ 7.2 Фаза 10, §10/§47–§54/§60/§61/§70/§76/§83).**
  Extensions now cross real security boundaries. **Declarative semantic UI
  slots** — the five frozen ids (`chat.header.actions`,
  `chat.message.actions`, `character.editor.actions`, `settings.section`,
  `generation.controls`) — accept plain-data contributions (title ≤80, no
  control chars; priority; optional v2 permission; `command`/`event` action)
  that the web host re-validates, permission-gates, orders and renders as
  plain buttons (`SlotHost`); plugins provide semantics only, never markup,
  and zero contributions render nothing. **No arbitrary third-party JS in
  the main WebView by default**: legacy SillyTavern `<script>` injection now
  requires the app-level `extensions.legacyFrontend` setting (default off)
  AND the admin-only `legacy.trusted` consent; rev4 plugins stay in the
  sandboxed iframe; the kernel-mode CSP is pinned by a contract test
  (`script-src 'self'` only). **Themes**: activation re-validates before
  flipping, the previously working theme (id + settings) is snapshotted as
  the fallback, boot resolves active → last-working → empty (safe mode
  always empty), and optional `responsive {density, motion}` semantics apply
  `data-theme-density`/`data-theme-motion` with defaults. **Manifest
  `engines`** are enforced against `neotavern`/`host`/`sdk`/`protocol`
  (422 `ENGINE_MISMATCH`); an incompatible update auto-disables the plugin
  and keeps the previous version installed. **Namespaced state** is
  quota-bounded (`kvBytes` 1 MiB / `kvKeys` 4096 → 413
  `STATE_QUOTA_EXCEEDED`). New **per-plugin SecretStore** (write-only PUT,
  masked list, reveal only with `secrets.reveal` + the host exposure gate;
  never in state/backup/export/logs). Plugin namespaces enter backups as an
  **additive optional sidecar** (state only, secrets excluded, conflict-skip
  restore). Hosts report **explicit extension availability**
  (`extensionsAvailability()` on Android — declarative-only policy;
  `useExtensionAvailability()` in web — `nodeRuntime` unavailable in
  desktop kernel mode). Docs: ADR-0037, plugin-sdk slots/availability/
  legacy-frontend pages, theme-sdk responsive/fallback sections.
- **Android background execution (ТЗ 7.2 Фаза 8, §8/§19/§65/§66/§85/§87).**
  Generation the user can see keeps running when the app leaves the
  foreground, and maintenance runs without interaction — both on the
  **same kernel session**, never a second writable kernel (the data-root
  lease rejects it with `DataRootInUse`, §22). `GenerationService` is a
  bounded `FOREGROUND_SERVICE_TYPE_DATA_SYNC` service sharing the ONE
  `KernelSession` handle with the activity via `KernelHolder`
  (refcounted `acquire()`/`release()`; at zero the session closes and the
  executor shuts down); the bridge hands active streams to the service
  through `ForegroundExecutionCoordinator` (first claim wins, idempotent),
  and `EnvelopeBuilder` produces request envelopes byte-identical to the
  TS `wireEnvelope`. The notification (channel `neotavern_generation`, id
  1001) shows run state only (`Generating` / `Complete` / `Failed`,
  `NotificationState`) plus a Stop action — **never message content**
  (§85); user Stop and OS expiration both map to `session.cancelStream` →
  `generation.cancel`, and process death recovers via kernel startup
  recovery (`interrupted`, §63) + `generation.retry`. Maintenance is
  WorkManager **unique one-time work** (`neotavern-maintenance` →
  `backups.create`) with `BATTERY_NOT_LOW` + `STORAGE_NOT_LOW` constraints —
  at-least-once, duplicates safe, best-effort timing with **no exact
  schedule** (§66), no boot-time daemon, no own scheduler (§87). No new
  JNI/FFI/contract/codegen surface: the wire registry and schema hash stay
  frozen (the only host addition is one additive bridge handoff entry
  point). API-level matrix 26/34 in nightly
  (`BackgroundExecutionInstrumentedTest` on API 26 + API 34 emulators),
  JVM unit tests for the new pure-Kotlin classes in PR `checks`. Docs:
  ADR-0036, `docs/android/README.md`, operations inventory.
- **Desktop Remote Access service (ТЗ 7.2 Фаза 9, §11.2/§10/§18.4).** New
  `crates/adapters/desktop-remote` (`neotavern-desktop-remote`) — a host
  service in the Tauri shell wrapping the Phase 4 `remote-http` adapter on
  the **same `Arc<Mutex<Kernel>>`** as local IPC (one writer): off by
  default (no listener until enabled in Settings → Remote Access), loopback
  default with an ephemeral port, non-loopback requires `trusted_proxy` AND
  auth (fail-closed pre-bind — `InsecureBind` / `PublicBindRequiresAuth`),
  pairing with revocable in-memory SHA-256-verifier credentials (token shown
  once, never logged or stored in plaintext; re-pair after restart — durable
  credential persistence deferred), CORS deny-by-default via
  `allowed_origins`, bounded secret-free audit, host-owned config at
  `app_config_dir/remote-access.json` (atomic write, never in the product
  DB), and a `kernel_remote_*` Tauri command surface (`remote` feature on
  `neotavern-tauri-local`) that controls the host service without touching
  the frozen wire registry (no contract/codegen change). The Settings panel
  gains the enable/pair/revoke UI in the desktop shell. Docs: ADR-0035,
  `docs/desktop/README.md`, operations inventory.
- **Phase 3 desktop local kernel mode (ТЗ §11.1/§15.1).** The Tauri shell
  now defaults to local kernel mode: the Runtime Kernel is embedded in the
  desktop process and the window loads bundled web assets over
  `tauri://localhost` — no HTTP server, no listening port, no server
  lifecycle. `React → LocalBackend → Tauri IPC → Runtime Kernel` via
  `crates/adapters/tauri-local` (`kernel_dispatch`, `kernel_stream_start`
  with a durable-log poller over a Tauri `Channel`, `kernel_stream_abort`),
  with the exact schema-hash/FFI-ABI handshake enforced at open (ТЗ §6.5).
  The legacy Node sidecar is opt-in via `NEOTA_LEGACY_SERVER=1` (transition
  bridge for unmigrated routes); kernel mode is smoke-tested with the server
  fully off. Desktop README and docs updated; ADR-0033 records the cutover.
- **Shared wire envelope layer (ТЗ §6.3).** `crates/adapters/envelope`
  (`neotavern-envelope`) now owns the request/response envelope mapping for
  every Kernel transport — CLI, remote-http and Tauri IPC answer
  byte-identical response envelopes; the CLI and HTTP adapter were migrated
  to it (no per-transport DTO copies).
- **`TauriTransport` for `LocalBackend`.** `apps/web/src/api/tauriTransport.ts`
  implements the same-process `LocalTransport` over Tauri IPC: contract
  envelopes in/out, product-vs-transport error split, live stream open with
  an eager independent promise chain and a manual async iterator (early
  consumer leave still aborts the opened run durably). `backend.ts` routes
  to `LocalBackend` inside the Tauri shell and keeps `LegacyBackend` in a
  browser; unmigrated legacy routes fail with a typed `UnsupportedError` in
  kernel mode. Covered by 13 new vitest tests (transport + routing).
- **First Phase 3 vertical slice: DiagnosticsPanel kernel section.** In the
  desktop shell the panel renders kernel metadata (`meta.get`) and backup
  count (`backups.list`) through the `NeoBackend` facade; hidden in a plain
  browser (ТЗ §60 availability). i18n keys added (en/ru).

- **Provider SDK contract tests (ТЗ §83).**
  `packages/provider-sdk/test/contract.test.ts` pins the public Provider SDK
  contract: config/base-URL validation, model listing, the unified stream
  contract (exactly one terminal event; usage arithmetic), AbortSignal
  cancellation (`GENERATION_CANCELLED`, no `done` after abort),
  `DeadlineController` timeout semantics, HTTP-status → stable error-code
  normalization with raw-body suppression, and timeout defaults/merging.
  13 tests against the offline EchoAdapter — no network required.
- **Dependency direction / forbidden-import gate (ТЗ §79/§6/§87).** New
  `scripts/check-dependency-rules.mjs` runs in the PR `checks` job: the
  Runtime Kernel's Cargo.toml must not depend on transport/UI/platform crates
  (denylist), the Kernel source must contain no `is_server`/`is_android`/
  `serverMode` branching, adapters may depend on the Kernel but never the
  reverse, and `packages/*` TypeScript never imports from `crates/` or
  `apps/` (Public SDK не импортирует Rust internal crates).
- **Nightly CI (ТЗ §80).** New `.github/workflows/nightly.yml`: scheduled
  daily run of the full Rust workspace suite (including the storage recovery
  matrix: DB support window, backup/restore kill-safety, data-root lease,
  export/legacy fixtures) on ubuntu + **Windows NTFS**, clippy/fmt gates, a
  scaled deterministic contract boundary fuzz (200k iterations over all 45
  generated decoders; any panic fails), the Phase 11 benchmark with report
  artifact, production dependency advisory scan (`pnpm audit --prod`,
  report-only until the graph is clean — current baseline: 12 high /
  2 moderate), and the TS regression baseline + docs integrity.
- **Contract boundary fuzz (ТЗ §80/§6.8).**
  `crates/contracts-generated/tests/fuzz_deserialization.rs` drives every
  generated `decode_*` fn with random raw buffers and structurally mutated
  fixture values (field deletion, wrong-type swaps, unknown keys, corrupt
  strings) under `catch_unwind` — a panic on arbitrary input is a test
  failure. Fixed-seed xorshift64 keeps the corpus reproducible;
  `NT_CONTRACT_FUZZ_ITERS` scales the budget.
- **Runtime Kernel + storage foundation (ТЗ 7.2 Фазы 0–2).** New `crates/`
  workspace: `contracts-generated` (deterministic Rust boundary DTOs from the
  TypeBox wire schemas), `runtime-kernel` (contract-validated dispatch,
  handshake, cancellation, durable storage attach) and `neotavern-storage`
  (exclusive data-root lease, pinned SQLite 3.53.2 baseline, migration ledger
  with checksums, immutable assets with orphan GC, Backup-API recovery
  snapshot, read-only Recovery Mode). A second writable process on the same
  data root gets a controlled `data_root_in_use` error.
- **Semantic contract diff (ТЗ §6.7).** `tools/contract-codegen/diff.mjs`
  classifies breaking/additive wire changes between canonical bundles;
  self-tested in CI (`diff-test.mjs`).
- **Headless Remote Adapter (ТЗ 7.2 Фаза 4).** New `crates/adapters/remote-http`
  (`remote-http-adapter`): a std-only tiny_http 0.12 adapter serving the frozen
  wire envelopes over `GET /meta`, `POST /rpc` and `POST /rpc/stream` (SSE) on
  the **same Runtime Kernel** as local IPC — one writer coordinator
  (`Arc<Mutex<Kernel>>`), no SQLite access, no product rules. Envelope-over-HTTP:
  valid envelopes always answer HTTP 200 with a `wire.response.envelope`;
  transport failures map to 400/404/405/413/426 with canonical error codes.
  Protocol negotiation (major equality, client minor ≤ server minor) is
  enforced before dispatch, so a mismatched client can never execute product
  writes; kernel product errors (`CHARACTER_NOT_FOUND`, …) pass through the
  error envelope verbatim. Security defaults: loopback-only bind, non-loopback
  requires an explicit `trusted_proxy` declaration (TLS-terminating boundary),
  bounded body/connection limits; TLS termination and pairing land with Phase
  4 hardening / Phase 9 (ADR-0030).
- **Mobile FFI ABI (ТЗ 7.2 Фаза 5, native bridge foundation).** New
  `crates/adapters/mobile-ffi` (`neotavern-mobile-ffi`): a minimal stable C
  ABI over the **same Runtime Kernel** for Android JNI / future Swift hosts —
  opaque `NtKernel`/`NtStream` handles, bounded length-delimited buffers,
  UTF-8 operation ids and stable integer status codes
  (`NT_OK` … `NT_ERR_MISMATCH`). Payloads are the identical Product Wire
  Contract bytes (`nt_call`/`nt_stream_start` → `Kernel::dispatch`/
  `dispatch_stream`), buffer sizes are checked before any allocation/parse
  (`MAX_REQUEST_LEN` 1 MiB; `NT_ERR_BUFFER` reports the required capacity),
  Rust allocations are freed only by the exported free functions
  (`nt_kernel_free`, `nt_stream_free`), and every entry point contains panics
  (`catch_unwind` → `NT_ERR_INTERNAL`). The `ffiAbiVersion` + `schemaHash`
  exact local handshake runs inside `nt_kernel_open`, so an incompatible host
  never receives a runtime handle and performs no product operations (§6.5).
  Streams wait via `nt_stream_wait` (committed/terminal sequence, durable
  `generation.events` replay) and cancel via `nt_stream_cancel` (§64). Docs:
  `crates/adapters/mobile-ffi/README.md`, wire-contracts §10,
  version-axes «Local FFI ABI».
- **Phase 5: Android Local foundation — JNI bridge, host, mobile transport,
  CI gates (ТЗ 7.2 Фаза 5, §13/§6.9/§5.4).** New
  `apps/android` (Gradle 8.9 / AGP 8.5.2 / Kotlin 1.9.24, compileSdk/
  targetSdk 35, minSdk 26, JDK 17) runs the **same Runtime Kernel** on the
  device: a WebView loads bundled web assets (no Node, no listening port,
  no HTTP, no arbitrary third-party JS) and talks to the kernel over a
  frozen JS bridge protocol (`window.__neotavernMobile` — sync
  `handshake()`, fire-and-forget `call(requestId, envelopeJson,
  callbackId)`, `cancelStream(streamId)`; async results via
  `window.__neotavernMobileCallbacks.resolve/reject` with
  `{kind:"event"|"terminal"|"error"}` stream payloads). The new
  `neotavern-android-jni` crate (cdylib + rlib, workspace member) is thin
  marshalling onto the mobile-ffi C ABI — envelope extraction in Rust, no
  hand-written Kotlin DTOs, opaque `jlong` handles, contained
  `KernelException`, no Rust panic crossing JNI. The TS side is
  `MobileBridgeTransport` (`LocalBackend` over it, byte-identical envelopes
  to `TauriTransport`, same typed `TransportError` split); the local
  profile routes to it as an explicit override while the default
  `createBackend()` routing stays unchanged. Data root
  `filesDir/neotavern`; secrets via Android Keystore AES/GCM with **no
  plaintext fallback** (typed `SecretStoreUnavailableError`); kernel open
  on a background executor, close on destroy, process-death durability via
  the kernel. The `.so` is built by `apps/android/scripts/build-libs.sh`
  (cargo ndk) into
  `app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so` and
  is **not committed**; Android compilation is verified in CI only
  (`android-build` job), JVM unit tests in PR `checks`, instrumentation on
  the nightly emulator. Docs: `docs/android/README.md`, ADR-0034.
- **Remote Access hardening (ТЗ §10, Фаза 4 hardening / Фаза 9).**
  `remote-http-adapter` gains the full remote-access security surface:
  pairing issues revocable scoped credentials (`pair` → `(id, token)`,
  SHA-256 verifier only, idempotent `revoke`, bounded by `max_credentials`),
  the auth gate runs **before** the body is read (401 `UNAUTHORIZED` with
  `WWW-Authenticate: Bearer` — `missing_credential` / `invalid_credential`;
  `/meta` stays public), a token-bucket rate limiter (keyed by credential id
  or peer IP, bounded bucket map) answers `429 RATE_LIMITED` with
  `Retry-After`, `max_streams` caps concurrent SSE streams (`rule:
  stream_limit`), live streams re-check the credential per frame batch and
  abort mid-stream on revocation (`credential_revoked`), CORS/Origin is
  deny-by-default (a browser `Origin` is admitted only on an exact match
  against the configured `allowed_origins` allowlist, otherwise 403
  `ORIGIN_NOT_ALLOWED` before dispatch; allowed origins get
  `Access-Control-Allow-Origin` + a 204 preflight), forwarded client headers
  are honored only from configured proxy addresses (`trusted_proxies`:
  `X-Forwarded-For` keys the rate-limit bucket only when the immediate peer
  is listed — rightmost chain entry not appended by a trusted proxy; from
  any other peer the header is ignored, so a client cannot self-spoof the
  bucket key), and every gate decision
  lands in a bounded audit ring without token material. A public non-loopback
  bind now requires BOTH `trusted_proxy` and configured `auth` — otherwise it
  is a startup error (`InsecureBind` / `PublicBindRequiresAuth`, §10). Docs:
  `crates/adapters/remote-http/README.md`, wire-contracts §6.1.
- **CLI transport (ТЗ §6.3, Фаза 4 CLI hooks).** New `crates/adapters/cli`
  (`neotavern-cli`): a std-only binary mapping one wire request envelope →
  one response envelope through the **same Runtime Kernel** and the same
  envelope layer as the HTTP adapter (decode → protocol check → dispatch →
  validated response; byte-identical answers). `--operation <id> '<payload>'`
  builds the envelope from the embedded manifest (protocol + `schemaHash` +
  generated v4 request id), `--envelope` reads a full request envelope JSON
  from stdin (bounded to 1 MiB, request id echoed). Stable exit codes: `0` =
  ok envelope, `1` = error envelope / pre-envelope transport failure, `2` =
  usage error. With `--root` the CLI holds the exclusive data-root lease for
  its run and a held lease answers `DATA_ROOT_IN_USE` (§22). Docs:
  `crates/adapters/cli/README.md`, wire-contracts §6.1.
- **Generation durability (ТЗ 7.2 Фаза 6).** Generation is now a recoverable
  workflow on the Runtime Kernel: wire registry grows 15 → 20 operations
  (`generation.get`, `generation.events`, `generation.retry`, `generation.keep`,
  `generation.discard`; schema hash `7e469552…`), storage migration 3 adds
  `generation_runs` + `generation_events` (schema revision 3), and the kernel
  gains a writer-coordinator thread (`Kernel` is now `Send + Sync`,
  `dispatch_stream` returns an `EventStream`). Durable state machine with
  CAS-by-revision transitions, executor lease, deterministic fake provider
  (`steps`/`fail-at`/`delay-ms`/`tokens-per-step` fault injection), per-step
  committed event log, atomic terminal commit (final message + terminal event
  in one transaction), and startup recovery of lease-expired runs to
  `interrupted`. The remote adapter streams real SSE for `generation.start` /
  `generation.retry` and resumes from `Last-Event-ID` via `generation.events`;
  Retry / Keep partial / Discard reconciliation commands are idempotent
  (ТЗ §62–§64). `NeoBackend` exposes the new generation API on all three
  backends with parity tests. Docs:
  `docs/architecture/generation-durability.md`.
- **Portable Built-in Providers (ТЗ 7.2 Фаза 7).** Provider execution is a
  portable contract, not kernel-internal code: new `crates/provider-sdk`
  (the `ProviderAdapter` trait with normalized errors/usage, `Deadline` /
  `RetryPolicy` policy primitives, `SecretRef`/`SecretValue`/`SecretResolver`
  config-secret separation, `CancelToken`/`EmitStatus` cancellation
  semantics) and `crates/built-in-providers` (deterministic `FakeProvider`
  ported byte-identical from the kernel inline fake, `RecordedProvider`
  replaying non-secret JSON fixtures, shared conformance suite proving
  cancel/timeout/no-double-billing/redaction). Storage migration 4 adds the
  `provider_configs` table (non-secret `config_json` + `secret_ref` only —
  secrets never enter the DB, snapshots, backups or logs). The wire registry
  grows 20 → 21 operations (`providers.list`, schema hash
  `b5333728…`); the kernel executor now resolves adapters through a
  `ProviderRegistry` with a host-provided secret-resolver seam and a 60s
  per-run deadline, and `NeoBackend` exposes `providers.list` on all three
  backends with parity tests. Docs: `docs/architecture/providers.md`.
- **Portable Data (ТЗ 7.2 Фаза 11).** The Phase 2 recovery primitives are
  now public long-lived formats: `.neotavern-backup` containers (manifest +
  checksummed inventory + the snapshot-pinned asset set, assembled in a temp
  dir and finalized atomically; `backups.create` / `backups.list` wire
  operations with a 16-container quota), kill-safe staged restore (candidate
  data roots activated by directory swap; a pending marker resolved at open
  completes or discards an interrupted activation — the active root is never
  overwritten), `.neotavern-export` NDJSON interchange with explicit
  duplicate policy (`reject`/`replace`/`remap`) and offline import through
  the same candidate machinery, and a read-only legacy converter for
  pre-kernel data roots (timestamps normalized, secrets/plugins never
  copied, source never mutated). Docs: `docs/architecture/portable-data.md`,
  ADR-0032, benchmark manifest `docs/architecture/benchmarks.md`.
- **NeoBackend UI routing.** Every web UI API call now routes through the
  `NeoBackend` facade (`apps/web/src/api/backend.ts`): typed wire operations
  via `LegacyBackend`, unmigrated `/api/v2` routes through the temporary
  `raw` passthrough (removed per-slice in Фаза 3).

- **Android APK client (remote server test).** Tauri 2 Android target:
  `#[cfg(desktop)]` sidecar/updater logic and `#[cfg(mobile)]` updater stubs;
  `tauri.android.conf.json` overrides the platform config; a plain
  `mobile-connect/` start page (no React, no Tauri API) remembers the server
  address, auto-navigates on fresh loads and lets the system back button
  return to the form. The APK connects to a NeoTavern server over LAN — no
  Node, no localhost backend on the device, cleartext HTTP only in debug
  builds via the manifest placeholder. Scripts: `desktop:android:init`,
  `desktop:android:dev`, `desktop:android:build`.
- **Non-destructive message edit history.** Real manual text edits now archive the
  previous content with CAS-safe restore, cursor pagination, checkpoint/branch copying,
  and chat export v2. Swipe/regenerate variants remain a separate history.
- **ST1-style message details.** Mobile details now provide a horizontally scrollable
  action row, Copy / + / Edit footer, drag-down dismissal, a grouped Danger zone, and
  plugin actions that adapt to circle or list presentation without SDK changes.


### Fixed

- **Android: backgrounded generation is no longer silently dropped (Фаза 8).**
  An active user-visible generation that used to stop being driven when the
  app left the foreground (WebView throttled, process trimmed/killed without
  a notification) now continues through the bounded foreground service on
  the shared kernel handle; user Stop and OS expiration cancel the run
  explicitly via `generation.cancel` instead of abandoning it, and a killed
  process resumes through kernel startup recovery + `generation.retry`.
- **Phase 9 CI gate (3cb5f87).** The feature-gated `neotavern-tauri-local`
  test/clippy step now runs with `working-directory: crates` (the workspace
  root — previously it failed with "could not find Cargo.toml" from the
  repo root), and the Remote Access status badge uses the `--st-radius-round`
  token instead of a hardcoded `999px` radius (theme-sdk style contract,
  AGENTS.md §14).
- **Token counter now matches the model's real tokenizer.** DeepSeek models
  (`deepseek/*`, `deepseek-chat`, `deepseek-reasoner`, local checkpoints) are
  counted with an exact counting-only byte-level BPE engine (ranks of
  `deepseek-ai/DeepSeek-V4-Flash`, converted once into a ~1.4 MB compact file
  cached in `data/cache/tokenizers/`, atomic write, offline falls back to the
  explicit approximate estimate), so Russian and other non-English text no
  longer shows a ~10% discrepancy versus the provider's usage. The remaining
  approximate fallback is script-aware (Latin ~4.6, Cyrillic ~4.0, CJK ~1.7,
  digits ~2.0 chars/token) and the web draft estimate uses the same function
  as the server instead of a divergent constant.
- **Chat viewport pins to the newest message on every open.** Switching chats
  in-app (sidebar, back-to-parent, checkpoint links) now deterministically
  lands on the newest message even when the target chat is served from the
  query cache with an equal message count — previously the viewport could
  stay at the previous scroll position and show the greeting.
- **Generation no longer hides behind the composer.** The pinned position is
  now the absolute bottom of the scroll container instead of an end-anchor
  alignment, so the streaming reply grows fully visible above the input field
  and manual scrolling is not yanked back on every flush.
- **The user's message appears instantly on send.** An optimistic pending
  bubble renders the message before the server confirms it, then swaps to the
  confirmed message without duplicates; after an error or Stop the persisted
  message is re-synced instead of staying invisible until reload.
- **Resizable settings sidebar.** A legacy compact-density preference no longer
  pins the navigation panel to 340 px, so drag and keyboard resize once again
  update both the panel and shifted chat. The General startup choice now uses
  the same full-width segmented control as Contrast instead of a switch.
- **Message action placement.** Editing, copy, regenerate and related controls now appear at the opposite edge of the message header from the author, instead of below the message body.
- **Unified live context preview.** Home and existing chats now use the same
  debounced preview hook and side-effect-free prompt pipeline. Changing context
  size, the composer draft, or chat history immediately invalidates the same
  query instead of leaving `/chats/:id` on the previous generation audit.
- **NanoGPT generation capabilities.** NanoGPT now enables its documented
  extended samplers and reasoning-effort selector. Provider capabilities expose
  accepted effort values, and the adapter omits unsupported `max` instead of
  sending an invalid request.

- **Remote image links render in single-process mode.** The CSP `img-src`
  directive now trusts `http:`/`https:` in addition to same-origin, `data:`
  and `blob:`, so markdown image links in chat and character cards load on
  the single-process server (`ST2_WEB_DIR`) exactly as they do behind the
  Vite dev server. Scripts remain strictly same-origin.

- **Single-process web serving trusts its own origin.** With `ST2_WEB_DIR` set,
  the CORS allowlist defaults to the server's own origin instead of the Vite
  dev origin, so CORS-mode asset loads (`<script type="module" crossorigin>`)
  no longer fail with "Not allowed by CORS" on every request.
- **Provider source changes preserve the selected API key.** The provider editor
  no longer sends a hidden `apiKey: null` patch when switching between catalog
  sources, so a visibly selected NanoGPT key remains active and connection
  validation no longer fails with `PROVIDER_CONFIG_INVALID`.

- **Accurate reasoning controls.** OpenAI-compatible profiles now hide the
  unrelated Anthropic reasoning switch, expose provider-default plus the full
  `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` effort superset, and warn
  that availability is model-specific. Anthropic keeps its explicit adaptive-
  thinking switch and only offers `low`/`medium`/`high`; unsupported foreign
  effort values are omitted instead of silently becoming `low`.
- **Deterministic plugin runtime delivery across CI platforms.** Backend module
  containment now canonicalizes package roots before validating package-local
  imports (including macOS `/var` aliases), streamed route bodies stay buffered
  until the HTTP consumer attaches and replenish worker credit after drain, and
  retryable jobs persist `dispatchAt` before publishing their due event so a
  same-turn acknowledgement cannot be lost.
- **Cross-platform CI and Plugin Runtime paths.** Files API confinement now
  compares canonical roots with the nearest existing target ancestor, allowing
  macOS `/var` to `/private/var` aliases while rejecting writes through escaping
  directory symlinks. The SIGTERM test waits for the child handler handshake,
  Theme starter archives normalize text to LF, Playwright runs against the
  checked-in Windows visual baselines, and GitHub Actions use Node 24-based
  action releases.

### Changed

- **Simplified variant controls.** The Variants picker button and popover were removed; the N/M counter and previous/next arrows remain.
- **ST1-height inline editing.** Editing a message now expands the textarea to the full height of its text, without an inner scrollbar.
- **Home now continues recent conversations.** Home shows an ST1-style
  expandable vertical list of the eight most recently updated chats across all
  characters. Character selection continues the latest conversation or creates
  one when needed while keeping preview open; explicit New chat reuses a
  greeting-only conversation until it receives user input, preventing empty
  duplicates. A default-on General setting opens Home only on
  initial load, while disabled mode preserves reloads and direct links. The
  chats API adds backward-compatible `sort=recent` and character metadata.
  Home also shows `NeoTavern <version>` with Docs/GitHub/Discord links and
  replaces All chats with a dismiss-and-restore Recent chats control.


- **Literal cleanup in `packages/ui` component styles.** `components.css` now
  resolves border widths, overlay viewport limits, the mobile dialog-sheet
  height and the inner menu radii through the new tokens (`border-width`,
  `radius-inset`, `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`) instead of hardcoded `1px`/`92vw`/`60vh`/`88dvh`/
  `calc(... - 4px)` literals; rendered output is unchanged.
- **Reusable `SurfaceDialog` shell + Edit prompt on the same chrome as Plugins.**
  The glass manager dialog (size, close control, `data-component="system-surface"`)
  is extracted to `SurfaceDialog`; route `SystemSurface` and
  `PromptBlockEditorDialog` both mount content inside it. Edit prompt is a
  Plugins-style page (eyebrow/header/actions + bordered panels), not a
  one-off dialog skin.

### Added

- **ST1 message actions: swipe history, checkpoints/branches, regenerate in
  place, and MessageActionDef v2.** Migration `0020_swipe_history_and_child_chats`
  gives every stored variant a 0-based `position` (backfilled by
  `(created_at, id)`, UNIQUE per message) and adds
  `messages.variant_count` / `active_variant_position` — positions form a
  permutation of `0..variant_count-1` with exactly one hole, the active
  content, which lives in `messages.content` — plus the child-chat provenance
  columns `chats.parent_chat_id` / `origin` / `source_message_id` and the
  checkpoint flag `messages.checkpoint_chat_id`. Swiping is a non-destructive
  position swap through the new `POST /chats/:id/messages/:messageId/swipe`
  (`{position, expectedRevision?}` → `Message` | 409 `MESSAGE_CONFLICT`); the
  legacy `variants/:variantId/activate` route keeps working, accepts an
  optional `{expectedRevision}` body and is non-destructive too. Regenerate
  rewrites the last assistant reply in place: the generate route accepts
  `regenerateMessageId` (stale target fails fast with 409
  `REGENERATE_TARGET_MOVED`) and archives the old text atomically with the
  done write, so an error or abort persists nothing. New
  `POST /chats/:id/snapshots` (`{messageId, kind: 'checkpoint'|'branch',
  replace?, title?}` → `{chat, copiedMessages}`) copies the active-branch
  prefix up to the target message in 500-row keyset batches into a child chat
  (raw `meta`, variants and persistent plugin blocks preserved, `parentId`
  remapped; child inherits character/persona/background/summary; default title
  `«{parent} — checkpoint|branch»`; `replace` only repoints the checkpoint
  flag — the old child chat is never deleted). UI: the message action bar is
  always visible (primary group + «Ещё» overflow at this stage; later
  superseded by the fully inline row and the mobile details card — see the
  adaptive actions entry below), the inline editor saves
  with `Ctrl/⌘+Enter`, cancels with `Escape` and keeps the draft on CAS
  conflict with an inline error, streaming regenerates in place (no second
  bubble), the swipe pager shows `N/M` plus a lazy variant picker, and the
  checkpoint flag opens / replaces (`Shift+click`) / unlinks with a toast
  carrying an «Open» action and a back-to-parent button in the child chat
  header. Plugin SDK: `MessageActionDef` v2 — `run()` now receives an
  immutable message snapshot (`message`) and an `AbortSignal` (**breaking**
  addition; `messageId`/`chatId` stay top-level so old callers keep working),
  optional `icon` (semantic names with host fallback), `order` and
  `placement: 'primary'|'overflow'`; `message.content` is `null` unless the
  plugin holds both `ui.messageActions` and `chat.read` (adding `chat.read`
  re-triggers consent); legacy `contextMenuItems` with `context: 'message'`
  still render in the overflow menu. Sample plugin `plugins/rev4-translate/`
  demonstrates the content contract without any external service. Docs:
  `docs/api/README.md` (§ «Чаты и сообщения», «Генерация (SSE)»),
  `docs/data/README.md` (§ «Свайп-история и child-чаты (миграция 0020)»),
  `docs/migrations/README.md` (§ 0020), `docs/ux/README.md` (§ 10.2, 10.4,
  10.6, 10.8), `docs/plugin-sdk/README.md` (§ «Message actions (v2)»),
  `docs/plugin-sdk/rev4-api.md` (§ «message actions (MessageActionDef v2)»).
- **Generation metadata (`messages.meta.generation`).** New replies and
  regenerations persist `generationId`, `providerConfigId`, `providerKind`,
  `providerSource`, `model`, `durationMs` (measured directly around the
  provider call) and `usage` (`promptTokens`/`completionTokens`/`totalTokens`,
  `null` when the provider reports none); legacy `meta.model` stays for
  compatibility. No DB migration — `meta` is already JSON. The typed contract
  exports `parseMessageGenerationMeta` (strict per-field, lenient to extra
  keys, never throws) so old and corrupted metadata render safely without
  placeholder values. Docs: `docs/data/README.md` (§ «Метаданные генерации»),
  `docs/api/README.md` (§ «Генерация (SSE)»).
- **Adaptive message actions: inline desktop row + ST1 mobile details card.**
  Above `600px` the message header shows every applicable built-in and plugin
  action in one inline row (context, edit, copy, regenerate, checkpoint,
  branch, delete-checkpoint, delete, plus all plugin actions — the «Ещё»
  overflow menu is gone). At ≤`600px` the header keeps only Edit and Details:
  Details opens an accessible bottom-sheet card (drag handle, avatar, author,
  Sent/Model/Generation-time rows — only really stored values, horizontal
  scrollable action panel, rendered message text, pinned Copy/Exclude/Edit
  footer); Edit opens the same card in full-size edit mode, Cancel closes it
  (or returns to details when edit was opened from there), a failed save keeps
  the card open with an inline error. Branch/checkpoint/regenerate close the
  card first; delete/remove-checkpoint close it and open the existing
  confirmation. The card ships stable theme hooks
  (`data-component="message-details-card"`, documented `data-part`/`data-state`
  set), focus trap and focus return, Escape/backdrop draft discard, safe-area,
  RTL logical properties and ≥44px touch targets. Docs:
  `docs/ux/README.md` (§ message action bar + mobile card hooks),
  `docs/plugin-sdk/README.md` + `docs/plugin-sdk/rev4-api.md`
  (host renders `placement: 'primary'|'overflow'` actions in the same row).
- **Generation races fixed.** The regenerate archive now persists **before**
  the SSE `done` event is emitted, so the client's post-done message refetch
  never sees the stale variant count (the swipe pager could stick at `N-1/N`
  after the second in-place regenerate). The streaming client surfaces a
  `GENERATION_FAILED` error when a connection ends without a terminal event
  instead of leaving the composer stuck in the generating state, and the echo
  provider paces its chunks so the Stop button has a real clickable window.
  Deep links (`/chats/:id`, system surfaces, OAuth) are no longer hijacked by
  the `openHomeOnLoad` startup redirect — it now applies only to a bare-root
  load — and a message row with its «Ещё» overflow menu open is lifted above
  the sticky composer so menu items stay clickable.
- **New `@st2/ui` primitives + theme tokens.** `Badge` (pill with
  `default`/`success`/`danger` tones and an optional decorative icon slot),
  `Segmented` (segmented radio group) and `SelectField` (Field-style labelled
  native select) are exported from `@st2/ui` with `data-component`/`data-part`
  hooks and token-only styles. `PromptBlockEditorDialog` now uses the shared
  `SelectField` (its local copy and `.select` CSS are removed).
  The theme contract gains five canonical tokens (all three contract places):
  `border-width` (`1px`, new Borders group), `radius-inset` (`4px`, Radii
  group) and the Viewport limits group `overlay-width-limit` (`92vw`),
  `overlay-height-limit` (`60vh`), `dialog-sheet-height` (`88dvh`); values
  match the literals they replace, so visuals are unchanged.
- **Per-model prompt blocks.** Each prompt block (host and `custom-*`) can be
  bound to one model id in its edit dialog (`PromptBlockEditorDialog`) through
  the same reusable `ModelMenu` as the provider editors (models of the active
  provider via «Load models»; free text allowed; empty value means every
  model). The prompt pipeline excludes blocks whose binding does not match the
  active model; the audit reports the new `model-mismatch` exclusion reason
  («Bound to a different model»). `PromptBlockSettingsSchema` gains the
  optional `model` field (max 256 chars); templates without it behave exactly
  as before. Docs: `docs/prompt-pipeline/README.md` (§ Prompt templates),
  `docs/api/README.md` (§ settings).
- **Reusable model menu (`ModelMenu`) + frontend Plugin SDK models surface.**
  The model picker is extracted into one reusable component
  `packages/ui/src/components/ModelMenu.tsx` (searchable combobox + «Load
  models» action + status line, token-styled via `data-component="model-menu"`
  and `data-part` hooks) and replaces the hand-rolled input/datalist + model
  select in `ProviderProfileEditor` and the plain input in
  `ConnectionProfileEditor` (AI Settings API tab and Providers page). The
  `Combobox` it wraps now seeds the search box with the committed value on
  focus (editing a model id no longer corrupts it) and stays open when the
  anchor input itself is focused (Radix outside-interaction fix). Frontend
  plugin SDK gains `models.list` on the web kernel (optional `providerId`
  defaults to the active provider config, capped at `MODELS_MAX_LIST`,
  `NOT_FOUND`/`VALIDATION_FAILED`/`CAPABILITY_DENIED`) and the sandbox
  surfaces `api.models.list(providerId?)` plus the ready-to-mount
  `api.ui.modelMenu(container, options)` widget (vanilla, mirrors the host
  `ModelMenu` skin through host theme tokens shipped in the kernel handshake
  (`HostHandshake.themeTokens`) and re-pushed on theme changes via
  `st2.plugin.tokens` — resolved values, var() chains unwrapped host-side;
  built-in CSSOM `prefers-color-scheme` palette remains the fallback only.
  The widget carries the same `data-component="model-menu"` /
  `data-part` / `data-tone` markers as the host component). Sample plugin
  `plugins/rev4-modelmenu/` with full e2e cycle in
  `e2e/rev4-samples.spec.ts` (including host-token color parity
  assertions). Docs: `docs/plugin-sdk/rev4-api.md`
  (§ «models и модельное меню»), `docs/plugin-sdk/README.md`,
  `docs/ux/README.md`, `packages/ui/README.md`.
- **§58 Final acceptance statement (Plugin SDK vNext M6).** New
  `docs/plugin-sdk/vnext-acceptance.md` maps every §58 clause to concrete
  evidence (implementation files, tests, benchmark gates) and tracks the
  DoD §56 checklist. Stage H (part 28), Stage I (part 29) and Stage J
  (part 30) are closed; the remaining CI-owned items — 24h soak (B17) and
  Linux/macOS runs (B18) — run in the new `plugin-runtime-platforms`
  matrix job (ubuntu-24.04 / windows-latest / macos-14) which executes the
  full suite, the B01–B31 bench with default gates and the parity recorder
  on every OS and uploads the reports as artifacts.
- **Cross-platform parity recorder (Plugin SDK vNext Stage J, part 30).**
  `scripts/platform-parity.mjs` runs the identical conformance smoke
  (lockdown before plugin code, noNodeAuthority, module-graph load, broker
  echo round-trip, warm reload) plus cold-start p50/p95 on every supported
  OS/arch and writes `platform-parity-<os>-<arch>.json` (B18/§44/§46/§56).
  Windows x64 report recorded (PARITY OK: cold p95 9.9 ms, broker call
  0.36 ms, warm load 5.3 ms); Linux/macOS run the same script in CI.
  Platform-sensitive runtime code is confined to host-adapter level:
  `path/win32` in the graph-builder builtin list and the documented
  win32 SIGTERM guard in `processHandles` (Windows does not run JS signal
  handlers on SIGTERM). Full vitest suite green on Windows: 114 files /
  1387 tests.
- **Benchmark harness B01–B31 (Plugin SDK vNext Stage I, part 29).**
  `apps/plugin-runtime/bench/bench-vnext.mjs` runs the §47 scenarios
  against the runtime's public dist API and gates them on the §46 SLOs:
  idle RSS, 30 installed / 15 cold plugins with zero Workers, 15
  blank-hardened Workers (lockdown p50/p95), >1 GiB legitimate allocation
  survival (B05), CPU-heavy completion (B07), infinite-loop
  force-termination with a live host (B08), 1 GiB bounded-RSS workload
  (B10), cold fanout (B19), warm retention without Worker recreation
  (B20), IPC control storm with zero runtime body decodes (B21), event
  fanout with handle-only envelopes (B22), missing-globals compatibility
  (B26), WASM/SAB invisibility (B27), hostile execArgv/env injection
  (B28), stale-epoch respawn (B29), 2000-call SDK flood with bounded RSS
  (B30) and 200k-line log flood through the bounded ring (B31). Scenarios
  already covered by dedicated suites (B06, B09, B11–B18, B23–B25, B32,
  B43–B47) are mapped to their test files and asserted present. Gates are
  env-overridable (`BENCH_GATE_*`); `--heavy` adds the >1 GiB scenarios,
  `--report-only` never fails CI, `--json` writes the machine report. All
  gates pass in default and `--heavy` modes. Documented the §9.1
  compatibility profile in `@st2/plugin-runtime` README, including the
  SES design exclusion of Float32/Float64Array (NaN side-channel).
- **Build/publish pipeline (Plugin SDK vNext Stage H, part 28).** New
  `packages/plugin-build` package with the `st2-plugin` CLI:
  `analyze` (§51/§52 — Node builtin imports with `@st2/node-compat`
  suggestions, platform payload hard gates via PE/ELF/Mach-O magic sniff,
  install scripts, dynamic imports, WASM stats, suggested §12
  capabilities), `build` (§8 zero-build mode: plain JS copied, TS
  transpiled through the pinned `typescript` compiler, per-file sha256
  digests + `sourceDigest`, signed `dist/backend/artifact.json` when a
  private key is provided), `sign`/`verify` (Ed25519 §36, keyId
  fingerprint pinning — a changed publisher key is detected before
  signature verification, `PUBLISHER_KEY_CHANGED` /
  `PACKAGE_SIGNATURE_INVALID`), and `genkey`. Build-time SES
  compatibility gate `--ses-gate` (§6.5/§8.10, benchmark B25): the final
  source-first module graph is imported under the exact production
  boundary — real Node Worker + `lockdown(moderate)` + one SES Compartment
  — and the build fails with the documented error code on
  incompatibility; marketplace ingestion reuses the same gate. Runtime
  (`plugin-runtime`) ships no dependency-install path and resolves no
  plugin `node_modules` at runtime (§7.2). `PluginManifest` gained
  `publisher.keyId` + `signature`; the v4 capability catalog appended the
  vNext §12 names. Tests: 19 (analyze 5, signing 6, build 6, ses-gate 2).
- **§33 Secrets API (Plugin SDK vNext Stage E, part 27).** OAuth-backed
  secrets through the Broker; the token value never leaves Main Host.
  Contracts (`sdkOps.ts`): `secrets.use` `{ connectionId (≤64 B) }` →
  `{ handle, serviceId, expiresAt? }`; `secrets.manageOwn` `{}` → redacted
  connections (≤ 100); `secrets.reveal` `{ connectionId }` →
  `{ accessToken, tokenType?, expiresAt? }`; bounds `SECRETS_MAX_LIVE` (16
  per plugin). Executor (`memoryHost.ts`): `secrets.use` mints an opaque
  `sec-…` handle via the injected `secretsProvider` and registers it in a
  per-plugin live store; the handle feeds `network.fetch`'s `secretId`
  (§29.1.5 — the host injects the Authorization header and pins the
  destination origin; a handle minted for another plugin is unknown,
  `NETWORK_SECRET_NOT_FOUND`); `secrets.reveal` is gated on
  `trustLevel === 'trusted'` in addition to the grant (§11.3), otherwise
  `TRUST_REQUIRED`; revoking a secrets capability closes the plugin's live
  handles (§10.2). Host (`vnextBrokerHost.ts`): `createHostSecretsProvider`
  reuses the OAuth connections repo (`authConnections.ts`, ADR-0016) with
  the same status/expiry semantics; the bound origin comes from the plugin
  manifest's declared `authClients` authorization URL or an injected
  `secretOriginResolver`; failures surface as AUTH_CONNECTION_NOT_FOUND /
  AUTH_REVOKED / AUTH_NOT_CONNECTED / AUTH_TOKEN_INVALID / AUTH_EXPIRED /
  AUTH_ORIGIN_UNKNOWN. Worker SDK: `sdk.secrets.use/manageOwn/reveal` with
  fail-fast validation. Tests: 5 unit (mint + header injection + origin
  mismatch, foreign-plugin handle, manageOwn + reveal trust gate, revoke +
  cap, denial + missing provider) + 3 worker e2e + 1 full-stack (real
  Worker → `sdk.secrets.use` → mint → `network.fetch` with the handle →
  Authorization header observed host-side; reveal stayed gated at sandbox
  trust). Stage E (M4) is now complete.
- **§34 Services API (Plugin SDK vNext Stage E, part 26).** Brokered
  cross-plugin calls: `services.provide` / `services.connect` /
  `services.respond` with no direct JavaScript references between
  Compartments. Contracts (`sdkOps.ts`): provide `{ name (≤128 B), version
  (≤64 B), methods (1..32 × ≤128 B) }` → `{ serviceId }`; connect `{ name,
  version, method, args (≤16 KiB JSON), deadlineMs (≤300 s) }` → `{
  result }`; respond `{ callId, ok, result | error }`; bounds
  `SERVICES_MAX_PENDING` (64 per plugin). Executor (`memoryHost.ts`):
  host-side registry name@version → provider plugin; `services.connect`
  checks the §26.2.1 causal chain — a provider already on the path fails
  fast with `SERVICE_CALL_CYCLE` before anything is pushed; pending calls
  are deadline-bounded (`OPERATION_DEADLINE`, the abort reason is
  propagated instead of masked); the injected `serviceCallSink` pushes
  `{ kind: 'service-call', envelope }` to the provider's worker (broker
  host `vnextBrokerHost.ts` keeps a `workerByPlugin` map registered when a
  `services.provide` RPC succeeds and pruned on `workerTerminated`; a dead
  provider surfaces as `SERVICE_UNAVAILABLE`); only the provider can settle
  a call (foreign/stale responds are idempotent `{ ok: false }`); revoking
  a services capability drops the plugin's registrations and settles
  in-flight calls in both directions (§10.2). Worker SDK:
  `sdk.services.provide(options, handler)` keeps the handler locally and
  `sdk.services.connect(...)` forwards the received causal chain (the host
  appends the caller id when pushing), with fail-fast validation; bridge
  `service-call` dispatch runs the handler and settles via
  `services.respond`. Tests: 7 unit (sink round-trip, cycle, NOT_FOUND /
  VALIDATION_FAILED / provider-down, duplicate + foreign respond, revoke,
  deadline, denial) + 3 worker e2e (provide + push with the received
  chain, denial, worker-side validation with zero wire calls) + 1
  full-stack (two real Workers: A→B round-trip and the A→B→A cycle that
  fails deterministically with SERVICE_CALL_CYCLE surfaced as the method
  result — B43).
- **§19/§27 Jobs API (Plugin SDK vNext Stage E, part 25).** `jobs.register`
  / `jobs.cancel` / `jobs.list` through the Broker, one capability
  (`jobs.background`). Contracts (`sdkOps.ts`): `jobs.register` takes a name
  (≤ 128 B) and exactly one of `intervalMs` (100..2^31-1) or `atMs`
  (0..2^31-1), optional payload ≤ 64 KiB; result `{ jobId }`; bounds
  `JOBS_MAX_PER_PLUGIN` (8) and `JOBS_MIN_INTERVAL_MS` (100). Executor
  (`memoryHost.ts`): host-side scheduler — timers live in the trusted host,
  the Worker never stays resident for `setInterval` (§19); repeating jobs
  re-arm themselves, one-shot jobs self-remove after firing; the injected
  `jobPushSink(pluginId, envelope)` delivers `{ kind: 'job-run', envelope }`
  to the owning worker (broker host `vnextBrokerHost.ts` keeps a
  `jobWorkers` map registered when a `jobs.register` RPC succeeds and pruned
  on `workerTerminated`; pushes to a dead worker are dropped); revoking
  `jobs.background` cancels the plugin's timers (§10.2), executor `close()`
  cancels all. Worker SDK: `sdk.jobs.register/cancel/list` plus
  `sdk.jobs.onRun(callback)` — the callback binds to a job through an
  `onRun` token passed to `register` (bound to the jobId after the wire
  response), backed by a bounded 8-entry map, dispatched via bridge
  `job-run` messages; fail-fast validation (exactly-one schedule, bounds)
  keeps invalid calls off the wire. Tests: 7 unit (register/list/cancel,
  exactly-one schedule, one-shot fire via sink, interval re-fire + cancel,
  revoke cancels, 8/plugin cap, denial) + 3 worker e2e (typed register +
  list, capability denial, worker-side validation with zero wire calls) + 1
  full-stack (real Worker → `sdk.jobs.register` → host timer → job-run push
  → callback → console through the §9.1.1 log router).
- **§13/§32 Process API (Plugin SDK vNext Stage E, part 24).**
  `process.spawn` / `process.output` / `process.signal` / `process.wait` /
  `process.close` through the Broker (all admit with `process.spawn`).
  Contracts (`sdkOps.ts`): spawn args (absolute executable path, args ≤ 64
  × 1 KiB, cwd, env ≤ 64 entries, timeoutMs ≤ 1 h, stdout/stderr capture or
  ignore); bounds 16 live processes per plugin, output ring 64 chunks ×
  64 KiB × 8 MiB (§32.4). New `apps/plugin-runtime/src/host/processHandles.ts`:
  trusted children stay host-side; always `shell:false`, `detached:false`,
  sanitized env (§32.1); scoped mode confines executable + cwd by host
  policy (`processScope`; manifest-derived scopes arrive with Stage H),
  mismatch fails with `PROCESS_SCOPE_DENIED`; unrestricted mode requires the
  separate `system.unrestricted` grant, otherwise
  `SYSTEM_UNRESTRICTED_REQUIRED` (§32.2); spawn failures (ENOENT) reject the
  call, post-spawn errors surface through the bounded stderr ring; timeout
  kills with SIGKILL; `kill()` targets the immediate child only —
  descendant containment is not guaranteed in pure Node (§32.3) and is
  documented, not promised; revoking a process capability kills the
  plugin's children (§10.2); `closeAll` awaits child exits. Worker SDK:
  `sdk.process.*` with fail-fast validation (bare executable names refused —
  absolute paths only). Tests: 9 unit (spawn + capture, missing executable,
  cwd scope, unrestricted gate, timeout kill, SIGTERM exit, revoke cleanup,
  ring bound, handle cap) + 3 worker e2e (spawn through the typed SDK,
  capability denial, worker-side validation) + 1 full-stack (real Worker →
  `sdk.process.spawn(node -e)` → host child → captured output over the full
  wire).
- **§29 Socket API (Plugin SDK vNext Stage E, part 23).** `network.websocket`
  / `network.tcp` / `network.listen` / `network.udp` through the Broker,
  one §12 capability per family. Contracts (`sdkOps.ts`): handle-based
  methods (open/connect → opaque id; send/receive/close; listen
  open/accept/close where accepted connection ids are managed by the
  `tcp.*` methods); bounds: 32 live handles per plugin, 128-message ring ×
  64 KiB per message × 8 MiB buffer per handle (§17 evict-oldest), receive
  limit 64, wait ≤ 5 s. New `apps/plugin-runtime/src/host/socketHandles.ts`:
  trusted sockets stay host-side (the plugin never touches raw Node
  sockets); bounded message rings with waiters; outbound destinations pass
  the same §29.1 SSRF scope policy as `network.http.fetch` (loopback
  requires `network.local` etc.); bind policy §29.1.4 — loopback by
  default, `0.0.0.0`/`::` always rejected, non-loopback bind requires
  `network.listen.public`; revoking a network capability closes the
  plugin's handles (§10.2); executor shutdown closes everything. Worker
  SDK: `sdk.network.websocket/tcp/listen/udp` with fail-fast validation.
  Tests: 9 unit (tcp echo round-trip, SSRF denial, listen loopback with
  per-connection handles, bind policy, udp round-trip with remote endpoint
  info, ring eviction, revoke cleanup, handle cap, closed semantics) + 3
  worker e2e (tcp echo through the typed SDK, capability denial,
  worker-side validation) + 1 full-stack (real Worker → `sdk.network.tcp`
  → host socket → echo server over the full wire).
- **§30 Files API (Plugin SDK vNext Stage E, part 22).** First Stage E
  (Full SDK) slice: `files.read` / `files.write` / `files.stat` /
  `files.list` / `files.rename` / `files.remove`, all under the
  `files.plugin` capability (plugin-owned data directory). Contracts
  (`packages/contracts/src/sdkOps.ts`): args schemas + catalog entries +
  method constants, bounds `FILES_MAX_PATH_BYTES` (1024), `FILES_MAX_CONTENT_BYTES`
  (4 MiB), `FILES_MAX_LIST` (1000). Executor (`memoryHost.ts`): `filesRoot`
  resolver (production: `join(pluginsRoot, pluginId, 'data')` wired via
  `createVNextRuntimeService({ filesRoot })` → broker policy → executor;
  `plugins.ts` provides it), path confinement — absolute paths, drive
  letters, backslashes and `..` segments are rejected; after `resolve` the
  real path is re-checked so a symlink cannot escape the plugin root;
  atomic writes (temp + rename), bounded reads, symlink-free listings,
  per-plugin root isolation. Worker SDK: `sdk.files.*` with fail-fast
  worker-side path validation that never reaches the wire. Tests: 9 unit
  (round-trip, traversal/absolute/backslash denial, symlink escape, size
  cap, per-plugin isolation, grant denial) + 3 worker e2e (round-trip,
  denial, worker-side validation) + 1 full-stack (real Worker → `sdk.files`
  → file on disk inside the plugin data dir).
- **§8.1 persistent module-map cache (Plugin SDK vNext Stage B, part 21).**
  The last open Stage B plan item. New
  `apps/plugin-runtime/src/graph/moduleMapCache.ts`:
  `packageSourceDigest` (sha256 over the sorted package files — rel path +
  content), `resolveModuleMapVersions` (Node / SES / @endo-module-source /
  @st2-plugin-runtime versions), `moduleMapCacheKey` = sha256(sourceDigest +
  NodeVersion + SESVersion + EndoCompilerVersion + ST2LoaderVersion) — any
  component upgrade invalidates the cache, and the canonical source stays
  the single source of truth (compiled records are not the plugin ABI).
  `ModuleMapDiskCache` does atomic writes (temp file + rename, §12), treats
  corrupt/unknown entries as misses (fully removable, self-rebuilding cache,
  §20), bounds entries at 8 MiB and stores `<key>.json` under
  `data/cache/plugin-module-maps`. Integration:
  `createVNextRuntimeService({ moduleMapCacheDir })` — `buildGraph` consults
  the cache keyed by source digest before compiling (hit: stored graph +
  warnings; miss: build + put); `plugins.ts` wires the cache directory.
  Tests: 10 unit (key stability, invalidation on any component change,
  round-trip, corrupt → miss, atomicity, clear, version switch) + 1
  full-stack (two activations of unchanged source = one entry and identical
  `graphDigest`; source change = second entry).
- **§6.5/§6.6 SES Compatibility Corpus gate (Plugin SDK vNext Stage B,
  part 20, benchmark B25).** New `apps/plugin-runtime/src/corpus/`:
  `corpus-manifest.json` is a versioned manifest (package, entry,
  `expect: pass|fail`, `expectedError`, reason) and `corpus.test.ts` imports
  every entry under the exact production boundary — a real Worker +
  `lockdown(moderate)` + one SES Compartment. `loadCorpusPackage.ts` is the
  first concrete dependency-vendoring step of the build pipeline (§7.2):
  the package and its transitive bare-import dependencies are vendored into
  a flat `node_modules/<pkg>/...` tree and bare specifiers are rewritten to
  relative imports (import / export-from / dynamic-import only), with
  archive-safety bounds (§8.7: ≤128 files, ≤512 KiB per file, ≤4 MiB total,
  depth ≤4). Pass entries must report `module-graph-loaded` with non-empty
  exports; fail entries must produce the documented error code (the
  `errorTaming: 'safe'` stack may be censored, so the code is the gate).
  Initial corpus: five Endo-family passes (`@endo/hex` including its
  transitive `@endo/harden` dependency, `@endo/immutable-arraybuffer`,
  `@endo/trampoline`, `@endo/path-compare`, `@endo/env-options`) and one
  documented failure (`@fastify/error` — CommonJS parses as ESM and fails at
  evaluation with `MODULE_EVALUATION_FAILED`; the vendoring path is
  build-time transpilation, §7.2). Corpus packages are pinned devDependencies
  of `@st2/plugin-runtime`. The gate must run on every Node/SES/@endo upgrade
  (§6.6). Tests: 7 (manifest structure + 6 imports).
- **§22 emergency resource boundary from headroom (Plugin SDK vNext Stage G,
  part 19, ADR-0026).** The static `DEFAULT_EMERGENCY_LIMITS` (768/128 MiB)
  in the supervisor is replaced by a per-spawn headroom-derived ceiling.
  New `apps/plugin-runtime/src/emergencyLimits.ts`: `computeEmergencyLimits`
  derives the ceiling from free memory × 0.75 minus the runtime's own RSS
  and a 256 MiB floor reservation per live worker, clamped to
  [256 MiB, 4 GiB]; the plugin memory hint (`memoryHintMiB`, §38) raises the
  ceiling toward the declared need when headroom permits; the admin override
  (`maxHeapOverrideMiB`, §39) replaces the whole calculation; young
  generation is old/4 clamped to [64, 512] MiB. `resolveEmergencyLimits`
  fixes precedence: explicit per-spawn caps → static supervisor config →
  headroom. The hint and override ride the `WORKER_SPAWN` frame (additive
  wire fields), the trusted bootstrap reports its actual
  `worker_threads.resourceLimits` in `hardened-ready`, and the ceiling
  surfaces in `WORKER_READY.emergencyLimits` and
  `VNextWorkerInfo.emergencyLimits` (§40 diagnostics).
  `VNextPluginActivationSpec` gained `memoryHintMiB` / `maxHeapOverrideMiB`.
  Tests: 13 unit (headroom math, hint, override, clamps, precedence),
  3 supervisor e2e (override exact via `thread.resourceLimits` + ready
  report, dynamic mode within bounds and consistent, static config), 1
  subprocess e2e (override through the real wire), 1 full-stack (override
  exact; hint 2048 → ceiling ≥ 2048).
- **§20.13 runtime restart recovery (Plugin SDK vNext Stage G, part 18).**
  A crashed Plugin Runtime process no longer leaves the Main Host holding a
  dead client. `VNextRuntimeService` now listens for the client's `exit`
  event: an unexpected process exit resets host state — pending activations
  are rejected with the new `PLUGIN_RUNTIME_CRASHED` error (HTTP 503),
  broker subscriptions are pruned, active workers become cold — and the
  client reference is dropped so the next activation spawns a fresh runtime
  under an incremented `runtimeEpoch` (runtime generation, §25.2: frames from
  a dead generation are distinguishable). Recovery is demand-driven only:
  previously warm plugins are never re-activated automatically and there is
  no restart stampede (§20.13). A spawn racing the crash fails fast with
  `PLUGIN_RUNTIME_CRASHED` instead of hanging on the dead pipe, and a
  graceful `shutdown()` exit is not treated as a crash. Tests: 1 subprocess
  e2e (SIGKILL → exit event → new generation handshake under epoch 2 with
  ping + workerReady) and 1 full-stack test (activation → SIGKILL via the
  runtime's own pid line on stderr → state reset, an in-flight activation
  rejects with `PLUGIN_RUNTIME_CRASHED`, the next activation boots a fresh
  generation with a new worker id).
- **§9.1.1–§9.1.4 BoundedConsoleSink and the full console channel (Plugin SDK
  vNext Stage G, part 17).** One `console.*` call no longer creates one
  transport message. The worker sink (`apps/plugin-runtime/consoleSink.mjs`,
  TCB) is a bounded formatter (§9.1.2: max depth 4 / keys 16 / items 32 /
  string 512 B / record 4000 B / stack 32 frames; getters are never
  intentionally invoked; proxy/getter failures become placeholders) plus a
  fixed 64 KiB ring with coalescing and a `droppedCount` — the ring is the
  only log buffer, with no secondary unbounded queue behind it. Batches
  (≤16 KiB / ≤256 records, flushed on a 4 KiB threshold, a 100 ms interval or
  force at terminate) are encoded once in the worker and forwarded opaque by
  the runtime (§15.1) as `LOG_BATCH` frames (0x1b). Flush credits start at 8
  and are replenished by `LOG_BATCH_ACK` (0x1c, capped at 64): without credit
  the worker stops flushing and never accumulates payload. The host log
  router attributes records to the plugin, must emit the synthetic
  `[ST2] N plugin log records suppressed` record when a batch reports drops
  (rule 9), and always acks. Fatal diagnostics (`FATAL_DIAGNOSTIC` 0x1d) ride
  a reserved, non-displaceable path: `uncaughtException` /
  `unhandledRejection` produce a bounded envelope plus a stderr line, the
  worker stays up only until `module-graph-loaded` / `module-graph-error` is
  delivered (deterministic activation outcome), then exits(1) (§9.1.4 /
  §26.1.3 / §26.1.4); the runtime retains the last envelope and attaches it
  to `WORKER_TERMINATED` so crash attribution survives frame races. Server
  wiring: `VNextRuntimeService` `logSink` / `fatalSink` options and a
  `[plugin:<id>]`-prefixed level mapping onto `ctx.logger` in `plugins.ts`.
  Tests: 13 unit (formatter bounds, ring coalesce/drop/drain, credits),
  5 worker e2e (batch round-trip, terminate flush, flood + droppedCount with
  ack loop, fatal paths), 2 subprocess e2e (LOG_BATCH + ack, FATAL_DIAGNOSTIC
  + WORKER_TERMINATED-with-fatal), 2 full-stack (log router attribution +
  synthetic suppressed record), 1 contracts pin. Import-time unhandled
  rejections no longer kill the worker before its graph report goes out; the
  four pre-existing full-stack lifecycle tests were restored and the
  "already active" test now uses a capability-granted plugin (a denied
  fire-and-forget chain is Worker-fatal by policy).
- **§29.1.1 scope capabilities (Plugin SDK vNext Stage F, part 16).**
  `network.http` alone now permits only public Internet addresses. Loopback
  (`127/8`, `::1`, `0.0.0.0/8`), RFC1918 / link-local / ULA / multicast, and
  cloud metadata endpoints each require an additional scope capability
  granted alongside `network.http`: `network.local`, `network.private`, and
  `network.metadata` respectively. New contracts: `NETWORK_SCOPE_LOCAL`,
  `NETWORK_SCOPE_PRIVATE`, `NETWORK_SCOPE_METADATA`,
  `NETWORK_SCOPE_CAPABILITIES`, `NetworkScope` interface, and
  `DEFAULT_NETWORK_SCOPE` (all-false). The executor's `isPublicIp` is
  replaced by `classifyAddress`, which returns `'public' | 'local' |
  'private' | 'metadata'`; cloud metadata IPs (`169.254.169.254`,
  `169.254.170.2`) are classified as `'metadata'` before link-local so they
  get the dedicated `network.metadata` scope, not `network.private`.
  `checkDestination` admits a non-public address only when the plugin's
  effective `NetworkScope` has the matching flag set; otherwise it fails
  with `NETWORK_DESTINATION_DENIED` (or `NETWORK_REDIRECT_DENIED` on a
  redirect hop, §29.1.3) and the error's `details.requiredScope` names the
  missing capability. Scope applies per-hop — every redirect is
  re-checked. A new `networkScopeProvider?: (pluginId) => NetworkScope`
  option lets the production broker derive the scope from the same DB
  grant rows the consent flow writes (`vnextBroker.ts` default provider),
  while the reference host derives it from the in-memory grants map. Tests:
  13 unit (local / private / metadata allow + deny, ECS metadata
  169.254.170.2, non-metadata link-local 169.254.1.1 → private, IPv6
  loopback, redirect scope re-check, redirect to private allowed, custom
  provider override, `requiredScope` in error details), 1 contracts pin.
- **§29 keep-alive/pooling, proxy and secret-bound requests (Plugin SDK vNext
  Stage F, part 15).** The `network.http.fetch` transport now satisfies §29 in
  full. A new `NetworkPool` (`apps/plugin-runtime/src/host/networkPool.ts`)
  provides real connection pooling over bounded `http.Agent`/`https.Agent`
  keep-alive agents (per-origin socket caps, idle TTL and connect timeout
  pinned in contracts: `NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN` = 6,
  `NETWORK_POOL_MAX_FREE_SOCKETS` = 4, `NETWORK_POOL_KEEP_ALIVE_MS` = 60 s,
  `NETWORK_POOL_CONNECT_TIMEOUT_MS` = 10 s). The executor creates it lazily and
  it is the default transport; injectable `fetchImpl` (tests) bypasses it so
  test runs never leave pooled sockets behind, and `close()` on the executor /
  policy / broker host (wired into runtime `shutdown()`) releases idle sockets
  with a bounded poll. Proxies are executor-level configuration (`proxyUrl`,
  never plugin-controlled — a plugin-set proxy would be a local pivoting
  hole): HTTP targets use the absolute-form request line, HTTPS targets a
  CONNECT tunnel with TLS over the tunneled socket (tunneled connections are
  not pooled and every exit path destroys the sockets). Secret-bound requests
  (§29.1.5): fetch args gain an opaque `secretId`; the executor resolves it
  against the service-level `networkSecrets` registry and injects the secret's
  headers at request time (secret wins on header conflicts; the plugin never
  sees the value). The first hop must stay inside the secret's bound origin
  (`NETWORK_SECRET_ORIGIN_MISMATCH`, no `use secret X + arbitrary Y`), an
  unknown handle fails with `NETWORK_SECRET_NOT_FOUND`, and redirects never
  carry the injected secret to another origin — they continue without the
  secret headers. Tests: 6 unit `networkPool.test.ts` (keep-alive reuse proven
  by a single TCP connection serving two requests, per-origin socket bounds,
  close semantics, absolute-form proxy round-trip, CONNECT tunneling with no
  leaked sockets, non-http proxy URL rejected at creation), 4 executor tests
  (injection + secret-wins, not-found, origin mismatch, redirect drops the
  secret), 2 worker e2e (secretId rides the wire; oversized secretId rejected
  locally), 2 full-stack e2e (secret injected through the real runtime wire;
  mismatch through the real wire), 1 contracts pin.
- **§17 credit streams / chunked streaming for large response bodies (Plugin
  SDK vNext Stage F, part 14).** Encoded response bodies larger than one chunk
  (256 KiB, `RPC_STREAM_CHUNK_BYTES`) now travel the fd 3 data pipe as
  `RPC_RESPONSE_STREAM` frames (0x1a, host → runtime, ≤ 256 KiB each) instead
  of one giant frame. Each frame's payload is `header JSON + NUL + raw chunk`
  (`{ requestId, seq, final }` — JSON text can never contain a raw NUL, so the
  separator is unambiguous); the runtime relays the payload opaque and the
  worker is the single assembly and decode point (§15.1). Flow control is
  credit-based per §17: the window starts at one chunk, the worker grants
  `{ kind: 'rpc-stream-credit', requestId, bytes }` (a `BRIDGE_MESSAGE` the
  host client consumes internally and never re-emits as app-level) after each
  consumed chunk, and the producer never creates the next chunk without a free
  window. No unbounded queues: the host stream registry is bounded
  (`RPC_STREAM_MAX_CONCURRENT` = 16; overflow fails the response with a broker
  error, never a silent stall) and the worker accumulator is capped at
  `RPC_STREAM_MAX_ACCUMULATED_BYTES` = 16 MiB (headroom over the 8 MiB network
  body cap; seq gaps / cap overflow fail the call with `VALIDATION_FAILED`).
  The host side is a dedicated, unit-tested `ResponseStreamer` state machine;
  the client exposes diagnostics counters (`responseStreamFrameCount`,
  `responseStreamByteCount`). Bodies are still buffered at the endpoints
  (producer-side streaming reads from executors are a documented follow-up);
  the win is bounded transport and runtime parser memory. Tests: 6 unit
  `responseStreamer.test.ts`, 1 in-process worker e2e (600 KiB reassembled
  across 3 chunks), 1 subprocess e2e (600 KiB result → 3+ frames through the
  real runtime with a live credit round-trip), 1 full-stack e2e (600 KiB fetch
  body through the real server + DB grants).
- **Request direction for large RPC arguments over the data pipe (Plugin SDK
  vNext Stage F, part 13).** Broker-call arguments above the control bound now
  travel the fd 4 data pipe as `RPC_REQUEST_DATA` frames (0x19, worker → host
  via the runtime, opaque payload decoded once by the host client, §15.1).
  The worker routes deterministically in `invokeBrokerCall`: args ≤ 32 KiB
  keep the structured-clone control path; up to 16 MiB
  (`BROKER_MAX_ARGS_DATA_BYTES`) are serialized into the final wire body
  exactly once and shipped as `{ kind: 'rpc-request-data', requestId,
  pluginId, capabilityName, causalChain, deadlineAt, payloadBytes }`; larger
  args fail with `VALIDATION_FAILED`. The broker gateway recognizes the new
  bridge message and both broker cores gained `submitOpaque`: the forwarding
  core admits the call (deadline, revocation, duplicates, in-flight cap)
  against the mirrored metadata and relays the payload without decoding, the
  in-process reference core decodes and runs the policy. The runtime's fd 4
  became a real producer: a serialized bounded outbox (single write chain,
  drain-based backpressure, ≤ 8 queued frames — excess fails the call), and on
  Windows data sockets open one-directionally (`readable: false,
  writable: true`) because a pending read on a named-pipe handle blocks
  writes. `SDK_MAX_KV_VALUE_BYTES` and `SDK_MAX_SETTINGS_VALUE_BYTES` raised
  from 32 KiB to 8 MiB (values travel the data pipe in both directions).
  Tests: 2 in-process worker e2e (100 KiB KV and settings values round-trip
  through the reference core; the old size-bound test now uses a 9 MiB
  value), 1 subprocess e2e (200 KiB args → fd 4 → `rpcRequest` with the full
  payload), 1 full-stack e2e (100 KiB KV value through the real subprocess
  runtime and DB grants).

- **Streaming response bodies over the data pipe (Plugin SDK vNext Stage F,
  part 12).** Broker-call results larger than the control path now travel the
  data pipe as `RPC_RESPONSE_DATA` frames (0x18, host → runtime, opaque
  payload decoded once by the worker, §15.1); `PluginRuntimeClient
  .sendRpcResponse` routes deterministically between the control frame and the
  data pipe. `NETWORK_MAX_BODY_BYTES` raised from 32 KiB to 8 MiB, so
  `sdk.network.fetch` returns full large bodies (still buffered whole —
  chunked §17 credit streams come later). Hardening: a module-graph snapshot
  with an oversized export can no longer crash the runtime via the
  BRIDGE_MESSAGE control frame — the worker bounds the snapshot at 48 KiB and
  reports `snapshotOmitted`. `VNextRuntimeOptions` gained injectable
  `fetchImpl`/`dnsLookupImpl` for tests. Tests: subprocess e2e (a 200 KiB
  broker result over the data pipe), subprocess e2e (a 300 KiB export →
  `snapshotOmitted`, runtime stays alive), full-stack e2e (a 100 KiB fetch
  body through the real subprocess runtime), in-process (fetch bodies above
  the old 32 KiB cap arrive intact).

- **Data pipes + large module graphs (Plugin SDK vNext Stage F, part 11).**
  The §15.9 control/data head-of-line isolation topology is now functional:
  the Plugin Runtime owns a separate bounded outbox and bulk-frame parser on
  the data pipes (fd 3/4, cap `PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES` = 256
  MiB) and the host client wires both ends (fd 3 writes, fd 4 parses into an
  opaque `dataFrame` event). New wire frame `MODULE_GRAPH_DATA` (0x17,
  host → runtime over the data pipe): same `{ workerId, workerEpoch, graph }`
  body as `MODULE_GRAPH` but opaque to the wire — the worker is the single
  decode point (§15.1). `sendModuleGraph` routes deterministically: the
  control frame only when the encoded body fits the control cap with escaping
  slack and every module source stays under the §15.11 string bound; larger
  graphs go the data pipe. Host-side graph caps raised from 24/48 KiB to
  per-source 64 KiB and total 256 KiB. Tests: 4 codec/parser unit tests,
  1 subprocess e2e (a ~60 KiB source graph loads over the data pipe) and
  1 full-stack e2e (plugin activation with a 60 KiB source through the real
  subprocess runtime).

- **Live-delivery event subscriptions (Plugin SDK vNext Stage F, part 10).**
  `sdk.events.subscribe({ name, cursor? }, signal?)` now returns an async
  iterator (`next()` / `close()` / `[Symbol.asyncIterator]`) that receives
  host-emitted events in real time. New SDK operations `events.subscribe` /
  `events.unsubscribe` in the catalog (core channel §18, no grant; per-plugin
  cap `EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN` = 8 → `SERVICE_UNAVAILABLE`). New
  wire frame `HOST_BRIDGE_MESSAGE` (0x16, host → runtime → worker, app-level;
  the worker-ward sibling of `BRIDGE_MESSAGE` 0x15); the runtime only checks
  worker identity and forwards the payload. Host side: `eventPushSink` in the
  reference executor (`memoryHost.ts`), subscription routing
  (subscriptionId → worker) in the broker host with cleanup on
  `events.unsubscribe` and `workerTerminated`, and a public emit path:
  `VNextRuntimeService.emitEvent(name, payload)` /
  `VNextBrokerHostService.emitEvent`. Worker side: bounded push queue (128),
  dedupe by seq, and a bounded-wait replay fallback so a lost push cannot hang
  the iterator. Tests: 5 executor unit, 2 in-process worker e2e, 4 broker-host,
  2 full-stack subprocess e2e (real wire: emit → worker → granted KV call →
  log marker).

- **M1 prototype go/no-go measurements (Plugin SDK vNext §54).**
  `apps/plugin-runtime/bench/m1-gates.mjs` runs the real subprocess runtime and
  measures the §54 gates measurable on a dev machine: idle runtime RSS,
  incremental RSS per blank worker, extrapolated worker capacity on 3 GiB, cold
  worker startup p50/p95 (wall + worker-side bootstrap), SES module load
  overhead, warm broker call host-ward hop latency, and infinite-loop
  termination latency (force-terminate path). Results are recorded to
  `docs/plugin-sdk/vnext-m1.md` (`--record`). First run (win32, node v24):
  idle runtime 72.7 MiB, blank worker ≈ 30 MiB delta (≈91 workers on 3 GiB),
  cold startup p50 447 ms / p95 465 ms, module load overhead 25 ms, warm
  broker hop 0.3 ms, infinite-loop termination p95 111 ms. Conclusion:
  `maxActivePlugins` is not needed (§54); deferred gates (8-10, 13-15) need
  the data-pipe infrastructure, a plugin corpus and long-running/platform
  suites.

- **v3 plugin spawn integration (Plugin SDK vNext Stage A, prototype).** The
  plugin manager now activates v3 backends in the real Plugin Runtime:
  `apps/server/src/plugin/vnextRuntime.ts` (`createVNextRuntimeService`)
  lazily spawns the runtime process, reads the plugin package from disk,
  builds the signed module graph host-side, and drives the activation cycle
  `WORKER_SPAWN → WORKER_READY → MODULE_GRAPH → module-graph-loaded`; the
  part-9c broker host is attached to the runtime transport so worker-side
  capability calls are decided by the Main Host policy against real DB grants.
  Wire additions in `@st2/contracts`: frame `MODULE_GRAPH` (0x14, host →
  runtime: the signed graph travels after hardened-ready per §15.8, opaque to
  the wire) and `BRIDGE_MESSAGE` (0x15, runtime → host: app-level worker
  bridge messages — module-graph-loaded/error today, live delivery in Stage
  F); `BrokerGateway.handleBridgeMessage` now reports whether it consumed the
  message. `PluginRuntimeClient` gained `sendModuleGraph` and the
  `bridgeMessage` event. `plugins.ts` routes apiVersion ≥ 3 through the
  service in every lifecycle point (install, reactivate, activate/disable/
  delete, safe-mode, onReady, onClose). Prototype limits (documented):
  one control-frame graph (64 KiB cap, per-module source ≤ 24 KiB), one
  worker per plugin, no worker restarts. Tests:
  `apps/plugin-runtime/src/runtimeClient.test.ts` (3 subprocess e2e: graph →
  loaded, evaluation error, stale-epoch reject) and
  `apps/server/test/vnextRuntime.spec.ts` (7 full-stack: broker round-trip
  through the real runtime, host-authoritative denial, activation failure +
  worker cleanup, already-active, deactivate no-op, shutdown + lazy restart,
  no protocol errors). Internal infrastructure; user-visible change: v3
  plugins activate end-to-end instead of failing with
  `PLUGIN_RUNTIME_UNAVAILABLE` (that code now only covers runtime spawn
  failure).

- **Main Host broker host + manifest v3 gate (Plugin SDK vNext Stage D part
  9c, prototype).** `apps/server/src/plugin/vnextBrokerHost.ts` —
  `createVNextBrokerHost(ctx, transport, options)` plugs the part-9 production
  policy into `createCapabilityBrokerCore` on Main Host: host-ward
  `RPC_REQUEST` frames become core submissions and the decision travels back
  as `RPC_RESPONSE` (part 9b wire); `revoke` aborts host-side in-flight calls
  and emits a `BROKER_REVOKE` frame so worker-side promises fail fast. The
  transport is injectable — `createPluginRuntimeTransport(client)` and
  `attachVNextBrokerHost(client, host)` adapt a `PluginRuntimeClient` (runtime
  spawn/worker lifecycle lands in Stage A). Boundary hardening: malformed
  frame bodies and call envelopes degrade to `VALIDATION_FAILED` with an
  unmatchable `requestId` (never poisons a real call), a host-side in-flight
  cap answers `SERVICE_UNAVAILABLE`, and wire errors are normalized exactly
  once. Manifest compat gate (ADR-0027 §3): `CURRENT_API_VERSION` is now 3 in
  `packages/plugin-sdk`, `InstalledPlugin.compatibilityLevel` gained
  `native-v3`, and activating a v3 plugin before the Stage A runtime
  integration returns the new `PLUGIN_RUNTIME_UNAVAILABLE` error (503)
  instead of running v3 code on the rev4 path. Also fixed in part 9:
  `fetchImpl`/`dnsLookupImpl` policy options now reach the reference executor
  (previously a silent no-op — real network calls leaked into tests); the
  injection test now asserts a body marker. Tests:
  `apps/server/test/vnextBrokerHost.spec.ts` (12: round-trip, denial, trust
  gate, revoke-abort + revoke frame, malformed frame/envelope, capacity cap,
  shutdown abort, transport wiring) plus manifest tests (apiVersion 3
  accepted, 4 rejected). Internal infrastructure; user-visible change is the
  v3 compat gate error.

- **Host-ward broker RPC relay (Plugin SDK vNext Stage D part 9b,
  prototype).** Worker broker calls now travel the production wire shape:
  `runtime-main` wires the supervisor `onBridgeMessage` hook through
  `createBrokerGateway(createHostForwardingCore(...))`; every admitted call
  ships host-ward as an `RPC_REQUEST` control frame (stamped with
  workerId/workerEpoch) and the worker-side pending promise settles from the
  matching `RPC_RESPONSE`. New wire contracts in `@st2/contracts`: frame type
  `BROKER_REVOKE` (0x13, additive) plus `PluginRuntimeRpcRequestBody` /
  `PluginRuntimeRpcResponseBody` / `PluginRuntimeBrokerRevokeBody` schemas.
  The forwarding core keeps admission protocol-level (envelope shape, deadline
  cap and expiry, causal cycles, duplicate requestIds, local revocation state,
  in-flight bound) while the capability decision stays in Main Host (ADR-0027);
  it aborts in-flight calls on `BROKER_REVOKE` (host-driven, `CAPABILITY_REVOKED`),
  on deadline expiry, on worker exit (epoch-matched) and on runtime shutdown,
  and drops `RPC_RESPONSE`s that race a worker restart (epoch mismatch).
  `PluginRuntimeClient` gained the `rpcRequest` event and
  `sendRpcResponse`/`sendBrokerRevoke` transport methods. Tests:
  `apps/plugin-runtime/src/broker/hostForwardingCore.test.ts` (21 unit) and
  `workerForwarding.test.ts` (3 worker e2e through the new
  `withForwardingWorker` harness: round-trip, host-side denial over the wire,
  revoke-abort B14 over the wire). Internal infrastructure; no user-facing
  behavior change.

- **Main Host broker policy for the vNext Capability Broker (Plugin SDK
  vNext Stage D part 9, prototype).** `apps/server` gained
  `src/plugin/vnextBroker.ts` — `createVNextBrokerPolicy(ctx, options)` builds
  the production `BrokerPolicy` (ADR-0027): `authorize` validates the call
  against the `SDK_OPERATION_CATALOG` (unknown method →
  `PROTOCOL_UNSUPPORTED`, capability/method mismatch → `POLICY_DENIED`), reads
  the grant from `ctx.database.repos.capabilityGrants` (the consent-flow rows,
  so revoke and expiry take effect on the next call; missing →
  `CAPABILITY_DENIED`, stale observed revision → `CAPABILITY_REVOKED`), and
  enforces the §31 trust gate (`database.core.read` requires
  `trustLevel: 'trusted'`, otherwise `TRUST_REQUIRED`). `execute` reuses the
  reference host executor with production backends: chats/characters/lorebook
  via `ctx.database.repos.*` (mapped to the summary schemas), `models.list`
  via provider config + adapter `listModels()`, `database.core.query` via a
  prepared statement on `ctx.database.sqlite` (the SQL gate and cell
  validation stay in the executor). All backends and the grant source are
  injectable for tests; the context surface is narrowed to `VNextBrokerHost`,
  and `assertProviderConfigValid` now takes the smaller
  `ProviderConfigValidationContext`. `@st2/server` depends on
  `@st2/plugin-runtime`. Tests: `apps/server/test/vnextBroker.spec.ts` (19:
  catalog/mismatch/core-channel/grant/revoke/expiry/revoke-race/trust gate/
  injected grantsProvider; production-backend round trips for characters,
  chats, lorebook, core DB, models and network). Internal infrastructure; no
  user-facing behavior change.

- **Brokered core DB read queries (Plugin SDK vNext Stage D part 8,
  prototype).** The §31 trusted `database.core.read` capability is now exposed
  as `sdk.db.query(sql, params?)` (broker method `database.core.query`). The
  reference host executor gates the SQL before delegating: exactly one
  read-only `SELECT`/`WITH` statement is admitted (write verbs, mutating
  keywords, multi-statement inputs and non-SELECT prefixes raise
  `POLICY_DENIED`), parameters must be bindable (non-finite numbers raise
  `VALIDATION_FAILED`), and the returned page is capped at
  `DATABASE_MAX_ROWS` (1000) rows and `DATABASE_MAX_COLUMNS` (64) columns
  with non-primitive cells rejected. The executor delegates to an injectable
  `dbQuery` function (in production a prepared statement on `ctx.database`);
  plugins never receive a DB driver module (§31). SQL text is bounded to
  `DATABASE_MAX_SQL_BYTES` (4096) and `DATABASE_MAX_PARAMS` (64) parameters.
  Contracts: `packages/contracts/src/sdkOps.ts` gained
  `SdkDatabaseQueryArgs/Result`, the four `DATABASE_*` bounds and one catalog
  entry. Tests: 7 unit (round-trip, write-gate across 10 statement kinds,
  multi-statement/prefix gate, CTE and `pragma_table_info` allowlisted,
  non-primitive cells, rows/columns cap, grant required) + 3 real-worker e2e
  (round-trip, local validation, grant required) + schema contract tests.
  Internal infrastructure; no user-facing behavior change.

- **Lorebook read operations over the Capability Broker (Plugin SDK vNext
  Stage D part 7, prototype).** The §12 `lorebook.read` capability is now
  exposed as three read-only SDK operations: `sdk.lorebook.list({ cursor?,
  limit?, characterId? })` returns a cursor-paginated page of books plus a
  `nextCursor`, `sdk.lorebook.read(bookId)` returns the full book, and
  `sdk.lorebook.entries(bookId)` returns the entries of a book (broker
  methods `lorebook.list`, `lorebook.read`, `lorebook.entries`, all gated by
  `lorebook.read`). The reference host executor delegates to injectable
  `lorebooksList` / `lorebookRead` / `lorebookEntries` functions (in
  production backed by `ctx.database.repos.lorebooks`); an unknown book (or a
  book without readable entries) raises `NOT_FOUND`. The book list is capped
  at `LOREBOK_MAX_LIST` (200), the entry list at `LOREBOK_MAX_ENTRIES` (1000),
  and cursors are bounded to 256 bytes. The results reuse the existing
  `LorebookSchema` and `LorebookEntrySchema` from
  `packages/contracts/src/lorebook.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkLorebookListArgs/Result`,
  `SdkLorebookReadArgs/Result`, `SdkLorebookEntriesArgs/Result`,
  `LOREBOK_MAX_LIST` / `LOREBOK_MAX_CURSOR_BYTES` / `LOREBOK_MAX_ENTRIES` and
  three catalog entries. Tests: 9 unit (list, characterId filter, read,
  NOT_FOUND, entries, entries NOT_FOUND, grant required, list cap, entries
  cap) + 5 real-worker e2e + schema contract tests. Internal infrastructure;
  no user-facing behavior change.

- **Characters read operations over the Capability Broker (Plugin SDK vNext
  Stage D part 6, prototype).** The §12 `characters.read` capability is now
  exposed as two read-only SDK operations: `sdk.characters.list({ cursor?,
  limit? })` returns a cursor-paginated page of character summaries plus a
  `nextCursor`, and `sdk.characters.read(characterId)` returns the full
  character (broker methods `characters.list` and `characters.read`, both
  gated by `characters.read`). The reference host executor delegates to
  injectable `charactersList` / `charactersRead` functions (in production
  backed by `ctx.database.repos.characters`); an unknown character raises
  `NOT_FOUND`, and the returned list is capped at `CHARACTERS_MAX_LIST` (200)
  with cursors bounded to 256 bytes. The results reuse the existing
  `CharacterSummarySchema` and `CharacterSchema` from
  `packages/contracts/src/character.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkCharactersListArgs/Result`,
  `SdkCharactersReadArgs/Result`, `CHARACTERS_MAX_LIST` /
  `CHARACTERS_MAX_CURSOR_BYTES` and two catalog entries. Tests: 5 unit (list,
  read, NOT_FOUND, grant required, cap) + 4 real-worker e2e + schema contract
  tests. Internal infrastructure; no user-facing behavior change.

- **Chats read operations over the Capability Broker (Plugin SDK vNext Stage D
  part 5, prototype).** The §12 `chats.read` capability is now exposed as two
  read-only SDK operations: `sdk.chats.list({ cursor?, limit?, characterId? })`
  returns a cursor-paginated page of chat summaries plus a `nextCursor`, and
  `sdk.chats.read(chatId)` returns the full chat (broker methods `chats.list`
  and `chats.read`, both gated by `chats.read`). The reference host executor
  delegates to injectable `chatsList` / `chatsRead` functions (in production
  backed by `ctx.database.repos.chats`); an unknown chat raises `NOT_FOUND`,
  and the returned list is capped at `CHATS_MAX_LIST` (200) with cursors
  bounded to 256 bytes. The results reuse the existing `ChatSummarySchema`
  and `ChatSchema` from `packages/contracts/src/chat.ts`. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkChatsListArgs/Result`,
  `SdkChatsReadArgs/Result`, `CHATS_MAX_LIST` / `CHATS_MAX_CURSOR_BYTES` and
  two catalog entries. Tests: 5 unit (list, read, NOT_FOUND, grant required,
  cap) + 4 real-worker e2e + schema contract tests. Internal infrastructure;
  no user-facing behavior change.

- **Models list over the Capability Broker (Plugin SDK vNext Stage D part 4,
  prototype).** The §12 `models.list` capability is now exposed as
  `sdk.models.list(providerId)` (broker method `models.list`). The reference
  host executor delegates to an injectable `modelsProvider` (in production this
  is the provider adapter's `listModels()` call); an unknown provider raises
  `NOT_FOUND`, and the returned list is capped at `MODELS_MAX_LIST` (256). The
  result reuses the existing `ModelInfoSchema` from
  `packages/contracts/src/provider.ts` (`{ id, name, contextLimit? }`).
  Contracts: `packages/contracts/src/sdkOps.ts` gained `SdkModelsListArgs/
  Result`, `MODELS_MAX_LIST` and a catalog entry mapping `models.list` →
  `models.list`. Tests: 4 unit (round-trip, NOT_FOUND, grant required, cap) +
  3 real-worker e2e + schema contract tests. Internal infrastructure; no
  user-facing behavior change.

- **Network fetch over the Capability Broker (Plugin SDK vNext Stage D part 3,
  prototype).** The §29 `network.http` capability is now exposed as
  `sdk.network.fetch(url, options)` (broker method `network.http.fetch`). The
  reference host executor (`apps/plugin-runtime/src/host/memoryHost.ts`)
  enforces SSRF hardening per §29.1: only `http`/`https` schemes are accepted;
  loopback, RFC1918 private ranges, link-local, cloud metadata
  (`169.254.0.0/16`), IPv6 loopback/ULA/link-local are denied with
  `NETWORK_DESTINATION_DENIED`; DNS rebinding (§29.1.2) is blocked by resolving
  the hostname before connect and policy-checking every resolved IP; redirects
  (§29.1.3) are followed manually with each target re-checked — a forbidden
  redirect raises `NETWORK_REDIRECT_DENIED`, the hop cap is 8. The response body
  is returned as a string (control-path, 32 KB cap until Stage F streaming
  bodies). The executor accepts injectable `fetchImpl` and `dnsLookupImpl` so
  tests stub network and SSRF edges without real I/O. Contracts:
  `packages/contracts/src/sdkOps.ts` gained `SdkNetworkFetchArgs/Result`,
  `NETWORK_*` bounds and a catalog entry mapping `network.http.fetch` →
  `network.http`. `KernelErrorCode` extended with `NETWORK_DESTINATION_DENIED`
  and `NETWORK_REDIRECT_DENIED` (§41). Tests: 11 unit (round-trip, SSRF
  loopback/private/metadata/scheme, DNS rebinding, redirect follow/manual/deny,
  grant required, body truncation) + 3 real-worker e2e + schema contract tests.
  Internal infrastructure; no user-facing behavior change.

- **Events channel over the Capability Broker (Plugin SDK vNext Stage D part 2,
  prototype).** The §18 events channel (ADR-0025 §J1 cursor/replay) is now
  exposed as a pull-based Core SDK operation `sdk.events.replay({ name,
  cursor?, limit?, waitMs? })` over the broker. The reference host executor
  (`apps/plugin-runtime/src/host/memoryHost.ts`) keeps a bounded ring buffer
  per event name (128/name, 4096 total, TTL 60 s, FIFO global eviction) with a
  per-name sequence and `evictedUpToSeq` tracking: cursors that fell outside
  the replay window raise `EVENT_CURSOR_EXPIRED`, a cursor ahead of the newest
  emitted event raises `VALIDATION_FAILED`, and concurrent replay waiters are
  bounded (64, `SERVICE_UNAVAILABLE` when exhausted). The wait is clamped to
  the broker deadline (a small margin avoids racing the in-flight deadline
  abort). Events are a core channel — `capability: null` in the operation
  catalog — so no §12 grant is required, but identity, deadline, cycle and
  bound checks still apply. Contracts: `packages/contracts/src/sdkOps.ts`
  gained `SdkEventsReplayArgs/Result`, `SdkEventEnvelope`, `EVENTS_*` ring
  bounds and a catalog entry with `capability: null` (the catalog type is now
  `string | null`). `KernelErrorCode` extended with `EVENT_BUFFER_EVICTED`
  (§41, reserved for the push/ack layer in Stage F); `BrokerErrorCode`
  extended with `SERVICE_UNAVAILABLE`. Tests: 8 unit (ring eviction, cursor
  expiry, per-name/global caps, TTL sweep, bounded wait, waiter cap, deadline
  clamp) + 3 real-worker e2e (replay from beginning, wait for an event,
  cursor expired) + events schema contract tests. Internal infrastructure; no
  user-facing behavior change.

- **Core SDK layer over the Capability Broker (Plugin SDK vNext Stage D part 1,
  prototype).** First typed capability operations on the new runtime:
  `packages/contracts/src/sdkOps.ts` defines the operation catalog — the
  single source of truth mapping broker `method` → §12 capability name
  (`storage.kv.*`, `settings.get`/`set`) plus TypeBox args schemas and value
  bounds. `worker-bootstrap.mjs` gained the frozen `sdk` endowment
  (`sdk.kv.get/set/delete/list`, `sdk.settings.get/set`) over the raw bridge:
  inputs are validated in the bootstrap before reaching the wire, validation
  failures surface as promise rejections (`VALIDATION_FAILED`), values are
  size-bounded (32 KiB, control path until Stage F). New reference host
  executor `apps/plugin-runtime/src/host/memoryHost.ts` implements the first
  operations with in-memory per-plugin KV/settings stores and per-§12 grants;
  it plugs into the broker core as a `BrokerPolicy` and denies unknown methods
  (`PROTOCOL_UNSUPPORTED`), capability/method mismatches (`POLICY_DENIED`) and
  ungranted capabilities (`CAPABILITY_DENIED`). `module-graph-loaded` drain
  switched to quiescent polling so chained import-time calls
  (`sdk.kv.set(...).then(() => sdk.kv.get(...))`) settle before the snapshot.
  Tests: 8 unit (host executor through the real broker core) + 5 real-worker
  e2e (kv/settings round-trips, chained calls, per-capability denial, worker-
  side input validation that never reaches the wire, value bound) + SDK
  operation schema contract tests. Internal infrastructure; no user-facing
  behavior change.

- **Capability Broker over the Plugin Runtime (Plugin SDK vNext Stage C,
  prototype).** New `apps/plugin-runtime/src/broker/*` (package
  `@st2/plugin-runtime`): `capabilityBroker.ts` implements the §10.1 admission
  checks (envelope validation, deadline fail-fast and in-flight deadline abort,
  `SERVICE_CALL_CYCLE` fail-fast over the causal call chain A→B→C per §26.2.1,
  revocation overlay per §10.2 with in-flight abort, B14) and delegates
  grant/trust/consent decisions to an injected `BrokerPolicy`; the bridge
  gateway (`brokerGateway.ts`) wires worker `rpc-request` bridge messages into
  the core and replies `rpc-response`, while the supervisor stays
  transport-pure (§16.1) behind a new `onBridgeMessage` hook. Worker bootstrap
  gained the hardened `bridge.invoke(method, args, options)` endowment — the
  only path plugin code can reach the broker — building the `BrokerCallRequest`
  envelope from workerData identity (pluginId/installationId/trustLevel) with
  bounded method/args/deadline/causal chain (§15.11); spawn now carries a
  `trustLevel` (sandbox/extended/trusted, §11). Wire contracts in
  `packages/contracts/src/capabilityBroker.ts` (TypeBox: `BrokerCallRequest`,
  `BrokerCallResult`, `BrokerRevokeCommand`, `BrokerWireError`, trust levels,
  deadline/chain limits); `rpc-request`/`rpc-response` bridge messages in
  `pluginRuntime.ts` are now typed to broker envelopes. `KernelErrorCode`
  extended with `TRUST_REQUIRED`, `POLICY_DENIED`, `SERVICE_VERSION_MISMATCH`,
  `SERVICE_CALL_CYCLE` (§41). SES Compartments do not support top-level await,
  so `module-graph-loaded` waits for import-time broker calls to settle
  (bounded, 5 s). Tests: 18 unit (broker core) + 5 real-worker e2e (echo
  round-trip, trust propagation, `CAPABILITY_DENIED`, revoke abort in-flight,
  `SERVICE_CALL_CYCLE`) + broker schema contract tests. Internal
  infrastructure; no user-facing behavior change.

- **Secure plugin module graph loader (Plugin SDK vNext Stage B, prototype).**
  New `apps/plugin-runtime/src/graph/*` (package `@st2/plugin-runtime`):
  `buildModuleGraph` builds a signed pure-JS dependency graph (BFS, SHA-256
  digests, static + dynamic imports via `@endo/module-source` and
  `@babel/parser`, `st2-plugin://` virtual locations, module-count/source-size
  caps, warnings for `require`/`eval`/`Function`/CJS idioms);
  `loadModuleGraph` evaluates the graph in an SES Compartment whose
  `resolveHook`/`importHook` serve only the signed graph
  (`noAggregateLoadErrors`, digest re-verification, `MODULE_NOT_IN_GRAPH` for
  out-of-graph imports, error codes `MODULE_DIGEST_MISMATCH` /
  `MODULE_EVALUATION_FAILED` / `UNSUPPORTED_DEPENDENCY` /
  `UNSUPPORTED_NODE_BUILTIN`). The worker bootstrap gained the
  `load-module-graph` bridge command; graph contracts live in
  `packages/contracts/src/pluginModule.ts` (incl. `toModuleMapManifest`).
  Tests: unit (builder + loader) and real-worker e2e. Internal infrastructure;
  no user-facing behavior change.

- **Event cursor/replay and multi-window background singleton (rev4 §J1/J3).**
  `api.events.subscribe(event, {cursor, signal, maxInFlight})` without a
  callback returns an async iterator (`api.events.stream`) over app events.
  The host retains a bounded ring buffer (128 per event name, 4096 total,
  60 s TTL) and replays events after the cursor — at-least-once recovery
  after a dropped subscription or sandbox restart; every `evt.emit` carries
  a stable `cursor` (`<event>:<seq>`) as the dedupe key, and delivery pauses
  at `maxInFlight` (default 64) until `events.ack` confirms handling
  (backpressure). Cursors outside the retained window are rejected with the
  new `EVENT_CURSOR_EXPIRED` code; fresh subscriptions start live without
  replaying the past. `api.events.on(event, cb)` adds local listeners for
  host-generated envelopes (`window.background.changed`). Background work
  now runs in exactly one window per installation: the host elects a primary
  per window over BroadcastChannel (claims + heartbeats, deterministic
  smallest-windowId leader, 4 s lease expiry, release on `pagehide`),
  exposed as `api.windows.role()` / `api.windows.isBackground()` with role
  transitions pushed as `window.background.changed`; without
  BroadcastChannel the window degrades to `standalone` (its own primary).
  New `plugins/rev4-events` (drop → replay through the cursor) and
  `plugins/rev4-multiwindow` (KV counter owned only by the primary, moves
  on primary death) samples; feature flags `events.cursor` /
  `windows.multiwindow`. Docs: ADR-0025, `docs/plugin-sdk/rev4-api.md`.

- **Sandbox crash isolation (rev4 §M3).** The host detects a dead or hung
  plugin sandbox through two signals: the kernel session port closing
  (`KernelSession.onPeerClose` — renderer-process death or self-navigation,
  detected without any timer) and a heartbeat (`kernel.ping` RPC every 10 s,
  3 s deadline — covers hangs in site-isolated Chromium where the sandbox
  runs in its own process). A detected crash restarts the frame under a
  restart budget (3 restarts inside a 10-minute window); exhausting the
  budget is a crash-loop and disables the plugin server-side
  (`POST /api/v2/plugins/:id/disable`) with no further restarts. Every
  outcome surfaces a host-owned notification (`st2-plugin-crash` →
  `plugins:pluginCrashed` / `pluginCrashedRestart` /
  `pluginCrashLoopDisabled`, en/ru) that survives the crashed frame's
  teardown, and the plugin's own `api.diagnostics.get()` gains an optional
  `crash` field (`count`, `lastAt`, `restartBudgetLeft`). The new
  `plugins/rev4-crash` sample self-navigates its sandbox away
  (`rev4-crash.boom`) and the e2e asserts the restart toast plus the
  re-registered command. Docs: ADR-0024, `docs/plugin-sdk/rev4-api.md`.

- **Host-driven plugin lifecycle hooks (rev4 §J2).** The server announces
  package updates around the atomic directory swap via SSE
  (`plugin.updating` → `plugin.updated` on success, `plugin.rollback` after
  a restore, `plugin.uninstalling` before removal) and the web runtime maps
  them onto best-effort sandbox RPCs: `beforeUpdate`, `afterUpdate`,
  `rollback`, `uninstall`, plus `suspend`/`resume` for every live frame on
  `visibilitychange` (feature flag `lifecycle.hooks`, RPC deadline 1500 ms,
  missing/throwing hooks degrade to `{handled: false}` without blocking the
  host state machine). Frame teardown on update replacement now awaits the
  in-flight hook's settlement before closing the session port, so the hook's
  final writes (KV, blobs, backend) are not cut off mid-flight. New
  `plugins/rev4-lifecycle` sample: suspend/resume state mirrored on
  `<html data-lifecycle-state>`, and a persisted KV hook log observable
  after an update (e2e installs v1 → updates to v2 → asserts the
  `beforeUpdate, afterUpdate` pair survives reload). Docs: ADR-0023,
  `docs/plugin-sdk/rev4-api.md`.

- **Host overlay chrome for `full` overlays (rev4 §G7).** While a plugin's
  `full` overlay is live, the host renders its own browser-chrome-style
  indicator (`data-component="plugin-overlay-chrome"` — plugin name +
  host-controlled close button) on a dedicated layer
  (`--st-layer-plugin-chrome: 300`, above every plugin layer and below host
  modals/permission UI), makes the app background inert, restores focus on
  close, and closes on Escape — including when focus lives inside the
  sandbox iframe (the sandbox relays the key via the new `ui.overlay.escape`
  RPC, which can only close the plugin's own overlay). Chrome ownership is
  tracked per frame instance, so a stale layout flush from a replaced frame
  can never close a newer frame's chrome. `ui.surface.unmount` now also
  disposes the sandbox-side overlay container so host-driven close leaves no
  plugin DOM behind; the overlay hit layer uses the `--st-layer-plugin-overlay`
  token instead of a hardcoded z-index. New canonical theme tokens
  `--st-layer-plugin-overlay` / `--st-layer-plugin-chrome`; i18n
  `plugins:overlayActiveLabel` / `plugins:closeOverlay` (en/ru). The
  `plugins/rev4-overlay` sample gains a `rev4-overlay.full` command (requires
  `ui.commands`) and the e2e asserts the chrome appears with the plugin name
  and disappears after Escape inside the iframe. Docs: ADR-0022,
  `docs/plugin-sdk/rev4-api.md`, `docs/theme-sdk/README.md`.

- **Plugin background jobs: cron schedules, retry lifecycle and a dead-letter
  queue (rev4 stage 5, `api.jobs`).** `jobs.schedule` accepts a 5-field UTC
  cron expression (`minute hour dom month dow`, `*`, ranges, steps, lists —
  parsed by a new dependency-free `apps/server/src/lib/cron.ts`) exclusive
  with `runAt`/`intervalMs`; the job's `nextRunAt` is the first cron match
  and advances on success, surviving server restarts. `retries` (0–20) turns
  on an ack-based lifecycle: the dispatch is held until the plugin reports
  `jobs.ack(jobId, {ok})` — `ok: false` retries with exponential backoff
  (`retryDelayMs` base, default 5 s, doubling, 1 h cap; a missing ack times
  out after 5 minutes as a failed attempt), and exhausting the budget moves
  the job to a DLQ (`status: 'failed'`, `lastError`, `failedAt`) where it is
  never dispatched again until `jobs.retry(jobId)` re-enqueues it; successful
  acks delete one-shots and advance interval/cron schedules. Fire-and-forget
  behavior without `retries` is unchanged. `jobs.list` exposes
  `status`/`attempts`/`maxRetries`/`lastError`/`failedAt`; new REST routes
  `POST /plugins/:id/jobs/:jobId/ack` (idempotent — acks for finished,
  never-dispatched or DLQ jobs are no-ops) and `POST .../jobs/:jobId/retry`;
  new kernel RPCs `jobs.ack`/`jobs.retry` with capability gating. The
  `plugins/rev4-jobs` sample demonstrates a flaky job delivered after two
  retries, a cron schedule listed and cancelled, and a full DLQ roundtrip;
  docs: ADR-0021, `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.

- **Overlay hit shapes and the corrected clip model (rev4 §A4/G3, `ui.overlays:3`).**
  `api.overlays.register`/`update` accept `hitShapes` (rect/circle/ellipse/polygon
  in overlay-local pixels, capped by `limits.overlays`: `maxShapes` 32,
  `maxPolygonPoints` 256, `maxGeometryBytes` 16 KiB). `native` overlays render
  the shapes as SVG clip primitives so browser hit-testing follows the same
  geometry; `proxy` overlays point-test them before forwarding packets. The
  clip model now matches the rev4 contract: `native`, `proxy` and `none` rects
  all join the iframe clip union (proxy visuals stay visible; `none` is a
  visible non-interactive layer with an absorbing host hit-div), while one
  `full` overlay unclips the whole iframe — interactivity is decided by the
  hit layer, not the clip. Pointer packets carry `pointerId`, `sequence` and
  `timestamp`; shape updates are rate-limited by
  `overlays.maxUpdatesPerSecond` (`PLUGIN_QUOTA_EXCEEDED`, retryable). The
  `plugins/rev4-overlay` sample demonstrates a circular hit region and the
  `rev4-overlay` e2e asserts shape-gated forwarding.

- **Plugin lifecycle events over SSE (`plugin.installed/activated/disabled/deleted`).**
  The server now emits these on install, install-git, activate, disable and
  uninstall; the SSE relay forwards them and the web client invalidates the
  `['plugins']` cache on each, so every connected client (including other
  tabs) drops plugin sandboxes, overlay hit-divs and registrations
  immediately instead of keeping them until a manual refetch.
- **Chat CAS, server-side drafts and the write outbox (rev4 stage 3).**
  Messages carry a `revision` (bumped per update); `PATCH` accepts an
  `expectedRevision` and answers `MESSAGE_CONFLICT` (409) with the current
  revision instead of silently clobbering concurrent edits, and
  `chat.message.updated` reports the new revision. Streaming writers no
  longer PATCH a committed message row up to 10×/s: plugin drafts stream
  into a server-side `message_drafts` object (`POST/PATCH/commit/DELETE
  /chats/:id/drafts…`) where a monotonic `sequence` makes replayed PATCHes
  idempotent no-ops, `commit` atomically materializes the final message and
  is retry-safe (`alreadyCommitted`), and a server sweep removes stale rows
  (committed >1 h, uncommitted >24 h) — a crashed writer leaves a swept
  draft, never a half-written message. Message creates accept an
  `idempotencyKey` (unique per chat): a retried create returns the original
  message, and `api.chats.append` exposes the key to plugins. The 10 Hz
  flush rate remains an internal host policy. The `plugins/rev4-draft`
  sample demonstrates streaming-commit and key-deduped append; docs:
  ADR-0019, `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.
- **Persistent message blocks (rev4 stage 4).** Block attachments —
  including the renderer's serialized state — are durable server data
  (`message_block_attachments`, migration 0019): they survive page reloads
  and render identically in any client. New REST surface: batch
  `GET /chats/:id/blocks?messageIds=`, `POST
  /chats/:id/messages/:messageId/blocks`, `PATCH/DELETE /blocks/:blockId`;
  uninstall and message deletion cascade the rows away. The host kernel
  persists on attach, freezes state to the server only on genuine unmounts
  (overscan/chat switch), and resolves the reload race (attachment arriving
  before the plugin re-registers its renderer) with an in-place retry
  instead of a remount storm. `chat.message.block.changed` (SSE + kernel
  allowlist) keeps other clients' caches in sync. The `rev4-blocks` e2e now
  asserts state restoration across a reload; docs: ADR-0020,
  `docs/api/README.md`, `docs/plugin-sdk/rev4-api.md`.

- **Isolated compute workers (rev4 §C2, `api.workers`).** Sandboxed plugins can
  spawn compute Workers inside their own opaque-origin sandbox
  (`plugins/rev4-worker/` sample): the manifest declares an allowlist of
  self-contained worker entry scripts (`workers: ["workers/double.js",
  "workers/triple.mjs"]`, install-time validated safe relative `.js`/`.mjs`
  paths), and `api.workers.spawn({entry, signal?})` requires the new
  `compute.worker` capability. The host verifies the bundle same-origin
  (≤ `workers.maxBundleBytes` = 2 MiB; `.mjs` additionally ≤
  `workers.maxModuleDataUrlBytes` = 1.5 MiB; MIME `text/javascript`,
  manifest-pinned path) and streams it over a kernel stream; the sandbox
  constructs the Worker in its own realm (`.js` → classic from a blob URL,
  `.mjs` → `{ type: 'module' }` from a base64 data: URL — blob: module
  workers cannot resolve their entry across opaque origins), so the Worker
  inherits the sandbox CSP (`worker-src blob: data:`, `connect-src 'none'`) —
  compute without DOM, direct network, app storage or credentials (data
  authority stays separate: the plugin shuttles data via `postMessage`).
  Handles expose `postMessage(message, transfer?)`, `onMessage`/`onError`
  (unregister), `closed` and `terminate()`. Live workers are capped at
  `limits.workers.maxInstances` (default 2) with the host ledger reconciled
  by sandbox `workers.exited`/`workers.error` reports; session teardown
  (disable/uninstall/navigation) and `compute.worker` revocation terminate
  every live worker. New stable error code `WORKER_SPAWN_FAILED` (retryable).
  v1: self-contained bundles only (classic — no `import`/`export`/
  `importScripts`, module — no `import`), `name`/`memoryBudgetMiB` advisory,
  no SharedWorker/ServiceWorker; backend compute (`compute.backend`) remains
  the fallback for data/network-bound work. Design: ADR-0018; covered by
  kernel unit tests and the rev4 e2e suite (round-trips `doubled 21 -> 42`,
  `tripled 14 -> 42`).
- **Cross-plugin services (rev4 §D, `api.services`).** Sandboxed plugins can
  publish and consume host-mediated RPC: a provider registers service metadata
  with `api.services.provide({name, methods, handle})` (capability
  `services.provide`) and a consumer discovers services, binds a connection
  and calls methods with `api.services.list/connect/invoke/disconnect`
  (capability `services.connect`). Service ids are host-prefixed
  (`<pluginId>.<name>`), so squatting another plugin's id is impossible by
  construction. Every call is routed by the host into the PROVIDER's own
  sandbox session — handlers never cross plugin boundaries as function
  objects and results are JSON-safe. Bounds: 16 services per plugin, 64
  methods per service, 64 connections per consumer, 256 host-wide, payloads
  up to 256 KiB both ways, per-service deadline (default 10 s, capped 60 s).
  Stable error codes for consumers (`SERVICE_NOT_FOUND`,
  `SERVICE_METHOD_NOT_FOUND`, `SERVICE_UNAVAILABLE`, `SERVICE_TIMEOUT`,
  `OPERATION_ABORTED`, `SERVICE_ERROR` with the provider's code in details);
  disabling a provider drops its registry and connections, so stale calls
  degrade gracefully. v1 is web-only (backend plugins are an explicit
  non-goal). Samples: `plugins/rev4-service/` (provider: greet/echo) and
  `plugins/rev4-service-client/` (consumer commands), covered by the rev4 e2e
  suite. Design: ADR-0017.
- **Plugin OAuth connections (rev4 §K5, `api.auth`).** Sandboxed plugins can
  manage host-owned OAuth connections to external services: manifest declares
  public OAuth clients (`authClients`: `clientId`, `authorizationUrl`,
  `tokenUrl`, `scopes` — HTTPS-only with a plain-HTTP loopback exception for
  local IdPs), and the SDK exposes `api.auth.list/get/connect/revoke`. The
  server runs the whole PKCE S256 dance (one-shot `state` + `code_verifier`
  stored per connection); the access token lives only in the new
  `plugin_auth_connections` table (migration 0017) and NEVER reaches the
  sandbox or the UI — authenticated traffic goes through
  `api.network.fetch(url, {connectionId})`, which the server-side proxy signs
  with the stored token. Connection statuses (`pending/connected/expired/
  revoked`), `plugin.auth.connected/revoked/expired` events (SSE + `api.events
  .subscribe`), and revoke wipes the token server-side. v1 does not refresh
  expired tokens automatically. New API: `GET/POST /api/v2/plugins/:id/auth/
  connections|connect|revoke|fetch` and the IdP callback
  `GET /api/v2/plugins/:id/auth/callback` (browser redirect to
  `#/plugin-auth-result`). A host-owned Connections dialog in the Plugins
  panel (`data-component="plugin-auth-manager"`) lists services, scopes and
  statuses without ever exposing token values, and the popup result screen
  (`#/plugin-auth-result`) auto-closes on success. Sample:
  `plugins/rev4-auth/` (mock local IdP, signed-request command), covered by
  the rev4 e2e suite. Requires capability `auth.connections`. Design:
  ADR-0016.
- **Plugin self-diagnostics (rev4 §C).** Sandboxed plugins can read their own
  runtime state: `api.diagnostics.get()` returns a read-only
  `DiagnosticsSnapshot` with protocol/sdk versions, the sandbox `instanceId`,
  registry identity (id, name, version, apiVersion, status, lastErrorCode,
  compatibilityLevel), the active limits, the host feature registry and the
  granted capabilities (capped at 64). The snapshot is built host-side from
  public registry fields only — it never contains secrets, manifests or other
  plugins' state — and requires no capability (the data is the plugin's own,
  like `capabilities.list`). Revoked grants disappear from the next snapshot.
- **Runtime capability grants (rev4 §B2).** Sandboxed plugins can request a
  capability while running: `api.capabilities.request({name, scope?})` shows a
  host-owned consent dialog (one per plugin, 60 s timeout), and an approved
  grant is persisted server-side via
  `POST /api/v2/plugins/:id/capabilities` (idempotent: an already-active grant
  returns as-is without revision churn). Web-side enforcement sees the new
  grant immediately; backend plugin processes pick it up on the next plugin
  activation. Denial, timeout or a busy consent queue reject with
  `CAPABILITY_DENIED` (details.reason `user-denied` / `consent-timeout` /
  `consent-pending`), an unreachable server with `BACKEND_UNAVAILABLE`, and
  unknown names with `VALIDATION_FAILED` / `unknown-capability`. Grants
  survive page reloads. The consent dialog is host-rendered (Radix, portaled
  into `modal.layer`) and exposes `data-component="plugin-consent-dialog"`
  with `data-part="allow"/"deny"` styling hooks.
- **Immediate revocation on the web host.** `plugin.capability.revoked` now
  removes the grant from the live frame grant list (`kernelHasCapability`,
  `capabilities.list`) and from the sandbox `K.grants` at once, so
  enforcement stops without waiting for a plugin-list refetch.
- **Rev4 runtime grant sample.** `plugins/rev4-grant/` demonstrates the full
  consent cycle (request → deny → allow → reload persistence), covered by the
  rev4 e2e suite (deny/allow/persist/immediate re-request).
- **Rev4 kernel events slice (plugin SDK).** Sandboxed plugins can subscribe
  to whitelisted app events over the kernel port:
  `api.events.subscribe(event, listener)` / `api.events.unsubscribe(event,
  listener)` (cleanup returned on subscribe). The allowlist mirrors the SSE
  stream the app already sends to browsers (`BROWSER_APP_EVENTS` plus
  `plugin.capability.revoked`, `plugin.job.due`, `plugin.chat.updated`,
  `plugin.chat.message`); unknown event names fail with `VALIDATION_FAILED`.
  Events carrying chat content (`generation.*`, `chat.message.*`) require the
  `chats.read.current` capability at subscribe time and stop at emit time if
  the grant was revoked (fail-closed). Delivery uses the existing `evt.emit`
  envelope `{event, payload, eventId, cursor?}` with per-listener error
  isolation; subscriptions live in the session scope and are torn down on
  deactivate/uninstall. The rev4-tools sample now subscribes to `chat.opened`
  and the e2e suite verifies end-to-end delivery.
- **Message block overscan.** Blocks attached to chat messages
  (`ui.messageBlock` renderers) are now mounted only while the message is in
  the viewport: leaving the viewport serializes the renderer state
  (`blocks.freeze` → `serialize`) and removes host containers; returning
  remounts and restores (`blocks.unfreeze` → `restore`). The overscan anchor
  is the message element itself, so unmounted blocks never collapse the slot;
  without `IntersectionObserver` blocks stay mounted (previous behavior).
- **Kernel overlay layout deduplication.** `ui.overlay.layout` pushes skip
  geometry-identical rect sets (fingerprint per frame), so layout feedback —
  e.g. block remounts — can no longer ping-pong host↔sandbox at frame rate;
  the revision counter only advances on real geometry changes.
- **Plugin sandbox Permissions-Policy.** The sandbox iframe now carries an
  `allow` attribute denying every sensitive browser feature (`camera 'none'`,
  `microphone 'none'`, `geolocation 'none'`, clipboard, usb/serial/hid/
  bluetooth, local fonts, high-entropy UA data, storage access, credential
  and OTP flows, local-network access, sensors, display capture, fullscreen,
  etc.). Unknown directive names are ignored by browsers, so the deny-list
  stays forward-compatible. Sandboxed frontends can no longer observe
  devices, location, or user data even if the app-level policy broadens.
- **Install plugins from a Git repository link.** The Plugin Manager accepts a
  GitHub/GitLab URL (`POST /api/v2/plugins/install-git`): the server downloads
  the repository archive over HTTPS (no `git` binary), validates it exactly
  like a `.stplugin` ZIP, and installs it with the same atomic replace +
  rollback and consent flow. Only `https://` links on `github.com`/
  `gitlab.com` are accepted; GitLab requires an explicit branch/tag/commit
  ref. The feature can be disabled with `ST2_PLUGIN_GIT_INSTALL=false`.
- **Built-in npm dependency installer for plugins.** When a plugin package
  ships a `package.json` with `dependencies`, the server resolves them from
  the npm registry (no `npm` invocation, install scripts never executed),
  verifies each tarball against the registry `integrity` hash, rejects
  native/executable files, and lays them out in the package's `node_modules`
  (flat hoisting). Backend plugins may then bare-import those modules inside
  their sandbox; the loader still confines resolution to the package root and
  keeps `node:*`/`data:`/`http(s):` blocked. Installed packages are recorded
  in `node_modules/.st2-deps.json` and shown in the Plugin Manager with a
  third-party warning before activation. Authors are strongly encouraged to
  bundle dependencies (esbuild/rollup) instead — on-the-fly resolution targets
  heavy WASM/ML libraries. Config: `ST2_PLUGIN_REGISTRY`,
  `ST2_PLUGIN_DEPS_MAX_PACKAGES`, `ST2_PLUGIN_DEPS_MAX_BYTES`.
- New `@st2/shared` error codes and en/ru localizations:
  `PLUGIN_SOURCE_UNSUPPORTED`, `PLUGIN_SOURCE_INVALID`,
  `PLUGIN_DEPS_UNSUPPORTED`, `PLUGIN_DEPS_CONFLICT`, `PLUGIN_DEPS_FAILED`,
  `PLUGIN_DEPS_FORBIDDEN_FILE`.
- Migration **0015** adds nullable `plugin_registry.source` and
  `plugin_registry.dependencies`; `InstalledPlugin` now exposes optional
  `source` (`zip`/`git`) and `dependencies` provenance.
- **Plugin SDK capability kernel (rev4).** Permissions are now scoped
  capability grants: the manifest requests `{ name, scope }` capabilities,
  the user consents to any subset, and grants persist in
  `plugin_capability_grants` (migration **0016**) with a monotonic revision.
  The same kernel code (`@st2/plugin-sdk` namespace `kernel`) enforces grants
  in the web host and the server capability broker. Sandboxes receive
  `grantedCapabilities`, `supportedFeatures` and `limits` over a single
  transferred `MessagePort` (one-shot nonce bootstrap); feature negotiation
  goes through `api.runtime.supports(feature, version)`. Revocation publishes
  `plugin.capability.revoked` over the SSE whitelist, the web host relays it
  into live kernel sessions, and in-flight operations end with
  `CAPABILITY_REVOKED`. Plugin user state moved out of the registry into
  `plugin_state` (scope `user|workspace|chat|installation`, CAS `revision`
  separate from `schema_version`). New endpoint
  `GET /api/v2/plugins/:id/capabilities` lists active grants. The rev4 kernel
  API surface lands in the sandbox incrementally: `api.storage` (scoped KV with
  CAS revisions + content-addressed blobs), `api.commands`/`api.surfaces`
  (unified registrations), `api.overlays` (`none`/`full`/`native-regions`/
  `proxy-regions` hit policies with normalized pointer packets), `api.chats`
  (scoped handles, message revisions, streaming drafts), `api.blocks`
  (persisted message-block descriptors) and `api.jobs`/`api.network`/
  `api.actions` (background jobs, allowlisted outbound fetch, user-activation
  host actions). Reference samples `plugins/rev4-storage/` and
  `plugins/rev4-overlay/` plus `docs/plugin-sdk/rev4-api.md` and
  `docs/plugin-sdk/examples/rev4-overlay-game.md` document the contract. Docs
  updated (`docs/plugin-sdk/README.md`, `docs/api/README.md`,
  `docs/migrations/README.md`, `docs/data/README.md`,
  [ADR-0014](docs/adr/0014-plugin-capability-kernel.md)).
- New `@st2/gestures` package provides framework-agnostic row gesture
  recognition (context menu on right-click / stationary touch hold, mouse and
  touch drag-and-drop reordering) with configurable travel thresholds,
  long-press delay and per-item drag permission. The host wraps it as
  `useRowGestures` in `@st2/ui`; plugins consume the same core through the
  `@st2/plugin-sdk/gestures` subpath. The Chats panel, the prompt template
  editor and the Backgrounds panel now share this single implementation
  instead of three private copies; the backgrounds panel long-press delay is
  aligned with the rest of the app at 700 ms (was 500 ms). Component, package
  and SDK tests updated; docs updated (`packages/gestures/README.md`,
  `docs/plugin-sdk/README.md`, `docs/architecture/README.md`).
- The sidebar **Backgrounds** panel manages chat wallpapers from the context
  rail: a grid of uploadable backgrounds backed by a new
  `/api/v2/backgrounds` REST surface (list/upload/delete) with content-
  addressed storage in `data/files/backgrounds/` (ST1-imported originals show
  up automatically) and lazily regenerated thumbnails served through the
  existing `/api/v2/assets/thumbnails` route. Uploads are limited to 25 MB,
  validated by MIME and content (`sharp`), and deduped by SHA-256; deletes
  remove the original plus its thumbnail and detach the reference from every
  chat. `PATCH /api/v2/chats/:id` accepts `backgroundId` (or `null`), and the
  chat workspace applies the selection by overriding the Theme SDK token
  `--st-chat-wallpaper-image` via a scoped custom property. Migration 0014
  adds `chats.background_id` (TEXT, nullable, filesystem-authoritative, no
  FK). The `backgrounds` rail item id was added to the Theme SDK
  (`NAVIGATION_RAIL_ITEM_IDS`) and the `backgrounds` i18n namespace covers
  en/ru incl. `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` /
  `FILE_NOT_FOUND` error keys. Component, API, migration and Theme SDK tests
  updated; docs updated (`docs/api/README.md`, `docs/data/README.md`,
  `docs/theme-sdk/README.md`).
- The sidebar **Lorebooks** panel provides full world-info management on the
  context rail: a cursor-paginated book list with global/character scope
  filter, deferred search, and a New Book action; per-book editing (rename,
  debounced description, character linking via `characterId`, soft delete)
  and an entries tab with add/edit/delete dialogs, primary/secondary keys,
  content, `position`, and `constant`/`selective`/`enabled` toggles backed by
  the existing `/api/v2/lorebooks` REST surface (`LorebookListQuery` hooks in
  `useLorebooks`/`useLorebookEntries`, mutation hooks with cache
  invalidation). The Character Management panel's Advanced tab links books to
  a character and offers "new book for character" + unlink shortcuts. The
  `lorebooks` rail item id was added to the Theme SDK
  (`NAVIGATION_RAIL_ITEM_IDS`, all bundled themes, starter theme) and the
  `lorebooks` i18n namespace covers en/ru incl. `LOREBOOK_NOT_FOUND` /
  `LORE_ENTRY_NOT_FOUND` error keys. Component tests, Theme SDK tests and
  docs updated (`docs/ux/README.md`, `docs/api/README.md`,
  `docs/theme-sdk/README.md`).
- The sidebar **Chats** panel manages conversations from the context rail:
  a cursor-paginated chat list automatically scoped to the current
  conversation's character or the pinned Home character, without a character
  picker; deferred search over chat
  titles/summaries and message content via `chats_fts` / `messages_fts`; a
  New Chat action above the list creating a chat for the current/pinned
  character and returning to `/home`. Each row's context menu provides open,
  rename, export
  (`GET /api/v2/chats/:id/export`), move up/down and delete (soft-delete into
  the trash, confirmed in a dialog). Reordering via context-menu commands or
  whole-row mouse/touch drag-and-drop persists optimistically through
  `PUT /api/v2/chats/order` and is only enabled in a single-character,
  non-search list where ordering is meaningful. A stationary touch hold opens
  the context menu, while movement starts reordering; portalled menus render
  above the full-screen phone sidebar. Migration 0013 adds
  `chats.sort_order` with a `chats_character_sort_idx
  (character_id, sort_order, updated_at, id)` index; new chats default to 0
  and surface on top via the existing `updated_at DESC` tie-break, so no
  backfill is needed. Component, i18n and API docs updated
  (`docs/ux/README.md`, `docs/api/README.md`, `docs/data/README.md`,
  `docs/migrations/README.md`).
- The character catalog supports an expanded sort vocabulary: `name` (A–Z),
  `name-desc` (Z–A), `newest`, `oldest`, `favorites`, `used` (recently used,
  never-used last), `chats-most` / `chats-least`, `tokens-most` /
  `tokens-least`, `random` (a single shuffled page with no cursor), and
  `relevance`. Deprecated aliases `recent` → `newest`, `created` → `oldest`,
  `usage` → `used` stay accepted. Migration 0012 adds `favorite`, `chat_count`
  and `token_count` columns to `characters` (backfilled and kept in sync by
  SQL triggers on `chats` / `messages`; trash is excluded; `token_count` is a
  content-length proxy in characters, not real tokens). `favorite` mirrors
  `ext.favorite` / `ext.legacy.favorite` so "favorites first" is indexable
  while `ext` stays the source of truth (API contract unchanged). New
  `(favorite|chat_count|token_count DESC, name, id)` indexes keep a 100k
  catalog within the 300 ms first-page target. The browser select exposes all
  options with localized labels (`characters:sort_*`); `random` returns a
  fresh page on each load (`staleTime: 0`). Repository integration tests cover
  ordering, tie-breaks, cursor pagination, legacy aliases, and trash
  exclusion; the migration test covers backfill + trigger behavior
  (`packages/db/test/charactersSorting.test.ts`).
- Character search (`GET /api/v2/characters?q=`) supports a query syntax:
  free text, exact phrases in quotes, `tag:` / `-tag:` / `author:` /
  `-author:` / `name:` / `-name:` filters, and full-text column filters
  `desc:` / `persona:` / `scenario:`. Queries with positive terms are
  evaluated through the FTS5 index with bm25 relevance ranking regardless of
  the requested `sort`; negative-only or degraded queries fall back to SQL
  filters. Migration 0011 adds a `tags` column to `characters_fts`
  (backfilled, kept in sync by triggers on `character_tags` and recreated
  `characters` triggers, included in the diagnostics rebuild), so free text
  also finds characters by tag name. `tag:` / `-tag:` match by tag-name
  prefix (case-insensitive, `tag:sf` finds `sfw`); the legacy `tag` query
  param stays an exact match. Parser unit tests and repository integration
  tests cover the grammar, ranking, cursors, and soft-deleted rows
  (`packages/db/src/repositories/characterQuery.ts`,
  `packages/db/test/characterQuery.test.ts`,
  `packages/db/test/charactersSearch.test.ts`).
- The distribution now ships a curated set of bundled themes (AMOLED, GitHub
  Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha,
  Solarized Dark, One Dark). On first boot `seedBundledThemes` copies each
  package from `apps/server/assets/themes/` into `data/themes/<id>/` and
  registers it in `theme_registry`, so the Themes manager opens with real
  themes instead of an empty list. An `app_meta` marker tracks installed ids:
  themes added in a later release appear on update, user-deleted ones are not
  re-created, and no theme is activated automatically — the built-in light/dark
  tokens remain the safe-mode/reset fallback. Previews are generated
  deterministically by `pnpm theme:previews`.
- Connection profiles are now available through typed CRUD/apply endpoints on the
  server. The AI Settings **API** tab is the supported UI for saving and
  activating provider connection profiles; the separate Profiles tab has been
  removed.
- `GenerationRequest.assistantPrefill`, profile stop-string merging, and the
  Provider SDK prefill capability. Built-in chat and text adapters serialize
  supported prefills.
- Multi-surface sandbox composition: one clipped iframe per plugin, isolated
  roots per registration, batched layout updates, and selective cleanup.
- Shared responsive action contract in `@st2/ui`: `ActionBar` /
  `ActionBarGroup`, structured Button `icon`/`label` parts, and Tabs
  layout/overflow strategies. Theme SDK documents the stable hooks and ships
  an editable, deterministically generated three-file starter kit.
- Theme tokens `shell-panel-min-width` and `shell-panel-max-width` now bound
  resizable context panels without hardcoded runtime limits.
- Theme SDK navigation composition through
  `shellLayout.navigationRail.main/bottom`: themes can reorder core rail
  actions and place or omit `menu-toggle`. Collapsing keeps only the rail root
  and its single configured toggle mounted, removes other items from
  DOM/layout/paint, closes and unmounts `panel.left` with its content, and
  reuses that toggle to restore the rail. The built-in layout now places the
  toggle first; the same control remains the first rail item and is aligned with
  `chat.header` on desktop and mobile without creating a duplicate. The mobile
  rail remains a full-height shell block above the header
  layer: opening it reserves rail width and shifts the main canvas while the
  toggle stays in the rail's top cell. The regular navigation group now starts
  after that toggle and its structural divider (`chats` is first by default),
  rather than attaching the divider to a specific destination. On every viewport
  this compact rail-only divider shares the exact vertical boundary and color of
  `chat.header`; the mobile header divider uses the same non-zero inset on both
  inline edges as the rail, keeping both segments compact instead of extending
  the header line to the viewport edge. When the rail is collapsed, its toggle
  no longer paints that divider over the header line. Theme-defined
  `main`/`bottom` ordering is now preserved on mobile instead of being
  overridden by the host.

- Server theme contract tests (`apps/server/test/api.test.ts`,
  `describe('themes')`): rejected malformed archives (non-ZIP 400, missing or
  broken manifest, traversal asset paths, forbidden CSS — remote `url()`,
  `behavior:url(#default#VML)`, `javascript:` URLs, `!important`), inheritance
  cycles and missing parents, asset serving (`FILE_NOT_FOUND` 404,
  `FILE_TYPE_NOT_ALLOWED` 415) and per-theme settings lifecycle
  (defaults, validated patches, cleanup on theme delete).
- E2E theme contract suite (`e2e/theme-contract.spec.ts`): localized install
  errors in the UI, traversal-entry archives, persisted theme settings emitted
  as CSS variables after a reload, and deleting the active theme clears its
  document overrides. Shared helpers moved to `e2e/helpers.ts`
  (`zipBuffer`, `postJson`, `expectNoA11yViolations`).
- Visual snapshot with an active installed theme
  (`e2e/visual.spec.ts` → `home-installed-theme.png`).
- Per-theme settings endpoints documented in `docs/api/README.md`
  (`GET/PATCH /api/v2/themes/:id/settings`).
- New canonical theme tokens: typography (`font-size-2xs`, `font-weight-*`),
  `radius-panel`, control geometry (`control-height-sm/xs/2xs`, `switch-*`,
  `menu-min-width`, `dialog-max-width/max-height`, `textarea-min-height`,
  `spinner-size`) and the chat column width (`size-chat-column-max`). All
  literal usages in the built-in CSS were migrated to these tokens with
  pixel-identical values.
- Theme SDK now ships a breakpoint registry
  (`packages/theme-sdk/src/breakpoints.ts`): `VIEWPORT_BREAKPOINTS`
  (`480…1080px`) and `CONTAINER_BREAKPOINTS` (`20…44rem`). Container queries
  must use rem; the single px container query (`560px`) was migrated to
  `35rem`.
- A style-contract test suite (`packages/theme-sdk/test/style-contract.test.ts`)
  fails the build when built-in CSS uses numeric `font-weight`, px `font-size`,
  numeric `z-index`, raw px `border-radius`, control-size literals
  (`32/36/40/44/52px`), unregistered viewport/container breakpoints, or
  `!important` outside the a11y override stylesheet.
- A theme-starter contract test
  (`packages/theme-sdk/test/theme-starter.test.ts`) verifies the shipped
  `theme-starter.zip` parses as ZIP, passes `validateThemeManifest`, references
  existing assets, and only uses known tokens and documented hooks.
- Shell slot registry aligned with ADR-0011: `character.browser` added on the
  Characters page, the inner chat canvas is `data-part="canvas"` (the outer
  `<main>` keeps `data-slot="chat.viewport"`), and the docs now list exactly
  the implemented slots (`navigation.secondary` / `panel.right` are not part
  of v1).
- ADR-0011 «Shell layout v1» documents slots as stable skin-targets, content
  geometry as an explicit exception, and the breakpoint/style contract;
  ADR-0006 references it for the shell rearrangement limitation.
- Tab lists are unified across system surfaces: Personas, Characters, AI
  Settings and plugin panels/character tabs all use the shared segment
  variant instead of per-panel underline/grid reimplementations. The `Tabs`
  root is now a flex column with a documented `order` contract on
  `[data-component="tabs-list"]`: inside the sidebar panel the tab list moves
  to the bottom at the ≤600px overlay breakpoint (mobile tab bar), and themes
  can override the placement declaratively through the `theme` layer
  (docs/theme-sdk/README.md, ADR-0011 component-level placement).

### Fixed

- **Segment tabs now animate a sliding active indicator (`@st2/ui` `Tabs`,
  `variant="segment"`).** AI Settings, Personas, Characters, Settings and
  plugin panels share the same segment control; switching Config / API /
  Advanced slides the highlight via CSS custom properties instead of measuring
  DOM nodes (Radix unmounts inactive tab panels, which previously reset the
  indicator through `ResizeObserver`).

- **Kernel byte streams no longer truncate when the producer ends before the
  consumer's initial credit arrives (`packages/plugin-sdk/src/kernel/session.ts`,
  `apps/server/src/plugin/sandboxRev4.ts`).** `openOutboundStream(...).end()`
  sent `stream.end` immediately and dropped the outbound state; the consumer's
  `stream.credit` (one macrotask after `stream.open`) then found no producer,
  so queued chunks were never pumped and the peer read 0 bytes. `end()` now
  defers the `stream.end` envelope until the queue drains. This race was the
  true cause of the 2026 "Chromium kills blob:/data: module workers" finding:
  worker bundles arrived empty and module workers die silently on empty
  source. With the fix, `.mjs` worker entries are enabled, the
  `plugins/rev4-worker` sample gains `workers/triple.mjs`, and spike 6 pins
  the positive module-worker capability (ADR-0018). The sandbox CSP
  `script-src` now includes `blob:` (module workers load their entry through
  script-src; `connect-src 'none'` is unchanged), and spike 8 pins module
  workers under the production CSP.
- **rev4 sample plugins and e2e suite (`plugins/rev4-tools`, `plugins/rev4-blocks`,
  `plugins/rev4-agent`, `e2e/rev4-samples.spec.ts`).** The kernel command
  registrations pass `{ kernel: true }` so toolbar buttons invoke runners over
  the kernel port instead of the legacy v2 postMessage path; `ui.notifications`
  is the host feature name checked by `runtime.supports` (the capability grant
  remains `notifications.show`); capability presence is probed with
  `api.capabilities.granted(name)` rather than `supports(feature)`;
  `chats.listMessages({})` without an explicit `chatId` targets the current
  chat under `chats.read.current` (an explicit foreign `chatId` requires
  `chats.read.all`), and message pages are newest-first so `items[0]` is the
  last message. Message-block content lives in the sandbox iframe container
  (`data-st2-registration="blk:..."`) anchored by the host slot
  (`data-part="plugin-block"`) in the message DOM. The server dispatcher now
  passes plain JSON worker responses through untouched and only normalizes
  responses that actually carry the `PluginResponse` envelope. All three
  samples pass the full user cycle (install → consent → activate → toolbar).
- Sidebar panels now stay mounted and non-interactive through their token-driven
  exit animation, then unmount on `animationend`; rapid reopen no longer loses
  the panel DOM or produces an abrupt close.
- Character Management header now switches between a neutral eye action for
  read-only preview and a neutral pencil action for editing. The unrelated
  full-library shortcut, duplicate editor preview action and viewer action bar
  were removed.
- Full-height Personas and Characters tabs now start at the inset top of their
  shared menu ScrollArea and scroll away with its content on desktop. Theme SDK
  exposes the inherited `shellLayout.managementTabs.pinned` switch (`false` by
  default); themes can set `true` for sticky behavior. The existing bottom
  placement and safe-area inset remain unchanged on mobile.
- Navigation-panel headers no longer add the redundant `Workspace` eyebrow.
  Their shared chrome now uses one `--st-control-height-large` row on desktop
  and mobile, with the top safe area owned by that row instead of an extra
  outer panel inset. The header now sits one stacking step above panel content,
  while its separator is painted as a dedicated overlay in the original
  `--st-color-border`. Scrolling content and floating controls can no longer
  cover the line without changing its established color.
- Persona Management and Character Management now use the same inset content
  frame as AI Settings. Their segmented tabs now float as a translucent cloud
  above the full-height ScrollArea, so the surrounding inset is genuinely
  transparent and scrolled content can pass behind it. A dedicated scrolling
  spacer keeps controls reachable without adding padding to the Radix wrapper
  or shrinking full-bleed viewers; desktop-top and mobile-bottom placements
  are covered by geometry, axe and visual regressions. The base cloud no
  longer casts a shadow, and mobile panels ignore stale desktop resize widths
  so they fill the viewport from the navigation rail to the opposite edge.
  Mobile shell padding no longer doubles the top/bottom gaps: safe areas are
  owned by the header, scroll body, and floating cloud instead.
- Text actions such as Character Management `New` / `Import`, dialog footers,
  settings maintenance controls, plugin/theme actions and plugin toolbar items
  no longer squeeze, lose icons or overlap at narrow panel widths. Compact
  toolbars measure their natural content width against their own available
  space, use hysteresis, keep icon actions horizontal and visually hide only
  their labels; no viewport threshold is involved. Forms retain
  wrapping/stacking. Character tabs use local overflow, panel resizing uses
  logical RTL-aware geometry, and the 320 px state is covered by behavioural,
  accessibility and visual tests.
- Sidebar resizing now clamps the stored runtime width to Theme SDK min/max
  tokens, and the visible panel and shifted chat use the same effective width.
  Dragging past a limit no longer moves the chat behind a stationary panel;
  the resize handle is also keyboard-operable in LTR and RTL.

- Default theme message colors now meet WCAG 2.2 AA (4.5:1) on the chat
  surface: light-mode `color-message-quote`/`color-message-emphasis` darkened,
  dark-mode `color-message-quote` brightened; mirrored in
  `packages/ui/src/styles/tokens.css` and `@st2/theme-sdk` default tokens.
- E2E `flows.spec.ts` expected the untranslated `Context Usage` instead of the
  i18n `chat:contextUsage` string.
- E2E `release.spec.ts` AI-settings flow was order-dependent: it reused the
  plugin connection profile left behind by the prompt-order test. The profile
  is now reset to the built-in one before editing.
- The SillyTavern archive migration test no longer leaves the default persona
  behind, which polluted the `assembled N message(s)` audit in later
  generation tests.
- Theme token contract is now single-source and verified: undefined tokens
  `--st-font-size-xs`, `--st-space-2xs`, `--st-radius-pill` and
  `--st-shadow-panel` used by components are resolved. `font-size-xs` and
  `space-2xs` joined the canonical `TOKEN_NAMES`; `radius-pill` usages were
  replaced with `radius-round` and `shadow-panel` with `shadow-overlay`.
  Panel/content sizes and scrollbar tokens (`size-*`, `scrollbar-*`) became
  theme-overridable instead of CSS-only. A contract test
  (`packages/theme-sdk/test/token-contract.test.ts`) fails the build when a
  `var(--st-*)` in the UI source is not a canonical token or when
  `packages/ui/src/styles/tokens.css` drifts from the SDK defaults.

- All app CSS modules (`apps/web/src/**/*.module.css`) now declare
  `@layer components`, matching the required stack
  `reset, tokens, base, components, plugin-base, theme, user`. Previously
  unlayered module CSS outranked every cascade layer, so theme `skin` CSS could
  not override component styles; now the `theme` layer wins over components at
  equal specificity.

- `packages/shared` macro test asserted a stale weekday (`Thursday` for
  `2026-07-31`, which is a Friday); the assertion now matches the resolved
  date.

- Chat and home greeting messages now expand `{{user}}`, `{{char}}`, time/date,
  `{{random:…}}`, and settings `macroVariables` for display and in-chat search
  while keeping the raw authored text in storage. Legacy `substituteMacros`
  uses the same resolver as the prompt pipeline (active persona + character
  names). Macro helpers live in `@st2/shared` for backend and frontend parity.

- Personas are fully manageable from the sidebar panel: create, rename,
  duplicate, delete, description editing, active/default selection, and a
  per-chat persona override in the chat header. New chats inherit the active
  persona; generation falls back to the default persona when none is selected.

- Home and live chat composers no longer drift: Send/Stop, the utility row
  (settings shortcut, scroll-to-latest, reset), empty-state heading level,
  submit-error placement under the composer, and context-trigger loading
  chrome are owned by the shared `ChatComposer` / `ChatWorkspace` surface.
  Scroll-to-latest uses its own label instead of reusing «Load older
  messages».

- Home and chat now use one shared context-usage panel instead of separate
  implementations. Home runs a side-effect-free preview through the current
  character card, persona, lorebook, prompt-template, tokenizer, and
  context-shifting pipeline; an existing chat reads its latest prompt audit.
  Placeholder character/world-info counts were removed, and only included
  prompt entries contribute to the displayed categories. Home preloads the
  preview while the panel is closed and keeps the latest real breakdown and
  tokenizer label visible while a 500 ms debounced draft update is
  recalculated.

- The pinned character's authored greeting now renders as the first assistant
  message with character identity on the chat-first home screen instead of
  appearing as centered empty-state copy. Its header is reduced to character
  identity and an inline search that highlights matches in the current
  conversation.

- Home composer no longer shows persistent provider and keyboard-hint copy
  beneath the message field; the disabled Send action remains the clear state
  indicator.
- Pressing Escape over an open dropdown menu no longer closes the sidebar
  panel underneath: the sidebar's global Escape handler now listens in the
  capture phase (React synchronously unmounts dialogs/menus before the
  bubbling phase) and ignores the key while a `[role="dialog"]` or
  `[role="menu"]` element exists.
- The prompt template editor no longer wipes in-progress edits: hydration
  from refetched settings is skipped while a block dialog is open, when the
  incoming state only echoes a save this client already sent, or when it is
  not newer than the last hydration (e.g. a failed refetch left a stale
  snapshot behind).
- The character card export menu now renders real links: `DropdownMenuItem`
  supports `asChild`, and the export actions are `<a href>` anchors so the
  menu stays keyboard-focusable and openable in new tabs/background tabs.
- E2E: the visual suite waits for thumbnail images to finish loading before
  screenshots (thumbnails are generated lazily in a fresh data directory per
  run); the home light/dark, installed-theme and pseudo-mobile-RTL goldens
  were regenerated. The export-menu assertions target the portalled menu at
  page level (`role="menu"` + `href`), and the release flow switches to Chat
  Template explicitly so it no longer depends on the shared server's
  persisted prompt mode.

### Changed

- **Plugin kernel protocol version normalized to strict semver (rev4 §A4).**
  The kernel advertises `protocolVersion: '2.0.0'` everywhere (host
  handshake, sandbox `api.runtime`, diagnostics snapshot) so the value
  parses with the SDK's own strict `x.y.z` version negotiation; the
  authoring contract now also types `api.events.subscribe/unsubscribe`.
- Context usage panel (`ContextUsagePanel`) is transparent inside the glass
  composer shell; metric/icon chips use light tints instead of opaque surfaces.
- The bundled AMOLED theme (`1.1.8`) keeps context usage on the composer glass
  layer (transparent panel, tinted metric/icon chips) instead of a second opaque
  shell.
- The bundled AMOLED theme (`1.1.7`) drops all shell layout overrides (legacy
  `chat-panel > chat.composer` grid overlay, `composer-sticky` hacks, and
  `::after` gap fills). Composer geometry is host-only like Nord/Dracula;
  AMOLED `components.css` supplies glass skin (elevated 92% shell, transparent
  inner parts, glass context-usage panel).
- The bundled AMOLED theme (`1.1.6`) restores translucent glass on the composer
  and context-usage panel: one elevated outer shell with transparent inner
  parts (pure `#000` token stacks otherwise read as a solid block), and a
  `composer-sticky::after` fill for the sticky bottom inset only — host geometry
  unchanged.
- The bundled AMOLED theme (`1.1.5`) uses the same host composer contract as every
  other bundled theme (sticky `composer-sticky`, shared glass layers, markdown
  column width). AMOLED no longer overrides composer inset, panel padding, or
  inner toolbar/field transparency; only an opaque `chat-panel` canvas prevents
  wallpaper bleed in the sticky offset on pure black.
- Shared chat shell: sticky glass composer inside the scroll viewport (no
  `ResizeObserver`), single `backdrop-filter` layer on `.composer`, light inner
  tints (≤12%), scrollbar gutter via `margin-inline-end` on the composer wrap.
- The Settings menu is now a tabbed sidebar panel (role="tablist", shared
  segment variant) with **General / Themes / Data** tabs instead of links into
  separate pages. The Themes tab lists built-in and installed themes with
  apply/reset actions and installs packages directly; the System/Light/Dark
  mode selector was removed everywhere. The Data tab hosts SillyTavern
  migration and backups (create/refresh/restore). The full `/settings` page
  is gone — deep links to it fall through to `/home`; the onboarding
  "Import existing data" card was removed, and `themes:openManager` keeps the
  full theme manager (safe mode, delete, starter kit) reachable from the
  Themes tab.
- The General settings tab no longer shows the Conversation defaults section
  or the Workspace density control. Existing stored preferences and API
  contracts remain unchanged.
- The Themes tab now uses a responsive dropdown for switching between the
  built-in interface and installed themes instead of a long card list.
- Successful theme selection in Settings no longer shows a transient
  `Applied ...` notice; actionable errors remain visible.
- The local Vite API proxy no longer forwards the browser `Origin` to Fastify,
  so a fallback dev-server port does not cause a CORS failure; remote mode
  keeps exact Origin validation.
- The bundled AMOLED theme now uses translucent "glass" surfaces throughout:
  dialogs, menus, comboboxes, cards, text fields, the sidebar panel, nav rail
  and panel headers render at ~70% opacity with `backdrop-filter` blur, and the
  chat wallpaper overlay is lightened (`rgba(0,0,0,0.5)`), so a wallpaper shows
  through the whole interface instead of flat opaque black. The chat composer
  keeps its field and textarea transparent inside one translucent outer surface,
  overlaps the bottom of the message viewport, and reserves enough scroll space
  to reveal the final message above it. This prevents nested black backgrounds
  from appearing opaque. Theme CSS URLs now include an install-version
  cache-buster, so replacing a package with the same id applies its new styles
  without a stale browser cache. The collapsed navigation rail no longer
  paints its glass background over the first 60 px of the chat or composer.
  Toolbar, context details, metric cells, field and textarea now share the
  composer's single outer glass surface instead of stacking translucent or
  opaque black backgrounds (theme `1.1.2`).

### Added

- Chat messages render sanitized Markdown with SillyTavern 1 roleplay defaults:
  `"..."` dialogue quotes, `*emphasis*`, `**strong**`, and `` `code` ``.
  Quote / emphasis / code colors are theme tokens (`color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`) with
  stable `data-part` hooks; streaming replies use the same renderer.

- Home and live chats keep readable side padding in the message viewport, and
  authored greetings with alternates can be switched with a `‹ N/M ›` pager or
  horizontal swipe. `POST /chats` accepts `greetingIndex` and stores
  `{ greeting, swipes, swipeId }` on the first assistant message.

- Prompt Template now uses an ST1-style Prompt Manager instead of stacked
  include cards: a dense Name/Tokens list, stable mouse/touch drag ordering,
  source/type markers, an enable control before each name, custom prompt
  creation, and a full modal editor for name, role, triggers, relative/in-chat
  position, depth/order, override protection, and prompt text. Draft changes
  autosave without footer actions, while row and total token counts use the
  latest prompt audit when available. `Chat History` and
  `Post-History Instructions` are fixed as the final two blocks. Custom entries
  persist in settings and presets and are applied by the server pipeline,
  including macro expansion, generation-trigger filtering, and in-chat
  insertion.

- Character Management: Edit now includes a complete read-only card viewer.
  Creator's notes render Markdown and sanitized HTML/CSS together in the card's
  central, auto-sized sandboxed preview. Its permanent identity header exposes
  the original avatar across the panel width and
  well-spaced tags, while Description and Greetings
  stay collapsed until opened; each greeting is separately collapsed. Creator
  documents are sized to their content, leaving one panel scrollbar. The viewer
  exposes only a return-to-edit control and cannot change character data. Selecting,
  importing, creating, or duplicating a character opens this viewer first.

- Character Management now follows the SillyTavern workflow in one sidebar
  surface: Cards, Edit, Advanced, and Gallery. It supports real create/import,
  pin/select, search/sort, list/grid, avatar upload, favorite metadata,
  compact alternate greetings, chip-based tags, explicit PNG/JSON export,
  duplication, prompt overrides, creator metadata, Character's Note
  depth/role, talkativeness, dialogue examples, thumbnail previews that open
  local full-resolution originals, and manually selected 1–4 column gallery
  layouts. Edit/Advanced share one header save action instead of duplicating a
  sticky Delete/Save footer.
  Character galleries use the existing attachment store for content-addressed
  upload/list/delete and primary-avatar selection without a schema migration.
- Search: tag filter for character scope, date/name sorting, dedicated FTS5
  index over lorebooks (books themselves are searchable, not only entries),
  transactional index rebuild, and `last_used_at` usage tracking with a
  `usage` catalog sort; `relevance` sorting is now FTS-rank driven.
- Data: chat trash restore/purge (`POST /chats/:id/restore`,
  `DELETE /chats/:id?purge=true`), character version history snapshots on
  every edit with list/restore endpoints, `GET /personas/:id`, typed
  `CHAT_BRANCH_NOT_FOUND` for unknown branches, and a pre-migration backup in
  the standalone `pnpm db:migrate` runner.
- Memory/RAG: `memories` store (migration 0006) with keyword retrieval wired
  into the prompt pipeline as the Memory stage, plus `/api/v2/memories` CRUD.
- Providers: HTTP status differentiation (`UNAUTHORIZED`, `RATE_LIMITED`,
  `MODEL_NOT_FOUND`), no raw upstream error bodies on the wire, streaming
  token usage (`stream_options.include_usage`), `contextLimit` in model
  listings, exact offline tokenizers in adapter `countTokens`, provider
  diagnostics logging, and `validateConfig` enforced on create/update/
  generate. Multimodal foundation per ТЗ §4.3: speech/image/transcription
  contracts, optional adapter methods with capability declaration, offline
  echo implementations, `/api/v2/providers/:id/{speech,images,transcribe}`
  routes and plugin-worker forwarding.
- Provider setup now uses a persisted source catalog, write-only credentials,
  connection tests/model discovery, capability-driven samplers, and a native
  Anthropic Messages adapter with prompt caching. The inline AI settings no
  longer use demo providers, keys, models, statuses, or preset actions.
- Provider secrets manager (SillyTavern-style): each provider now stores
  multiple labelled API keys with exactly one active. New `provider_secrets`
  table (migration 0009) and `/api/v2/providers/:id/secrets` CRUD plus a gated
  `/reveal` endpoint and `/api/v2/secrets/exposure`. Secret values stay
  write-only (masked in lists); reveal requires the server flag
  `ST2_ALLOW_SECRETS_EXPOSURE` (default off). The provider editor's key field
  now opens a multi-key manager (add / make active / rename / copy / delete).
- API tab redesign (SillyTavern-style): the provider editor adds a Prompt
  Post-Processing mode select, an Additional Parameters dialog (include body /
  exclude body / include headers, authored as JSON and validated client- and
  server-side), a "View hidden API keys" affordance, a `/v1` base-URL hint for
  custom sources, and an "Auto-connect to Last Server" toggle. Connecting now
  persists `settings.lastServer`; on launch `AutoConnectSync` restores and
  re-validates the last connection when `settings.autoConnect` is enabled.
  Additional parameters deliberately use structured JSON instead of ST1's YAML
  (see ADR-0008); forbidden headers (`Authorization`, `Content-Type`,
  `Content-Length`) cannot be overridden.
- API Settings: the inline API tab now keeps its connection-profile selector
  visible, provides an explicit available-models selector after `/v1/models`
  discovery, and gives API-key management a saved-key selector plus one
  dedicated manager control. Removed the redundant enabled switch, test
  message, save, additional-parameters, and send-test actions; connecting is
  now the sole bottom action.
- API tab parity (SillyTavern `main_api`): the provider editor now leads with a
  top-level **API** selector — Chat Completions vs Text Completions — derived
  from each catalog entry's `adapterKind`; the **Source** ("API Type") list is
  filtered to the selected API and resets to its first source on switch. The
  connection no longer needs a manual **Name**: the chosen source is the
  identity (SillyTavern-style), so a key saves immediately; the panel hides the
  Name field when a source is set, and the full profile editor keeps it as an
  optional override. The secrets manager dialog gains a quick **Active key**
  selector in its header for switching the active key without scrolling the
  list.
- Provider backends (SillyTavern parity): four new generation adapters behind
  the unified `ProviderAdapter` contract — a generic OpenAI-compatible
  **Text Completion** adapter (`/v1/completions`, prompt serialized as text)
  with `ooba` / `koboldcpp` / `vLLM` / `Ollama` source presets, plus
  **NovelAI**, **AI Horde** (async submit-and-poll queue, anonymous or keyed),
  and **KoboldAI Classic** (`/api/v1/generate`). The source catalog, provider
  kinds, and `adapterKind` union are widened accordingly. Text adapters
  consume the rendered instruct prompt (see prompt-pipeline `serializeAsText`),
  never a chat-message array; NovelAI/Horde/Kobold are plain-`fetch`
  integrations marked experimental where the upstream API is not formally
  stable, and are covered by mocked transport tests.
- Prompt pipeline (SillyTavern parity): the Prompt Post-Processing select now
  takes effect server-side. A port of SillyTavern's `mergeMessages` reshapes
  chat-mode messages right before provider serialization (`merge` / `semi` /
  `strict` / `single` and their `_tools` variants); text adapters skip the stage
  because instruct rendering already collapses roles into one prompt. The
  Additional Parameters (`customIncludeBody` / `customExcludeBody` /
  `customIncludeHeaders`) are now applied on the wire by the `openai-compatible`
  and `text-completion` adapters — merging and excluding request-body keys and
  adding extra headers, while the forbidden headers (`Authorization`,
  `Content-Type`, `Content-Length`) can never be overridden.
- Pipeline: time/date/weekday/random macros and settings-driven custom
  variables; selectable built-in instruct formats
  (`settings.instructFormatId` + `GET /settings/instruct-formats`);
  `AbortSignal` honored across assembly and hooks; context strategies run
  with a timeout and fall back to truncation; interceptor journal records
  prompt diffs; plugin provider streaming is bounded by an idle deadline
  instead of a fixed 30s RPC timeout.
- Prompt templates: Advanced settings can switch between Chat and Text modes,
  reorder/enable validated prompt blocks, edit post-history instructions, and
  import/export persisted prompt-template and generation presets. Each
  generation now persists the latest bounded per-chat context audit, exposed
  in the chat usage inspector with exact provider messages, exclusions,
  tokenizer budget, diagnostics, and terminal status.
- Events: `GET /api/v2/events` SSE channel delivering whitelisted app events
  to browsers for cache invalidation and multi-tab sync.
- Plugin SDK: partial consent (any subset of requested permissions; legacy
  entrypoints still require `legacy.trusted`), `chat.read` enforced on
  backend event subscriptions, declared interceptor `timeoutMs` honored,
  i18n bundles and notifications removed on deactivation, sandbox lifecycle
  errors surfaced, and backend app events (chat/generation lifecycle,
  language changes) delivered to frontend plugins.
- Theme SDK: persisted per-theme settings emitted as manifest-declared CSS
  custom properties (`GET/PATCH /themes/:id/settings`), theme translation
  resources (`locales` in theme.json) registered under `theme.<id>`.
- Legacy compatibility: extended `getContext()` (chat history, macros,
  token counting, `generate`, `power_user` subset, real request headers with
  CSRF), slash-command and prompt-interceptor bridges, more `event_types`,
  legacy i18n resources, version cache-busting on update, and Express host
  support for `res.write`/`res.end` streaming handlers.
- SillyTavern import (ТЗ §16): groups with group-chat transcripts,
  backgrounds, extension settings (into the legacy settings store),
  OpenAI-compatible API settings as disabled providers, UI extensions as
  consent-gated legacy plugin packages, and themes/custom CSS preservation.
- Backups: `DELETE /api/v2/backups/:id`.
- Logging: redacted structured log file under `data/logs/server.log` with
  startup rotation, alongside console output.
- i18n: Russian CLDR plural forms (one/few/many), missing-key logging in dev,
  a real ru↔en key-parity test and a pseudo-locale long-string test.
- Tests: corrupted character-card suite (all six rejection paths), contracts
  schema suite, and a ТЗ §18 performance benchmark (`pnpm benchmark`: 100k
  characters / 10k messages, catalog ≤300 ms and chat open ≤700 ms targets).
- CI: `ci.yml` runs lint, typecheck, unit/integration tests, web component
  tests, production build and the Playwright accessibility suite on every PR.
- Data: migration 0007 — covers the generation hot path
  (`messages(chat_id, branch_id, created_at DESC, id DESC)`), expression
  indexes for usage sort and import-hash lookups, COLLATE NOCASE name
  indexes, a `chats_au` trigger restricted to FTS-indexed columns, and a
  `memories_fts` backfill; stable `app_meta.install_id` generated on first
  open; migration runner records and verifies per-migration content hashes
  (edited applied migrations are rejected); `appMeta`, `cacheMetadata` and
  `attachments` repositories (the `cache_metadata`/`attachments` tables are
  no longer write-dead — thumbnail generation records cache metadata).
- Starter content: bundled Seraphina V3 character assets and the linked
  four-entry Eldoria lorebook are imported resumably once per installation;
  the initial chat is created atomically with the authored greeting, while
  post-import user edits or deletion are never restored on startup.
- Memory/RAG: retrieval now also activates memories whose content matches
  the context via the previously write-only `memories_fts` index
  (`ftsMatchRanks`, bm25), and `rebuild()` rebuilds `memories_fts` too.
- Events: the SSE channel is consumed at app level — backend-driven changes
  (other tabs, legacy bridge, plugins) invalidate TanStack Query caches;
  `character.selected` is emitted when a character chat opens.
- Desktop: core updater wired end-to-end — update check on open plus
  install/restart controls in the diagnostics panel (localized), Tauri CSP
  defense-in-depth, and `desktop:release` chains a per-platform release
  smoke.
- Plugins: bundled reference plugin `plugins/example-hello` (frontend
  toolbar/command/slash registrations + backend route).
- Contracts: `/health`, `/version` and `/settings/instruct-formats` moved
  from inline TypeBox to `@st2/contracts`.
- Tests: `packages/ui` brought into the vitest config with component tests;
  route suites for memories/personas/characterTransfer/events; web api and
  UI-state tests; shared/legacy-compat/db unit tests with a schema↔migration
  parity check; a legacy server-plugin contract suite; Playwright visual
  regression for the base theme and functional e2e flows.
- AI settings: generation sampler values are now editable number inputs —
  type a value directly and the slider follows, blur/Enter clamps it to the
  parameter's `min`/`max`/`step` (SillyTavern-style manual entry) — alongside
  an “Unlocked context size” toggle that lifts the default 200k context-size
  slider ceiling (up to 10M) for large-window models.

### Changed

- Security (ТЗ §13): Origin validation for state-changing API requests in
  local mode, host-side authoritative `network:<host>` enforcement for plugin
  fetch (worker check is fail-fast only), bounded plugin fetch responses,
  SSE parser buffer cap, typed `FILE_TOO_LARGE` for oversized JSON bodies,
  and structural validation of worker→host RPC envelopes.
- Chat list title filtering goes through the trigger-synced `chats_fts`
  index (prefix search) instead of an unindexable `LIKE '%…%'` scan.
- Provider API keys moved from the single `provider_configs.api_key` column to
  the dedicated `provider_secrets` table; migration 0009 transfers an existing
  key into an active "migrated" secret and nulls the column. The column is kept
  only as a read fallback for unmigrated databases.
- Profiles: the active profile is tracked in `app_meta` (`setActive`/
  `delete` added); `getCurrent()` falls back to the oldest profile.
- Desktop packaging scripts resolve native modules via `require.resolve`
  and honor `TAURI_ENV_TARGET_TRIPLE` for Sharp and better-sqlite3 instead
  of host platform/arch and a hard-coded node_modules path.
- AI settings: context-size bounds now come from shared `@st2/contracts`
  limits; the `maxContextTokens` schema ceiling is raised from 200000 to
  10 000 000 (200k stays the default UI cap until unlocked), and the context
  and max-tokens slider steps no longer strand their maximum below the
  configured cap (e.g. 199936 / 199937).

### Fixed

- Legacy Express dispatcher no longer hangs on handlers using
  `res.write`/`res.end` (previously waited out the 30s timeout).
- Message counting uses `COUNT(*)` instead of materializing row ids.
- Stability (ТЗ §13): plugin worker spawn failures (`child.on('error')`) no
  longer crash the server; process-level unhandled-rejection/uncaught-
  exception guards; legacy async handler rejections contained; profile
  export temp cleanup and plugin install rollback can no longer escape as
  unhandled rejections or mask the original error; shutdown exit code
  reflects close failures.
- SSE generation errors no longer leak raw error text (SQL, paths, provider
  internals) to clients — only app-authored messages cross the boundary;
  failures are logged server-side; client disconnects report
  `GENERATION_CANCELLED`; writes honor backpressure and dead sockets.
- Hijacked SSE responses (`/generate`, `/events`) carry the security
  headers the `onSend` hook cannot add.
- Fastify client errors (malformed JSON body, unsupported content type)
  return their 4xx status with a typed `BAD_REQUEST` envelope instead of
  `INTERNAL`/500; schema validation keeps the `VALIDATION` envelope.
- Plugin worker: IPC disconnect exits instead of orphaning, event handler
  failures and failed `deactivate()` are reported (no silent deaths,
  non-zero exit on failed teardown).
- Backup listing distinguishes an unreadable backup directory from "no
  backups".

### Changed

- Sidebar panel chrome is unified: Persona Management and Character Management
  now use the same header (eyebrow, title, close button, optional avatar and
  actions) as AI Settings / Settings, with standard panel padding and
  translucent shell background instead of the previous full-bleed opaque
  header. A shared `SidebarPanelHeader` component is the single source of
  truth; legacy `data-part="personas-header"` /
  `data-part="character-management-header"` hooks are preserved, and the new
  `data-component="sidebar-panel-header"` hook (parts `identity`, `avatar`,
  `eyebrow`, `title`, `actions`, `close`) is documented in the Theme SDK.

## [0.1.0] — 2026-08-11

Public release prep:

- Rebranded SillyTavern 2 → **NeoTavern**: package scope `@st2/*` → `@neotavern/*`,
  desktop product identity, plugin IDs, CLI tools (`neotavern-plugin`,
  `neotavern-plugin-runtime`), env vars (`NEOTA_*`), wire-format markers
  (`neotavern-profile-export`, `neotavern-chat-export`), and display strings.
- Versioning restarts at `0.1.0` (was `2.0.0-pre.3`).
- Documentation is now English: all app/package READMEs, `docs/` reference tree,
  ADRs, and `AGENTS.md` were translated from Russian.
- **AGPL-3.0** license added.
- Removed superseded planning documents (`ТЗ.md`, plugin-SDK vNext specs, mockup
  directory) and tracked build debris.

## 2.0.0-pre.3 (prior)

### Added

- Expanded the inline AI Config tab with context size, sampling, penalties, seed,
  streaming and reasoning controls, and added a persisted custom chat-template
  editor under Advanced.
- Generation now applies saved defaults, context limits and custom instruct
  formats; OpenAI-compatible providers receive every supported sampling option
  and can return either streamed or non-streamed completions.
- Added the installable Plugin Manager with atomic bounded `.stplugin`
  replacement, explicit permission consent/re-consent, safe mode, isolated
  package assets, lifecycle status and cleanup.
- Added sandboxed frontend plugin pages, settings/sidebar panels, toolbar and
  message actions, commands, hotkeys, notifications, dialogs, character tabs,
  safe text message renderers, i18n resources and app-event subscriptions.
- Added process-isolated backend plugins with capability-checked routes,
  storage, virtual files, network fetch, providers, async tokenizers, context
  strategies and a bounded namespaced event bus.
- Added an SSE rendezvous for frontend prompt interceptors with one-time
  response tokens, timeout isolation, protected-message restoration and final
  server-side token-budget enforcement.
- Added explicit trusted legacy frontend/Express entry points behind
  `legacy.trusted` consent, plus safe-mode bypass and deterministic teardown.
- Added migration `0004_plugin_consent` separating manifest requests from
  explicit grants and retaining a stable plugin runtime error code.
- Added a complete local Theme Manager with bounded `.sttheme` ZIP install,
  atomic replacement/rollback, inheritance-aware activation, persisted
  component/shell CSS, built-in reset, deletion and a pre-load `?safe=1`
  recovery path.
- Added a reproducible Windows portable ZIP with adjacent SHA-256, marker-based
  local data directory and automated packaged-sidecar/Tauri lifecycle smoke
  checks covering SQLite, Sharp, SPA resources and orphan cleanup.
- Added a local diagnostics and recovery panel with SQLite integrity/migration
  state, aggregate library/storage/runtime health, a versioned redacted JSON
  report, FTS rebuild, safe-mode entry and thumbnail-only cache cleanup.
- Added a streaming, idempotent SillyTavern full-data ZIP migration for
  characters, solo JSONL chats and swipes, personas, Worlds/lorebooks and JSON
  presets, with bounded extraction, path/symlink checks, cancellation and a
  localized Settings report.
- Added migration `0002_import_artifacts` so interrupted streamed chat imports
  recover without duplicates and completed source artifacts remain traceable.
- Added a read-only SillyTavern ZIP preflight with 30-minute bounded staging,
  per-category counts, damaged-record and conflict reporting, category
  selection, explicit `skip`/`copy`/`merge`/`replace` policies, confirmation,
  cancellation and a pre-write safety backup.
- Added migration `0003_repeatable_import_jobs` so the same archive can be
  intentionally confirmed more than once with different categories or conflict
  policies while compatibility clients can still find the latest result.
- Added Mistral and Command-R instruct presets, detached versioned preset
  export, and exact offline `o200k_base`/`cl100k_base` tokenization for known
  OpenAI model families.
- Added signed Tauri core updater commands and updater artifacts, plus native
  macOS/Linux sidecar and bundle lifecycle gates in the desktop release
  workflow.

### Changed

- UX/UI: chat is now the only primary workspace. Characters, chat history,
  providers, settings, themes and plugins open as route-aware modal surfaces
  without unmounting the current chat; deep links, Back, Escape and focus
  restoration remain supported.
- First-run UX now provides an inline language/text-size checklist, direct
  provider and character setup, an existing-data import shortcut, session-only
  per-chat drafts, offline status, destructive-action confirmation and
  persisted density/scale/contrast/reduced-motion preferences.
- Theme Manager now offers a ready-to-edit `theme-starter.zip`; shell slots and
  system-surface hooks are documented for no-build-tools customization.

- Replaced the generic navigation drawer content with contextual inline
  workspace panels. AI generation/provider/context controls now stay beside
  the chat, and desktop chat content is centered in the remaining width while
  the panel is open. Theme SDK now exposes `shell-rail-width` and
  `shell-panel-width` for this layout.
- Theme API v1 now defines `shell` as declarative CSS instead of an executable
  module proposal; JavaScript themes, remote CSS resources and unsafe archives
  are rejected before installation.
- Desktop external native-module loading now handles packaged Node reliably,
  Windows resource paths are normalized before crossing into the sidecar, and
  an unexpected backend termination closes the Tauri shell instead of leaving
  a broken window running.
- Tauri uses platform-native bundle targets on each build host (`all`): NSIS/MSI
  on Windows, app/DMG on macOS and Linux packages including AppImage where the
  runner provides the required system tooling.
- Remote/LAN mode now fails closed unless explicitly enabled with a strong
  bootstrap token and trusted HTTPS origin. Remote browser access uses bounded
  HttpOnly sessions, exact Origin and CSRF validation, login rate limiting,
  in-memory-only frontend credentials and explicit logout; Bearer auth remains
  available for deliberate CLI/API clients.
- Offline PWA reloads now keep the cached app shell visible with an explicit
  offline status while API, SSE, credentials and user responses remain
  uncached and unavailable.
- Prompt pipeline now assembles ranked Lorebook and Memory/RAG blocks, applies
  character post-history instructions, shifts context before plugin
  interceptors, and enforces the token budget again after all interceptors.
- Tool-call/result messages can be linked by stable call ID and are removed as
  one context-shifting group even when non-adjacent.
- Generation now reports tokenizer profile/accuracy metadata and fails with
  `TOKEN_BUDGET_EXCEEDED` when protected context cannot fit safely.
- Chat message deletion, variant activation and active-branch updates now
  validate chat ownership before mutation.
- SQLite backup restore now uses the online backup API and keeps the live
  database connection writable without a process restart.
- Backend Plugin SDK post-processors now participate in host-enforced cleanup;
  cache metrics exclude expired unpruned entries.
- Profile ZIP export now has an explicit binary TypeBox response contract, and
  API documentation covers personas, profiles, variants and regeneration
  semantics.
- Added selectable `truncate`, local `summarize`, relevance-aware
  `vector-recall`, and persisted `manual` context strategies with a
  host-enforced strategy registry and Plugin SDK cleanup.
- Chat message actions can include or exclude individual messages from manual
  prompt context without deleting them.

### Fixed

- Fixed sandbox mounts inside portal-based plugin dialogs and character tabs,
  stable registration snapshots, focus restoration and deterministic hotkey
  collision handling.
- Inline navigation panels now use a secondary heading, preserving one
  unambiguous page-level heading on routes such as Settings.

## [2.0.0-pre.3] — 2026-07-26

### Fixed

- Windows packaged sidecar normalizes absolute bundled SQLite paths before loading the native addon; startup is verified for drive paths and directory names containing spaces.

## [2.0.0-pre.2] — 2026-07-26

### Fixed

- Windows packaged sidecar handling for bundled `better-sqlite3` was updated after a drive-letter startup failure.

## [2.0.0-pre.1] — 2026-07-26

### Changed

- Chat composer now uses a two-layer frosted-glass shell with a distinct input surface, while preserving send, stop, keyboard, and localization behavior.
- The chat composer now mirrors the reference interaction model: settings, draft reset, regeneration, scroll controls, context details, and the compact mobile toolbar.
- SSE generation accepts `regenerate: true` to replace the newest assistant response in the active chat branch.
- Navigation now uses a permanent icon rail with an attached inline settings panel; language, theme, provider and token-limit controls no longer require opening a modal.
- Chat messages now expose inline edit and delete controls. Message edits are persisted through `PATCH /api/v2/chats/:id/messages/:messageId`.
- The local-storage status badge now meets WCAG AA contrast in the dark theme, and release E2E coverage follows the permanent navigation rail interaction model.
- Windows desktop sidecar now normalizes bundled native-module paths before loading SQLite, fixing startup on installed drives other than the system drive.

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [2.0.0-pre.0] — 2026-07-25

First pre-release of the SillyTavern 2 core.

### Added

- New chat-first App Shell: a start home screen with a locally pinned
  character, chat creation deferred until the first message, shared desktop
  and mobile sliding navigation, a seamless chat canvas, and full
  loading/empty/error states.
- Theme SDK contract for a custom chat background (`chat-wallpaper-*`) and a
  stable `data-part="chat-wallpaper"` without tying React components to a
  specific image.
- Host-enforced Plugin SDK lifecycle: automatic cleanup of
  UI/routes/events/i18n/providers, rollback of partial activation, and
  cleanup even when `deactivate()` throws.
- Tauri 2 desktop shell with a self-contained Node.js 24/Fastify sidecar,
  bundled `better-sqlite3`/Sharp runtime, app icon, and Windows NSIS
  installer.
- Installable PWA manifest and a versioned offline app-shell cache without
  caching API, SSE, or sensitive responses.
- A dedicated UX spec: user groups, information architecture, key scenarios,
  responsive behavior, states, accessibility, and acceptance criteria.
- Idempotent Character Card V1/V2 import/export: JSON/PNG, preservation of
  unknown metadata, SHA-256 deduplication, atomic storage of originals, and
  rebuildable WebP thumbnails.
- Migration `0001_content_and_imports`: character versions, attachments,
  lorebooks, FTS5 lore entries, presets, cache metadata, and the import log.
- pnpm workspaces monorepo: `apps/server`, `apps/web`, and the
  `shared`, `contracts`, `db`, `provider-sdk`, `plugin-sdk`, `theme-sdk`,
  `i18n`, `ui`, `legacy-compat` packages.
- Fastify 5 backend with TypeBox schemas under `/api/v2`: characters, chats,
  messages, personas, providers, settings, search, backups.
- SSE streaming generation with a prompt pipeline (macros, ChatML/Llama3/Alpaca
  instruct formats, context shifting, interceptor isolation).
- Providers: an OpenAI-compatible adapter and an offline `echo`; a registry
  that lets plugins register new kinds.
- SQLite (better-sqlite3 + Drizzle): WAL, foreign_keys, STRICT tables, FTS5
  search with sync triggers, cursor pagination, transactional migrations.
- Frontend React 19 + Vite 8: virtualized character catalog, chat with token
  batching via requestAnimationFrame, settings, providers.
- i18n: en/ru, namespaces, error-code localization, pseudo-locale, RTL.
- Theme SDK: tokens, inheritance, safe mode; base tokens and a dark theme.
- Legacy layer: `window.SillyTavern`, `eventSource`/`event_types`,
  `extension_settings`, jQuery, DOM islands; an Express host for server
  plugins.
- Security: bind on 127.0.0.1, CORS restriction, CSP, error envelope with
  traceId, API keys never appear in responses or logs.

### Tests

- 101 backend/unit/integration tests and 5 frontend component tests (Vitest +
  Fastify inject + Testing Library).
- 6 Playwright E2E tests: character creation, main navigation, keyboard focus,
  and an automated axe WCAG A/AA audit of the Characters, Chats, Providers,
  and Settings pages.
