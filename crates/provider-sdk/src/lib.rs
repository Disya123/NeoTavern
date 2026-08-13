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
/// deltas only.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProviderEvent {
    /// One text delta (bounded by the adapter).
    Delta {
        /// Delta text.
        text: String,
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

/// Sanitized generation request handed to an adapter. Built from the durable
/// run snapshot; contains no secrets (§62).
#[derive(Debug)]
pub struct ProviderRequest<'a> {
    /// Provider identifier (wire `provider` field).
    pub provider_id: &'a str,
    /// Model string selected by the caller.
    pub model: &'a str,
    /// Sanitized user input (from the run snapshot).
    pub input: &'a str,
    /// Stable execution identity `"{chat_id}|{attempt}"` — deterministic
    /// adapters derive their output from this key.
    pub run_key: &'a str,
    /// Per-run deadline, when the kernel sets one.
    pub deadline: Option<policy::Deadline>,
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
