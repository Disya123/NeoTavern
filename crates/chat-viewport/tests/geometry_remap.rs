use neotavern_chat_viewport::{
    AckResult, CommitError, ContactMode, DebtCaps, GeometryEpoch, HeightIndex, HeightKind,
    LogicalItemId, PredictorBudgets, PrefixDelta, PrefixDeltaMap, PrefixError, PresentDecision,
    ScrollAck, TileCache, TileFidelity, ViewportError, ViewportSession, PROTECTED_BAND_PX,
};

const N: u32 = 10_000;
const VIEWPORT: f64 = 800.0;
const DT_NS: u64 = 1_000_000_000 / 120;
const FLING: f64 = 10_000.0;
const GROW: f64 = 350.0;

fn mixed_height(i: u32) -> f64 {
    48.0 + f64::from(i % 7) * 12.0 + if i.is_multiple_of(11) { 80.0 } else { 0.0 }
}

fn lid(i: u32) -> LogicalItemId {
    LogicalItemId(10_000 + u64::from(i))
}

fn index_n(n: u32) -> HeightIndex {
    let mut index = HeightIndex::new();
    for i in 0..n {
        index
            .push(lid(i), mixed_height(i), HeightKind::Estimated)
            .unwrap();
    }
    index
}

fn session(index: HeightIndex) -> ViewportSession {
    ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(256, 4 * 1024 * 1024),
        VIEWPORT,
        12_000_000,
    )
}

fn fling_warm(vp: &mut ViewportSession, frames: u32) {
    vp.set_velocity(FLING);
    for _ in 0..frames {
        let _ = vp.present();
        vp.advance(DT_NS);
    }
    let _ = vp.present();
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

fn item_inside_viewport(vp: &ViewportSession) -> LogicalItemId {
    vp.index()
        .item_at_offset(vp.offset() + VIEWPORT * 0.5)
        .unwrap()
        .id
}

fn item_after_viewport(vp: &ViewportSession) -> LogicalItemId {
    let y = vp.offset() + VIEWPORT + PROTECTED_BAND_PX + 80.0;
    vp.index().item_at_offset(y).unwrap().id
}

fn grow(vp: &mut ViewportSession, id: LogicalItemId) -> neotavern_chat_viewport::RemapOutcome {
    let (estimated, _) = vp.index().height(id).unwrap();
    vp.commit_exact(id, estimated + GROW).unwrap()
}

#[test]
fn plus_350_before_viewport_preserves_c0_c1_at_ten_thousand_px_s() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    let id = item_before_viewport(&vp);
    let origin = vp.index().offset_of(id).unwrap();
    let height = vp.index().height(id).unwrap().0;
    assert!(
        origin + height <= vp.offset() - PROTECTED_BAND_PX + 1e-6,
        "fixture item is not fully above the protected band"
    );
    let vel = vp.velocity();
    let top = vp.index().item_at_offset(vp.offset()).unwrap().id;
    let screen_before = vp.screen_position_of(top).unwrap();
    let outcome = grow(&mut vp, id);
    assert!(outcome.applied);
    assert!(!outcome.deferred);
    assert!(!outcome.hard_clamped);
    assert!(outcome.position_continuous());
    assert!(outcome.velocity_continuous());
    assert!((vp.velocity() - vel).abs() < 1e-9);
    assert!((vp.screen_position_of(top).unwrap() - screen_before).abs() < 1e-6);
    assert_eq!(vp.index().height(id).unwrap().1, HeightKind::Exact);
    assert_eq!(vp.present().blank_px, 0.0);
}

#[test]
fn plus_350_inside_viewport_is_deferred_debt_at_ten_thousand_px_s() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    let id = item_inside_viewport(&vp);
    let (estimated, _) = vp.index().height(id).unwrap();
    let vel = vp.velocity();
    let outcome = grow(&mut vp, id);
    assert!(outcome.deferred);
    assert!(!outcome.applied);
    assert_eq!(vp.index().height(id).unwrap().0, estimated);
    assert!((vp.velocity() - vel).abs() < 1e-9);
    assert_ne!(vp.active_snapshot().epoch, vp.shadow_snapshot().epoch);
    assert_eq!(vp.present().blank_px, 0.0);
}

