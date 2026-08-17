//! Compositor-thread transform/opacity animation (RFC §17).
//!
//! Sampling uses monotonic [`PresentationTime`]. Duration does not depend on
//! refresh rate. Layout/paint/text properties cannot be sampled here.

use std::time::Duration;

use crate::epoch::PresentationTime;
use crate::property_tree::{EffectId, SpatialId, Vec2};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct AnimationId {
    index: u32,
    generation: u64,
}

impl AnimationId {
    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FastPathError {
    NeedsProducer,
    StaleHandle,
    MissingHandle,
}

/// Properties the compositor can sample locally, plus the ones that must
/// return to layout/paint/text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnimationProperty {
    Translation(SpatialId),
    Opacity(EffectId),
    Width,
    Height,
    Color,
    FontSize,
    GlyphOffset,
}

impl AnimationProperty {
    pub fn compositor_sampleable(self) -> bool {
        matches!(self, Self::Translation(_) | Self::Opacity(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AnimValue {
    Translation(Vec2),
    Opacity(f32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Easing {
    Linear,
}

impl Easing {
    fn apply(self, t: f64) -> f64 {
        match self {
            Self::Linear => t.clamp(0.0, 1.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnimationSpec {
    pub property: AnimationProperty,
    pub from: Option<AnimValue>,
    pub to: AnimValue,
    pub duration: Duration,
    pub easing: Easing,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AnimationSlot {
    id: AnimationId,
    property: AnimationProperty,
    from: AnimValue,
    to: AnimValue,
    start: PresentationTime,
    duration_ns: u64,
    easing: Easing,
}

#[derive(Clone, Debug, Default)]
pub struct AnimationTable {
    slots: Vec<Option<AnimationSlot>>,
}

impl AnimationTable {
    pub fn start(
        &mut self,
        spec: AnimationSpec,
        now: PresentationTime,
        current: Option<AnimValue>,
    ) -> Result<AnimationId, FastPathError> {
        if !spec.property.compositor_sampleable() {
            return Err(FastPathError::NeedsProducer);
        }
        let from = match spec.from.or(current) {
            Some(value) if values_match(spec.property, value, spec.to) => value,
            Some(_) => return Err(FastPathError::NeedsProducer),
            None => rest_value(spec.property),
        };
        if !values_match(spec.property, from, spec.to) {
            return Err(FastPathError::NeedsProducer);
        }
        let slot = AnimationSlot {
            id: AnimationId {
                index: 0,
                generation: 1,
            },
            property: spec.property,
            from,
            to: spec.to,
            start: now,
            duration_ns: nanos(spec.duration),
            easing: spec.easing,
        };
        Ok(self.insert(slot))
    }

    pub fn retarget(
        &mut self,
        id: AnimationId,
        to: AnimValue,
        duration: Duration,
        now: PresentationTime,
    ) -> Result<AnimValue, FastPathError> {
        let slot = self.slot_mut(id)?;
        if !values_match(slot.property, slot.from, to) {
            return Err(FastPathError::NeedsProducer);
        }
        let current = sample_slot(slot, now);
        slot.from = current;
        slot.to = to;
        slot.start = now;
        slot.duration_ns = nanos(duration);
        Ok(current)
    }

    pub fn sample(&self, id: AnimationId, now: PresentationTime) -> Option<AnimValue> {
        self.slots
            .get(id.index as usize)?
            .as_ref()
            .filter(|slot| slot.id == id)
            .map(|slot| sample_slot(slot, now))
    }

    pub fn for_each_sampled(
        &self,
        now: PresentationTime,
        mut f: impl FnMut(AnimationId, AnimationProperty, AnimValue),
    ) {
        for slot in self.slots.iter().flatten() {
            f(slot.id, slot.property, sample_slot(slot, now));
        }
    }

    fn insert(&mut self, mut slot: AnimationSlot) -> AnimationId {
        let index = self.slots.len() as u32;
        let id = AnimationId {
            index,
            generation: 1,
        };
        slot.id = id;
        self.slots.push(Some(slot));
        id
    }

    fn slot_mut(&mut self, id: AnimationId) -> Result<&mut AnimationSlot, FastPathError> {
        match self.slots.get_mut(id.index as usize) {
            Some(Some(slot)) if slot.id == id => Ok(slot),
            Some(None) | Some(Some(_)) => Err(FastPathError::StaleHandle),
            None => Err(FastPathError::MissingHandle),
        }
    }
}

fn rest_value(property: AnimationProperty) -> AnimValue {
    match property {
        AnimationProperty::Translation(_) => AnimValue::Translation(Vec2::default()),
        AnimationProperty::Opacity(_) => AnimValue::Opacity(1.0),
        _ => AnimValue::Opacity(1.0),
    }
}

fn values_match(property: AnimationProperty, from: AnimValue, to: AnimValue) -> bool {
    matches!(
        (property, from, to),
        (
            AnimationProperty::Translation(_),
            AnimValue::Translation(_),
            AnimValue::Translation(_),
        ) | (
            AnimationProperty::Opacity(_),
            AnimValue::Opacity(_),
            AnimValue::Opacity(_)
        )
    )
}

fn sample_slot(slot: &AnimationSlot, now: PresentationTime) -> AnimValue {
    let t = if slot.duration_ns == 0 {
        1.0
    } else {
        let elapsed = now.as_nanos().saturating_sub(slot.start.as_nanos());
        slot.easing.apply(elapsed as f64 / slot.duration_ns as f64)
    };
    match (slot.from, slot.to) {
        (AnimValue::Translation(from), AnimValue::Translation(to)) => {
            AnimValue::Translation(Vec2::new(lerp(from.x, to.x, t), lerp(from.y, to.y, t)))
        }
        (AnimValue::Opacity(from), AnimValue::Opacity(to)) => {
            AnimValue::Opacity(lerp(from as f64, to as f64, t) as f32)
        }
        _ => slot.to,
    }
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

fn nanos(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}
