//! Phase 7 provider integration tests (design §Kernel integration).
//!
//! Covers: `providers.list` on stateless and storage kernels, secret
//! redaction through the resolver seam (values never reach snapshots, event
//! payloads or error payloads), the per-run timeout override, and cancel
//! precedence (late provider output never reaches the chat after a durable
//! cancel).

use contracts_generated::generated::{
    decode_result_list_providers, GenerationRun, GenerationStatus, PagedGenerationEvents,
    PagedMessages, ProviderAvailability, ResultListProviders,
};
use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::ProviderError;
use runtime_kernel::{
    CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode, StreamNotice,
};
use std::sync::Arc;
use std::time::Duration;

/// Fixed chat id (wire-uuid-shaped) so the deterministic fake-provider
/// deltas are stable.
const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";
const SECRET: &str = "super-secret-value";

/// A resolver that hands out the test secret for any reference. The seam
/// itself is the deliverable: the kernel never invokes it for the built-in
/// fake, and the value must never surface anywhere (snapshot, event
/// payloads, error payloads, Debug).
struct FixedSecretResolver;

impl SecretResolver for FixedSecretResolver {
    fn resolve(&self, _reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Ok(SecretValue::new(SECRET))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn open_stateless() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open")
}

/// Seeds a character + chat through `neotavern_storage`, then releases the
/// lease so the kernel under test can take the root.
fn seed_chat(root: &std::path::Path) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES (?1, 'Aria', NULL, NULL, '[]', '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES (?1, 'Gen test', ?2, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID],
        )
        .expect("seed chat");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn dispatch_bytes(kernel: &Kernel, op: &str, request: serde_json::Value) -> Vec<u8> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed")
}

fn start_stream(
    kernel: &Kernel,
    op: &str,
    request: serde_json::Value,
) -> Result<runtime_kernel::EventStream, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel.dispatch_stream(op, &bytes, &flag)
}

/// Drains a stream until the terminal notice, returning the committed
/// sequences and the terminal sequence.
fn drain_until_terminal(
    stream: &mut runtime_kernel::EventStream,
    timeout: Duration,
) -> (Vec<i64>, i64) {
    let mut committed = Vec::new();
    loop {
        match stream.next_notice(timeout) {
            Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
            Some(StreamNotice::Terminal { last_sequence }) => return (committed, last_sequence),
            None => panic!("stream ended without a terminal notice"),
        }
    }
}

fn get_run(kernel: &Kernel, run_id: &str) -> GenerationRun {
    serde_json::from_slice(&dispatch_bytes(
        kernel,
        "generation.get",
        serde_json::json!({ "workflowId": run_id }),
    ))
    .expect("get response must be a GenerationRun")
}

fn list_events(
    kernel: &Kernel,
    run_id: &str,
    after: i64,
    limit: Option<i64>,
) -> PagedGenerationEvents {
    let mut request = serde_json::json!({ "workflowId": run_id });
    if let Some(after) = (after >= 0).then_some(after) {
        request["afterSequence"] = serde_json::json!(after);
    }
    if let Some(limit) = limit {
        request["limit"] = serde_json::json!(limit);
    }
    serde_json::from_slice(&dispatch_bytes(kernel, "generation.events", request))
        .expect("events response must be PagedGenerationEvents")
}

fn list_messages(kernel: &Kernel, chat_id: &str) -> PagedMessages {
    serde_json::from_slice(&dispatch_bytes(
        kernel,
        "chats.messages.list",
        serde_json::json!({ "chatId": chat_id, "limit": 200 }),
    ))
    .expect("messages response shape")
}

// ---------------------------------------------------------------------------
// providers.list
// ---------------------------------------------------------------------------

#[test]
fn providers_list_on_stateless_kernel() {
    let kernel = open_stateless();

    // Stateless (like meta.get — no data root required).
    let bytes = dispatch_bytes(&kernel, "providers.list", serde_json::json!({}));
    let dto: ResultListProviders =
        decode_result_list_providers(&bytes).expect("schema-valid result");

    let fake = dto
        .items
        .iter()
        .find(|p| p.id == "fake")
        .expect("fake registered");
    assert!(fake.builtin, "built-in flag");
    assert_eq!(fake.name, "Fake Provider");
    assert_eq!(
        fake.availability,
        ProviderAvailability::Available,
        "fake is available"
    );
    assert!(
        fake.models.iter().any(|m| m.id == "fake-1"),
        "fake-1 model listed: {:?}",
        fake.models
    );
}

