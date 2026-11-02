//! Chunked asset upload (`assets.upload.*`, ADR-0061) through the kernel.
//!
//! Proves the ingestion contract end-to-end: bounded chunks stage under the
//! data root, `finish` publishes ONE immutable content-addressed asset with the
//! digest of the assembled bytes, the result is indistinguishable from
//! `assets.put` (same DTO, same dedupe), the declared length is authoritative
//! (a truncated transfer never publishes), out-of-order and over-size chunks are
//! stable product errors, and `abort` reclaims the staged bytes idempotently.

use contracts_generated::generated::{
    ResultAssetsGet, ResultAssetsPut, ResultAssetsUploadAbort, ResultAssetsUploadAppend,
    ResultAssetsUploadBegin,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use serde_json::{json, Value};

const CHUNK_SIZE: usize = 524_288;

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel.dispatch(op, &bytes, &flag)?;
    Ok(serde_json::from_slice(&response).expect("response must be JSON"))
}

fn product_code(error: &KernelError) -> String {
    error
        .product
        .as_ref()
        .expect("a product error carries a wire code")
        .code
        .clone()
}

fn sha256_hex(bytes: &[u8]) -> String {
    neotavern_storage::assets::sha256_hex(bytes)
}

fn begin(kernel: &Kernel, kind: &str, filename: &str, total: usize) -> ResultAssetsUploadBegin {
    let response = dispatch(
        kernel,
        "assets.upload.begin",
        json!({ "kind": kind, "filename": filename, "totalBytes": total }),
    )
    .expect("begin must succeed");
    serde_json::from_value(response).expect("begin result decodes")
}

fn append(
    kernel: &Kernel,
    upload_id: &str,
    index: usize,
    bytes: &[u8],
) -> Result<ResultAssetsUploadAppend, KernelError> {
    let content = base64_encode(bytes);
    dispatch(
        kernel,
        "assets.upload.append",
        json!({ "uploadId": upload_id, "index": index, "contentBase64": content }),
    )
    .map(|value| serde_json::from_value(value).expect("append result decodes"))
}

fn finish(kernel: &Kernel, upload_id: &str) -> Result<ResultAssetsPut, KernelError> {
    dispatch(
        kernel,
        "assets.upload.finish",
        json!({ "uploadId": upload_id }),
    )
    .map(|value| serde_json::from_value(value).expect("finish result decodes"))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Deterministic pseudo-random bytes: reproducible in the test, incompressible
/// enough that a truncated chunk cannot accidentally hash the same.
fn payload(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    for _ in 0..len {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        out.push((state >> 33) as u8);
    }
    out
}

#[test]
fn chunked_upload_publishes_the_same_asset_as_a_single_put() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Two chunks (one full, one short). The assembled file stays under the
    // ssets.put request cap so the dedupe assertion below can compare both
    // publish paths; files ABOVE that cap are exactly what this contract is for.
    let bytes = payload(CHUNK_SIZE + 65_536);
    let upload = begin(&kernel, "background", "wallpaper.png", bytes.len());
    assert_eq!(upload.chunk_size_bytes, CHUNK_SIZE as i64);

    let first = append(&kernel, &upload.upload_id, 0, &bytes[..CHUNK_SIZE]).expect("first chunk");
    assert_eq!(first.received_bytes, CHUNK_SIZE as i64);
    assert_eq!(first.next_index, 1);
    let second = append(&kernel, &upload.upload_id, 1, &bytes[CHUNK_SIZE..]).expect("second chunk");
    assert_eq!(second.received_bytes, bytes.len() as i64);
    assert_eq!(second.next_index, 2);

    // The staged file lives in the data root, outside the database.
    let staged = root.path().join("staged").join(&upload.upload_id);
    assert!(
        staged.join("data.part").exists(),
        "bytes must be staged on disk"
    );

    let finished = finish(&kernel, &upload.upload_id).expect("finish must succeed");
    assert!(!finished.deduplicated);
    assert_eq!(finished.asset.size_bytes, bytes.len() as i64);
    assert_eq!(finished.asset.checksum_sha256, sha256_hex(&bytes));
    assert_eq!(finished.asset.kind, "background");
    assert!(!staged.exists(), "finish must reclaim the staged directory");

    // The published bytes are readable as a normal asset …
    let fetched: ResultAssetsGet = serde_json::from_value(
        dispatch(
            &kernel,
            "assets.get",
            json!({ "assetId": finished.asset.id }),
        )
        .expect("get must succeed"),
    )
    .expect("decode");
    assert_eq!(
        fetched.asset.checksum_sha256,
        finished.asset.checksum_sha256
    );

    // … and a single-shot `assets.put` of the same bytes dedupes onto it.
    let put: ResultAssetsPut = serde_json::from_value(
        dispatch(
            &kernel,
            "assets.put",
            json!({
                "kind": "background",
                "filename": "wallpaper.png",
                "contentBase64": base64_encode(&bytes),
            }),
        )
        .expect("put must succeed"),
    )
    .expect("decode");
    assert!(put.deduplicated, "identical bytes must not publish twice");
    assert_eq!(put.asset.id, finished.asset.id);
}

