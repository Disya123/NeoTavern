use neotavern_presentation_chat::{
    start_flagged_route, start_flagged_session, ChatRouteError, ChatSession, FakeWire, StreamFrame,
    DEMO_CHAT_ID, PAGE_LIMIT,
};
use neotavern_presentation_dioxus_shell::{ProductChrome, PRODUCT_PATH_VISIBLE};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

#[test]
fn cargo_toml_does_not_depend_on_kernel_storage_or_network() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = fs::read_to_string(manifest).expect("Cargo.toml");
    for forbidden in [
        "runtime-kernel",
        "neotavern-storage",
        "neotavern-android-jni",
        "reqwest",
        "rusqlite",
        "tokio",
    ] {
        assert!(
            !text.contains(forbidden),
            "live chat route must not depend on {forbidden}"
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
    assert!(!view.visible.is_empty());
}

#[test]
fn empty_library_is_an_error_not_a_panic() {
    let session = ChatSession::open(FakeWire::empty(), None).expect("open");
    let code = session
        .state()
        .last_error
        .as_ref()
        .map(|err| err.code.as_str());
    assert_eq!(code, Some("EMPTY_LIBRARY"));
    assert!(session.state().messages.is_empty());
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
        start_flagged_session(Some("1"), FakeWire::demo(), None).expect("flagged");
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
fn ten_thousand_wire_messages_virtualize_the_visible_window() {
    let session =
        ChatSession::open(FakeWire::with_message_count(10_000), Some(DEMO_CHAT_ID)).expect("open");
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
    let (visible, outcome) = session.present_visible();
    assert!(visible.len() <= PRODUCT_PATH_VISIBLE);
    assert!(!outcome.waited_on_producer);
    assert!(session.mount_vdom() > 0);
    assert_eq!(session.view().chrome, ProductChrome::TripleGlass);
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
}
