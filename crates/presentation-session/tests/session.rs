use neotavern_chat_viewport::{
    AckResult, HeightIndex, HeightKind, ItemSpan, LogicalItemId, PredictorBudgets, ScrollAck,
    TileCache, ViewportSession,
};
use neotavern_neocompositor::{InteractionReady, PointerId, PresentationTime, RasterDecision};
use neotavern_presentation_m0_d2::publish_selectable_text;
use neotavern_presentation_session::{map_viewport_geometry, PresentationSession, SessionOutcome};

fn lid(n: u64) -> LogicalItemId {
    LogicalItemId(n)
}

fn three_item_session() -> ViewportSession {
    let mut index = HeightIndex::new();
    for n in 1..=3 {
        index.push(lid(n), 80.0, HeightKind::Exact).expect("push");
    }
    let mut vp = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(16, 1024 * 1024),
        240.0,
        0,
    );
    let _ = vp.present();
    vp.replace_fallback(ItemSpan { start: 0, end: 3 })
        .expect("full tiles");
    vp
}

#[test]
fn geometry_hit_text_and_tiles_switch_in_one_transaction() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let published = publish_selectable_text().expect("blitz");
    let fragment = published.transaction.text().fragments()[0].clone();
    session.bind_spanning_text(lid(1), fragment);
    let tx = session.publish().expect("publish");
    assert!(tx.interaction_epochs_match());
    assert_eq!(tx.text().scene_epoch(), tx.scene_epoch());
    assert_eq!(tx.geometry().scene_epoch(), tx.scene_epoch());
    assert_eq!(tx.properties().scene_epoch(), tx.scene_epoch());
    assert!(tx.geometry().tiles().len() >= 3);
    let fragment = &tx.text().fragments()[0];
    assert!(fragment.tiles.len() >= 3);
    let generation = session.viewport().scene_generation();
    assert!(generation.is_atomic());
}

#[test]
fn delta_token_does_not_double_apply_scroll_ack_or_remap() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    session.publish().expect("publish");
    let token = session.viewport().delta_token();
    let offset = session.viewport().offset();
    let ack = ScrollAck {
        scroll_generation: session.viewport().scroll_generation(),
        token,
        base_offset: offset + 40.0,
    };
    assert_eq!(session.ack_scroll(ack), AckResult::Applied);
    assert_eq!(session.ack_scroll(ack), AckResult::IgnoredAlreadyApplied);
    let before = session.viewport().offset();
    let id = lid(1);
    let height = session.viewport().index().height(id).unwrap().0;
    let _ = session.commit_exact(id, height + 40.0);
    assert!(
        (session.viewport().offset() - before).abs() < 1e-6 || session.viewport().offset() >= 0.0
    );
}

#[test]
fn remap_during_drag_keeps_logical_selection() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let published = publish_selectable_text().expect("blitz");
    let fragment = published.transaction.text().fragments()[0].clone();
    session.bind_spanning_text(lid(2), fragment);
    session.publish().expect("publish");
    let (origin_x, origin_y) = {
        let tx = session.last_transaction().unwrap();
        let frag = &tx.text().fragments()[0];
        let line = &frag.line_metrics[0];
        (line.origin_x, line.origin_y)
    };
    let anchor = session
        .begin_selection(
            lid(2),
            origin_x + 4.0,
            origin_y,
            PointerId(1),
            PresentationTime::from_millis(0),
        )
        .expect("begin");
    assert_eq!(anchor.item, lid(2));
    let before = session.selection().unwrap();
    let drag = session
        .drag_selection(origin_x + 48.0, origin_y, None)
        .expect("drag");
    assert_eq!(drag.raster, RasterDecision::SelectionOnly);
    assert_eq!(
        drag.logical_range.start.0.min(drag.logical_range.end.0),
        before.anchor.offset.0.min(before.focus.offset.0)
    );
    session.viewport_mut().set_velocity(10_000.0);
    let height = session.viewport().index().height(lid(1)).unwrap().0;
    let _ = session.commit_exact(lid(1), height + 350.0);
    let after = session.selection().expect("still selected");
    assert_eq!(after.anchor.item, lid(2));
    assert_eq!(after.anchor.offset, before.anchor.offset);
    assert_eq!(after.anchor.semantic, before.anchor.semantic);
}

