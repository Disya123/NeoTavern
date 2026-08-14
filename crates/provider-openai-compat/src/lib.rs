//! Production OpenAI-compatible provider adapter (ТЗ §9.3, Этап 2.5).
//!
//! A [`ProviderAdapter`] that speaks the OpenAI **chat completions streaming**
//! protocol (`POST {baseUrl}/chat/completions`, SSE `data:` frames) against
//! any OpenAI-compatible endpoint — OpenAI, local/self-hosted servers
//! (vLLM, llama.cpp, LocalAI, Ollama-compatible gateways), etc.
//!
//! Configuration arrives as a non-secret `provider_configs.config_json`
//! object (wire `providers.config.set`, ТЗ §9.4):
//!
//! ```json
//! {
//!   "baseUrl": "https://api.openai.com/v1",
//!   "models": [
//!     { "id": "gpt-4o-mini", "name": "GPT-4o mini", "contextLimit": 128000 }
//!   ],
//!   "timeoutMs": 60000,
//!   "maxResponseBytes": 16777216,
//!   "maxTokens": 2048,
//!   "organization": null
//! }
//! ```
//!
//! The API key is **never** part of the config: the kernel resolves the
//! config's `secret_ref` through the host's SecretResolver seam at execution
//! time and hands the value via [`ProviderRequest::api_key`] only for the
//! outgoing `Authorization` header (§9.4). The adapter never stores, logs,
//! or echoes the key.
//!
//! Streaming is bounded (SEC-04): the response body is capped at
//! `maxResponseBytes`, the response is destroyed immediately when the cap is
//! exceeded, and cancellation/deadline are re-checked between every chunk.

pub mod http;

use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

use provider_sdk::policy::Usage;
use provider_sdk::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode,
    ProviderEvent, ProviderModel, ProviderRequest,
};

/// Default per-attempt timeout when `timeoutMs` is absent.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default response body budget (SEC-04).
const DEFAULT_MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
/// Default model exposed when the config carries no `models`.
const DEFAULT_MODEL_ID: &str = "gpt-4o-mini";

/// Parsed endpoint (scheme + host + port + path prefix).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Endpoint {
    tls: bool,
    host: String,
    port: u16,
    prefix: String,
}

impl Endpoint {
    fn parse(base_url: &str) -> Result<Self, String> {
        let (scheme, rest) = base_url
            .split_once("://")
            .ok_or_else(|| format!("baseUrl must be http(s)://host[:port][/path]: {base_url}"))?;
        let tls = match scheme {
            "https" => true,
            "http" => false,
            other => return Err(format!("unsupported scheme '{other}' in baseUrl")),
        };
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, path.trim_end_matches('/')),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return Err("baseUrl has an empty host".to_string());
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => {
                let port: u16 = port.parse().map_err(|_| "invalid port in baseUrl")?;
                (host.to_string(), port)
            }
            None => (authority.to_string(), if tls { 443 } else { 80 }),
        };
        if host.is_empty() || host.contains(char::is_whitespace) {
            return Err("invalid host in baseUrl".to_string());
        }
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("/{path}")
        };
        Ok(Self {
            tls,
            host,
            port,
            prefix,
        })
    }

    /// The chat-completions path: `{prefix}/chat/completions`.
    fn chat_completions_path(&self) -> String {
        format!("{}/chat/completions", self.prefix)
    }
}

/// One configured model (`wire.provider.model`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// Stable model identifier (sent in `model`).
    pub id: String,
    /// Display name (defaults to the id).
    #[serde(default)]
    pub name: Option<String>,
    /// Context window size, when known.
    #[serde(default)]
    pub context_limit: Option<i64>,
    /// Maximum output tokens, when known.
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
}

/// Non-secret provider configuration (wire `providers.config.set` `config`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Endpoint root, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    /// Exposed models; empty → one default model.
    #[serde(default)]
    pub models: Vec<ModelSpec>,
    /// Per-attempt timeout in milliseconds (default 60000).
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// Optional `OpenAI-Organization` header.
    #[serde(default)]
    pub organization: Option<String>,
    /// Response body budget in bytes (SEC-04; default 16 MiB).
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: u64,
    /// Optional `max_tokens` sent with every request.
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT.as_millis() as u64
}

