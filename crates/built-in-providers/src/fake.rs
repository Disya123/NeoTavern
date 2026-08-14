//! Deterministic `fake` provider (design §FakeProvider).
//!
//! Byte-identical port of the Phase 6 kernel inline fake provider: delta text
//! derives from `sha256(run_key|i)` — no wall clock — so two attempts with
//! the same `run_key` and model produce byte-identical payloads. The model
//! grammar is `;`-separated `key=value` pairs (`steps`, `fail-at`,
//! `delay-ms`, `tokens-per-step`, `tool=<name>`, all optional).
//!
//! Tool mode (Этап 2.7, ТЗ §8.3): with `tool=<name>` the first provider turn
//! emits one normalized `ProviderEvent::ToolCall` (arguments derived from the
//! run input) instead of text, and the turn ends. On a RESUMED turn — the
//! request carries a `tool`-role result message appended by the kernel after
//! `generation.tool.result` — the provider emits deterministic final text and
//! ends, so a run can complete exactly one tool round trip.
//!
//! One billable attempt per [`generate`](FakeProvider::generate) call: the
//! shared call counter increments exactly once per entry, regardless of
//! outcome (no hidden retry, §55).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use provider_sdk::policy::Usage;
use provider_sdk::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode,
    ProviderEvent, ProviderModel, ProviderRequest,
};
use sha2::{Digest, Sha256};

use crate::sleep_checking;

/// Default fake-provider parameters (per design §3).
const DEFAULT_STEPS: usize = 8;
const DEFAULT_TOKENS_PER_STEP: usize = 6;

/// Parsed fake-provider configuration from the `model` string
/// (`;`-separated `key=value` pairs, all optional).
#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeConfig {
    /// Provider steps (default 8, clamp 1..=64).
    steps: usize,
    /// 1-based step at which the provider errors before producing; `None`
    /// never fails.
    fail_at: Option<usize>,
    /// Sleep per step in milliseconds (default 0, clamp 0..=200).
    delay_ms: u64,
    /// Delta chars per step (default 6, clamp 1..=256).
    tokens_per_step: usize,
    /// Tool-mode: the tool name the model calls on its first turn. `None`
    /// disables tools for the attempt.
    tool: Option<String>,
    /// Loop-mode (budget tests, ТЗ §8.3): the model calls `tool_loop` on
    /// EVERY turn — even resumed ones — so a kernel run keeps re-entering the
    /// waiting state until its loop guard fails the run. `None` disables.
    tool_loop: Option<String>,
}

/// Deterministic built-in `fake` provider.
#[derive(Debug)]
pub struct FakeProvider {
    call_counter: Arc<AtomicU64>,
}

impl FakeProvider {
    /// Creates the provider with a fresh (unused) call counter.
    pub fn new() -> Self {
        Self::with_call_counter(Arc::new(AtomicU64::new(0)))
    }

    /// Creates the provider sharing a call counter.
    ///
    /// The counter is incremented exactly once per
    /// [`generate`](ProviderAdapter::generate) entry, regardless of outcome —
    /// conformance proves one billable attempt per call (§55).
    pub fn with_call_counter(call_counter: Arc<AtomicU64>) -> Self {
        Self { call_counter }
    }
}

impl Default for FakeProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Parses the fake model grammar; a malformed or unknown key yields
/// `RequestInvalid` carrying the raw model as a parameter.
fn parse_config(model: &str) -> Result<FakeConfig, ProviderError> {
    let mut cfg = FakeConfig {
        steps: DEFAULT_STEPS,
        fail_at: None,
        delay_ms: 0,
        tokens_per_step: DEFAULT_TOKENS_PER_STEP,
        tool: None,
        tool_loop: None,
    };
    for segment in model.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let (key, value) = segment
            .split_once('=')
            .ok_or_else(|| model_invalid(model))?;
        let key = key.trim();
        let value = value.trim();
        // `tool`/`tool-loop` take a name, everything else a clamped integer.
        if key == "tool" || key == "tool-loop" {
            if value.is_empty()
                || !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(model_invalid(model));
            }
            if key == "tool" {
                cfg.tool = Some(value.to_string());
            } else {
                cfg.tool_loop = Some(value.to_string());
            }
            continue;
        }
        let n: i64 = value.parse().map_err(|_| model_invalid(model))?;
        match key {
            "steps" => cfg.steps = n.clamp(1, 64) as usize,
            "fail-at" => cfg.fail_at = Some(n.clamp(1, cfg.steps as i64) as usize),
            "delay-ms" => cfg.delay_ms = n.clamp(0, 200) as u64,
            "tokens-per-step" => cfg.tokens_per_step = n.clamp(1, 256) as usize,
            _ => return Err(model_invalid(model)),
        }
    }
    // `fail-at` clamps against the final step count regardless of order.
    if let Some(fail_at) = cfg.fail_at {
        cfg.fail_at = Some(fail_at.clamp(1, cfg.steps));
    }
    Ok(cfg)
}