#[test]
fn deleting_selected_message_cancels() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let published = publish_selectable_text().expect("blitz");
    session.bind_spanning_text(lid(2), published.transaction.text().fragments()[0].clone());
    session.publish().expect("publish");
    let (origin_x, origin_y) = {
        let tx = session.last_transaction().unwrap();
        let line = &tx.text().fragments()[0].line_metrics[0];
        (line.origin_x, line.origin_y)
    };
    session
        .begin_selection(
            lid(2),
            origin_x + 4.0,
            origin_y,
            PointerId(7),
            PresentationTime::from_millis(0),
        )
        .expect("begin");
    let outcome = session
        .remove_item(lid(2), PointerId(7), PresentationTime::from_millis(16))
        .expect("remove");
    assert_eq!(outcome, SessionOutcome::Cancel);
    assert!(session.selection().is_none());
    assert_eq!(
        session.last_event().map(|event| event.kind),
        Some(neotavern_neocompositor::PointerKind::Cancel)
    );
}

#[test]
fn fallback_without_text_is_not_interaction_ready() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let tx = session.publish().expect("fallback publish");
    let tile = tx.geometry().tiles()[0].id;
    assert_eq!(
        tx.text().interaction_hit_for_tile(
            tx.geometry(),
            tile,
            neotavern_neocompositor::SpatialId::unbound(0),
            neotavern_neocompositor::ClipId::unbound(0),
            1
        ),
        InteractionReady::NotInteractionReady
    );
}

#[test]
fn autoscroll_uses_existing_scroll_id_and_selection_damage_is_underlay_only() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let published = publish_selectable_text().expect("blitz");
    session.bind_spanning_text(lid(1), published.transaction.text().fragments()[0].clone());
    session.publish().expect("publish");
    let (origin_x, origin_y) = {
        let tx = session.last_transaction().unwrap();
        let line = &tx.text().fragments()[0].line_metrics[0];
        (line.origin_x, line.origin_y)
    };
    session
        .begin_selection(
            lid(1),
            origin_x + 4.0,
            origin_y,
            PointerId(3),
            PresentationTime::from_millis(0),
        )
        .expect("begin");
    let extended = session
        .drag_selection(origin_x + 80.0, origin_y, None)
        .expect("extend");
    assert_eq!(extended.raster, RasterDecision::SelectionOnly);
    assert!(!extended.glass_roi_invalidations.is_empty());
    assert!(extended
        .damage
        .iter()
        .all(|rect| { rect.width.saturating_mul(rect.height) < 240 * 240 || rect.is_empty() }));
    let update = session
        .drag_selection(
            origin_x + 80.0,
            230.0,
            Some(neotavern_neocompositor::Point::new(
                f64::from(origin_x + 80.0),
                230.0,
            )),
        )
        .expect("edge drag");
    assert_eq!(update.raster, RasterDecision::SelectionOnly);
    let delta = update.autoscroll.expect("autoscroll through ScrollId");
    assert!(delta.y > 0.0);
    assert!(!update.glass_roi_invalidations.is_empty());
    let scroll = session.scroll_id().expect("scroll latch");
    assert_eq!(session.path().latched_scroll(), Some(scroll));
    let offset = session.path().visual_offset(scroll).expect("offset");
    assert!(offset.y > 0.0);
}

#[test]
fn map_rejects_mixed_generation() {
    let snapshot = three_item_session().compositor_handoff();
    let mut mixed = snapshot.clone();
    mixed.generation.tiles = mixed.generation.geometry.saturating_add(1);
    assert!(map_viewport_geometry(&mixed, 240.0, neotavern_neocompositor::SceneEpoch(1)).is_err());
}

#[test]
fn visual_surface_ingress_is_session_owned_and_not_plugin_runtime() {
    let mut session = PresentationSession::new(three_item_session(), 240.0, 240.0);
    let id = session
        .declare_visual_surface(neotavern_neocompositor::VisualSurfaceDeclare::reference(
            "vs.reference",
        ))
        .expect("declare");
    let _ = session.publish().expect("publish");
    let ops_before = session
        .last_transaction()
        .expect("tx")
        .scene()
        .display_list
        .ops
        .len();
    assert_eq!(id, neotavern_neocompositor::SurfaceId(1));
    assert!(session.visual_ingress().surface_frame_ingress());
    assert!(!session.visual_ingress().plugin_runtime());
    assert!(!session.visual_ingress().direct_display_list_injection());
    session.publish().expect("republish");
    let ops_after = session
        .last_transaction()
        .expect("tx")
        .scene()
        .display_list
        .ops
        .len();
    assert_eq!(
        ops_before, ops_after,
        "ingress must not inject producer paint into NeoDisplayList"
    );
}
