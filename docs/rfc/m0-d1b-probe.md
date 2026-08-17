# M0-D1b moving sampleable texture

**Status:** program **M0-D1b PASS** on the host-side record
[`m0-d1b-adjudication.json`](m0-d1b-adjudication.json). The probe log stays
`capture=false`. Normative M0 stays **`ENTERED`**. `D1=Track D GO` is not
granted. D1a capture boundary, D1a evidence, and the D1a admission JSON
are unchanged (`d1b=NOT_STARTED` in that file is historical).

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48 stage 2  
**Crate:** [`crates/presentation-m0`](../../crates/presentation-m0/README.md)  
**Lab:** [m0-d1b-physical-runbook.md](m0-d1b-physical-runbook.md)

D1b adds one synthetic moving checker/gradient between vector UI and
GlassSurface B. Motion is a deterministic compositor dest offset. The
display list and compiled pass graph are built **once** (`pass_compiles=1`).
The moving layer is a persistent sampleable texture blit, not a Vello
rebuild and not a decoder/media/plugin/input path.

## Scene

```text
wallpaper
→ GlassSurface A
→ ordinary vector UI
→ synthetic moving checker/gradient (64×64)
→ overlapping GlassSurface B
→ foreground overlay
```

Pass kinds:

```text
raster → glass → raster → raster → moving → glass → raster
```

First-frame API timeline (golden, generation 0):

```text
clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,moving:g0,roi:2,glass:2:g0,raster,blit
```

Motion path recorded at capture generation 120 (no Vello):

```text
restore,moving:g120,roi:2,glass:2:g120,overlay
```

Frame 0 bakes four Vello rasters and snapshots the static prefix (after UI,
before the moving blit). Frames `> 0` restore that cache, blit the moving
sample, run Glass B only, then blit the cached overlay. `vello_rebuilds`
stays at the bake count **4**. `layout_rebuilds=0`, `ui_rebuilds=0`.

Glass B samples the accumulator **after** the moving blit (current frame
generation: `sampled_gen == frame`). Its damage/ROI follows the moving dest
and stays inside the original 140×80 glass bounds, smaller than the 320×200
accumulator and the 256×256 snapshot.

## Host-side admission (2026-08-17)

Physical Xiaomi `8f5c2b7c` / Adreno 710 / Vulkan. Source commit
`21b38c0`. Bound APK SHA-256 `089744f3…`. Capture stamp
`2026-08-17T18-15-34-453Z` vs control `2026-08-17T18-15-03-717Z`.

Event Browser at generation 120:

```text
m0-d1b-restore-static
→ m0-d1b-moving-blit:g120
→ m0-d1b-roi-read:2
→ m0-d1b-glass:2:g120
→ m0-d1b-overlay-blit
```

Moving blit is 64×64 into the named accumulator. Glass B ROI copy is
bounded (`96×60` at dest offset in the capture). No stale `glass:2:g0`
on that frame. No `vkMapMemory` / image-to-buffer. One `VkDevice`.

| Field | Control | Capture |
| ----- | ------- | ------- |
| `frames` | 1000 | 1000 |
| `devices` / `readbacks` / `xdev` | 1 / 0 / 0 | 1 / 0 / 0 |
| `moving_blits` | 1000 | 1000 |
| `pass_compiles` | 1 | 1 |
| `vello_rebuilds` | 4 | 4 |
| `layout_rebuilds` / `ui_rebuilds` | 0 / 0 | 0 / 0 |
| `raster` / `glass` | 4 / 1001 | 4 / 1001 |
| `render_polls` | 0 | 0 |
| `capture_polls` | 0 | 1 (after `EndFrameCapture` only) |
| `acc_bytes` | 1046528 | 1046528 |
| probe `capture=` | false | false |

Host record: `android_gpu_capture=true`, `capture_driver=Vulkan`,
`d1b_verdict=PASS`. The crate still cannot self-admit.

## Non-goals

- Rewriting the D1a admission JSON or D1a evidence
- Production `MainActivity` compositor
- `D1=Track D GO` (needs M0 PASS and TrackComparison)
- Treating crate `BLOCKED` as a FAIL
