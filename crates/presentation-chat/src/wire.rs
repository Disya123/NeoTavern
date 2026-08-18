use contracts_generated::generated::{ErrorDto, GenerationEvent};
use serde_json::Value;

use crate::error::ChatRouteError;

pub const PAGE_LIMIT: i64 = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum StreamFrame {
    Event(Box<GenerationEvent>),
    Terminal,
    Error(ErrorDto),
    Timeout,
}

/// Payload-level Product Wire. Presentation never opens Kernel/storage/network.
pub trait ProductWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<Value, ChatRouteError>;
    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError>;
    fn poll_stream(&mut self, handle: &str, timeout_ms: u32)
        -> Result<StreamFrame, ChatRouteError>;
    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError>;
}
