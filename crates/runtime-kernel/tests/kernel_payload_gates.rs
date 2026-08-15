//! Plan rev 2.2 Layer C/D — kernel payload gates (вход, линия 2).
//!
//! Behavioral, NOT grep-based: proves that over-limit payloads are rejected
//! with the stable `PAYLOAD_TOO_LARGE` product error BEFORE any parse, that
//! unknown operations win over the limit gate (OperationNotFound first), and
//! that the gate also covers the stream dispatch path. These tests never
//! materialize a payload larger than a few KiB on the test side.

use contracts_generated::generated::ProductErrorDto;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};

/// meta.get request limit from the registry (generated, single source of
/// truth): assert the value the test relies on instead of hard-coding it.
const META_REQUEST_LIMIT: u64 = 1024;

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn payload_too_large(err: &KernelError) -> &ProductErrorDto {
    assert_eq!(
        err.code,
        KernelErrorCode::Conflict,
        "PAYLOAD_TOO_LARGE maps to the Conflict class"
    );
    err.product
        .as_ref()
        .expect("PAYLOAD_TOO_LARGE must carry the wire product dto")
}

#[test]
fn over_limit_invalid_json_is_payload_too_large_not_validation() {
    // The body is BOTH over the meta.get limit AND invalid JSON. If the gate
    // ran after the parser, we would see a validation error; the invariant is
    // PAYLOAD_TOO_LARGE (gate BEFORE parse) — plan rev 2.2 Layer C.
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();

    let over = (META_REQUEST_LIMIT + 1024) as usize;
    let mut body = Vec::with_capacity(over);
    body.push(b'{'); // start a JSON object, then garbage
    body.extend(std::iter::repeat_n(b'x', over - 2));
    body.push(b'}');

    let err = kernel
        .dispatch("meta.get", &body, &flag)
        .expect_err("over-limit body must be rejected");
    let product = payload_too_large(&err);
    assert_eq!(product.code, "PAYLOAD_TOO_LARGE");
    assert_eq!(product.params["operationId"], "meta.get");
    assert_eq!(
        product.params["limit"],
        META_REQUEST_LIMIT.to_string(),
        "limit must come from the generated registry data"
    );
}

#[test]
fn over_limit_valid_json_is_payload_too_large_not_validation() {
    // Even a STRUCTURALLY VALID but over-limit body is rejected by the byte
    // gate before the schema checker would flag its extra fields.
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();

    let wide_field = "x".repeat((META_REQUEST_LIMIT + 512) as usize);
    let body = format!(r#"{{"extra":"{wide_field}"}}"#);

    let err = kernel
        .dispatch("meta.get", body.as_bytes(), &flag)
        .expect_err("over-limit body must be rejected");
    assert_eq!(payload_too_large(&err).code, "PAYLOAD_TOO_LARGE");
}

#[test]
fn unknown_operation_wins_over_the_limit_gate() {
    // Unknown op → OperationNotFound BEFORE the limit gate, so a huge
    // invalid body for a nonexistent op reports the op, not the size.
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();

    let body = vec![b'x'; 8 * 1024];
    let err = kernel
        .dispatch("does.not.exist", &body, &flag)
        .expect_err("unknown op must be rejected");
    assert_eq!(err.code, KernelErrorCode::OperationNotFound);
    assert!(err.product.is_none());
}

#[test]
fn stream_dispatch_rejects_over_limit_payloads() {
    // generation.start (generated requestLimitBytes = 131072) with a larger
    // message: the gate fires before the DTO parse, so even without a seeded
    // chat the error is PAYLOAD_TOO_LARGE, not CHAT_NOT_FOUND / validation.
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();

    let message = "x".repeat(131_072 + 256);
    let request = serde_json::json!({
        "chatId": "00000000-0000-4000-8000-000000000001",
        "message": message,
    });
    let bytes = serde_json::to_vec(&request).expect("serialize");
    assert!(
        bytes.len() > 131_072,
        "test body must actually exceed the generated request limit"
    );

    let err = kernel
        .dispatch_stream("generation.start", &bytes, &flag)
        .expect_err("over-limit stream request must be rejected");
    let product = payload_too_large(&err);
    assert_eq!(product.code, "PAYLOAD_TOO_LARGE");
    assert_eq!(product.params["operationId"], "generation.start");
}

#[test]
fn sanity_meta_get_still_works() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let flag = CancellationFlag::new();
    let response = kernel
        .dispatch("meta.get", b"{}", &flag)
        .expect("normal meta.get must still succeed");
    assert!(!response.is_empty());
}
