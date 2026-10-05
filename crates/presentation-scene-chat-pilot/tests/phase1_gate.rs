//! ADR-0057 Phase 1 gate (behavioral, INV-7): the chat-screen pilot runs
//! the full journey against the REAL Kernel in an isolated data root —
//! open → caret/selection editing → send → stream render → durable state
//! verified by reopening the SQLite root → restart restores the draft.
//! Snapshot invariants ride along: single geometry (hit-test, caret
//! round-trip, no NaN), stable scene ids, deterministic digest.

use neotavern_presentation_chat::{ChatSession, ProductWire, StreamFrame};
use neotavern_presentation_kernel_wire::{seed_parity_workspace, KernelProductWire};
use neotavern_presentation_scene::hit::HitTarget;
use neotavern_presentation_scene::{CursorOp, FieldId, SceneAction};
use neotavern_presentation_scene_chat_pilot::{ChatPilot, ACTION_SEND};

const VIEWPORT: (f32, f32) = (900.0, 700.0);

/// Pumps the live stream until it ends (mirrors the parity harness).
fn pump_stream<W: ProductWire>(session: &mut ChatSession<W>) -> Vec<StreamFrame> {
    let mut frames = Vec::new();
    for _ in 0..64 {
        match session.poll_stream(500) {
            Ok(StreamFrame::Timeout) => break,
            Ok(frame @ StreamFrame::Event { .. }) => frames.push(frame),
            Ok(frame @ (StreamFrame::Terminal | StreamFrame::Error(_))) => {
                frames.push(frame);
                break;
            }
            Err(err) => panic!("poll_stream failed: {err}"),
        }
    }
    frames
}

fn assert_no_nan(pilot_snapshot: &neotavern_presentation_scene::FrameSnapshot) {
    for node in &pilot_snapshot.nodes {
        let r = node.rect;
        assert!(
            r.x.is_finite() && r.y.is_finite() && r.w.is_finite() && r.h.is_finite(),
            "INV-2 sanity: node rect must never be NaN/inf, got {r:?} for {:?}",
            node.id
        );
    }
}

