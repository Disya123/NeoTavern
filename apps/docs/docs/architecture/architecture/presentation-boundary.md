---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/presentation-boundary.md
---

# Presentation boundary (Milestone A)

**Status:**

```text
Milestone A = PASS
A/Product Wire boundary = PASS
shared-device raster interop = PASS
platform gesture adapter = PASS
Milestone B = STARTED
production cutover = NOT_STARTED
```

Milestone A **PASS** is the feature-flagged Product Wire shell, React ↔
Dioxus canonical projection parity, and presentation-path streaming tests.
It is **not** a production migration, **not** Milestone B/C PASS, and **not**
a `MainActivity` cutover.

**Decisions:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md),
[d1-d2-decision.md](../rfc/d1-d2-decision.md).
**D3:** **DEFERRED** — Android may take a Rust presentation path; Web stays
React. Rollback is the acting React/WebView host.

This is not a production migration and not Milestone B/C PASS.

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
4. Production Android `MainActivity` stays WebView until Milestone B/C DoD.
   `NEOTA_NEOCOMPOSITOR=1` is a **non-default** feature flag for
   `crates/neocompositor`, not a cutover switch.
   `NEOTA_DIOXUS_SHELL=1` is a **non-default** flag for the Dioxus Product
   Wire shell crate; it is not a launcher switch.
5. M0 probe crates stay probes and are not production JNI. Interchange
   types (`NeoDisplayList`, `compile_passes`) live in
   `neotavern-neocompositor`; probes re-export them.

## Surfaces

```text
react-web                  — production Web / desktop UI
webview-android-rollback   — production Android default
dioxus-android-flagged     — experimental; not the launcher
```

## Milestone B start

`crates/neocompositor` holds production interchange types, a bounded
`FrameTransaction` mailbox, spatial/scroll/clip/effect property trees,
CPU scroll/animation fast paths, async hit-test / nested-scroll dispatch,
interaction-ready text snapshots, a cross-tile selection underlay (PERF-19
**PASS** on physical Vulkan, not B PASS), a PERF-18 effect-scope
backdrop capture (**PASS** on physical Vulkan, not B PASS), a CPU
device/surface recovery state machine (injection-tested, not production JNI,
not B PASS), bounded GPU telemetry (CPU snapshot; GPU timestamps on that
snapshot stay `Unavailable` and are not image readbacks; not B PASS), and a
shared-device raster interop CPU protocol (`SharedGpuContext`; one
`DeviceEpoch`; sampleable raster texture; `image_readbacks=0`,
`cross_device_copies=0`; not production JNI, not B PASS). Chat
virtualization lives
in `crates/chat-viewport` (height index, predictor, bounded tile cache,
geometry epochs / C0/C1 remap; compositor sees only the **active** tile
descriptors and geometry snapshot). PERF-20 is **PASS** on the physical
Vulkan multi-frame trace, not B PASS. The Blitz producer publishes `TextInteractionSnapshot`
from already-shaped Parley layouts (no compositor reshape). Viewport remap and
selection go through `crates/presentation-session` (one
`FrameTransaction`, logical selection, `DeltaToken`). Independent stamps:
[`docs/rfc/perf-18-20-adjudication.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/perf-18-20-adjudication.json).
Debug-only
`crates/presentation-perf-probe` / `PresentationPerfActivity` is the
physical capture vehicle (not production JNI), including debug
`PERF_SCENARIO=interop` (host **PASS** on physical Vulkan; not cutover,
not B PASS). Neither crate is linked into
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
[`scripts/input-to-present-adjudicate.mjs`](https://github.com/Disya123/NeoTavern/blob/main/scripts/input-to-present-adjudicate.mjs)
does not treat `Choreographer#doFrame` as present and does not compare raw
`input-to-present` to one refresh. Physical FrameTimeline /
SurfaceFlinger stamp `2026-08-18T16-28-13-285Z`
([input-to-present-physical-runbook.md](../rfc/input-to-present-physical-runbook.md),
[input-to-present-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/input-to-present-adjudication.json)).
Raw input-to-present p99 `20.65 ms` on that device is a
**reference-device baseline**, not a release budget (no calibration ADR).
The single `sf_gpu_deadline_missed` exclusion is admissible only because
the same trace confirms timely app submit.
Non-sampleable surface fallback (PERF-22) is **IMPLEMENTED** on the host
corpus (`crates/neocompositor` `surface_fallback`) plus a debug Android
fixture (`PresentationSurfaceActivity`: real WebView + secure
`SurfaceView` + fallback hit routing). PASS still requires a BOUND
physical capture.
Pressure/degraded admission (PERF-15) is **IMPLEMENTED** on the host
corpus (`crates/neocompositor` `pressure`) plus a probe fixture (10k
fling + live glass + image decode/upload + trim-memory). PASS is blocked
until a real VisualSurface / Product Wire surface exists; a synthetic
texture is not a substitute.
Physical device-loss injection is still **CPU_INJECTION** until a phone
capture proves wgpu destroy/recreate (`wgpu_destroyed=true`).
Independent records:
[perf-15-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/perf-15-adjudication.json),
[perf-22-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/perf-22-adjudication.json),
[device-loss-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/device-loss-adjudication.json).
The machine-checkable B-exit registry
[`docs/rfc/milestone-b-exit.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/milestone-b-exit.json) refuses
`Milestone B = PASS` until PERF-01…05 and PERF-11…22 have independent
admissible evidence, device-loss injection is physical, and known
baseline failures are fixed or explicitly waived.
Known host baseline
failures are
recorded in
[known-baseline-failures.md](known-baseline-failures.md) and do not make
PERF-18/19/20 evidence inadmissible.
