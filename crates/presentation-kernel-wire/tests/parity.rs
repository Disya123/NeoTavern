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

// ---------------------------------------------------------------------------
// drop_stream: unsubscribe without cancelling (chat switch mid-generation)
// ---------------------------------------------------------------------------

/// Dropping a live kernel stream must stop frame delivery for that handle
/// while the run itself keeps executing on the kernel's writer thread and
/// commits `completed` — the durable log stays canonical, so re-entering the
/// chat reads the finished state back. This is also the regression test for
/// the writer surviving a dropped notice receiver (generation.rs must ignore
/// `SendError`, never panic).
#[test]
fn drop_stream_unsubscribes_without_cancelling_the_run() {
    let (mut kernel, _root) = kernel_wire();
    let chat = seed_parity_workspace(&mut kernel, "Drop", 2).expect("seed");
    let handle = kernel
        .start_stream(
            "generation.start",
            json!({
                "chatId": chat,
                "message": "drop me mid-flight",
                "provider": "fake",
                "model": "steps=8;delay-ms=15",
            }),
        )
        .expect("stream starts");

    kernel.drop_stream(&handle).expect("drop");
    assert_eq!(
        kernel.poll_stream(&handle, 0),
        Ok(StreamFrame::Timeout),
        "a dropped handle must never deliver frames again"
    );

    // The run was NOT cancelled: it must reach `completed` on its own.
    let mut status = String::new();
    for _ in 0..200 {
        let call = kernel
            .call("generation.get", json!({ "workflowId": handle }))
            .expect("generation.get");
        status = call
            .result
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if status == "completed" {
            break;
        }
        assert_ne!(status, "cancelled", "drop_stream must never cancel the run");
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(
        status, "completed",
        "the dropped run finishes on the writer thread without a consumer"
    );
}

/// Restart rehydration: an unsent composer draft saved over the wire is
/// durable in the Kernel, and a session that re-opens the same data root
/// restores it through `chats.messages.drafts.list` — no remembered id
/// (the gap this closes: the row existed but the UI could not learn it).
/// FakeWire has no counterpart: nothing survives an in-memory restart.
#[test]
fn kernel_restart_restores_the_unsent_draft() {
    let (mut kernel, root) = kernel_wire();
    let chat = seed_parity_workspace(&mut kernel, "Drafts", 2).expect("kernel seed");
    {
        let mut session = ChatSession::open(kernel, Some(&chat)).expect("open before restart");
        session
            .set_composer_text("unsent restart draft")
            .expect("composer typing saves the draft over the wire");
        assert!(
            session.state().last_error.is_none(),
            "draft save must not record an error: {:?}",
            session.state().last_error
        );
        // Session and wire drop here — nothing survives in memory.
    }

    // Re-open the SAME data root: a fresh kernel wire + fresh session.
    let wire = KernelProductWire::open(&root).expect("kernel reopens the data root");
    let mut session = ChatSession::open(wire, Some(&chat)).expect("open after restart");
    assert_eq!(
        session.state().composer_text,
        "unsent restart draft",
        "the durable draft restores the composer after a restart"
    );
    assert!(
        session.state().last_error.is_none(),
        "rehydration must not record an error: {:?}",
        session.state().last_error
    );

    // Editing continues from the restored draft (the id persists across
    // the restart — the follow-up save updates the same row).
    session
        .set_composer_text("unsent restart draft, continued")
        .expect("typing continues on the restored draft");
    assert_eq!(
        session.state().composer_text,
        "unsent restart draft, continued"
    );
}

/// Phase 2 gate item (ADR-0057 §7): "paginated catalogs (UI-03 class)
/// reach item 101+". The UI-03 audit class — `load_chat_list` /
/// `load_characters` discarded the server cursor and `load_more` never
/// fetched — is closed against the REAL Kernel: 101 characters and 55
/// chats seeded over the wire, then paged through the session command
/// surface only. No client-side arithmetic decides the page boundary;
/// the Kernel's keyset cursor is the only truth (INV-1).
#[test]
fn catalog_pagination_reaches_item_101_over_the_real_kernel() {
    let (mut kernel, _keep_root) = kernel_wire();
    let call = |wire: &mut KernelProductWire, op: &str, payload| {
        wire.call(op, payload).expect("seed call succeeds")
    };
    for index in 0..101usize {
        let character = call(
            &mut kernel,
            "characters.create",
            json!({
                "name": format!("Paginator {index:03}"),
                "description": format!("UI-03 pagination witness {index}"),
            }),
        );
        let character_id = character
            .result
            .get("id")
            .cloned()
            .expect("characters.create returns the id");
        if index < 55 {
            call(
                &mut kernel,
                "chats.create",
                json!({
                    "characterId": character_id,
                    "title": format!("Page chat {index:03}"),
                }),
            );
        }
    }

    let mut session = ChatSession::open(kernel, None).expect("session opens");
    let no_error = |session: &ChatSession<KernelProductWire>| {
        assert!(
            session.state().last_error.is_none(),
            "pagination must not record an error: {:?}",
            session.state().last_error
        );
    };

    // First page: 50 rows resident, the tail is cursor-locked away. The
    // page ORDER is the Kernel's (`created_at DESC, id DESC` — ties break
    // newest-first), so the test asserts reachability, not composition.
    let first_page_names: std::collections::HashSet<String> = session
        .state()
        .characters
        .iter()
        .map(|row| row.name.clone())
        .collect();
    let absent: Vec<usize> = (0..101usize)
        .filter(|index| !first_page_names.contains(&format!("Paginator {index:03}")))
        .collect();
    assert_eq!(
        absent.len(),
        51,
        "the 51 remaining rows are behind the cursor"
    );
    assert_eq!(
        session.state().chat_list.len(),
        50,
        "chat first page is 50 of 55"
    );

    // Load more until the server says the catalog ends.
    for _ in 0..8 {
        session.load_more_characters();
        no_error(&session);
    }
    assert_eq!(
        session.state().characters.len(),
        101,
        "the whole catalog arrives"
    );

    // No page boundary duplicates: 101 rows, 101 distinct stable ids.
    let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in &session.state().characters {
        assert!(ids.insert(row.id.clone()), "duplicate id across pages");
    }
    assert_eq!(ids.len(), 101);
    // EVERY seeded row is reachable — items 51 and 101 included (the
    // Phase-2 gate), and nothing was lost at the boundaries.
    for index in 0..101usize {
        let name = format!("Paginator {index:03}");
        assert!(
            session
                .state()
                .characters
                .iter()
                .any(|row| row.name == name),
            "{name} must be reachable through cursor pagination"
        );
    }

    // Exhausted load-more is a clean no-op: no fetch, no error.
    let resident = session.state().characters.len();
    session.load_more_characters();
    assert_eq!(session.state().characters.len(), resident);
    no_error(&session);

    // Chats: one more page reaches 55; the exact last page carries no
    // cursor, so the second load-more reports exhaustion.
    assert!(session.load_more_chats(), "chat page 2 exists");
    assert_eq!(session.state().chat_list.len(), 55);
    let mut chat_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in &session.state().chat_list {
        assert!(
            chat_ids.insert(row.id.clone()),
            "duplicate chat id across pages"
        );
    }
    assert_eq!(chat_ids.len(), 55);
    assert!(
        !session.load_more_chats(),
        "55 is the exact end — no cursor"
    );
    no_error(&session);
}

/// UI-01 (ADR-0057 Phase 2): the selected provider profile REACHES
/// generation over the real Kernel. The old session wrote a camelCase
/// `activeProviderConfigId` settings row that canonical validation
/// rejected while the UI kept showing the profile as active, and
/// `generation.start` (provider: None) silently substituted `fake`. The
/// chain now: canonical row (`activeproviderconfigid`, Object value) →
/// the Kernel resolves the active `provider_configs` row when the
/// request omits provider/model (INV-1 — sessions never read product
/// state to build requests) → the durable run carries the selected
/// provider + configured model → the selection survives a restart → a
/// selection pointing at a deleted profile is a STABLE error, never a
/// silent `fake`.
#[test]
fn provider_selection_reaches_generation_over_the_real_kernel() {
    let (mut kernel, root) = kernel_wire();
    let chat = seed_parity_workspace(&mut kernel, "UI-01", 1).expect("kernel seed");

    // The old write shape is rejected by the Kernel's OWN request
    // validation (lowercase key pattern): this is the exact mutation the
    // session used to issue while displaying the selection as active.
    let rejected = kernel.call(
        "settings.update",
        json!({ "settings": [ { "key": "activeProviderConfigId", "value": { "value": "x" } } ] }),
    );
    assert!(
        rejected.is_err(),
        "camelCase settings keys are contract violations the Kernel must reject"
    );

    // Durable profile + canonical selection row. The `fake` adapter's
    // model is a step-grammar string (`steps=3;tokens-per-step=24`) — a
    // REAL valid model for the provider, not a sentinel.
    let profile = kernel
        .call(
            "providers.config.set",
            json!({
                "provider": "fake",
                "name": "ui01-profile",
                "config": { "model": "steps=3;tokens-per-step=24" },
            }),
        )
        .expect("providers.config.set");
    let profile_id = profile
        .result
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("profile id")
        .to_string();
    kernel
        .call(
            "settings.update",
            json!({ "settings": [ { "key": "activeproviderconfigid", "value": { "value": profile_id } } ] }),
        )
        .expect("canonical settings row lands");

    // Send WITHOUT provider/model: the Kernel resolves through the
    // durable selection and the run carries the selected authority.
    let mut session = ChatSession::open(kernel, Some(&chat)).expect("session opens");
    assert_eq!(
        session.state().active_provider_id.as_deref(),
        Some(profile_id.as_str()),
        "the durable provider selection hydrates on open"
    );
    session
        .send(Some("provider selection probe"))
        .expect("send");
    pump_stream(&mut session);
    assert!(
        session.state().last_error.is_none(),
        "send stays clean: {:?}",
        session.state().last_error
    );
    let run_id = session
        .state()
        .active_run_id
        .clone()
        .expect("completed run id");
    drop(session); // releases the data root for the restart leg

    // The selection AND the run authority survive the restart.
    let mut wire = KernelProductWire::open(&root).expect("kernel reopens the data root");
    let run = wire
        .call("generation.get", json!({ "workflowId": run_id }))
        .expect("run readable after restart");
    assert_eq!(
        run.result.get("provider"),
        Some(&json!("fake")),
        "the run carries the selected profile's provider kind"
    );
    assert_eq!(
        run.result.get("model"),
        Some(&json!("steps=3;tokens-per-step=24")),
        "the run carries the selected profile's configured model"
    );
    let mut session = ChatSession::open(wire, Some(&chat)).expect("session reopens");
    assert_eq!(
        session.state().active_provider_id.as_deref(),
        Some(profile_id.as_str()),
        "the selection survives the restart"
    );

    // Dangling selection: delete the profile (the session clears the row
    // canonically), then re-select the deleted id and send — a STABLE
    // product error, not a silent `fake` fallback.
    session.load_provider_configs();
    assert!(
        session
            .state()
            .provider_configs
            .iter()
            .any(|item| item.id == profile_id),
        "the seeded profile is listed"
    );
    session.open_provider_delete(&profile_id);
    session.confirm_provider_delete();
    assert!(session.state().last_error.is_none(), "delete stays clean");
    assert_eq!(
        session.state().active_provider_id,
        None,
        "deleting the active profile clears the selection"
    );
    session.select_provider(&profile_id);
    // The start fails synchronously (no stream handle is created), so the
    // error is already recorded by `send` — nothing to pump.
    session
        .send(Some("dangling selection probe"))
        .expect("send records the error instead of failing");
    let code = session
        .state()
        .last_error
        .as_ref()
        .map(|err| err.code.clone())
        .unwrap_or_default();
    assert_eq!(
        code, "PROVIDER_CONFIG_NOT_FOUND",
        "a dangling selection is a stable product error"
    );
}

/// UI-02 audit gate (ADR-0057 Phase 2, docs/audits/rust-app/PRESENTATION.md):
/// the character editor reads and writes REAL card fields — no synthetic
/// greeting/notes strings, no silently dropped edits — over the real Kernel
/// in a durable data root. Witness: import a card with a unique first
/// message, notes and greetings (plus unknown extension metadata) → open
/// the editor → the draft shows the imported fields → edit the first
/// message and the notes → Save → reselect → the edit is durable → the
/// export carries the edit AND the unknown extensions verbatim → the same
/// survives a full restart of the data root.
#[test]
fn card_editor_roundtrips_real_fields_over_the_real_kernel() {
    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    let (mut kernel, root) = kernel_wire();

    // A spec-compliant V2 card: the flat mirror AND the `data` copy carry
    // the unique witness fields; unknown extension metadata rides along.
    let card_json = json!({
        "spec": "character_card_v2",
        "name": "UI-02 Roundtrip",
        "description": "Audit UI-02 witness character",
        "first_mes": "*Roundtrip opens a ledger.* The audit begins.",
        "creator_notes": "Imported for the UI-02 audit gate.",
        "alternate_greetings": ["*Roundtrip bows.* Second greeting."],
        "extensions": { "neo_tavern": { "unknown_key": "keep-me" } },
        "data": {
            "name": "UI-02 Roundtrip",
            "description": "Audit UI-02 witness character",
            "first_mes": "*Roundtrip opens a ledger.* The audit begins.",
            "creator_notes": "Imported for the UI-02 audit gate.",
            "alternate_greetings": ["*Roundtrip bows.* Second greeting."],
            "extensions": { "neo_tavern": { "unknown_key": "keep-me" } },
        },
    });
    let asset = kernel
        .call(
            "assets.put",
            json!({
                "kind": "card",
                "filename": "ui02-card.json",
                "contentType": "application/json",
                "contentBase64": b64(serde_json::to_string(&card_json).unwrap().as_bytes()),
            }),
        )
        .expect("assets.put stages the card");
    let asset_id = asset
        .result
        .get("asset")
        .and_then(|asset| asset.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("staged asset id")
        .to_string();
    let imported = kernel
        .call("imports.character.card", json!({ "assetId": asset_id }))
        .expect("imports.character.card");
    let character_id = imported
        .result
        .get("character")
        .and_then(|character| character.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("imported character id")
        .to_string();

    // Open the session and select the imported character: the editor draft
    // hydrates from the REAL card document — never a synthesized string.
    let mut session = ChatSession::open(kernel, None).expect("session opens");
    session.select_character(&character_id);
    assert!(
        session.state().last_error.is_none(),
        "selection stays clean: {:?}",
        session.state().last_error
    );
    let draft = session
        .state()
        .character_draft
        .clone()
        .expect("the editor draft loads");
    assert_eq!(
        draft.first_message,
        "*Roundtrip opens a ledger.* The audit begins.",
        "the first message is the imported card's own first_mes"
    );
    assert_eq!(
        draft.creator_notes, "Imported for the UI-02 audit gate.",
        "the creator notes are the imported card's own creator_notes"
    );
    assert_eq!(
        draft.alternate_greetings,
        vec!["*Roundtrip bows.* Second greeting.".to_string()],
        "the alternate greetings are the imported card's own list"
    );
    assert!(
        !draft.first_message.contains("looks up"),
        "no synthetic greeting string may appear"
    );
    assert!(
        !draft.creator_notes.starts_with("Character card for"),
        "no synthetic notes string may appear"
    );

    // Edit the first message and the notes, then Save: both land through
    // `characters.card.update` (the RMW keeps the unknown extensions).
    session.set_character_first_message("*Roundtrip smiles.* Edited first message.");
    session.set_character_creator_notes("Edited for the UI-02 audit gate.");
    session.save_character_meta();
    assert!(
        session.state().last_error.is_none(),
        "save stays clean: {:?}",
        session.state().last_error
    );
    let status = session
        .state()
        .status_message
        .clone()
        .expect("save confirms with a status");
    assert_eq!(status, "Saved UI-02 Roundtrip.", "save confirms the name");

    // Reload the draft from the durable store (the reselect path): the
    // edit is what loads back, not the pre-edit card.
    session.refresh_characters();
    assert!(
        session.state().last_error.is_none(),
        "refresh stays clean: {:?}",
        session.state().last_error
    );
    let draft = session
        .state()
        .character_draft
        .clone()
        .expect("the draft reloads after reselect");
    assert_eq!(
        draft.first_message, "*Roundtrip smiles.* Edited first message.",
        "the edited first message survives a reselect"
    );
    assert_eq!(
        draft.creator_notes, "Edited for the UI-02 audit gate.",
        "the edited creator notes survive a reselect"
    );
    assert_eq!(
        draft.alternate_greetings,
        vec!["*Roundtrip bows.* Second greeting.".to_string()],
        "the untouched greeting list rides along"
    );

    // The export carries the edit AND the unknown extension metadata.
    session.export_character_card(&character_id);
    assert!(
        session.state().last_error.is_none(),
        "export stays clean: {:?}",
        session.state().last_error
    );
    let export = session
        .state()
        .last_export
        .clone()
        .expect("the export parks its bytes");
    let exported: serde_json::Value =
        serde_json::from_slice(&export.bytes).expect("the export is a JSON card");
    let field = |key: &str| -> String {
        exported
            .get("data")
            .and_then(|data| data.get(key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    assert_eq!(
        field("first_mes"),
        "*Roundtrip smiles.* Edited first message.",
        "the exported card carries the edited first message"
    );
    assert_eq!(
        field("creator_notes"),
        "Edited for the UI-02 audit gate.",
        "the exported card carries the edited creator notes"
    );
    assert_eq!(
        exported
            .get("data")
            .and_then(|data| data.get("extensions"))
            .and_then(|ext| ext.get("neo_tavern"))
            .and_then(|nt| nt.get("unknown_key"))
            .and_then(serde_json::Value::as_str),
        Some("keep-me"),
        "unknown extension metadata rides the roundtrip verbatim"
    );

    // Full restart of the data root: the same edited card loads.
    drop(session); // releases the data root
    let wire = KernelProductWire::open(&root).expect("kernel reopens the data root");
    let mut session = ChatSession::open(wire, None).expect("session reopens");
    session.select_character(&character_id);
    let draft = session
        .state()
        .character_draft
        .clone()
        .expect("the draft loads after the restart");
    assert_eq!(
        draft.first_message, "*Roundtrip smiles.* Edited first message.",
        "the edited first message survives a restart"
    );
    assert_eq!(
        draft.creator_notes, "Edited for the UI-02 audit gate.",
        "the edited creator notes survive a restart"
    );
}