fn default_max_response_bytes() -> u64 {
    DEFAULT_MAX_RESPONSE_BYTES
}

/// The OpenAI-compatible provider adapter.
#[derive(Debug, Clone)]
pub struct OpenAICompatProvider {
    /// Wire provider id (e.g. `"openai"`).
    id: String,
    /// Parsed endpoint.
    endpoint: Endpoint,
    /// Exposed models (non-empty).
    models: Vec<ProviderModel>,
    /// Per-attempt timeout.
    timeout: Duration,
    /// Response byte budget (SEC-04).
    max_response_bytes: u64,
    /// Optional `OpenAI-Organization` header value.
    organization: Option<String>,
    /// Optional `max_tokens` for outgoing requests.
    max_tokens: Option<u32>,
}

impl OpenAICompatProvider {
    /// Builds the provider from a non-secret config value (the `config`
    /// object stored by `providers.config.set`).
    ///
    /// `provider_id` is the wire id under which the provider is registered
    /// (usually `"openai"`). Returns a descriptive `Err` for invalid
    /// configuration — never a panic.
    pub fn from_config(
        provider_id: impl Into<String>,
        config: &serde_json::Value,
    ) -> Result<Self, String> {
        let config: ProviderConfig = serde_json::from_value(config.clone())
            .map_err(|err| format!("invalid provider config: {err}"))?;
        Self::from_parsed(provider_id, config)
    }

    /// Builds the provider from a raw JSON string (test convenience).
    pub fn from_config_json(
        provider_id: impl Into<String>,
        config_json: &str,
    ) -> Result<Self, String> {
        let config: ProviderConfig = serde_json::from_str(config_json)
            .map_err(|err| format!("invalid provider config: {err}"))?;
        Self::from_parsed(provider_id, config)
    }

    fn from_parsed(provider_id: impl Into<String>, config: ProviderConfig) -> Result<Self, String> {
        let endpoint = Endpoint::parse(&config.base_url)?;
        let models = if config.models.is_empty() {
            vec![ModelSpec {
                id: DEFAULT_MODEL_ID.to_string(),
                name: None,
                context_limit: None,
                max_output_tokens: None,
            }]
        } else {
            config.models
        };
        let models = models
            .into_iter()
            .map(|model| ProviderModel {
                id: model.id.clone(),
                name: model.name.unwrap_or_else(|| model.id.clone()),
                context_limit: model.context_limit,
                max_output_tokens: model.max_output_tokens,
            })
            .collect();
        Ok(Self {
            id: provider_id.into(),
            endpoint,
            models,
            timeout: Duration::from_millis(config.timeout_ms.max(1)),
            max_response_bytes: config.max_response_bytes.max(1),
            organization: config.organization,
            max_tokens: config.max_tokens,
        })
    }
}

