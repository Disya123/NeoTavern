//! Viewport session: predict, prepare, present without waiting on Dioxus.
//! Geometry commits remap C0/C1 without mixing epochs.

use crate::height::{GeometryEpoch, HeightError, HeightIndex, HeightKind, LogicalItemId};
use crate::predictor::{PredictedRanges, PredictorBudgets, PredictorInput, RangePredictor};
use crate::prepare::{PrepAccept, PrepPriority, PreparationQueue};
use crate::range::ItemSpan;
use crate::remap::{
    validate_commit, AckResult, CommitError, ContactMode, DebtCaps, DualGeometry, GeometryCommit,
    GeometryCorrection, GeometryDebt, GeometryDebtLedger, PrefixDelta, PrefixDeltaMap,
    RemapOutcome, SceneGeneration, ScrollAck, ScrollAnchor, ViewportError,
};
use crate::tiles::{GeometrySnapshot, TileCache, TileDescriptor, TileFidelity, TileInsert};

pub const PROTECTED_BAND_PX: f64 = 120.0;

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
    prefix: PrefixDeltaMap,
    debt: GeometryDebtLedger,
    active: GeometrySnapshot,
    shadow: GeometrySnapshot,
    anchor: Option<ScrollAnchor>,
    contact: ContactMode,
    scroll_generation: u64,
    acked_scroll_generation: u64,
    last_acked_token: Option<crate::remap::DeltaToken>,
    last_applied_token: Option<crate::remap::DeltaToken>,
    origin_base: f64,
    generation: SceneGeneration,
    shadow_epoch: GeometryEpoch,
    deceleration_requested: bool,
}

impl ViewportSession {
    pub fn new(
        index: HeightIndex,
        budgets: PredictorBudgets,
        cache: TileCache,
        viewport_height: f64,
        latency_ns: u64,
    ) -> Self {
        Self::with_debt_caps(
            index,
            budgets,
            cache,
            viewport_height,
            latency_ns,
            DebtCaps::default(),
        )
    }

    pub fn with_debt_caps(
        index: HeightIndex,
        budgets: PredictorBudgets,
        cache: TileCache,
        viewport_height: f64,
        latency_ns: u64,
        debt_caps: DebtCaps,
    ) -> Self {
        let epoch = index.geometry_epoch();
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
            prefix: PrefixDeltaMap::default(),
            debt: GeometryDebtLedger::new(debt_caps),
            active: GeometrySnapshot::empty(),
            shadow: GeometrySnapshot::empty(),
            anchor: None,
            contact: ContactMode::Rest,
            scroll_generation: 0,
            acked_scroll_generation: 0,
            last_acked_token: None,
            last_applied_token: None,
            origin_base: 0.0,
            generation: SceneGeneration::default(),
            shadow_epoch: epoch,
            deceleration_requested: false,
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

    pub fn origin_base(&self) -> f64 {
        self.origin_base
    }

    pub fn contact_mode(&self) -> ContactMode {
        self.contact
    }

    pub fn anchor(&self) -> Option<ScrollAnchor> {
        self.anchor
    }

    pub fn pending_debt(&self) -> &[GeometryDebt] {
        self.debt.pending()
    }

    pub fn debt_stats(&self) -> crate::remap::DebtStats {
        self.debt.stats()
    }

    pub fn prefix_map(&self) -> &PrefixDeltaMap {
        &self.prefix
    }

    pub fn delta_token(&self) -> crate::remap::DeltaToken {
        self.prefix.token()
    }

    pub fn scroll_generation(&self) -> u64 {
        self.scroll_generation
    }

    pub fn scene_generation(&self) -> SceneGeneration {
        self.generation
    }

    pub fn deceleration_requested(&self) -> bool {
        self.deceleration_requested
    }

    pub fn active_snapshot(&self) -> &GeometrySnapshot {
        &self.active
    }

    pub fn shadow_snapshot(&self) -> &GeometrySnapshot {
        &self.shadow
    }

    pub fn dual_geometry(&self) -> DualGeometry {
        DualGeometry {
            active: self.active.clone(),
            shadow: self.shadow.clone(),
        }
    }

    pub fn set_velocity(&mut self, velocity: f64) {
        let reversed =
            self.velocity != 0.0 && velocity != 0.0 && self.velocity.signum() != velocity.signum();
        self.velocity = velocity;
        if velocity.abs() > 1.0 {
            self.contact = ContactMode::Fling;
            self.cache.set_fling(true);
        } else {
            self.cache.set_fling(false);
            if self.contact == ContactMode::Fling {
                self.contact = ContactMode::Rest;
            }
        }
        self.refresh_anchor();
        if reversed {
            let _ = self.predict(true);
        }
    }

    pub fn finger_down(&mut self, viewport_y: f64) {
        self.contact = ContactMode::Touch;
        self.cache.set_fling(false);
        let y = viewport_y.clamp(0.0, self.viewport_height);
        let content_y = self.offset + y;
        self.anchor = self.hit_anchor(content_y);
    }

    pub fn finger_up(&mut self) {
        if self.contact == ContactMode::Touch {
            self.contact = ContactMode::Rest;
        }
    }

    pub fn teleport(&mut self, offset: f64) {
        self.offset = self.clamp_offset(offset);
        self.queue.cancel_stale(u64::MAX);
        self.refresh_anchor();
        let predicted = self.predict(false);
        self.queue.submit(
            predicted.prepared.span,
            predicted.prepared.generation,
            PrepPriority::Emergency,
        );
    }

    pub fn advance(&mut self, dt_ns: u64) {
        if self.deceleration_requested {
            self.velocity *= 0.5;
            self.deceleration_requested = false;
        }
        let dt = dt_ns as f64 / 1.0e9;
        self.offset = self.clamp_offset(self.offset + self.velocity * dt);
        self.settle_ready_debt();
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
        self.settle_ready_debt();
        let predicted = self.predict(false);
        let protected = self.protected_span(predicted.visible.span);
        self.cache.pin_span(&self.index, protected);
        self.fill_fallback(predicted.visible.span);
        let blank = self.blank_px(predicted.visible.offset, predicted.visible.viewport_height);
        debug_assert!(
            blank.abs() < 1e-6,
            "overscan miss must not open a transparent gap"
        );
        self.refresh_snapshots();
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
            snapshot: self.active.clone(),
        }
    }

