//! Local connection: a direct in-process call facade (ТЗ §11.1).
//!
//! No HTTP, no port, no transport — `call` executes synchronously on the
//! caller's thread. Remote/legacy transports live in `packages/neobackend`.

use crate::{CancellationFlag, Kernel, KernelError};

/// Direct in-process connection to a [`Kernel`].
#[derive(Debug)]
pub struct LocalConnection {
    kernel: Kernel,
}

impl LocalConnection {
    /// Opens a local connection over the given kernel.
    pub fn new(kernel: Kernel) -> Self {
        Self { kernel }
    }

    /// Executes `operation_id` synchronously over `request` bytes.
    pub fn call(
        &self,
        operation_id: &str,
        request: &[u8],
        cancel: &CancellationFlag,
    ) -> Result<Vec<u8>, KernelError> {
        self.kernel.dispatch(operation_id, request, cancel)
    }
}
