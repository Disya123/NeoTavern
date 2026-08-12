//! Phase 1 kernel smoke tests (rust-contract §5).
//!
//! Covers: open validation (hash + ABI), `meta.get` dispatch, contract
//! violations on malformed payloads, cancellation, unknown operations,
//! headless/local pass-through, and a deterministic garbage-input
//! no-panic sweep over dispatch.

use contracts_generated::generated::{decode_meta_dto, MetaDto, MetaDtoApi, MetaDtoProductWire};
use runtime_kernel::{
    headless::HeadlessAdapter, local::LocalConnection, CancellationFlag, Kernel, KernelConfig,
    KernelErrorCode,
};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// A kernel opened with the correct, manifest-derived contract expectations.
fn open_kernel() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// The exact meta DTO this build must report.
fn expected_meta() -> MetaDto {
    MetaDto {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        api: MetaDtoApi { major: 1, minor: 0 },
        product_wire: MetaDtoProductWire { major: 1, minor: 0 },
        minimum_client_version: None,
        features: HashMap::from([("core".to_string(), 1)]),
    }
}

/// Deterministic xorshift32 LCG for reproducible garbage input.
struct XorShift32(u32);

impl XorShift32 {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
}

#[test]
fn open_with_correct_hash_and_abi_succeeds() {
    let kernel = open_kernel();
    let meta = kernel.meta();
    assert_eq!(meta.app_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(meta.api.major, 1);
    assert_eq!(meta.api.minor, 0);
    assert_eq!(meta.product_wire.major, 1);
    assert_eq!(meta.product_wire.minor, 0);
    assert_eq!(meta.minimum_client_version, None);
    assert_eq!(meta.features, HashMap::from([("core".to_string(), 1)]));
}

#[test]
fn open_rejects_wrong_schema_hash() {
    let err = Kernel::open(KernelConfig {
        expected_schema_hash: "0".repeat(64),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect_err("wrong hash must be rejected");
    assert_eq!(err.code, KernelErrorCode::ContractMismatch);
    assert!(
        err.message.contains("schema hash mismatch"),
        "message should describe the mismatch: {}",
        err.message
    );
}

#[test]
fn open_rejects_wrong_abi_version() {
    let err = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 2,
        data_root: None,
    })
    .expect_err("wrong abi must be rejected");
    assert_eq!(err.code, KernelErrorCode::ContractMismatch);
    assert!(
        err.message.contains("ffi abi version mismatch"),
        "message should describe the mismatch: {}",
        err.message
    );
}

#[test]
fn meta_get_round_trips_to_meta_dto() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let bytes = kernel
        .dispatch("meta.get", b"{}", &flag)
        .expect("meta.get with empty request must succeed");
    let decoded = decode_meta_dto(&bytes).expect("response must decode as MetaDto");
    assert_eq!(decoded, kernel.meta());
    assert_eq!(decoded, expected_meta());
}

#[test]
fn meta_get_wire_shape_is_correct() {
    // JSON-level assertions: verify the wire contract fields independent of
    // generated Rust field naming.
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let bytes = kernel
        .dispatch("meta.get", b"{}", &flag)
        .expect("meta.get must succeed");
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).expect("response must be valid JSON");
    assert_eq!(value["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["api"]["major"], 1);
    assert_eq!(value["api"]["minor"], 0);
    assert_eq!(value["productWire"]["major"], 1);
    assert_eq!(value["productWire"]["minor"], 0);
    assert_eq!(value["features"]["core"], 1);
}

#[test]
fn meta_get_invalid_json_is_contract_violation_not_panic() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let result = kernel.dispatch("meta.get", b"{invalid json", &flag);
    let err = result.expect_err("malformed JSON must be rejected");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

#[test]
fn meta_get_extra_field_is_contract_violation() {
    // The empty request DTO is strict: any extra field is a violation.
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let result = kernel.dispatch("meta.get", br#"{"extra":true}"#, &flag);
    let err = result.expect_err("extra field must be rejected by the strict empty request");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

#[test]
fn meta_get_with_wrong_type_is_contract_violation() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let result = kernel.dispatch("meta.get", b"[1,2,3]", &flag);
    let err = result.expect_err("non-object request must be rejected");
    assert_eq!(err.code, KernelErrorCode::ContractViolation);
}

#[test]
fn cancelled_flag_yields_cancelled() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    flag.cancel();
    let err = kernel
        .dispatch("meta.get", b"{}", &flag)
        .expect_err("cancelled flag must reject dispatch");
    assert_eq!(err.code, KernelErrorCode::Cancelled);
}

#[test]
fn unknown_operation_yields_operation_not_found() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let err = kernel
        .dispatch("nope.nope", b"{}", &flag)
        .expect_err("unknown operation must be rejected");
    assert_eq!(err.code, KernelErrorCode::OperationNotFound);
}

