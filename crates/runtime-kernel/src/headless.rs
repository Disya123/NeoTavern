//! Headless adapter: an in-process, transport-free dispatch surface.
//!
//! Used by embedding hosts that want the kernel's dispatch semantics without
//! any network layer (CLI, tests, other crates).

use crate::{CancellationFlag, Kernel, KernelError};

/// Thin in-process adapter over a [`Kernel`].
#[derive(Debug)]
pub struct HeadlessAdapter {
    kernel: Kernel,
}

impl HeadlessAdapter {
    /// Wraps a kernel in the headless adapter.
    pub fn new(kernel: Kernel) -> Self {
        Self { kernel }
    }

    /// Dispatches `operation_id` over `request` bytes.
    ///
    /// `request_id` is accepted for correlation but ignored in this phase —
    /// correlation handling is the caller's concern (see ТЗ §11.1).
    pub fn dispatch(
        &self,
        request_id: &str,
        operation_id: &str,
        request: &[u8],
        cancel: &CancellationFlag,
    ) -> Result<Vec<u8>, KernelError> {
        let _ = request_id;
        self.kernel.dispatch(operation_id, request, cancel)
    }

    /// Returns the serialized `wire.meta.dto` for the wrapped kernel.
    pub fn meta_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.kernel.meta()).expect("meta dto serialization cannot fail")
    }
}
