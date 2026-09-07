//! Stream hygiene regression tests (chat-switch leak, double send, drain
//! tail): a scripted wire wraps `FakeWire` — every CRUD call goes through the
//! real fake, while stream polls can be held open (a still-running run) or
//! have frames injected between the terminal event and `Terminal`.

use std::collections::VecDeque;

use contracts_generated::generated::{GenerationEvent, MessageRole};
use neotavern_presentation_chat::{
    start_flagged_session, FakeWire, ProductWire, StreamFrame, DEMO_CHAT_ID,
};
use serde_json::{json, Value};

/// Which frames the wrapper hands out for the intercepted stream.
enum Script {
    /// Keep the stream open: every poll times out (a run still executing).
    Hold,
    /// Emit the inner wire's frames, but inject `after_terminal` between the
    /// terminal event and the inner `Terminal` frame.
    InjectAfterTerminal(VecDeque<StreamFrame>),
}

struct ScriptedWire {
    inner: FakeWire,
    handle: Option<String>,
    script: Script,
    seen_terminal_event: bool,
}

impl ScriptedWire {
    fn new(inner: FakeWire, script: Script) -> Self {
        Self {
            inner,
            handle: None,
            script,
            seen_terminal_event: false,
        }
    }
}

impl ProductWire for ScriptedWire {
    fn call(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<neotavern_presentation_chat::WireCall, neotavern_presentation_chat::ChatRouteError>
    {
        self.inner.call(operation_id, payload)
    }

    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, neotavern_presentation_chat::ChatRouteError> {
        let handle = self.inner.start_stream(operation_id, payload)?;
        self.handle = Some(handle.clone());
        self.seen_terminal_event = false;
        Ok(handle)
    }

    fn poll_stream(
        &mut self,
        handle: &str,
        timeout_ms: u32,
    ) -> Result<StreamFrame, neotavern_presentation_chat::ChatRouteError> {
        if self.handle.as_deref() == Some(handle) {
            match &mut self.script {
                Script::Hold => return Ok(StreamFrame::Timeout),
                Script::InjectAfterTerminal(inject) => {
                    if self.seen_terminal_event {
                        if let Some(frame) = inject.pop_front() {
                            return Ok(frame);
                        }
                        // Injected frames exhausted: fall through to the inner
                        // wire for its trailing `Terminal`.
                    }
                }
            }
        }
        let frame = self.inner.poll_stream(handle, timeout_ms)?;
        if let StreamFrame::Event { event, .. } = &frame {
            if matches!(
                event.as_ref(),
                GenerationEvent::GenerationCompleted { .. }
                    | GenerationEvent::GenerationFailed { .. }
                    | GenerationEvent::GenerationCancelled
            ) {
                self.seen_terminal_event = true;
            }
        }
        Ok(frame)
    }

    fn cancel_stream(
        &mut self,
        handle: &str,
    ) -> Result<(), neotavern_presentation_chat::ChatRouteError> {
        self.inner.cancel_stream(handle)
    }

    fn drop_stream(
        &mut self,
        handle: &str,
    ) -> Result<(), neotavern_presentation_chat::ChatRouteError> {
        self.handle = None;
        self.inner.drop_stream(handle)
    }
}

/// `FakeWire::with_message_count` seeds exactly one chat; a second one is
/// created through the same wire so the session can switch to it.
fn wire_with_second_chat(mut wire: FakeWire) -> (FakeWire, String) {
    let call = wire
        .call(
            "chats.create",
            json!({ "characterId": neotavern_presentation_chat::DEMO_CHARACTER_ID }),
        )
        .expect("chats.create");
    let other = call
        .result
        .get("id")
        .and_then(Value::as_str)
        .expect("created chat id")
        .to_string();
    (wire, other)
}

#[test]
fn fake_wire_drop_stream_makes_subsequent_polls_timeout() {
    let mut wire = FakeWire::demo();
    let handle = wire
        .start_stream(
            "generation.start",
            json!({ "chatId": DEMO_CHAT_ID, "message": "hi" }),
        )
        .expect("stream starts");
    assert!(
        !matches!(wire.poll_stream(&handle, 0), Ok(StreamFrame::Timeout)),
        "a live stream must yield frames before the drop"
    );
    wire.drop_stream(&handle).expect("drop");
    assert_eq!(
        wire.poll_stream(&handle, 0),
        Ok(StreamFrame::Timeout),
        "a dropped handle must never deliver frames again"
    );
}

#[test]
fn open_chat_during_live_stream_unsubscribes_and_clears_input_state() {
    let (inner, other) = wire_with_second_chat(FakeWire::with_message_count(6));
    let wire = ScriptedWire::new(inner, Script::Hold);
    let (mut session, _) =
        start_flagged_session(Some("1"), wire, Some(DEMO_CHAT_ID), None).expect("route");
    session.set_composer_text("still typing").expect("draft");
    session.send(None).expect("send starts the run");
    assert!(
        session.state().stream_handle.is_some(),
        "the held stream must keep the handle live"
    );

    session.open_chat(&other);

    let state = session.state();
    assert!(
        state.stream_handle.is_none(),
        "unsubscribe clears the handle"
    );
    assert!(state.active_run_id.is_none());
    assert!(state.streaming_text.is_empty());
    assert!(state.draft.is_none(), "the old chat's draft must not leak");
    assert!(
        state.composer_text.is_empty(),
        "composer text belongs to the old chat"
    );
    assert!(
        state.messages.iter().all(|row| row.chat_id == other),
        "only the new chat's rows are loaded"
    );
}

#[test]
fn send_while_a_stream_is_live_is_a_no_op() {
    let wire = ScriptedWire::new(FakeWire::with_message_count(4), Script::Hold);
    let (mut session, _) =
        start_flagged_session(Some("1"), wire, Some(DEMO_CHAT_ID), None).expect("route");
    session.send(Some("first")).expect("first send");
    assert!(session.state().stream_handle.is_some());
    let starts_before = session
        .issued_commands()
        .iter()
        .filter(|op| op.as_str() == "generation.start")
        .count();
    assert_eq!(starts_before, 1);

    session
        .send(Some("second"))
        .expect("second send is a no-op");
    let starts_after = session
        .issued_commands()
        .iter()
        .filter(|op| op.as_str() == "generation.start")
        .count();
    assert_eq!(
        starts_after, 1,
        "a live stream must swallow the double tap without a second run"
    );
}

#[test]
fn drain_stream_consumes_frames_after_the_terminal_event() {
    // The old drain stopped at the terminal event with one blind extra poll;
    // anything queued between it and `Terminal` (e.g. a lag notice) was
    // applied-but-discarded and the handle stayed live forever.
    let mut inject = VecDeque::new();
    inject.push_back(StreamFrame::from_sequenced(
        3,
        GenerationEvent::ConsumerLagged { dropped: 1 },
    ));
    let wire = ScriptedWire::new(
        FakeWire::with_message_count(2),
        Script::InjectAfterTerminal(inject),
    );
    let (mut session, _) =
        start_flagged_session(Some("1"), wire, Some(DEMO_CHAT_ID), None).expect("route");
    session.send(Some("hello")).expect("send");

    let state = session.state();
    assert!(
        state.stream_handle.is_none(),
        "the drain must reach the Terminal frame, not strand the handle"
    );
    assert!(
        state
            .messages
            .iter()
            .any(|row| row.role == MessageRole::Assistant && row.content == "echo: hello"),
        "the completed message is durable"
    );
    assert!(state.streaming_text.is_empty());
}