impl ProviderAdapter for OpenAICompatProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        "OpenAI Compatible"
    }

    fn builtin(&self) -> bool {
        false
    }

    fn models(&self) -> Vec<ProviderModel> {
        self.models.clone()
    }

    fn availability(&self) -> Availability {
        // Construction validates the endpoint; a live probe would cost a
        // network round-trip, which the contract forbids here. Real
        // availability surfaces as normalized per-run errors.
        Availability::Available
    }

    fn generate(
        &self,
        request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        if cancel.is_cancelled() {
            return Err(ProviderError::new(
                ProviderErrorCode::Cancelled,
                "cancelled before start",
            ));
        }
        let api_key = request.api_key.ok_or_else(|| {
            ProviderError::with(
                ProviderErrorCode::RequestInvalid,
                "provider requires an API key (configure it via providers.config.set)",
                vec![("provider".to_string(), self.id.clone())],
            )
        })?;

        let body = build_body(request, self.max_tokens)?;
        let headers = render_headers(api_key, self.organization.as_deref());
        let path = self.endpoint.chat_completions_path();
        let connect_timeout = request
            .deadline
            .and_then(|d| d.remaining())
            .unwrap_or(self.timeout)
            .min(self.timeout);
        let read_timeout = request
            .deadline
            .and_then(|d| d.remaining())
            .unwrap_or(self.timeout);

        let http_request = http::HttpRequest {
            path: &path,
            host: &self.endpoint.host,
            port: self.endpoint.port,
            tls: self.endpoint.tls,
            headers,
            body: &body,
        };
        let response = match http::send(&http_request, connect_timeout, Some(read_timeout)) {
            Ok(response) => response,
            Err(err) => return Err(map_io_error(err)),
        };

        if !(200..300).contains(&response.status) {
            return Err(map_http_status(response.status));
        }

        let reader = response.body.with_budget(self.max_response_bytes);
        let mut steps: u64 = 0;
        let mut output_chars: u64 = 0;

        let mut reader = BufReader::new(reader);
        let mut sse = SseReader::new(&mut reader);
        loop {
            if cancel.is_cancelled() {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "cancelled while streaming",
                ));
            }
            if request.deadline.is_some_and(|d| d.expired()) {
                return Err(ProviderError::new(
                    ProviderErrorCode::Timeout,
                    "deadline expired while streaming",
                ));
            }
            match sse.next_event() {
                Ok(Some(event)) => match event {
                    SseEvent::Done => break,
                    SseEvent::Data(json) => {
                        if let Some(error) = json.get("error") {
                            return Err(map_sse_error(error));
                        }
                        let Some(choices) = json.get("choices").and_then(|c| c.as_array()) else {
                            continue;
                        };
                        for choice in choices {
                            let Some(delta) = choice.get("delta").and_then(|d| d.as_object())
                            else {
                                continue;
                            };
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if content.is_empty() {
                                    continue;
                                }
                                let chars = content.chars().count() as u64;
                                if emit(ProviderEvent::Delta {
                                    text: content.to_string(),
                                }) == EmitStatus::Stop
                                {
                                    return Err(ProviderError::new(
                                        ProviderErrorCode::Cancelled,
                                        "executor requested stop",
                                    ));
                                }
                                steps += 1;
                                output_chars += chars;
                            }
                        }
                    }
                },
                Ok(None) => break, // end of stream
                Err(err) => return Err(map_stream_error(err)),
            }
        }

        Ok(Usage {
            steps,
            output_chars,
        })
    }
}

/// Builds the chat-completions JSON body (`stream: true`).
fn build_body(
    request: &ProviderRequest<'_>,
    max_tokens: Option<u32>,
) -> Result<Vec<u8>, ProviderError> {
    let mut body = serde_json::json!({
        "model": request.model,
        "messages": [ { "role": "user", "content": request.input } ],
        "stream": true,
    });
    if let Some(max_tokens) = max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    serde_json::to_vec(&body).map_err(|err| {
        ProviderError::with(
            ProviderErrorCode::StepFailed,
            "failed to serialize the chat-completions request",
            vec![("detail".to_string(), err.to_string())],
        )
    })
}

/// Owned header strings (rendered per request).
///
/// The API key appears only in this ephemeral buffer for the outgoing
/// request; it is never stored, logged, or echoed.
fn render_headers(api_key: &str, organization: Option<&str>) -> Vec<String> {
    let mut headers = vec![
        format!("Authorization: Bearer {api_key}"),
        "Content-Type: application/json".to_string(),
        "Accept: text/event-stream".to_string(),
    ];
    if let Some(org) = organization {
        headers.push(format!("OpenAI-Organization: {org}"));
    }
    headers
}

/// Maps connection-level IO errors to normalized provider errors.
fn map_io_error(err: std::io::Error) -> ProviderError {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => ProviderError::with(
            ProviderErrorCode::Timeout,
            "provider connection timed out",
            vec![("kind".to_string(), "timeout".to_string())],
        ),
        ErrorKind::Interrupted => ProviderError::new(
            ProviderErrorCode::Cancelled,
            "provider connection interrupted",
        ),
        ErrorKind::ConnectionRefused
        | ErrorKind::ConnectionReset
        | ErrorKind::ConnectionAborted => ProviderError::with(
            ProviderErrorCode::NetworkFault,
            "provider connection failed",
            vec![("kind".to_string(), "connection".to_string())],
        ),
        _ => ProviderError::with(
            ProviderErrorCode::NetworkFault,
            "provider transport error",
            vec![("kind".to_string(), err.kind().to_string())],
        ),
    }
}

