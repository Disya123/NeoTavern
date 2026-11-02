//! Asset catalog (`assets.list`) through the kernel: the canonical enumeration
//! that lets a feature own a "collection" without owning a second store.
//!
//! Proves: the `kind` filter is exact (a background list never leaks gallery
//! images), ordering is newest-first with a stable id tiebreak, the opaque
//! cursor pages without gaps or repeats and disappears on the last page, and a
//! malformed cursor is a stable CONTRACT_VIOLATION instead of a 500/panic.

use contracts_generated::generated::{ResultAssetsList, ResultAssetsPut};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError};
use serde_json::{json, Value};

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

fn put_asset(
    kernel: &Kernel,
    kind: &str,
    filename: &str,
    content: &[u8],
) -> Result<String, KernelError> {
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::STANDARD.encode(content);
    let response = dispatch(
        kernel,
        "assets.put",
        json!({ "kind": kind, "filename": filename, "contentBase64": payload }),
    )?;
    let dto: ResultAssetsPut = serde_json::from_value(response).expect("put result decodes");
    Ok(dto.asset.id)
}

fn list(kernel: &Kernel, request: Value) -> Result<ResultAssetsList, KernelError> {
    dispatch(kernel, "assets.list", request)
        .map(|value| serde_json::from_value(value).expect("list result decodes"))
}

#[test]
fn the_catalog_filters_by_kind_and_orders_newest_first() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    let first = put_asset(&kernel, "background", "a.png", b"background one").expect("put");
    let other = put_asset(&kernel, "gallery", "b.png", b"gallery one").expect("put");
    let second = put_asset(&kernel, "background", "c.png", b"background two").expect("put");

    let backgrounds = list(&kernel, json!({ "kind": "background" })).expect("list backgrounds");
    let ids: Vec<&str> = backgrounds
        .items
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    // Newest first; the gallery asset never appears.
    assert_eq!(ids, vec![second.as_str(), first.as_str()]);
    assert!(
        backgrounds.next_cursor.is_none(),
        "one page holds the whole list"
    );
    assert!(backgrounds
        .items
        .iter()
        .all(|item| item.kind == "background"));

    let all = list(&kernel, json!({})).expect("list everything");
    assert_eq!(all.items.len(), 3);
    assert!(all.items.iter().any(|item| item.id == other));
}

#[test]
fn the_cursor_pages_without_gaps_or_repeats() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    for index in 0..5 {
        put_asset(
            &kernel,
            "background",
            &format!("wall-{index}.png"),
            format!("bytes {index}").as_bytes(),
        )
        .expect("put");
    }

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let request = match &cursor {
            Some(cursor) => json!({ "kind": "background", "limit": 2, "cursor": cursor }),
            None => json!({ "kind": "background", "limit": 2 }),
        };
        let page = list(&kernel, request).expect("page");
        pages += 1;
        seen.extend(page.items.iter().map(|item| item.id.clone()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        assert!(pages < 10, "the cursor must terminate");
    }
    assert_eq!(pages, 3, "five rows in pages of two");
    assert_eq!(seen.len(), 5, "every asset exactly once");

    let unique: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), seen.len(), "no repeats across pages");
}

#[test]
fn a_malformed_cursor_is_a_contract_violation() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    put_asset(&kernel, "background", "a.png", b"one").expect("put");

    let error = list(&kernel, json!({ "cursor": "not-base64-at-all!!" })).expect_err("bad cursor");
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );

    // A well-formed base64 cursor without the `created_at|id` shape is refused too.
    let error = list(&kernel, json!({ "cursor": "bm9wZQ" })).expect_err("shapeless cursor");
    assert_eq!(
        error.code,
        runtime_kernel::KernelErrorCode::ContractViolation
    );
}

#[test]
fn a_deleted_asset_leaves_the_catalog() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let keep = put_asset(&kernel, "background", "keep.png", b"keep").expect("put");
    let drop = put_asset(&kernel, "background", "drop.png", b"drop").expect("put");

    dispatch(&kernel, "assets.delete", json!({ "assetId": drop })).expect("delete");
    let after = list(&kernel, json!({ "kind": "background" })).expect("list");
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.items[0].id, keep);
}
