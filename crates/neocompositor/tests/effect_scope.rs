//! PERF-18 host golden: effect-scope / backdrop conformance.
//!
//! Status: **IMPLEMENTED / GPU_PENDING**. This corpus locks the CPU pass
//! graph, resource topology, and last-known-good reject path. It is **not**
//! PERF-18 PASS: RFC still requires an Android Vulkan capture.

use neotavern_neocompositor::{
    compile_passes, AffineCoeffs, BackdropRootId, BarrierId, ClipChainId, ClipNode, CompiledPass,
    EffectKind, EffectNode, EffectNodeId, EffectScopeId, EpochClock, FrameMailbox,
    FrameTransaction, GlassBoundary, GraphError, ImageLayer, LayerCache, LayerKey, NeoDisplayList,
    NeoPaintOp, NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, PostReject, Rect, ResourceLease,
    ResourceLeaseId, SpatialNode, SpatialNodeId, StubPayload,
};
use std::sync::Arc;

const FB_W: f32 = 1080.0;
const FB_H: f32 = 2400.0;
const CARD_X: f64 = 80.0;
const CARD_Y: f64 = 160.0;
const CARD_SCALE: f64 = 1.25;
const CARD_W: f32 = 200.0;
const CARD_H: f32 = 120.0;
const CLIP_RADIUS: f32 = 16.0;
const GLASS_LOCAL: Rect = Rect {
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

fn framebuffer() -> Rect {
    Rect::new(0.0, 0.0, FB_W, FB_H)
}

fn card_transform() -> AffineCoeffs {
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

fn area(rect: Rect) -> f32 {
    rect.width * rect.height
}

fn contains_rect(outer: Rect, inner: Rect) -> bool {
    inner.x >= outer.x - 1e-3
        && inner.y >= outer.y - 1e-3
        && inner.x1() <= outer.x1() + 1e-3
        && inner.y1() <= outer.y1() + 1e-3
}

fn expected_glass_roi() -> Rect {
    let clip = world_aabb(card_transform(), Rect::new(0.0, 0.0, CARD_W, CARD_H));
    intersect(world_aabb(card_transform(), GLASS_LOCAL), clip)
}

fn expected_group_bounds() -> Rect {
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

fn list(ops: Vec<NeoPaintOp>, extra_effects: Vec<EffectNode>) -> NeoDisplayList {
    let mut effects = vec![
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
    effects.extend(extra_effects);
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
        ops: ops.into(),
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
fn reference_scene() -> NeoDisplayList {
    let roi = expected_glass_roi();
    list(
        vec![
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
        ],
        Vec::new(),
    )
}

fn nested_opacity_scene() -> NeoDisplayList {
    let inner_scope = EffectScopeId(4);
    let inner_effect = EffectNodeId(6);
    let inner_contents = EffectNodeId(7);
    let inner_glass = BarrierId(2);
    let extra = vec![
        EffectNode {
            id: inner_effect,
            parent: Some(CONTENTS_EFFECT),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: Rect::new(90.0, 180.0, 120.0, 60.0),
            kind: EffectKind::Opacity(0.8),
            backdrop_root: PARENT_ROOT,
        },
        EffectNode {
            id: inner_contents,
            parent: Some(inner_effect),
            spatial_node: CARD_SPATIAL,
            clip_chain: CARD_CLIP,
            bounds: Rect::new(90.0, 180.0, 120.0, 60.0),
            kind: EffectKind::Isolation,
            backdrop_root: PARENT_ROOT,
        },
    ];
    let mut scene = reference_scene();
    let mut ops = Vec::from(scene.ops.as_ref());
    let glass_at = ops
        .iter()
        .position(|op| matches!(op, NeoPaintOp::BackdropBarrier(_)))
        .unwrap();
    ops.splice(
        glass_at..glass_at,
        [
            NeoPaintOp::BeginEffectScope(inner_scope),
            NeoPaintOp::PaintChunk(chunk(
                PaintChunkId(6),
                StubPayload::VectorUi,
                CARD_SPATIAL,
                CARD_CLIP,
                inner_contents,
                PARENT_ROOT,
                Rect::new(4.0, 4.0, 40.0, 12.0),
            )),
            NeoPaintOp::BackdropBarrier(barrier(
                inner_glass,
                CARD_SPATIAL,
                CARD_CLIP,
                inner_contents,
                PARENT_ROOT,
                Rect::new(100.0, 190.0, 80.0, 28.0),
            )),
            NeoPaintOp::EndEffectScope(inner_scope),
        ],
    );
    scene.ops = ops.into();
    let mut effects = Vec::from(scene.effects.as_ref());
    effects.extend(extra);
    scene.effects = effects.into();
    scene
}

fn isolation_scene() -> NeoDisplayList {
    let isolation_root = BackdropRootId(1);
    let isolation_effect = EffectNodeId(6);
    let isolation_scope = EffectScopeId(4);
    let isolation_contents = EffectNodeId(7);
    let iso_glass = BarrierId(3);
    NeoDisplayList {
        generation: 1,
        width: FB_W as u32,
        height: FB_H as u32,
        spatial: Arc::from([SpatialNode {
            id: ROOT_SPATIAL,
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([ClipNode {
            id: ROOT_CLIP,
            parent: None,
            rect: framebuffer(),
        }]),
        effects: Arc::from([
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
                id: isolation_effect,
                parent: Some(ROOT_EFFECT),
                spatial_node: ROOT_SPATIAL,
                clip_chain: ROOT_CLIP,
                bounds: Rect::new(40.0, 80.0, 400.0, 240.0),
                kind: EffectKind::Isolation,
                backdrop_root: isolation_root,
            },
            EffectNode {
                id: isolation_contents,
                parent: Some(isolation_effect),
                spatial_node: ROOT_SPATIAL,
                clip_chain: ROOT_CLIP,
                bounds: Rect::new(40.0, 80.0, 400.0, 240.0),
                kind: EffectKind::Isolation,
                backdrop_root: isolation_root,
            },
        ]),
        ops: Arc::from([
            NeoPaintOp::PaintChunk(chunk(
                WALLPAPER,
                StubPayload::Wallpaper,
                ROOT_SPATIAL,
                ROOT_CLIP,
                ROOT_EFFECT,
                PARENT_ROOT,
                framebuffer(),
            )),
            NeoPaintOp::BeginEffectScope(isolation_scope),
            NeoPaintOp::PaintChunk(chunk(
                PREFIX,
                StubPayload::VectorUi,
                ROOT_SPATIAL,
                ROOT_CLIP,
                isolation_contents,
                isolation_root,
                Rect::new(40.0, 80.0, 400.0, 40.0),
            )),
            NeoPaintOp::BackdropBarrier(barrier(
                iso_glass,
                ROOT_SPATIAL,
                ROOT_CLIP,
                isolation_contents,
                isolation_root,
                Rect::new(48.0, 128.0, 200.0, 80.0),
            )),
            NeoPaintOp::EndEffectScope(isolation_scope),
        ]),
    }
}

fn two_glass_scene() -> NeoDisplayList {
    let mut scene = reference_scene();
    let mut ops = Vec::from(scene.ops.as_ref());
    let after_first = ops
        .iter()
        .position(|op| matches!(op, NeoPaintOp::BackdropBarrier(b) if b.id == GLASS))
        .unwrap()
        + 1;
    ops.insert(
        after_first,
        NeoPaintOp::PaintChunk(contents_chunk(
            PaintChunkId(7),
            StubPayload::VectorUi,
            Rect::new(0.0, 40.0, CARD_W, 12.0),
        )),
    );
    ops.insert(
        after_first + 1,
        NeoPaintOp::BackdropBarrier(barrier(
            BarrierId(2),
            CARD_SPATIAL,
            CARD_CLIP,
            CONTENTS_EFFECT,
            PARENT_ROOT,
            Rect::new(95.0, 230.0, 180.0, 24.0),
        )),
    );
    scene.ops = ops.into();
    scene
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Topo {
    Raster {
        chunks: Vec<u32>,
        scopes: Vec<u32>,
    },
    Glass {
        barrier: u32,
        scopes: Vec<u32>,
        root: u32,
    },
}

fn topology(passes: &[CompiledPass]) -> Vec<Topo> {
    passes
        .iter()
        .map(|pass| match pass {
            CompiledPass::Raster {
                chunks,
                open_scopes,
            } => Topo::Raster {
                chunks: chunks.iter().map(|chunk| chunk.id.0).collect(),
                scopes: open_scopes.iter().map(|scope| scope.0).collect(),
            },
            CompiledPass::Glass {
                barrier,
                open_scopes,
            } => Topo::Glass {
                barrier: barrier.id.0,
                scopes: open_scopes.iter().map(|scope| scope.0).collect(),
                root: barrier.backdrop_root.0,
            },
            CompiledPass::MovingSample { chunk, open_scopes } => Topo::Raster {
                chunks: vec![chunk.id.0],
                scopes: open_scopes.iter().map(|scope| scope.0).collect(),
            },
        })
        .collect()
}

fn group_scopes() -> Vec<u32> {
    vec![OPACITY_SCOPE.0, FILTER_SCOPE.0, MASK_SCOPE.0]
}

fn backdrop_source_chunks(list: &NeoDisplayList, barrier: BarrierId) -> Vec<PaintChunkId> {
    let mut sources = Vec::new();
    let mut found = None;
    for op in list.ops.iter() {
        match op {
            NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk }) => {
                sources.push((chunk.id, chunk.backdrop_root, chunk.generation));
            }
            NeoPaintOp::BackdropBarrier(glass) if glass.id == barrier => {
                found = Some(glass.backdrop_root);
                break;
            }
            _ => {}
        }
    }
    let root = found.expect("barrier");
    sources
        .into_iter()
        .filter(|(_, chunk_root, _)| *chunk_root == root)
        .map(|(id, _, _)| id)
        .collect()
}

fn glass_roi_token(list: &NeoDisplayList, barrier: BarrierId) -> u64 {
    let sources = backdrop_source_chunks(list, barrier);
    list.ops
        .iter()
        .filter_map(|op| match op {
            NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk })
                if sources.contains(&chunk.id) =>
            {
                Some(chunk.generation)
            }
            _ => None,
        })
        .max()
        .unwrap_or(0)
}

fn bump_chunk_generation(list: &NeoDisplayList, id: PaintChunkId) -> NeoDisplayList {
    let mut scene = list.clone();
    let ops: Vec<NeoPaintOp> = scene
        .ops
        .iter()
        .cloned()
        .map(|op| match op {
            NeoPaintOp::PaintChunk(mut chunk) if chunk.id == id => {
                chunk.generation = chunk.generation.saturating_add(1);
                NeoPaintOp::PaintChunk(chunk)
            }
            NeoPaintOp::Image(ImageLayer { mut chunk }) if chunk.id == id => {
                chunk.generation = chunk.generation.saturating_add(1);
                NeoPaintOp::Image(ImageLayer { chunk })
            }
            other => other,
        })
        .collect();
    scene.ops = ops.into();
    scene
}

fn pass_edges(passes: &[CompiledPass]) -> Vec<(usize, usize)> {
    let mut writers: Vec<(usize, BackdropRootId, Option<EffectScopeId>)> = Vec::new();
    let mut edges = Vec::new();
    for (i, pass) in passes.iter().enumerate() {
        match pass {
            CompiledPass::Raster {
                chunks,
                open_scopes,
            } => {
                let root = chunks
                    .first()
                    .map(|chunk| chunk.backdrop_root)
                    .unwrap_or(PARENT_ROOT);
                writers.push((i, root, open_scopes.last().copied()));
            }
            CompiledPass::MovingSample { chunk, open_scopes } => {
                writers.push((i, chunk.backdrop_root, open_scopes.last().copied()));
            }
            CompiledPass::Glass {
                barrier,
                open_scopes,
            } => {
                for (j, root, scope) in &writers {
                    let same_root = *root == barrier.backdrop_root;
                    let same_group = match (scope, open_scopes.last()) {
                        (Some(a), Some(b)) => a == b,
                        _ => true,
                    };
                    if same_root || same_group {
                        edges.push((*j, i));
                    }
                }
                writers.push((i, barrier.backdrop_root, open_scopes.last().copied()));
            }
        }
    }
    edges
}

fn assert_acyclic(edges: &[(usize, usize)]) {
    for (src, dst) in edges {
        assert!(src < dst, "cyclic or backward backdrop edge {src} → {dst}");
    }
}

fn publish(clock: &mut EpochClock, scene: NeoDisplayList, lease: u64) -> FrameTransaction {
    let device = clock.device_epoch();
    FrameTransaction::publish_shared(
        clock.next_frame(),
        clock.next_scene(),
        device,
        Arc::new(NeoScene::from_display_list(scene)),
        Vec::new(),
        vec![ResourceLease {
            id: ResourceLeaseId(lease),
            device_epoch: device,
        }],
    )
}

#[test]
fn reference_scene_matches_golden_pass_topology() {
    let scene = reference_scene();
    let passes = compile_passes(&scene).expect("valid PERF-18 list");
    assert_eq!(
        topology(&passes),
        vec![
            Topo::Raster {
                chunks: vec![WALLPAPER.0],
                scopes: vec![],
            },
            Topo::Raster {
                chunks: vec![PREFIX.0],
                scopes: group_scopes(),
            },
            Topo::Glass {
                barrier: GLASS.0,
                scopes: group_scopes(),
                root: PARENT_ROOT.0,
            },
            Topo::Raster {
                chunks: vec![FOREGROUND.0, MEDIA.0],
                scopes: group_scopes(),
            },
            Topo::Raster {
                chunks: vec![SIBLING.0],
                scopes: vec![],
            },
        ]
    );
}

#[test]
fn backdrop_is_sampled_at_barrier_from_parent_root() {
    let scene = reference_scene();
    let passes = compile_passes(&scene).unwrap();
    let glass = passes
        .iter()
        .find_map(|pass| match pass {
            CompiledPass::Glass { barrier, .. } => Some(barrier),
            _ => None,
        })
        .unwrap();
    assert_eq!(glass.backdrop_root, PARENT_ROOT);
    assert_eq!(glass.spatial_node, CARD_SPATIAL);
    let sources = backdrop_source_chunks(&scene, GLASS);
    assert!(sources.contains(&WALLPAPER));
    assert!(sources.contains(&PREFIX));
    assert!(!sources.contains(&FOREGROUND));
    assert!(!sources.contains(&MEDIA));
    assert!(!sources.contains(&SIBLING));
    let published: Vec<_> = scene
        .effects
        .iter()
        .map(|node| node.backdrop_root)
        .collect();
    assert!(published.contains(&glass.backdrop_root));
    assert_eq!(
        published
            .iter()
            .filter(|root| **root != PARENT_ROOT)
            .count(),
        0,
        "opacity offscreen must not invent a backdrop root"
    );
}

#[test]
fn ancestor_opacity_applies_once_and_is_not_distributed() {
    let scene = reference_scene();
    let opacity_nodes: Vec<_> = scene
        .effects
        .iter()
        .filter(|node| matches!(node.kind, EffectKind::Opacity(_)))
        .collect();
    assert_eq!(opacity_nodes.len(), 1);
    assert_eq!(opacity_nodes[0].kind, EffectKind::Opacity(0.5));
    assert_eq!(opacity_nodes[0].id, OPACITY_EFFECT);
    for id in [PREFIX, FOREGROUND, MEDIA, SIBLING, WALLPAPER] {
        let chunk = scene.ops.iter().find_map(|op| match op {
            NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk })
                if chunk.id == id =>
            {
                Some(chunk)
            }
            _ => None,
        });
        let Some(chunk) = chunk else {
            continue;
        };
        let kind = scene
            .effects
            .iter()
            .find(|node| node.id == chunk.effect_node)
            .map(|node| node.kind);
        assert_ne!(
            kind,
            Some(EffectKind::Opacity(0.5)),
            "chunk {id:?} must not carry the group opacity"
        );
    }
    let passes = compile_passes(&scene).unwrap();
    let scoped: Vec<_> = passes
        .iter()
        .filter(|pass| pass.open_scopes().contains(&OPACITY_SCOPE))
        .collect();
    assert_eq!(scoped.len(), 3, "prefix, glass, foreground share one scope");
    assert!(matches!(scoped[1], CompiledPass::Glass { .. }));
}

#[test]
fn transformed_rounded_clip_bounds_glass_roi() {
    let scene = reference_scene();
    let rounded = scene
        .effects
        .iter()
        .find(|node| matches!(node.kind, EffectKind::RoundedClip { .. }))
        .unwrap();
    assert_eq!(
        rounded.kind,
        EffectKind::RoundedClip {
            radius: CLIP_RADIUS
        }
    );
    let passes = compile_passes(&scene).unwrap();
    let glass = passes
        .iter()
        .find_map(|pass| match pass {
            CompiledPass::Glass { barrier, .. } => Some(barrier),
            _ => None,
        })
        .unwrap();
    let expected = expected_glass_roi();
    assert_eq!(glass.roi, expected);
    assert_eq!(glass.clip_chain, CARD_CLIP);
    let clip = expected_group_bounds();
    assert!(contains_rect(clip, glass.roi));
    assert!(area(glass.roi) > 0.0);
    assert!(area(glass.roi) < area(framebuffer()));
    assert!(area(glass.roi) < area(clip) || (area(glass.roi) - area(clip)).abs() < 1.0);
}

#[test]
fn group_target_is_bounded_not_fullscreen() {
    let scene = reference_scene();
    let group = scene
        .effects
        .iter()
        .find(|node| node.id == OPACITY_EFFECT)
        .unwrap();
    assert!(area(group.bounds) > 0.0);
    assert!(area(group.bounds) < area(framebuffer()) * 0.25);
    assert_eq!(group.bounds, expected_group_bounds());
    let passes = compile_passes(&scene).unwrap();
    for pass in &passes {
        if let CompiledPass::Glass { barrier, .. } = pass {
            assert!(area(barrier.roi) < area(framebuffer()));
            assert!(!contains_rect(barrier.roi, framebuffer()));
        }
    }
}

#[test]
fn following_sibling_stays_outside_effect_scope() {
    let scene = reference_scene();
    let passes = compile_passes(&scene).unwrap();
    let sibling = passes.last().unwrap();
    assert_eq!(sibling.open_scopes(), &[] as &[EffectScopeId]);
    match sibling {
        CompiledPass::Raster { chunks, .. } => {
            assert_eq!(
                chunks.iter().map(|chunk| chunk.id).collect::<Vec<_>>(),
                vec![SIBLING]
            );
        }
        other => panic!("expected sibling raster, got {other:?}"),
    }
    let sources = backdrop_source_chunks(&scene, GLASS);
    assert!(!sources.contains(&SIBLING));
}

#[test]
fn nested_opacity_clip_transform_preserve_order() {
    let scene = nested_opacity_scene();
    let passes = compile_passes(&scene).unwrap();
    let inner = passes
        .iter()
        .find_map(|pass| match pass {
            CompiledPass::Glass {
                barrier,
                open_scopes,
            } if barrier.id == BarrierId(2) => Some(open_scopes.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        inner,
        vec![OPACITY_SCOPE, FILTER_SCOPE, MASK_SCOPE, EffectScopeId(4)]
    );
    let outer = passes
        .iter()
        .find_map(|pass| match pass {
            CompiledPass::Glass {
                barrier,
                open_scopes,
            } if barrier.id == GLASS => Some(open_scopes.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        outer,
        group_scopes()
            .into_iter()
            .map(EffectScopeId)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        scene
            .effects
            .iter()
            .filter(|node| matches!(node.kind, EffectKind::Opacity(_)))
            .count(),
        2
    );
}

#[test]
fn nested_glass_and_two_barriers_are_acyclic() {
    for scene in [nested_opacity_scene(), two_glass_scene()] {
        let passes = compile_passes(&scene).unwrap();
        let glasses: Vec<_> = passes
            .iter()
            .filter(|pass| matches!(pass, CompiledPass::Glass { .. }))
            .collect();
        assert!(glasses.len() >= 2);
        assert_acyclic(&pass_edges(&passes));
        let scopes: Vec<_> = glasses
            .iter()
            .map(|pass| pass.open_scopes().to_vec())
            .collect();
        assert!(
            scopes.windows(2).all(|pair| pair[0].len() <= pair[1].len()
                || pair[1].iter().all(|scope| pair[0].contains(scope))),
            "nested/sibling glass must keep ancestor scopes"
        );
    }
}

#[test]
fn two_glass_barriers_share_one_scope() {
    let scene = two_glass_scene();
    let passes = compile_passes(&scene).unwrap();
    let glasses: Vec<_> = passes
        .iter()
        .filter_map(|pass| match pass {
            CompiledPass::Glass {
                barrier,
                open_scopes,
            } => Some((barrier.id, open_scopes.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(glasses.len(), 2);
    assert_eq!(glasses[0].1, glasses[1].1);
    assert_eq!(
        glasses[0].1,
        group_scopes()
            .into_iter()
            .map(EffectScopeId)
            .collect::<Vec<_>>()
    );
}

#[test]
fn isolation_publishes_explicit_backdrop_root() {
    let scene = isolation_scene();
    let passes = compile_passes(&scene).unwrap();
    let glass = passes
        .iter()
        .find_map(|pass| match pass {
            CompiledPass::Glass { barrier, .. } => Some(barrier),
            _ => None,
        })
        .unwrap();
    assert_eq!(glass.backdrop_root, BackdropRootId(1));
    let sources = backdrop_source_chunks(&scene, BarrierId(3));
    assert!(sources.contains(&PREFIX));
    assert!(
        !sources.contains(&WALLPAPER),
        "isolation root must not sample the parent wallpaper"
    );
}

#[test]
fn mask_filter_placeholders_do_not_leak_or_flatten() {
    let scene = reference_scene();
    assert!(scene
        .effects
        .iter()
        .any(|node| matches!(node.kind, EffectKind::Filter)));
    assert!(scene
        .effects
        .iter()
        .any(|node| matches!(node.kind, EffectKind::Mask)));
    let passes = compile_passes(&scene).unwrap();
    for pass in &passes {
        if pass.open_scopes().contains(&OPACITY_SCOPE) {
            assert!(pass.open_scopes().contains(&FILTER_SCOPE));
            assert!(pass.open_scopes().contains(&MASK_SCOPE));
        }
        if let CompiledPass::Raster { chunks, .. } = pass {
            for chunk in chunks {
                let kind = scene
                    .effects
                    .iter()
                    .find(|node| node.id == chunk.effect_node)
                    .map(|node| node.kind);
                assert!(
                    !matches!(kind, Some(EffectKind::Filter | EffectKind::Mask)),
                    "filter/mask must not flatten onto paint chunks"
                );
            }
        }
    }
}

#[test]
fn foreground_change_does_not_invalidate_backdrop() {
    let scene = reference_scene();
    let before = glass_roi_token(&scene, GLASS);
    let mut cache = LayerCache::new(8);
    cache.insert(LayerKey {
        chunk: WALLPAPER,
        generation: 1,
    });
    cache.insert(LayerKey {
        chunk: PREFIX,
        generation: 1,
    });
    let changed = bump_chunk_generation(&scene, FOREGROUND);
    assert_eq!(glass_roi_token(&changed, GLASS), before);
    assert!(cache.get(LayerKey {
        chunk: WALLPAPER,
        generation: 1,
    }));
    assert!(cache.get(LayerKey {
        chunk: PREFIX,
        generation: 1,
    }));
}

#[test]
fn backdrop_change_invalidates_dependent_glass_roi() {
    let scene = reference_scene();
    let before = glass_roi_token(&scene, GLASS);
    let changed = bump_chunk_generation(&scene, PREFIX);
    assert_ne!(glass_roi_token(&changed, GLASS), before);
    let wallpaper = bump_chunk_generation(&scene, WALLPAPER);
    assert_ne!(glass_roi_token(&wallpaper, GLASS), before);
}

#[test]
fn malformed_effect_scope_is_rejected_before_present_and_keeps_last_known_good() {
    let mailbox = FrameMailbox::with_defaults();
    let mut clock = EpochClock::new();
    mailbox
        .post(publish(&mut clock, reference_scene(), 1))
        .unwrap();
    let good = match mailbox.try_dequeue() {
        neotavern_neocompositor::TryDequeue::Ready(tx) => tx,
        other => panic!("expected Ready, got {other:?}"),
    };
    assert_eq!(good.leases()[0].id, ResourceLeaseId(1));

    let mut extra_end = reference_scene();
    let mut ops = Vec::from(extra_end.ops.as_ref());
    ops.push(NeoPaintOp::EndEffectScope(EffectScopeId(99)));
    extra_end.ops = ops.into();
    assert_eq!(
        compile_passes(&extra_end),
        Err(GraphError::UnbalancedEnd(EffectScopeId(99)))
    );
    assert_eq!(
        mailbox.post(publish(&mut clock, extra_end, 2)),
        Err(PostReject::InvalidGraph)
    );

    let mut unclosed = reference_scene();
    let mut ops = Vec::from(unclosed.ops.as_ref());
    ops.retain(|op| !matches!(op, NeoPaintOp::EndEffectScope(id) if *id == OPACITY_SCOPE));
    unclosed.ops = ops.into();
    assert_eq!(compile_passes(&unclosed), Err(GraphError::UnclosedScopes));
    assert_eq!(
        mailbox.post(publish(&mut clock, unclosed, 3)),
        Err(PostReject::InvalidGraph)
    );

    let mut crossed = reference_scene();
    let mut ops = Vec::from(crossed.ops.as_ref());
    for op in &mut ops {
        if let NeoPaintOp::EndEffectScope(id) = op {
            if *id == MASK_SCOPE {
                *id = OPACITY_SCOPE;
            }
        }
    }
    crossed.ops = ops.into();
    assert!(matches!(
        compile_passes(&crossed),
        Err(GraphError::UnbalancedEnd(_))
    ));
    assert_eq!(
        mailbox.post(publish(&mut clock, crossed, 4)),
        Err(PostReject::InvalidGraph)
    );

    let mut duplicate = reference_scene();
    let mut ops = Vec::from(duplicate.ops.as_ref());
    ops.insert(1, NeoPaintOp::BeginEffectScope(OPACITY_SCOPE));
    duplicate.ops = ops.into();
    assert_eq!(
        compile_passes(&duplicate),
        Err(GraphError::DuplicateScope(OPACITY_SCOPE))
    );
    assert_eq!(
        mailbox.post(publish(&mut clock, duplicate, 5)),
        Err(PostReject::InvalidGraph)
    );

    assert_eq!(
        mailbox.last_known_good().unwrap().leases()[0].id,
        ResourceLeaseId(1)
    );
    assert_eq!(mailbox.pending_count(), 0);
}
