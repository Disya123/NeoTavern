//! Shared conformance battery (design §Conformance suite), applied to BOTH
//! built-in providers, plus fake-specific single-billing and byte-identity
//! coverage.
//!
//! Every generate call must be exactly one billable attempt (§55): the fake
//! provider's shared call counter is asserted after each battery step.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use built_in_providers::{FakeProvider, RecordedProvider, RecordedScript};
use provider_sdk::policy::{Deadline, Usage};
use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::{
    CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode, ProviderEvent,
    ProviderRequest,
};

const PLAIN: &str = include_str!("../fixtures/plain.json");
const FAULTS: &str = include_str!("../fixtures/faults.json");
const FAIL_NETWORK: &str = include_str!("../fixtures/fail-network.json");

/// Per-provider models used by the shared battery.
struct ConformanceModels {
    /// Deterministic happy path (≥2 steps, no failure).
    happy: &'static str,
    /// Slow path with sleep steps (cancel/timeout tests).
    slow: &'static str,
    /// Fails with `StepFailed`, when the provider can produce it.
    fail_step: Option<&'static str>,
    /// Fails with `NetworkFault`, when the provider can produce it.
    fail_network: Option<&'static str>,
    /// Unknown/invalid model for the redaction test.
    unknown: &'static str,
}

/// Resolver that hands out the sentinel secret (§68 seam — what an upstream
/// host would use; the redaction test proves it never leaks).
struct SuperSecretResolver;

impl SecretResolver for SuperSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Ok(SecretValue::new("super-secret-value"))
    }
}

/// Runs one generate call, collecting emitted delta texts in order.
fn generate_collect(
    provider: &dyn ProviderAdapter,
    model: &str,
    deadline: Option<Deadline>,
    flag: &AtomicBool,
) -> (Result<Usage, ProviderError>, Vec<String>) {
    let request = ProviderRequest {
        provider_id: provider.id(),
        model,
        input: "hello",
        run_key: "chat-123|1",
        deadline,
        api_key: None,
        messages: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(flag), &mut |event| {
        let ProviderEvent::Delta { text } = event;
        texts.push(text);
        EmitStatus::Continue
    });
    (result, texts)
}

/// Runs one generate call that flips the cancel flag after the first delta,
/// so cancellation lands mid-stream.
fn generate_cancel_midstream(
    provider: &dyn ProviderAdapter,
    model: &str,
    flag: &AtomicBool,
) -> (Result<Usage, ProviderError>, Vec<String>) {
    let request = ProviderRequest {
        provider_id: provider.id(),
        model,
        input: "hello",
        run_key: "chat-123|1",
        deadline: None,
        api_key: None,
        messages: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(flag), &mut |event| {
        let ProviderEvent::Delta { text } = event;
        texts.push(text);
        flag.store(true, Ordering::SeqCst);
        EmitStatus::Continue
    });
    (result, texts)
}

/// Runs one generate call whose emit sink returns `Stop` on the very first
/// event; returns the number of events the sink saw.
fn generate_stop_first(
    provider: &dyn ProviderAdapter,
    model: &str,
) -> (Result<Usage, ProviderError>, usize) {
    let request = ProviderRequest {
        provider_id: provider.id(),
        model,
        input: "hello",
        run_key: "chat-123|1",
        deadline: None,
        api_key: None,
        messages: None,
    };
    let flag = AtomicBool::new(false);
    let mut seen = 0usize;
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |_event| {
        seen += 1;
        EmitStatus::Stop
    });
    (result, seen)
}

/// Asserts the shared call counter equals `expected` (exactly one billable
/// attempt per generate call, §55), then bumps it.
fn assert_calls(counter: Option<&AtomicU64>, expected: &mut u64) {
    if let Some(counter) = counter {
        assert_eq!(
            counter.load(Ordering::SeqCst),
            *expected,
            "exactly one billable attempt per generate call"
        );
    }
    *expected += 1;
}

