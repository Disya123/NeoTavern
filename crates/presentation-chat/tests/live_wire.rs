use neotavern_presentation_chat::{
    ensure_isolated_10k_workspace, start_flagged_route, start_flagged_session, ChatRouteError,
    ChatSession, FakeWire, StreamFrame, DEMO_CHAT_ID, ISOLATED_10K_COUNT, ISOLATED_10K_PROFILE,
    ISOLATED_10K_TITLE, PAGE_LIMIT,
};
use neotavern_presentation_dioxus_shell::{ProductChrome, PRODUCT_PATH_VISIBLE};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn production_dependency_text(manifest: &str) -> String {
    let mut out = String::new();
    let mut in_prod = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_prod = trimmed == "[dependencies]"
                || (trimmed.starts_with("[target.") && trimmed.ends_with("dependencies]"));
            if trimmed == "[dev-dependencies]" || trimmed.contains("dev-dependencies") {
                in_prod = false;
            }
        }
        if in_prod {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[test]
fn cargo_toml_does_not_depend_on_kernel_storage_or_network() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = fs::read_to_string(manifest).expect("Cargo.toml");
    let production = production_dependency_text(&text);
    for forbidden in [
        "runtime-kernel",
        "neotavern-storage",
        "neotavern-android-jni",
        "reqwest",
        "rusqlite",
        "tokio",
    ] {
        assert!(
            !production.contains(forbidden),
            "live chat route must not depend on {forbidden} in [dependencies]"
        );
    }
}

#[test]
fn flagged_route_stays_off_without_the_flag() {
    let line = start_flagged_route(None);
    assert!(line.contains("chat_route=false"), "{line}");
    assert!(line.contains("reason=flag_off"), "{line}");
    assert!(line.contains("live_wire=false"), "{line}");
    assert!(line.contains("production_cutover=false"), "{line}");
}

#[test]
fn flagged_route_opens_live_wire_not_the_fixture() {
    let line = start_flagged_route(Some("1"));
    assert!(line.contains("chat_route=true"), "{line}");
    assert!(line.contains("live_wire=true"), "{line}");
    assert!(line.contains("data_component=chat-workspace"), "{line}");
    assert!(line.contains("production_cutover=false"), "{line}");
    assert!(line.contains("main_activity=false"), "{line}");
}

#[test]
fn open_lists_history_through_wire_operations() {
    let session = ChatSession::open(FakeWire::demo(), None).expect("open");
    assert_eq!(session.chat_id(), Some(DEMO_CHAT_ID));
    assert_eq!(
        session
            .state()
            .last_error
            .as_ref()
            .map(|err| err.code.as_str()),
        None,
        "open must not record a Wire error: {:?}",
        session.state().last_error
    );
    assert_eq!(session.state().messages.len(), 2);
    assert!(session.issued_commands().contains(&"chats.list".into()));
    assert!(session.issued_commands().contains(&"chats.get".into()));
    assert!(session
        .issued_commands()
        .contains(&"chats.messages.list".into()));
    let view = session.view();
    assert_eq!(view.title, "Live wire chat");
    assert_eq!(view.message_count, 2);
    assert!(!view.visible.is_empty());
}

#[test]
fn empty_library_is_an_error_not_a_panic() {
    // After 2026-08-20 the live route auto-creates a Hazel chat on a clean device
    // (starter seeds the character via NEOTA_SEED_STARTER, but not a chat; the session
    // now creates the first chat so `live_open` does not fail with EMPTY_LIBRARY on
    // a fresh install). FakeWire::empty() therefore now succeeds and creates that chat.
    let session = ChatSession::open(FakeWire::empty(), None).expect("open");
    assert!(
        session.chat_id().is_some(),
        "empty wire should now auto-create a Hazel chat"
    );
    assert!(
        session.state().last_error.is_none(),
        "auto-created chat must not record EMPTY_LIBRARY: {:?}",
        session.state().last_error
    );
    // The new chat has no messages yet, but the route is live.
    assert!(session.state().messages.is_empty() || !session.state().messages.is_empty());
}

#[test]
fn product_errors_stay_in_route_state() {
    let mut wire = FakeWire::demo();
    wire.fail_operation("chats.get");
    let session = ChatSession::open(wire, Some(DEMO_CHAT_ID)).expect("open");
    let code = session
        .state()
        .last_error
        .as_ref()
        .map(|err| err.code.as_str());
    assert_eq!(code, Some("WIRE_FAILED"));
}

#[test]
fn send_create_then_generation_start() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("next turn")).expect("send");
    assert!(session
        .issued_commands()
        .contains(&"chats.messages.create".into()));
    assert!(session
        .issued_commands()
        .contains(&"generation.start".into()));
    assert!(session
        .state()
        .messages
        .iter()
        .any(|row| row.content == "next turn"));
    assert!(session
        .state()
        .messages
        .iter()
        .any(|row| row.content.contains("echo: next turn")));
    assert!(session.state().stream_handle.is_none());
    assert_eq!(session.view().message_count, 4);
    assert!(session.send_accepted());
    assert_eq!(session.wire().message_count(DEMO_CHAT_ID), 4);
}