    pub fn commit_exact(
        &mut self,
        id: LogicalItemId,
        exact: f64,
    ) -> Result<RemapOutcome, ViewportError> {
        if exact <= 0.0 {
            return Err(HeightError::NonPositiveHeight.into());
        }
        let (estimated, kind) = self.index.height(id).ok_or(HeightError::UnknownItem)?;
        let delta = exact - estimated;
        if delta.abs() < 1e-9 {
            if kind != HeightKind::Exact {
                self.index.set_height(id, exact, HeightKind::Exact)?;
            }
            return Ok(self.unchanged_outcome());
        }
        self.refresh_anchor();
        self.prefix.reindex(&self.index);
        let token = self.prefix.insert(
            &self.index,
            PrefixDelta {
                item: id,
                estimated,
                exact,
                delta,
            },
        )?;
        self.shadow_epoch = GeometryEpoch(self.index.geometry_epoch().0.saturating_add(1));
        self.refresh_snapshots();
        if self.should_defer(id) {
            let debt = GeometryDebt {
                item: id,
                estimated,
                exact,
                delta,
                from_epoch: self.index.geometry_epoch(),
                to_epoch: self.shadow_epoch,
            };
            let cap_hit = self.debt.try_push(debt).is_err();
            if cap_hit {
                self.deceleration_requested = true;
            }
            self.refresh_snapshots();
            return Ok(RemapOutcome {
                correction: GeometryCorrection::Deferred,
                applied: false,
                deferred: true,
                hard_clamped: false,
                cap_hit,
                deceleration_requested: cap_hit,
                screen_velocity_before: self.velocity,
                screen_velocity_after: self.velocity,
                anchor_screen_before: self.current_anchor_screen(),
                anchor_screen_after: self.current_anchor_screen(),
                generation: self.generation,
                old_epoch: self.index.geometry_epoch(),
                new_epoch: self.shadow_epoch,
                token,
            });
        }
        self.apply_items(&[id])
    }

    pub fn prepend(
        &mut self,
        items: &[(LogicalItemId, f64, HeightKind)],
    ) -> Result<RemapOutcome, ViewportError> {
        self.refresh_anchor();
        let vel_before = self.velocity;
        let screen_before = self.current_anchor_screen();
        let old_epoch = self.index.geometry_epoch();
        let token = self.prefix.token();
        let skip_offset = self.last_acked_token == Some(token);
        self.index.prepend(items)?;
        self.prefix.reindex(&self.index);
        self.index.bump_epoch();
        let hard =
            self.finish_geometry(screen_before, skip_offset, vel_before, old_epoch, token)?;
        Ok(hard)
    }

