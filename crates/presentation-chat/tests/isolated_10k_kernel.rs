//! Isolated 10k workspace through a real Kernel Product Wire, not Dioxus nodes.

use contracts_generated::contract_schema_hash;
use neotavern_presentation_chat::{
    ensure_isolated_10k_workspace, ChatRouteError, ChatSession, ProductWire, StreamFrame, WireCall,
    ISOLATED_10K_COUNT, ISOLATED_10K_TITLE, PAGE_LIMIT,
};
use neotavern_presentation_dioxus_shell::PRODUCT_PATH_VISIBLE;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use serde_json::Value;

struct KernelWire {
    kernel: Kernel,
    next: u64,
}

impl KernelWire {
    fn open(root: &std::path::Path) -> Self {
        let kernel = Kernel::open(KernelConfig {
            expected_schema_hash: contract_schema_hash().to_string(),
            ffi_abi_version: 1,
            data_root: Some(root.to_path_buf()),
        })
        .expect("kernel must open");
        Self { kernel, next: 1 }
    }

    fn alloc(&mut self) -> String {
        let n = self.next;
        self.next += 1;
        format!("00000000-0000-4000-8000-{n:012x}")
    }
}

fn map_kernel(err: KernelError) -> ChatRouteError {
    if let Some(product) = err.product {
        ChatRouteError::Product(*product)
    } else {
        ChatRouteError::Transport(err.message)
    }
}

impl ProductWire for KernelWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError> {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&payload)?;
        match self.kernel.dispatch(operation_id, &bytes, &flag) {
            Ok(resp) => Ok(WireCall {
                request_id: self.alloc(),
                operation_id: operation_id.to_string(),
                result: serde_json::from_slice(&resp)?,
            }),
            Err(err) => Err(map_kernel(err)),
        }
    }

    fn start_stream(
        &mut self,
        operation_id: &str,
        _payload: Value,
    ) -> Result<String, ChatRouteError> {
        Err(ChatRouteError::UnknownCommand(operation_id.to_string()))
    }

    fn poll_stream(
        &mut self,
        _handle: &str,
        _timeout_ms: u32,
    ) -> Result<StreamFrame, ChatRouteError> {
        Ok(StreamFrame::Timeout)
    }

    fn cancel_stream(&mut self, _handle: &str) -> Result<(), ChatRouteError> {
        Ok(())
    }
}

#[test]
fn isolated_10k_kernel_projection_pages_the_same_route() {
    let root = tempfile::tempdir().expect("tempdir");
    let mut wire = KernelWire::open(root.path());
    let seeded = ensure_isolated_10k_workspace(&mut wire).expect("seed");
    assert_eq!(seeded.kernel_message_count, ISOLATED_10K_COUNT);
    assert!(!seeded.skipped);
    let skipped = ensure_isolated_10k_workspace(&mut wire).expect("second seed");
    assert!(skipped.skipped);
    assert_eq!(skipped.created, 0);

    let mut session = ChatSession::open(wire, Some(&seeded.chat_id)).expect("open");
    assert_eq!(session.view().title, ISOLATED_10K_TITLE);
    assert_eq!(session.view().message_count, ISOLATED_10K_COUNT as usize);
    assert_eq!(session.state().messages.len(), PAGE_LIMIT as usize);
    let (visible, outcome) = session.present_visible();
    assert!(visible.len() <= PRODUCT_PATH_VISIBLE);
    assert!(!outcome.waited_on_producer);
    assert_eq!(outcome.blank_px, 0.0);
    let before = session.state().messages.len();
    session.prepend().expect("prepend");
    assert!(session.state().messages.len() > before);
    assert!(session.state().messages.len() <= ISOLATED_10K_COUNT as usize);
}