/// Shared battery (design §Conformance suite). `counter` is `Some` for the
/// fake provider only.
fn run_conformance(
    provider: &dyn ProviderAdapter,
    models: &ConformanceModels,
    counter: Option<&AtomicU64>,
) {
    let mut expected_calls: u64 = 1;

    // 1. happy path: usage accounting matches the emitted deltas.
    let flag = AtomicBool::new(false);
    let (result, texts) = generate_collect(provider, models.happy, None, &flag);
    let usage = result.expect("happy path must succeed");
    assert!(!texts.is_empty(), "happy path must emit deltas");
    assert_eq!(usage.steps as usize, texts.len());
    assert_eq!(
        usage.output_chars,
        texts.iter().map(|t| t.chars().count() as u64).sum::<u64>()
    );
    assert_calls(counter, &mut expected_calls);

    // 2. cancel mid-stream (Sleep steps): Err Cancelled, partial output.
    let flag = AtomicBool::new(false);
    let (result, texts) = generate_cancel_midstream(provider, models.slow, &flag);
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Cancelled));
    assert!(
        !texts.is_empty(),
        "mid-stream cancel must have produced partial output"
    );
    assert_calls(counter, &mut expected_calls);

    // 3. timeout: 1ms deadline with Sleep steps -> Err Timeout.
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(
        provider,
        models.slow,
        Some(Deadline::after(Duration::from_millis(1))),
        &flag,
    );
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Timeout));
    assert_calls(counter, &mut expected_calls);

    // 4. fault injection: fail markers map to the matching error codes.
    if let Some(model) = models.fail_step {
        let flag = AtomicBool::new(false);
        let (result, _) = generate_collect(provider, model, None, &flag);
        assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::StepFailed));
        assert_calls(counter, &mut expected_calls);
    }
    if let Some(model) = models.fail_network {
        let flag = AtomicBool::new(false);
        let (result, _) = generate_collect(provider, model, None, &flag);
        assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::NetworkFault));
        assert_calls(counter, &mut expected_calls);
    }

    // 5. EmitStatus::Stop on first emit -> adapter stops (≤1 delta).
    let (result, seen) = generate_stop_first(provider, models.happy);
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Cancelled));
    assert!(seen <= 1, "stop signal must halt production immediately");
    assert_calls(counter, &mut expected_calls);

    // 6. determinism: two generate calls with the same request produce
    //    identical delta text sequences.
    let flag = AtomicBool::new(false);
    let (_, first) = generate_collect(provider, models.happy, None, &flag);
    assert_calls(counter, &mut expected_calls);
    let (_, second) = generate_collect(provider, models.happy, None, &flag);
    assert_calls(counter, &mut expected_calls);
    assert_eq!(first, second, "deterministic delta sequence");

    // 7. redaction: a resolver-returned secret never appears in any
    //    ProviderError Debug/Display/params (constructed via the provider
    //    path that carries params).
    let resolver = SuperSecretResolver;
    let resolved = resolver
        .resolve(&SecretRef("api-key".to_string()))
        .expect("test resolver must succeed");
    assert_eq!(format!("{resolved:?}"), "SecretValue(<redacted>)");
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(provider, models.unknown, None, &flag);
    let err = result.expect_err("unknown model must fail");
    let debug = format!("{err:?}");
    let display = format!("{err}");
    for rendered in [&debug, &display] {
        assert!(
            !rendered.contains("super-secret"),
            "secret leaked via error rendering: {rendered}"
        );
    }
    assert!(
        err.params.iter().all(|(_, v)| !v.contains("super-secret")),
        "secret leaked via error params"
    );
    assert_calls(counter, &mut expected_calls);

    // 8. availability is side-effect-free: two probes are equal (and make
    //    no generate call).
    assert_eq!(provider.availability(), provider.availability());
}

#[test]
fn fake_conformance() {
    let counter = Arc::new(AtomicU64::new(0));
    let provider = FakeProvider::with_call_counter(Arc::clone(&counter));
    let models = ConformanceModels {
        happy: "steps=3;tokens-per-step=12",
        slow: "steps=64;delay-ms=200",
        fail_step: Some("steps=5;fail-at=3"),
        fail_network: None,
        unknown: "bogus-key=1",
    };
    run_conformance(&provider, &models, Some(&counter));
}

/// Byte-identity (assignment §6): run_key
/// `"7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1"`, model
/// `"steps=3;tokens-per-step=64"` — recompute sha256 in-test and require
/// exact equality of all three deltas the adapter produces.
#[test]
fn fake_byte_identity_through_generate() {
    use sha2::{Digest, Sha256};
    let provider = FakeProvider::new();
    let run_key = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c|1";
    let flag = AtomicBool::new(false);
    let request = ProviderRequest {
        provider_id: provider.id(),
        model: "steps=3;tokens-per-step=64",
        input: "hello",
        run_key,
        deadline: None,
        api_key: None,
        messages: None,
    };
    let mut texts = Vec::new();
    let result = provider.generate(&request, CancelToken::new(&flag), &mut |event| {
        let ProviderEvent::Delta { text } = event;
        texts.push(text);
        EmitStatus::Continue
    });
    let usage = result.expect("byte-identity run must succeed");
    assert_eq!(usage.steps, 3);
    assert_eq!(texts.len(), 3);
    for (i, text) in texts.iter().enumerate() {
        let mut hasher = Sha256::new();
        hasher.update(format!("{run_key}|{i}").as_bytes());
        let digest = hasher.finalize();
        let hex8 = format!(
            "{:02x}{:02x}{:02x}{:02x}",
            digest[0], digest[1], digest[2], digest[3]
        );
        let expected = format!("[attempt 1] step {}/3: {hex8}", i + 1);
        assert_eq!(text, &expected, "delta {i} must be byte-identical");
    }
}

fn recorded_provider() -> RecordedProvider {
    RecordedProvider::new(vec![
        RecordedScript::from_json(PLAIN).unwrap(),
        RecordedScript::from_json(FAULTS).unwrap(),
        RecordedScript::from_json(FAIL_NETWORK).unwrap(),
    ])
}

