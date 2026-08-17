use neotavern_chat_viewport::{
    GeometryCorrection, HeightIndex, HeightKind, ItemSpan, LogicalItemId, PredictorBudgets,
    PrepAccept, PrepPriority, PreparationQueue, PresentDecision, TileCache, TileFidelity,
    TileInsert, ViewportSession,
};

const N: u32 = 10_000;
const VIEWPORT: f64 = 800.0;
const DT_NS: u64 = 1_000_000_000 / 120;
const FLING: f64 = 10_000.0;

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

fn session(index: HeightIndex, item_cap: usize, byte_cap: usize) -> ViewportSession {
    ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(item_cap, byte_cap),
        VIEWPORT,
        12_000_000,
    )
}

#[test]
fn ten_thousand_mixed_height_offset_lookup_is_log_n() {
    let index = index_n(N);
    assert_eq!(index.len(), N as usize);
    let mut last_origin = 0.0;
    for i in [0u32, 1, 17, 99, 500, 4096, 9999] {
        let hit = index
            .item_at_offset(index.offset_of(lid(i)).unwrap())
            .unwrap();
        assert_eq!(hit.id, lid(i));
        assert_eq!(hit.index, i as usize);
        assert!(hit.origin + 1e-9 >= last_origin);
        last_origin = hit.origin;
        let again = index.offset_of(lid(i)).unwrap();
        assert!((again - hit.origin).abs() < 1e-9);
    }
    for step in 0..200 {
        let offset = (step as f64) * (index.extent() / 200.0);
        let hit = index.item_at_offset(offset).unwrap();
        assert!(offset + 1e-6 >= hit.origin);
        assert!(offset < hit.origin + hit.height + 1e-6 || hit.index + 1 == index.len());
    }
}

#[test]
fn prefix_height_update_shifts_later_offsets() {
    let mut index = index_n(N);
    let last = lid(N - 1);
    let before = index.offset_of(last).unwrap();
    let (old, _) = index.height(lid(0)).unwrap();
    index
        .set_height(lid(0), old + 20.0, HeightKind::Exact)
        .unwrap();
    let after = index.offset_of(last).unwrap();
    assert!((after - before - 20.0).abs() < 1e-6);
    assert_eq!(index.item_at_offset(0.0).unwrap().id, lid(0));
}

#[test]
fn cold_fling_ten_thousand_px_s_has_zero_blank_and_does_not_wait() {
    let mut vp = session(index_n(N), 256, 4 * 1024 * 1024);
    vp.set_velocity(FLING);
    for _ in 0..120 {
        let frame = vp.present();
        assert_eq!(frame.blank_px, 0.0);
        assert!(!frame.waited_on_producer);
        assert_ne!(frame.decision, PresentDecision::Clamp);
        vp.advance(DT_NS);
    }
    assert!(vp.offset() > 0.0);
}

#[test]
fn sharp_reversal_keeps_trailing_coverage() {
    let mut vp = session(index_n(N), 256, 4 * 1024 * 1024);
    vp.set_velocity(FLING);
    for _ in 0..40 {
        let _ = vp.present();
        vp.advance(DT_NS);
    }
    let ahead = vp.last_prediction().unwrap().ahead_px;
    vp.set_velocity(-FLING);
    let frame = vp.present();
    assert_eq!(frame.blank_px, 0.0);
    let behind = vp.last_prediction().unwrap().behind_px;
    assert!(behind + 1e-6 >= ahead.min(PredictorBudgets::default().brake_px));
    for _ in 0..40 {
        assert_eq!(vp.present().blank_px, 0.0);
        vp.advance(DT_NS);
    }
}

#[test]
fn teleport_and_prepend_keep_logical_ids() {
    let mut vp = session(index_n(N), 256, 4 * 1024 * 1024);
    let stable = lid(500);
    let before = vp.index().height(stable).unwrap();
    vp.teleport(vp.index().extent());
    assert_eq!(vp.index().height(stable).unwrap(), before);
    assert_eq!(vp.present().blank_px, 0.0);
    let mut prepend = Vec::new();
    for i in 0..100u32 {
        prepend.push((LogicalItemId(u64::from(i)), 40.0, HeightKind::Estimated));
    }
    vp.index_mut().prepend(&prepend).unwrap();
    assert_eq!(vp.index().height(stable).unwrap(), before);
    assert_eq!(vp.index().item_at_offset(0.0).unwrap().id, LogicalItemId(0));
    assert!(vp.index().offset_of(stable).unwrap() > 0.0);
}

#[test]
fn stale_preparation_is_cancelled_latest_range_wins() {
    let mut queue = PreparationQueue::new(1);
    let a = ItemSpan { start: 0, end: 8 };
    let b = ItemSpan { start: 20, end: 40 };
    assert_eq!(
        queue.submit(a, 1, PrepPriority::Speculative),
        PrepAccept::Queued
    );
    match queue.submit(b, 2, PrepPriority::Visible) {
        PrepAccept::Coalesced { .. } => {}
        other => panic!("expected coalesced, got {other:?}"),
    }
    assert_eq!(queue.pending().unwrap().generation, 2);
    assert_eq!(
        queue.submit(a, 1, PrepPriority::Speculative),
        PrepAccept::Stale
    );
    assert!(queue.cancel_stale(3));
    assert!(queue.pending().is_none());
    assert!(queue.stats().high_water_items <= 1);
    assert!(queue.stats().cancelled >= 2);
}

