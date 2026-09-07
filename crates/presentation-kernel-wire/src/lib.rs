//! ProductWire adapter over the canonical Rust Kernel (`runtime-kernel`).
//!
//! This crate is the single presentation-side place where the
//! `runtime-kernel` dependency is legal — the `presentation-chat` guard test
//! (`tests/live_wire.rs::cargo_toml_does_not_depend_on_kernel_storage_or_network`)
//! forbids it there, and this crate's own
//! [`presentation_chat_does_not_depend_on_kernel_wire`] test keeps the
//! package graph acyclic. The adapter keeps the payload-level
//! [`ProductWire`] contract: JSON values in, JSON values out — presentation
//! never links storage or the kernel itself.
//!
//! Stream mapping (the part the unary `tests/isolated_10k_kernel.rs` sample
//! does not cover):
//!
//! - `start_stream` — `Kernel::dispatch_stream` (`generation.start` /
//!   `generation.retry`) returns a live [`EventStream`]; the adapter stores
//!   it keyed by the run id and returns that id as the opaque handle.
//! - `poll_stream` — one frame per poll, matching the FakeWire deque: every
//!   envelope after the last applied sequence from the durable
//!   `generation.events` log becomes one `StreamFrame::Event`
//!   (kernel sequences are unique per run, so no frame is ever delivered
//!   twice); after a terminal event the next poll returns `StreamFrame::Terminal`
//!   and drops the stream entry. `EventStream::next_notice` is only the wait
//!   primitive — the durable log is canonical, so a timeout also replays the
//!   log before giving up (the notice channel closes when the executor
//!   finished).
//! - `cancel_stream` — `generation.cancel` through the same unary dispatch
//!   path (idempotent while the run is in `cancelling`); the executor commits
//!   the terminal `generation.cancelled` event, which the next polls replay.
//!
//! Generation runs are durable-only, so a stateless kernel
//! (`KernelConfig::data_root = None`) rejects streams — the host and the
//! tests open the kernel on a real directory.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use contracts_generated::contract_schema_hash;
use contracts_generated::generated::{
    decode_paged_generation_events, decode_result_empty, GenerationEvent, RequestCancelGeneration,
    RequestCreateCharacter, RequestCreateChat, RequestCreateMessage, RequestListGenerationEvents,
};
use neotavern_presentation_chat::{ChatRouteError, ProductWire, StreamFrame, WireCall, PAGE_LIMIT};
use runtime_kernel::{CancellationFlag, EventStream, Kernel, KernelConfig, KernelError};
use serde_json::{json, Value};

/// Events page pulled per poll; the wire bound is `1..=200`, `PAGE_LIMIT` (50)
/// matches the session's list pages and keeps replay cheap.
const EVENTS_PAGE: i64 = PAGE_LIMIT;

/// A live generation run tracked by the adapter.
struct LiveStream {
    stream: EventStream,
    /// The terminal event (`completed`/`failed`/`cancelled`) was already
    /// delivered to the session; the next poll returns `StreamFrame::Terminal`
    /// and drops the entry — the exact tail the FakeWire deque has after its
    /// terminal event frame.
    terminal_sent: bool,
}

pub struct KernelProductWire {
    kernel: Kernel,
    streams: HashMap<String, LiveStream>,
    /// Highest envelope `sequence` already returned per run. Kernel
    /// sequences are unique and ascending per run, so the adapter never
    /// re-delivers a frame the session already applied (the session's
    /// `accept_stream_sequence` guard would swallow it anyway, but a
    /// re-delivered `generation.completed` must not resurrect the stream).
    applied: HashMap<String, i64>,
    next_request_id: u64,
}

impl KernelProductWire {
    /// Opens a durable kernel rooted at `data_root` (generation streams
    /// require storage).
    pub fn open(data_root: &Path) -> Result<Self, ChatRouteError> {
        let kernel = Kernel::open(KernelConfig {
            expected_schema_hash: contract_schema_hash().to_string(),
            ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
            data_root: Some(data_root.to_path_buf()),
        })
        .map_err(map_kernel)?;
        Ok(Self {
            kernel,
            streams: HashMap::new(),
            applied: HashMap::new(),
            next_request_id: 1,
        })
    }

    /// The underlying kernel (host glue: provider registration, diagnostics).
    pub fn kernel(&self) -> &Kernel {
        &self.kernel
    }