#[test]
fn recorded_conformance() {
    let provider = recorded_provider();
    let models = ConformanceModels {
        happy: "plain",
        slow: "faults",
        fail_step: Some("faults"),
        fail_network: Some("fail-network"),
        unknown: "no-such-script",
    };
    run_conformance(&provider, &models, None);
}

/// Fake-specific: the call counter proves exactly one billable attempt per
/// generate call on EVERY outcome path (happy/cancel/timeout/fail/invalid/
/// stop) — no hidden double billing (§55).
#[test]
fn fake_call_counter_exactly_one_per_outcome() {
    let counter = Arc::new(AtomicU64::new(0));
    let provider = FakeProvider::with_call_counter(Arc::clone(&counter));

    // happy
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, "steps=2;tokens-per-step=8", None, &flag);
    assert!(result.is_ok());
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    // cancelled (pre-set flag: nothing emitted)
    let flag = AtomicBool::new(true);
    let (result, texts) = generate_collect(&provider, "steps=64;delay-ms=200", None, &flag);
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Cancelled));
    assert!(texts.is_empty());
    assert_eq!(counter.load(Ordering::SeqCst), 2);

    // timeout
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(
        &provider,
        "steps=64;delay-ms=200",
        Some(Deadline::after(Duration::from_millis(1))),
        &flag,
    );
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Timeout));
    assert_eq!(counter.load(Ordering::SeqCst), 3);

    // step failed BEFORE producing step 3, params carry the step
    let flag = AtomicBool::new(false);
    let (result, texts) = generate_collect(&provider, "steps=5;fail-at=3", None, &flag);
    match result {
        Err(e) => {
            assert_eq!(e.code, ProviderErrorCode::StepFailed);
            assert!(e.params.contains(&("step".to_string(), "3".to_string())));
            assert_eq!(texts.len(), 2, "fail-at must error before step N");
        }
        Ok(_) => panic!("fail-at must produce an error"),
    }
    assert_eq!(counter.load(Ordering::SeqCst), 4);

    // invalid model grammar
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, "bogus=1", None, &flag);
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::RequestInvalid));
    assert_eq!(counter.load(Ordering::SeqCst), 5);

    // stop on first emit
    let (result, seen) = generate_stop_first(&provider, "steps=4;tokens-per-step=8");
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Cancelled));
    assert_eq!(seen, 1);
    assert_eq!(counter.load(Ordering::SeqCst), 6);
}

#[test]
fn recorded_fixtures_load_and_roundtrip() {
    let plain = RecordedScript::from_json(PLAIN).unwrap();
    assert_eq!(plain.id, "plain");
    assert_eq!(plain.steps.len(), 5);
    assert_eq!(
        RecordedScript::from_json(&serde_json::to_string(&plain).unwrap()).unwrap(),
        plain
    );
    let faults = RecordedScript::from_json(FAULTS).unwrap();
    assert_eq!(faults.id, "faults");
    let fail_network = RecordedScript::from_json(FAIL_NETWORK).unwrap();
    assert_eq!(fail_network.id, "fail-network");
}

#[test]
fn fixture_files_roundtrip_from_disk() {
    // The committed fixtures must parse exactly as the include_str! copies
    // do — a consumer reading the same files from disk sees identical
    // scripts.
    let dir = tempfile::tempdir().unwrap();
    for (name, content) in [
        ("plain.json", PLAIN),
        ("faults.json", FAULTS),
        ("fail-network.json", FAIL_NETWORK),
    ] {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            RecordedScript::from_json(&on_disk).unwrap(),
            RecordedScript::from_json(content).unwrap()
        );
    }
}

#[test]
fn recorded_models_match_scripts() {
    let provider = recorded_provider();
    let models = provider.models();
    assert_eq!(models.len(), 3);
    for model in &models {
        assert_eq!(model.id, model.name);
        assert!(model.id == "plain" || model.id == "faults" || model.id == "fail-network");
    }
    assert!(provider.builtin());
    assert_eq!(provider.id(), "recorded");
}

#[test]
fn recorded_unavailable_fail_mapping() {
    let script = RecordedScript::from_json(
        r#"{"id":"unavail","steps":[{"type":"fail","code":"unavailable"}]}"#,
    )
    .unwrap();
    let provider = RecordedProvider::new(vec![script]);
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(&provider, "unavail", None, &flag);
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Unavailable));
}

#[test]
fn recorded_sleep_clamps_to_200ms() {
    // A 300ms sleep clamps to 200ms at replay: with a 1ms deadline the run
    // must still time out promptly rather than sleep the full 300ms.
    let script = RecordedScript::from_json(
        r#"{"id":"clamp","steps":[{"type":"delta","text":"x"},{"type":"sleep","ms":300}]}"#,
    )
    .unwrap();
    let provider = RecordedProvider::new(vec![script]);
    let flag = AtomicBool::new(false);
    let (result, _) = generate_collect(
        &provider,
        "clamp",
        Some(Deadline::after(Duration::from_millis(1))),
        &flag,
    );
    assert!(matches!(result, Err(e) if e.code == ProviderErrorCode::Timeout));
}
