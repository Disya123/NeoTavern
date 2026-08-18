# Input-to-present physical Perfetto runbook

**Status:** lab procedure. The debug present loop is on
`PresentationInputActivity` (window swapchain, compositor `HandlerThread`).
`Choreographer#doFrame` is not present. Production cutover is unchanged.

```text
platform gesture adapter = IMPLEMENTED / PERFETTO_PENDING
  (PASS only after this batch stamps docs/rfc/input-to-present-adjudication.json)
Milestone B = STARTED
production cutover = NOT_STARTED
almost_pass = false
```

Host adjudicator:
[`scripts/input-to-present-adjudicate.mjs`](../../scripts/input-to-present-adjudicate.mjs)
(v3). Record:
[`input-to-present-adjudication.json`](input-to-present-adjudication.json).

APK must be `BOUND` to `55a31747e0151ed085be2d5107beb9e149e131e2` or a
subsequent **clean** descendant. Do not cite unpublished `aec937c`.

Evidence commit after a successful physical batch:

```text
test(presentation-android): adjudicate physical input-to-present
```

RenderDoc is secondary. Gesture latency is a time trace, not one GPU
frame.

## Causal chain

Stable identifiers must join one chain:

```text
MotionEvent(sequence, eventTime)
→ bounded enqueue
→ compositor consume
→ SampledFrame(frameId, vsyncId)
→ GPU submit
→ SurfaceFlinger latch
→ actual display present
```

UI thread only `try_push`es. Correlate `vsyncId` from the debug adapter
through SurfaceFlinger `actualTimeline` / FrameTimeline. Expected present
from `FrameTimeline` is a deadline, not the latch.

## Per-opportunity cookies

Each presented sample records:

```text
eventTime
inputCutoff
callbackTime
targetVsyncId
targetPresentDeadline
actualPresentTime
eligibleForCurrentVsync
rendererControlled
exclusionReason
```

Input after `inputCutoff` is not eligible for the current vsync and MUST
receive the next `targetVsyncId`. That can make raw input-to-present
longer than one refresh without an application miss.

For a coalesced `MotionEvent`, primary `eventTime` is the **newest**
sample actually reflected in the frame. The oldest historical sample is
published separately as diagnostic **gesture age**.

`Choreographer#doFrame` is `callbackTime`, not `actualPresentTime`.

## RFC budgets (not a one-refresh PASS threshold)

[RFC §14.1](neoui-v4-android-presentation-backend.md):

```text
60 Hz  → 16.67 ms   (pacing only)
90 Hz  → 11.11 ms   (pacing only)
120 Hz → 8.33 ms    (normative gate)
```

These numbers are deadlines for a **renderer-controlled frame
opportunity**, not a one-refresh PASS threshold on every raw
`input-to-present` sample.

```text
deadline_miss =
  rendererControlled
  && actualPresentTime > targetPresentDeadline

input_to_present = actualPresentTime - eventTime
```

`input_to_present` p50/p95/p99 remain mandatory **report** metrics.

## Normative 120 Hz fixture

Before PASS the adjudicator also requires:

- APK `BOUND` to `55a3174` or a subsequent clean commit;
- warm-up ≥ 1 s and 60 s continuous-scroll at the **actually locked**
  120 Hz mode;
- `actualPresentTime` from FrameTimeline/SurfaceFlinger;
- MotionEvent, Choreographer, and present timestamps in one clock
  domain;
- unique `sequence → targetVsyncId → actual present`;
- trace packets/buffers not lost;
- exclusion reasons listed; `unknown` is application-caused;
- ≥99% renderer-controlled opportunities on time;
- application misses `<1%`, streak ≤ 2;
- bounded input / Product Wire / compositor queues (≤ 64);
- no producer/layout/shaping/raster on compositor-only scroll;
- raw input-to-present p50/p95/p99 published separately.

`ENVIRONMENT_BLOCKED` if 120 Hz was requested correctly but the OS held
the panel at 60 Hz. Milestone B stays STARTED even if the adapter stamps
PASS.

## Scenarios

Run on the debug host (`PresentationInputActivity`), not `MainActivity`:

| Extra / fixture        | What to prove                                    |
| ---------------------- | ------------------------------------------------ |
| `scroll_fling`         | ordinary scroll and fling                        |
| `nested_handoff`       | nested horizontal/vertical latch handoff         |
| `sticky_fixed`         | sticky/fixed hit after async scroll              |
| `selection_autoscroll` | selection drag + edge autoscroll                 |
| `coalesced_move`       | historical / coalesced MOVE, original timestamps |
| `focus_cancel`         | `CANCEL` on focus / window / surface loss        |
| `refresh_60/90`        | pacing only                                      |
| `refresh_120`          | locked 120 Hz + 60 s continuous-scroll           |
| `refresh_transition`   | 60→120→90 without changing physical fling speed  |

`I2P_FIXTURE=all` runs the full set. `I2P_HZ` / `I2P_WARMUP_MS` /
`I2P_SCROLL_MS` override the 120 Hz window. Cookie `targetVsyncId` is the
compositor `HandlerThread` FrameTimeline token, not the UI-thread
Choreographer stream.

## Capture

Physical Xiaomi / Vulkan. Close Android Studio first. Emulator serials
are excluded. Host logcat is streamed from t0 (`adb logcat -s NeoTavernI2P`);
do not dump the logd ring at the end. Perfetto config keeps FrameTimeline
and light gfx/view/input atrace so the 256 MiB buffer holds the whole
session (sched ftrace overflowed the first 128 MiB capture).

```text
M0_D1A_FEATURES=gpu,android-jni bash apps/android/scripts/build-m0-d1a-libs.sh
# assembleDebug, then bind the APK to this clean tree:
node scripts/m0-d1a-source-bundle.mjs --apk apps/android/app/build/outputs/apk/debug/app-debug.apk --bind-apk
node scripts/input-to-present-perfetto-capture.mjs --serial=8f5c2b7c
node scripts/input-to-present-adjudicate.mjs --fixture=apps/android/input-to-present-captures/<stamp>/<stamp>-fixture.json --write
```

Perfetto config: [`scripts/input-to-present.pbtxt`](../../scripts/input-to-present.pbtxt)
(`android.surfaceflinger.frametimeline` plus `android.log` tag `NeoTavernI2P`).
The config is pushed to `/data/misc/perfetto-configs`; stdin+`--background` on Windows adb can start an empty session. Cookies come from the streamed host logcat;
FrameTimeline `actualPresentTime` is converted from the trace clock onto
monotonic.

Evidence JSON must pin: trace SHA, APK SHA, Perfetto config SHA, source
commit, device, display mode, denominators, exclusions, trace-loss
counters. Raw traces stay gitignored under
`apps/android/input-to-present-captures/`.

Without `--fixture` the record stays `IMPLEMENTED / PERFETTO_PENDING`.
A fixture that uses `doFrame` as present is `BLOCKED`.

Production `MainActivity`, default JNI, and WebView rollback stay off.
