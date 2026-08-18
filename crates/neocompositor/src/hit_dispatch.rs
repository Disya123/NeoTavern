//! Async hit-test and nested-scroll pointer dispatch (RFC §23.1, PERF-14/17/21).
//!
//! [`HitTestSnapshot`] is bound to the same [`SceneEpoch`] / [`PropertySnapshot`]
//! as render. The query path uses the already sampled compositor transforms
//! (sticky/fixed/async scroll) and never applies a global inverse or waits on
//! Dioxus/layout.

use std::sync::Arc;

use crate::epoch::{PresentationTime, SceneEpoch};
use crate::fast_path::CompositorFastPath;
use crate::property_tree::{
    hit_test, HitTestItem, Point, PropertySnapshot, SampledFrame, ScrollId, SpatialId,
    StableSemanticId, TreeError, Vec2,
};
use crate::scroll::{GestureId, ScrollInputError, ScrollSequence, MAX_SCROLL_CHAIN};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct PointerId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerKind {
    Down,
    Move,
    Up,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchError {
    StaleEpoch,
    MissingSnapshot,
    Scroll(ScrollInputError),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerEvent {
    pub kind: PointerKind,
    pub pointer: PointerId,
    pub target: Option<StableSemanticId>,
    pub generation: u64,
    pub screen: Point,
    pub local: Option<Point>,
    pub scene_epoch: SceneEpoch,
    pub scroll_id: Option<ScrollId>,
    pub scroll_sequence: ScrollSequence,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HitTestSnapshot {
    scene_epoch: SceneEpoch,
    items: Arc<[HitTestItem]>,
}

impl HitTestSnapshot {
    /// Sorts items front-to-back (highest [`HitTestItem::paint_order`] first).
    pub fn commit(scene_epoch: SceneEpoch, mut items: Vec<HitTestItem>) -> Self {
        items.sort_by_key(|item| std::cmp::Reverse(item.paint_order));
        Self {
            scene_epoch,
            items: items.into(),
        }
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn items(&self) -> &[HitTestItem] {
        &self.items
    }

    pub fn live(&self, target: StableSemanticId, generation: u64) -> Option<&HitTestItem> {
        self.items
            .iter()
            .find(|item| item.target == target && item.generation == generation)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PointerCapture {
    pointer: PointerId,
    gesture: GestureId,
    target: StableSemanticId,
    generation: u64,
    spatial: SpatialId,
    last_screen: Point,
    scroll_id: Option<ScrollId>,
    latched: bool,
}

impl CompositorFastPath {
    pub fn bind_hit_test(&mut self, hits: Arc<HitTestSnapshot>) -> Result<(), DispatchError> {
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        if snapshot.scene_epoch() != hits.scene_epoch() {
            return Err(DispatchError::StaleEpoch);
        }
        self.hits = Some(hits);
        Ok(())
    }

    pub fn bind_text(
        &mut self,
        text: Arc<crate::text::TextSnapshotSet>,
    ) -> Result<(), DispatchError> {
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        if snapshot.scene_epoch() != text.scene_epoch() {
            return Err(DispatchError::StaleEpoch);
        }
        self.text = Some(text);
        Ok(())
    }

    pub fn bind_geometry(
        &mut self,
        geometry: Arc<crate::geometry_tiles::GeometryTileSnapshot>,
    ) -> Result<(), DispatchError> {
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        if snapshot.scene_epoch() != geometry.scene_epoch() {
            return Err(DispatchError::StaleEpoch);
        }
        self.geometry = Some(geometry);
        Ok(())
    }

    pub fn text_snapshot(&self) -> Option<&crate::text::TextSnapshotSet> {
        self.text.as_deref()
    }

    pub fn geometry_snapshot(&self) -> Option<&crate::geometry_tiles::GeometryTileSnapshot> {
        self.geometry.as_deref()
    }

    pub fn hit_snapshot(&self) -> Option<&HitTestSnapshot> {
        self.hits.as_deref()
    }

    pub fn captured_target(&self) -> Option<StableSemanticId> {
        self.capture.map(|capture| capture.target)
    }

    pub fn pointer_down(
        &mut self,
        pointer: PointerId,
        screen: Point,
        time: PresentationTime,
    ) -> Result<PointerEvent, DispatchError> {
        self.present(time);
        self.ensure_epochs()?;
        if let Some(capture) = self.capture {
            if capture.pointer == pointer {
                self.end_gesture(capture.gesture);
            }
        }
        self.capture = None;
        let snapshot = self.property()?;
        let sampled = self
            .sampled
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        let hits = self.hits.as_ref().ok_or(DispatchError::MissingSnapshot)?;
        let hit = hit_test(snapshot, sampled, hits.items(), screen.x, screen.y)
            .map_err(|_| DispatchError::StaleEpoch)?;
        let Some(hit) = hit else {
            return Ok(self.event(PointerKind::Down, pointer, screen, None, None, None, 0));
        };
        let item = hits
            .items()
            .iter()
            .find(|item| item.id == hit.id)
            .copied()
            .ok_or(DispatchError::MissingSnapshot)?;
        let gesture = GestureId(pointer.0);
        let mut chain = [ScrollId::unbound(0); MAX_SCROLL_CHAIN];
        let n = snapshot
            .copy_scroll_chain(item.spatial, &mut chain)
            .map_err(|err| match err {
                TreeError::BufferTooSmall => DispatchError::Scroll(ScrollInputError::ChainTooLong),
                _ => DispatchError::StaleEpoch,
            })?;
        let (latched, scroll_id) = if n > 0 {
            let latched_id = self
                .begin_gesture(gesture, &chain[..n])
                .map_err(DispatchError::Scroll)?;
            (true, Some(latched_id))
        } else {
            (false, item.scroll_target)
        };
        self.capture = Some(PointerCapture {
            pointer,
            gesture,
            target: item.target,
            generation: item.generation,
            spatial: item.spatial,
            last_screen: screen,
            scroll_id,
            latched,
        });
        Ok(self.event(
            PointerKind::Down,
            pointer,
            screen,
            Some(item.target),
            Some(hit.local),
            scroll_id,
            item.generation,
        ))
    }

    pub fn pointer_move(
        &mut self,
        pointer: PointerId,
        screen: Point,
        time: PresentationTime,
    ) -> Result<PointerEvent, DispatchError> {
        let Some(mut capture) = self.capture.filter(|capture| capture.pointer == pointer) else {
            self.present(time);
            return Ok(self.event(PointerKind::Move, pointer, screen, None, None, None, 0));
        };
        if self.ensure_epochs().is_err() || !self.target_still_live(capture) {
            return self.cancel_pointer(pointer, screen, time);
        }
        let delta = Vec2::new(
            capture.last_screen.x - screen.x,
            capture.last_screen.y - screen.y,
        );
        if capture.latched && !delta.is_zero() {
            self.next_input_seq = self
                .next_input_seq
                .max(self.scrolls.max_applied_seq())
                .saturating_add(1);
            let seq = ScrollSequence(self.next_input_seq);
            capture.scroll_id = Some(
                self.gesture_delta(capture.gesture, delta, seq, time)
                    .map_err(DispatchError::Scroll)?,
            );
        }
        capture.last_screen = screen;
        self.capture = Some(capture);
        self.present(time);
        if !self.target_still_live(capture) {
            return self.cancel_pointer(pointer, screen, time);
        }
        let local = self.local_of(capture.spatial, screen)?;
        Ok(self.event(
            PointerKind::Move,
            pointer,
            screen,
            Some(capture.target),
            local,
            capture.scroll_id,
            capture.generation,
        ))
    }

    pub fn pointer_up(
        &mut self,
        pointer: PointerId,
        screen: Point,
        time: PresentationTime,
    ) -> Result<PointerEvent, DispatchError> {
        let Some(capture) = self.capture.filter(|capture| capture.pointer == pointer) else {
            self.present(time);
            return Ok(self.event(PointerKind::Up, pointer, screen, None, None, None, 0));
        };
        if self.ensure_epochs().is_err() || !self.target_still_live(capture) {
            return self.cancel_pointer(pointer, screen, time);
        }
        self.present(time);
        if self.ensure_epochs().is_err() || !self.target_still_live(capture) {
            return self.cancel_pointer(pointer, screen, time);
        }
        let local = self.local_of(capture.spatial, screen)?;
        self.end_gesture(capture.gesture);
        self.capture = None;
        Ok(self.event(
            PointerKind::Up,
            pointer,
            screen,
            Some(capture.target),
            local,
            capture.scroll_id,
            capture.generation,
        ))
    }

    fn cancel_pointer(
        &mut self,
        pointer: PointerId,
        screen: Point,
        time: PresentationTime,
    ) -> Result<PointerEvent, DispatchError> {
        let capture = self.capture.take();
        if let Some(capture) = capture {
            self.end_gesture(capture.gesture);
            self.present(time);
            return Ok(self.event(
                PointerKind::Cancel,
                pointer,
                screen,
                Some(capture.target),
                None,
                capture.scroll_id,
                capture.generation,
            ));
        }
        self.present(time);
        Ok(self.event(PointerKind::Cancel, pointer, screen, None, None, None, 0))
    }

    fn target_still_live(&self, capture: PointerCapture) -> bool {
        self.hits
            .as_ref()
            .and_then(|hits| hits.live(capture.target, capture.generation))
            .is_some()
    }

    fn local_of(&self, spatial: SpatialId, screen: Point) -> Result<Option<Point>, DispatchError> {
        let snapshot = self.property()?;
        let sampled = self
            .sampled
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        sampled
            .check_epoch(snapshot)
            .map_err(|_| DispatchError::StaleEpoch)?;
        Ok(sampled.inverse(snapshot, spatial).map(|inverse| {
            let (x, y) = inverse.transform_point(screen.x, screen.y);
            Point::new(x, y)
        }))
    }

    fn ensure_epochs(&self) -> Result<(), DispatchError> {
        let snapshot = self.property()?;
        let sampled = self
            .sampled
            .as_ref()
            .ok_or(DispatchError::MissingSnapshot)?;
        let hits = self.hits.as_ref().ok_or(DispatchError::MissingSnapshot)?;
        if snapshot.scene_epoch() != sampled.scene_epoch()
            || snapshot.scene_epoch() != hits.scene_epoch()
        {
            return Err(DispatchError::StaleEpoch);
        }
        if let Some(text) = self.text.as_ref() {
            if text.scene_epoch() != snapshot.scene_epoch() {
                return Err(DispatchError::StaleEpoch);
            }
        }
        if let Some(geometry) = self.geometry.as_ref() {
            if geometry.scene_epoch() != snapshot.scene_epoch() {
                return Err(DispatchError::StaleEpoch);
            }
        }
        Ok(())
    }

    fn property(&self) -> Result<&PropertySnapshot, DispatchError> {
        self.snapshot
            .as_deref()
            .ok_or(DispatchError::MissingSnapshot)
    }

    #[allow(clippy::too_many_arguments)]
    fn event(
        &self,
        kind: PointerKind,
        pointer: PointerId,
        screen: Point,
        target: Option<StableSemanticId>,
        local: Option<Point>,
        scroll_id: Option<ScrollId>,
        generation: u64,
    ) -> PointerEvent {
        let scene_epoch = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.scene_epoch())
            .unwrap_or(SceneEpoch(0));
        let scroll_sequence = scroll_id
            .and_then(|id| self.scrolls.state(id))
            .map(|state| state.applied_input_seq)
            .unwrap_or(ScrollSequence(0));
        PointerEvent {
            kind,
            pointer,
            target,
            generation,
            screen,
            local,
            scene_epoch,
            scroll_id,
            scroll_sequence,
        }
    }
}

pub fn hit_test_front_to_back(
    snapshot: &PropertySnapshot,
    sampled: &SampledFrame,
    hits: &HitTestSnapshot,
    x: f64,
    y: f64,
) -> Result<Option<crate::HitTestMatch>, crate::SampleError> {
    hit_test(snapshot, sampled, hits.items(), x, y)
}
