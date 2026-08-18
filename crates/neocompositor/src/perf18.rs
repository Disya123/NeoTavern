//! Canonical PERF-18 effect-scope scene (host golden + Android GPU probe).
//!
//! Status of the CPU corpus: **IMPLEMENTED / GPU_PENDING** until the host
//! adjudicator records a physical Vulkan capture. This module is not
//! production JNI.

use std::sync::Arc;

use crate::display_list::{
    AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, EffectKind, EffectNode,
    EffectNodeId, EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk,
    PaintChunkId, PaintOrderKey, Rect, SpatialNode, SpatialNodeId, StubPayload,
};

pub const FB_W: f32 = 1080.0;
pub const FB_H: f32 = 2400.0;
pub const CARD_X: f64 = 80.0;
pub const CARD_Y: f64 = 160.0;
pub const CARD_SCALE: f64 = 1.25;
pub const CARD_W: f32 = 200.0;
pub const CARD_H: f32 = 120.0;
pub const CLIP_RADIUS: f32 = 16.0;
pub const GLASS_LOCAL: Rect = Rect {
    x: 12.0,
    y: 20.0,
    width: 176.0,
    height: 56.0,
};

const ROOT_SPATIAL: SpatialNodeId = SpatialNodeId(0);
const CARD_SPATIAL: SpatialNodeId = SpatialNodeId(1);
const ROOT_CLIP: ClipChainId = ClipChainId(0);
const CARD_CLIP: ClipChainId = ClipChainId(1);
const ROOT_EFFECT: EffectNodeId = EffectNodeId(0);
const OPACITY_EFFECT: EffectNodeId = EffectNodeId(1);
const FILTER_EFFECT: EffectNodeId = EffectNodeId(2);
const MASK_EFFECT: EffectNodeId = EffectNodeId(3);
const ROUNDED_EFFECT: EffectNodeId = EffectNodeId(4);
const CONTENTS_EFFECT: EffectNodeId = EffectNodeId(5);
const OPACITY_SCOPE: EffectScopeId = EffectScopeId(1);
const FILTER_SCOPE: EffectScopeId = EffectScopeId(2);
const MASK_SCOPE: EffectScopeId = EffectScopeId(3);
const PARENT_ROOT: BackdropRootId = BackdropRootId(0);
const WALLPAPER: PaintChunkId = PaintChunkId(1);
const PREFIX: PaintChunkId = PaintChunkId(2);
const FOREGROUND: PaintChunkId = PaintChunkId(3);
const MEDIA: PaintChunkId = PaintChunkId(4);
const SIBLING: PaintChunkId = PaintChunkId(5);
const GLASS: BarrierId = BarrierId(1);

pub fn framebuffer() -> Rect {
    Rect::new(0.0, 0.0, FB_W, FB_H)
}

pub fn card_transform() -> AffineCoeffs {
    AffineCoeffs::translate(CARD_X, CARD_Y).compose(AffineCoeffs::scale(CARD_SCALE, CARD_SCALE))
}

fn world_aabb(transform: AffineCoeffs, local: Rect) -> Rect {
    let corners = [
        transform.transform_point(f64::from(local.x), f64::from(local.y)),
        transform.transform_point(f64::from(local.x1()), f64::from(local.y)),
        transform.transform_point(f64::from(local.x), f64::from(local.y1())),
        transform.transform_point(f64::from(local.x1()), f64::from(local.y1())),
    ];
    let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|p| p.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners
        .iter()
        .map(|p| p.1)
        .fold(f64::NEG_INFINITY, f64::max);
    Rect::new(
        min_x as f32,
        min_y as f32,
        (max_x - min_x) as f32,
        (max_y - min_y) as f32,
    )
}

fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let x1 = a.x1().min(b.x1());
    let y1 = a.y1().min(b.y1());
    Rect::new(x, y, (x1 - x).max(0.0), (y1 - y).max(0.0))
}

pub fn expected_glass_roi() -> Rect {
    let clip = world_aabb(card_transform(), Rect::new(0.0, 0.0, CARD_W, CARD_H));
    intersect(world_aabb(card_transform(), GLASS_LOCAL), clip)
}

pub fn expected_group_bounds() -> Rect {
    world_aabb(card_transform(), Rect::new(0.0, 0.0, CARD_W, CARD_H))
}

fn chunk(
    id: PaintChunkId,
    payload: StubPayload,
    spatial: SpatialNodeId,
    clip: ClipChainId,
    effect: EffectNodeId,
    backdrop: BackdropRootId,
    bounds: Rect,
) -> PaintChunk {
    PaintChunk {
        id,
        generation: 1,
        paint_order: PaintOrderKey(id.0),
        spatial_node: spatial,
        clip_chain: clip,
        effect_node: effect,
        backdrop_root: backdrop,
        bounds,
        payload,
    }
}

