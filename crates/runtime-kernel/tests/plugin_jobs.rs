//! `plugins.jobs.*` — the kernel-resident plugin executor's queue (ADR-0064).
//!
//! The wire surface is deliberately small: enqueue, list, get, cancel. Claiming,
//! leasing and completing are executor-internal, so these tests pin what a
//! client can observe: a job lands `queued` with its opaque payload, an unknown
//! plugin cannot create work, listing is ordered and filterable, cancel is
//! terminal, and a second cancel is refused instead of rewriting state.

use contracts_generated::generated::{
    decode_result_plugin_job, decode_result_plugins_jobs_list, PluginJob, PluginJobState,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};

const PLUGIN_ID: &str = "clockwork-jobs";
const OTHER_PLUGIN_ID: &str = "other-plugin";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch(kernel: &Kernel, op: &str, request: Value) -> Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed");
    serde_json::from_slice(&response).expect("response must be JSON")
}

fn dispatch_error(kernel: &Kernel, op: &str, request: Value) -> runtime_kernel::KernelError {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .expect_err("dispatch must fail")
}

fn product_code(error: &runtime_kernel::KernelError) -> String {
    error
        .product
        .as_ref()
        .expect("expected a product error")
        .code
        .clone()
}

fn install_plugin(kernel: &Kernel, id: &str) {
    dispatch(
        kernel,
        "plugins.install",
        json!({
            "id": id,
            "name": "Jobs Test",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": ["jobs.enqueue"],
        }),
    );
}

fn enqueue(kernel: &Kernel, request: Value) -> PluginJob {
    let response = dispatch(kernel, "plugins.jobs.enqueue", request);
    decode_result_plugin_job(&serde_json::to_vec(&response).expect("response encodes"))
        .expect("result decodes")
        .job
}

fn list(kernel: &Kernel, request: Value) -> Vec<PluginJob> {
    let response = dispatch(kernel, "plugins.jobs.list", request);
    decode_result_plugins_jobs_list(&serde_json::to_vec(&response).expect("response encodes"))
        .expect("result decodes")
        .jobs
}

fn seeded_kernel(root: &std::path::Path) -> Kernel {
    let kernel = open_kernel(root);
    install_plugin(&kernel, PLUGIN_ID);
    install_plugin(&kernel, OTHER_PLUGIN_ID);
    kernel
}

#[test]
fn enqueue_stores_the_opaque_payload_and_defaults() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());

    let job = enqueue(
        &kernel,
        json!({
            "pluginId": PLUGIN_ID,
            "kind": "timer",
            "payloadJson": "{\"tick\":7}",
        }),
    );
    assert_eq!(job.state, PluginJobState::Queued);
    assert_eq!(job.payload_json, "{\"tick\":7}");
    assert_eq!(job.attempts, 0);
    assert_eq!(job.max_attempts, 3, "scheduler default");
    assert!(job.lease_until.is_none());
    assert!(job.run_at.ends_with('Z'), "RFC 3339 with a zone");
}

#[test]
fn enqueue_without_a_payload_stores_an_empty_object() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());
    let job = enqueue(&kernel, json!({ "pluginId": PLUGIN_ID, "kind": "task" }));
    assert_eq!(job.payload_json, "{}");
}

#[test]
fn enqueue_refuses_unknown_plugins_and_bad_payloads() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());

    let unknown = dispatch_error(
        &kernel,
        "plugins.jobs.enqueue",
        json!({ "pluginId": "no-such-plugin", "kind": "timer" }),
    );
    assert_eq!(product_code(&unknown), "PLUGIN_NOT_FOUND");

    let bad_payload = dispatch_error(
        &kernel,
        "plugins.jobs.enqueue",
        json!({ "pluginId": PLUGIN_ID, "kind": "timer", "payloadJson": "{not json" }),
    );
    assert_eq!(product_code(&bad_payload), "JOB_PAYLOAD_INVALID");

    let bad_kind = dispatch_error(
        &kernel,
        "plugins.jobs.enqueue",
        json!({ "pluginId": PLUGIN_ID, "kind": "" }),
    );
    assert_eq!(
        bad_kind.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn list_is_newest_first_and_filters_by_plugin_and_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());

    let first = enqueue(&kernel, json!({ "pluginId": PLUGIN_ID, "kind": "timer" }));
    let second = enqueue(
        &kernel,
        json!({ "pluginId": OTHER_PLUGIN_ID, "kind": "task" }),
    );
    let _third = enqueue(&kernel, json!({ "pluginId": PLUGIN_ID, "kind": "timer" }));

    let all = list(&kernel, json!({}));
    assert_eq!(all.len(), 3);

    let mine = list(&kernel, json!({ "pluginId": PLUGIN_ID }));
    assert_eq!(mine.len(), 2);
    assert!(mine.iter().all(|job| job.plugin_id == PLUGIN_ID));
    // Newest first: the second enqueued job for this plugin precedes the first.
    assert!(mine.iter().any(|job| job.id == first.id));
    assert!(!mine.iter().any(|job| job.id == second.id));

    let queued = list(&kernel, json!({ "state": "queued" }));
    assert_eq!(queued.len(), 3);
    let cancelled = list(&kernel, json!({ "state": "cancelled" }));
    assert!(cancelled.is_empty());
    assert_eq!(list(&kernel, json!({ "limit": 1 })).len(), 1);
}

#[test]
fn get_returns_the_job_and_missing_ids_are_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());
    let job = enqueue(&kernel, json!({ "pluginId": PLUGIN_ID, "kind": "timer" }));

    let response = dispatch(&kernel, "plugins.jobs.get", json!({ "jobId": job.id }));
    let fetched = decode_result_plugin_job(&serde_json::to_vec(&response).expect("encodes"))
        .expect("decodes")
        .job;
    assert_eq!(fetched.id, job.id);

    let missing = dispatch_error(
        &kernel,
        "plugins.jobs.get",
        json!({ "jobId": "00000000-0000-4000-8000-000000000000" }),
    );
    assert_eq!(product_code(&missing), "JOB_NOT_FOUND");
}

#[test]
fn cancel_is_terminal_and_a_second_cancel_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());
    let job = enqueue(&kernel, json!({ "pluginId": PLUGIN_ID, "kind": "timer" }));

    let response = dispatch(&kernel, "plugins.jobs.cancel", json!({ "jobId": job.id }));
    let cancelled = decode_result_plugin_job(&serde_json::to_vec(&response).expect("encodes"))
        .expect("decodes")
        .job;
    assert_eq!(cancelled.state, PluginJobState::Cancelled);
    assert!(cancelled.lease_until.is_none());

    let again = dispatch_error(&kernel, "plugins.jobs.cancel", json!({ "jobId": job.id }));
    assert_eq!(product_code(&again), "JOB_TERMINAL");

    // The cancelled job is still readable, and no longer queued.
    assert!(list(&kernel, json!({ "state": "queued" })).is_empty());
    assert_eq!(list(&kernel, json!({ "state": "cancelled" })).len(), 1);
}

#[test]
fn run_at_moves_the_job_into_the_future() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(dir.path());
    let job = enqueue(
        &kernel,
        json!({
            "pluginId": PLUGIN_ID,
            "kind": "timer",
            "runAt": "2030-01-01T00:00:00Z",
        }),
    );
    assert!(job.run_at.starts_with("2030-01-01"));
    // Still visible to a client, even though no worker could claim it yet.
    assert_eq!(list(&kernel, json!({ "pluginId": PLUGIN_ID })).len(), 1);
}
