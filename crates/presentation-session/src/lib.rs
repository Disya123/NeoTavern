//! Atomic chat-viewport ↔ compositor handoff (RFC §15.8 / §21).
//!
//! Geometry remap, hit-test, semantics, text, and tiles switch in one
//! [`FrameTransaction`]. Selection is a logical text position, not a tile
//! coordinate. This crate is not production JNI and not an Android cutover.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use neotavern_chat_viewport::{
    AckResult as ViewportAckResult, DeltaToken, GeometrySnapshot, LogicalItemId, SceneGeneration,
    ScrollAck as ViewportScrollAck, TileFidelity, ViewportSession,
};
use neotavern_neocompositor::{
    apply_autoscroll, autoscroll_delta, compose_selectable, AffineCoeffs, BackdropRootId,
    BidiAffinity, ClipChainId, ClipId, ClipNode, CompositorFastPath, DamageRect, DeviceEpoch,
    EffectKind, EffectNode, EffectNodeId, EpochClock, FrameMailbox, FrameTransaction,
    FrameTransactionParts, GeometryTile, GeometryTileSnapshot, GestureId, GlassBoundary,
    HitTestSnapshot, IngressReject, InteractionReady, LogicalRect, NeoDisplayList, NeoPaintOp,
    NeoScene, PaintChunk, PaintChunkId, PaintOrderKey, Point, PointerEvent, PointerId, PointerKind,
    PostAccept, PostReject, PresentationTime, PropertySnapshot, PropertyTreeBuilder,
    RasterDecision, Rect, SceneEpoch, ScrollAck as CompositorScrollAck, ScrollEpoch, ScrollId,
    ScrollSequence, SelectablePaintPlan, SpatialKind, SpatialNode, SpatialNodeId, StableSemanticId,
    StubPayload, SurfaceFrameIngress, SurfaceId, TextFragmentId, TextInteractionSnapshot,
    TextOffset, TextRange, TextSnapshotSet, TileCoverage, TileId, TileKind, Vec2,
    VisualSurfaceDeclare,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    MixedGeneration,
    MixedEpoch,
    Incomplete,
    Mailbox(PostReject),
    MissingFragment,
    FallbackNotReady,
    StaleSelection,
    VisualIngress(IngressReject),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionOutcome {
    Applied,
    IgnoredAlreadyApplied,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogicalTextAnchor {
    pub item: LogicalItemId,
    pub offset: TextOffset,
    pub affinity: BidiAffinity,
    pub semantic: StableSemanticId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionAnchor {
    pub anchor: LogicalTextAnchor,
    pub focus: LogicalTextAnchor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectionUpdate {
    pub raster: RasterDecision,
    pub logical_range: TextRange,
    pub damage: Vec<DamageRect>,
    pub glass_roi_invalidations: Vec<Rect>,
    pub autoscroll: Option<Vec2>,
}

pub fn map_viewport_geometry(
    snapshot: &GeometrySnapshot,
    width: f32,
    scene_epoch: SceneEpoch,
) -> Result<GeometryTileSnapshot, SessionError> {
    if !snapshot.generation.is_atomic() {
        return Err(SessionError::MixedGeneration);
    }
    let tiles = snapshot
        .tiles
        .iter()
        .map(|tile| GeometryTile {
            id: TileId(tile.id.0),
            bounds: Rect::new(
                0.0,
                (tile.origin - snapshot.offset) as f32,
                width,
                tile.height.max(1.0) as f32,
            ),
            generation: snapshot.generation.tiles,
            kind: match tile.fidelity {
                TileFidelity::Full => TileKind::Prepared,
                TileFidelity::Fallback => TileKind::Fallback,
            },
        })
        .collect();
    Ok(GeometryTileSnapshot::commit(scene_epoch, tiles))
}

pub struct PresentationSession {
    viewport: ViewportSession,
    clock: EpochClock,
    mailbox: FrameMailbox,
    path: CompositorFastPath,
    width: f32,
    height: f32,
    last_applied_token: Option<DeltaToken>,
    selection: Option<SelectionAnchor>,
    last_selection_union: Option<Rect>,
    scroll_id: Option<ScrollId>,
    texts: HashMap<LogicalItemId, TextInteractionSnapshot>,
    span_viewport: HashSet<LogicalItemId>,
    last_tx: Option<FrameTransaction>,
    last_event: Option<PointerEvent>,
    hit_spatial: Option<neotavern_neocompositor::SpatialId>,
    hit_clip: Option<ClipId>,
    autoscroll_seq: u64,
    ingress: SurfaceFrameIngress,
}

impl PresentationSession {
    pub fn new(viewport: ViewportSession, width: f32, height: f32) -> Self {
        let clock = EpochClock::new();
        let ingress = SurfaceFrameIngress::new(clock.device_epoch());
        Self {
            viewport,
            clock,
            mailbox: FrameMailbox::with_defaults(),
            path: CompositorFastPath::new(),
            width,
            height,
            last_applied_token: None,
            selection: None,
            last_selection_union: None,
            scroll_id: None,
            texts: HashMap::new(),
            span_viewport: HashSet::new(),
            last_tx: None,
            last_event: None,
            hit_spatial: None,
            hit_clip: None,
            autoscroll_seq: 0,
            ingress,
        }
    }

    pub fn viewport(&self) -> &ViewportSession {
        &self.viewport
    }

    pub fn viewport_mut(&mut self) -> &mut ViewportSession {
        &mut self.viewport
    }

    pub fn path(&self) -> &CompositorFastPath {
        &self.path
    }

    pub fn selection(&self) -> Option<SelectionAnchor> {
        self.selection
    }

    pub fn last_event(&self) -> Option<PointerEvent> {
        self.last_event
    }

    pub fn last_transaction(&self) -> Option<&FrameTransaction> {
        self.last_tx.as_ref()
    }

    pub fn scroll_id(&self) -> Option<ScrollId> {
        self.scroll_id
    }

    pub fn declare_visual_surface(
        &mut self,
        declare: VisualSurfaceDeclare,
    ) -> Result<SurfaceId, SessionError> {
        self.ingress
            .declare(declare)
            .map_err(SessionError::VisualIngress)
    }

    pub fn visual_ingress(&self) -> &SurfaceFrameIngress {
        &self.ingress
    }

    pub fn visual_ingress_mut(&mut self) -> &mut SurfaceFrameIngress {
        &mut self.ingress
    }

    pub fn recover_visual_device(&mut self, epoch: DeviceEpoch) {
        self.ingress.recover_device(epoch);
    }

    pub fn bind_item_text(&mut self, item: LogicalItemId, snapshot: TextInteractionSnapshot) {
        self.texts.insert(item, snapshot);
    }

    /// One logical message whose producer snapshot covers every active tile.
    pub fn bind_spanning_text(&mut self, item: LogicalItemId, snapshot: TextInteractionSnapshot) {
        self.span_viewport.insert(item);
        self.texts.insert(item, snapshot);
    }

    pub fn unbind_item_text(&mut self, item: LogicalItemId) {
        self.texts.remove(&item);
        self.span_viewport.remove(&item);
    }

    /// Geometry, hit-test, semantics, text, and tiles switch together.
    pub fn publish(&mut self) -> Result<FrameTransaction, SessionError> {
        let generation = self.viewport.scene_generation();
        if !generation.is_atomic() {
            return Err(SessionError::MixedGeneration);
        }
        let epoch = SceneEpoch(generation.geometry.max(1));
        let handoff = self.viewport.compositor_handoff();
        let geometry = map_viewport_geometry(&handoff, self.width, epoch)?;
        let (properties, scroll, spatial, clip) =
            commit_properties(epoch, self.width, self.height)?;
        self.scroll_id = Some(scroll);
        self.hit_spatial = Some(spatial);
        self.hit_clip = Some(clip);
        let text = self.commit_text(epoch, generation, &handoff, &geometry)?;
        let hits = hit_snapshot(epoch, &text, spatial, clip);
        let list = display_list(generation.geometry.max(1), self.width, self.height, &text);
        let tx = FrameTransaction::publish(FrameTransactionParts {
            frame_id: self.clock.next_frame(),
            scene_epoch: epoch,
            device_epoch: self.clock.device_epoch(),
            scene: NeoScene::from_display_list(list),
            damage: Vec::new(),
            leases: Vec::new(),
            properties,
            geometry,
            text,
        });
        if !tx.interaction_epochs_match() {
            return Err(SessionError::MixedEpoch);
        }
        match self.mailbox.post(tx.clone()) {
            Ok(PostAccept::Queued | PostAccept::Coalesced { .. }) => {}
            Err(err) => return Err(SessionError::Mailbox(err)),
        }
        self.path.bind_snapshot(tx.properties_arc());
        self.path
            .bind_geometry(tx.geometry_arc())
            .map_err(|_| SessionError::MixedEpoch)?;
        self.path
            .bind_text(tx.text_arc())
            .map_err(|_| SessionError::MixedEpoch)?;
        self.path
            .bind_hit_test(Arc::new(hits))
            .map_err(|_| SessionError::MixedEpoch)?;
        if let Some(scroll) = self.scroll_id {
            let _ = self.path.begin_gesture(GestureId(1), &[scroll]);
        }
        self.last_tx = Some(tx.clone());
        Ok(tx)
    }

    pub fn ack_scroll(&mut self, ack: ViewportScrollAck) -> ViewportAckResult {
        if self.last_applied_token == Some(ack.token) {
            return ViewportAckResult::IgnoredAlreadyApplied;
        }
        let result = self.viewport.ack_scroll(ack);
        if result == ViewportAckResult::Applied {
            self.last_applied_token = Some(ack.token);
            if let Some(scroll) = self.scroll_id {
                let _ = self.path.ack(CompositorScrollAck {
                    scroll_id: scroll,
                    epoch: ScrollEpoch(ack.scroll_generation),
                    base_offset: Vec2::new(0.0, ack.base_offset),
                    scroll_sequence: ScrollSequence(ack.scroll_generation),
                });
            }
        }
        result
    }

    pub fn commit_exact(
        &mut self,
        id: LogicalItemId,
        exact: f64,
    ) -> Result<neotavern_chat_viewport::RemapOutcome, SessionError> {
        let token = self.viewport.delta_token();
        let outcome = self
            .viewport
            .commit_exact(id, exact)
            .map_err(|_| SessionError::Incomplete)?;
        if outcome.applied {
            // Remember the token the viewport just applied (then rotated). A later
            // scroll ack with the same token must not compositor-ack that delta again.
            self.last_applied_token = Some(token);
            self.publish()?;
            self.rebind_selection()?;
        }
        Ok(outcome)
    }

    pub fn remove_item(
        &mut self,
        id: LogicalItemId,
        pointer: PointerId,
        time: PresentationTime,
    ) -> Result<SessionOutcome, SessionError> {
        let selected = self.selection.is_some_and(|sel| sel.anchor.item == id);
        self.viewport
            .remove_item(id)
            .map_err(|_| SessionError::Incomplete)?;
        self.texts.remove(&id);
        if selected {
            self.selection = None;
            self.last_selection_union = None;
        }
        self.publish()?;
        if let Ok(event) = self.path.pointer_move(pointer, Point::new(1.0, 1.0), time) {
            self.last_event = Some(event);
            if event.kind == PointerKind::Cancel {
                return Ok(SessionOutcome::Cancel);
            }
        }
        if selected {
            self.last_event = Some(PointerEvent {
                kind: PointerKind::Cancel,
                pointer,
                target: Some(StableSemanticId(id.0)),
                generation: 0,
                screen: Point::new(0.0, 0.0),
                local: None,
                scene_epoch: self
                    .last_tx
                    .as_ref()
                    .map(|tx| tx.scene_epoch())
                    .unwrap_or(SceneEpoch(0)),
                scroll_id: self.scroll_id,
                scroll_sequence: ScrollSequence(0),
            });
            return Ok(SessionOutcome::Cancel);
        }
        Ok(SessionOutcome::Applied)
    }

    pub fn begin_selection(
        &mut self,
        item: LogicalItemId,
        local_x: f32,
        local_y: f32,
        pointer: PointerId,
        time: PresentationTime,
    ) -> Result<LogicalTextAnchor, SessionError> {
        let spatial = self.hit_spatial.ok_or(SessionError::Incomplete)?;
        let clip = self.hit_clip.ok_or(SessionError::Incomplete)?;
        let fragment = {
            let tx = self.last_tx.as_ref().ok_or(SessionError::Incomplete)?;
            let fragment = fragment_for_item(tx.text(), item)?;
            ensure_interaction_ready(tx, fragment, spatial, clip)?;
            fragment.clone()
        };
        let event = self
            .path
            .pointer_down(pointer, Point::new(local_x as f64, local_y as f64), time)
            .ok();
        self.last_event = event;
        let offset = fragment
            .hit_caret(local_x, local_y)
            .unwrap_or(fragment.logical_range.start);
        let anchor = LogicalTextAnchor {
            item,
            offset,
            affinity: BidiAffinity::After,
            semantic: fragment.semantic,
        };
        self.selection = Some(SelectionAnchor {
            anchor,
            focus: anchor,
        });
        Ok(anchor)
    }

    pub fn drag_selection(
        &mut self,
        local_x: f32,
        local_y: f32,
        pointer_in_viewport: Option<Point>,
    ) -> Result<SelectionUpdate, SessionError> {
        let sel = self.selection.ok_or(SessionError::StaleSelection)?;
        let width = self.width;
        let height = self.height;
        let (fragment, geometry) = {
            let tx = self.last_tx.as_ref().ok_or(SessionError::Incomplete)?;
            (
                fragment_for_item(tx.text(), sel.anchor.item)?.clone(),
                tx.geometry().clone(),
            )
        };
        let focus = fragment
            .hit_caret(local_x, local_y)
            .unwrap_or(sel.focus.offset);
        let range = fragment.logical_copy_range(sel.anchor.offset, focus);
        let paint_plan = plan(width, height);
        let mut frame = compose_selectable(&fragment, &geometry, &paint_plan, range, Some(focus))
            .map_err(|_| SessionError::StaleSelection)?;
        self.selection = Some(SelectionAnchor {
            anchor: sel.anchor,
            focus: LogicalTextAnchor {
                offset: focus,
                ..sel.focus
            },
        });
        let new_union = union_damage(&frame.damage);
        let combined = match (self.last_selection_union, new_union) {
            (Some(prev), Some(next)) => Some(prev.union(next)),
            (Some(prev), None) => Some(prev),
            (None, Some(next)) => Some(next),
            (None, None) => None,
        };
        if let Some(combined) = combined {
            frame.damage = vec![DamageRect::from_rect(combined)];
        }
        self.last_selection_union = new_union;
        let pointer =
            pointer_in_viewport.unwrap_or(Point::new(f64::from(local_x), f64::from(local_y)));
        frame.autoscroll =
            autoscroll_delta(paint_plan.viewport, pointer.x as f32, pointer.y as f32);
        if let Some(delta) = frame.autoscroll {
            if let Some(scroll) = self.scroll_id {
                self.autoscroll_seq = self.autoscroll_seq.saturating_add(1);
                let seq = ScrollSequence(self.autoscroll_seq);
                let time = PresentationTime::from_millis(16 * self.autoscroll_seq);
                if self.path.latched_scroll() != Some(scroll) {
                    let _ = self.path.begin_gesture(GestureId(1), &[scroll]);
                }
                if self
                    .path
                    .gesture_delta(GestureId(1), delta, seq, time)
                    .is_err()
                {
                    let _ = apply_autoscroll(&mut self.path, scroll, delta, seq, time);
                }
                let _ = self.path.present(time);
            }
        }
        Ok(SelectionUpdate {
            raster: frame.raster,
            logical_range: frame.logical_range,
            damage: frame.damage,
            glass_roi_invalidations: frame.glass_roi_invalidations,
            autoscroll: frame.autoscroll,
        })
    }

    fn commit_text(
        &self,
        epoch: SceneEpoch,
        generation: SceneGeneration,
        handoff: &GeometrySnapshot,
        geometry: &GeometryTileSnapshot,
    ) -> Result<TextSnapshotSet, SessionError> {
        let mut fragments = Vec::new();
        for (item, template) in &self.texts {
            let tiles = if self.span_viewport.contains(item) {
                geometry
                    .tiles()
                    .iter()
                    .map(|tile| TileCoverage {
                        tile: tile.id,
                        clip: tile.bounds,
                    })
                    .collect()
            } else {
                coverage_for_item(handoff, geometry, *item)
            };
            if tiles.is_empty() {
                continue;
            }
            let mut fragment = template.clone();
            fragment.scene_epoch = epoch;
            fragment.generation = generation.semantics.max(1);
            fragment.fragment_id = TextFragmentId::new(item.0 as u32, fragment.generation);
            fragment.semantic = StableSemanticId(item.0);
            fragment.tiles = tiles.into();
            fragments.push(fragment);
        }
        TextSnapshotSet::commit(epoch, fragments).map_err(|_| SessionError::MixedEpoch)
    }

    fn rebind_selection(&mut self) -> Result<(), SessionError> {
        let Some(sel) = self.selection else {
            return Ok(());
        };
        let tx = self.last_tx.as_ref().ok_or(SessionError::Incomplete)?;
        match fragment_for_item(tx.text(), sel.anchor.item) {
            Ok(fragment) if fragment.semantic == sel.anchor.semantic => Ok(()),
            Ok(_) => {
                self.selection = None;
                Err(SessionError::StaleSelection)
            }
            Err(_) => {
                self.selection = None;
                Ok(())
            }
        }
    }
}

fn commit_properties(
    epoch: SceneEpoch,
    width: f32,
    height: f32,
) -> Result<
    (
        PropertySnapshot,
        ScrollId,
        neotavern_neocompositor::SpatialId,
        ClipId,
    ),
    SessionError,
> {
    let mut builder = PropertyTreeBuilder::new();
    let scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    let _scroll_node = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::IDENTITY,
        SpatialKind::Scroll {
            scroll_id: scroll,
            scrollport: LogicalRect::new(0.0, 0.0, f64::from(width), f64::from(height)),
            content_extent: LogicalRect::new(0.0, 0.0, f64::from(width), f64::from(height) * 8.0),
        },
    );
    let clip = builder.alloc_clip(
        None,
        root,
        LogicalRect::new(0.0, 0.0, f64::from(width), f64::from(height)),
    );
    let properties = builder
        .commit(epoch)
        .map_err(|_| SessionError::Incomplete)?;
    Ok((properties, scroll, root, clip))
}

fn coverage_for_item(
    handoff: &GeometrySnapshot,
    geometry: &GeometryTileSnapshot,
    item: LogicalItemId,
) -> Vec<TileCoverage> {
    handoff
        .tiles
        .iter()
        .filter(|tile| tile.first == item || tile.last == item)
        .filter_map(|tile| {
            let id = TileId(tile.id.0);
            geometry.get(id).map(|mapped| TileCoverage {
                tile: id,
                clip: mapped.bounds,
            })
        })
        .collect()
}

fn fragment_for_item(
    text: &TextSnapshotSet,
    item: LogicalItemId,
) -> Result<&TextInteractionSnapshot, SessionError> {
    text.fragments()
        .iter()
        .find(|fragment| fragment.semantic == StableSemanticId(item.0))
        .ok_or(SessionError::MissingFragment)
}

fn ensure_interaction_ready(
    tx: &FrameTransaction,
    fragment: &TextInteractionSnapshot,
    spatial: neotavern_neocompositor::SpatialId,
    clip: ClipId,
) -> Result<(), SessionError> {
    for cover in fragment.tiles.iter() {
        if matches!(
            tx.text()
                .interaction_hit_for_tile(tx.geometry(), cover.tile, spatial, clip, 1),
            InteractionReady::NotInteractionReady
        ) {
            return Err(SessionError::FallbackNotReady);
        }
    }
    Ok(())
}

fn hit_snapshot(
    epoch: SceneEpoch,
    text: &TextSnapshotSet,
    spatial: neotavern_neocompositor::SpatialId,
    clip: ClipId,
) -> HitTestSnapshot {
    let items = text
        .fragments()
        .iter()
        .map(|fragment| fragment.hit_test_item(spatial, clip, fragment.fragment_id.index()))
        .collect();
    HitTestSnapshot::commit(epoch, items)
}

fn display_list(
    generation: u64,
    width: f32,
    height: f32,
    text: &TextSnapshotSet,
) -> NeoDisplayList {
    let mut ops = vec![NeoPaintOp::Image(neotavern_neocompositor::ImageLayer {
        chunk: PaintChunk {
            id: PaintChunkId(1),
            generation,
            paint_order: PaintOrderKey(10),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            effect_node: EffectNodeId(0),
            backdrop_root: BackdropRootId(0),
            bounds: Rect::new(0.0, 0.0, width, height),
            payload: StubPayload::Wallpaper,
        },
    })];
    for (index, fragment) in text.fragments().iter().enumerate() {
        ops.push(NeoPaintOp::PaintChunk(PaintChunk {
            id: PaintChunkId(100 + index as u32),
            generation: fragment.generation,
            paint_order: PaintOrderKey(20 + index as u32),
            spatial_node: fragment.spatial_node,
            clip_chain: fragment.clip_chain,
            effect_node: fragment.effect_node,
            backdrop_root: fragment.backdrop_root,
            bounds: Rect::new(0.0, 0.0, width, height),
            payload: StubPayload::TransparentGlyphs,
        }));
        ops.push(NeoPaintOp::TextFragment(
            neotavern_neocompositor::TextPaintFragment {
                fragment_id: fragment.fragment_id,
                generation: fragment.generation,
                spatial_node: fragment.spatial_node,
                clip_chain: fragment.clip_chain,
                effect_node: fragment.effect_node,
                backdrop_root: fragment.backdrop_root,
                bounds: Rect::new(0.0, 0.0, width, height),
                tiles: fragment
                    .tiles
                    .iter()
                    .map(|cover| cover.tile)
                    .collect::<Vec<_>>()
                    .into(),
            },
        ));
    }
    NeoDisplayList {
        generation,
        width: width as u32,
        height: height as u32,
        spatial: Arc::from([SpatialNode {
            id: SpatialNodeId(0),
            parent: None,
            transform: AffineCoeffs::IDENTITY,
        }]),
        clips: Arc::from([ClipNode {
            id: ClipChainId(0),
            parent: None,
            rect: Rect::new(0.0, 0.0, width, height),
        }]),
        effects: Arc::from([EffectNode {
            id: EffectNodeId(0),
            parent: None,
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            bounds: Rect::new(0.0, 0.0, width, height),
            kind: EffectKind::Isolation,
            backdrop_root: BackdropRootId(0),
        }]),
        ops: ops.into(),
    }
}

fn plan(width: f32, height: f32) -> SelectablePaintPlan {
    let mut plan = SelectablePaintPlan::plain(
        PaintChunk {
            id: PaintChunkId(1),
            generation: 1,
            paint_order: PaintOrderKey(1),
            spatial_node: SpatialNodeId(0),
            clip_chain: ClipChainId(0),
            effect_node: EffectNodeId(0),
            backdrop_root: BackdropRootId(0),
            bounds: Rect::new(0.0, 0.0, width, height),
            payload: StubPayload::Wallpaper,
        },
        Rect::new(0.0, 0.0, width, height),
    );
    plan.under_subsequent_glass = Some(GlassBoundary {
        id: neotavern_neocompositor::BarrierId(1),
        spatial_node: SpatialNodeId(0),
        clip_chain: ClipChainId(0),
        effect_node: EffectNodeId(0),
        backdrop_root: BackdropRootId(0),
        roi: Rect::new(0.0, 0.0, width, height),
    });
    plan
}

fn union_damage(damage: &[DamageRect]) -> Option<Rect> {
    let mut iter = damage.iter();
    let first = iter.next()?;
    let mut rect = Rect::new(
        first.x as f32,
        first.y as f32,
        first.width as f32,
        first.height as f32,
    );
    for next in iter {
        rect = rect.union(Rect::new(
            next.x as f32,
            next.y as f32,
            next.width as f32,
            next.height as f32,
        ));
    }
    Some(rect)
}