#[test]
fn plus_350_after_viewport_does_not_change_offset_or_velocity() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    let id = item_after_viewport(&vp);
    let offset = vp.offset();
    let vel = vp.velocity();
    let outcome = grow(&mut vp, id);
    assert!(outcome.applied);
    assert!(!outcome.hard_clamped);
    assert!(outcome.velocity_continuous());
    assert!((vp.offset() - offset).abs() < 1e-6);
    assert!((vp.velocity() - vel).abs() < 1e-9);
    assert_eq!(vp.index().height(id).unwrap().1, HeightKind::Exact);
}

#[test]
fn shrink_at_bottom_bound_retargets_and_may_clamp_velocity() {
    let mut vp = session(index_n(512));
    vp.teleport(vp.index().extent());
    let _ = vp.present();
    let last = lid(511);
    let (height, _) = vp.index().height(last).unwrap();
    let max_before = (vp.index().extent() - VIEWPORT).max(0.0);
    assert!((vp.offset() - max_before).abs() < 1e-6);
    let outcome = vp.commit_exact(last, (height - 200.0).max(1.0)).unwrap();
    assert!(outcome.applied);
    let max_after = (vp.index().extent() - VIEWPORT).max(0.0);
    assert!((vp.offset() - max_after).abs() < 1e-6);
    assert!(vp.offset() <= max_before + 1e-6);
    assert!(outcome.hard_clamped);
}

#[test]
fn reversal_during_pending_debt_does_not_double_apply() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    let id = item_inside_viewport(&vp);
    let (estimated, _) = vp.index().height(id).unwrap();
    assert!(grow(&mut vp, id).deferred);
    vp.set_velocity(-FLING);
    assert_eq!(vp.pending_debt().len(), 1);
    assert_eq!(vp.index().height(id).unwrap().0, estimated);
    for _ in 0..8 {
        assert_eq!(vp.present().blank_px, 0.0);
        vp.advance(DT_NS);
    }
    vp.teleport(vp.index().extent());
    let _ = vp.present();
    assert!(vp.pending_debt().is_empty());
    assert!((vp.index().height(id).unwrap().0 - (estimated + GROW)).abs() < 1e-9);
    assert_eq!(vp.index().height(id).unwrap().1, HeightKind::Exact);
}

#[test]
fn finger_down_anchor_is_under_finger_fling_uses_protected_band() {
    let mut vp = session(index_n(N));
    vp.teleport(4_000.0);
    let _ = vp.present();
    vp.finger_down(120.0);
    let under = vp.anchor().unwrap();
    let hit = vp.index().item_at_offset(vp.offset() + 120.0).unwrap();
    assert_eq!(under.item, hit.id);
    assert_eq!(vp.contact_mode(), ContactMode::Touch);
    vp.set_velocity(FLING);
    let fling_anchor = vp.anchor().unwrap();
    let band = vp.index().item_at_offset(vp.offset()).unwrap();
    assert_eq!(fling_anchor.item, band.id);
    assert_eq!(vp.contact_mode(), ContactMode::Fling);
}

#[test]
fn prepend_with_exact_height_keeps_logical_ids_and_c0() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 16);
    let stable = lid(500);
    let screen = vp.screen_position_of(stable).unwrap();
    let mut prepend = Vec::new();
    for i in 0..40u32 {
        prepend.push((LogicalItemId(u64::from(i)), 40.0, HeightKind::Estimated));
    }
    let prepended = vp.prepend(&prepend).unwrap();
    assert!(prepended.applied);
    assert!(prepended.position_continuous());
    assert!((vp.screen_position_of(stable).unwrap() - screen).abs() < 1e-6);
    assert_eq!(vp.index().item_at_offset(0.0).unwrap().id, LogicalItemId(0));
    assert_eq!(vp.index().height(stable).unwrap().1, HeightKind::Estimated);
    let after = item_after_viewport(&vp);
    let outcome = grow(&mut vp, after);
    assert!(outcome.applied);
    assert!(outcome.velocity_continuous());
    assert!(vp.index().height(stable).is_some());
    assert_eq!(vp.index().item_at_offset(0.0).unwrap().id, LogicalItemId(0));
}

