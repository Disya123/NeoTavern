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
}
