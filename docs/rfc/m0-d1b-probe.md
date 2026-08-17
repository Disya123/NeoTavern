# M0-D1b moving sampleable texture

**Status:** **STARTED** after host-side [M0-D1a PASS](m0-d1a-adjudication.json).
Not D1b PASS. Normative M0 stays **`ENTERED`**. `D1=Track D GO` is not
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

Debug groups the physical Vulkan capture at frame 120 must show:

```text
m0-d1b-moving-blit:g120
→ accumulator current generation
→ m0-d1b-roi-read:2
→ m0-d1b-glass:2:g120
```

## Telemetry

| Field | 1000-frame golden |
| ----- | ----------------- |
| `frames` | 1000 |
| `devices` | 1 |
| `readbacks` | 0 |
| `xdev` | 0 |
| `moving_blits` | 1000 |
| `pass_compiles` | 1 |
| `vello_rebuilds` | 4 |
| `layout_rebuilds` / `ui_rebuilds` | 0 |
| `raster` | 4 |
| `glass` / `roi_copies` | 1001 (2 on bake + Glass B on 999 motion frames) |
| `sampled_gen` | 999 |
| `capture_timeline` | `restore,moving:g120,roi:2,glass:2:g120,overlay` |
| `render_polls` | 0 |
| `capture_polls` | 0 on the normal path; 1 only around RenderDoc `EndFrameCapture` |
| `acc_bytes` | `1046528` (D1a `774144` + `64×64×4` + extra 320×200 static-prefix cache) |
| crate `capture=` | **false** (probe cannot self-admit) |
| crate verdict | **BLOCKED** off host-side admission |

A capture-only `device.poll` after `EndFrameCapture` must not increment
`render_polls`. Production motion frames do not wait on a fence or device
poll.

## Desktop GPU 1000-frame run (preliminary)

```text
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu
cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0 --features gpu --bin m0-d1b-probe
```

Desktop Vulkan is a useful pre-check. It is **not** a physical Android D1b
PASS and **not** a new GPU capture. D1a RenderDoc admission is unchanged.

## Still required for D1b PASS

RFC 4.5 exit M0-D1b, host-side only (`scripts/m0-d1b-adjudicate.mjs`):

- physical Android 1000-frame run on the production backend
- readable Vulkan capture at generation 120 with the motion chain above
- Glass B does not sample a previous generation
- damage/ROI follows motion and stays bounded
- resource/target high-water stable vs control
- no validation errors / stale handles
- `devices=1`, `readbacks=0`, `xdev=0`

Do not treat crate `BLOCKED`/`PASS` as program D1b. Do not flip
`android_gpu_capture` in the probe log.

## Non-goals

- Rewriting the D1a admission JSON or D1a evidence
- Production `MainActivity` compositor
- M0-D2 Dioxus/Blitz producer
- `D1=Track D GO`
