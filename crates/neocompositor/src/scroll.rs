//! Compositor-thread async scroll (RFC §15).
//!
//! State lives beside the immutable [`crate::PropertySnapshot`], never inside
//! it. Input only mutates delta/velocity. A producer ack rebases committed
//! offset without teleport or double-apply.

use crate::epoch::{PresentationTime, ScrollEpoch};
use crate::property_tree::{PropertySnapshot, SampleError, ScrollId, ScrollRange, Vec2};

pub const MAX_SCROLL_CHAIN: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct GestureId(pub u64);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub struct ScrollSequence(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckResult {
    Applied,
    IgnoredStale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollInputError {
    StaleHandle,
    MissingHandle,
    NoGesture,
    ChainTooLong,
}

impl From<SampleError> for ScrollInputError {
    fn from(err: SampleError) -> Self {
        match err {
            SampleError::StaleHandle | SampleError::EpochMismatch => Self::StaleHandle,
            SampleError::MissingHandle => Self::MissingHandle,
        }
    }
}

/// Producer-published base offset plus the input sequence already absorbed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollAck {
    pub scroll_id: ScrollId,
    pub epoch: ScrollEpoch,
    pub base_offset: Vec2,
    pub scroll_sequence: ScrollSequence,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AsyncScrollState {
    pub id: ScrollId,
    pub epoch: ScrollEpoch,
    pub committed_offset: Vec2,
    pub unacked_delta: Vec2,
    pub applied_input_seq: ScrollSequence,
    pub acknowledged_input_seq: ScrollSequence,
    pub screen_velocity: Vec2,
    pub bounds: ScrollRange,
    last_input_ns: Option<u64>,
}

impl AsyncScrollState {
    fn new(id: ScrollId, bounds: ScrollRange) -> Self {
        Self {
            id,
            epoch: ScrollEpoch(0),
            committed_offset: Vec2::default(),
            unacked_delta: Vec2::default(),
            applied_input_seq: ScrollSequence(0),
            acknowledged_input_seq: ScrollSequence(0),
            screen_velocity: Vec2::default(),
            bounds,
            last_input_ns: None,
        }
    }

    pub fn visual_offset(&self) -> Vec2 {
        self.committed_offset.add(self.unacked_delta)
    }

    fn consume_delta(&mut self, delta: Vec2) -> Vec2 {
        let visual = self.visual_offset();
        let unclamped = visual.add(delta);
        let clamped = self.bounds.clamp(unclamped);
        self.unacked_delta = clamped.sub(self.committed_offset);
        unclamped.sub(clamped)
    }

    fn ack(&mut self, ack: ScrollAck) -> AckResult {
        if ack.scroll_id != self.id {
            return AckResult::IgnoredStale;
        }
        if ack.epoch < self.epoch {
            return AckResult::IgnoredStale;
        }
        if ack.epoch > self.epoch {
            self.epoch = ack.epoch;
            self.committed_offset = self.bounds.clamp(ack.base_offset);
            self.unacked_delta = Vec2::default();
            self.applied_input_seq = ack.scroll_sequence;
            self.acknowledged_input_seq = ack.scroll_sequence;
            self.screen_velocity = Vec2::default();
            self.last_input_ns = None;
            return AckResult::Applied;
        }
        if ack.scroll_sequence <= self.acknowledged_input_seq {
            return AckResult::IgnoredStale;
        }
        if ack.scroll_sequence > self.applied_input_seq {
            return AckResult::IgnoredStale;
        }
        let visual = self.visual_offset();
        self.committed_offset = self.bounds.clamp(ack.base_offset);
        self.unacked_delta = visual.sub(self.committed_offset);
        self.acknowledged_input_seq = ack.scroll_sequence;
        AckResult::Applied
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GestureLatch {
    gesture: GestureId,
    len: u8,
    index: u8,
    chain: [ScrollId; MAX_SCROLL_CHAIN],
}

impl GestureLatch {
    fn from_chain(gesture: GestureId, chain: &[ScrollId]) -> Result<Self, ScrollInputError> {
        if chain.is_empty() {
            return Err(ScrollInputError::NoGesture);
        }
        if chain.len() > MAX_SCROLL_CHAIN {
            return Err(ScrollInputError::ChainTooLong);
        }
        let mut ids = [ScrollId::unbound(0); MAX_SCROLL_CHAIN];
        ids[..chain.len()].copy_from_slice(chain);
        Ok(Self {
            gesture,
            len: chain.len() as u8,
            index: 0,
            chain: ids,
        })
    }

    fn latched(self) -> ScrollId {
        self.chain[self.index as usize]
    }

    fn neighbor(self, unused: Vec2) -> Option<u8> {
        let idx = self.index as usize;
        if unused.x > 0.0 || unused.y > 0.0 {
            let next = idx + 1;
            (next < self.len as usize).then_some(next as u8)
        } else if unused.x < 0.0 || unused.y < 0.0 {
            idx.checked_sub(1).map(|v| v as u8)
        } else {
            None
        }
    }
}

/// Dense compositor-thread scroll table. Not shared with the UI mailbox.
#[derive(Clone, Debug, Default)]
pub struct ScrollTable {
    slots: Vec<Option<AsyncScrollState>>,
    latch: Option<GestureLatch>,
}

impl ScrollTable {
    pub fn bind(&mut self, snapshot: &PropertySnapshot) {
        let n = snapshot.scroll_slot_count();
        if self.slots.len() < n {
            self.slots.resize(n, None);
        }
        for i in 0..n {
            match snapshot.scroll_at(i as u32) {
                None => self.slots[i] = None,
                Some(id) => {
                    let bounds = snapshot
                        .scroll_bounds(id)
                        .unwrap_or_else(ScrollRange::unbounded);
                    match &self.slots[i] {
                        Some(existing) if existing.id == id => {
                            if let Some(slot) = self.slots[i].as_mut() {
                                slot.bounds = bounds;
                            }
                        }
                        _ => self.slots[i] = Some(AsyncScrollState::new(id, bounds)),
                    }
                }
            }
        }
        if let Some(latch) = self.latch {
            if self.state(latch.latched()).is_none() {
                self.latch = None;
            }
        }
    }

    pub fn state(&self, id: ScrollId) -> Option<&AsyncScrollState> {
        self.slots
            .get(id.index() as usize)?
            .as_ref()
            .filter(|slot| slot.id == id)
    }

    pub fn visual_offset(&self, id: ScrollId) -> Option<Vec2> {
        self.state(id).map(AsyncScrollState::visual_offset)
    }

    pub fn latched_scroll(&self) -> Option<ScrollId> {
        self.latch.map(GestureLatch::latched)
    }

    pub(crate) fn max_applied_seq(&self) -> u64 {
        self.slots
            .iter()
            .filter_map(|slot| slot.as_ref())
            .map(|state| state.applied_input_seq.0)
            .max()
            .unwrap_or(0)
    }

    pub fn ack(&mut self, ack: ScrollAck) -> AckResult {
        match self.slots.get_mut(ack.scroll_id.index() as usize) {
            Some(Some(slot)) if slot.id == ack.scroll_id => slot.ack(ack),
            _ => AckResult::IgnoredStale,
        }
    }

    pub fn nudge(
        &mut self,
        id: ScrollId,
        delta: Vec2,
        seq: ScrollSequence,
        time: PresentationTime,
    ) -> Result<Vec2, ScrollInputError> {
        let unused = self.consume(id, delta, seq, time)?;
        Ok(unused)
    }

    pub fn begin_gesture(
        &mut self,
        gesture: GestureId,
        chain: &[ScrollId],
    ) -> Result<ScrollId, ScrollInputError> {
        for id in chain {
            if self.state(*id).is_none() {
                return Err(ScrollInputError::StaleHandle);
            }
        }
        let latch = GestureLatch::from_chain(gesture, chain)?;
        let latched = latch.latched();
        self.latch = Some(latch);
        Ok(latched)
    }

    pub fn end_gesture(&mut self, gesture: GestureId) {
        if self.latch.is_some_and(|latch| latch.gesture == gesture) {
            self.latch = None;
        }
    }

    /// Applies `delta` to the latched scroller. Leftover at a bound is handed
    /// to the next chain member only; it is never applied twice.
    pub fn gesture_delta(
        &mut self,
        gesture: GestureId,
        delta: Vec2,
        seq: ScrollSequence,
        time: PresentationTime,
    ) -> Result<ScrollId, ScrollInputError> {
        let mut latch = self.latch.ok_or(ScrollInputError::NoGesture)?;
        if latch.gesture != gesture {
            return Err(ScrollInputError::NoGesture);
        }
        let mut unused = delta;
        loop {
            let id = latch.latched();
            let before = unused;
            unused = self.consume(id, unused, seq, time)?;
            if unused.is_zero() {
                break;
            }
            match latch.neighbor(unused) {
                Some(next) if next != latch.index => latch.index = next,
                _ => {
                    if unused == before {
                        break;
                    }
                    break;
                }
            }
        }
        self.latch = Some(latch);
        Ok(latch.latched())
    }

    fn consume(
        &mut self,
        id: ScrollId,
        delta: Vec2,
        seq: ScrollSequence,
        time: PresentationTime,
    ) -> Result<Vec2, ScrollInputError> {
        let slot = self
            .slots
            .get_mut(id.index() as usize)
            .ok_or(ScrollInputError::MissingHandle)?
            .as_mut()
            .ok_or(ScrollInputError::StaleHandle)?;
        if slot.id != id {
            return Err(ScrollInputError::StaleHandle);
        }
        if seq <= slot.applied_input_seq {
            return Err(ScrollInputError::StaleHandle);
        }
        let unused = slot.consume_delta(delta);
        let used = delta.sub(unused);
        if !used.is_zero() {
            if let Some(prev) = slot.last_input_ns {
                let dt = time.as_nanos().saturating_sub(prev) as f64;
                if dt > 0.0 {
                    slot.screen_velocity = Vec2::new(used.x / dt * 1.0e9, used.y / dt * 1.0e9);
                }
            } else {
                slot.screen_velocity = used;
            }
            slot.applied_input_seq = seq;
            slot.last_input_ns = Some(time.as_nanos());
        }
        Ok(unused)
    }
}