    fn alloc_request_id(&mut self) -> String {
        let n = self.next_request_id;
        self.next_request_id += 1;
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    /// Reads the next unapplied envelope after the last applied sequence and
    /// packs it into one `StreamFrame::Event`. `Ok(None)` — the durable log
    /// holds nothing new yet. A terminal event marks the stream
    /// `terminal_sent` instead of dropping it, so the following poll can
    /// return `StreamFrame::Terminal` (FakeWire deque parity).
    fn next_new_event(&mut self, handle: &str) -> Result<Option<StreamFrame>, ChatRouteError> {
        let after = self.applied.get(handle).copied().unwrap_or(-1);
        let request = serde_json::to_vec(&RequestListGenerationEvents {
            workflow_id: handle.to_string(),
            after_sequence: Some(after),
            limit: Some(EVENTS_PAGE),
        })?;
        let flag = CancellationFlag::new();
        let resp = self
            .kernel
            .dispatch("generation.events", &request, &flag)
            .map_err(map_kernel)?;
        let page = decode_paged_generation_events(&resp)
            .map_err(|err| ChatRouteError::Wire(err.message))?;
        let Some(envelope) = page.items.first() else {
            return Ok(None);
        };
        let event: GenerationEvent = serde_json::from_value(envelope.payload.clone())?;
        let is_terminal = matches!(
            event,
            GenerationEvent::GenerationCompleted { .. }
                | GenerationEvent::GenerationFailed { .. }
                | GenerationEvent::GenerationCancelled
        );
        if is_terminal {
            if let Some(entry) = self.streams.get_mut(handle) {
                entry.terminal_sent = true;
            }
        }
        self.applied.insert(handle.to_string(), envelope.sequence);
        Ok(Some(StreamFrame::from_sequenced(envelope.sequence, event)))
    }
}

fn map_kernel(err: KernelError) -> ChatRouteError {
    if let Some(product) = err.product {
        ChatRouteError::Product(*product)
    } else {
        ChatRouteError::Transport(err.message)
    }
}

impl ProductWire for KernelProductWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError> {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&payload)?;
        let resp = self
            .kernel
            .dispatch(operation_id, &bytes, &flag)
            .map_err(map_kernel)?;
        let result = serde_json::from_slice(&resp)?;
        Ok(WireCall {
            request_id: self.alloc_request_id(),
            operation_id: operation_id.to_string(),
            result,
        })
    }

    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError> {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&payload)?;
        let stream = self
            .kernel
            .dispatch_stream(operation_id, &bytes, &flag)
            .map_err(map_kernel)?;
        let handle = stream.stream_id().to_string();
        self.applied.insert(handle.clone(), -1);
        self.streams.insert(
            handle.clone(),
            LiveStream {
                stream,
                terminal_sent: false,
            },
        );
        Ok(handle)
    }

    fn poll_stream(
        &mut self,
        handle: &str,
        timeout_ms: u32,
    ) -> Result<StreamFrame, ChatRouteError> {
        if let Some(entry) = self.streams.get_mut(handle) {
            if entry.terminal_sent {
                self.streams.remove(handle);
                return Ok(StreamFrame::Terminal);
            }
        } else {
            return Ok(StreamFrame::Timeout);
        }
        // Events committed since the last poll are returned instantly — a
        // poll right after `start_stream` must not burn its timeout when the
        // run is already done (the session drain loop relies on that).
        if let Some(frame) = self.next_new_event(handle)? {
            return Ok(frame);
        }
        // Wait for the next notice, then replay the durable log once more —
        // the notice is only the wake-up; on a timeout AND on a closed notice
        // channel (executor finished, terminal event already committed) the
        // log replay is the canonical answer.
        let _ = self.streams.get_mut(handle).map(|entry| {
            entry
                .stream
                .next_notice(Duration::from_millis(u64::from(timeout_ms)))
        });
        if let Some(frame) = self.next_new_event(handle)? {
            return Ok(frame);
        }
        Ok(StreamFrame::Timeout)
    }

    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&RequestCancelGeneration {
            workflow_id: handle.to_string(),
        })?;
        let resp = self
            .kernel
            .dispatch("generation.cancel", &bytes, &flag)
            .map_err(map_kernel)?;
        decode_result_empty(&resp).map_err(|err| ChatRouteError::Wire(err.message))?;
        Ok(())
    }
}

/// Seeds a small demo workspace through the Product Wire only: one character,
/// one chat titled `title`, and `messages` alternating user/assistant rows.
/// Used by the parity tests and the `neocompositor-kernel` host so both wire
/// implementations run against the same data shape. Returns the chat id.
pub fn seed_parity_workspace<W: ProductWire>(
    wire: &mut W,
    title: &str,
    messages: u32,
) -> Result<String, ChatRouteError> {
    let call = |wire: &mut W, op: &str, payload: Value| wire.call(op, payload);
    let character = call(
        wire,
        "characters.create",
        json!({
            "name": title,
            "description": format!("{title} Product Wire parity fixture"),
            "tags": ["parity"],
        }),
    )?;
    let character_id = character
        .result
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ChatRouteError::Json("characters.create: missing id".into()))?
        .to_string();
    let chat = call(
        wire,
        "chats.create",
        json!({ "characterId": character_id, "title": title }),
    )?;
    let chat_id = chat
        .result
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ChatRouteError::Json("chats.create: missing id".into()))?
        .to_string();
    for index in 0..messages {
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        call(
            wire,
            "chats.messages.create",
            json!({
                "chatId": chat_id,
                "role": role,
                "content": format!("msg {index}"),
            }),
        )?;
    }
    Ok(chat_id)
}

// Compile-time proof the request DTO imports match the generated wire
// contract (the payloads above are hand-built JSON; the typed requests stay
// referenced so a rename in contracts-generated breaks the build here first).
#[allow(dead_code)]
fn _typed_request_shapes() {
    let _ = (
        RequestCreateCharacter {
            name: String::new(),
            description: None,
            tags: None,
            avatar_asset_id: None,
            profile_id: None,
        },
        RequestCreateChat {
            character_id: String::new(),
            title: None,
            persona_id: None,
        },
        RequestCreateMessage {
            chat_id: String::new(),
            role: contracts_generated::generated::MessageRole::User,
            content: String::new(),
            generation_run_id: None,
        },
    );
}