#[test]
fn headless_adapter_passes_through() {
    let kernel = open_kernel();
    let adapter = HeadlessAdapter::new(kernel);

    let flag = CancellationFlag::new();
    let bytes = adapter
        .dispatch("request-id-1", "meta.get", b"{}", &flag)
        .expect("headless dispatch must succeed");
    let decoded = decode_meta_dto(&bytes).expect("response must decode as MetaDto");
    assert_eq!(decoded, expected_meta());

    // meta_bytes() is the same DTO serialized.
    let meta_bytes = adapter.meta_bytes();
    let from_bytes = decode_meta_dto(&meta_bytes).expect("meta_bytes must decode as MetaDto");
    assert_eq!(from_bytes, decoded);

    // Error pass-through keeps codes intact.
    let err = adapter
        .dispatch("request-id-2", "nope.nope", b"{}", &flag)
        .expect_err("unknown operation must pass through as error");
    assert_eq!(err.code, KernelErrorCode::OperationNotFound);
}

#[test]
fn local_connection_passes_through() {
    let kernel = open_kernel();
    let conn = LocalConnection::new(kernel);

    let flag = CancellationFlag::new();
    let bytes = conn
        .call("meta.get", b"{}", &flag)
        .expect("local call must succeed");
    let decoded = decode_meta_dto(&bytes).expect("response must decode as MetaDto");
    assert_eq!(decoded, expected_meta());

    // Cancellation also passes through.
    let cancelled = CancellationFlag::new();
    cancelled.cancel();
    let err = conn
        .call("meta.get", b"{}", &cancelled)
        .expect_err("cancelled flag must pass through");
    assert_eq!(err.code, KernelErrorCode::Cancelled);
}

#[test]
fn garbage_inputs_never_panic() {
    let kernel = open_kernel();
    let flag = CancellationFlag::new();
    let mut rng = XorShift32(0x9E37_79B9);

    for len in 0..512u32 {
        let mut buf = Vec::with_capacity(len as usize);
        for _ in 0..len {
            buf.push((rng.next() & 0xFF) as u8);
        }
        let result = catch_unwind(AssertUnwindSafe(|| {
            kernel.dispatch("meta.get", &buf, &flag)
        }));
        assert!(
            result.is_ok(),
            "dispatch panicked on {}-byte garbage input",
            len
        );
    }
}

// ---------------------------------------------------------------------------
// Phase 2: durable storage wiring (ТЗ §22/31) through Kernel::open.
// ---------------------------------------------------------------------------

#[test]
fn kernel_opens_with_durable_storage() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.path().to_path_buf()),
    })
    .expect("kernel must open with a fresh data root");

    assert!(kernel.has_storage());
    let diag = kernel
        .storage_diagnostics()
        .expect("durable kernel must report storage diagnostics");
    assert_eq!(diag.storage_format, Some(1));
    assert_eq!(
        diag.schema_revision,
        Some(neotavern_storage::CURRENT_SCHEMA)
    );
    assert!(!diag.sqlite_version.is_empty());
    assert!(root.path().join("database.sqlite").is_file());

    // The wire surface is unchanged: meta.get must still dispatch.
    let flag = CancellationFlag::new();
    let bytes = kernel
        .dispatch("meta.get", b"{}", &flag)
        .expect("meta.get must work with durable storage");
    let meta: MetaDto = decode_meta_dto(&bytes).expect("meta bytes must decode");
    assert_eq!(meta.product_wire.major, 1);
}

#[test]
fn second_kernel_on_same_data_root_is_controlled_error() {
    let root = tempfile::tempdir().expect("tempdir");
    let _first = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.path().to_path_buf()),
    })
    .expect("first open");

    let err = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.path().to_path_buf()),
    })
    .expect_err("second writable open must fail while the first holds the lease");
    assert_eq!(err.code, KernelErrorCode::DataRootInUse);
}

#[test]
fn releasing_kernel_releases_data_root() {
    let root = tempfile::tempdir().expect("tempdir");
    let first = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.path().to_path_buf()),
    })
    .expect("first open");
    drop(first);

    // Same process re-acquires after the previous kernel dropped its lease.
    let second = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.path().to_path_buf()),
    })
    .expect("re-open after release");
    assert_eq!(
        second.storage_diagnostics().unwrap().schema_revision,
        Some(neotavern_storage::CURRENT_SCHEMA)
    );
}

#[test]
fn stateless_kernel_reports_no_storage() {
    let kernel = open_kernel();
    assert!(!kernel.has_storage());
    assert!(kernel.storage_diagnostics().is_none());
}