#[test]
fn fallback_tile_replacement_is_single_epoch() {
    let mut vp = session(index_n(256));
    let frame = vp.present();
    assert_eq!(frame.decision, PresentDecision::Fallback);
    let span = vp.last_prediction().unwrap().visible.span;
    vp.replace_fallback(span).unwrap();
    let handoff = vp.compositor_handoff();
    assert!(handoff.uniform_epoch());
    assert!(handoff.generation.is_atomic());
    assert!(handoff
        .tiles
        .iter()
        .filter(|tile| span.contains(vp.index().index_of(tile.first).unwrap()))
        .all(|tile| tile.fidelity == TileFidelity::Full));
    assert_eq!(handoff.epoch, vp.index().geometry_epoch());
}

#[test]
fn stale_and_out_of_order_geometry_commits_are_rejected() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 16);
    let id = item_inside_viewport(&vp);
    assert!(grow(&mut vp, id).deferred);
    let draft = vp.draft_commit().unwrap();

    let mut stale = draft.clone();
    stale.old_epoch = GeometryEpoch(42);
    match vp.apply_commit(stale) {
        Err(ViewportError::Commit(CommitError::Stale)) => {}
        other => panic!("expected stale, got {other:?}"),
    }

    let mut out_of_order = draft.clone();
    out_of_order.new_epoch = out_of_order.old_epoch;
    match vp.apply_commit(out_of_order) {
        Err(ViewportError::Commit(CommitError::OutOfOrder)) => {}
        other => panic!("expected out of order, got {other:?}"),
    }

    let mut shadow = draft.clone();
    shadow.new_epoch = GeometryEpoch(shadow.old_epoch.0.saturating_add(99));
    match vp.apply_commit(shadow) {
        Err(ViewportError::Commit(CommitError::StaleShadow)) => {}
        other => panic!("expected stale shadow, got {other:?}"),
    }
}

#[test]
fn removed_anchor_is_replaced_by_nearest_stable_neighbour() {
    let mut vp = session(index_n(256));
    vp.teleport(1_200.0);
    let _ = vp.present();
    vp.finger_down(40.0);
    let removed = vp.anchor().unwrap();
    let idx = vp.index().index_of(removed.item).unwrap();
    let predecessor = vp.index().height_at(idx - 1).unwrap().0;
    let next = vp.remove_item(removed.item).unwrap().unwrap();
    assert_eq!(next.item, predecessor);
    assert!(vp.index().height(removed.item).is_none());
    assert_ne!(next.item, lid(255));
}

#[test]
fn debt_cap_records_telemetry_and_does_not_teleport() {
    let mut vp = ViewportSession::with_debt_caps(
        index_n(512),
        PredictorBudgets::default(),
        TileCache::new(256, 4 * 1024 * 1024),
        VIEWPORT,
        12_000_000,
        DebtCaps {
            items: 2,
            bytes: 2 * 64,
            pixels: 400.0,
        },
    );
    fling_warm(&mut vp, 12);
    let offset = vp.offset();
    let vis = vp.last_prediction().unwrap().visible.span;
    let mut cap_hit = false;
    for i in vis.start..vis.end {
        let id = vp.index().height_at(i).unwrap().0;
        let outcome = grow(&mut vp, id);
        cap_hit |= outcome.cap_hit;
    }
    assert!(cap_hit);
    assert!(vp.debt_stats().cap_hits >= 1);
    assert!((vp.offset() - offset).abs() < 1e-6);
    assert!(vp.deceleration_requested());
}

