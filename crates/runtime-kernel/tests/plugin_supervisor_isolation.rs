//! Destructive acceptance for the plugin supervisor (ADR-0066 D9).
//!
//! The claim under test is not "the supervisor exists" but "a plugin cannot take the
//! product down". Each case breaks a plugin on purpose and then asks the kernel to do
//! real work:
//!
//! 1. a plugin process that never exits (a hang) is killed and reported as a hang,
//!    while the kernel keeps dispatching wire operations in the meantime;
//! 2. a plugin that crashes burns its restart budget and ends in `Failed`, and the
//!    registry refuses to start it again until an operator resets it;
//! 3. a rebuilt kernel on the same data root still answers after both of the above —
//!    the failures were contained in the plugin, not written into the product.

use std::time::{Duration, Instant};

use runtime_kernel::plugin_supervisor::{
    run_guarded, ExitKind, Supervisor, SupervisorPolicy, SupervisorRegistry, SupervisorState,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};

/// Sends one wire operation through the real kernel and returns its result.
fn dispatch(kernel: &Kernel, operation_id: &str, payload: serde_json::Value) -> serde_json::Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&payload).expect("request serialization");
    let response = kernel
        .dispatch(operation_id, &bytes, &flag)
        .expect("the kernel must answer while a plugin is misbehaving");
    serde_json::from_slice(&response).expect("response must be JSON")
}

fn open(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: runtime_kernel::FFI_ABI_VERSION,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel opens")
}

fn sleeper(seconds: u32) -> std::process::Command {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", &format!("ping -n {seconds} 127.0.0.1 >NUL")]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", &format!("sleep {seconds}")]);
        command
    }
}

#[test]
fn a_hung_plugin_is_killed_while_the_kernel_keeps_answering() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open(dir.path());
    let mut registry = SupervisorRegistry::new();
    registry.register("author.hang", SupervisorPolicy::default());
    assert!(registry.start("author.hang"));

    // The plugin process is started on another thread so the kernel is asked for real
    // work while the process is still running.
    let handle = std::thread::spawn(move || {
        let mut command = sleeper(30);
        run_guarded(&mut command, Duration::from_millis(400)).expect("spawn")
    });

    let started = Instant::now();
    let result = dispatch(&kernel, "meta.get", serde_json::json!({}));
    assert!(
        result.get("version").is_some() || result.get("appVersion").is_some(),
        "the kernel must serve while a plugin hangs: {result}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a hanging plugin must not slow the kernel down"
    );

    let outcome = handle.join().expect("supervisor thread");
    assert_eq!(outcome.kind, ExitKind::Hang);
    let delay = registry.finish("author.hang", outcome.kind, outcome.detail);
    assert!(delay.is_some(), "a hang is retried within the budget");
}

#[test]
fn a_crash_loop_ends_failed_and_needs_an_operator_to_restart() {
    let mut registry = SupervisorRegistry::new();
    registry.register(
        "author.crash",
        SupervisorPolicy {
            max_restarts: 2,
            base_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(20),
            heartbeat_timeout: Duration::from_secs(1),
        },
    );

    for _ in 0..3 {
        let mut command = {
            #[cfg(windows)]
            {
                let mut command = std::process::Command::new("cmd");
                command.args(["/C", "exit 3"]);
                command
            }
            #[cfg(not(windows))]
            {
                let mut command = std::process::Command::new("sh");
                command.args(["-c", "exit 3"]);
                command
            }
        };
        assert!(
            registry.start("author.crash"),
            "the budget allows this start"
        );
        let outcome = run_guarded(&mut command, Duration::from_secs(5)).expect("spawn");
        assert_eq!(outcome.kind, ExitKind::Crash);
        registry.finish("author.crash", outcome.kind, outcome.detail);
    }

    let supervisor: &Supervisor = registry.get("author.crash").expect("known plugin");
    assert_eq!(supervisor.state(), SupervisorState::Failed);
    assert!(
        !registry.can_start("author.crash"),
        "a failed plugin stays down"
    );
    assert!(
        supervisor.last_error().is_some(),
        "the reason must survive for the UI"
    );

    registry.reset("author.crash");
    assert!(
        registry.can_start("author.crash"),
        "reset is the operator's way back"
    );
}

#[test]
fn the_kernel_still_serves_after_a_plugin_was_killed() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let kernel = open(dir.path());
        let mut command = sleeper(30);
        let outcome = run_guarded(&mut command, Duration::from_millis(300)).expect("spawn");
        assert_eq!(outcome.kind, ExitKind::Hang);
        drop(kernel);
    }
    // A fresh kernel on the same data root: if the plugin failure had corrupted state,
    // this open or the following dispatch would fail.
    let kernel = open(dir.path());
    let result = dispatch(&kernel, "meta.get", serde_json::json!({}));
    assert!(
        result.get("version").is_some() || result.get("appVersion").is_some(),
        "a fresh kernel must still answer: {result}"
    );
}

#[test]
fn an_ungranted_capability_is_denied_at_the_kernel_boundary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = open(dir.path());
    // Installed with no permissions: the plugin exists, but the grant set is empty.
    dispatch(
        &kernel,
        "plugins.install",
        serde_json::json!({
            "id": "author-denied",
            "name": "Denied",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": [],
        }),
    );

    let flag = CancellationFlag::new();
    let request = serde_json::to_vec(&serde_json::json!({
        "pluginId": "author-denied",
        "name": "probe.bin",
        "contentType": "application/octet-stream",
        "totalBytes": 16,
    }))
    .expect("request serialization");
    let error = kernel
        .dispatch("plugins.blobs.begin", &request, &flag)
        .expect_err("an ungranted capability must be refused by the kernel, not by the UI");
    let product = error.product.expect("a product error carries a wire code");
    assert_eq!(product.code, "PLUGIN_PERMISSION_DENIED");
    assert_eq!(
        product
            .params
            .get("capability")
            .and_then(|value| value.as_str()),
        Some("storage.blobs"),
        "the refusal must name the capability the plugin did not get: {:?}",
        product.params
    );
}