/// Maps a non-2xx HTTP status to a normalized provider error (advisory
/// retryable flags; the kernel/UI decide actual retries, §55).
fn map_http_status(status: u16) -> ProviderError {
    let retryable = matches!(status, 408 | 429 | 500..=599);
    let code = match status {
        400 | 404 | 422 => ProviderErrorCode::RequestInvalid,
        401 | 403 => ProviderErrorCode::Unavailable,
        408 | 429 | 500..=599 => ProviderErrorCode::StepFailed,
        _ => ProviderErrorCode::StepFailed,
    };
    let mut err = ProviderError::with(
        code,
        format!("provider returned HTTP {status}"),
        vec![("httpStatus".to_string(), status.to_string())],
    );
    err.retryable = retryable;
    err
}

/// Maps an SSE `error` object to a normalized provider error.
fn map_sse_error(error: &serde_json::Value) -> ProviderError {
    let code = error
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    let (kind, retryable) = match code {
        "invalid_api_key" | "insufficient_quota" => (ProviderErrorCode::Unavailable, false),
        "rate_limit_exceeded" => (ProviderErrorCode::StepFailed, true),
        _ => (ProviderErrorCode::StepFailed, false),
    };
    let mut err = ProviderError::with(
        kind,
        "provider returned an error event",
        vec![("errorCode".to_string(), code.to_string())],
    );
    err.retryable = retryable;
    err
}

/// Maps a stream read failure: the byte-budget breach surfaces as
/// `StepFailed` (the connection is destroyed, SEC-04); anything else is a
/// network fault.
fn map_stream_error(err: std::io::Error) -> ProviderError {
    if err.to_string().contains("max_response_bytes") {
        return ProviderError::with(
            ProviderErrorCode::StepFailed,
            "provider response exceeded the byte budget",
            vec![("kind".to_string(), "budget".to_string())],
        );
    }
    map_io_error(err)
}

/// One parsed SSE event.
enum SseEvent {
    /// The `data: [DONE]` sentinel.
    Done,
    /// A JSON payload.
    Data(serde_json::Value),
}

/// Incremental SSE reader: buffers `data:` lines until the blank separator,
/// then yields the assembled event.
struct SseReader<'r, R: Read> {
    reader: &'r mut BufReader<R>,
    data_lines: Vec<String>,
}

impl<'r, R: Read> SseReader<'r, R> {
    fn new(reader: &'r mut BufReader<R>) -> Self {
        Self {
            reader,
            data_lines: Vec::new(),
        }
    }

    /// Reads the next event; `Ok(None)` at end of stream.
    fn next_event(&mut self) -> std::io::Result<Option<SseEvent>> {
        loop {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line)?;
            if n == 0 {
                // Flush any buffered data lines at EOF.
                return Ok(self.take_buffered());
            }
            if line.ends_with('\n') {
                line.pop();
                if line.ends_with('\r') {
                    line.pop();
                }
            }
            if line.is_empty() {
                return Ok(self.take_buffered());
            }
            if let Some(payload) = line.strip_prefix("data:") {
                self.data_lines.push(payload.trim_start().to_string());
            }
        }
    }

    fn take_buffered(&mut self) -> Option<SseEvent> {
        if self.data_lines.is_empty() {
            return None;
        }
        let joined = self.data_lines.join("\n");
        self.data_lines.clear();
        if joined == "[DONE]" {
            return Some(SseEvent::Done);
        }
        match serde_json::from_str(&joined) {
            Ok(value) => Some(SseEvent::Data(value)),
            Err(err) => {
                // A malformed payload is a provider-side step failure, not a
                // protocol dead-end: report and keep the stream closed.
                eprintln!("provider-openai-compat: malformed SSE payload: {err}");
                Some(SseEvent::Data(serde_json::json!({
                    "error": { "code": "invalid_sse_payload", "message": "malformed SSE payload" }
                })))
            }
        }
    }
}

#[cfg(test)]
mod tests;
