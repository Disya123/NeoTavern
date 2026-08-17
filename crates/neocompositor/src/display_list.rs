//! Production NeoDisplayList interchange (RFC §9 subset).
//!
//! M0 probes consume this crate. This is not a WebView cutover.

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

    /// Treat a transform as singular when `|det|` is below this epsilon.
    pub const SINGULAR_EPS: f64 = 1e-12;

    pub fn translate(x: f64, y: f64) -> Self {
        Self([1.0, 0.0, 0.0, 1.0, x, y])
    }

    pub fn scale(sx: f64, sy: f64) -> Self {
        Self([sx, 0.0, 0.0, sy, 0.0, 0.0])
    }

    /// Column-vector multiply `self * rhs` (`p' = self * rhs * p`).
    pub fn compose(self, rhs: Self) -> Self {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = rhs.0;
        Self([
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        ])
    }

    pub fn transform_point(self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    pub fn translation(self) -> (f64, f64) {
        (self.0[4], self.0[5])
    }

    pub fn determinant(self) -> f64 {
        let [a, b, c, d, ..] = self.0;
        a * d - b * c
    }

    pub fn is_finite(self) -> bool {
        self.0.iter().copied().all(f64::is_finite)
    }

    /// Inverse for hit-test. Singular or non-finite matrices return `None`
    /// (the node is non-hittable). This must not panic.
    pub fn inverse(self) -> Option<Self> {
        if !self.is_finite() {
            return None;
        }
        let det = self.determinant();
        if !det.is_finite() || det.abs() < Self::SINGULAR_EPS {
            return None;
        }
        let [a, b, c, d, e, f] = self.0;
        let inv = 1.0 / det;
        Some(Self([
            d * inv,
            -b * inv,
            -c * inv,
            a * inv,
            (c * f - d * e) * inv,
            (b * e - a * f) * inv,
        ]))
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

/// Group effects on the display list. `Filter` / `Mask` / `RoundedClip` are
/// host placeholders: they participate in nesting and bounds, and must not
/// be flattened across a [`crate::NeoPaintOp::BackdropBarrier`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EffectKind {
    Opacity(f32),
    Isolation,
    Filter,
    Mask,
    RoundedClip { radius: f32 },
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
    /// Compositor-owned sampleable texture. Never merged into a Vello run.
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
