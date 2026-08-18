//! Host-authored D1b scene (RFC §48 stage 2).
//!
//! D1a static cut plus one compositor-owned moving sampleable texture
//! between vector UI and GlassSurface B:
//!
//! ```text
//! wallpaper
//! → GlassSurface A
//! → ordinary vector UI
//! → synthetic moving checker/gradient
//! → overlapping GlassSurface B (inside a group-opacity scope)
//! → foreground overlay
//! ```
//!
//! Motion is a deterministic compositor dest offset. The display list and
//! compiled pass graph are built once; they are not rebuilt per frame.

use std::sync::Arc;

use crate::display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};
use crate::scene_d1a::{D1A_HEIGHT, D1A_WIDTH};
use crate::timeline::{RoiPx, GLASS_SNAPSHOT_MAX};

/// 64×64 keeps `write_texture` bytes_per_row = 256 (wgpu row alignment).
pub const MOVING_SIZE: u32 = 64;
pub const D1B_FRAMES: u64 = 1000;
pub const D1B_CAPTURE_FRAME: u64 = 120;
pub const D1B_BAKE_VELLO_PASSES: u64 = 4;
pub const GLASS_B_BOUNDS: Rect = Rect {
    x: 80.0,
    y: 70.0,
    width: 140.0,
    height: 80.0,
};

pub fn moving_bounds(frame: u64) -> Rect {
    let x = 96.0 + (frame % 41) as f32;
    let y = 88.0 + ((frame / 2) % 21) as f32;
    Rect::new(x, y, MOVING_SIZE as f32, MOVING_SIZE as f32)
}

/// Glass B damage/ROI follows the moving sample, stays inside the original
/// glass bounds, and remains smaller than the accumulator / snapshot max.
pub fn glass_b_follow_roi(frame: u64) -> Rect {
    glass_b_follow_roi_in(frame, GLASS_B_BOUNDS)
}

pub fn glass_b_follow_roi_in(frame: u64, glass_bounds: Rect) -> Rect {
    let moving = moving_bounds(frame);
    let pad = 16.0;
    let x = (moving.x - pad).max(glass_bounds.x);
    let y = (moving.y - pad).max(glass_bounds.y);
    let x1 = (moving.x1() + pad).min(glass_bounds.x1());
    let y1 = (moving.y1() + pad).min(glass_bounds.y1());
    Rect::new(x, y, (x1 - x).max(1.0), (y1 - y).max(1.0))
}

pub fn glass_b_follow_roi_px(frame: u64) -> RoiPx {
    let roi = glass_b_follow_roi(frame);
    let x = roi.x.max(0.0).floor() as u32;
    let y = roi.y.max(0.0).floor() as u32;
    let w = roi.width.ceil() as u32;
    let h = roi.height.ceil() as u32;
    RoiPx {
        x,
        y,
        w: w.min(GLASS_SNAPSHOT_MAX).min(D1A_WIDTH),
        h: h.min(GLASS_SNAPSHOT_MAX).min(D1A_HEIGHT),
    }
}

pub fn sampled_generation_is_current(sampled: u64, frame: u64) -> bool {
    sampled == frame
}

pub fn list_has_moving_sample(list: &NeoDisplayList) -> bool {
    list.ops.iter().any(|op| match op {
        NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk }) => {
            chunk.payload == StubPayload::MovingSample
        }
        _ => false,
    })
}

pub fn glass_barriers(list: &NeoDisplayList) -> Vec<&GlassBoundary> {
    list.ops
        .iter()
        .filter_map(|op| match op {
            NeoPaintOp::BackdropBarrier(barrier) => Some(barrier),
            _ => None,
        })
        .collect()
}

/// 1-based paint-order index of a glass barrier. Capture/timeline tokens use
/// this ordinal (`roi:2`), not a Blitz node id.
pub fn glass_ordinal(list: &NeoDisplayList, id: BarrierId) -> u32 {
    glass_barriers(list)
        .iter()
        .position(|barrier| barrier.id == id)
        .map(|idx| u32::try_from(idx).unwrap_or(u32::MAX).saturating_add(1))
        .unwrap_or(id.0)
}

