//! Plugin blob store (`plugins.blobs.*`, M7 Этап-4 cluster 21a).
//!
//! The legacy `/api/v2/plugins/:id/blobs*` routes accepted an 8 MiB binary body
//! and kept `<root>/<pluginId>/<blobId>.{bin,json}` on disk. The canonical
//! family has to keep every guarantee the sandbox relies on while riding the
//! JSON-only Product Wire, so these tests pin exactly that:
//!
//! - the blob id IS the sha256 of the bytes (content addressing + dedupe);
//! - the declared length is authoritative and chunks are sequential;
//! - reads are bounded ranges, so an 8 MiB blob never rides one response;
//! - the `storage.blobs` grant and the upload row's owner are both enforced,
//!   so one plugin can never address another plugin's bytes;
//! - 64 blobs per plugin is a hard quota, delete is idempotent.

use base64::Engine as _;
use contracts_generated::generated::{
    decode_plugin_blob, decode_result_plugins_blobs_append, decode_result_plugins_blobs_begin,
    decode_result_plugins_blobs_delete, decode_result_plugins_blobs_list,
    decode_result_plugins_blobs_read,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::Value;

const PLUGIN_A: &str = "blob-store-plugin";
const PLUGIN_B: &str = "blob-thief-plugin";

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn with_db<T>(
    root: &std::path::Path,
    f: impl FnOnce(&mut neotavern_storage::open::Database) -> T,
) -> T {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must open");
    f(&mut db)
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
        .expect("a product error carries a wire code")
        .code
        .clone()
}

fn install_plugin(kernel: &Kernel, id: &str, permissions: &[&str]) {
    dispatch(
        kernel,
        "plugins.install",
        serde_json::json!({
            "id": id,
            "name": "Blob Store",
            "version": "1.0.0",
            "trustState": "locally-trusted",
            "permissions": permissions,
        }),
    );
}

fn begin(kernel: &Kernel, plugin: &str, name: &str, bytes: &[u8]) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.begin",
        serde_json::json!({
            "pluginId": plugin,
            "name": name,
            "contentType": "application/octet-stream",
            "totalBytes": bytes.len(),
        }),
    );
    decode_result_plugins_blobs_begin(
        &serde_json::to_vec(&response).expect("re-serialize begin result"),
    )
    .expect("begin must answer a schema-valid wire.result.plugins.blobs.begin");
    response
}

fn append(kernel: &Kernel, plugin: &str, upload_id: &str, index: i64, bytes: &[u8]) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.append",
        serde_json::json!({
            "pluginId": plugin,
            "uploadId": upload_id,
            "index": index,
            "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }),
    );
    decode_result_plugins_blobs_append(
        &serde_json::to_vec(&response).expect("re-serialize append result"),
    )
    .expect("append must answer a schema-valid wire.result.plugins.blobs.append");
    response
}

fn finish(kernel: &Kernel, plugin: &str, upload_id: &str) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.finish",
        serde_json::json!({ "pluginId": plugin, "uploadId": upload_id }),
    );
    decode_plugin_blob(&serde_json::to_vec(&response).expect("re-serialize finish result"))
        .expect("finish must answer a schema-valid wire.plugin-blob");
    response
}

fn upload(kernel: &Kernel, plugin: &str, name: &str, bytes: &[u8]) -> Value {
    let started = begin(kernel, plugin, name, bytes);
    let upload_id = started["uploadId"]
        .as_str()
        .expect("begin returns an upload id");
    let chunk = 512 * 1024;
    for (index, part) in bytes.chunks(chunk).enumerate() {
        append(kernel, plugin, upload_id, index as i64, part);
    }
    finish(kernel, plugin, upload_id)
}

fn read_range(kernel: &Kernel, plugin: &str, blob_id: &str, offset: i64, length: i64) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.read",
        serde_json::json!({
            "pluginId": plugin,
            "blobId": blob_id,
            "offset": offset,
            "length": length,
        }),
    );
    decode_result_plugins_blobs_read(
        &serde_json::to_vec(&response).expect("re-serialize read result"),
    )
    .expect("read must answer a schema-valid wire.result.plugins.blobs.read");
    response
}

fn list(kernel: &Kernel, plugin: &str) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.list",
        serde_json::json!({ "pluginId": plugin }),
    );
    decode_result_plugins_blobs_list(&serde_json::to_vec(&response).expect("re-serialize list"))
        .expect("list must answer a schema-valid wire.result.plugins.blobs.list");
    response
}