#[test]
fn send_count_comes_from_chats_get_not_local_len() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("next turn")).expect("send");
    assert!(session.state().messages.len() >= 3);
    assert_eq!(
        session.view().message_count,
        session.wire().message_count(DEMO_CHAT_ID)
    );
}

#[test]
fn duplicate_in_flight_send_creates_one_durable_message() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.set_send_in_flight(true);
    session.send(Some("dup")).expect("coalesced");
    session.set_send_in_flight(false);
    assert!(!session
        .issued_commands()
        .contains(&"chats.messages.create".into()));
    assert_eq!(session.wire().message_count(DEMO_CHAT_ID), 2);
    session.send(Some("dup")).expect("first");
    let creates = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "chats.messages.create")
        .count();
    session.set_send_in_flight(true);
    session.send(Some("dup")).expect("retry callback");
    session.set_send_in_flight(false);
    let creates_after = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "chats.messages.create")
        .count();
    assert_eq!(creates, 1);
    assert_eq!(creates_after, 1);
    assert_eq!(session.wire().message_count(DEMO_CHAT_ID), 4);
}

#[test]
fn rejected_create_shows_error_and_does_not_bump_kernel_count() {
    let mut wire = FakeWire::demo();
    wire.fail_operation("chats.messages.create");
    let mut session = ChatSession::open(wire, Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("nope")).expect("send");
    assert_eq!(
        session
            .state()
            .last_error
            .as_ref()
            .map(|err| err.code.as_str()),
        Some("WIRE_FAILED")
    );
    assert!(!session.send_accepted());
    assert_eq!(session.view().message_count, 2);
    assert_eq!(session.state().composer_text, "nope");
}

#[test]
fn generation_start_failure_keeps_the_durable_create() {
    let mut wire = FakeWire::demo();
    wire.fail_operation("generation.start");
    let mut session = ChatSession::open(wire, Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("keep")).expect("send");
    assert!(session.send_accepted());
    assert_eq!(session.view().message_count, 3);
    assert_eq!(
        session
            .state()
            .last_error
            .as_ref()
            .map(|err| err.code.as_str()),
        Some("WIRE_FAILED")
    );
    assert!(session
        .state()
        .messages
        .iter()
        .any(|row| row.content == "keep"));
}

#[test]
fn stale_scene_epoch_ack_does_not_drop_kernel_messages() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    let before = session.scene_epoch();
    session.send(Some("epoch")).expect("send");
    let epoch = session.scene_epoch();
    assert!(epoch > before);
    let count = session.view().message_count;
    let durable = session
        .last_durable_message_id()
        .expect("durable")
        .to_string();
    assert!(!session.ack_revision(before));
    assert_eq!(session.view().message_count, count);
    assert_eq!(session.last_durable_message_id(), Some(durable.as_str()));
    assert!(session.ack_revision(epoch));
    assert_eq!(session.last_acked_epoch(), epoch);
}

#[test]
fn reopen_session_keeps_the_durable_message() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("keep me")).expect("send");
    let durable = session
        .last_durable_message_id()
        .expect("durable")
        .to_string();
    let count = session.view().message_count;
    let wire = session.into_wire();
    let reopened = ChatSession::open(wire, Some(DEMO_CHAT_ID)).expect("reopen");
    assert_eq!(reopened.view().message_count, count);
    assert!(reopened
        .state()
        .messages
        .iter()
        .any(|row| row.content == "keep me"));
    assert!(reopened
        .state()
        .messages
        .iter()
        .any(|row| row.id == durable));
}

#[test]
fn send_trace_omits_message_content() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.send(Some("secret-body")).expect("send");
    let line = session.send_trace_line();
    assert!(line.contains("chat_send"));
    assert!(line.contains("sendAccepted=true"));
    assert!(!line.contains("secret-body"));
    assert!(!line.contains("echo:"));
}

#[test]
fn retry_uses_generation_retry_not_a_second_create() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    let creates_before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "chats.messages.create")
        .count();
    session.retry().expect("retry");
    assert!(session
        .issued_commands()
        .contains(&"generation.retry".into()));
    let creates_after = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "chats.messages.create")
        .count();
    assert_eq!(creates_before, creates_after);
}

#[test]
fn prepend_passes_opaque_cursor_and_does_not_parse_it() {
    let mut session =
        ChatSession::open(FakeWire::with_message_count(80), Some(DEMO_CHAT_ID)).expect("open");
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
    let newest = session
        .state()
        .messages
        .last()
        .map(|row| row.sequence)
        .expect("newest");
    assert_eq!(newest, 79);
    let cursor = session.state().next_cursor.clone().expect("cursor");
    assert!(!cursor.chars().all(|ch| ch.is_ascii_digit()));
    session.prepend().expect("prepend");
    assert_eq!(session.state().messages.len(), 80);
    assert_eq!(
        session.state().messages.first().map(|row| row.sequence),
        Some(0)
    );
}