    pub fn remove_item(
        &mut self,
        id: LogicalItemId,
    ) -> Result<Option<ScrollAnchor>, ViewportError> {
        let removed_index = self.index.remove(id)?;
        self.prefix.remove(&self.index, id);
        self.debt.remove(id);
        if self.anchor.is_some_and(|anchor| anchor.item == id) {
            self.anchor = self.neighbour_anchor(removed_index);
        }
        self.cache.remap_from_index(&self.index);
        self.index.bump_epoch();
        self.generation.bump_atomic();
        self.sync_shadow_epoch();
        self.refresh_snapshots();
        Ok(self.anchor)
    }

    pub fn replace_fallback(&mut self, span: ItemSpan) -> Result<(), ViewportError> {
        self.cache
            .replace_span_atomic(&self.index, span, TileFidelity::Full);
        self.generation.bump_atomic();
        self.refresh_snapshots();
        if !self.active.uniform_epoch() || self.active.epoch != self.index.geometry_epoch() {
            return Err(CommitError::MixedEpoch.into());
        }
        Ok(())
    }

    pub fn apply_commit(&mut self, commit: GeometryCommit) -> Result<RemapOutcome, ViewportError> {
        validate_commit(
            self.index.geometry_epoch(),
            self.shadow_epoch,
            self.scroll_generation,
            &commit,
        )?;
        self.prefix = commit.prefix_delta_map;
        self.prefix.reindex(&self.index);
        self.anchor = Some(commit.anchor);
        let ids = self.prefix.item_ids();
        self.apply_items(&ids)
    }

    pub fn ack_scroll(&mut self, ack: ScrollAck) -> AckResult {
        if ack.scroll_generation < self.acked_scroll_generation {
            return AckResult::IgnoredStale;
        }
        if self.last_applied_token == Some(ack.token) {
            self.acked_scroll_generation = self.acked_scroll_generation.max(ack.scroll_generation);
            return AckResult::IgnoredAlreadyApplied;
        }
        if self.last_acked_token == Some(ack.token) {
            return AckResult::IgnoredAlreadyApplied;
        }
        self.offset = self.clamp_offset(ack.base_offset);
        self.last_acked_token = Some(ack.token);
        self.acked_scroll_generation = ack.scroll_generation;
        AckResult::Applied
    }

    pub fn rebase_origin(&mut self, new_base: f64) {
        self.origin_base = new_base;
        self.generation.bump_atomic();
        self.refresh_snapshots();
    }

    pub fn compositor_handoff(&self) -> GeometrySnapshot {
        self.active.clone()
    }

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

    pub fn commit_exact_insert(
        &mut self,
        id: LogicalItemId,
        exact: f64,
    ) -> Result<(RemapOutcome, TileInsert), ViewportError> {
        let covering = self.cache.covering(id);
        let outcome = self.commit_exact(id, exact)?;
        let insert = if outcome.deferred {
            if covering.is_some() {
                TileInsert::Pinned
            } else {
                TileInsert::AlreadyPresent
            }
        } else {
            TileInsert::Inserted
        };
        Ok((outcome, insert))
    }
}

impl ViewportSession {
    fn apply_items(&mut self, ids: &[LogicalItemId]) -> Result<RemapOutcome, ViewportError> {
        self.refresh_anchor();
        let vel_before = self.velocity;
        let screen_before = self.current_anchor_screen();
        let old_epoch = self.index.geometry_epoch();
        let token = self.prefix.token();
        let skip_offset = self.last_acked_token == Some(token);
        self.prefix.reindex(&self.index);
        for id in ids {
            let Some(entry) = self.prefix.remove(&self.index, *id) else {
                continue;
            };
            self.debt.remove(*id);
            self.index.set_height(*id, entry.exact, HeightKind::Exact)?;
        }
        self.index.bump_epoch();
        let outcome =
            self.finish_geometry(screen_before, skip_offset, vel_before, old_epoch, token)?;
        Ok(outcome)
    }