fn model_invalid(model: &str) -> ProviderError {
    ProviderError::with(
        ProviderErrorCode::RequestInvalid,
        format!("invalid fake model grammar: {model}"),
        vec![("model".to_string(), model.to_string())],
    )
}

/// Attempt number from a `"{chat_id}|{attempt}"` run key: the integer after
/// the LAST `|`, falling back to `1` when missing or unparseable.
fn parse_attempt(run_key: &str) -> u64 {
    run_key
        .rsplit_once('|')
        .and_then(|(_, tail)| tail.parse::<u64>().ok())
        .unwrap_or(1)
}

/// Deterministic delta text for step `i` (0-based):
/// `[attempt {a}] step {i+1}/{steps}: {hex8}` where `hex8` is the first 8
/// hex chars of `sha256(run_key|i)`, truncated to `tokens_per_step` chars.
fn delta_text(
    run_key: &str,
    attempt: u64,
    step: usize,
    steps: usize,
    tokens_per_step: usize,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(run_key.as_bytes());
    hasher.update(b"|");
    hasher.update(step.to_string().as_bytes());
    let digest = hasher.finalize();
    let hex8 = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    );
    let text = format!("[attempt {attempt}] step {}/{}: {hex8}", step + 1, steps);
    text.chars().take(tokens_per_step).collect()
}

/// Deterministic final text emitted by tool mode on the resumed turn:
/// `[tool-result] final {hex8}` where `hex8` derives from `sha256(run_key)`.
fn tool_final_text(run_key: &str, attempt: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(run_key.as_bytes());
    let digest = hasher.finalize();
    let hex8 = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    );
    format!("[tool-result {attempt}] final {hex8}")
}

impl ProviderAdapter for FakeProvider {
    fn id(&self) -> &str {
        "fake"
    }

    fn name(&self) -> &str {
        "Fake Provider"
    }

    fn builtin(&self) -> bool {
        true
    }

    fn models(&self) -> Vec<ProviderModel> {
        vec![ProviderModel {
            id: "fake-1".to_string(),
            name: "Fake 1".to_string(),
            context_limit: Some(8192),
            max_output_tokens: None,
        }]
    }

    fn availability(&self) -> Availability {
        Availability::Available
    }

