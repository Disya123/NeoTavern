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
canary_batch = NOT_RUN
```

Milestone A **PASS** is the feature-flagged Product Wire shell, React ↔
Dioxus canonical projection parity, and presentation-path streaming tests.
Milestone B **PASS** is the independent physical PERF-01…22 / device-loss
registry. Neither is a production migration, Milestone C PASS, or an unguarded
`MainActivity` cutover. Cutover is **STARTED / CANARY**.

**Decisions:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md),
[ADR-0050](../adr/0050-visual-surface-ingress-vs-plugin.md),
[ADR-0051](../adr/0051-android-talkback-webview-fallback.md),
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
   WebView. `NEOTA_DIOXUS_SHELL=1` is a **non-default** persisted canary
   flag, not an unguarded cutover.
   `NEOTA_NEOCOMPOSITOR=1` is a **non-default** feature flag for
   `crates/neocompositor`, not a cutover switch.
   TalkBack / touch exploration MUST select WebView **before** a Rust
   presentation host is created ([ADR-0051](../adr/0051-android-talkback-webview-fallback.md)).
5. M0 probe crates stay probes and are not production JNI. Interchange
   types (`NeoDisplayList`, `compile_passes`) live in
   `neotavern-neocompositor`; probes re-export them.

## Surfaces

```text
react-web                  — production Web / desktop UI
webview-android-rollback   — production Android default (retained)
dioxus-android-canary      — MainActivity selector; STARTED / CANARY; not default
dioxus-android-chat-route  — PresentationChatActivity; same Kernel; canary + debug harness
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
**reference-device baseline**, not a release budget (no calibration ADR).
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
hosts the live Product Wire route in `crates/presentation-chat`. History,
streaming, send, retry, prepend, drafts, and `ErrorDto` go through registered Wire
operations only. Tests use in-memory `FakeWire`; the Activity talks to
the existing Kernel via `KernelSession` + `EnvelopeBuilder`. The UI never
opens SQLite or talks to the network. The visible window is virtualized
through `crates/chat-viewport` (`waited_on_producer=false`). The host
mirrors that same snapshot (selectable Markdown/image rows) and hosts a
Gboard composer (IME send, **Send** button, draft save, keyboard inset animation). It is
not a second chat and not the compositor `SurfaceView` paint path.
Header/composer glass, Markdown `data-format`, sampleable image rows, and
TalkBack roles live on the Dioxus tree. Rotate/recreation restores
`chatId` and composer text. Optional `NEOTA_SAFE_MODE=1` escapes to
production `MainActivity` (WebView).

Guarded canary: `MainActivity` may start this activity when the selector
allows a Rust host. Production APK packages
`libneotavern_presentation_chat.so`. Kernel and `filesDir/neotavern` stay
shared. Isolated 10k remains a debug harness profile
(`NEOTA_CHAT_PROFILE=isolated-10k` → `filesDir/neotavern-isolated-10k`).
Physical canary batch is **NOT_RUN**
([milestone-c-canary.md](../rfc/milestone-c-canary.md)).

The route mounts only when `com.neotavern.mobile.NEOTA_DIOXUS_SHELL=1`
(extra or persisted canary flag). Without it the selector stays on
WebView (`reason=flag_off`). Optional `NEOTA_SAFE_MODE=1` escapes to
WebView. Send round-trip uses Kernel `chats.get.messageCount` as the
source of truth (not a local `+= 1`). IME action Send and a Send button
both issue `chats.messages.create`; a failed `generation.start` must not
drop an accepted durable row. Physical stamp `2026-08-18T21-55-58-696Z` stays a preserved
**`FAILED_ATTEMPT`**. Stamp `2026-08-19T10-29-35-149Z` is the successful
journey batch (**PASS**) on the same Xiaomi debug harness: send round-trip,
isolated 10k, Gboard InputConnection keys, lifecycle, and safe-mode WebView
escape. TalkBack was operator-waived (**SKIPPED**, not PASS). That skip
does **not** satisfy RFC §51 TalkBack; native Dioxus TalkBack is
**DEFERRED_BY_OWNER** and the product accessibility path is
**WEBVIEW_FALLBACK** ([ADR-0051](../adr/0051-android-talkback-webview-fallback.md)).
([milestone-c-adjudication.json](../rfc/milestone-c-adjudication.json),
[runbook](../rfc/milestone-c-physical-runbook.md)). Milestone C is
**STARTED**, not RFC §51 PASS. Cutover is **STARTED / CANARY**;
`canary_batch` is **NOT_RUN**. Chat workspace on flagged Dioxus Android
remains **DEFERRED** in the compatibility matrix until owner-signed PARITY.
