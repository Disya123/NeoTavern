//! Minimal RFC §9 interchange subset for the M0-D1a probe.

use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn x1(self) -> f32 {
        self.x + self.width
    }

    pub fn y1(self) -> f32 {
        self.y + self.height
    }
}

/// Column-major affine `[a, b, c, d, e, f]` as in kurbo (`|a c e; b d f|`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AffineCoeffs(pub [f64; 6]);

impl AffineCoeffs {
    pub const IDENTITY: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn translate(x: f64, y: f64) -> Self {
        Self([1.0, 0.0, 0.0, 1.0, x, y])
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialNode {
    pub id: SpatialNodeId,
    pub parent: Option<SpatialNodeId>,
    pub transform: AffineCoeffs,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipNode {
    pub id: ClipChainId,
    pub parent: Option<ClipChainId>,
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct PaintChunkId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct BarrierId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct SpatialNodeId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct ClipChainId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct EffectNodeId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct EffectScopeId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct BackdropRootId(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct PaintOrderKey(pub u32);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EffectKind {
    Opacity(f32),
    Isolation,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectNode {
    pub id: EffectNodeId,
    pub parent: Option<EffectNodeId>,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub bounds: Rect,
    pub kind: EffectKind,
    pub backdrop_root: BackdropRootId,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StubPayload {
    Wallpaper,
    VectorUi,
    Overlay,
    /// Compositor-owned sampleable texture. D1b only; never merged into Vello.
    MovingSample,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaintChunk {
    pub id: PaintChunkId,
    pub generation: u64,
    pub paint_order: PaintOrderKey,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
    pub bounds: Rect,
    pub payload: StubPayload,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GlassBoundary {
    pub id: BarrierId,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
    pub roi: Rect,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageLayer {
    pub chunk: PaintChunk,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NeoPaintOp {
    BeginEffectScope(EffectScopeId),
    EndEffectScope(EffectScopeId),
    PaintChunk(PaintChunk),
    BackdropBarrier(GlassBoundary),
    Image(ImageLayer),
}

#[derive(Clone, Debug, PartialEq)]
pub struct NeoDisplayList {
    pub generation: u64,
    pub width: u32,
    pub height: u32,
    pub spatial: Arc<[SpatialNode]>,
    pub clips: Arc<[ClipNode]>,
    pub effects: Arc<[EffectNode]>,
    pub ops: Arc<[NeoPaintOp]>,
}