#[test]
fn providers_list_on_storage_kernel() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    let bytes = dispatch_bytes(&kernel, "providers.list", serde_json::json!({}));
    let dto: ResultListProviders =
        decode_result_list_providers(&bytes).expect("schema-valid result");

    let fake = dto
        .items
        .iter()
        .find(|p| p.id == "fake")
        .expect("fake registered");
    assert!(fake.builtin);
    assert_eq!(fake.availability, ProviderAvailability::Available);
    let fake_1 = fake
        .models
        .iter()
        .find(|m| m.id == "fake-1")
        .expect("fake-1");
    assert_eq!(fake_1.name, "Fake 1");
    assert_eq!(fake_1.context_limit, Some(8192));

    // Strict empty request: extra fields are contract violations.
    let flag = CancellationFlag::new();
    let err = kernel
        .dispatch(
            "providers.list",
            &serde_json::to_vec(&serde_json::json!({ "extra": 1 })).expect("serialize"),
            &flag,
        )
        .expect_err("extra fields must be rejected");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

#[test]
fn secret_resolver_value_never_reaches_durable_state() {
    // The seam stores only the handle; resolved values must never appear in
    // the request snapshot, event payloads or error payloads.
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    kernel.set_secret_resolver(Arc::new(FixedSecretResolver));

    // Run a full generation through the fake provider.
    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "Hello from the redaction test",
            "model": "steps=4;tokens-per-step=48"
        }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    // generation.get DTO: serialize the whole run snapshot and assert the
    // secret is absent (partial text, error, ids, everything).
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Completed);
    let run_json = serde_json::to_string(&run).expect("run serializes");
    assert!(
        !run_json.contains(SECRET),
        "secret leaked into generation.get payload"
    );

    // Every durable event payload (delta text, checkpoint, completed
    // finalMessage) must be free of the secret.
    let events = list_events(&kernel, &run_id, -1, None);
    assert!(!events.items.is_empty(), "events exist");
    for envelope in &events.items {
        let payload = serde_json::to_string(&envelope.payload).expect("payload serializes");
        assert!(
            !payload.contains(SECRET),
            "secret leaked into event payload {}",
            envelope.r#type
        );
    }

    // The durable rows themselves: request snapshot + error_json on the run,
    // payload_json on every event — the canonical storage, read directly.
    let read_only = neotavern_storage::open::open_read_only(root.path()).expect("read-only open");
    let run_row: (String, Option<String>) = read_only
        .conn()
        .query_row(
            "SELECT request_snapshot_json, error_json FROM generation_runs WHERE id = ?1",
            rusqlite::params![&run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("run row readable");
    assert!(
        !run_row.0.contains(SECRET),
        "secret leaked into request_snapshot_json: {}",
        run_row.0
    );
    if let Some(error_json) = run_row.1 {
        assert!(
            !error_json.contains(SECRET),
            "secret leaked into error_json"
        );
    }
    let mut stmt = read_only
        .conn()
        .prepare("SELECT payload_json FROM generation_events WHERE run_id = ?1")
        .expect("events query prepares");
    let payloads: Vec<String> = stmt
        .query_map(rusqlite::params![&run_id], |row| row.get(0))
        .expect("events query runs")
        .collect::<Result<Vec<_>, _>>()
        .expect("payloads read");
    assert!(!payloads.is_empty(), "event payloads exist");
    for payload in &payloads {
        assert!(
            !payload.contains(SECRET),
            "secret leaked into stored event payload"
        );
    }
}

#[test]
fn secret_value_debug_is_redacted() {
    let value = SecretValue::new(SECRET);
    assert_eq!(
        format!("{value:?}"),
        "SecretValue(<redacted>)",
        "Debug must redact the value"
    );
    assert!(
        !format!("{value:?}").contains(SECRET),
        "Debug format leaks the value"
    );
    assert!(
        !format!("{value:?}").contains("super"),
        "no substring of the value leaks"
    );
}

// ---------------------------------------------------------------------------
// Per-run timeout
// ---------------------------------------------------------------------------

#[test]
fn generation_fails_with_provider_timeout_under_short_run_timeout() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());

    // 50ms per-run deadline; the fake sleeps 100ms between steps, so the
    // first inter-step sleep blows the deadline.
    kernel.set_run_timeout(Duration::from_millis(50));

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "Hello",
            "model": "steps=4;delay-ms=100;tokens-per-step=48"
        }),
    )
    .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Failed);
    let error = run.error.as_ref().expect("failed run carries an error");
    assert_eq!(error.code, "PROVIDER_TIMEOUT");
    assert_eq!(error.params["runId"], serde_json::json!(run_id));

    // The terminal event mirrors the error.
    let events = list_events(&kernel, &run_id, -1, None);
    let failed = events
        .items
        .iter()
        .find(|e| e.r#type == "generation.failed")
        .expect("terminal failed event");
    assert_eq!(
        failed.payload["error"]["code"],
        serde_json::json!("PROVIDER_TIMEOUT")
    );
    assert!(
        list_messages(&kernel, CHAT_ID).items.is_empty(),
        "no message row for a timed-out run"
    );
}