#[test]
fn cache_pressure_evicts_overscan_not_above_caps() {
    let index = index_n(200);
    let mut cache = TileCache::new(8, 8 * 4096);
    cache.set_fling(true);
    cache.insert_span(&index, ItemSpan { start: 0, end: 3 }, TileFidelity::Full);
    cache.pin_span(&index, ItemSpan { start: 0, end: 3 });
    for start in (10..80).step_by(1) {
        let _ = cache.insert_span(
            &index,
            ItemSpan {
                start,
                end: start + 1,
            },
            TileFidelity::Fallback,
        );
    }
    assert!(cache.len() <= 8);
    assert!(cache.bytes() <= 8 * 4096);
    assert!(cache.stats().evictions > 0);
    assert!(cache.stats().high_water_items <= 8);
    assert!(cache.covering(lid(0)).is_some());
    assert!(cache.covering(lid(1)).is_some());
}

#[test]
fn overscan_miss_uses_fallback_geometry_with_zero_blank() {
    let mut vp = session(index_n(N), 64, 512 * 1024);
    let frame = vp.present();
    assert_eq!(frame.blank_px, 0.0);
    assert!(!frame.waited_on_producer);
    assert_eq!(frame.decision, PresentDecision::Fallback);
    assert!(!frame.snapshot.tiles.is_empty());
    assert!(frame
        .snapshot
        .tiles
        .iter()
        .all(|tile| tile.fidelity == TileFidelity::Fallback));
}

#[test]
fn preparation_queue_high_water_stays_at_cap() {
    let mut queue = PreparationQueue::new(1);
    for g in 1..80u64 {
        let _ = queue.submit(
            ItemSpan {
                start: g as usize,
                end: g as usize + 4,
            },
            g,
            PrepPriority::Speculative,
        );
    }
    assert_eq!(queue.stats().high_water_items, 1);
    assert_eq!(queue.pending().map(|job| job.generation), Some(79));
}

#[test]
fn estimated_to_exact_plus_350_defers_inside_protected_fling() {
    let mut vp = session(index_n(256), 64, 1024 * 1024);
    vp.set_velocity(FLING);
    let _ = vp.present();
    vp.advance(DT_NS);
    let _ = vp.present();
    let hit = vp.index().item_at_offset(vp.offset()).unwrap();
    let (estimated, kind) = vp.index().height(hit.id).unwrap();
    assert_eq!(kind, HeightKind::Estimated);
    let epoch = vp.index().geometry_epoch();
    let outcome = vp.commit_exact(hit.id, estimated + 350.0).unwrap();
    assert_eq!(outcome.correction, GeometryCorrection::Deferred);
    assert!(outcome.deferred);
    assert!(!outcome.applied);
    assert!((outcome.screen_velocity_after - outcome.screen_velocity_before).abs() < 1e-9);
    assert_eq!(vp.index().height(hit.id).unwrap().0, estimated);
    assert_eq!(vp.index().height(hit.id).unwrap().1, HeightKind::Estimated);
    assert_eq!(vp.index().geometry_epoch(), epoch);
    assert_eq!(vp.pending_debt().len(), 1);
    assert_ne!(vp.active_snapshot().epoch, vp.shadow_snapshot().epoch);
}

#[test]
fn protected_band_item_is_not_replaced_during_fling() {
    let mut vp = session(index_n(256), 64, 1024 * 1024);
    vp.set_velocity(FLING);
    let _ = vp.present();
    vp.advance(DT_NS);
    let _ = vp.present();
    let hit = vp.index().item_at_offset(vp.offset()).unwrap();
    let before = vp.cache().covering(hit.id).unwrap();
    let (estimated, _) = vp.index().height(hit.id).unwrap();
    let (outcome, insert) = vp.commit_exact_insert(hit.id, estimated + 350.0).unwrap();
    assert_eq!(outcome.correction, GeometryCorrection::Deferred);
    assert_eq!(insert, TileInsert::Pinned);
    let after = vp.cache().covering(hit.id).unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.height, before.height);
    assert_eq!(vp.present().blank_px, 0.0);
}

#[test]
fn compositor_handoff_is_tiles_and_geometry_only() {
    let mut vp = session(index_n(128), 64, 1024 * 1024);
    let _ = vp.present();
    let handoff = vp.compositor_handoff();
    assert_eq!(handoff.epoch, vp.index().geometry_epoch());
    assert_eq!(handoff.extent, vp.index().extent());
    assert!(handoff.generation.is_atomic());
    assert!(!handoff.tiles.is_empty());
    for tile in handoff.tiles.iter() {
        assert!(tile.height > 0.0);
        assert!(vp.index().height(tile.first).is_some());
    }
}
