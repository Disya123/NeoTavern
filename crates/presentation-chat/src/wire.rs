use contracts_generated::generated::{ErrorDto, GenerationEvent};
use serde_json::Value;

use crate::error::ChatRouteError;

pub const PAGE_LIMIT: i64 = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum StreamFrame {
    /// One generation event. `sequence` is the Kernel envelope sequence when
    /// the host supplied it (JNI); `None` for in-memory FakeWire frames that
    /// only carry the payload. Duplicate `sequence` values are not applied.
    Event {
        sequence: Option<i64>,
        event: Box<GenerationEvent>,
    },
    Terminal,
    Error(ErrorDto),
    Timeout,
}

impl StreamFrame {
    pub fn from_event(event: GenerationEvent) -> Self {
        Self::Event {
            sequence: None,
            event: Box::new(event),
        }
    }

    pub fn from_sequenced(sequence: i64, event: GenerationEvent) -> Self {
        Self::Event {
            sequence: Some(sequence),
            event: Box::new(event),
        }
    }
}

/// One Product Wire request/response. Presentation never opens Kernel.
#[derive(Debug, Clone, PartialEq)]
pub struct WireCall {
    pub request_id: String,
    pub operation_id: String,
    pub result: Value,
}

/// Payload-level Product Wire. Presentation never opens Kernel/storage/network.
pub trait ProductWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError>;
    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError>;
    fn poll_stream(&mut self, handle: &str, timeout_ms: u32)
        -> Result<StreamFrame, ChatRouteError>;
    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError>;
    /// Stops tracking a live stream WITHOUT cancelling it — the user left the
    /// chat, the run keeps committing on the wire side and the durable log
    /// stays canonical. Polling a dropped handle afterwards returns
    /// `Timeout`. The default is a no-op for wires that keep no per-handle
    /// state.
    fn drop_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        let _ = handle;
        Ok(())
    }
}

/// Hosts that pick the wire implementation at runtime (e.g. the desktop
/// `--wire kernel` mode) hold the session as `ChatSession<Box<dyn ProductWire>>`;
/// this blanket keeps every `Box`ed wire a full wire without changing the
/// trait itself.
impl<T: ProductWire + ?Sized> ProductWire for Box<T> {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError> {
        (**self).call(operation_id, payload)
    }
    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError> {
        (**self).start_stream(operation_id, payload)
    }
    fn poll_stream(
        &mut self,
        handle: &str,
        timeout_ms: u32,
    ) -> Result<StreamFrame, ChatRouteError> {
        (**self).poll_stream(handle, timeout_ms)
    }
    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        (**self).cancel_stream(handle)
    }
    fn drop_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        (**self).drop_stream(handle)
    }
}

/// Stream key carried by a JNI/bridge stream frame: the transport envelope's
/// `streamId`. Returns `None` when the bridge invented no id (frame died
/// before the first event).
pub(crate) fn stream_key_from_frame(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value
        .get("event")?
        .get("streamId")?
        .as_str()
        .map(str::to_string)
}

/// The kernel run id embedded in a stream frame's event payload:
/// `generation.step` steps carry `runId`, `generation.completed` carries the
/// final message's `generationRunId`. Used when the transport envelope has
/// no `streamId` of its own.
pub(crate) fn run_id_from_frame(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let payload = value.get("event")?.get("payload")?;
    payload
        .get("step")
        .and_then(|step| step.get("runId"))
        .or_else(|| {
            payload
                .get("finalMessage")
                .and_then(|row| row.get("generationRunId"))
        })
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Keys the JNI bridge invents when the native stream dies before it can
/// report its kernel stream id (`s<pointer>`); never a run id.
pub(crate) fn is_synthetic_stream_key(key: &str) -> bool {
    match key.strip_prefix('s') {
        Some(digits) => !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

#[cfg(test)]
mod stream_key_tests {
    use super::*;

    #[test]
    fn stream_keys_extract_ids_and_flag_synthetics() {
        let step = r#"{"kind":"event","event":{"streamId":"envelope-1","sequence":0,
            "type":"generation.step","payload":{"type":"generation.step",
            "step":{"runId":"run-9","stepId":"s1"}}}}"#;
        assert_eq!(
            stream_key_from_frame(step.as_bytes()).as_deref(),
            Some("envelope-1")
        );
        assert_eq!(run_id_from_frame(step.as_bytes()).as_deref(), Some("run-9"));

        let completed = r#"{"kind":"event","event":{"sequence":2,
            "type":"generation.completed","payload":{"type":"generation.completed",
            "finalMessage":{"generationRunId":"run-7"}}}}"#;
        assert_eq!(stream_key_from_frame(completed.as_bytes()), None);
        assert_eq!(
            run_id_from_frame(completed.as_bytes()).as_deref(),
            Some("run-7")
        );

        // Synthetic JNI fallback keys are transport-only, never run ids.
        assert!(is_synthetic_stream_key("s140234"));
        assert!(!is_synthetic_stream_key("run-9"));
        assert!(!is_synthetic_stream_key("s12a3"));
        assert!(!is_synthetic_stream_key(""));
    }
}
