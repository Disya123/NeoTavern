//! provider-sdk unit tests: deadline/retry arithmetic, error formatting,
//! secret redaction and cancellation semantics.
use super::policy::{Deadline, RetryPolicy, Usage};
use super::secret::{SecretRef, SecretResolver, SecretValue, UnavailableSecretResolver};
use super::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode,
    ProviderEvent, ProviderModel, ProviderRequest,
};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[test]
fn deadline_expiry_and_remaining() {
    let far = Deadline::after(Duration::from_secs(60));
    assert!(!far.expired());
    assert!(far.remaining().is_some());

    let past = Deadline::after(Duration::from_nanos(0));
    std::thread::sleep(Duration::from_millis(2));
    assert!(past.expired());
    assert_eq!(past.remaining(), None);
}

#[test]
fn retry_policy_no_retry_allows_exactly_one_attempt() {
    let policy = RetryPolicy::NO_RETRY;
    assert!(policy.allows(1));
    assert!(!policy.allows(0));
    assert!(!policy.allows(2));
}

#[test]
fn retry_policy_bound_allows_until_limit() {
    let policy = RetryPolicy {
        max_provider_attempts: 3,
    };
    assert!(policy.allows(1) && policy.allows(2) && policy.allows(3));
    assert!(!policy.allows(4));
    assert!(!policy.allows(0));
}

#[test]
fn usage_serializes_to_json() {
    let usage = Usage {
        steps: 4,
        output_chars: 128,
    };
    let json = serde_json::to_value(usage).expect("usage serializes");
    assert_eq!(json["steps"], 4);
    assert_eq!(json["outputChars"], 128);
}

#[test]
fn error_codes_display_kebab_case() {
    let cases = [
        (ProviderErrorCode::Timeout, "timeout"),
        (ProviderErrorCode::Cancelled, "cancelled"),
        (ProviderErrorCode::Unavailable, "unavailable"),
        (ProviderErrorCode::RequestInvalid, "request-invalid"),
        (ProviderErrorCode::StepFailed, "step-failed"),
        (ProviderErrorCode::NetworkFault, "network-fault"),
    ];
    for (code, text) in cases {
        assert_eq!(code.to_string(), text);
    }
}

#[test]
fn error_display_includes_code_message_and_params() {
    let err = ProviderError::with(
        ProviderErrorCode::StepFailed,
        "injected fault",
        vec![("step".to_string(), "3".to_string())],
    );
    assert_eq!(err.to_string(), "[step-failed] injected fault (step=3)");
    assert!(!err.retryable);
    assert_eq!(
        ProviderError::new(ProviderErrorCode::Timeout, "deadline").to_string(),
        "[timeout] deadline"
    );
}

#[test]
fn secret_value_debug_is_redacted() {
    let value = SecretValue::new("super-secret-value");
    let debug = format!("{value:?}");
    assert_eq!(debug, "SecretValue(<redacted>)");
    assert!(!debug.contains("super-secret-value"));
    assert_eq!(value.expose(), "super-secret-value");
}

#[test]
fn unavailable_secret_resolver_returns_typed_error_without_value() {
    let resolver = UnavailableSecretResolver;
    let err = resolver
        .resolve(&SecretRef("anthropic-key".to_string()))
        .expect_err("no secure storage here");
    assert_eq!(err.code, ProviderErrorCode::Unavailable);
    // The reference travels, never a value.
    assert_eq!(
        err.params,
        vec![("secretRef".to_string(), "anthropic-key".to_string())]
    );
}

#[test]
fn cancel_token_observes_flag() {
    let flag = AtomicBool::new(false);
    let token = CancelToken::new(&flag);
    assert!(!token.is_cancelled());
    flag.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(token.is_cancelled());
    // Cloned handle observes the same flag.
    let clone = token.clone();
    assert!(clone.is_cancelled());
}

/// Minimal adapter used to prove the trait is object-safe and callable
/// through `&dyn ProviderAdapter`.
struct OneShotProvider;

impl ProviderAdapter for OneShotProvider {
    fn id(&self) -> &str {
        "oneshot"
    }
    fn name(&self) -> &str {
        "One Shot"
    }
    fn builtin(&self) -> bool {
        true
    }
    fn models(&self) -> Vec<ProviderModel> {
        vec![ProviderModel {
            id: "m1".to_string(),
            name: "M1".to_string(),
            context_limit: Some(1024),
            max_output_tokens: None,
        }]
    }
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn generate(
        &self,
        _request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        if cancel.is_cancelled() {
            return Err(ProviderError::new(
                ProviderErrorCode::Cancelled,
                "cancelled",
            ));
        }
        let mut usage = Usage::default();
        for i in 0..3 {
            let text = format!("delta-{i}");
            usage.steps += 1;
            usage.output_chars += text.len() as u64;
            if emit(ProviderEvent::Delta { text }) == EmitStatus::Stop {
                return Err(ProviderError::new(ProviderErrorCode::Cancelled, "stopped"));
            }
        }
        Ok(usage)
    }
}

#[test]
fn adapter_trait_is_object_safe_and_streams_usage() {
    let provider: &dyn ProviderAdapter = &OneShotProvider;
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: "oneshot",
        model: "m1",
        input: "hi",
        run_key: "chat|1",
        deadline: None,
        api_key: None,
        messages: None,
    };
    let mut texts = Vec::new();
    let usage = provider
        .generate(&request, CancelToken::new(&flag), &mut |event| {
            let ProviderEvent::Delta { text } = event;
            texts.push(text);
            EmitStatus::Continue
        })
        .expect("one-shot succeeds");
    assert_eq!(usage.steps, 3);
    assert_eq!(texts, vec!["delta-0", "delta-1", "delta-2"]);
}

#[test]
fn adapter_stop_signal_cancels_the_attempt() {
    let provider: &dyn ProviderAdapter = &OneShotProvider;
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: "oneshot",
        model: "m1",
        input: "hi",
        run_key: "chat|1",
        deadline: None,
        api_key: None,
        messages: None,
    };
    let mut emitted = 0;
    let err = provider
        .generate(&request, CancelToken::new(&flag), &mut |_event| {
            emitted += 1;
            EmitStatus::Stop
        })
        .expect_err("stop must cancel");
    assert_eq!(err.code, ProviderErrorCode::Cancelled);
    assert_eq!(emitted, 1);
}

#[test]
fn adapter_availability_is_side_effect_free() {
    let provider: &dyn ProviderAdapter = &OneShotProvider;
    assert_eq!(provider.availability(), provider.availability());
    assert_eq!(provider.models().len(), 1);
    assert!(provider.builtin());
}
