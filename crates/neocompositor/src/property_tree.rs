//! Spatial / scroll / clip / effect property trees (RFC §9.1, §23.1).
//!
//! The snapshot is immutable and dense. Parent/cycle checks run at
//! [`PropertyTreeBuilder::commit`]. The present loop indexes arrays; it does
//! not allocate, hash, or wait on the UI mailbox.

use std::sync::Arc;

use crate::display_list::{AffineCoeffs, BackdropRootId};
use crate::epoch::SceneEpoch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct SpatialId {
    index: u32,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct ScrollId {
    index: u32,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct ClipId {
    index: u32,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct EffectId {
    index: u32,
    generation: u64,
}

impl SpatialId {
    /// Handle that never matches a live slot (diagnostics / rejection tests).
    pub const fn unbound(index: u32) -> Self {
        Self {
            index,
            generation: 0,
        }
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }
}

impl ScrollId {
    pub const fn unbound(index: u32) -> Self {
        Self {
            index,
            generation: 0,
        }
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }
}

impl ClipId {
    pub const fn unbound(index: u32) -> Self {
        Self {
            index,
            generation: 0,
        }
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }
}

impl EffectId {
    pub const fn unbound(index: u32) -> Self {
        Self {
            index,
            generation: 0,
        }
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub const fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }

    pub const fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }

    pub const fn is_zero(self) -> bool {
        self.x == 0.0 && self.y == 0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Size {
    pub const fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Insets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Insets {
    pub const fn uniform(v: f64) -> Self {
        Self {
            top: v,
            right: v,
            bottom: v,
            left: v,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollRange {
    pub min: Vec2,
    pub max: Vec2,
}

impl ScrollRange {
    pub fn unbounded() -> Self {
        Self {
            min: Vec2::new(f64::NEG_INFINITY, f64::NEG_INFINITY),
            max: Vec2::new(f64::INFINITY, f64::INFINITY),
        }
    }

    pub fn contains(self, v: Vec2) -> bool {
        v.x >= self.min.x && v.x <= self.max.x && v.y >= self.min.y && v.y <= self.max.y
    }

    pub fn clamp(self, v: Vec2) -> Vec2 {
        Vec2::new(
            v.x.clamp(self.min.x, self.max.x),
            v.y.clamp(self.min.y, self.max.y),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SpatialKind {
    ReferenceFrame,
    Scroll {
        scroll_id: ScrollId,
        scrollport: LogicalRect,
        content_extent: LogicalRect,
    },
    Sticky {
        scroll_id: ScrollId,
        normal_origin: Point,
        constraint_rect: LogicalRect,
        insets: Insets,
        valid_scroll_range: ScrollRange,
        size: Size,
    },
    Fixed {
        containing_block: SpatialId,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PropertyEffectKind {
    Opacity(f32),
    Filter,
    Mask,
    Isolation,
    Glass,
}

impl PropertyEffectKind {
    pub fn is_group_scope(self) -> bool {
        matches!(self, Self::Opacity(_) | Self::Filter | Self::Mask)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialTreeNode {
    pub id: SpatialId,
    pub parent: Option<SpatialId>,
    pub producer_transform: AffineCoeffs,
    pub kind: SpatialKind,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipTreeNode {
    pub id: ClipId,
    pub parent: Option<ClipId>,
    pub spatial: SpatialId,
    pub rect: LogicalRect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EffectTreeNode {
    pub id: EffectId,
    pub parent: Option<EffectId>,
    pub spatial: SpatialId,
    pub clip: ClipId,
    pub kind: PropertyEffectKind,
    pub backdrop_root: BackdropRootId,
    pub bounds: LogicalRect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EffectSpec {
    pub parent: Option<EffectId>,
    pub spatial: SpatialId,
    pub clip: ClipId,
    pub kind: PropertyEffectKind,
    pub backdrop_root: BackdropRootId,
    pub bounds: LogicalRect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeError {
    MissingParent,
    StaleParent,
    Cycle,
    MissingScroll,
    StaleScroll,
    DuplicateScroll,
    StickyScrollNotAncestor,
    MissingContainingBlock,
    StaleContainingBlock,
    ContainingBlockMismatch,
    MissingClipParent,
    StaleClip,
    ClipCycle,
    MissingClipSpatial,
    StaleClipSpatial,
    MissingEffectParent,
    StaleEffect,
    EffectCycle,
    MissingEffectSpatial,
    StaleEffectSpatial,
    MissingEffectClip,
    StaleEffectClip,
    MissingBackdropRoot,
    GenerationOverflow,
    StaleHandle,
    BufferTooSmall,
}

impl std::fmt::Display for TreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for TreeError {}

#[derive(Clone, Debug, PartialEq)]
struct SpatialSlot {
    generation: u64,
    live: Option<SpatialDraft>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SpatialDraft {
    parent: Option<SpatialId>,
    producer_transform: AffineCoeffs,
    kind: SpatialKind,
}

#[derive(Clone, Debug, PartialEq)]
struct ScrollSlot {
    generation: u64,
    live: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct ClipSlot {
    generation: u64,
    live: Option<ClipDraft>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ClipDraft {
    parent: Option<ClipId>,
    spatial: SpatialId,
    rect: LogicalRect,
}

#[derive(Clone, Debug, PartialEq)]
struct EffectSlot {
    generation: u64,
    live: Option<EffectDraft>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct EffectDraft {
    parent: Option<EffectId>,
    spatial: SpatialId,
    clip: ClipId,
    kind: PropertyEffectKind,
    backdrop_root: BackdropRootId,
    bounds: LogicalRect,
}

/// Producer-side allocator. Handles are generation-tagged; recycle bumps the
/// generation so a reused index cannot revive a stale parent (no ABA).
#[derive(Clone, Debug, Default)]
pub struct PropertyTreeBuilder {
    spatial: Vec<SpatialSlot>,
    spatial_free: Vec<u32>,
    scrolls: Vec<ScrollSlot>,
    scroll_free: Vec<u32>,
    clips: Vec<ClipSlot>,
    clip_free: Vec<u32>,
    effects: Vec<EffectSlot>,
    effect_free: Vec<u32>,
    backdrop_roots: Vec<BackdropRootId>,
    next_backdrop: u32,
}

impl PropertyTreeBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn declare_backdrop_root(&mut self) -> BackdropRootId {
        let id = BackdropRootId(self.next_backdrop);
        self.next_backdrop = self
            .next_backdrop
            .checked_add(1)
            .expect("BackdropRootId overflow");
        self.backdrop_roots.push(id);
        id
    }

    pub fn alloc_scroll(&mut self) -> ScrollId {
        if let Some(index) = self.scroll_free.pop() {
            let slot = &mut self.scrolls[index as usize];
            slot.live = true;
            ScrollId {
                index,
                generation: slot.generation,
            }
        } else {
            let index = self.scrolls.len() as u32;
            self.scrolls.push(ScrollSlot {
                generation: 1,
                live: true,
            });
            ScrollId {
                index,
                generation: 1,
            }
        }
    }

    pub fn alloc_spatial(
        &mut self,
        parent: Option<SpatialId>,
        producer_transform: AffineCoeffs,
        kind: SpatialKind,
    ) -> SpatialId {
        let draft = SpatialDraft {
            parent,
            producer_transform,
            kind,
        };
        if let Some(index) = self.spatial_free.pop() {
            let slot = &mut self.spatial[index as usize];
            slot.live = Some(draft);
            SpatialId {
                index,
                generation: slot.generation,
            }
        } else {
            let index = self.spatial.len() as u32;
            self.spatial.push(SpatialSlot {
                generation: 1,
                live: Some(draft),
            });
            SpatialId {
                index,
                generation: 1,
            }
        }
    }

    pub fn alloc_clip(
        &mut self,
        parent: Option<ClipId>,
        spatial: SpatialId,
        rect: LogicalRect,
    ) -> ClipId {
        let draft = ClipDraft {
            parent,
            spatial,
            rect,
        };
        if let Some(index) = self.clip_free.pop() {
            let slot = &mut self.clips[index as usize];
            slot.live = Some(draft);
            ClipId {
                index,
                generation: slot.generation,
            }
        } else {
            let index = self.clips.len() as u32;
            self.clips.push(ClipSlot {
                generation: 1,
                live: Some(draft),
            });
            ClipId {
                index,
                generation: 1,
            }
        }
    }

    pub fn alloc_effect(&mut self, spec: EffectSpec) -> EffectId {
        let draft = EffectDraft {
            parent: spec.parent,
            spatial: spec.spatial,
            clip: spec.clip,
            kind: spec.kind,
            backdrop_root: spec.backdrop_root,
            bounds: spec.bounds,
        };
        if let Some(index) = self.effect_free.pop() {
            let slot = &mut self.effects[index as usize];
            slot.live = Some(draft);
            EffectId {
                index,
                generation: slot.generation,
            }
        } else {
            let index = self.effects.len() as u32;
            self.effects.push(EffectSlot {
                generation: 1,
                live: Some(draft),
            });
            EffectId {
                index,
                generation: 1,
            }
        }
    }

    pub fn recycle_spatial(&mut self, id: SpatialId) -> Result<(), TreeError> {
        let slot = self
            .spatial
            .get_mut(id.index as usize)
            .ok_or(TreeError::StaleHandle)?;
        if slot.live.is_none() || slot.generation != id.generation {
            return Err(TreeError::StaleHandle);
        }
        slot.live = None;
        slot.generation = slot
            .generation
            .checked_add(1)
            .ok_or(TreeError::GenerationOverflow)?;
        self.spatial_free.push(id.index);
        Ok(())
    }

    pub fn recycle_scroll(&mut self, id: ScrollId) -> Result<(), TreeError> {
        let slot = self
            .scrolls
            .get_mut(id.index as usize)
            .ok_or(TreeError::StaleHandle)?;
        if !slot.live || slot.generation != id.generation {
            return Err(TreeError::StaleHandle);
        }
        slot.live = false;
        slot.generation = slot
            .generation
            .checked_add(1)
            .ok_or(TreeError::GenerationOverflow)?;
        self.scroll_free.push(id.index);
        Ok(())
    }

    pub fn reparent_spatial(
        &mut self,
        id: SpatialId,
        parent: Option<SpatialId>,
    ) -> Result<(), TreeError> {
        let slot = self
            .spatial
            .get_mut(id.index as usize)
            .ok_or(TreeError::StaleHandle)?;
        let live = slot.live.as_mut().ok_or(TreeError::StaleHandle)?;
        if slot.generation != id.generation {
            return Err(TreeError::StaleHandle);
        }
        live.parent = parent;
        Ok(())
    }

    pub fn reparent_clip(&mut self, id: ClipId, parent: Option<ClipId>) -> Result<(), TreeError> {
        let slot = self
            .clips
            .get_mut(id.index as usize)
            .ok_or(TreeError::StaleHandle)?;
        let live = slot.live.as_mut().ok_or(TreeError::StaleHandle)?;
        if slot.generation != id.generation {
            return Err(TreeError::StaleHandle);
        }
        live.parent = parent;
        Ok(())
    }

    pub fn reparent_effect(
        &mut self,
        id: EffectId,
        parent: Option<EffectId>,
    ) -> Result<(), TreeError> {
        let slot = self
            .effects
            .get_mut(id.index as usize)
            .ok_or(TreeError::StaleHandle)?;
        let live = slot.live.as_mut().ok_or(TreeError::StaleHandle)?;
        if slot.generation != id.generation {
            return Err(TreeError::StaleHandle);
        }
        live.parent = parent;
        Ok(())
    }

    pub fn commit(self, scene_epoch: SceneEpoch) -> Result<PropertySnapshot, TreeError> {
        compile_snapshot(self, scene_epoch)
    }
}

/// Immutable property-tree snapshot published inside [`crate::FrameTransaction`].
#[derive(Clone, Debug, PartialEq)]
pub struct PropertySnapshot {
    scene_epoch: SceneEpoch,
    spatial: Arc<[Option<SpatialTreeNode>]>,
    scrolls: Arc<[Option<ScrollId>]>,
    clips: Arc<[Option<ClipTreeNode>]>,
    effects: Arc<[Option<EffectTreeNode>]>,
    spatial_topo: Arc<[u32]>,
    spatial_child_offsets: Arc<[u32]>,
    spatial_children: Arc<[u32]>,
    scroll_spatial: Arc<[Option<u32>]>,
    backdrop_roots: Arc<[BackdropRootId]>,
}

impl Default for PropertySnapshot {
    fn default() -> Self {
        Self::empty()
    }
}

impl PropertySnapshot {
    pub fn empty() -> Self {
        Self {
            scene_epoch: SceneEpoch(0),
            spatial: Arc::from([]),
            scrolls: Arc::from([]),
            clips: Arc::from([]),
            effects: Arc::from([]),
            spatial_topo: Arc::from([]),
            spatial_child_offsets: Arc::from([0]),
            spatial_children: Arc::from([]),
            scroll_spatial: Arc::from([]),
            backdrop_roots: Arc::from([]),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.spatial.is_empty()
            && self.scrolls.is_empty()
            && self.clips.is_empty()
            && self.effects.is_empty()
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn spatial_slot_count(&self) -> usize {
        self.spatial.len()
    }

    pub fn scroll_slot_count(&self) -> usize {
        self.scrolls.len()
    }

    pub fn clip_slot_count(&self) -> usize {
        self.clips.len()
    }

    pub fn effect_slot_count(&self) -> usize {
        self.effects.len()
    }

    pub fn spatial_topo(&self) -> &[u32] {
        &self.spatial_topo
    }

    pub fn spatial(&self, id: SpatialId) -> Option<&SpatialTreeNode> {
        let node = self.spatial.get(id.index as usize)?.as_ref()?;
        (node.id == id).then_some(node)
    }

    pub fn clip(&self, id: ClipId) -> Option<&ClipTreeNode> {
        let node = self.clips.get(id.index as usize)?.as_ref()?;
        (node.id == id).then_some(node)
    }

    pub fn effect(&self, id: EffectId) -> Option<&EffectTreeNode> {
        let node = self.effects.get(id.index as usize)?.as_ref()?;
        (node.id == id).then_some(node)
    }

    pub fn effect_at(&self, index: u32) -> Option<&EffectTreeNode> {
        self.effects.get(index as usize)?.as_ref()
    }

    pub fn scroll_is_live(&self, id: ScrollId) -> bool {
        self.scrolls
            .get(id.index as usize)
            .and_then(|slot| slot.as_ref())
            .is_some_and(|live| *live == id)
    }

    pub fn scroll_at(&self, index: u32) -> Option<ScrollId> {
        self.scrolls.get(index as usize).copied().flatten()
    }

    pub fn scroll_bounds(&self, id: ScrollId) -> Option<ScrollRange> {
        let spatial = self.spatial_for_scroll(id)?;
        let node = self.spatial(spatial)?;
        match node.kind {
            SpatialKind::Scroll {
                scrollport,
                content_extent,
                ..
            } => {
                let max_x = (content_extent.width - scrollport.width).max(0.0);
                let max_y = (content_extent.height - scrollport.height).max(0.0);
                Some(ScrollRange {
                    min: Vec2::new(0.0, 0.0),
                    max: Vec2::new(max_x, max_y),
                })
            }
            _ => None,
        }
    }

    pub fn spatial_for_scroll(&self, id: ScrollId) -> Option<SpatialId> {
        if !self.scroll_is_live(id) {
            return None;
        }
        let index = *self.scroll_spatial.get(id.index as usize)?.as_ref()?;
        self.spatial[index as usize].as_ref().map(|node| node.id)
    }

    pub fn backdrop_roots(&self) -> &[BackdropRootId] {
        &self.backdrop_roots
    }

    pub fn children(&self, index: u32) -> &[u32] {
        let i = index as usize;
        if i + 1 >= self.spatial_child_offsets.len() {
            return &[];
        }
        let start = self.spatial_child_offsets[i] as usize;
        let end = self.spatial_child_offsets[i + 1] as usize;
        &self.spatial_children[start..end]
    }

    /// Writes the effect ancestor chain (self first, then parents) into `out`.
    /// No heap allocation.
    pub fn copy_effect_chain(
        &self,
        id: EffectId,
        out: &mut [EffectId],
    ) -> Result<usize, TreeError> {
        let mut current = Some(id);
        let mut n = 0usize;
        let mut guard = 0usize;
        while let Some(effect_id) = current {
            if guard > self.effects.len() {
                return Err(TreeError::EffectCycle);
            }
            guard += 1;
            let node = self.effect(effect_id).ok_or(TreeError::StaleEffect)?;
            if n >= out.len() {
                return Err(TreeError::BufferTooSmall);
            }
            out[n] = effect_id;
            n += 1;
            current = node.parent;
        }
        Ok(n)
    }

    pub fn group_scope_depth(&self, id: EffectId) -> Result<usize, TreeError> {
        let mut buf = [EffectId::unbound(0); 32];
        let n = self.copy_effect_chain(id, &mut buf)?;
        Ok(buf[..n]
            .iter()
            .filter(|effect_id| {
                self.effect(**effect_id)
                    .is_some_and(|node| node.kind.is_group_scope())
            })
            .count())
    }

    pub fn validate(&self) -> Result<(), TreeError> {
        validate_snapshot(self)
    }
}

fn compile_snapshot(
    builder: PropertyTreeBuilder,
    scene_epoch: SceneEpoch,
) -> Result<PropertySnapshot, TreeError> {
    let spatial = freeze_spatial(&builder.spatial);
    let scrolls = freeze_scrolls(&builder.scrolls);
    let clips = freeze_clips(&builder.clips);
    let effects = freeze_effects(&builder.effects);
    let snapshot = PropertySnapshot {
        scene_epoch,
        spatial,
        scrolls,
        clips,
        effects,
        spatial_topo: Arc::from([]),
        spatial_child_offsets: Arc::from([]),
        spatial_children: Arc::from([]),
        scroll_spatial: Arc::from([]),
        backdrop_roots: Arc::from(builder.backdrop_roots),
    };
    let tables = index_snapshot(&snapshot)?;
    let snapshot = PropertySnapshot {
        spatial_topo: tables.topo,
        spatial_child_offsets: tables.child_offsets,
        spatial_children: tables.children,
        scroll_spatial: tables.scroll_spatial,
        ..snapshot
    };
    snapshot.validate()?;
    Ok(snapshot)
}

fn freeze_spatial(slots: &[SpatialSlot]) -> Arc<[Option<SpatialTreeNode>]> {
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.live.map(|draft| SpatialTreeNode {
                id: SpatialId {
                    index: index as u32,
                    generation: slot.generation,
                },
                parent: draft.parent,
                producer_transform: draft.producer_transform,
                kind: draft.kind,
            })
        })
        .collect()
}

fn freeze_scrolls(slots: &[ScrollSlot]) -> Arc<[Option<ScrollId>]> {
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.live.then_some(ScrollId {
                index: index as u32,
                generation: slot.generation,
            })
        })
        .collect()
}

fn freeze_clips(slots: &[ClipSlot]) -> Arc<[Option<ClipTreeNode>]> {
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.live.map(|draft| ClipTreeNode {
                id: ClipId {
                    index: index as u32,
                    generation: slot.generation,
                },
                parent: draft.parent,
                spatial: draft.spatial,
                rect: draft.rect,
            })
        })
        .collect()
}

fn freeze_effects(slots: &[EffectSlot]) -> Arc<[Option<EffectTreeNode>]> {
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.live.map(|draft| EffectTreeNode {
                id: EffectId {
                    index: index as u32,
                    generation: slot.generation,
                },
                parent: draft.parent,
                spatial: draft.spatial,
                clip: draft.clip,
                kind: draft.kind,
                backdrop_root: draft.backdrop_root,
                bounds: draft.bounds,
            })
        })
        .collect()
}

struct SpatialTables {
    topo: Arc<[u32]>,
    child_offsets: Arc<[u32]>,
    children: Arc<[u32]>,
    scroll_spatial: Arc<[Option<u32>]>,
}

fn index_snapshot(snapshot: &PropertySnapshot) -> Result<SpatialTables, TreeError> {
    check_spatial_refs(snapshot)?;
    check_cycles(
        &snapshot.spatial,
        |node| node.parent.map(|id| id.index),
        TreeError::Cycle,
    )?;
    check_clip_refs(snapshot)?;
    check_cycles(
        &snapshot.clips,
        |node| node.parent.map(|id| id.index),
        TreeError::ClipCycle,
    )?;
    check_effect_refs(snapshot)?;
    check_cycles(
        &snapshot.effects,
        |node| node.parent.map(|id| id.index),
        TreeError::EffectCycle,
    )?;

    let n = snapshot.spatial.len();
    let mut lists: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (index, slot) in snapshot.spatial.iter().enumerate() {
        if let Some(node) = slot {
            if let Some(parent) = node.parent {
                lists[parent.index as usize].push(index as u32);
            }
        }
    }
    let mut child_offsets = vec![0u32; n + 1];
    let mut children = Vec::new();
    for i in 0..n {
        child_offsets[i] = children.len() as u32;
        children.extend_from_slice(&lists[i]);
    }
    child_offsets[n] = children.len() as u32;

    let mut topo = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    for i in 0..n {
        if snapshot.spatial[i].is_some() {
            push_topo(i as u32, snapshot, &mut seen, &mut topo);
        }
    }

    let mut scroll_spatial = vec![None; snapshot.scrolls.len()];
    for (index, slot) in snapshot.spatial.iter().enumerate() {
        let Some(node) = slot else { continue };
        if let SpatialKind::Scroll { scroll_id, .. } = node.kind {
            if !snapshot.scroll_is_live(scroll_id) {
                return Err(
                    if snapshot.scrolls.get(scroll_id.index as usize).is_some() {
                        TreeError::StaleScroll
                    } else {
                        TreeError::MissingScroll
                    },
                );
            }
            let owner = &mut scroll_spatial[scroll_id.index as usize];
            if owner.is_some() {
                return Err(TreeError::DuplicateScroll);
            }
            *owner = Some(index as u32);
        }
    }

    for slot in snapshot.spatial.iter().flatten() {
        if let SpatialKind::Sticky { scroll_id, .. } = slot.kind {
            let owner = scroll_spatial
                .get(scroll_id.index as usize)
                .and_then(|v| *v)
                .ok_or(TreeError::MissingScroll)?;
            if !is_ancestor(snapshot, slot.id.index, owner) {
                return Err(TreeError::StickyScrollNotAncestor);
            }
        }
        if let SpatialKind::Fixed { containing_block } = slot.kind {
            let block = snapshot.spatial(containing_block).ok_or(
                if snapshot
                    .spatial
                    .get(containing_block.index as usize)
                    .is_some()
                {
                    TreeError::StaleContainingBlock
                } else {
                    TreeError::MissingContainingBlock
                },
            )?;
            let parent = slot.parent.ok_or(TreeError::ContainingBlockMismatch)?;
            if parent != block.id {
                return Err(TreeError::ContainingBlockMismatch);
            }
        }
    }

    Ok(SpatialTables {
        topo: topo.into(),
        child_offsets: child_offsets.into(),
        children: children.into(),
        scroll_spatial: scroll_spatial.into(),
    })
}

fn push_topo(index: u32, snapshot: &PropertySnapshot, seen: &mut [bool], out: &mut Vec<u32>) {
    let i = index as usize;
    if seen[i] {
        return;
    }
    seen[i] = true;
    if let Some(node) = snapshot.spatial[i].as_ref() {
        if let Some(parent) = node.parent {
            push_topo(parent.index, snapshot, seen, out);
        }
        if let SpatialKind::Fixed { containing_block } = node.kind {
            push_topo(containing_block.index, snapshot, seen, out);
        }
    }
    out.push(index);
}

fn is_ancestor(snapshot: &PropertySnapshot, start: u32, ancestor: u32) -> bool {
    let mut current = Some(start);
    let mut guard = 0usize;
    while let Some(index) = current {
        if index == ancestor {
            return true;
        }
        if guard > snapshot.spatial.len() {
            return false;
        }
        guard += 1;
        current = snapshot.spatial[index as usize]
            .as_ref()
            .and_then(|node| node.parent)
            .map(|id| id.index);
    }
    false
}

fn check_spatial_refs(snapshot: &PropertySnapshot) -> Result<(), TreeError> {
    for node in snapshot.spatial.iter().flatten() {
        if let Some(parent) = node.parent {
            match snapshot.spatial(parent) {
                Some(_) => {}
                None if snapshot.spatial.get(parent.index as usize).is_some() => {
                    return Err(TreeError::StaleParent);
                }
                None => return Err(TreeError::MissingParent),
            }
        }
        match node.kind {
            SpatialKind::Scroll { scroll_id, .. } | SpatialKind::Sticky { scroll_id, .. } => {
                if !snapshot.scroll_is_live(scroll_id) {
                    return Err(
                        if snapshot.scrolls.get(scroll_id.index as usize).is_some() {
                            TreeError::StaleScroll
                        } else {
                            TreeError::MissingScroll
                        },
                    );
                }
            }
            SpatialKind::Fixed { containing_block } => {
                if snapshot.spatial(containing_block).is_none() {
                    return Err(
                        if snapshot
                            .spatial
                            .get(containing_block.index as usize)
                            .is_some()
                        {
                            TreeError::StaleContainingBlock
                        } else {
                            TreeError::MissingContainingBlock
                        },
                    );
                }
            }
            SpatialKind::ReferenceFrame => {}
        }
    }
    Ok(())
}

fn check_clip_refs(snapshot: &PropertySnapshot) -> Result<(), TreeError> {
    for node in snapshot.clips.iter().flatten() {
        if let Some(parent) = node.parent {
            match snapshot.clip(parent) {
                Some(_) => {}
                None if snapshot.clips.get(parent.index as usize).is_some() => {
                    return Err(TreeError::StaleClip);
                }
                None => return Err(TreeError::MissingClipParent),
            }
        }
        match snapshot.spatial(node.spatial) {
            Some(_) => {}
            None if snapshot.spatial.get(node.spatial.index as usize).is_some() => {
                return Err(TreeError::StaleClipSpatial);
            }
            None => return Err(TreeError::MissingClipSpatial),
        }
    }
    Ok(())
}

fn check_effect_refs(snapshot: &PropertySnapshot) -> Result<(), TreeError> {
    for node in snapshot.effects.iter().flatten() {
        if let Some(parent) = node.parent {
            match snapshot.effect(parent) {
                Some(_) => {}
                None if snapshot.effects.get(parent.index as usize).is_some() => {
                    return Err(TreeError::StaleEffect);
                }
                None => return Err(TreeError::MissingEffectParent),
            }
        }
        match snapshot.spatial(node.spatial) {
            Some(_) => {}
            None if snapshot.spatial.get(node.spatial.index as usize).is_some() => {
                return Err(TreeError::StaleEffectSpatial);
            }
            None => return Err(TreeError::MissingEffectSpatial),
        }
        match snapshot.clip(node.clip) {
            Some(_) => {}
            None if snapshot.clips.get(node.clip.index as usize).is_some() => {
                return Err(TreeError::StaleEffectClip);
            }
            None => return Err(TreeError::MissingEffectClip),
        }
        if !snapshot.backdrop_roots.contains(&node.backdrop_root) {
            return Err(TreeError::MissingBackdropRoot);
        }
    }
    Ok(())
}

fn check_cycles<T>(
    slots: &[Option<T>],
    parent_of: impl Fn(&T) -> Option<u32>,
    on_cycle: TreeError,
) -> Result<(), TreeError> {
    let mut color = vec![0u8; slots.len()];
    for i in 0..slots.len() {
        if slots[i].is_none() || color[i] != 0 {
            continue;
        }
        let mut stack = vec![i];
        color[i] = 1;
        while let Some(node) = stack.last().copied() {
            let parent = slots[node].as_ref().and_then(&parent_of);
            if let Some(p) = parent {
                let p = p as usize;
                if p >= slots.len() || slots[p].is_none() {
                    stack.pop();
                    color[node] = 2;
                    continue;
                }
                match color[p] {
                    1 => return Err(on_cycle),
                    0 => {
                        color[p] = 1;
                        stack.push(p);
                        continue;
                    }
                    _ => {}
                }
            }
            stack.pop();
            color[node] = 2;
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &PropertySnapshot) -> Result<(), TreeError> {
    check_spatial_refs(snapshot)?;
    check_cycles(
        &snapshot.spatial,
        |node| node.parent.map(|id| id.index),
        TreeError::Cycle,
    )?;
    check_clip_refs(snapshot)?;
    check_cycles(
        &snapshot.clips,
        |node| node.parent.map(|id| id.index),
        TreeError::ClipCycle,
    )?;
    check_effect_refs(snapshot)?;
    check_cycles(
        &snapshot.effects,
        |node| node.parent.map(|id| id.index),
        TreeError::EffectCycle,
    )?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleError {
    EpochMismatch,
    StaleHandle,
    MissingHandle,
}

/// Preallocated present/hit-test sample of one [`PropertySnapshot`].
///
/// [`SampledFrame::bind`] may allocate. [`SampledFrame::set_scroll_offset`]
/// and [`hit_test`] only index the bound buffers.
#[derive(Clone, Debug)]
pub struct SampledFrame {
    scene_epoch: SceneEpoch,
    worlds: Vec<AffineCoeffs>,
    inverses: Vec<Option<AffineCoeffs>>,
    hittable: Vec<bool>,
    constraint_stale: Vec<bool>,
    scroll_offsets: Vec<Vec2>,
    anim_local: Vec<AffineCoeffs>,
    dirty: Vec<bool>,
    nodes_recomputed: u32,
    resample_deferred: bool,
}

impl SampledFrame {
    pub fn bind(snapshot: &PropertySnapshot) -> Self {
        let n = snapshot.spatial.len();
        let mut sampled = Self {
            scene_epoch: snapshot.scene_epoch,
            worlds: vec![AffineCoeffs::IDENTITY; n],
            inverses: vec![None; n],
            hittable: vec![false; n],
            constraint_stale: vec![false; n],
            scroll_offsets: vec![Vec2::default(); snapshot.scrolls.len()],
            anim_local: vec![AffineCoeffs::IDENTITY; n],
            dirty: vec![true; n],
            nodes_recomputed: 0,
            resample_deferred: false,
        };
        sampled.resample(snapshot);
        sampled
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn nodes_recomputed(&self) -> u32 {
        self.nodes_recomputed
    }

    pub fn worlds_ptr(&self) -> *const AffineCoeffs {
        self.worlds.as_ptr()
    }

    pub fn worlds_capacity(&self) -> usize {
        self.worlds.capacity()
    }

    pub fn world(&self, snapshot: &PropertySnapshot, id: SpatialId) -> Option<AffineCoeffs> {
        self.check_epoch(snapshot).ok()?;
        let _ = snapshot.spatial(id)?;
        Some(self.worlds[id.index as usize])
    }

    pub fn hittable(&self, snapshot: &PropertySnapshot, id: SpatialId) -> bool {
        if self.check_epoch(snapshot).is_err() {
            return false;
        }
        if snapshot.spatial(id).is_none() {
            return false;
        }
        self.hittable[id.index as usize]
    }

    pub fn inverse(&self, snapshot: &PropertySnapshot, id: SpatialId) -> Option<AffineCoeffs> {
        self.check_epoch(snapshot).ok()?;
        let _ = snapshot.spatial(id)?;
        self.inverses[id.index as usize]
    }

    pub fn constraint_stale(&self, snapshot: &PropertySnapshot, id: SpatialId) -> bool {
        if self.check_epoch(snapshot).is_err() || snapshot.spatial(id).is_none() {
            return false;
        }
        self.constraint_stale[id.index as usize]
    }

    pub fn scroll_offset(&self, snapshot: &PropertySnapshot, id: ScrollId) -> Option<Vec2> {
        self.check_epoch(snapshot).ok()?;
        if !snapshot.scroll_is_live(id) {
            return None;
        }
        Some(self.scroll_offsets[id.index as usize])
    }

    pub fn set_scroll_offset(
        &mut self,
        snapshot: &PropertySnapshot,
        id: ScrollId,
        offset: Vec2,
    ) -> Result<(), SampleError> {
        self.check_epoch(snapshot)?;
        if snapshot.scrolls.get(id.index as usize).is_none() {
            return Err(SampleError::MissingHandle);
        }
        if !snapshot.scroll_is_live(id) {
            return Err(SampleError::StaleHandle);
        }
        let slot = id.index as usize;
        if self.scroll_offsets[slot] == offset {
            self.nodes_recomputed = 0;
            return Ok(());
        }
        self.scroll_offsets[slot] = offset;
        if let Some(spatial) = snapshot.scroll_spatial[slot] {
            self.mark_subtree(snapshot, spatial);
        }
        self.maybe_resample(snapshot);
        Ok(())
    }

    /// Extra local transform sampled from a compositor animation. Identity is
    /// the rest pose. Present-loop safe: no allocation.
    pub fn set_anim_local(
        &mut self,
        snapshot: &PropertySnapshot,
        id: SpatialId,
        transform: AffineCoeffs,
    ) -> Result<(), SampleError> {
        self.check_epoch(snapshot)?;
        let _ = snapshot.spatial(id).ok_or(SampleError::StaleHandle)?;
        let slot = id.index as usize;
        if self.anim_local[slot] == transform {
            self.nodes_recomputed = 0;
            return Ok(());
        }
        self.anim_local[slot] = transform;
        self.mark_subtree(snapshot, id.index);
        self.maybe_resample(snapshot);
        Ok(())
    }

    /// Batch scroll/animation writes and resample once. Bind/present uses this
    /// so the hot path does not allocate.
    pub fn defer_resample(&mut self, snapshot: &PropertySnapshot, defer: bool) {
        let was = self.resample_deferred;
        self.resample_deferred = defer;
        if was && !defer {
            self.resample(snapshot);
        }
    }

    fn maybe_resample(&mut self, snapshot: &PropertySnapshot) {
        if !self.resample_deferred {
            self.resample(snapshot);
        }
    }

    fn check_epoch(&self, snapshot: &PropertySnapshot) -> Result<(), SampleError> {
        if self.scene_epoch != snapshot.scene_epoch {
            Err(SampleError::EpochMismatch)
        } else {
            Ok(())
        }
    }

    fn mark_subtree(&mut self, snapshot: &PropertySnapshot, index: u32) {
        let i = index as usize;
        if i >= self.dirty.len() || self.dirty[i] {
            return;
        }
        self.dirty[i] = true;
        for &child in snapshot.children(index) {
            self.mark_subtree(snapshot, child);
        }
    }

    fn resample(&mut self, snapshot: &PropertySnapshot) {
        self.nodes_recomputed = 0;
        for &index in snapshot.spatial_topo.iter() {
            let i = index as usize;
            if !self.dirty[i] {
                continue;
            }
            if snapshot.spatial[i].is_none() {
                self.dirty[i] = false;
                continue;
            }
            self.sample_node(snapshot, index);
            self.nodes_recomputed += 1;
            self.dirty[i] = false;
        }
    }

    fn sample_node(&mut self, snapshot: &PropertySnapshot, index: u32) {
        let i = index as usize;
        let node = snapshot.spatial[i].as_ref().expect("topo live node");
        let local = self.local_transform(node);
        let parent_world = match node.kind {
            SpatialKind::Fixed { containing_block } => self.worlds[containing_block.index as usize],
            _ => node
                .parent
                .map(|parent| self.worlds[parent.index as usize])
                .unwrap_or(AffineCoeffs::IDENTITY),
        };
        let world = parent_world.compose(local);
        self.worlds[i] = world;
        let inverse = world.inverse();
        self.hittable[i] = inverse.is_some();
        self.inverses[i] = inverse;
        self.constraint_stale[i] = matches!(
            node.kind,
            SpatialKind::Sticky {
                valid_scroll_range, ..
            } if !self.sticky_scroll(node).map(|offset| valid_scroll_range.contains(offset)).unwrap_or(true)
        );
    }

    fn sticky_scroll(&self, node: &SpatialTreeNode) -> Option<Vec2> {
        match node.kind {
            SpatialKind::Sticky { scroll_id, .. } => {
                Some(self.scroll_offsets[scroll_id.index as usize])
            }
            _ => None,
        }
    }

    fn local_transform(&self, node: &SpatialTreeNode) -> AffineCoeffs {
        let anim = self.anim_local[node.id.index as usize];
        let producer = node.producer_transform.compose(anim);
        match node.kind {
            SpatialKind::ReferenceFrame | SpatialKind::Fixed { .. } => producer,
            SpatialKind::Scroll { scroll_id, .. } => {
                let offset = self.scroll_offsets[scroll_id.index as usize];
                producer.compose(AffineCoeffs::translate(-offset.x, -offset.y))
            }
            SpatialKind::Sticky {
                scroll_id,
                normal_origin,
                constraint_rect,
                insets,
                valid_scroll_range,
                size,
            } => {
                let actual = self.scroll_offsets[scroll_id.index as usize];
                let used = if valid_scroll_range.contains(actual) {
                    actual
                } else {
                    valid_scroll_range.clamp(actual)
                };
                let extra = sticky_extra(used, normal_origin, constraint_rect, insets, size);
                let compensate = Vec2::new(actual.x - used.x, actual.y - used.y);
                producer
                    .compose(AffineCoeffs::translate(normal_origin.x, normal_origin.y))
                    .compose(AffineCoeffs::translate(
                        extra.x + compensate.x,
                        extra.y + compensate.y,
                    ))
            }
        }
    }
}

fn sticky_extra(
    scroll: Vec2,
    origin: Point,
    constraint: LogicalRect,
    insets: Insets,
    size: Size,
) -> Vec2 {
    let visual_x = origin.x - scroll.x;
    let visual_y = origin.y - scroll.y;
    let min_x = constraint.x + insets.left;
    let min_y = constraint.y + insets.top;
    let max_x = (constraint.x + constraint.width - insets.right - size.width).max(min_x);
    let max_y = (constraint.y + constraint.height - insets.bottom - size.height).max(min_y);
    Vec2::new(
        visual_x.clamp(min_x, max_x) - visual_x,
        visual_y.clamp(min_y, max_y) - visual_y,
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitTestItem {
    pub local_bounds: LogicalRect,
    pub spatial: SpatialId,
    pub clip: ClipId,
    pub paint_order: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HitTestMatch {
    pub paint_order: u32,
    pub spatial: SpatialId,
}

/// Front-to-back hit-test against a single snapshot/epoch sample.
/// `items` must already be paint-order descending. No allocation.
pub fn hit_test(
    snapshot: &PropertySnapshot,
    sampled: &SampledFrame,
    items: &[HitTestItem],
    x: f64,
    y: f64,
) -> Result<Option<HitTestMatch>, SampleError> {
    sampled.check_epoch(snapshot)?;
    for item in items {
        if item_hits(snapshot, sampled, item, x, y) {
            return Ok(Some(HitTestMatch {
                paint_order: item.paint_order,
                spatial: item.spatial,
            }));
        }
    }
    Ok(None)
}

fn item_hits(
    snapshot: &PropertySnapshot,
    sampled: &SampledFrame,
    item: &HitTestItem,
    x: f64,
    y: f64,
) -> bool {
    if !sampled.hittable(snapshot, item.spatial) {
        return false;
    }
    let Some(inverse) = sampled.inverse(snapshot, item.spatial) else {
        return false;
    };
    let (lx, ly) = inverse.transform_point(x, y);
    if !item.local_bounds.contains(lx, ly) {
        return false;
    }
    point_in_clip_chain(snapshot, sampled, item.clip, x, y)
}

fn point_in_clip_chain(
    snapshot: &PropertySnapshot,
    sampled: &SampledFrame,
    clip: ClipId,
    x: f64,
    y: f64,
) -> bool {
    let mut current = Some(clip);
    let mut guard = 0usize;
    while let Some(id) = current {
        if guard > snapshot.clips.len() {
            return false;
        }
        guard += 1;
        let Some(node) = snapshot.clip(id) else {
            return false;
        };
        if !sampled.hittable(snapshot, node.spatial) {
            return false;
        }
        let Some(inverse) = sampled.inverse(snapshot, node.spatial) else {
            return false;
        };
        let (lx, ly) = inverse.transform_point(x, y);
        if !node.rect.contains(lx, ly) {
            return false;
        }
        current = node.parent;
    }
    true
}
