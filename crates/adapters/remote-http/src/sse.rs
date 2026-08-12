//! Server-Sent Events framing helpers (`text/event-stream`) for the
//! streaming endpoint.
//!
//! Phase 4 ships the framing plus `Last-Event-ID` plumbing; durable resume
//! arrives with the generation workflows (Phase 6).

use contracts_generated::generated::EventEnvelope;

/// A single SSE frame: optional `event:` and `id:` lines, one `data:` line
/// per line of data, terminated by a blank line (text/event-stream spec).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// The `event:` name; an empty string omits the line.
    pub event: String,
    /// The `id:` value; `None` omits the line.
    pub id: Option<u64>,
    /// The frame payload; embedded newlines become separate `data:` lines.
    pub data: String,
}

/// Encodes a frame per the SSE spec: `event: <event>\n` (only when
/// non-empty) + `id: <n>\n` (when `Some`) + one `data: <line>\n` per line of
/// `data`, terminated by a blank line.
pub fn encode_frame(frame: &SseFrame) -> String {
    let mut out = String::new();
    if !frame.event.is_empty() {
        out.push_str("event: ");
        out.push_str(&frame.event);
        out.push('\n');
    }
    if let Some(id) = frame.id {
        out.push_str("id: ");
        out.push_str(&id.to_string());
        out.push('\n');
    }
    for line in frame.data.split('\n') {
        out.push_str("data: ");
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    out
}

/// Serializes one `EventEnvelope` as an SSE frame: `event = env.type`,
/// `id = env.sequence`, `data = JSON(env)`.
pub fn encode_envelope_frame(env: &EventEnvelope) -> String {
    encode_frame(&SseFrame {
        event: env.r#type.clone(),
        id: u64::try_from(env.sequence).ok(),
        data: serialize_json(env),
    })
}

/// Encodes the terminal frame of a stream: `event = terminal_type`,
/// `id = sequence`, `data = JSON(payload)`.
///
/// `stream_id` is reserved for Phase 6 durable resume (terminal payloads may
/// then embed the stream identity); it does not appear in the frame body yet.
pub fn encode_terminal_frame(
    stream_id: &str,
    sequence: u64,
    terminal_type: &str,
    payload: serde_json::Value,
) -> String {
    // `stream_id` is intentionally unused in the frame body (reserved for
    // Phase 6 durable resume); keep the binding to match the fixed API.
    let _ = stream_id;
    encode_frame(&SseFrame {
        event: terminal_type.to_string(),
        id: Some(sequence),
        data: serialize_json(&payload),
    })
}

/// Parses a `Last-Event-ID` header value into a `u64`; `None` on an absent
/// header or a non-numeric value.
pub fn parse_last_event_id(header: Option<&str>) -> Option<u64> {
    header?.trim().parse().ok()
}

/// Serializes a wire DTO for an SSE `data:` line. Wire DTOs hold only
/// String/Value fields, so serialization cannot fail; the fallback is
/// unreachable and keeps every path panic-free.
fn serialize_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts_generated::generated::validate_event_envelope;
    use serde_json::json;

    const STREAM_ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn frame_omits_event_and_id_lines_when_empty_or_absent() {
        let frame = encode_frame(&SseFrame {
            event: String::new(),
            id: None,
            data: "hello".to_string(),
        });
        assert_eq!(frame, "data: hello\n\n");
    }

    #[test]
    fn frame_emits_event_and_id_lines_when_present() {
        let frame = encode_frame(&SseFrame {
            event: "stream.closed".to_string(),
            id: Some(7),
            data: "{}".to_string(),
        });
        assert_eq!(frame, "event: stream.closed\nid: 7\ndata: {}\n\n");
    }

    #[test]
    fn frame_splits_embedded_newlines_into_data_lines() {
        let frame = encode_frame(&SseFrame {
            event: "chunk".to_string(),
            id: Some(2),
            data: "line1\nline2\nline3".to_string(),
        });
        assert_eq!(
            frame,
            "event: chunk\nid: 2\ndata: line1\ndata: line2\ndata: line3\n\n"
        );
    }

    #[test]
    fn envelope_frame_uses_type_sequence_and_json_data() {
        let env = EventEnvelope {
            stream_id: STREAM_ID.to_string(),
            sequence: 3,
            r#type: "generation.chunk".to_string(),
            payload: json!({ "text": "hi" }),
        };
        let frame = encode_envelope_frame(&env);
        let expected =
            serde_json::to_string(&env).unwrap_or_else(|e| panic!("serializing env: {e}"));
        assert_eq!(
            frame,
            format!("event: generation.chunk\nid: 3\ndata: {expected}\n\n")
        );
        // The data payload must itself be a valid wire event envelope.
        let data_line: String = frame
            .lines()
            .filter(|line| line.starts_with("data: "))
            .map(|line| &line["data: ".len()..])
            .collect();
        let data: serde_json::Value =
            serde_json::from_str(&data_line).unwrap_or_else(|e| panic!("data must be JSON: {e}"));
        validate_event_envelope(&data)
            .unwrap_or_else(|issues| panic!("data must validate: {issues:?}"));
        assert_eq!(data["sequence"], 3);
        assert_eq!(data["type"], "generation.chunk");
        assert_eq!(data["payload"], json!({ "text": "hi" }));
    }

    #[test]
    fn terminal_frame_shape() {
        let frame = encode_terminal_frame(STREAM_ID, 1, "stream.closed", json!({}));
        assert_eq!(frame, "event: stream.closed\nid: 1\ndata: {}\n\n");
    }

    #[test]
    fn terminal_frame_serializes_payload_object() {
        let frame = encode_terminal_frame(STREAM_ID, 5, "stream.closed", json!({ "reason": "ok" }));
        assert_eq!(
            frame,
            "event: stream.closed\nid: 5\ndata: {\"reason\":\"ok\"}\n\n"
        );
    }

    #[test]
    fn last_event_id_parses_valid_u64() {
        assert_eq!(parse_last_event_id(Some("42")), Some(42));
        assert_eq!(parse_last_event_id(Some(" 42 ")), Some(42));
        assert_eq!(
            parse_last_event_id(Some("18446744073709551615")),
            Some(u64::MAX)
        );
    }

    #[test]
    fn last_event_id_rejects_garbage_and_absent() {
        assert_eq!(parse_last_event_id(Some("abc")), None);
        assert_eq!(parse_last_event_id(Some("12x")), None);
        assert_eq!(parse_last_event_id(Some("-1")), None);
        assert_eq!(parse_last_event_id(Some("18446744073709551616")), None);
        assert_eq!(parse_last_event_id(Some("")), None);
        assert_eq!(parse_last_event_id(None), None);
    }
}