fn delete(kernel: &Kernel, plugin: &str, blob_id: &str) -> Value {
    let response = dispatch(
        kernel,
        "plugins.blobs.delete",
        serde_json::json!({ "pluginId": plugin, "blobId": blob_id }),
    );
    decode_result_plugins_blobs_delete(
        &serde_json::to_vec(&response).expect("re-serialize delete result"),
    )
    .expect("delete must answer a schema-valid wire.result.plugins.blobs.delete");
    response
}

fn seeded_kernel(root: &std::path::Path) -> Kernel {
    let kernel = open_kernel(root);
    install_plugin(&kernel, PLUGIN_A, &["storage.blobs"]);
    install_plugin(&kernel, PLUGIN_B, &["storage.blobs"]);
    kernel
}

#[test]
fn blob_round_trip_is_content_addressed() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let stored = upload(&kernel, PLUGIN_A, "greeting.txt", b"hello");
    let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(stored["blobId"], expected, "the blob id is the sha256");
    assert_eq!(stored["hash"], expected);
    assert_eq!(stored["name"], "greeting.txt");
    assert_eq!(stored["sizeBytes"], 5);

    let read = read_range(&kernel, PLUGIN_A, expected, 0, 1024);
    assert_eq!(read["dataBase64"], "aGVsbG8=");
    assert_eq!(read["sizeBytes"], 5);
    assert_eq!(read["eof"], true);

    let listed = list(&kernel, PLUGIN_A);
    assert_eq!(listed["items"].as_array().expect("items").len(), 1);
    assert_eq!(listed["items"][0]["blobId"], expected);

    assert_eq!(delete(&kernel, PLUGIN_A, expected)["deleted"], true);
    assert_eq!(
        delete(&kernel, PLUGIN_A, expected)["deleted"],
        false,
        "delete is idempotent"
    );
    let (code, _) = (
        product_code(&dispatch_error(
            &kernel,
            "plugins.blobs.read",
            serde_json::json!({ "pluginId": PLUGIN_A, "blobId": expected, "offset": 0, "length": 8 }),
        )),
        (),
    );
    assert_eq!(code, "PLUGIN_BLOB_NOT_FOUND", "bytes are gone with the row");
}

#[test]
fn identical_bytes_dedupe_and_refresh_metadata() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let first = upload(&kernel, PLUGIN_A, "first.bin", b"same bytes");
    let second = upload(&kernel, PLUGIN_A, "second.bin", b"same bytes");
    assert_eq!(
        first["blobId"], second["blobId"],
        "content addressing dedupes"
    );
    assert_eq!(second["name"], "second.bin", "re-upload refreshes metadata");

    let listed = list(&kernel, PLUGIN_A);
    assert_eq!(
        listed["items"].as_array().expect("items").len(),
        1,
        "one row per digest"
    );
    assert_eq!(listed["items"][0]["name"], "second.bin");
}

