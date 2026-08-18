# Input-to-present physical Perfetto runbook

**Status:** lab procedure. Adapter is implemented; Perfetto is pending.

```text
platform gesture adapter = IMPLEMENTED / PERFETTO_PENDING
Milestone B = STARTED
production cutover = NOT_STARTED
almost_pass = false
```

Host adjudicator:
[`scripts/input-to-present-adjudicate.mjs`](../../scripts/input-to-present-adjudicate.mjs).
Record:
[`input-to-present-adjudication.json`](input-to-present-adjudication.json).

Do not cite unpublished `aec937c`. Cite
`0a1031c0f2fbd9e4da6f958e344e25b0f89d2bb7` or the `--amend` successor on
`pr-m7-etap6-slices` whose message is
`docs(presentation-android): stage input-to-present Perfetto pending`.

The next evidence commit, **after** a physical batch, is:

```text
test(presentation-android): adjudicate physical input-to-present
```

RenderDoc is secondary. Gesture latency and Choreographer pacing are a
time trace, not one GPU frame. `Choreographer#doFrame` / `frameTimeNanos`
is **not** present.

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

Correlate `vsyncId` (or an equivalent FrameTimeline cookie) from the
debug adapter through SurfaceFlinger `actualTimeline` /
`actualPresentationTime`. Expected present from `FrameTimeline` is a
deadline, not the latch.

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
published separately as diagnostic **gesture age**. It is not the
pass/fail latency.

`Choreographer#doFrame` is `callbackTime`, not `actualPresentTime`.

## RFC budgets (not measured-from-this-run)

[RFC §14.1](neoui-v4-android-presentation-backend.md):

```text
60 Hz  → 16.67 ms
90 Hz  → 11.11 ms
120 Hz → 8.33 ms
```

These numbers are deadlines for a **renderer-controlled frame
opportunity**, not a one-refresh PASS threshold on every raw
`input-to-present` sample. There is no such threshold without a separate
budget ADR.

Adjudicator:

```text
deadline_miss =
  rendererControlled
  && actualPresentTime > targetPresentDeadline

input_to_present = actualPresentTime - eventTime
```

`input_to_present` p50/p95/p99 remain mandatory **report** metrics. A
good mean must not hide a bad p95/p99 or missed frames, but the mean of
`input_to_present` cannot pass or fail the gate.

[RFC §14.2](neoui-v4-android-presentation-backend.md) gate, per refresh
mode:

- all-frame and renderer-controlled denominators are both published;
- `unknown` exclusion is application-caused and stays in the
  renderer-controlled denominator;
- ≥99% eligible renderer-controlled opportunities on time;
- application-caused misses `<1%`;
- miss streak at most two consecutive.

`ENVIRONMENT_BLOCKED` if the device was held at 60 Hz after a correct
120 Hz request.

These remain a Milestone B hypothesis gate until a device-specific budget
ADR. Milestone B stays STARTED even if this adapter later stamps PASS.

## Scenarios

Run each on the debug host (`PresentationInputActivity`), not
`MainActivity`:

| Extra / fixture        | What to prove                                    |
| ---------------------- | ------------------------------------------------ |
| `scroll_fling`         | ordinary scroll and fling                        |
| `nested_handoff`       | nested horizontal/vertical latch handoff         |
| `sticky_fixed`         | sticky/fixed hit after async scroll              |
| `selection_autoscroll` | selection drag + edge autoscroll                 |
| `coalesced_move`       | historical / coalesced MOVE, original timestamps |
| `focus_cancel`         | `CANCEL` on focus / window / surface loss        |
| `refresh_60/90/120`    | each available panel mode                        |
| `refresh_transition`   | 60→120→90 without changing physical fling speed  |

## Capture

Physical Xiaomi / Vulkan, APK `BOUND`, `evidence_dirty=false`. Phone may
stay disconnected until this batch.

```text
perfetto config: sched, freq, idle, power, gpu, view, gfx, hal, ss, am,
wm, input, atrace (app + SurfaceFlinger FrameTimeline)
```

App cookies (logcat tag `NeoTavernI2P` and `atrace` sections `nt.input.*`):

```text
seq eventTime inputCutoff callbackTime targetVsyncId targetPresentDeadline
actualPresentTime eligibleForCurrentVsync rendererControlled exclusionReason
newestEventTime oldestHistoricalEventTime
```

Do not treat a Choreographer callback timestamp as `actualPresent`.

Also record:

- `supported_modes` / `requested_frame_rate` / `observed_display_mode`
- `frame_callback_rate` vs `present_rate`
- thermal state, CPU/GPU frequency
- queue high-water, dropped MOVE vs dropped edges
- producer/layout/shaping/raster counters on the consume path (must be 0
  for compositor-only frames)

## Adjudicator

```text
node scripts/input-to-present-adjudicate.mjs
node scripts/input-to-present-adjudicate.mjs --fixture=apps/android/input-to-present-captures/<stamp>.json --write
```

Without `--fixture` the record stays `IMPLEMENTED / PERFETTO_PENDING`.
A fixture that uses `doFrame` as present is `BLOCKED`. A fixture that
compares raw `input-to-present` to 8.33 ms as the PASS gate is the wrong
denominator: the host adjudicator does not do that.

Production `MainActivity`, default JNI, and WebView rollback stay off.