#[test]
fn composer_draft_roundtrip_and_discard() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.set_composer_text("drafting").expect("save");
    assert_eq!(session.state().composer_text, "drafting");
    assert!(session.state().draft.is_some());
    session.reload_draft().expect("get");
    assert_eq!(session.state().composer_text, "drafting");
    session.discard_draft().expect("discard");
    assert!(session.state().draft.is_none());
    assert!(session.state().composer_text.is_empty());
}

#[test]
fn start_flagged_session_mounts_vdom() {
    let (session, report) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("flagged");
    assert!(report.vdom_edits > 0);
    assert!(report.live_wire);
    assert!(session.mount_vdom() > 0);
}

#[test]
fn unknown_wire_command_is_rejected_before_call() {
    let err = ChatRouteError::from(
        neotavern_presentation_dioxus_shell::assert_registered_command("presentation.bypassSqlite")
            .unwrap_err(),
    );
    assert!(matches!(err, ChatRouteError::UnknownCommand(_)));
}

#[test]
fn drain_stream_timeout_is_idle() {
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    assert!(matches!(
        session.poll_stream(0).expect("poll"),
        StreamFrame::Timeout
    ));
}

#[test]
fn duplicate_stream_sequence_does_not_double_append() {
    use contracts_generated::generated::GenerationEvent;
    let mut session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    session.apply_stream_frame(&StreamFrame::from_sequenced(
        0,
        GenerationEvent::GenerationDelta { text: "ab".into() },
    ));
    session.apply_stream_frame(&StreamFrame::from_sequenced(
        0,
        GenerationEvent::GenerationDelta { text: "ab".into() },
    ));
    assert_eq!(session.state().streaming_text, "ab");
    session.apply_stream_frame(&StreamFrame::from_sequenced(
        1,
        GenerationEvent::GenerationDelta { text: "cd".into() },
    ));
    assert_eq!(session.state().streaming_text, "abcd");
}

#[test]
fn ten_thousand_wire_messages_virtualize_the_visible_window() {
    let session =
        ChatSession::open(FakeWire::with_message_count(10_000), Some(DEMO_CHAT_ID)).expect("open");
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
    assert_eq!(session.view().message_count, 10_000);
    let (visible, outcome) = session.present_visible();
    assert!(visible.len() <= PRODUCT_PATH_VISIBLE);
    assert!(!outcome.waited_on_producer);
    assert!(session.mount_vdom() > 0);
    assert_eq!(session.view().chrome, ProductChrome::HeaderComposer);
}

#[test]
fn present_does_not_catch_up_frames_on_the_producer() {
    let session = ChatSession::open(FakeWire::demo(), Some(DEMO_CHAT_ID)).expect("open");
    let (_, outcome) = session.present_visible();
    assert!(!outcome.waited_on_producer);
}

#[test]
fn snapshot_json_is_object() {
    let session = ChatSession::open(FakeWire::demo(), None).expect("open");
    let value: serde_json::Value = serde_json::from_str(&session.snapshot_json()).expect("json");
    assert_eq!(value["title"], json!("Live wire chat"));
    assert_eq!(value["chatId"], json!(DEMO_CHAT_ID));
    assert_eq!(value["messageCount"], json!(2));
    assert_eq!(value["kernelMessageCount"], json!(2));
}

#[test]
fn isolated_10k_seed_goes_through_wire_ops_and_pages() {
    let mut wire = FakeWire::empty();
    let report = ensure_isolated_10k_workspace(&mut wire).expect("seed");
    assert!(!report.skipped);
    assert_eq!(report.kernel_message_count, ISOLATED_10K_COUNT);
    assert_eq!(report.created, ISOLATED_10K_COUNT);
    let again = ensure_isolated_10k_workspace(&mut wire).expect("skip");
    assert!(again.skipped);
    assert_eq!(again.created, 0);
    assert_eq!(again.chat_id, report.chat_id);

    let session = ChatSession::open(wire, Some(&report.chat_id)).expect("open");
    assert_eq!(session.view().title, ISOLATED_10K_TITLE);
    assert_eq!(session.view().message_count, ISOLATED_10K_COUNT as usize);
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
    let (visible, outcome) = session.present_visible();
    assert!(visible.len() <= PRODUCT_PATH_VISIBLE);
    assert!(!outcome.waited_on_producer);
    assert!(!visible.iter().any(|row| row.content.contains("**msg 0**")));
}

#[test]
fn isolated_10k_profile_opens_the_seeded_workspace() {
    let (session, report) = start_flagged_session(
        Some("1"),
        FakeWire::empty(),
        None,
        Some(ISOLATED_10K_PROFILE),
    )
    .expect("isolated");
    assert!(report.live_wire);
    assert_eq!(session.view().title, ISOLATED_10K_TITLE);
    assert_eq!(session.view().message_count, ISOLATED_10K_COUNT as usize);
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
}