// ---------------------------------------------------------------------------
// Cancel precedence: late provider output never reaches the chat
// ---------------------------------------------------------------------------

#[test]
fn cancel_precedence_no_deltas_after_cancel() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = Arc::new(open_kernel(root.path()));
    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&serde_json::json!({
                "chatId": CHAT_ID,
                "message": "Hello",
                "model": "steps=16;delay-ms=50;tokens-per-step=48"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    let run_id = stream.stream_id().to_string();

    // Wait for the first committed delta, then cancel from a second thread.
    let mut committed = Vec::new();
    match stream.next_notice(Duration::from_secs(30)) {
        Some(StreamNotice::Committed { through_sequence }) => committed.push(through_sequence),
        other => panic!("expected a committed delta, got {other:?}"),
    }
    let cancel_kernel = Arc::clone(&kernel);
    let cancel_run_id = run_id.clone();
    let cancel_thread = std::thread::spawn(move || {
        let flag = CancellationFlag::new();
        let bytes = serde_json::to_vec(&serde_json::json!({ "workflowId": cancel_run_id }))
            .expect("serialize");
        cancel_kernel.dispatch("generation.cancel", &bytes, &flag)
    });

    let (rest, terminal) = drain_until_terminal(&mut stream, Duration::from_secs(30));
    committed.extend(rest);
    cancel_thread
        .join()
        .expect("cancel thread must not panic")
        .expect("generation.cancel must succeed");

    assert!(
        !committed.is_empty(),
        "at least one delta before the cancel"
    );
    assert!(
        committed.len() < 16,
        "the run must be cancelled before all 16 steps"
    );

    // Cancelled terminal; no completed event, no message row.
    let run = get_run(&kernel, &run_id);
    assert_eq!(run.status, GenerationStatus::Cancelled);
    assert_eq!(run.message_id, None, "cancelled runs have no final message");

    // The durable log proves no delta was committed after the cancel: every
    // delta sits strictly before the single terminal `generation.cancelled`
    // event, and the delta count matches the committed count exactly.
    let events = list_events(&kernel, &run_id, -1, None);
    assert!(
        events
            .items
            .iter()
            .all(|e| e.r#type != "generation.completed"),
        "no completed event"
    );
    let delta_seqs: Vec<i64> = events
        .items
        .iter()
        .filter(|e| e.r#type == "generation.delta")
        .map(|e| e.sequence)
        .collect();
    assert_eq!(delta_seqs.len(), committed.len(), "committed == durable");
    assert!(
        delta_seqs.iter().all(|seq| *seq < terminal),
        "every delta precedes the terminal cancelled event"
    );
    assert_eq!(
        events
            .items
            .iter()
            .filter(|e| e.r#type == "generation.cancelled")
            .count(),
        1,
        "exactly one terminal event"
    );
    assert_eq!(events.items.last().unwrap().sequence, terminal);
    assert!(list_messages(&kernel, CHAT_ID).items.is_empty());
}
