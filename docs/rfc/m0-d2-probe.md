# M0-D2 Dioxus/Blitz producer seam

**Status:** program **M0-D2 STARTED**, not PASS. Host-side D1a and D1b remain
PASS. Normative M0 stays **`ENTERED`**. `D1=Track D GO` is not granted.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §48 stage 3  
**Crate:** [`crates/presentation-m0-d2`](../../crates/presentation-m0-d2/README.md)

D1a/D1b used a host-authored display list. Stage 3 requires geometry and text
to come from a real Dioxus `VirtualDom` and pinned Blitz layout/paint. A mock
list pasted on after layout is forbidden. This crate starts that seam; it does
not finish Exit M0-D2.

## Pins (experimental, not production)

```text
dioxus-core / dioxus-core-macro / dioxus-hooks / dioxus-html / dioxus-native-dom = 0.8.0-alpha.1
blitz-dom / blitz-paint / blitz-traits = 0.3.0-beta.1
anyrender = 0.11.0
```

These match `presentation-m0` Vello **0.9** / wgpu **29**. Rejected:

- `dioxus-native 0.7.10` — Blitz 0.2 / anyrender 0.6 / older wgpu.
- Full `dioxus-native 0.8` renderer crate — pulls a winit 0.31 window shell
  into the workspace lockfile. Headless path is
  `DioxusDocument` → `initial_build` → `BaseDocument::resolve` →
  `blitz_paint::paint_scene`.

Alpha/beta crates are marked experimental. They are not a D2 GO.

## Paint boundary

RFC allows a public recording sink, a small upstreamable hook, or another
described bounded extension point.

| Piece | Implementation in this start |
| --- | --- |
| Raster/text paint | Public `anyrender::Scene` (`PaintScene` recording sink) |
| Glass | Host hook `data-neoui="glass"` (and class `neoui-glass`) read from the laid-out Blitz DOM |
| Display list | Walk Blitz `paint_children` after resolve+paint; emit `PaintChunk` / `Image` / `BackdropBarrier` |
| Ancestor effect | One wrapper with `opacity:0.85` and `overflow:hidden` around Glass B |

A typed Blitz/anyrender Glass paint node is **missing**. The DOM attribute
hook is an honest stand-in, not a claim that Blitz grew compositor barriers.

## Scene (static)

Same D1a-shaped first-party scene, now from Dioxus:

```text
wallpaper
→ GlassSurface A
→ ordinary vector UI
→ bounded opacity/clip group
    → grouped vector
    → overlapping GlassSurface B
→ foreground overlay
```

`compile_passes` must keep the opacity scope open on Glass B.

## Missing upstream capabilities

D2 cannot PASS while these remain:

1. Typed Blitz/anyrender Glass/backdrop paint node (host `data-neoui` hook is a stand-in).
2. Producer-owned synthetic moving sample after the static seam (D1b motion still lives in `presentation-m0`).
3. Rebase experiment of this alpha/beta pin set.
4. Physical Android GPU capture of the producer path.
5. First-class compositor barrier inserted by Blitz paint order, not a post-layout host walk.

Estimated replacement surface if the pin set fails: keep the `NeoDisplayList`
cut and swap the producer (another layout/paint substrate) without rewriting
D1a/D1b compositor evidence.

## Non-goals (this start)

- Declaring M0-D2 PASS or `D2=Dioxus`.
- Changing `docs/rfc/m0-d1a-adjudication.json` or D1b admission.
- Linking this crate into production kernel JNI.
- 10k chat, streaming Markdown, virtualization, IME/TalkBack, device-loss
  recovery, production plugin UI.

## Commands

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2
```

A green unit test is **STARTED** evidence, not program PASS.
