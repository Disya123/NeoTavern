//! Kernel character-gallery operation tests (M7 Etap-4 gallery slice,
//! ТЗ §13.1): `characters.gallery.list/add/delete` over the dispatch surface
//! — wire-valid DTOs on a seeded kernel, owner-scoped idempotent delete,
//! missing-character rejection, stateless-kernel rejection.

use contracts_generated::generated::ResultCharactersGalleryList;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn open_stateless_kernel() -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel must open")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

const PNG_BASE64: &str = "aGVsbG8="; // "hello"

#[test]
fn gallery_add_list_delete_round_trip() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let created = dispatch_json(
        &kernel,
        "characters.create",
        json!({ "name": "Gallery Char", "tags": ["art"] }),
    )
    .expect("character create must succeed");
    let character_id = created["id"].as_str().expect("character id").to_string();

    // Add: publishes the bytes (kind gallery) and links them.
    let added = dispatch_json(
        &kernel,
        "characters.gallery.add",
        json!({
            "characterId": character_id,
            "filename": "sunset.png",
            "contentType": "image/png",
            "contentBase64": PNG_BASE64,
        }),
    )
    .expect("gallery add must succeed");
    let item = &added["item"];
    assert_eq!(item["characterId"], json!(character_id));
    assert_eq!(added["deduplicated"], json!(false));
    assert_eq!(item["sizeBytes"], json!(5));
    assert_eq!(item["checksumSha256"].as_str().map(str::len), Some(64));
    let asset_id = item["assetId"].as_str().expect("assetId").to_string();
    let image_id = item["id"].as_str().expect("image id").to_string();

    // The published asset is servable through the existing assets port.
    let content = dispatch_json(&kernel, "assets.get", json!({ "assetId": asset_id }))
        .expect("the gallery asset must exist");
    assert_eq!(content["asset"]["id"], json!(asset_id));

    // List returns the one entry (default order).
    let listed = dispatch_json(
        &kernel,
        "characters.gallery.list",
        json!({ "characterId": character_id }),
    )
    .expect("gallery list must succeed");
    let parsed: ResultCharactersGalleryList =
        serde_json::from_value(listed).expect("list response must decode to the wire DTO");
    assert_eq!(parsed.items.len(), 1);
    assert_eq!(parsed.items[0].id, image_id);

    // Re-adding identical bytes deduplicates the ASSET but still creates a
    // second link (per-link records, shared content).
    let again = dispatch_json(
        &kernel,
        "characters.gallery.add",
        json!({
            "characterId": character_id,
            "filename": "sunset-copy.png",
            "contentBase64": PNG_BASE64,
        }),
    )
    .expect("second add must succeed");
    assert_eq!(again["deduplicated"], json!(true));
    assert_eq!(again["item"]["assetId"], json!(asset_id));

    // Owner-scoped idempotent delete.
    let deleted = dispatch_json(
        &kernel,
        "characters.gallery.delete",
        json!({ "characterId": character_id, "imageId": image_id }),
    )
    .expect("gallery delete must succeed");
    assert_eq!(deleted["deleted"], json!(true));
    let again_delete = dispatch_json(
        &kernel,
        "characters.gallery.delete",
        json!({ "characterId": character_id, "imageId": image_id }),
    )
    .expect("repeat delete must succeed");
    assert_eq!(again_delete["deleted"], json!(false));

    // The asset bytes survive the link delete (immutable store).
    dispatch_json(&kernel, "assets.get", json!({ "assetId": asset_id }))
        .expect("asset must outlive its gallery link");
}

#[test]
fn gallery_list_of_missing_character_is_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let err = dispatch_json(
        &kernel,
        "characters.gallery.list",
        json!({ "characterId": "018f0000-0000-4000-8000-00000000dead" }),
    )
    .expect_err("missing character must fail");
    let product = err.product.expect("carries the wire product DTO");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
}

#[test]
fn gallery_add_of_missing_character_is_not_found() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let err = dispatch_json(
        &kernel,
        "characters.gallery.add",
        json!({
            "characterId": "018f0000-0000-4000-8000-00000000dead",
            "filename": "x.png",
            "contentBase64": PNG_BASE64,
        }),
    )
    .expect_err("missing character must fail");
    let product = err.product.expect("carries the wire product DTO");
    assert_eq!(product.code, "CHARACTER_NOT_FOUND");
}

#[test]
fn stateless_kernel_rejects_gallery_ops_with_storage_failure() {
    let kernel = open_stateless_kernel();

    for (op, request) in [
        (
            "characters.gallery.list",
            json!({ "characterId": "018f0000-0000-4000-8000-0000000000aa" }),
        ),
        (
            "characters.gallery.add",
            json!({
                "characterId": "018f0000-0000-4000-8000-0000000000aa",
                "filename": "x.png",
                "contentBase64": PNG_BASE64,
            }),
        ),
        (
            "characters.gallery.delete",
            json!({
                "characterId": "018f0000-0000-4000-8000-0000000000aa",
                "imageId": "018f0000-0000-4000-8000-0000000000bb",
            }),
        ),
    ] {
        let err = dispatch_json(&kernel, op, request).expect_err("stateless must fail");
        assert_eq!(
            err.code,
            KernelErrorCode::StorageFailure,
            "{op} on a stateless kernel must surface StorageFailure"
        );
    }
}
