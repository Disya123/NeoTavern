//! Deterministic `fake` provider (design §FakeProvider).
//!
//! Byte-identical port of the Phase 6 kernel inline fake provider: delta text
//! derives from `sha256(run_key|i)` — no wall clock — so two attempts with
//! the same `run_key` and model produce byte-identical payloads. The model
//! grammar is `;`-separated `key=value` pairs (`steps`, `fail-at`,
//! `delay-ms`, `tokens-per-step`, all optional).
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    };
    for segment in model.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let (key, value) = segment
            .split_once('=')
            .ok_or_else(|| model_invalid(model))?;
        let value = value.trim();
        let n: i64 = value.parse().map_err(|_| model_invalid(model))?;
        match key.trim() {
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
}