#[test]
fn phase1_chat_pilot_journey_on_real_kernel() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path().to_path_buf();
    let _keep = &root; // the tempdir lives until the end of the test

    let mut wire = KernelProductWire::open(&root_path).expect("kernel wire opens");
    let chat = seed_parity_workspace(&mut wire, "Pilot", 3).expect("seed");

    // --- open ---------------------------------------------------------------
    let mut session = ChatSession::open(wire, Some(&chat)).expect("session opens");
    let mut pilot = ChatPilot::new();
    pilot.project(&session);
    let snap = pilot.frame(VIEWPORT);
    assert_no_nan(&snap);

    // The seeded history is visible and the composer starts empty.
    let state = session.state();
    assert!(!state.messages.is_empty(), "seeded history is visible");
    assert!(state.composer_text.is_empty());

    // --- caret/selection editing through the single editing model ----------
    let before_caret = pilot.composer().cursor().caret;
    assert_eq!(before_caret, 0);
    pilot.apply_composer_op(&mut session, CursorOp::Insert { batch: 0 });
    pilot.composer().queue_insert("hello pilot");
    pilot.apply_composer_op(&mut session, CursorOp::Insert { batch: 0 });
    let typed = session.state().composer_text.clone();
    assert_eq!(
        typed, "hello pilot",
        "typed text routes through the session truth"
    );

    // Selection then replace: select all → overwrite with a longer draft.
    pilot.apply_composer_op(&mut session, CursorOp::SelectAll);
    pilot.composer().queue_insert("hello from the scene pilot");
    pilot.apply_composer_op(&mut session, CursorOp::Insert { batch: 0 });
    assert_eq!(
        session.state().composer_text,
        "hello from the scene pilot",
        "typing replaces the selection (PL-01 stays fixed at the pilot level)"
    );

    // --- single geometry: caret round-trips through the snapshot ----------
    let snap = pilot.frame(VIEWPORT);
    assert_no_nan(&snap);
    let frame = &snap.inputs[&FieldId::Composer];
    let caret = frame.caret_rect.expect("caret geometry exists");
    let mid_y = caret.y + caret.h * 0.5;
    match neotavern_presentation_scene::hit_test(&snap, caret.x + caret.w * 0.5, mid_y) {
        HitTarget::Field {
            field: FieldId::Composer,
            caret_byte,
            ..
        } => {
            assert_eq!(caret_byte, Some(frame.cursor.expect("cursor").caret),
                "clicking at the caret resolves to the caret byte — hit-test reads the same shaped text");
        }
        other => panic!("expected a composer field hit, got {other:?}"),
    }

    // --- send: the button hit routes through the session -------------------
    let send_rect = snap
        .node(pilot.send_button_id())
        .expect("send button in snapshot")
        .rect;
    let target = pilot.handle_hit(
        &mut session,
        &snap,
        send_rect.x + send_rect.w * 0.5,
        send_rect.y + send_rect.h * 0.5,
    );
    assert!(
        matches!(target, HitTarget::Action { action, .. } if action == SceneAction(ACTION_SEND))
    );
    pump_stream(&mut session);

    let state = session.state();
    assert!(
        state
            .messages
            .iter()
            .any(|m| m.content == "hello from the scene pilot"),
        "the sent message is in the route state"
    );
    assert!(
        state
            .messages
            .iter()
            .any(|m| m.role == contracts_generated::generated::MessageRole::Assistant),
        "the stream completed into a durable assistant row"
    );
    assert!(
        state.streaming_text.is_empty(),
        "streaming cleared after terminal"
    );

    // --- snapshot invariants after the round trip --------------------------
    pilot.project(&session);
    let snap = pilot.frame(VIEWPORT);
    assert_no_nan(&snap);
    let digest_a = snap.digest();

    // Stable ids: the same rows keep their nodes across projections.
    let digest_b = pilot.frame(VIEWPORT).digest();
    assert_eq!(
        digest_a, digest_b,
        "same state → same digest (refactor-stability seam)"
    );

    // Editing moves the digest (geometry/semantics changed).
    pilot.composer().queue_insert("x");
    pilot.apply_composer_op(&mut session, CursorOp::Insert { batch: 0 });
    pilot.project(&session);
    let digest_c = pilot.frame(VIEWPORT).digest();
    assert_ne!(digest_a, digest_c, "changed state → changed digest");

    // --- durable state verified by REOPENING the data root ----------------
    let unsent = "unsent after the journey";
    session.set_composer_text(unsent).expect("draft save");
    drop(session); // releases the kernel's SQLite connection; root stays alive

    let wire = KernelProductWire::open(&root_path).expect("kernel reopens");
    let mut reopened = ChatSession::open(wire, Some(&chat)).expect("session reopens");
    let state = reopened.state();
    assert!(
        state
            .messages
            .iter()
            .any(|m| m.content == "hello from the scene pilot"),
        "the sent message is durable in SQLite, not just in memory"
    );
    assert!(
        state
            .messages
            .iter()
            .any(|m| m.role == contracts_generated::generated::MessageRole::Assistant),
        "the assistant answer is durable too"
    );
    assert_eq!(
        state.composer_text, unsent,
        "restart rehydration restored the unsent draft (drafts.list path)"
    );

    // The reopened session projects cleanly onto a fresh pilot.
    let mut pilot = ChatPilot::new();
    pilot.project(&reopened);
    let snap = pilot.frame(VIEWPORT);
    assert_no_nan(&snap);
    let frame = &snap.inputs[&FieldId::Composer];
    let caret = frame.caret_rect.expect("caret geometry after reopen");
    assert!(caret.h > 0.0);
}

#[test]
fn send_button_is_hit_first_and_background_misses() {
    let mut wire = KernelProductWire::open(tempfile::tempdir().expect("tempdir").path())
        .expect("kernel wire opens");
    let chat = seed_parity_workspace(&mut wire, "Hits", 1).expect("seed");
    let mut session = ChatSession::open(wire, Some(&chat)).expect("session opens");
    let mut pilot = ChatPilot::new();
    pilot.project(&session);
    let snap = pilot.frame(VIEWPORT);

    let rect = snap.node(pilot.send_button_id()).expect("send button").rect;
    match neotavern_presentation_scene::hit_test(
        &snap,
        rect.x + rect.w * 0.5,
        rect.y + rect.h * 0.5,
    ) {
        HitTarget::Action { action, .. } => assert_eq!(action, SceneAction(ACTION_SEND)),
        other => panic!("send button must hit as an action, got {other:?}"),
    }
    assert_eq!(
        neotavern_presentation_scene::hit_test(&snap, -1.0, -1.0),
        HitTarget::Nothing,
        "outside the frame hits nothing"
    );
    let _ = ACTION_SEND;
}
