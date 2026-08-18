---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0050-visual-surface-ingress-vs-plugin.md
---

# ADR-0050: VisualSurfaceFrameIngress is Milestone B; PluginVisualSurface is Milestone D

Date: 2026-08-19. Status: **Accepted**.
Related: [RFC 4.6](../rfc/neoui-v4-android-presentation-backend.md) §29,
§43/PERF-15, §50, §52; [ADR-0049](0049-track-d-dioxus-presentation.md)
(D3 remains **DEFERRED**).

## Context

Milestone B exit requires PERF-15. PERF-15 requires a live VisualSurface in
the pressure fixture (10k fling + live glass + image decode/upload +
VisualSurface + injected trim-memory). The RFC previously named that surface
`PluginVisualSurface` and placed the public plugin platform in Milestone D.
D3 is **DEFERRED**. Closing B therefore looked like it required unfreezing
the plugin platform.

That coupling is a documentation defect, not a reason to weaken PERF-15 or
to start Plugin SDK / IR / untrusted producers early.

## Decision

Split two levels. Do **not** lower PERF-15. Do **not** unfreeze D3. Do
**not** expose this ingress as Plugin SDK.

| Milestone B                           | Milestone D                       |
| ------------------------------------- | --------------------------------- |
| Internal `VisualSurfaceFrameIngress`  | Public `PluginVisualSurface`      |
| `SurfaceId` / generation / sequence   | Plugin API / IR / packages        |
| Bounded latest-ready-frame-wins queue | Permissions / quotas / isolation  |
| Shared-device texture validation      | Untrusted producer sandbox        |
| Damage / readiness / retirement       | Update / revoke / crash isolation |
| Trusted reference producer            | Real third-party plugins          |

Product Wire carries only the **logical** surface declaration and policy.
It MUST NOT carry GPU handles, `wgpu::Device`, Vulkan/Metal devices, or
command encoders.

Ephemeral `SurfaceFrameIngress` lives in the presentation session and binds
through a generation-safe `SurfaceId`. A `SurfaceFrame` has generation,
sequence, timestamp, content, damage, and readiness/fence. The queue is
bounded, non-blocking, and latest-ready-frame-wins. Submit validates
format, dimensions, usage, ownership, quota, and `DeviceEpoch`. A late or
not-ready frame MUST NOT block present: keep the last-ready frame or the
documented fallback. Lifetime is held until GPU completion. Recovery
creates a new generation; old frames and fences are rejected.

PERF-15 PASS requires this B-level ingress with a trusted **reference**
producer (deforming textured mesh/rig, alpha layers, atlas, per-frame
animation/damage, own sequence/timestamp, bounded producer queue, no
direct `NeoDisplayList` injection). A D1b checkerboard or a colored
synthetic texture is not a substitute. Evidence MUST record:

```text
producer=reference-visual-surface
surface_frame_ingress=true
direct_display_list_injection=false
plugin_runtime=false
```

That PASS does **not** claim PluginVisualSurface, Plugin SDK, or Milestone
D are ready.

## Alternatives

1. **Weaken PERF-15** (drop VisualSurface from the B fixture). Rejected:
   pressure under a live independent surface is the point of PERF-15.
2. **Pull PluginVisualSurface into B.** Rejected: that unfreezes D3 and
   the untrusted plugin sandbox.
3. **Silent synthetic texture** in the probe. Rejected: already forbidden
   by the PERF-15 record.

## Consequences

- RFC §29 describes B-level ingress; PluginVisualSurface constraints move
  to §29.1 and stay Milestone D.
- RFC §50 gains `VisualSurfaceFrameIngress` as a B deliverable.
- RFC §52 keeps public VisualSurface / plugin platform as D.
- D3 stays **DEFERRED**. Production `MainActivity`, default JNI, and
  WebView rollback are unchanged.
- Remaining PERF-01…05 / 11–14 / 16–17 / 21 records exist as independent
  physical PASS. Milestone B PASS is stamped only by
  [`docs/rfc/milestone-b-exit.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/milestone-b-exit.json), not by
  this ADR. Production cutover remains **NOT_STARTED**.
