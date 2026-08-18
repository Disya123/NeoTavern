//! Android MotionEvent / Choreographer adapter (host-side).
//!
//! Kotlin (debug/flagged shell) expands `MotionEvent` into raw screen samples
//! and never waits on this module. The compositor thread drains the bounded
//! queue into the existing hit-test / `ScrollId` latch path. Production
//! `MainActivity` and default JNI do not load this adapter.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, TryLockError};

use crate::display_list::Rect;
use crate::epoch::{DeviceEpoch, PresentationTime};
use crate::fast_path::{CompositorFastPath, PresentOutcome};
use crate::geometry_tiles::GeometryTileSnapshot;
use crate::hit_dispatch::{DispatchError, PointerEvent, PointerId, PointerKind};
use crate::property_tree::Point;
use crate::scroll::{ScrollInputError, ScrollSequence};
use crate::selection::{
    apply_autoscroll, autoscroll_delta, SelectablePaintPlan, SelectionError, SelectionSession,
};
use crate::text::TextInteractionSnapshot;

pub const INPUT_QUEUE_CAP: usize = 64;
pub const INPUT_EDGE_RESERVE: usize = 8;
pub const INPUT_MAX_POINTERS: usize = 16;
pub const ANDROID_ACTION_DOWN: i32 = 0;
pub const ANDROID_ACTION_UP: i32 = 1;
pub const ANDROID_ACTION_MOVE: i32 = 2;
pub const ANDROID_ACTION_CANCEL: i32 = 3;
pub const ANDROID_ACTION_POINTER_DOWN: i32 = 5;
pub const ANDROID_ACTION_POINTER_UP: i32 = 6;
pub const ANDROID_ACTION_MASK: i32 = 0xff;
pub const ANDROID_ACTION_POINTER_INDEX_SHIFT: i32 = 8;
pub const ANDROID_ACTION_POINTER_INDEX_MASK: i32 = 0xff00;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformPointerKind {
    Down,
    Move,
    Up,
    Cancel,
}

impl PlatformPointerKind {
    pub fn is_edge(self) -> bool {
        !matches!(self, Self::Move)
    }

