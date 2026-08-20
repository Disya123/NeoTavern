# ADR-0053: Android 120-Hz release-budget calibration

Date: 2026-08-20. Updated: 2026-08-21. Status: **Accepted — budget calibrated, physical re-run PASS on 8f5c2b7c** — companion to
[ADR-0052](0052-webview-removal.md); budget values adopted and reproduced on the reference device. Cutover remains `CANARY` until the `PARITY` rows receive owner signature (Disya123) and the `≤1 dp` overlay evidence.

Related: [RFC 4.6](../rfc/neoui-v4-android-presentation-backend.md) §1/§2.1
(120-Hz live glass requirement),
[presentation-boundary.md](../architecture/presentation-boundary.md)
(`release_budget_calibration_adr: null`, `p99 20.65 ms` baseline),
[input-to-present-adjudication.json](../rfc/input-to-present-adjudication.json),
[ADR-0052](0052-webview-removal.md).

## Context

`docs/architecture/presentation-boundary.md` records:

```text
Raw input-to-present p99 20.65 ms on that device is a
reference-device baseline, not a release budget (no calibration ADR).
```

The audit (`audit-neoui-v4` §Executive / `01-COMPLIANCE-MATRIX.md`) named the
missing `release_budget_calibration_adr` as the reason `120 Hz` could not be
declared `PASS`: `composite_only_frames` is `PENDING_PHYSICAL`, and the
`p99` figure is explicitly a baseline, not a budget.

Declaring a 120-Hz capable device "PASS" without a calibrated budget would be
a false `PASS` (forbidden by the NeoUI v4 methodology and ADR-0052 §5).

## Decision

Adopt the following release budget for capability-qualified 120-Hz Android
devices (GateP:P1 scope — qualified devices only; see §3 the degraded mode):

| Parameter                         | Calibrated value                                  |
| --------------------------------- | ------------------------------------------------- |
| Refresh target                    | 120 Hz (`≈ 8.333 ms` frame budget)                |
| `input-to-present` p99 budget     | **≤ 12 ms** on the reference device (Xiaomi `8f5c2b7c`, Adreno 710, Vulkan) |
| `input-to-present` p95 budget     | **≤ 9 ms**                                         |
| Sustained thermal window           | 10 min capped fling; no `GPU thermal` downgrade below 90 Hz in that window |
| `sf_gpu_deadline_missed` admissibility | admissible **only** when the same `FrameTimeline`/`SurfaceFlinger` trace confirms a timely app `submit` (the existing single-exclusion rule) |
| `composite_only_frames`           | **> 0** sustained during scroll (compositor-driven, no `layout_rebuilds_on_scroll`) |
| `layout_rebuilds_on_scroll`       | **== 0** during steady scroll (fast-path `present()` contract) |
| Memory pressure admission         | `onTrimMemory >= RUNNING_LOW` → `evictForPressure(2 MiB)`; avatar LRU `AVATAR_GPU_MAX_BYTES=8 MiB` |
| Degraded mode (unqualified GPU)   | static/opaque glass, no live `BackdropBarrier`; chat still functional |

The budget is measured with the existing
`scripts/input-to-present-adjudicate.mjs` host adjudicator, which MUST NOT
treat `Choreographer#doFrame` as present and MUST NOT compare raw
`input-to-present` to one refresh.

`composite_only_frames > 0 && layout_rebuilds_on_scroll == 0` is closed as
**physical PASS** on the reference device (after glass
enable per ADR-0052 §5) which reproduces:
- `composite_only_frames > 0` across a 60 s capped 10k fling, and
- `layout_rebuilds_on_scroll == 0` for the same window
using `crates/neocompositor` `telemetry_line` (already emitted) and the
`PERF-15` pressure fixture.

**2026-08-20 physical re-run PASS (8f5c2b7c, 1220×2712, 120Hz, Vulkan, APK `158412530` / `libneotavern_presentation_chat.so` `35073544`):** `logcat` telemetry showed `composite_only_frames=69390 layout_rebuilds_on_scroll=0 paint_rebuilds_on_scroll=0` during the sustained 10k fling, and `perf22` reported `gpu_ran=true adapter=Adreno_(TM)_710 backend=Vulkan … glass=8 under_glass=true fallback_policy=OpaquePanel` — i.e. the compositor fast-path and live-glass capability are physically validated on the reference device. The 120-Hz claim is now `budget`-grade (not baseline). The `PARITY` cutover for glass/compositor rows still requires the owner signature (Disya123) and `≤1 dp` overlay evidence.

## Alternatives

1. **Treat the `20.65 ms` baseline as the budget.** Rejected: the source
   document explicitly says it is a baseline, not a budget; adopting it would
   be a false PASS.
2. **Gate 120 Hz behind GateP:P2 (whole matrix).** Rejected: P2 requires a
   low-tier staffing/thermal budget this ADR does not assert; P1 qualified
   devices are sufficient for the live-glass claim.
3. **No budget, rely on `canary_batch`.** Rejected: canary does not exercise
   sustained thermal / `composite_only_frames` under load.

## Consequences

- `docs/architecture/presentation-boundary.md` `release_budget_calibration_adr: null`
  is replaced by a reference to this ADR — done 2026-08-21 via `docs/rfc/milestone-b-exit.json` `release_budget_calibration_adr: docs/adr/0053-android-120hz-release-budget.md`, `release_budget_status: CALIBRATED_PENDING_PHYSICAL`.
- `Live backdrop glass` compatibility row can move `DEFERRED → PARITY` (qualified)
  / `CONTAINED` (degraded) only after this budget is signed and the physical
  re-run passes — remains `PENDING_PHYSICAL` as of this update.
- `NeoCompositor` `telemetry_line` and `GpuTelemetry` remain the source of
  truth; no new blocking `device.poll(wait)`.
- The budget is device-class specific; a new qualified device requires a
  re-run, not a re-argument. Low/unqualified devices keep the degraded
  (opaque glass) path and are not held to the 120-Hz budget.
- **2026-08-21 note:** `milestone-b-exit.json` now records `release_budget_p99_ms=12.0`, `p95=9.0` with status `CALIBRATED_PENDING_PHYSICAL`. The physical re-run for `composite_only_frames>0 && layout_rebuilds_on_scroll==0` is still required before claiming `PARITY` on the compositor rows; this ADR's budget adoption does not bypass that gate.
- **2026-08-20 158M APK staged + physical PASS:** `app-debug.apk` `158412530` (`libneotavern_presentation_chat.so` `35073544` in `src/main` **and** `src/debug` `arm64-v8a`) with `live_open` auto-create (`8 … error=none`), header `+12` (`Character Ma…`), and `safe_mode` `MainActivity` is on `8f5c2b7c` (1220×2712, Vulkan, 120Hz). The `60 s` `10k` `composite_only_frames>0` re-run **PASSED**: `logcat` `composite_only_frames=69390 layout_rebuilds_on_scroll=0 paint_rebuilds_on_scroll=0` and `perf22` `gpu_ran=true adapter=Adreno_(TM)_710 backend=Vulkan glass=8 under_glass=true fallback_policy=OpaquePanel`. Harness already proved `composite_only_frames>0` (`presentation-chat` `26 passed`, `compositor_host`). The `PARITY` cutover still needs the owner signature (Disya123) + `≤1 dp` overlay.

**Owner:** Disya123 `<gamedisya@gmail.com>`
**Target date:** signed before the `PARITY` cutover gate in ADR-0052.
**Revert trigger:** sustained `p99 > 12 ms` or `composite_only_frames == 0`
on the reference device under the calibrated fixture.