    fn finish_geometry(
        &mut self,
        screen_before: f64,
        skip_offset: bool,
        vel_before: f64,
        old_epoch: GeometryEpoch,
        token: crate::remap::DeltaToken,
    ) -> Result<RemapOutcome, ViewportError> {
        let mut hard_clamped = false;
        if !skip_offset {
            if let Some(anchor) = self.resolve_anchor() {
                let origin = self.index.offset_of(anchor.item).unwrap_or(0.0);
                let height = self.index.height(anchor.item).map(|h| h.0).unwrap_or(0.0);
                let intra = anchor.intra_item_offset.clamp(0.0, height.max(0.0));
                let new_offset = origin + intra - screen_before;
                hard_clamped = self.apply_offset_with_retarget(new_offset);
            }
        } else {
            hard_clamped = self.apply_offset_with_retarget(self.offset);
        }
        self.cache.remap_from_index(&self.index);
        if self.cache.descriptors().iter().any(|tile| {
            tile.epoch != self.index.geometry_epoch() && self.cache.covering(tile.first).is_some()
        }) {
            self.cache.set_all_epochs(self.index.geometry_epoch());
        }
        self.generation.bump_atomic();
        self.last_applied_token = Some(token);
        self.prefix.rotate_token();
        self.scroll_generation = self.scroll_generation.saturating_add(1);
        self.sync_shadow_epoch();
        self.refresh_snapshots();
        if !self.active.uniform_epoch() {
            return Err(CommitError::MixedEpoch.into());
        }
        let screen_after = self.current_anchor_screen();
        Ok(RemapOutcome {
            correction: GeometryCorrection::Applied,
            applied: true,
            deferred: false,
            hard_clamped,
            cap_hit: false,
            deceleration_requested: false,
            screen_velocity_before: vel_before,
            screen_velocity_after: self.velocity,
            anchor_screen_before: screen_before,
            anchor_screen_after: screen_after,
            generation: self.generation,
            old_epoch,
            new_epoch: self.index.geometry_epoch(),
            token,
        })
    }

    fn apply_offset_with_retarget(&mut self, new_offset: f64) -> bool {
        let max = self.max_offset();
        if new_offset > max + 1e-6 {
            self.offset = max;
            if self.velocity > 0.0 {
                self.velocity = 0.0;
            }
            true
        } else if new_offset < -1e-6 {
            self.offset = 0.0;
            if self.velocity < 0.0 {
                self.velocity = 0.0;
            }
            true
        } else {
            self.offset = new_offset.clamp(0.0, max);
            false
        }
    }

    fn max_offset(&self) -> f64 {
        (self.index.extent() - self.viewport_height).max(0.0)
    }

    fn settle_ready_debt(&mut self) {
        if self.prefix.is_empty() {
            return;
        }
        self.prefix.reindex(&self.index);
        let rest = self.contact == ContactMode::Rest && self.velocity.abs() <= 1.0;
        let mut ready: Vec<LogicalItemId> = self
            .prefix
            .item_ids()
            .into_iter()
            .filter(|id| rest || !self.item_in_protected(*id))
            .collect();
        if ready.is_empty() {
            return;
        }
        ready.sort_by_key(|id| self.index.index_of(*id).unwrap_or(usize::MAX));
        let _ = self.apply_items(&ready);
    }

    fn should_defer(&self, id: LogicalItemId) -> bool {
        if !self.item_in_protected(id) {
            return false;
        }
        match self.contact {
            ContactMode::Fling => self.velocity.abs() > 1.0,
            ContactMode::Touch => true,
            ContactMode::Rest => false,
        }
    }

    fn item_in_protected(&self, id: LogicalItemId) -> bool {
        let Some(origin) = self.index.offset_of(id) else {
            return false;
        };
        let height = self.index.height(id).map(|h| h.0).unwrap_or(0.0);
        let start = (self.offset - PROTECTED_BAND_PX).max(0.0);
        let end = self.offset + self.viewport_height + PROTECTED_BAND_PX;
        origin < end && origin + height > start
    }

    fn refresh_anchor(&mut self) {
        match self.contact {
            ContactMode::Touch => {
                if self.anchor.is_none() {
                    self.anchor = self.hit_anchor(self.offset);
                }
            }
            ContactMode::Fling => {
                self.anchor = self.hit_anchor(self.offset);
            }
            ContactMode::Rest => {
                if self.anchor.is_none() {
                    self.anchor = self.hit_anchor(self.offset);
                }
            }
        }
        self.anchor = self.resolve_anchor();
    }

    fn hit_anchor(&self, content_y: f64) -> Option<ScrollAnchor> {
        let hit = self.index.item_at_offset(content_y)?;
        Some(ScrollAnchor {
            item: hit.id,
            intra_item_offset: hit.local.min(hit.height),
        })
    }

    fn resolve_anchor(&self) -> Option<ScrollAnchor> {
        let Some(anchor) = self.anchor else {
            return self.hit_anchor(self.offset);
        };
        if let Some((height, _)) = self.index.height(anchor.item) {
            return Some(ScrollAnchor {
                item: anchor.item,
                intra_item_offset: anchor.intra_item_offset.clamp(0.0, height),
            });
        }
        None
    }

    fn neighbour_anchor(&self, removed_index: usize) -> Option<ScrollAnchor> {
        if removed_index > 0 {
            if let Some((id, height, _)) = self.index.height_at(removed_index - 1) {
                return Some(ScrollAnchor {
                    item: id,
                    intra_item_offset: height,
                });
            }
        }
        if let Some((id, _, _)) = self.index.height_at(removed_index) {
            return Some(ScrollAnchor {
                item: id,
                intra_item_offset: 0.0,
            });
        }
        None
    }