#[test]
fn scroll_ack_and_geometry_commit_do_not_apply_the_same_delta_twice() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    let id = item_before_viewport(&vp);
    let (estimated, _) = vp.index().height(id).unwrap();
    let token = vp.delta_token();
    let offset = vp.offset();
    assert_eq!(
        vp.ack_scroll(ScrollAck {
            scroll_generation: vp.scroll_generation(),
            token,
            base_offset: offset + GROW,
        }),
        AckResult::Applied
    );
    let outcome = vp.commit_exact(id, estimated + GROW).unwrap();
    assert!(outcome.applied);
    assert!((vp.offset() - (offset + GROW)).abs() < 1e-6);
    assert_eq!(
        vp.ack_scroll(ScrollAck {
            scroll_generation: vp.scroll_generation(),
            token,
            base_offset: offset + GROW * 2.0,
        }),
        AckResult::IgnoredAlreadyApplied
    );
    assert!((vp.offset() - (offset + GROW)).abs() < 1e-6);
}

#[test]
fn origin_rebase_does_not_change_screen_position_or_velocity() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 12);
    let id = item_inside_viewport(&vp);
    let screen = vp.screen_position_of(id).unwrap();
    let vel = vp.velocity();
    let offset = vp.offset();
    vp.rebase_origin(offset + 1_000_000.0);
    assert!((vp.screen_position_of(id).unwrap() - screen).abs() < 1e-9);
    assert!((vp.velocity() - vel).abs() < 1e-9);
    assert_eq!(vp.origin_base(), offset + 1_000_000.0);
    assert!(vp.scene_generation().is_atomic());
}

#[test]
fn geometry_tile_hit_test_semantics_generations_switch_atomically() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 16);
    let id = item_after_viewport(&vp);
    let outcome = grow(&mut vp, id);
    assert!(outcome.applied);
    assert!(outcome.generation.is_atomic());
    let snap = vp.active_snapshot();
    assert_eq!(snap.generation, outcome.generation);
    assert_eq!(snap.generation.geometry, snap.generation.tiles);
    assert_eq!(snap.generation.tiles, snap.generation.hit_test);
    assert_eq!(snap.generation.hit_test, snap.generation.semantics);
    assert!(snap.uniform_epoch());
    assert_eq!(snap.epoch, vp.index().geometry_epoch());
}

#[test]
fn screen_velocity_after_equals_before_outside_hard_clamp() {
    let mut vp = session(index_n(N));
    fling_warm(&mut vp, 24);
    for id in [item_before_viewport(&vp), item_after_viewport(&vp)] {
        let outcome = grow(&mut vp, id);
        assert!(
            outcome.velocity_continuous(),
            "C1 broken for {id:?}: {outcome:?}"
        );
        assert_eq!(
            outcome.screen_velocity_after,
            outcome.screen_velocity_before
        );
    }
}

#[test]
fn prefix_delta_map_rejects_overlap_and_non_monotonic_batches() {
    let index = index_n(32);
    let mut map = PrefixDeltaMap::default();
    let a = PrefixDelta {
        item: lid(2),
        estimated: 10.0,
        exact: 20.0,
        delta: 10.0,
    };
    map.insert(&index, a).unwrap();
    assert_eq!(map.insert(&index, a), Err(PrefixError::Overlap));
    let unsorted = [
        PrefixDelta {
            item: lid(8),
            estimated: 1.0,
            exact: 2.0,
            delta: 1.0,
        },
        PrefixDelta {
            item: lid(3),
            estimated: 1.0,
            exact: 2.0,
            delta: 1.0,
        },
    ];
    assert_eq!(
        map.extend_sorted(&index, &unsorted),
        Err(PrefixError::NonMonotonic)
    );
    let layout = index.index_of(lid(4)).unwrap();
    map.reindex(&index);
    let prefix = map.prefix_before(layout);
    assert!(prefix.is_finite());
}

#[test]
fn dual_snapshots_exist_and_compositor_sees_only_active() {
    let mut vp = session(index_n(256));
    fling_warm(&mut vp, 8);
    let dual = vp.dual_geometry();
    assert_eq!(dual.active.epoch, vp.active_snapshot().epoch);
    let id = item_inside_viewport(&vp);
    assert!(grow(&mut vp, id).deferred);
    let dual = vp.dual_geometry();
    assert_ne!(dual.active.epoch, dual.shadow.epoch);
    assert_eq!(vp.compositor_handoff().epoch, dual.active.epoch);
}
