//! FakeWire ↔ KernelProductWire parity: the same Product Wire scenarios on
//! both implementations, checked against structural invariants (not exact
//! text — FakeWire echoes, the kernel's FakeProvider generates deterministic
//! steps).
//!
//! Scenarios: seed → open session → send → stream completes with a durable
//! assistant message → retry-after-completion → cancel mid-flight (adapter
//! level; the session's `send` hardcodes `model: None`, which completes
//! instantly) → retry after cancel → unknown operation → missing chat.
//!
//! Timing note: the kernel executor runs inline on the kernel's writer thread
//! and services queued unary commands at step boundaries — so a
//! `generation.events` replay dispatch blocks until the next boundary and
//! then sees at least one fresh commit. Polls therefore make progress even
//! with a zero timeout mid-run; a `Timeout` is only expected after the
//! terminal frame (exhausted stream, FakeWire deque parity).

use contracts_generated::generated::GenerationEvent;
use neotavern_presentation_chat::{
    ChatRouteError, ChatSession, FakeWire, ProductWire, StreamFrame,
};
use neotavern_presentation_kernel_wire::{seed_parity_workspace, KernelProductWire};
use serde_json::json;

/// Stream pump cap: the fake provider's biggest config used here is 8 steps;
/// 64 leaves a wide margin for per-event polls.
const PUMP_CAP: usize = 64;

fn kernel_wire() -> (KernelProductWire, std::path::PathBuf) {
    let root = tempfile::tempdir().expect("tempdir");
    let wire = KernelProductWire::open(root.path()).expect("kernel wire opens");
    (wire, root.keep())
}