    fn current_anchor_screen(&self) -> f64 {
        let Some(anchor) = self.resolve_anchor() else {
            return 0.0;
        };
        self.anchor_screen(anchor)
    }

    fn anchor_screen(&self, anchor: ScrollAnchor) -> f64 {
        let origin = self.index.offset_of(anchor.item).unwrap_or(0.0);
        origin - self.offset + anchor.intra_item_offset
    }

    fn screen_position(&self, id: LogicalItemId, intra: f64) -> f64 {
        let origin = self.index.offset_of(id).unwrap_or(0.0);
        origin - self.offset + intra
    }

    pub fn screen_position_of(&self, id: LogicalItemId) -> Option<f64> {
        let origin = self.index.offset_of(id)?;
        Some(origin - self.offset)
    }

    fn sync_shadow_epoch(&mut self) {
        if self.prefix.is_empty() {
            self.shadow_epoch = self.index.geometry_epoch();
        } else {
            self.shadow_epoch = GeometryEpoch(self.index.geometry_epoch().0.saturating_add(1));
        }
    }

    fn refresh_snapshots(&mut self) {
        self.prefix.reindex(&self.index);
        self.active = GeometrySnapshot::from_cache(
            &self.cache,
            &self.index,
            self.offset,
            self.origin_base,
            self.generation,
        );
        self.shadow = self.build_shadow_snapshot();
    }

    fn build_shadow_snapshot(&self) -> GeometrySnapshot {
        if self.prefix.is_empty() {
            let mut shadow = self.active.clone();
            shadow.epoch = self.shadow_epoch;
            return shadow;
        }
        let tiles: Vec<TileDescriptor> = self
            .cache
            .descriptors()
            .into_iter()
            .map(|mut tile| {
                if let Some(layout) = self.index.index_of(tile.first) {
                    tile.origin = self.index.origin_at(layout).unwrap_or(tile.origin)
                        + self.prefix.prefix_before(layout);
                    if let Some(delta) = self.prefix.delta_for(tile.first) {
                        tile.height += delta;
                    }
                    tile.epoch = self.shadow_epoch;
                }
                tile
            })
            .collect();
        GeometrySnapshot {
            epoch: self.shadow_epoch,
            extent: self.index.extent() + self.prefix.total_delta(),
            offset: self.shadow_offset(),
            origin_base: self.origin_base,
            tiles: tiles.into(),
            generation: self.generation,
        }
    }

    fn shadow_offset(&self) -> f64 {
        let Some(anchor) = self.resolve_anchor() else {
            return self.offset;
        };
        let Some(layout) = self.index.index_of(anchor.item) else {
            return self.offset;
        };
        let origin =
            self.index.origin_at(layout).unwrap_or(0.0) + self.prefix.prefix_before(layout);
        let height = self.index.height(anchor.item).map(|h| h.0).unwrap_or(0.0)
            + self.prefix.delta_for(anchor.item).unwrap_or(0.0);
        let intra = anchor.intra_item_offset.clamp(0.0, height.max(0.0));
        let screen = self.anchor_screen(anchor);
        (origin + intra - screen).max(0.0)
    }

    fn unchanged_outcome(&self) -> RemapOutcome {
        RemapOutcome {
            correction: GeometryCorrection::Unchanged,
            applied: false,
            deferred: false,
            hard_clamped: false,
            cap_hit: false,
            deceleration_requested: false,
            screen_velocity_before: self.velocity,
            screen_velocity_after: self.velocity,
            anchor_screen_before: self.current_anchor_screen(),
            anchor_screen_after: self.current_anchor_screen(),
            generation: self.generation,
            old_epoch: self.index.geometry_epoch(),
            new_epoch: self.index.geometry_epoch(),
            token: self.prefix.token(),
        }
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
        offset.clamp(0.0, self.max_offset())
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
    pub fn draft_commit(&self) -> Option<GeometryCommit> {
        if self.prefix.is_empty() {
            return None;
        }
        Some(GeometryCommit {
            old_epoch: self.index.geometry_epoch(),
            new_epoch: self.shadow_epoch,
            based_on_scroll_generation: self.scroll_generation,
            anchor: self.resolve_anchor()?,
            prefix_delta_map: self.prefix.clone(),
            new_extent: self.index.extent() + self.prefix.total_delta(),
        })
    }

    pub fn screen_of(&self, id: LogicalItemId, intra: f64) -> f64 {
        self.screen_position(id, intra)
    }
}