fn barrier(
    id: BarrierId,
    spatial: SpatialNodeId,
    clip: ClipChainId,
    effect: EffectNodeId,
    backdrop: BackdropRootId,
    roi: Rect,
) -> GlassBoundary {
    GlassBoundary {
        id,
        spatial_node: spatial,
        clip_chain: clip,
        effect_node: effect,
        backdrop_root: backdrop,
        roi,
    }
}

fn contents_chunk(id: PaintChunkId, payload: StubPayload, bounds: Rect) -> PaintChunk {
    chunk(
        id,
        payload,
        CARD_SPATIAL,
        CARD_CLIP,
        CONTENTS_EFFECT,
        PARENT_ROOT,
        bounds,
    )
}

/// Canonical PERF-18 scene:
/// backdrop root → BeginEffect(opacity/transform/rounded clip) → prefix →
/// glass → foreground text/media → EndEffect → following sibling.
pub fn reference_scene() -> NeoDisplayList {
    let roi = expected_glass_roi();
    let effects = vec![
        EffectNode {
            id: ROOT_EFFECT,
            parent: None,
            spatial_node: ROOT_SPATIAL,
            clip_chain: ROOT_CLIP,
            bounds: framebuffer(),
            kind: EffectKind::Isolation,
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: OPACITY_EFFECT,
            parent: Some(ROOT_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: expected_group_bounds(),
            kind: EffectKind::Opacity(0.5),
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: FILTER_EFFECT,
            parent: Some(OPACITY_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: expected_group_bounds(),
            kind: EffectKind::Filter,
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: MASK_EFFECT,
            parent: Some(FILTER_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: expected_group_bounds(),
            kind: EffectKind::Mask,
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: ROUNDED_EFFECT,
            parent: Some(MASK_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: expected_group_bounds(),
            kind: EffectKind::RoundedClip {
                radius: CLIP_RADIUS,
            },
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: CONTENTS_EFFECT,
            parent: Some(ROUNDED_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: expected_group_bounds(),
            kind: EffectKind::Isolation,
            backdrop_root: PARENT_ROOT,
        },
    ];
    NeoDisplayList {
        generation: 1,
        width: FB_W as u32,
        height: FB_H as u32,
        spatial: Arc::from([
            SpatialNode {
                id: ROOT_SPATIAL,
                parent: None,
                transform: AffineCoeffs::IDENTITY,
            },
            SpatialNode {
                id: CARD_SPATIAL,
                parent: Some(ROOT_SPATIAL),
                transform: card_transform(),
            },
        ]),
        clips: Arc::from([
            ClipNode {
                id: ROOT_CLIP,
                parent: None,
                rect: framebuffer(),
            },
            ClipNode {
                id: CARD_CLIP,
                parent: Some(ROOT_CLIP),
                rect: Rect::new(0.0, 0.0, CARD_W, CARD_H),
            },
        ]),
        effects: effects.into(),
        ops: vec![
            NeoPaintOp::Image(ImageLayer {
                chunk: chunk(
                    WALLPAPER,
                    StubPayload::Wallpaper,
                    ROOT_SPATIAL,
                    ROOT_CLIP,
                    ROOT_EFFECT,
                    PARENT_ROOT,
                    framebuffer(),
                ),
            }),
            NeoPaintOp::BeginEffectScope(OPACITY_SCOPE),
            NeoPaintOp::BeginEffectScope(FILTER_SCOPE),
            NeoPaintOp::BeginEffectScope(MASK_SCOPE),
            NeoPaintOp::PaintChunk(contents_chunk(
                PREFIX,
                StubPayload::VectorUi,
                Rect::new(0.0, 0.0, CARD_W, 18.0),
            )),
            NeoPaintOp::BackdropBarrier(barrier(
                GLASS,
                CARD_SPATIAL,
                CARD_CLIP,
                CONTENTS_EFFECT,
                PARENT_ROOT,
                roi,
            )),
            NeoPaintOp::PaintChunk(contents_chunk(
                FOREGROUND,
                StubPayload::VectorUi,
                Rect::new(8.0, 84.0, 160.0, 24.0),
            )),
            NeoPaintOp::Image(ImageLayer {
                chunk: contents_chunk(
                    MEDIA,
                    StubPayload::VectorUi,
                    Rect::new(8.0, 84.0, 48.0, 24.0),
                ),
            }),
            NeoPaintOp::EndEffectScope(MASK_SCOPE),
            NeoPaintOp::EndEffectScope(FILTER_SCOPE),
            NeoPaintOp::EndEffectScope(OPACITY_SCOPE),
            NeoPaintOp::PaintChunk(chunk(
                SIBLING,
                StubPayload::Overlay,
                ROOT_SPATIAL,
                ROOT_CLIP,
                ROOT_EFFECT,
                PARENT_ROOT,
                Rect::new(40.0, 640.0, 200.0, 40.0),
            )),
        ]
        .into(),
    }
}
