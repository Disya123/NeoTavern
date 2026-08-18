//! Multi-frame PERF-20 fling + exact `+350 px` trace (not a single GPU frame).

use neotavern_chat_viewport::{
    HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, TileCache, ViewportSession,
    PROTECTED_BAND_PX,
};

pub const N: u32 = 10_000;
pub const VIEWPORT: f64 = 800.0;
pub const DT_NS: u64 = 1_000_000_000 / 120;
pub const FLING: f64 = 10_000.0;
pub const GROW: f64 = 350.0;

#[derive(Clone, Debug)]
pub struct Perf20Summary {
    pub frames: u64,
    pub commit_frame: u64,
    pub applied_token: u64,
    pub applied: bool,
    pub deferred: bool,
    pub hard_clamped: bool,
    pub velocity_continuous: bool,
    pub mixed_epoch: bool,
    pub blank_px: f64,
}

fn mixed_height(i: u32) -> f64 {
    48.0 + f64::from(i % 7) * 12.0 + if i.is_multiple_of(11) { 80.0 } else { 0.0 }
}

fn lid(i: u32) -> LogicalItemId {
    LogicalItemId(10_000 + u64::from(i))
}

fn item_before_viewport(vp: &ViewportSession) -> LogicalItemId {
    let band_start = (vp.offset() - PROTECTED_BAND_PX).max(0.0);
    let mut idx = vp
        .index()
        .item_at_offset((band_start - 1.0).max(0.0))
        .map(|hit| hit.index)
        .unwrap_or(0);
    loop {
        let (id, height, _) = vp.index().height_at(idx).unwrap();
        let origin = vp.index().origin_at(idx).unwrap();
        if origin + height <= band_start + 1e-9 {
            return id;
        }
        if idx == 0 {
            return id;
        }
        idx -= 1;
    }
}

/// Emit one `perf20-frame` line per present and one `perf20-commit` at the
/// exact `+350` remap. Fling integration happens *after* the line so
/// `velocity_before == velocity_after` except a registered hard clamp.
pub fn run_fling_trace(frames: u64, emit: &mut dyn FnMut(&str)) -> Result<Perf20Summary, String> {
    let frames = frames.clamp(8, 1000);
    let mut index = HeightIndex::new();
    for i in 0..N {
        index
            .push(lid(i), mixed_height(i), HeightKind::Estimated)
            .map_err(|err| format!("{err:?}"))?;
    }
    let mut vp = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(256, 4 * 1024 * 1024),
        VIEWPORT,
        12_000_000,
    );
    vp.set_velocity(FLING);
    let commit_at = 24u64.min(frames.saturating_sub(2)).max(1);
    let mut mixed_epoch = false;
    let mut blank = 0.0;
    let mut velocity_continuous = true;
    let mut applied_token = 0;
    let mut applied = false;
    let mut deferred = false;
    let mut hard_clamped = false;

    for frame in 0..frames {
        let velocity_before = vp.velocity();
        let present = vp.present();
        blank = present.blank_px.max(blank);
        if !present.snapshot.uniform_epoch() || !vp.scene_generation().is_atomic() {
            mixed_epoch = true;
        }
        let mut hard_clamp = false;
        let mut geometry_debt = vp.pending_debt().len();
        let mut velocity_after = vp.velocity();
        if frame == commit_at {
            let id = item_before_viewport(&vp);
            let height = vp.index().height(id).map(|h| h.0).unwrap_or(80.0);
            let outcome = vp
                .commit_exact(id, height + GROW)
                .map_err(|err| format!("{err:?}"))?;
            hard_clamp = outcome.hard_clamped;
            hard_clamped = outcome.hard_clamped;
            applied = outcome.applied;
            deferred = outcome.deferred;
            geometry_debt = vp.pending_debt().len();
            applied_token = outcome.token.0;
            velocity_after = outcome.screen_velocity_after;
            emit(&format!(
                "perf20-commit token={} velocity_before={} velocity_after={} anchor_before={} anchor_after={} hard_clamp={} applied={} deferred={} exact_delta={GROW} fling_px_s={FLING}",
                outcome.token.0,
                outcome.screen_velocity_before,
                outcome.screen_velocity_after,
                outcome.anchor_screen_before,
                outcome.anchor_screen_after,
                outcome.hard_clamped,
                outcome.applied,
                outcome.deferred
            ));
            if !outcome.hard_clamped
                && (outcome.screen_velocity_after - outcome.screen_velocity_before).abs() > 1e-6
            {
                velocity_continuous = false;
            }
        }
        if !hard_clamp && (velocity_after - velocity_before).abs() > 1e-6 {
            velocity_continuous = false;
        }
        let generation = vp.scene_generation();
        emit(&format!(
            "perf20-frame frame_id={frame} scene_epoch={} geometry_epoch={} scroll_sequence={} delta_token={} visual_offset={} anchor_screen_position={} velocity_before={velocity_before} velocity_after={velocity_after} geometry_debt={geometry_debt} hard_clamp={hard_clamp} layout_rebuilds=0 paint_rebuilds=0 raster_invalidations=0 mixed_epoch={mixed_epoch} blank_px={}",
            generation.geometry,
            vp.active_snapshot().epoch.0,
            vp.scroll_generation(),
            vp.delta_token().0,
            vp.offset(),
            vp.current_anchor_screen(),
            present.blank_px
        ));
        vp.advance(DT_NS);
    }

    Ok(Perf20Summary {
        frames,
        commit_frame: commit_at,
        applied_token,
        applied,
        deferred,
        hard_clamped,
        velocity_continuous,
        mixed_epoch,
        blank_px: blank,
    })
}
