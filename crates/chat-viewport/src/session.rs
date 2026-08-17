//! Viewport session: predict, prepare, present without waiting on Dioxus.

use crate::height::{GeometryCorrection, HeightIndex, LogicalItemId};
use crate::predictor::{PredictedRanges, PredictorBudgets, PredictorInput, RangePredictor};
use crate::prepare::{PrepAccept, PrepPriority, PreparationQueue};
use crate::range::ItemSpan;
use crate::tiles::{GeometrySnapshot, TileCache, TileFidelity, TileInsert};

const PROTECTED_BAND_PX: f64 = 120.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentDecision {
    Prepared,
    Fallback,
    Clamp,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PresentOutcome {
    pub decision: PresentDecision,
    pub blank_px: f64,
    pub waited_on_producer: bool,
    pub snapshot: GeometrySnapshot,
}

pub struct ViewportSession {
    index: HeightIndex,
    predictor: RangePredictor,
    queue: PreparationQueue,
    cache: TileCache,
    offset: f64,
    velocity: f64,
    viewport_height: f64,
    latency_ns: u64,
    last: Option<PredictedRanges>,
}

impl ViewportSession {
    pub fn new(
        index: HeightIndex,
        budgets: PredictorBudgets,
        cache: TileCache,
        viewport_height: f64,
        latency_ns: u64,
    ) -> Self {
        Self {
            index,
            predictor: RangePredictor::new(budgets),
            queue: PreparationQueue::new(1),
            cache,
            offset: 0.0,
            velocity: 0.0,
            viewport_height,
            latency_ns,
            last: None,
        }
    }

    pub fn index(&self) -> &HeightIndex {
        &self.index
    }

    pub fn index_mut(&mut self) -> &mut HeightIndex {
        &mut self.index
    }

    pub fn cache(&self) -> &TileCache {
        &self.cache
    }

    pub fn cache_mut(&mut self) -> &mut TileCache {
        &mut self.cache
    }

    pub fn queue(&self) -> &PreparationQueue {
        &self.queue
    }

    pub fn offset(&self) -> f64 {
        self.offset
    }

    pub fn velocity(&self) -> f64 {
        self.velocity
    }

    pub fn set_velocity(&mut self, velocity: f64) {
        let reversed =
            self.velocity != 0.0 && velocity != 0.0 && self.velocity.signum() != velocity.signum();
        self.velocity = velocity;
        self.cache.set_fling(velocity.abs() > 1.0);
        if reversed {
            let _ = self.predict(true);
        }
    }

    pub fn teleport(&mut self, offset: f64) {
        self.offset = self.clamp_offset(offset);
        self.queue.cancel_stale(u64::MAX);
        let predicted = self.predict(false);
        self.queue.submit(
            predicted.prepared.span,
            predicted.prepared.generation,
            PrepPriority::Emergency,
        );
    }

    pub fn advance(&mut self, dt_ns: u64) {
        let dt = dt_ns as f64 / 1.0e9;
        self.offset = self.clamp_offset(self.offset + self.velocity * dt);
        let predicted = self.predict(false);
        if predicted.should_prepare {
            self.queue.submit(
                predicted.prepared.span,
                predicted.prepared.generation,
                if predicted.time_to_prepared_edge_ns < self.latency_ns {
                    PrepPriority::Visible
                } else {
                    PrepPriority::Speculative
                },
            );
        }
        if let Some(job) = self.queue.take() {
            let _ = self
                .cache
                .insert_span(&self.index, job.span, TileFidelity::Full);
        }
    }

    pub fn present(&mut self) -> PresentOutcome {
        let predicted = self.predict(false);
        let protected = self.protected_span(predicted.visible.span);
        self.cache.pin_span(&self.index, protected);
        self.fill_fallback(predicted.visible.span);
        let blank = self.blank_px(predicted.visible.offset, predicted.visible.viewport_height);
        debug_assert!(
            blank.abs() < 1e-6,
            "overscan miss must not open a transparent gap"
        );
        let snapshot = GeometrySnapshot::from_cache(&self.cache, &self.index, self.offset);
        let decision = if self.visible_all_full(predicted.visible.span) {
            PresentDecision::Prepared
        } else if blank.abs() < 1e-6 {
            PresentDecision::Fallback
        } else {
            PresentDecision::Clamp
        };
        PresentOutcome {
            decision,
            blank_px: blank.max(0.0),
            waited_on_producer: false,
            snapshot,
        }
    }

    pub fn commit_exact(
        &mut self,
        id: LogicalItemId,
        exact: f64,
    ) -> Result<(GeometryCorrection, TileInsert), crate::height::HeightError> {
        let correction = self.index.commit_exact(id, exact)?;
        let insert = if let Some(hit) = self
            .index
            .item_at_offset(self.index.offset_of(id).unwrap_or(0.0))
        {
            self.cache.insert_span(
                &self.index,
                ItemSpan {
                    start: hit.index,
                    end: hit.index + 1,
                },
                TileFidelity::Full,
            )
        } else {
            TileInsert::AlreadyPresent
        };
        Ok((correction, insert))
    }

    pub fn compositor_handoff(&self) -> GeometrySnapshot {
        GeometrySnapshot::from_cache(&self.cache, &self.index, self.offset)
    }

    fn predict(&mut self, reversed: bool) -> PredictedRanges {
        let predicted = self.predictor.predict(
            &self.index,
            PredictorInput {
                offset: self.offset,
                velocity: self.velocity,
                viewport_height: self.viewport_height,
                latency_ns: self.latency_ns,
                reversed,
            },
        );
        self.last = Some(predicted.clone());
        predicted
    }

    fn clamp_offset(&self, offset: f64) -> f64 {
        let max = (self.index.extent() - self.viewport_height).max(0.0);
        offset.clamp(0.0, max)
    }

    fn protected_span(&self, visible: ItemSpan) -> ItemSpan {
        let start = (self.offset - PROTECTED_BAND_PX).max(0.0);
        let end = self.offset + self.viewport_height + PROTECTED_BAND_PX;
        visible.union(self.index.span_covering(start, end))
    }

    fn fill_fallback(&mut self, visible: ItemSpan) {
        for i in visible.start..visible.end {
            if let Some((id, _, _)) = self.index.height_at(i) {
                if self.cache.covering(id).is_none() {
                    let _ = self.cache.insert_span(
                        &self.index,
                        ItemSpan {
                            start: i,
                            end: i + 1,
                        },
                        TileFidelity::Fallback,
                    );
                }
            }
        }
    }

    fn visible_all_full(&self, visible: ItemSpan) -> bool {
        (visible.start..visible.end).all(|i| {
            self.index
                .height_at(i)
                .and_then(|(id, _, _)| self.cache.covering(id))
                .is_some_and(|tile| tile.fidelity == TileFidelity::Full)
        })
    }

    fn blank_px(&self, offset: f64, viewport_height: f64) -> f64 {
        let end = offset + viewport_height;
        let mut covered = 0.0;
        let mut cursor = offset;
        let mut tiles = self.cache.descriptors();
        tiles.retain(|tile| tile.origin + tile.height > offset && tile.origin < end);
        tiles.sort_by(|a, b| {
            a.origin
                .partial_cmp(&b.origin)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for tile in tiles {
            let lo = tile.origin.max(offset);
            let hi = (tile.origin + tile.height).min(end);
            if hi <= lo {
                continue;
            }
            if lo > cursor {
                covered += 0.0;
            }
            let from = cursor.max(lo);
            if hi > from {
                covered += hi - from;
                cursor = hi;
            }
        }
        (end - offset - covered).max(0.0)
    }
}

impl ViewportSession {
    pub fn last_prediction(&self) -> Option<&PredictedRanges> {
        self.last.as_ref()
    }

    pub fn submit_prep(
        &mut self,
        span: ItemSpan,
        generation: u64,
        priority: PrepPriority,
    ) -> PrepAccept {
        self.queue.submit(span, generation, priority)
    }
}