    fn generate(
        &self,
        request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        self.call_counter.fetch_add(1, Ordering::SeqCst);
        // Pre-cancel check at generate entry (design §FakeProvider).
        if cancel.is_cancelled() {
            return Err(ProviderError::new(
                ProviderErrorCode::Cancelled,
                "cancelled before start",
            ));
        }
        let cfg = parse_config(request.model)?;
        let attempt = parse_attempt(request.run_key);

        // Tool loop-mode (budget tests, ТЗ §8.3): EVERY turn — including
        // resumed ones with a tool-role result — emits a tool call, so the
        // kernel's loop guard is exercised.
        if let Some(tool_name) = &cfg.tool_loop {
            if emit(ProviderEvent::ToolCall {
                id: format!("fake-loop-call-{attempt}"),
                name: tool_name.clone(),
                arguments: serde_json::json!({ "query": request.input }),
            }) == EmitStatus::Stop
            {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "executor requested stop",
                ));
            }
            return Ok(Usage {
                steps: 1,
                output_chars: 0,
            });
        }

        // Tool mode (Этап 2.7): a resumed turn — the kernel appended a
        // `tool`-role result message — emits deterministic final text; the
        // first turn emits one normalized tool call instead of text.
        if let Some(tool_name) = &cfg.tool {
            let has_tool_result = request
                .messages
                .is_some_and(|messages| messages.iter().any(|m| m.role == "tool"));
            if has_tool_result {
                let text = tool_final_text(request.run_key, attempt);
                if emit(ProviderEvent::Delta { text }) == EmitStatus::Stop {
                    return Err(ProviderError::new(
                        ProviderErrorCode::Cancelled,
                        "executor requested stop",
                    ));
                }
                return Ok(Usage {
                    steps: 1,
                    output_chars: 1,
                });
            }
            if emit(ProviderEvent::ToolCall {
                id: format!("fake-call-{attempt}"),
                name: tool_name.clone(),
                arguments: serde_json::json!({ "query": request.input }),
            }) == EmitStatus::Stop
            {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "executor requested stop",
                ));
            }
            return Ok(Usage {
                steps: 1,
                output_chars: 0,
            });
        }

        let mut emitted_steps: u64 = 0;
        let mut output_chars: u64 = 0;
        for i in 0..cfg.steps {
            if cancel.is_cancelled() {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "cancelled before step",
                ));
            }
            if request.deadline.is_some_and(|d| d.expired()) {
                return Err(ProviderError::new(
                    ProviderErrorCode::Timeout,
                    "deadline expired before step",
                ));
            }
            // fail-at=N errors BEFORE producing step N (1-based).
            if cfg.fail_at == Some(i + 1) {
                return Err(ProviderError::with(
                    ProviderErrorCode::StepFailed,
                    format!("fake provider failed at step {}", i + 1),
                    vec![("step".to_string(), (i + 1).to_string())],
                ));
            }
            let text = delta_text(request.run_key, attempt, i, cfg.steps, cfg.tokens_per_step);
            let chars = text.chars().count() as u64;
            if emit(ProviderEvent::Delta { text }) == EmitStatus::Stop {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "executor requested stop",
                ));
            }
            emitted_steps += 1;
            output_chars += chars;
            // delay-ms sleeps BETWEEN steps (not before the first).
            if i + 1 < cfg.steps {
                sleep_checking(&cancel, request.deadline, cfg.delay_ms)?;
            }
        }
        Ok(Usage {
            steps: emitted_steps,
            output_chars,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// A never-cancelled token for unit tests.
    fn never_cancel() -> CancelToken<'static> {
        static FLAG: AtomicBool = AtomicBool::new(false);
        CancelToken::new(&FLAG)
    }

    #[test]
    fn delta_text_byte_identity() {
        // Byte-identity check (assignment): recompute sha256 in-test and
        // require the exact same strings the adapter produces.
        let run_key = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1";
        let steps = 3usize;
        let tokens_per_step = 64usize; // no truncation of the ~28-char text
        for i in 0..steps {
            let mut hasher = Sha256::new();
            hasher.update(run_key.as_bytes());
            hasher.update(b"|");
            hasher.update(i.to_string().as_bytes());
            let digest = hasher.finalize();
            let hex8 = format!(
                "{:02x}{:02x}{:02x}{:02x}",
                digest[0], digest[1], digest[2], digest[3]
            );
            let expected = format!("[attempt 1] step {}/{}: {hex8}", i + 1, steps);
            assert_eq!(delta_text(run_key, 1, i, steps, tokens_per_step), expected);
        }
    }

    #[test]
    fn parse_attempt_falls_back_to_one() {
        assert_eq!(parse_attempt("7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1"), 1);
        assert_eq!(parse_attempt("no-pipe"), 1);
        assert_eq!(parse_attempt("chat|not-a-number"), 1);
        assert_eq!(parse_attempt("chat|42"), 42);
        assert_eq!(parse_attempt("a|b|c|7"), 7);
    }

    #[test]
    fn model_grammar_unknown_key_is_request_invalid() {
        let err = parse_config("bogus=1").unwrap_err();
        assert_eq!(err.code, ProviderErrorCode::RequestInvalid);
        assert_eq!(
            err.params,
            vec![("model".to_string(), "bogus=1".to_string())]
        );
    }

    #[test]
    fn model_grammar_unparseable_value_is_request_invalid() {
        for model in ["steps=abc", "steps=", "steps=1.5", "no-equals"] {
            let err = parse_config(model).unwrap_err();
            assert_eq!(err.code, ProviderErrorCode::RequestInvalid);
            assert_eq!(err.params, vec![("model".to_string(), model.to_string())]);
        }
    }

    #[test]
    fn model_grammar_clamps_and_skips_empty_segments() {
        let cfg = parse_config(";;steps=999;tokens-per-step=0;delay-ms=-5;;").unwrap();
        assert_eq!(cfg.steps, 64);
        assert_eq!(cfg.tokens_per_step, 1);
        assert_eq!(cfg.delay_ms, 0);
        assert_eq!(cfg.fail_at, None);
        assert_eq!(cfg.tool, None);
    }

    #[test]
    fn model_grammar_tool_key_takes_a_name() {
        let cfg = parse_config("tool=lookup_weather").unwrap();
        assert_eq!(cfg.tool.as_deref(), Some("lookup_weather"));
        // Non-alphanumeric tool names and missing values are rejected.
        for bad in ["tool=", "tool=with space", "tool=bad/name", "tool=ümlaut"] {
            assert!(parse_config(bad).is_err(), "{bad} must be invalid");
        }
        // tool-loop accepts the same grammar.
        let cfg = parse_config("tool-loop=lookup_weather").unwrap();
        assert_eq!(cfg.tool_loop.as_deref(), Some("lookup_weather"));
        assert!(parse_config("tool-loop=").is_err());
    }

    #[test]
    fn tool_loop_mode_emits_a_call_on_every_turn() {
        let provider = FakeProvider::new();
        let run_key = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1";
        let model = "tool-loop=lookup_weather";
        // A resumed turn (tool-role result present) STILL emits a call.
        let tool_message = provider_sdk::PromptMessage {
            role: "tool",
            content: "sunny",
            tool_calls: None,
            tool_call_id: Some("call-1"),
        };
        let request = ProviderRequest {
            provider_id: "fake",
            model,
            input: "weather in Kyiv",
            run_key,
            deadline: None,
            api_key: None,
            messages: Some(&[tool_message]),
            tools: None,
        };
        let mut events = Vec::new();
        let usage = provider
            .generate(&request, never_cancel(), &mut |event| {
                events.push(event);
                EmitStatus::Continue
            })
            .expect("loop turn succeeds");
        assert_eq!(usage.steps, 1);
        assert_eq!(usage.output_chars, 0);
        assert_eq!(events.len(), 1);
        let ProviderEvent::ToolCall { name, .. } = &events[0] else {
            panic!("expected a tool call, got {events:?}");
        };
        assert_eq!(name, "lookup_weather");
    }

    #[test]
    fn fail_at_reclamped_to_final_steps() {
        // fail-at before steps: intermediate clamp hits the default 8, then
        // the final re-clamp against the parsed step count.
        let cfg = parse_config("fail-at=100;steps=3").unwrap();
        assert_eq!(cfg.fail_at, Some(3));
        let cfg = parse_config("steps=3;fail-at=100").unwrap();
        assert_eq!(cfg.fail_at, Some(3));
        let cfg = parse_config("steps=3;fail-at=0").unwrap();
        assert_eq!(cfg.fail_at, Some(1));
    }

    #[test]
    fn fake_metadata_matches_design() {
        let provider = FakeProvider::new();
        assert_eq!(provider.id(), "fake");
        assert_eq!(provider.name(), "Fake Provider");
        assert!(provider.builtin());
        assert_eq!(provider.availability(), Availability::Available);
        assert_eq!(
            provider.models(),
            vec![ProviderModel {
                id: "fake-1".to_string(),
                name: "Fake 1".to_string(),
                context_limit: Some(8192),
                max_output_tokens: None,
            }]
        );
    }

    #[test]
    fn tool_mode_emits_call_then_final_text_on_resume() {
        let provider = FakeProvider::new();
        let run_key = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1";
        let model = "tool=lookup_weather";

        // Turn 1: a normalized tool call, no text.
        let request = ProviderRequest {
            provider_id: "fake",
            model,
            input: "weather in Kyiv",
            run_key,
            deadline: None,
            api_key: None,
            messages: None,
            tools: None,
        };
        let mut events = Vec::new();
        let result = provider.generate(&request, never_cancel(), &mut |event| {
            events.push(event);
            EmitStatus::Continue
        });
        let usage = result.expect("turn 1 succeeds");
        assert_eq!(usage.steps, 1);
        assert_eq!(usage.output_chars, 0);
        assert_eq!(events.len(), 1);
        let ProviderEvent::ToolCall {
            id,
            name,
            arguments,
        } = &events[0]
        else {
            panic!("expected a tool call, got {events:?}");
        };
        assert_eq!(name, "lookup_weather");
        assert!(id.starts_with("fake-call-"));
        assert_eq!(arguments["query"], serde_json::json!("weather in Kyiv"));

        // Turn 2 (resumed): a tool-role result message present → final text.
        let tool_message = provider_sdk::PromptMessage {
            role: "tool",
            content: "sunny, 21 C",
            tool_calls: None,
            tool_call_id: Some("call-1"),
        };
        let resumed = ProviderRequest {
            provider_id: "fake",
            model,
            input: "weather in Kyiv",
            run_key,
            deadline: None,
            api_key: None,
            messages: Some(&[tool_message]),
            tools: None,
        };
        let mut events = Vec::new();
        let usage = provider
            .generate(&resumed, never_cancel(), &mut |event| {
                events.push(event);
                EmitStatus::Continue
            })
            .expect("turn 2 succeeds");
        assert_eq!(usage.steps, 1);
        assert_eq!(events.len(), 1);
        let ProviderEvent::Delta { text } = &events[0] else {
            panic!("expected final text, got {events:?}");
        };
        assert!(text.starts_with("[tool-result 1] final "), "got {text}");
        // Deterministic across runs.
        let mut events2 = Vec::new();
        provider
            .generate(&resumed, never_cancel(), &mut |event| {
                events2.push(event);
                EmitStatus::Continue
            })
            .expect("turn 2 rerun");
        assert_eq!(events, events2);
    }
}
