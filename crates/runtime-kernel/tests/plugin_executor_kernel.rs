//! The executor through the public `Kernel` API (ADR-0064): a host adapter calls
//! `run_plugin_jobs` with its handler, and the queue drains on the writer thread
//! without a second connection.
//!
//! These tests pin the API contract the Tauri adapter will use: the call returns
//! a report, execution stays closed unless asked, and the job row reflects the
//! transition (so a restart resumes from the same rows).

use std::sync::Arc;

use runtime_kernel::plugin_runner::{
    JobInvocation, PluginJobHandler, RunReport, RunnerOptions, SecretAccess,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};

const PLUGIN_ID: &str = "clockwork-jobs";

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

fn install_plugin(kernel: &Kernel) {
    dispatch(
        kernel,
        "plugins.install",
        json!({
            "id": PLUGIN_ID,
            "name": "Jobs",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": ["jobs.enqueue"],
        }),
    );
}

fn enqueue(kernel: &Kernel) -> String {
    let response = dispatch(
        kernel,
        "plugins.jobs.enqueue",
        json!({ "pluginId": PLUGIN_ID, "kind": "timer", "payloadJson": "{\"tick\":1}" }),
    );
    response["job"]["id"].as_str().expect("job id").to_string()
}

fn job(kernel: &Kernel, id: &str) -> Value {
    dispatch(kernel, "plugins.jobs.get", json!({ "jobId": id }))["job"].clone()
}

struct OkHandler;

impl PluginJobHandler for OkHandler {
    fn run(&self, _job: &JobInvocation, _secrets: &mut dyn SecretAccess) -> Result<(), String> {
        Ok(())
    }
}

fn enabled() -> RunnerOptions {
    RunnerOptions {
        enabled: true,
        allow_exposure: false,
        lease_ms: 60_000,
        max_jobs: 8,
    }
}

#[test]
fn a_host_pass_drains_the_queue_through_the_public_api() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    install_plugin(&kernel);
    let id = enqueue(&kernel);
    assert_eq!(job(&kernel, &id)["state"], "queued");

    let report: RunReport = kernel
        .run_plugin_jobs(enabled(), Arc::new(OkHandler))
        .expect("pass");
    assert_eq!(report.claimed, 1);
    assert_eq!(report.succeeded, 1);
    assert!(!report.skipped);

    let after = job(&kernel, &id);
    assert_eq!(after["state"], "succeeded");
    assert_eq!(after["attempts"], 1);
}

#[test]
fn the_public_api_respects_the_kill_switch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(dir.path());
    install_plugin(&kernel);
    let id = enqueue(&kernel);

    let report = kernel
        .run_plugin_jobs(RunnerOptions::default(), Arc::new(OkHandler))
        .expect("pass");
    assert!(report.skipped);
    assert_eq!(report.claimed, 0);
    assert_eq!(job(&kernel, &id)["state"], "queued");
}
