//! Provider SDK (ТЗ §55, Фаза 7): the portable adapter contract executed by
//! the Runtime Kernel for every local/native host.
//!
//! A provider adapter turns one sanitized generation request into a bounded
//! stream of [`ProviderEvent`]s plus a normalized [`policy::Usage`] or a
//! typed [`ProviderError`]. Vendor types never cross the adapter boundary;
//! secrets are referenced ([`secret::SecretRef`]) and resolved through a
//! host-provided [`secret::SecretResolver`] seam, never stored or logged
//! (§68). Exactly one billable attempt runs per [`ProviderAdapter::generate`]
//! call — retry is a new user-visible generation attempt, never a hidden
//! internal loop (§55).

use std::sync::atomic::{AtomicBool, Ordering};

pub mod policy;
pub mod secret;

/// Cooperative cancellation token shared with the generation executor.
///
/// Adapters MUST check [`CancelToken::is_cancelled`] between work units and
/// stop promptly; late output after cancellation never reaches the chat
/// (§63).
#[derive(Debug, Clone)]
pub struct CancelToken<'a> {
    flag: &'a AtomicBool,
}

impl<'a> CancelToken<'a> {
    /// Wraps the shared cancellation flag.
    pub fn new(flag: &'a AtomicBool) -> Self {
        Self { flag }
    }

    /// True once cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Stable machine-readable provider failure codes (§55 normalized errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorCode {
    /// The per-run deadline expired before the attempt finished.
    Timeout,
    /// Cancellation was observed; the attempt produced no committed result.
    Cancelled,
    /// The provider is unavailable (misconfigured, disabled, unreachable).
    Unavailable,
    /// The request/model spec is invalid (parse failure, unknown model).
    RequestInvalid,
    /// A provider-side step failed (deterministic fault injection maps here).
    StepFailed,
    /// A transient network fault (advisory retryable, §55).
    NetworkFault,
}

impl std::fmt::Display for ProviderErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            ProviderErrorCode::Timeout => "timeout",
            ProviderErrorCode::Cancelled => "cancelled",
            ProviderErrorCode::Unavailable => "unavailable",
            ProviderErrorCode::RequestInvalid => "request-invalid",
            ProviderErrorCode::StepFailed => "step-failed",
            ProviderErrorCode::NetworkFault => "network-fault",
        };
        f.write_str(text)
    }
}

/// Normalized provider error. `params` must never contain secret values,
/// raw user content or vendor payloads (§55, §68, §85).
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderError {
    /// Stable failure code.
    pub code: ProviderErrorCode,
    /// Human-readable diagnostics (no secrets, no raw payloads).
    pub message: String,
    /// Machine-readable parameters (`("step", "3")`, `("provider", "fake")`…).
    pub params: Vec<(String, String)>,
    /// Advisory only (§55): retry decisions belong to the kernel/UI, and a
    /// retry is always a new user-visible attempt, never a hidden repeat.
    pub retryable: bool,
}

impl ProviderError {
    /// Builds a non-retryable error.
    pub fn new(code: ProviderErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            params: Vec::new(),
            retryable: false,
        }
    }

    /// Builds a non-retryable error with parameters.
    pub fn with(
        code: ProviderErrorCode,
        message: impl Into<String>,
        params: Vec<(String, String)>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            params,
            retryable: false,
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if !self.params.is_empty() {
            write!(f, " (")?;
            for (i, (k, v)) in self.params.iter().enumerate() {
                if i > 0 {
                    write!(f, ", ")?;
                }
                write!(f, "{k}={v}")?;
            }
            write!(f, ")")?;
        }
        Ok(())
    }
}

impl std::error::Error for ProviderError {}

/// One streaming unit produced by an adapter. The wire `generation.checkpoint`
/// event is derived by the kernel from the commit rhythm — adapters emit
/// deltas only. `ToolCall` is the normalized tool request (§9.3): the adapter
/// never executes tools itself — the kernel validates and durably records it,
/// then the host performs the effect and submits the result.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProviderEvent {
    /// One text delta (bounded by the adapter).
    Delta {
        /// Delta text.
        text: String,
    },
    /// A normalized tool request produced by the model: the adapter's turn is
    /// complete when it emits this; the kernel transitions the run to the
    /// durable `waiting_for_tool` state and stops the attempt.
    ToolCall {
        /// Stable tool-call identifier echoed to the host (`toolCallId`).
        id: String,
        /// Declared tool name (must match a registered `ToolSpec`).
        name: String,
        /// JSON arguments validated by the kernel against the tool's
        /// `input_schema` before the run may wait on the result.
        arguments: serde_json::Value,
    },
}

/// Backpressure/cancellation signal returned by the executor's `emit` sink.
///
/// `Stop` means the run was cancelled (or the consumer is gone): the adapter
/// MUST stop producing immediately. Late output never reaches the chat (§63).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitStatus {
    /// Keep producing.
    Continue,
    /// Stop: the run is being cancelled.
    Stop,
}

/// One model exposed by a provider (wire `wire.provider.model`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProviderModel {
    /// Stable model identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Context window size, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<i64>,
    /// Maximum output tokens, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<i64>,
}