/// Pumps the session's live stream (500 ms per poll) until it ends.
fn pump_stream<W: ProductWire>(session: &mut ChatSession<W>) -> Vec<StreamFrame> {
    let mut frames = Vec::new();
    for _ in 0..PUMP_CAP {
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

/// Seed → open → send → stream completes with a durable assistant message.
/// Both wires must leave the session in the same state shape: one new user
/// row plus one new assistant row, cleared streaming text, no error, and the
/// run id recorded.
#[test]
fn send_completes_identically_on_fake_and_kernel_wires() {
    // --- FakeWire side (in-memory, drains synchronously inside `send`) -----
    let mut fake = FakeWire::empty();
    let fake_chat = seed_parity_workspace(&mut fake, "Parity", 3).expect("fake seed");
    let mut fake_session = ChatSession::open(fake, Some(&fake_chat)).expect("fake open");
    let fake_before = fake_session.state().messages.len();
    fake_session.mount_vdom();
    fake_session.send(Some("hello parity")).expect("fake send");

    let fake_state = fake_session.state();
    assert_eq!(
        fake_state.messages.len(),
        fake_before + 2,
        "user + assistant"
    );
    assert!(
        fake_state.streaming_text.is_empty(),
        "fake streaming cleared"
    );
    assert!(
        fake_state.last_error.is_none(),
        "fake no error: {:?}",
        fake_state.last_error
    );
    let fake_last = fake_state.messages.last().expect("fake assistant row");
    assert_eq!(
        fake_last.role,
        contracts_generated::generated::MessageRole::Assistant
    );
    assert_eq!(fake_last.content, "echo: hello parity");
    assert!(fake_state.active_run_id.is_some(), "fake run id recorded");

    // --- Kernel side (durable events, async executor) ----------------------
    let (mut kernel, _root) = kernel_wire();
    let kernel_chat = seed_parity_workspace(&mut kernel, "Parity", 3).expect("kernel seed");
    let mut kernel_session = ChatSession::open(kernel, Some(&kernel_chat)).expect("kernel open");
    let kernel_before = kernel_session.state().messages.len();
    kernel_session.mount_vdom();
    kernel_session
        .send(Some("hello parity"))
        .expect("kernel send");
    pump_stream(&mut kernel_session);

    let kernel_state = kernel_session.state();
    assert_eq!(
        kernel_state.messages.len(),
        kernel_before + 2,
        "user + assistant"
    );
    assert!(
        kernel_state.streaming_text.is_empty(),
        "kernel streaming cleared"
    );
    assert!(
        kernel_state.last_error.is_none(),
        "kernel no error: {:?}",
        kernel_state.last_error
    );
    let kernel_last = kernel_state.messages.last().expect("kernel assistant row");
    assert_eq!(
        kernel_last.role,
        contracts_generated::generated::MessageRole::Assistant
    );
    assert!(
        !kernel_last.content.is_empty(),
        "fake provider reply is non-empty"
    );
    assert!(
        kernel_state.active_run_id.is_some(),
        "kernel run id recorded"
    );
}

/// A completed run cannot be retried (`completed` is not a recoverable
/// terminal state): the session records `GENERATION_RUN_STATE_CONFLICT`, no
/// second stream starts, no new message appears.
#[test]
fn retry_after_completion_is_an_error_not_a_panic() {
    let (mut kernel, _root) = kernel_wire();
    let chat_id = seed_parity_workspace(&mut kernel, "Retry", 1).expect("seed");
    let mut session = ChatSession::open(kernel, Some(&chat_id)).expect("open");
    session.mount_vdom();
    session.send(Some("finish me")).expect("send");
    pump_stream(&mut session);
    let before = session.state().messages.len();

    session.retry().expect("retry call does not panic");

    let error = session
        .state()
        .last_error
        .as_ref()
        .expect("retry after completion must record an error");
    assert_eq!(error.code, "GENERATION_RUN_STATE_CONFLICT", "{error:?}");
    assert_eq!(session.state().messages.len(), before);
    assert!(session.state().stream_handle.is_none());
}

/// Adapter contract: a terminal event is delivered exactly once, the next
/// poll returns `Terminal`, and after the entry is dropped further polls
/// return `Timeout` — the exhausted FakeWire deque semantics. Envelope
/// sequences are unique across the whole stream.
#[test]
fn poll_after_terminal_returns_timeout_and_no_duplicates() {
    let (mut kernel, _root) = kernel_wire();
    let chat_id = seed_parity_workspace(&mut kernel, "Hygiene", 1).expect("seed");
    let mut session = ChatSession::open(kernel, Some(&chat_id)).expect("open");
    session.mount_vdom();
    session.send(Some("hygiene")).expect("send");
    let frames = pump_stream(&mut session);

    assert!(
        frames
            .iter()
            .any(|frame| matches!(frame, StreamFrame::Terminal)),
        "stream must end with Terminal, frames: {frames:?}"
    );
    let mut seen: Vec<i64> = Vec::new();
    for frame in &frames {
        if let StreamFrame::Event {
            sequence: Some(seq),
            ..
        } = frame
        {
            assert!(!seen.contains(seq), "sequence {seq} delivered twice");
            seen.push(*seq);
        }
    }
    assert_eq!(session.state().stream_handle, None);

    // The session handle is cleared; probe the wire seam directly with the
    // finished run id — the adapter must behave like an exhausted deque.
    let run_id = session
        .state()
        .active_run_id
        .clone()
        .expect("run id recorded");
    assert_eq!(
        session.wire_mut().poll_stream(&run_id, 0),
        Ok(StreamFrame::Timeout)
    );
}

/// Cancel of an in-flight run at the adapter seam: the run is made slow via
/// the fake provider's `steps`/`delay-ms` model config (the session's `send`
/// hardcodes `model: None`), `cancel_stream` marks the run, and the
/// subsequent polls replay deltas and then the terminal
/// `generation.cancelled` event, followed by `Terminal` and `Timeout` —
/// the same observable contract as FakeWire's injected cancelled frame.
#[test]
fn cancel_in_flight_run_ends_the_stream() {
    let (mut kernel, _root) = kernel_wire();
    let chat_id = seed_parity_workspace(&mut kernel, "Cancel", 1).expect("seed");
    let handle = kernel
        .start_stream(
            "generation.start",
            json!({
                "chatId": chat_id,
                "message": "cancel me",
                "model": "steps=8;delay-ms=15",
            }),
        )
        .expect("start slow run");
    kernel.cancel_stream(&handle).expect("cancel");

    let mut cancelled_seen = false;
    let mut terminal_seen = false;
    for _ in 0..PUMP_CAP {
        match kernel.poll_stream(&handle, 500).expect("poll") {
            StreamFrame::Event { event, .. }
                if matches!(*event, GenerationEvent::GenerationCancelled) =>
            {
                cancelled_seen = true;
            }
            StreamFrame::Event { .. } => {}
            StreamFrame::Terminal => {
                terminal_seen = true;
                break;
            }
            StreamFrame::Timeout => break,
            StreamFrame::Error(err) => panic!("cancel poll error: {err:?}"),
        }
    }
    assert!(cancelled_seen, "generation.cancelled must be replayed");
    assert!(
        terminal_seen,
        "cancelled stream must close with one Terminal"
    );
    // Exhausted-deque semantics after the Terminal frame (FakeWire parity).
    assert_eq!(kernel.poll_stream(&handle, 0), Ok(StreamFrame::Timeout));
}

/// A cancelled run is recoverable: `generation.retry` starts attempt 2 from
/// the source run's request snapshot and completes with a durable assistant
/// message under the default model.
#[test]
fn kernel_wire_supports_generation_retry_after_cancel() {
    let (mut kernel, _root) = kernel_wire();
    let chat_id = seed_parity_workspace(&mut kernel, "RetryCancel", 1).expect("seed");
    let handle = kernel
        .start_stream(
            "generation.start",
            json!({
                "chatId": chat_id,
                "message": "cancelled then retried",
                "model": "steps=4;delay-ms=10",
            }),
        )
        .expect("start slow run");
    kernel.cancel_stream(&handle).expect("cancel");
    let mut cancelled_seen = false;
    for _ in 0..PUMP_CAP {
        match kernel.poll_stream(&handle, 500).expect("poll") {
            StreamFrame::Event { event, .. }
                if matches!(*event, GenerationEvent::GenerationCancelled) =>
            {
                cancelled_seen = true;
            }
            StreamFrame::Event { .. } => {}
            StreamFrame::Terminal | StreamFrame::Timeout => break,
            StreamFrame::Error(err) => panic!("cancel poll error: {err:?}"),
        }
    }
    assert!(cancelled_seen, "cancellation must be observable");

    let handle2 = kernel
        .start_stream("generation.retry", json!({ "sourceRunId": handle }))
        .expect("retry after cancel");
    assert_ne!(handle, handle2, "retry creates a new run");

    let mut completed = false;
    for _ in 0..PUMP_CAP {
        match kernel.poll_stream(&handle2, 500).expect("poll") {
            StreamFrame::Event { event, .. }
                if matches!(
                    *event,
                    GenerationEvent::GenerationCompleted { .. }
                        | GenerationEvent::GenerationDelta { .. }
                ) =>
            {
                if matches!(*event, GenerationEvent::GenerationCompleted { .. }) {
                    completed = true;
                }
            }
            StreamFrame::Event { .. } => {}
            StreamFrame::Terminal | StreamFrame::Timeout => break,
            StreamFrame::Error(err) => panic!("retry poll error: {err:?}"),
        }
    }
    assert!(completed, "retry run must reach generation.completed");
}

/// `generation.start` on a missing chat surfaces the same product error code
/// through both wires.
#[test]
fn missing_chat_error_code_matches() {
    let missing = "00000000-0000-4000-8000-0000000000ff";
    let mut fake = FakeWire::empty();
    let fake_err = fake
        .start_stream(
            "generation.start",
            json!({ "chatId": missing, "message": "orphan" }),
        )
        .expect_err("fake must reject missing chat");
    match &fake_err {
        ChatRouteError::Product(dto) => assert_eq!(dto.code, "CHAT_NOT_FOUND"),
        other => panic!("fake error must be product-level: {other}"),
    }

    let (mut kernel, _root) = kernel_wire();
    let kernel_err = kernel
        .start_stream(
            "generation.start",
            json!({ "chatId": missing, "message": "orphan" }),
        )
        .expect_err("kernel must reject missing chat");
    match &kernel_err {
        ChatRouteError::Product(dto) => assert_eq!(dto.code, "CHAT_NOT_FOUND"),
        other => panic!("kernel error must be product-level: {other}"),
    }
}

/// Unknown unary operations are errors on both wires (the classification
/// differs — FakeWire answers `UnknownCommand`, the kernel maps its
/// `OperationNotFound` to `Transport` — the shared contract is "no result").
#[test]
fn unknown_operation_is_an_error_on_both_wires() {
    let mut fake = FakeWire::empty();
    assert!(fake.call("no.such.op", json!({})).is_err());

    let (mut kernel, _root) = kernel_wire();
    assert!(kernel.call("no.such.op", json!({})).is_err());
}

// ---------------------------------------------------------------------------
// Package-graph guards (the presentation-chat side lives in its live_wire.rs)
// ---------------------------------------------------------------------------

/// The kernel-wire crate depends on presentation-chat; the reverse edge would
/// be a package cycle. Cargo would reject it anyway — this test documents the
/// invariant next to the presentation-chat guard.
#[test]
fn guard_presentation_chat_does_not_depend_on_kernel_wire() {
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../presentation-chat/Cargo.toml");
    let text = std::fs::read_to_string(manifest).expect("presentation-chat Cargo.toml");
    assert!(
        !text.contains("presentation-kernel-wire"),
        "presentation-chat must not depend on neotavern-presentation-kernel-wire"
    );
}

/// The kernel-wire crate is the single presentation-side place where the
/// kernel dependency is legal — its own manifest must keep the dependency
/// list minimal (kernel + chat contract, nothing else creeping in).
#[test]
fn guard_kernel_wire_dependencies_are_minimal() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = std::fs::read_to_string(manifest).expect("Cargo.toml");
    let production = extract_production_deps(&text);
    for required in ["runtime-kernel", "neotavern-presentation-chat"] {
        assert!(
            production.contains(required),
            "kernel-wire must declare {required} in [dependencies]"
        );
    }
    for forbidden in ["neotavern-storage", "reqwest", "rusqlite", "tokio"] {
        assert!(
            !production.contains(forbidden),
            "kernel-wire must not depend on {forbidden}"
        );
    }
}

fn extract_production_deps(manifest: &str) -> String {
    let mut out = String::new();
    let mut in_prod = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_prod = trimmed == "[dependencies]"
                || (trimmed.starts_with("[target.") && trimmed.ends_with("dependencies]"));
        }
        if in_prod {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}
