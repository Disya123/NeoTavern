//! Deadline-aware range predictor (RFC §15.3). Overscan is clamped by
//! item/byte/time budgets. Reversal keeps bounded trailing coverage.

use crate::height::HeightIndex;
use crate::range::{FallbackReadyRange, ItemSpan, PreparedRange, VisibleRange};

pub const DEFAULT_REFRESH_NS: u64 = 8_333_333;
pub const DEFAULT_BRAKE_PX: f64 = 64.0;
pub const BYTES_PER_ITEM: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PredictorBudgets {
    pub max_overscan_items: usize,
    pub max_overscan_bytes: usize,
    pub max_overscan_ns: u64,
    pub refresh_ns: u64,
    pub brake_px: f64,
}

impl Default for PredictorBudgets {
    fn default() -> Self {
        Self {
            max_overscan_items: 48,
            max_overscan_bytes: 256 * 1024,
            max_overscan_ns: 50_000_000,
            refresh_ns: DEFAULT_REFRESH_NS,
            brake_px: DEFAULT_BRAKE_PX,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PredictorInput {
    pub offset: f64,
    pub velocity: f64,
    pub viewport_height: f64,
    pub latency_ns: u64,
    pub reversed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PredictedRanges {
    pub visible: VisibleRange,
    pub prepared: PreparedRange,
    pub fallback_ready: FallbackReadyRange,
    pub time_to_prepared_edge_ns: u64,
    pub should_prepare: bool,
    pub ahead_px: f64,
    pub behind_px: f64,
}

pub struct RangePredictor {
    budgets: PredictorBudgets,
    last_sign: f64,
    last_ahead_px: f64,
    generation: u64,
}

impl RangePredictor {
    pub fn new(budgets: PredictorBudgets) -> Self {
        Self {
            budgets,
            last_sign: 0.0,
            last_ahead_px: 0.0,
            generation: 0,
        }
    }

    pub fn budgets(&self) -> PredictorBudgets {
        self.budgets
    }

    pub fn predict(&mut self, index: &HeightIndex, input: PredictorInput) -> PredictedRanges {
        let visible_end = input.offset + input.viewport_height;
        let visible = VisibleRange {
            span: index.span_covering(input.offset, visible_end),
            offset: input.offset,
            viewport_height: input.viewport_height,
        };
        let horizon_ns = input
            .latency_ns
            .saturating_add(self.budgets.refresh_ns.saturating_mul(2));
        let horizon_s = ns_to_s(horizon_ns);
        let speed = input.velocity.abs();
        let sign = input.velocity.signum();
        let reversed =
            input.reversed || (self.last_sign != 0.0 && sign != 0.0 && sign != self.last_sign);
        let mut ahead_px = speed * horizon_s + self.budgets.brake_px;
        let mut behind_px = self.budgets.brake_px;
        if reversed {
            behind_px = behind_px.max(self.last_ahead_px);
        }
        self.clamp_overscan(&mut ahead_px, &mut behind_px, speed, horizon_ns);
        let prepared_span = expand_span(
            index,
            visible.span,
            if sign >= 0.0 { ahead_px } else { behind_px },
            if sign >= 0.0 { behind_px } else { ahead_px },
        );
        let fallback_span = expand_span(
            index,
            prepared_span,
            (ahead_px * 0.25).max(16.0),
            (behind_px * 0.25).max(16.0),
        );
        let edge_px = if sign >= 0.0 {
            index.origin_at(prepared_span.end).unwrap_or(index.extent()) - visible_end
        } else {
            input.offset - index.origin_at(prepared_span.start).unwrap_or(0.0)
        };
        let time_to_edge_ns = if speed < 1e-6 {
            u64::MAX
        } else {
            ((edge_px.max(0.0) / speed) * 1.0e9) as u64
        };
        let should_prepare =
            time_to_edge_ns < horizon_ns || prepared_span.len() <= visible.span.len();
        self.generation = self.generation.saturating_add(1);
        self.last_sign = if sign == 0.0 { self.last_sign } else { sign };
        self.last_ahead_px = ahead_px;
        PredictedRanges {
            visible,
            prepared: PreparedRange {
                span: prepared_span,
                generation: self.generation,
            },
            fallback_ready: FallbackReadyRange {
                span: fallback_span,
            },
            time_to_prepared_edge_ns: time_to_edge_ns,
            should_prepare,
            ahead_px,
            behind_px,
        }
    }

    fn clamp_overscan(&self, ahead_px: &mut f64, behind_px: &mut f64, speed: f64, horizon_ns: u64) {
        let max_items = self.budgets.max_overscan_items.max(1);
        let max_bytes = self.budgets.max_overscan_bytes.max(BYTES_PER_ITEM);
        let item_px_cap = max_items as f64 * 96.0;
        let byte_px_cap = (max_bytes / BYTES_PER_ITEM) as f64 * 96.0;
        let time_px_cap = if speed < 1e-6 {
            *ahead_px
        } else {
            speed * ns_to_s(self.budgets.max_overscan_ns.min(horizon_ns).max(1))
        };
        let cap = item_px_cap
            .min(byte_px_cap)
            .min(time_px_cap)
            .max(self.budgets.brake_px);
        *ahead_px = ahead_px.min(cap);
        *behind_px = behind_px.min(cap);
    }
}

fn ns_to_s(ns: u64) -> f64 {
    ns as f64 / 1.0e9
}

fn expand_span(index: &HeightIndex, span: ItemSpan, ahead_px: f64, behind_px: f64) -> ItemSpan {
    if index.is_empty() {
        return ItemSpan::EMPTY;
    }
    let mut start = span.start;
    let mut remain = behind_px;
    while start > 0 && remain > 0.0 {
        start -= 1;
        remain -= index.height_at(start).map(|h| h.1).unwrap_or(0.0);
    }
    let mut end = span.end;
    remain = ahead_px;
    while end < index.len() && remain > 0.0 {
        remain -= index.height_at(end).map(|h| h.1).unwrap_or(0.0);
        end += 1;
    }
    ItemSpan { start, end }
}