    pub fn as_pointer_kind(self) -> PointerKind {
        match self {
            Self::Down => PointerKind::Down,
            Self::Move => PointerKind::Move,
            Self::Up => PointerKind::Up,
            Self::Cancel => PointerKind::Cancel,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlatformPointerSample {
    pub pointer: PointerId,
    pub kind: PlatformPointerKind,
    pub x: f32,
    pub y: f32,
    pub time_nanos: u64,
}

impl PlatformPointerSample {
    pub fn time(self) -> PresentationTime {
        PresentationTime::from_nanos(self.time_nanos)
    }

    pub fn screen(self) -> Point {
        Point::new(f64::from(self.x), f64::from(self.y))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputQueueStats {
    pub pushed: u64,
    pub accepted: u64,
    pub coalesced_moves: u64,
    pub dropped_moves: u64,
    pub dropped_edges: u64,
    pub contended: u64,
    pub high_water: usize,
    pub current: usize,
    pub cancels_synthesized: u64,
    pub layout_callbacks: u64,
    pub producer_callbacks: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputPush {
    Queued,
    Coalesced,
    DroppedMove,
    DroppedEdge,
    Contended,
}

/// Host-side view of one Android `MotionEvent` (no JNI types).
#[derive(Clone, Copy, Debug)]
pub struct AndroidMotionView<'a> {
    pub action: i32,
    pub pointer_count: usize,
    pub event_time_nanos: u64,
    pub pointer_ids: &'a [i32],
    pub x: &'a [f32],
    pub y: &'a [f32],
    pub history_times_nanos: &'a [u64],
    pub history_x: &'a [f32],
    pub history_y: &'a [f32],
}

#[derive(Clone, Copy, Debug)]
struct TrackedPointer {
    id: PointerId,
    x: f32,
    y: f32,
}

struct QueueInner {
    slots: [Option<PlatformPointerSample>; INPUT_QUEUE_CAP],
    head: usize,
    len: usize,
    tracked: [Option<TrackedPointer>; INPUT_MAX_POINTERS],
    stats: InputQueueStats,
}

impl QueueInner {
    fn new() -> Self {
        Self {
            slots: [None; INPUT_QUEUE_CAP],
            head: 0,
            len: 0,
            tracked: [None; INPUT_MAX_POINTERS],
            stats: InputQueueStats::default(),
        }
    }

    fn index(&self, offset: usize) -> usize {
        (self.head + offset) % INPUT_QUEUE_CAP
    }

    fn move_budget(&self) -> usize {
        INPUT_QUEUE_CAP.saturating_sub(INPUT_EDGE_RESERVE)
    }

    fn track(&mut self, sample: PlatformPointerSample) {
        match sample.kind {
            PlatformPointerKind::Down => {
                if let Some(slot) = self
                    .tracked
                    .iter_mut()
                    .find(|slot| slot.map(|t| t.id) == Some(sample.pointer))
                {
                    *slot = Some(TrackedPointer {
                        id: sample.pointer,
                        x: sample.x,
                        y: sample.y,
                    });
                    return;
                }
                if let Some(slot) = self.tracked.iter_mut().find(|slot| slot.is_none()) {
                    *slot = Some(TrackedPointer {
                        id: sample.pointer,
                        x: sample.x,
                        y: sample.y,
                    });
                }
            }
            PlatformPointerKind::Move => {
                if let Some(slot) = self
                    .tracked
                    .iter_mut()
                    .find(|slot| slot.map(|t| t.id) == Some(sample.pointer))
                {
                    *slot = Some(TrackedPointer {
                        id: sample.pointer,
                        x: sample.x,
                        y: sample.y,
                    });
                }
            }
            PlatformPointerKind::Up | PlatformPointerKind::Cancel => {
                for slot in &mut self.tracked {
                    if slot.map(|t| t.id) == Some(sample.pointer) {
                        *slot = None;
                    }
                }
            }
        }
    }

    fn push(&mut self, sample: PlatformPointerSample) -> InputPush {
        self.stats.pushed = self.stats.pushed.saturating_add(1);
        if sample.kind == PlatformPointerKind::Move {
            if let Some(existing) = self.last_move_slot(sample.pointer) {
                self.slots[existing] = Some(sample);
                self.track(sample);
                self.stats.coalesced_moves = self.stats.coalesced_moves.saturating_add(1);
                self.stats.accepted = self.stats.accepted.saturating_add(1);
                return InputPush::Coalesced;
            }
            let move_count = self.count_moves();
            if self.len >= INPUT_QUEUE_CAP || move_count >= self.move_budget() {
                if self.drop_oldest_move() {
                    self.stats.dropped_moves = self.stats.dropped_moves.saturating_add(1);
                } else {
                    self.stats.dropped_moves = self.stats.dropped_moves.saturating_add(1);
                    return InputPush::DroppedMove;
                }
            }
        } else if self.len >= INPUT_QUEUE_CAP && !self.drop_oldest_move() {
            self.stats.dropped_edges = self.stats.dropped_edges.saturating_add(1);
            return InputPush::DroppedEdge;
        }
        if self.len >= INPUT_QUEUE_CAP {
            if sample.kind == PlatformPointerKind::Move {
                self.stats.dropped_moves = self.stats.dropped_moves.saturating_add(1);
                return InputPush::DroppedMove;
            }
            self.stats.dropped_edges = self.stats.dropped_edges.saturating_add(1);
            return InputPush::DroppedEdge;
        }
        let idx = self.index(self.len);
        self.slots[idx] = Some(sample);
        self.len += 1;
        self.track(sample);
        self.stats.accepted = self.stats.accepted.saturating_add(1);
        self.stats.current = self.len;
        self.stats.high_water = self.stats.high_water.max(self.len);
        InputPush::Queued
    }

    fn last_move_slot(&self, pointer: PointerId) -> Option<usize> {
        (0..self.len).rev().find_map(|offset| {
            let idx = self.index(offset);
            match self.slots[idx] {
                Some(sample)
                    if sample.pointer == pointer && sample.kind == PlatformPointerKind::Move =>
                {
                    Some(idx)
                }
                _ => None,
            }
        })
    }

    fn count_moves(&self) -> usize {
        (0..self.len)
            .filter(|&offset| {
                self.slots[self.index(offset)]
                    .is_some_and(|sample| sample.kind == PlatformPointerKind::Move)
            })
            .count()
    }

    fn drop_oldest_move(&mut self) -> bool {
        let Some(offset) = (0..self.len).find(|&offset| {
            self.slots[self.index(offset)]
                .is_some_and(|sample| sample.kind == PlatformPointerKind::Move)
        }) else {
            return false;
        };
        self.remove_offset(offset);
        true
    }

    fn remove_offset(&mut self, offset: usize) {
        for step in offset..(self.len.saturating_sub(1)) {
            let from = self.index(step + 1);
            let to = self.index(step);
            self.slots[to] = self.slots[from];
        }
        let last = self.index(self.len.saturating_sub(1));
        self.slots[last] = None;
        self.len = self.len.saturating_sub(1);
        self.stats.current = self.len;
    }

    fn take(&mut self, out: &mut [PlatformPointerSample]) -> usize {
        let n = self.len.min(out.len());
        for i in 0..n {
            out[i] = self.slots[self.index(i)].expect("occupied");
            self.slots[self.index(i)] = None;
        }
        self.head = 0;
        self.len = 0;
        self.stats.current = 0;
        n
    }

    fn synthesize_cancels(&mut self, time_nanos: u64) -> usize {
        let tracked: [Option<TrackedPointer>; INPUT_MAX_POINTERS] = self.tracked;
        let mut n = 0;
        for slot in tracked {
            let Some(pointer) = slot else {
                continue;
            };
            let sample = PlatformPointerSample {
                pointer: pointer.id,
                kind: PlatformPointerKind::Cancel,
                x: pointer.x,
                y: pointer.y,
                time_nanos,
            };
            if matches!(self.push(sample), InputPush::Queued | InputPush::Coalesced) {
                n += 1;
                self.stats.cancels_synthesized = self.stats.cancels_synthesized.saturating_add(1);
            }
        }
        n
    }
}

/// Bounded UI → compositor input pump. The UI thread only [`Self::try_push`]es.
pub struct PlatformInputAdapter {
    inner: Mutex<QueueInner>,
    overflow: Mutex<[Option<PlatformPointerSample>; INPUT_EDGE_RESERVE]>,
    vsync_ns: AtomicU64,
    device_epoch: AtomicU64,
    contended_moves: AtomicU64,
}

impl Default for PlatformInputAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformInputAdapter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner::new()),
            overflow: Mutex::new([None; INPUT_EDGE_RESERVE]),
            vsync_ns: AtomicU64::new(0),
            device_epoch: AtomicU64::new(0),
            contended_moves: AtomicU64::new(0),
        }
    }

    /// Choreographer `frameTimeNanos` maps 1:1 to [`PresentationTime`].
    pub fn on_vsync(&self, frame_time_nanos: u64) {
        self.vsync_ns.store(frame_time_nanos, Ordering::Relaxed);
    }

    pub fn presentation_time(&self) -> PresentationTime {
        PresentationTime::from_nanos(self.vsync_ns.load(Ordering::Relaxed))
    }

    /// GPU recovery may bump [`DeviceEpoch`]; the logical gesture stays.
    pub fn note_device_epoch(&self, epoch: DeviceEpoch) {
        self.device_epoch.store(epoch.0, Ordering::Relaxed);
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        DeviceEpoch(self.device_epoch.load(Ordering::Relaxed))
    }

    pub fn try_push(&self, sample: PlatformPointerSample) -> InputPush {
        match self.inner.try_lock() {
            Ok(mut inner) => inner.push(sample),
            Err(TryLockError::WouldBlock) => {
                if sample.kind.is_edge() {
                    if self.push_overflow(sample) {
                        InputPush::Queued
                    } else {
                        InputPush::Contended
                    }
                } else {
                    self.contended_moves.fetch_add(1, Ordering::Relaxed);
                    InputPush::Contended
                }
            }
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().push(sample),
        }
    }

    /// UI thread: expand one MotionEvent and enqueue. Never waits on present.
    pub fn try_push_motion(&self, event: &AndroidMotionView<'_>) -> usize {
        let mut scratch = [PlatformPointerSample {
            pointer: PointerId(0),
            kind: PlatformPointerKind::Move,
            x: 0.0,
            y: 0.0,
            time_nanos: 0,
        }; INPUT_QUEUE_CAP];
        let n = expand_android_motion(event, &mut scratch);
        for sample in scratch.iter().take(n) {
            let _ = self.try_push(*sample);
        }
        n
    }

    pub fn lose_focus(&self, time_nanos: u64) {
        self.synthesize_cancels(time_nanos);
    }

    pub fn lose_window(&self, time_nanos: u64) {
        self.synthesize_cancels(time_nanos);
    }

    pub fn recreate_surface(&self, time_nanos: u64) {
        self.synthesize_cancels(time_nanos);
    }

    pub fn stats(&self) -> InputQueueStats {
        let mut stats = match self.inner.lock() {
            Ok(inner) => inner.stats,
            Err(poisoned) => poisoned.into_inner().stats,
        };
        stats.contended = stats
            .contended
            .saturating_add(self.contended_moves.load(Ordering::Relaxed));
        stats
    }

    /// Holds the queue mutex while `f` runs. The UI path still [`Self::try_push`]es
    /// without waiting (it returns [`InputPush::Contended`] or uses overflow).
    pub fn hold_queue<R>(&self, f: impl FnOnce() -> R) -> R {
        let _guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f()
    }

    pub fn drain(
        &self,
        path: &mut CompositorFastPath,
    ) -> Result<(usize, PresentOutcome), DispatchError> {
        let mut batch = [PlatformPointerSample {
            pointer: PointerId(0),
            kind: PlatformPointerKind::Move,
            x: 0.0,
            y: 0.0,
            time_nanos: 0,
        }; INPUT_QUEUE_CAP + INPUT_EDGE_RESERVE];
        let n = self.take_locked(&mut batch);
        for sample in batch.iter().take(n) {
            dispatch_sample(path, *sample)?;
        }
        Ok((n, path.present(self.presentation_time())))
    }

    pub fn drain_selection(
        &self,
        path: &mut CompositorFastPath,
        session: &mut SelectionSession,
        fragment: &TextInteractionSnapshot,
        geometry: &GeometryTileSnapshot,
        plan: &SelectablePaintPlan,
        viewport: Rect,
        next_seq: &mut u64,
    ) -> Result<(usize, PresentOutcome), SelectionDrainError> {
        let mut batch = [PlatformPointerSample {
            pointer: PointerId(0),
            kind: PlatformPointerKind::Move,
            x: 0.0,
            y: 0.0,
            time_nanos: 0,
        }; INPUT_QUEUE_CAP + INPUT_EDGE_RESERVE];
        let n = self.take_locked(&mut batch);
        for sample in batch.iter().take(n) {
            let event = dispatch_sample(path, *sample).map_err(SelectionDrainError::Dispatch)?;
            if event.kind == PointerKind::Move || event.kind == PointerKind::Down {
                if let Some(local) = event.local {
                    let frame = session
                        .drag(
                            fragment,
                            geometry,
                            plan,
                            local.x as f32,
                            local.y as f32,
                            Some(event.screen),
                        )
                        .map_err(SelectionDrainError::Selection)?;
                    if let Some(delta) = frame.autoscroll.or_else(|| {
                        autoscroll_delta(viewport, event.screen.x as f32, event.screen.y as f32)
                    }) {
                        if let Some(scroll) = event.scroll_id {
                            *next_seq = (*next_seq).saturating_add(1);
                            apply_autoscroll(
                                path,
                                scroll,
                                delta,
                                ScrollSequence(*next_seq),
                                sample.time(),
                            )
                            .map_err(SelectionDrainError::Scroll)?;
                        }
                    }
                }
            }
        }
        Ok((n, path.present(self.presentation_time())))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionDrainError {
    Dispatch(DispatchError),
    Selection(SelectionError),
    Scroll(ScrollInputError),
}

impl PlatformInputAdapter {
    fn push_overflow(&self, sample: PlatformPointerSample) -> bool {
        match self.overflow.try_lock() {
            Ok(mut slots) => {
                if let Some(slot) = slots.iter_mut().find(|slot| slot.is_none()) {
                    *slot = Some(sample);
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }

    fn synthesize_cancels(&self, time_nanos: u64) {
        match self.inner.lock() {
            Ok(mut inner) => {
                let _ = inner.synthesize_cancels(time_nanos);
            }
            Err(poisoned) => {
                let _ = poisoned.into_inner().synthesize_cancels(time_nanos);
            }
        }
    }

    fn take_locked(&self, out: &mut [PlatformPointerSample]) -> usize {
        let mut n = match self.inner.lock() {
            Ok(mut inner) => inner.take(out),
            Err(poisoned) => poisoned.into_inner().take(out),
        };
        let overflow = match self.overflow.lock() {
            Ok(mut slots) => {
                let copied: [Option<PlatformPointerSample>; INPUT_EDGE_RESERVE] = *slots;
                *slots = [None; INPUT_EDGE_RESERVE];
                copied
            }
            Err(poisoned) => {
                let mut slots = poisoned.into_inner();
                let copied = *slots;
                *slots = [None; INPUT_EDGE_RESERVE];
                copied
            }
        };
        for sample in overflow.into_iter().flatten() {
            if n < out.len() {
                out[n] = sample;
                n += 1;
            }
        }
        n
    }
}

fn dispatch_sample(
    path: &mut CompositorFastPath,
    sample: PlatformPointerSample,
) -> Result<PointerEvent, DispatchError> {
    let pointer = sample.pointer;
    let screen = sample.screen();
    let time = sample.time();
    match sample.kind {
        PlatformPointerKind::Down => path.pointer_down(pointer, screen, time),
        PlatformPointerKind::Move => path.pointer_move(pointer, screen, time),
        PlatformPointerKind::Up => path.pointer_up(pointer, screen, time),
        PlatformPointerKind::Cancel => path.pointer_cancel(pointer, screen, time),
    }
}

/// Expand one Android motion into samples. Historical MOVE keep original times.
pub fn expand_android_motion(
    event: &AndroidMotionView<'_>,
    out: &mut [PlatformPointerSample],
) -> usize {
    let count = event
        .pointer_count
        .min(event.pointer_ids.len())
        .min(event.x.len())
        .min(event.y.len());
    if count == 0 {
        return 0;
    }
    let masked = event.action & ANDROID_ACTION_MASK;
    let index = ((event.action & ANDROID_ACTION_POINTER_INDEX_MASK)
        >> ANDROID_ACTION_POINTER_INDEX_SHIFT) as usize;
    let mut n = 0;
    if masked == ANDROID_ACTION_MOVE {
        let history = event.history_times_nanos.len();
        for h in 0..history {
            let time = event.history_times_nanos[h];
            for p in 0..count {
                let base = h * count + p;
                if n >= out.len() || base >= event.history_x.len() || base >= event.history_y.len()
                {
                    return n;
                }
                out[n] = PlatformPointerSample {
                    pointer: PointerId(event.pointer_ids[p] as u64),
                    kind: PlatformPointerKind::Move,
                    x: event.history_x[base],
                    y: event.history_y[base],
                    time_nanos: time,
                };
                n += 1;
            }
        }
        for p in 0..count {
            if n >= out.len() {
                return n;
            }
            out[n] = PlatformPointerSample {
                pointer: PointerId(event.pointer_ids[p] as u64),
                kind: PlatformPointerKind::Move,
                x: event.x[p],
                y: event.y[p],
                time_nanos: event.event_time_nanos,
            };
            n += 1;
        }
        return n;
    }
    let kind = match masked {
        ANDROID_ACTION_DOWN | ANDROID_ACTION_POINTER_DOWN => PlatformPointerKind::Down,
        ANDROID_ACTION_UP | ANDROID_ACTION_POINTER_UP => PlatformPointerKind::Up,
        ANDROID_ACTION_CANCEL => PlatformPointerKind::Cancel,
        _ => return 0,
    };
    if masked == ANDROID_ACTION_CANCEL {
        for p in 0..count {
            if n >= out.len() {
                break;
            }
            out[n] = PlatformPointerSample {
                pointer: PointerId(event.pointer_ids[p] as u64),
                kind: PlatformPointerKind::Cancel,
                x: event.x[p],
                y: event.y[p],
                time_nanos: event.event_time_nanos,
            };
            n += 1;
        }
        return n;
    }
    let p = index.min(count.saturating_sub(1));
    if n < out.len() {
        out[n] = PlatformPointerSample {
            pointer: PointerId(event.pointer_ids[p] as u64),
            kind,
            x: event.x[p],
            y: event.y[p],
            time_nanos: event.event_time_nanos,
        };
        n += 1;
    }
    n
}

pub fn presentation_time_from_vsync(frame_time_nanos: u64) -> PresentationTime {
    PresentationTime::from_nanos(frame_time_nanos)
}