#[test]
fn reads_are_bounded_ranges() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let bytes = vec![b'x'; 300_000];
    let stored = upload(&kernel, PLUGIN_A, "large.bin", &bytes);
    let blob_id = stored["blobId"].as_str().expect("blob id");

    let first = read_range(&kernel, PLUGIN_A, blob_id, 0, 262_144);
    let first_bytes = base64::engine::general_purpose::STANDARD
        .decode(first["dataBase64"].as_str().expect("data"))
        .expect("valid base64");
    assert_eq!(first_bytes.len(), 262_144, "the chunk cap is enforced");
    assert_eq!(first["eof"], false, "300k does not fit in one chunk");

    let second = read_range(&kernel, PLUGIN_A, blob_id, 262_144, 262_144);
    let second_bytes = base64::engine::general_purpose::STANDARD
        .decode(second["dataBase64"].as_str().expect("data"))
        .expect("valid base64");
    assert_eq!(second_bytes.len(), 300_000 - 262_144);
    assert_eq!(second["eof"], true, "the last range reports eof");

    // Reading exactly at the end is an honest empty tail, not an error.
    let tail = read_range(&kernel, PLUGIN_A, blob_id, 300_000, 16);
    assert_eq!(tail["dataBase64"], "");
    assert_eq!(tail["eof"], true);

    // An offset past the blob is a contract violation.
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.read",
        serde_json::json!({
            "pluginId": PLUGIN_A,
            "blobId": blob_id,
            "offset": 300_001,
            "length": 16,
        }),
    );
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn staging_is_sequential_and_size_bounded() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let started = begin(&kernel, PLUGIN_A, "chunks.bin", &[0u8; 8]);
    let upload_id = started["uploadId"].as_str().expect("upload id");

    let error = dispatch_error(
        &kernel,
        "plugins.blobs.append",
        serde_json::json!({
            "pluginId": PLUGIN_A,
            "uploadId": upload_id,
            "index": 1,
            "contentBase64": "aGVsbG8=",
        }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_UPLOAD_OUT_OF_ORDER");

    let error = dispatch_error(
        &kernel,
        "plugins.blobs.finish",
        serde_json::json!({ "pluginId": PLUGIN_A, "uploadId": upload_id }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_UPLOAD_INCOMPLETE");

    append(&kernel, PLUGIN_A, upload_id, 0, b"hello");
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.append",
        serde_json::json!({
            "pluginId": PLUGIN_A,
            "uploadId": upload_id,
            "index": 1,
            "contentBase64": "aGVsbG8=",
        }),
    );
    assert_eq!(
        product_code(&error),
        "PLUGIN_BLOB_SIZE_EXCEEDED",
        "the declared length is authoritative"
    );
}

#[test]
fn family_requires_the_storage_blobs_grant() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    install_plugin(&kernel, "no-blob-plugin", &["storage.user"]);

    let error = dispatch_error(
        &kernel,
        "plugins.blobs.begin",
        serde_json::json!({
            "pluginId": "no-blob-plugin",
            "name": "x.bin",
            "contentType": "application/octet-stream",
            "totalBytes": 4,
        }),
    );
    assert_eq!(product_code(&error), "PLUGIN_PERMISSION_DENIED");
}

#[test]
fn another_plugins_upload_and_bytes_are_unreachable() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = seeded_kernel(root.path());

    let started = begin(&kernel, PLUGIN_A, "secret.bin", b"plugin a only");
    let upload_id = started["uploadId"].as_str().expect("upload id");

    // Holding the upload id is useless for another plugin…
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.append",
        serde_json::json!({
            "pluginId": PLUGIN_B,
            "uploadId": upload_id,
            "index": 0,
            "contentBase64": "aGVsbG8=",
        }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_UPLOAD_NOT_FOUND");
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.finish",
        serde_json::json!({ "pluginId": PLUGIN_B, "uploadId": upload_id }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_UPLOAD_NOT_FOUND");

    // …and so is knowing the digest: the row is plugin-scoped.
    append(&kernel, PLUGIN_A, upload_id, 0, b"plugin a only");
    let stored = finish(&kernel, PLUGIN_A, upload_id);
    let blob_id = stored["blobId"].as_str().expect("blob id");
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.read",
        serde_json::json!({ "pluginId": PLUGIN_B, "blobId": blob_id, "offset": 0, "length": 16 }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_NOT_FOUND");
    assert_eq!(
        list(&kernel, PLUGIN_B)["items"]
            .as_array()
            .expect("items")
            .len(),
        0
    );

    // Uninstalling the owner reclaims the bytes: the rows cascade and the
    // per-plugin directory is swept.
    dispatch(
        &kernel,
        "plugins.uninstall",
        serde_json::json!({ "id": PLUGIN_A }),
    );
    assert!(
        !root.path().join("plugin-blobs").join(PLUGIN_A).exists(),
        "the uninstall sweeps the plugin's blob directory"
    );
}

#[test]
fn blob_count_quota_is_enforced() {
    let root = tempfile::tempdir().expect("tempdir");
    // Install first, drop the kernel (and its data-root lease), then seed the
    // quota directly: 64 real uploads would only slow the test down, and the
    // row count is the authority the finish path checks.
    {
        let kernel = seeded_kernel(root.path());
        drop(kernel);
    }
    with_db(root.path(), |db| {
        db.transaction(|tx| {
            for index in 0..64 {
                let blob_id = format!("{index:064x}");
                tx.execute(
                    "INSERT INTO plugin_blobs \
                     (plugin_id, blob_id, name, content_type, size_bytes, created_at, updated_at) \
                     VALUES (?1, ?2, 'seed', 'application/octet-stream', 1, \
                     '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
                    rusqlite::params![PLUGIN_A, blob_id],
                )
                .expect("seed blob row");
            }
            Ok::<(), neotavern_storage::StorageError>(())
        })
        .expect("seeding transaction must succeed");
    });
    let kernel = open_kernel(root.path());

    let started = begin(&kernel, PLUGIN_A, "one-too-many.bin", &[1u8; 4]);
    let upload_id = started["uploadId"].as_str().expect("upload id");
    append(&kernel, PLUGIN_A, upload_id, 0, &[1u8; 4]);
    let error = dispatch_error(
        &kernel,
        "plugins.blobs.finish",
        serde_json::json!({ "pluginId": PLUGIN_A, "uploadId": upload_id }),
    );
    assert_eq!(product_code(&error), "PLUGIN_BLOB_QUOTA_EXCEEDED");
}
