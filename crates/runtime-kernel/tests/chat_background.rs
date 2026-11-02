//! Chat wallpaper through the kernel (`chats.update.backgroundAssetId`).
//!
//! The wallpaper stops being a filename in the sidecar's
//! `data/files/backgrounds/` and becomes a reference to a `background` asset —
//! the consumer side of `assets.list` (ADR-0061). Proves: the reference round-
//! trips through `chats.get`/`chats.update`, a non-background asset is a stable
//! CONTRACT_VIOLATION instead of a silently blank wallpaper, an unknown asset is
//! ASSET_NOT_FOUND, `clearBackground` is the only unset spelling (the wire has
//! no nullable fields), setting and clearing at once is rejected, and
//! `assets.delete` detaches the reference from every chat.

use contracts_generated::generated::{ChatDto, ResultAssetsPut};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

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

fn put_asset(kernel: &Kernel, kind: &str, filename: &str, content: &[u8]) -> String {
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::STANDARD.encode(content);
    let response = dispatch(
        kernel,
        "assets.put",
        json!({ "kind": kind, "filename": filename, "contentBase64": payload }),
    )
    .expect("put");
    let dto: ResultAssetsPut = serde_json::from_value(response).expect("put result decodes");
    dto.asset.id
}

fn create_chat(kernel: &Kernel) -> String {
    let character = dispatch(
        kernel,
        "characters.create",
        json!({ "name": "Wallpaper Owner", "description": "" }),
    )
    .expect("create character");
    let character_id = character["id"].as_str().expect("character id").to_string();
    let chat = dispatch(
        kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": "Wallpaper chat" }),
    )
    .expect("create chat");
    chat["id"].as_str().expect("chat id").to_string()
}

fn get_chat(kernel: &Kernel, chat_id: &str) -> ChatDto {
    let value = dispatch(kernel, "chats.get", json!({ "chatId": chat_id })).expect("get chat");
    serde_json::from_value(value).expect("chat result decodes")
}

fn update_chat(kernel: &Kernel, request: Value) -> Result<ChatDto, KernelError> {
    dispatch(kernel, "chats.update", request)
        .map(|value| serde_json::from_value(value).expect("update result decodes"))
}

#[test]
fn a_background_asset_becomes_the_chat_wallpaper() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let chat_id = create_chat(&kernel);
    let asset_id = put_asset(&kernel, "background", "wall.png", PNG_1X1);

    // A fresh chat carries no wallpaper at all (absent, not null).
    assert_eq!(get_chat(&kernel, &chat_id).background_asset_id, None);

    let updated = update_chat(
        &kernel,
        json!({ "chatId": chat_id, "backgroundAssetId": asset_id }),
    )
    .expect("attach wallpaper");

    assert_eq!(
        updated.background_asset_id.as_deref(),
        Some(asset_id.as_str())
    );

    // Durable, not just echoed back.
    let stored = get_chat(&kernel, &chat_id);
    assert_eq!(
        stored.background_asset_id.as_deref(),
        Some(asset_id.as_str())
    );
}

#[test]
fn clear_background_is_the_only_unset_and_conflicts_with_a_set() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let chat_id = create_chat(&kernel);
    let asset_id = put_asset(&kernel, "background", "wall.png", PNG_1X1);

    update_chat(
        &kernel,
        json!({ "chatId": chat_id, "backgroundAssetId": asset_id }),
    )
    .expect("attach wallpaper");

    let cleared = update_chat(
        &kernel,
        json!({ "chatId": chat_id, "clearBackground": true }),
    )
    .expect("clear wallpaper");
    assert_eq!(cleared.background_asset_id, None);
    assert_eq!(get_chat(&kernel, &chat_id).background_asset_id, None);

    // Both directions at once is a contradictory request, not a silent last-win.
    let conflict = update_chat(
        &kernel,
        json!({
            "chatId": chat_id,
            "backgroundAssetId": asset_id,
            "clearBackground": true
        }),
    );
    assert_eq!(
        conflict.expect_err("must reject").code,
        KernelErrorCode::ContractViolation
    );
}

#[test]
fn only_background_assets_can_become_a_wallpaper() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let chat_id = create_chat(&kernel);
    let gallery_asset = put_asset(&kernel, "gallery", "card.png", PNG_1X1);

    let error = update_chat(
        &kernel,
        json!({ "chatId": chat_id, "backgroundAssetId": gallery_asset }),
    )
    .expect_err("a gallery asset is not a wallpaper");
    assert_eq!(error.code, KernelErrorCode::ContractViolation);
    assert_eq!(get_chat(&kernel, &chat_id).background_asset_id, None);

    // An id that was never published is ASSET_NOT_FOUND, never a dangling link.
    let missing = update_chat(
        &kernel,
        json!({
            "chatId": chat_id,
            "backgroundAssetId": "00000000-0000-4000-8000-000000000000"
        }),
    )
    .expect_err("unknown asset");
    assert_eq!(missing.code, KernelErrorCode::NotFound);
}

#[test]
fn deleting_the_asset_detaches_the_wallpaper() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let chat_id = create_chat(&kernel);
    let asset_id = put_asset(&kernel, "background", "wall.png", PNG_1X1);
    update_chat(
        &kernel,
        json!({ "chatId": chat_id, "backgroundAssetId": asset_id }),
    )
    .expect("attach wallpaper");

    dispatch(&kernel, "assets.delete", json!({ "assetId": asset_id })).expect("delete asset");

    // The column has no FK (asset delete must never fail on a reference), so the
    // kernel detaches explicitly — otherwise the chat would render an empty
    // wallpaper forever with no way to see why.
    assert_eq!(get_chat(&kernel, &chat_id).background_asset_id, None);
}