/// Feature availability (§60): `Available`, or `Degraded`/`Unavailable` with a
/// versioned code and an optional safe user-facing detail.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum Availability {
    /// Fully usable.
    Available,
    /// Usable with reduced capability.
    Degraded {
        /// Versioned availability code.
        code: String,
        /// Safe user-facing diagnostic (never used for programmatic branching).
        detail: Option<String>,
    },
    /// Not usable.
    Unavailable {
        /// Versioned availability code.
        code: String,
        /// Safe user-facing diagnostic (never used for programmatic branching).
        detail: Option<String>,
    },
}

/// One rendered prompt message (instruct-neutral form, ТЗ §9.2): the prompt
/// pipeline works with a plain role/content array until the provider-specific
/// serialization stage (AGENTS.md §9). Carries no secrets. On a resumed turn
/// after a tool call the kernel appends an assistant message carrying
/// `tool_calls` and the matching `tool`-role result message carrying
/// `tool_call_id` — the working context of §8.3.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptMessage<'a> {
    /// Wire role: `system` | `user` | `assistant` | `tool`.
    pub role: &'a str,
    /// Message content.
    pub content: &'a str,
    /// Assistant tool calls (JSON-encoded arguments) on the resumed turn.
    pub tool_calls: Option<&'a [PromptToolCall<'a>]>,
    /// The `tool_call_id` of a `tool`-role result message.
    pub tool_call_id: Option<&'a str>,
}

/// One assistant-side tool call in the working context (§8.3).
#[derive(Debug, Clone, PartialEq)]
pub struct PromptToolCall<'a> {
    /// Tool-call identifier (matches `ProviderEvent::ToolCall.id`).
    pub id: &'a str,
    /// Declared tool name.
    pub name: &'a str,
    /// JSON-encoded arguments (the adapter writes them verbatim).
    pub arguments: &'a str,
}

/// A tool the kernel exposes to providers for the run (ТЗ §8.3, §9.3):
/// name, description and the JSON-Schema the kernel validates call arguments
/// against before the run may wait on the tool result. The kernel never
/// executes tools itself.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec<'a> {
    /// Stable wire id (`wire.tool.spec.id` pattern).
    pub id: &'a str,
    /// Function name the model calls.
    pub name: &'a str,
    /// Human description sent to the model.
    pub description: &'a str,
    /// JSON-Schema document for `arguments`.
    pub input_schema: &'a serde_json::Value,
}

/// Sanitized generation request handed to an adapter. Built from the durable
/// run snapshot; contains no secrets (§62) except the transient
/// [`ProviderRequest::api_key`], which the kernel resolves at execution time
/// and which must never be stored, logged, or serialized.
#[derive(Debug)]
pub struct ProviderRequest<'a> {
    /// Provider identifier (wire `provider` field).
    pub provider_id: &'a str,
    /// Model string selected by the caller.
    pub model: &'a str,
    /// Sanitized user input (from the run snapshot). Providers that receive
    /// [`ProviderRequest::messages`] should prefer the rendered plan; `input`
    /// remains the durable single-message fallback.
    pub input: &'a str,
    /// Stable execution identity `"{chat_id}|{attempt}"` — deterministic
    /// adapters derive their output from this key.
    pub run_key: &'a str,
    /// Per-run deadline, when the kernel sets one.
    pub deadline: Option<policy::Deadline>,
    /// The resolved provider secret (API key), present only when the run's
    /// provider configuration carries a stored `secret_ref` (§9.4). Resolved
    /// by the kernel just before [`ProviderAdapter::generate`] and dropped
    /// afterwards; adapters must use it only to build the outgoing request
    /// and must never log, store, or echo it back.
    pub api_key: Option<&'a str>,
    /// The kernel's rendered prompt plan (system blocks + selected history +
    /// the user message), when the prompt pipeline is active (Этап 2.6).
    /// `None` for direct single-message calls. Adapters serialize this array
    /// (or fall back to `input`) and never store or log it. On resumed turns
    /// the array also carries the assistant tool calls and tool results.
    pub messages: Option<&'a [PromptMessage<'a>]>,
    /// Tools declared for this run (adapter declares them to the model and
    /// parses normalized tool requests). `None` when tool use is disabled.
    pub tools: Option<&'a [ToolSpec<'a>]>,
}

/// The portable provider adapter contract (§55).
///
/// Implementations must be deterministic where documented, must never retry a
/// billable attempt internally, must honor cancellation/deadline between work
/// units, and must keep vendor types inside the adapter.
pub trait ProviderAdapter: Send + Sync {
    /// Provider identifier used on the wire (`provider` field).
    fn id(&self) -> &str;
    /// Display name.
    fn name(&self) -> &str;
    /// True for built-in adapters shipped with the kernel.
    fn builtin(&self) -> bool;
    /// Models exposed by this provider.
    fn models(&self) -> Vec<ProviderModel>;
    /// Cheap, side-effect-free availability probe (§60).
    fn availability(&self) -> Availability;

    /// Executes exactly one generation attempt.
    ///
    /// Streams deltas through `emit`; checks `cancel` and
    /// [`ProviderRequest::deadline`] between work units. Returns the attempt
    /// [`policy::Usage`] on success or a typed [`ProviderError`]. No internal
    /// retry: a second billable attempt is a new `generation.retry` attempt.
    fn generate(
        &self,
        request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<policy::Usage, ProviderError>;
}

#[cfg(test)]
mod tests;