#[test]
fn append_enforces_sequential_indexes_and_the_declared_size() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let bytes = payload(64);
    let upload = begin(&kernel, "card", "hero.png", bytes.len());

    // Out of order: index 1 before index 0.
    let error = append(&kernel, &upload.upload_id, 1, &bytes).expect_err("out of order");
    assert_eq!(product_code(&error), "ASSET_UPLOAD_OUT_OF_ORDER");

    // Declared 64 bytes, a second chunk would overflow.
    append(&kernel, &upload.upload_id, 0, &bytes).expect("first chunk");
    let overflow = append(&kernel, &upload.upload_id, 1, &[0u8; 1]).expect_err("over size");
    assert_eq!(product_code(&overflow), "ASSET_UPLOAD_SIZE_EXCEEDED");

    // A chunk larger than the negotiated size is refused before any write.
    let big = begin(&kernel, "card", "hero.png", CHUNK_SIZE * 2);
    let too_big =
        append(&kernel, &big.upload_id, 0, &payload(CHUNK_SIZE + 1)).expect_err("chunk too large");
    assert_eq!(
        too_big.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn finish_refuses_an_incomplete_upload() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let upload = begin(&kernel, "card", "hero.png", 128);
    append(&kernel, &upload.upload_id, 0, &payload(64)).expect("first chunk");

    let error = finish(&kernel, &upload.upload_id).expect_err("incomplete");
    assert_eq!(product_code(&error), "ASSET_UPLOAD_INCOMPLETE");

    // The upload is still intact: completing it publishes normally.
    append(&kernel, &upload.upload_id, 1, &payload(64)).expect("second chunk");
    finish(&kernel, &upload.upload_id).expect("completing the upload publishes");
}

#[test]
fn abort_reclaims_staged_bytes_and_is_idempotent() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let bytes = payload(32);
    let upload = begin(&kernel, "card", "hero.png", bytes.len());
    append(&kernel, &upload.upload_id, 0, &bytes).expect("chunk");
    let staged = root.path().join("staged").join(&upload.upload_id);
    assert!(staged.exists());

    let aborted: ResultAssetsUploadAbort = serde_json::from_value(
        dispatch(
            &kernel,
            "assets.upload.abort",
            json!({ "uploadId": upload.upload_id }),
        )
        .expect("abort must succeed"),
    )
    .expect("decode");
    assert!(aborted.deleted);
    assert!(!staged.exists(), "abort must reclaim the staged bytes");

    let again: ResultAssetsUploadAbort = serde_json::from_value(
        dispatch(
            &kernel,
            "assets.upload.abort",
            json!({ "uploadId": upload.upload_id }),
        )
        .expect("abort stays idempotent"),
    )
    .expect("decode");
    assert!(!again.deleted);

    let error = append(&kernel, &upload.upload_id, 0, &bytes).expect_err("gone");
    assert_eq!(product_code(&error), "ASSET_UPLOAD_NOT_FOUND");
}

#[test]
fn a_second_identical_upload_dedupes_instead_of_republishing() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let bytes = payload(1024);

    let first_upload = begin(&kernel, "card", "hero.png", bytes.len());
    append(&kernel, &first_upload.upload_id, 0, &bytes).expect("chunk");
    let first = finish(&kernel, &first_upload.upload_id).expect("first publish");
    assert!(!first.deduplicated);

    let second_upload = begin(&kernel, "card", "hero-copy.png", bytes.len());
    append(&kernel, &second_upload.upload_id, 0, &bytes).expect("chunk");
    let second = finish(&kernel, &second_upload.upload_id).expect("second publish");
    assert!(second.deduplicated);
    assert_eq!(second.asset.id, first.asset.id);
    assert_eq!(
        second.deduplicated_from_id.as_deref(),
        Some(first.asset.id.as_str())
    );
}
