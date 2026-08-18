//! Compositor scroll and animation fast paths (RFC §15, §17).
//!
//! Owned by the compositor thread. The present loop samples monotonic time
//! into the bound [`SampledFrame`] without locking the UI mailbox, allocating,
//! rasterizing, or calling Dioxus/layout.

use std::sync::Arc;
use std::time::Duration;

use crate::animation::{
    AnimValue, AnimationId, AnimationProperty, AnimationSpec, AnimationTable, FastPathError,
};
use crate::display_list::AffineCoeffs;
use crate::epoch::{PresentationTime, SceneEpoch};
use crate::hit_dispatch::{HitTestSnapshot, PointerCapture};
use crate::property_tree::{
    PropertyEffectKind, PropertySnapshot, SampledFrame, ScrollId, SpatialId, Vec2,
};
use crate::scroll::{
    AckResult, AsyncScrollState, GestureId, ScrollAck, ScrollInputError, ScrollSequence,
    ScrollTable,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RasterDecision {
    /// Transform/opacity/scroll composite. Display-list pixels stay valid.
    CompositeOnly,
    /// Selection underlay, caret, and handles only. Glyph and background
    /// rasters stay valid; shaping and layout are not re-run.
    SelectionOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresentOutcome {
    pub raster: RasterDecision,
    pub scene_epoch: SceneEpoch,
}

/// Compositor-thread fast path. Bind may allocate; [`Self::present`] must not.
#[derive(Clone, Debug, Default)]
pub struct CompositorFastPath {
    pub(crate) snapshot: Option<Arc<PropertySnapshot>>,
    pub(crate) sampled: Option<SampledFrame>,
    pub(crate) scrolls: ScrollTable,
    animations: AnimationTable,
    translations: Vec<Vec2>,
    opacities: Vec<f32>,
    producer_requests: u64,
    raster_invalidations: u64,
    pub(crate) hits: Option<Arc<HitTestSnapshot>>,
    pub(crate) capture: Option<PointerCapture>,
    pub(crate) next_input_seq: u64,
    pub(crate) text: Option<Arc<crate::text::TextSnapshotSet>>,
    pub(crate) geometry: Option<Arc<crate::geometry_tiles::GeometryTileSnapshot>>,
}

impl CompositorFastPath {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind_snapshot(&mut self, snapshot: Arc<PropertySnapshot>) {
        self.scrolls.bind(&snapshot);
        let spatial_n = snapshot.spatial_slot_count();
        let effect_n = snapshot.effect_slot_count();
        self.translations.resize(spatial_n, Vec2::default());
        self.opacities.resize(effect_n, 1.0);
        for i in 0..effect_n {
            if let Some(node) = snapshot.effect_at(i as u32) {
                self.opacities[i] = match node.kind {
                    PropertyEffectKind::Opacity(alpha) => alpha,
                    _ => 1.0,
                };
            }
        }
        self.sampled = Some(SampledFrame::bind(&snapshot));
        self.snapshot = Some(snapshot);
    }

    pub fn snapshot(&self) -> Option<&PropertySnapshot> {
        self.snapshot.as_deref()
    }

    pub fn sampled(&self) -> Option<&SampledFrame> {
        self.sampled.as_ref()
    }

    pub fn producer_requests(&self) -> u64 {
        self.producer_requests
    }

    pub fn raster_invalidations(&self) -> u64 {
        self.raster_invalidations
    }

    pub fn visual_offset(&self, id: ScrollId) -> Option<Vec2> {
        self.scrolls.visual_offset(id)
    }

    pub fn scroll_state(&self, id: ScrollId) -> Option<&AsyncScrollState> {
        self.scrolls.state(id)
    }

    pub fn latched_scroll(&self) -> Option<ScrollId> {
        self.scrolls.latched_scroll()
    }

    pub fn opacity(&self, id: crate::EffectId) -> Option<f32> {
        self.opacities.get(id.index() as usize).copied()
    }

    pub fn translation(&self, id: SpatialId) -> Option<Vec2> {
        self.translations.get(id.index() as usize).copied()
    }

    pub fn ack(&mut self, ack: ScrollAck) -> AckResult {
        self.scrolls.ack(ack)
    }

    pub fn nudge(
        &mut self,
        id: ScrollId,
        delta: Vec2,
        seq: ScrollSequence,
        time: PresentationTime,
    ) -> Result<Vec2, ScrollInputError> {
        self.scrolls.nudge(id, delta, seq, time)
    }

    pub fn begin_gesture(
        &mut self,
        gesture: GestureId,
        chain: &[ScrollId],
    ) -> Result<ScrollId, ScrollInputError> {
        self.scrolls.begin_gesture(gesture, chain)
    }

    pub fn stamp_input_time(
        &mut self,
        id: ScrollId,
        time: PresentationTime,
    ) -> Result<(), ScrollInputError> {
        self.scrolls.stamp_input_time(id, time)
    }

    pub fn end_gesture(&mut self, gesture: GestureId) {
        self.scrolls.end_gesture(gesture);
    }

    pub fn gesture_delta(
        &mut self,
        gesture: GestureId,
        delta: Vec2,
        seq: ScrollSequence,
        time: PresentationTime,
    ) -> Result<ScrollId, ScrollInputError> {
        self.scrolls.gesture_delta(gesture, delta, seq, time)
    }

    pub fn start_animation(
        &mut self,
        spec: AnimationSpec,
        now: PresentationTime,
    ) -> Result<AnimationId, FastPathError> {
        if !spec.property.compositor_sampleable() {
            self.producer_requests = self.producer_requests.saturating_add(1);
            return Err(FastPathError::NeedsProducer);
        }
        let current = self.current_value(spec.property);
        self.animations.start(spec, now, current)
    }

    pub fn retarget_animation(
        &mut self,
        id: AnimationId,
        to: AnimValue,
        duration: Duration,
        now: PresentationTime,
    ) -> Result<AnimValue, FastPathError> {
        match self.animations.retarget(id, to, duration, now) {
            Err(FastPathError::NeedsProducer) => {
                self.producer_requests = self.producer_requests.saturating_add(1);
                Err(FastPathError::NeedsProducer)
            }
            other => other,
        }
    }

    pub fn animation_value(&self, id: AnimationId, now: PresentationTime) -> Option<AnimValue> {
        self.animations.sample(id, now)
    }

    /// Sample scroll + animation into the bound frame. No allocation, no
    /// mailbox lock, no producer callback, no raster invalidation.
    pub fn present(&mut self, time: PresentationTime) -> PresentOutcome {
        let Some(snapshot) = self.snapshot.clone() else {
            return PresentOutcome {
                raster: RasterDecision::CompositeOnly,
                scene_epoch: SceneEpoch(0),
            };
        };
        let Some(sampled) = self.sampled.as_mut() else {
            return PresentOutcome {
                raster: RasterDecision::CompositeOnly,
                scene_epoch: snapshot.scene_epoch(),
            };
        };
        sampled.defer_resample(&snapshot, true);
        {
            let translations = &mut self.translations;
            let opacities = &mut self.opacities;
            self.animations
                .for_each_sampled(time, |_, property, value| match (property, value) {
                    (AnimationProperty::Translation(spatial), AnimValue::Translation(offset)) => {
                        if let Some(slot) = translations.get_mut(spatial.index() as usize) {
                            *slot = offset;
                        }
                        let _ = sampled.set_anim_local(
                            &snapshot,
                            spatial,
                            AffineCoeffs::translate(offset.x, offset.y),
                        );
                    }
                    (AnimationProperty::Opacity(effect), AnimValue::Opacity(alpha)) => {
                        if let Some(slot) = opacities.get_mut(effect.index() as usize) {
                            *slot = alpha;
                        }
                    }
                    _ => {}
                });
        }
        for i in 0..snapshot.scroll_slot_count() {
            if let Some(id) = snapshot.scroll_at(i as u32) {
                if let Some(offset) = self.scrolls.visual_offset(id) {
                    let _ = sampled.set_scroll_offset(&snapshot, id, offset);
                }
            }
        }
        sampled.defer_resample(&snapshot, false);
        PresentOutcome {
            raster: RasterDecision::CompositeOnly,
            scene_epoch: snapshot.scene_epoch(),
        }
    }

    fn current_value(&self, property: AnimationProperty) -> Option<AnimValue> {
        match property {
            AnimationProperty::Translation(id) => self
                .translations
                .get(id.index() as usize)
                .copied()
                .map(AnimValue::Translation),
            AnimationProperty::Opacity(id) => self
                .opacities
                .get(id.index() as usize)
                .copied()
                .map(AnimValue::Opacity),
            _ => None,
        }
    }
}