pub fn last_glass(list: &NeoDisplayList) -> Option<&GlassBoundary> {
    glass_barriers(list).into_iter().next_back()
}

pub fn is_last_glass(list: &NeoDisplayList, id: BarrierId) -> bool {
    last_glass(list).is_some_and(|barrier| barrier.id == id)
}

/// Glass B follow-ROI clamped to the last producer barrier, not a hard-coded D1b rect.
pub fn last_glass_follow_roi(list: &NeoDisplayList, frame: u64) -> Rect {
    last_glass(list)
        .map(|barrier| glass_b_follow_roi_in(frame, barrier.roi))
        .unwrap_or_else(|| glass_b_follow_roi(frame))
}

pub fn static_d1b_scene() -> NeoDisplayList {
    let root_spatial = SpatialNodeId(0);
    let overlay_spatial = SpatialNodeId(1);
    let root_clip = ClipChainId(0);
    let glass_b_clip = ClipChainId(1);
    let root_effect = EffectNodeId(0);
    let opacity_effect = EffectNodeId(1);
    let root_backdrop = BackdropRootId(0);
    let opacity_scope = EffectScopeId(1);
    let rest = moving_bounds(0);

    let wallpaper = PaintChunk {
        id: PaintChunkId(1),
        generation: 1,
        paint_order: PaintOrderKey(10),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
        payload: StubPayload::Wallpaper,
    };
    let text = PaintChunk {
        id: PaintChunkId(2),
        generation: 1,
        paint_order: PaintOrderKey(30),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(36.0, 132.0, 210.0, 28.0),
        payload: StubPayload::VectorUi,
    };
    let grouped_vector = PaintChunk {
        id: PaintChunkId(3),
        generation: 1,
        paint_order: PaintOrderKey(40),
        spatial_node: root_spatial,
        clip_chain: glass_b_clip,
        effect_node: opacity_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(88.0, 84.0, 90.0, 36.0),
        payload: StubPayload::VectorUi,
    };
    let moving = PaintChunk {
        id: PaintChunkId(5),
        generation: 1,
        paint_order: PaintOrderKey(45),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: rest,
        payload: StubPayload::MovingSample,
    };
    let overlay = PaintChunk {
        id: PaintChunkId(4),
        generation: 1,
        paint_order: PaintOrderKey(60),
        spatial_node: overlay_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        bounds: Rect::new(208.0, 8.0, 96.0, 22.0),
        payload: StubPayload::Overlay,
    };

    let glass_a = GlassBoundary {
        id: BarrierId(1),
        spatial_node: root_spatial,
        clip_chain: root_clip,
        effect_node: root_effect,
        backdrop_root: root_backdrop,
        roi: Rect::new(24.0, 40.0, 140.0, 80.0),
    };
    let glass_b = GlassBoundary {
        id: BarrierId(2),
        spatial_node: root_spatial,
        clip_chain: glass_b_clip,
        effect_node: opacity_effect,
        backdrop_root: root_backdrop,
        roi: GLASS_B_BOUNDS,
    };

    NeoDisplayList {
        generation: 1,
        width: D1A_WIDTH,
        height: D1A_HEIGHT,
        spatial: Arc::from([
            SpatialNode {
                id: root_spatial,
                parent: None,
                transform: AffineCoeffs::IDENTITY,
            },
            SpatialNode {
                id: overlay_spatial,
                parent: Some(root_spatial),
                transform: AffineCoeffs::translate(4.0, 2.0),
            },
        ]),
        clips: Arc::from([
            ClipNode {
                id: root_clip,
                parent: None,
                rect: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
            },
            ClipNode {
                id: glass_b_clip,
                parent: Some(root_clip),
                rect: Rect::new(72.0, 64.0, 160.0, 96.0),
            },
        ]),
        effects: Arc::from([
            EffectNode {
                id: root_effect,
                parent: None,
                spatial_node: root_spatial,
                clip_chain: root_clip,
                bounds: Rect::new(0.0, 0.0, D1A_WIDTH as f32, D1A_HEIGHT as f32),
                kind: EffectKind::Isolation,
                backdrop_root: root_backdrop,
            },
            EffectNode {
                id: opacity_effect,
                parent: Some(root_effect),
                spatial_node: root_spatial,
                clip_chain: glass_b_clip,
                bounds: Rect::new(72.0, 64.0, 160.0, 96.0),
                kind: EffectKind::Opacity(0.85),
                backdrop_root: root_backdrop,
            },
        ]),
        ops: Arc::from([
            NeoPaintOp::Image(ImageLayer { chunk: wallpaper }),
            NeoPaintOp::BackdropBarrier(glass_a),
            NeoPaintOp::PaintChunk(text),
            NeoPaintOp::BeginEffectScope(opacity_scope),
            NeoPaintOp::PaintChunk(grouped_vector),
            NeoPaintOp::PaintChunk(moving),
            NeoPaintOp::BackdropBarrier(glass_b),
            NeoPaintOp::EndEffectScope(opacity_scope),
            NeoPaintOp::PaintChunk(overlay),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pass_graph::compile_passes;
    use crate::timeline::{compositor_owned_bytes, compositor_owned_bytes_d1b};

    #[test]
    fn d1b_pass_order_inserts_moving_before_glass_b() {
        let scene = static_d1b_scene();
        let passes = compile_passes(&scene).expect("valid D1b list");
        let kinds: Vec<&'static str> = passes
            .iter()
            .map(|pass| match pass {
                crate::pass_graph::CompiledPass::Raster { .. } => "raster",
                crate::pass_graph::CompiledPass::Glass { .. } => "glass",
                crate::pass_graph::CompiledPass::MovingSample { .. } => "moving",
                crate::pass_graph::CompiledPass::Interaction { .. } => "interaction",
            })
            .collect();
        assert_eq!(
            kinds,
            ["raster", "glass", "raster", "raster", "moving", "glass", "raster"]
        );
        assert!(list_has_moving_sample(&scene));
    }

    #[test]
    fn motion_and_follow_roi_are_bounded_and_change() {
        let a = moving_bounds(0);
        let b = moving_bounds(20);
        assert_ne!((a.x, a.y), (b.x, b.y));
        assert_eq!(a.width, MOVING_SIZE as f32);
        assert_eq!(a.height, MOVING_SIZE as f32);
        let roi0 = glass_b_follow_roi_px(0);
        let roi20 = glass_b_follow_roi_px(20);
        assert_ne!((roi0.x, roi0.y), (roi20.x, roi20.y));
        for roi in [roi0, roi20] {
            assert!(roi.w * roi.h < D1A_WIDTH * D1A_HEIGHT);
            assert!(roi.w <= GLASS_SNAPSHOT_MAX);
            assert!(roi.h <= GLASS_SNAPSHOT_MAX);
            assert!(roi.x + roi.w <= D1A_WIDTH);
            assert!(roi.y + roi.h <= D1A_HEIGHT);
        }
        assert!(!sampled_generation_is_current(1, 20));
        assert!(sampled_generation_is_current(20, 20));
        assert_eq!(
            compositor_owned_bytes_d1b(D1A_WIDTH, D1A_HEIGHT),
            compositor_owned_bytes(D1A_WIDTH, D1A_HEIGHT)
                + u64::from(MOVING_SIZE) * u64::from(MOVING_SIZE) * 4
                + u64::from(D1A_WIDTH) * u64::from(D1A_HEIGHT) * 4
        );
        assert_eq!(compositor_owned_bytes_d1b(D1A_WIDTH, D1A_HEIGHT), 1_046_528);
    }

    #[test]
    fn glass_ordinal_is_paint_order_not_host_id() {
        let scene = static_d1b_scene();
        assert_eq!(glass_ordinal(&scene, BarrierId(1)), 1);
        assert_eq!(glass_ordinal(&scene, BarrierId(2)), 2);
        assert!(is_last_glass(&scene, BarrierId(2)));
        assert!(!is_last_glass(&scene, BarrierId(1)));
    }

    #[test]
    fn d1a_scene_has_no_moving_sample() {
        assert!(!list_has_moving_sample(&crate::static_d1a_scene()));
    }
}
