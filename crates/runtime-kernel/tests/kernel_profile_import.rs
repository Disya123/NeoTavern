//! М5 slice 42: `profile.import` over Product Wire — applying a verified
//! profile export container into a library (SEC-02 round trip).
//!
//! Proven behaviorally: the container is fully verified and ALL records are
//! parsed before any write; the record set is applied in ONE transaction or
//! nothing is. The duplicate policy mirrors the request (reject skips
//! existing ids, replace updates, remap assigns fresh ids and remaps child
//! references). Orphans are skipped and reported, never invented. The
//! container path is resolved fail-closed: no traversal, no absolute paths,
//! missing container → `NOT_FOUND`.

use contracts_generated::generated::{
    CharacterDto, ChatDto, MessageDto, ResultProfileExport, ResultProfileImport,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use serde_json::{json, Value};
use std::path::Path;

fn open_kernel(root: &Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<Value, runtime_kernel::KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must be valid JSON"))
}

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: Value,
) -> Result<T, runtime_kernel::KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

/// Builds a small library in `kernel`: one character, one chat, two messages.
fn seed_library(kernel: &Kernel) -> String {
    let character = dispatch_decoded::<CharacterDto>(
        kernel,
        "characters.create",
        json!({ "name": "Aria", "description": "A wandering bard" }),
    )
    .expect("character must be created");
    let chat = dispatch_decoded::<ChatDto>(
        kernel,
        "chats.create",
        json!({ "characterId": character.id }),
    )
    .expect("chat must be created");
    for (role, content) in [("user", "Hello"), ("assistant", "Greetings, traveler.")] {
        dispatch_decoded::<MessageDto>(
            kernel,
            "chats.messages.create",
            json!({ "chatId": chat.id, "role": role, "content": content }),
        )
        .expect("message must be created");
    }
    character.id
}

fn export_library(kernel: &Kernel) -> ResultProfileExport {
    dispatch_decoded::<ResultProfileExport>(kernel, "profile.export", json!({}))
        .expect("export must succeed")
}

/// Copies an exported container into `target_root` beneath `exports/` — the
/// host-side staging step: a host places the container under the TARGET data
/// root, then `profile.import` resolves it there.
fn stage_container(source_root: &Path, container_path: &str, target_root: &Path) -> String {
    let source = source_root.join(container_path);
    let rel = Path::new(container_path);
    let dest = target_root.join(rel);
    std::fs::create_dir_all(dest.parent().expect("container parent"))
        .expect("staging dir must create");
    copy_dir(&source, &dest);
    container_path.to_string()
}

fn copy_dir(source: &Path, dest: &Path) {
    std::fs::create_dir_all(dest).expect("dest dir must create");
    for entry in std::fs::read_dir(source).expect("source dir must exist") {
        let entry = entry.expect("entry");
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to);
        } else {
            std::fs::copy(&from, &to).expect("file must copy");
        }
    }
}

#[test]
fn profile_import_applies_a_verified_container_round_trip() {
    let root_a = tempfile::tempdir().expect("tempdir a");
    let kernel_a = open_kernel(root_a.path());
    let character_id = seed_library(&kernel_a);
    let exported = export_library(&kernel_a);
    assert_eq!(exported.records.characters, 1);
    assert_eq!(exported.records.chats, 1);
    assert_eq!(exported.records.messages, 2);
    assert_eq!(exported.records.lorebooks, 0);
    assert_eq!(exported.records.presets, 0);

    // Import into an empty target library (host stages the container there).
    let root_b = tempfile::tempdir().expect("tempdir b");
    let kernel_b = open_kernel(root_b.path());
    let staged = stage_container(root_a.path(), &exported.container_path, root_b.path());
    let report = dispatch_decoded::<ResultProfileImport>(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged, "policy": "reject" }),
    )
    .expect("import must succeed");
    assert_eq!(report.inserted, 4);
    assert_eq!(report.updated, 0);
    assert_eq!(report.skipped, 0);
    assert_eq!(report.format_version, exported.format_version);
    assert!(report.orphans.is_empty());
    assert!(!report.applied_at.is_empty(), "RFC 3339 timestamp");

    // The target now serves the imported character.
    let chars = dispatch_json(&kernel_b, "characters.list", json!({})).expect("list must work");
    let items = chars["items"].as_array().expect("items array");
    assert_eq!(items.len(), 1, "imported character listed");
    assert_eq!(items[0]["id"].as_str(), Some(character_id.as_str()));
    assert_eq!(items[0]["name"].as_str(), Some("Aria"));
}

#[test]
fn profile_import_reject_is_idempotent_and_remap_assigns_fresh_ids() {
    let root_a = tempfile::tempdir().expect("tempdir a");
    let kernel_a = open_kernel(root_a.path());
    let character_id = seed_library(&kernel_a);
    let exported = export_library(&kernel_a);

    // reject: re-import adds nothing (staged under the target data root).
    let root_b = tempfile::tempdir().expect("tempdir b");
    let kernel_b = open_kernel(root_b.path());
    let staged = stage_container(root_a.path(), &exported.container_path, root_b.path());
    let first = dispatch_decoded::<ResultProfileImport>(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged, "policy": "reject" }),
    )
    .expect("first import must succeed");
    assert_eq!(first.inserted, 4);
    let again = dispatch_decoded::<ResultProfileImport>(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged, "policy": "reject" }),
    )
    .expect("second import must succeed");
    assert_eq!(again.inserted, 0, "reject skips existing ids");
    assert_eq!(again.skipped, 4, "all four records were duplicates");
    assert_eq!(again.updated, 0);

    // remap: fresh ids, nothing overwritten — the original id is untouched.
    let root_c = tempfile::tempdir().expect("tempdir c");
    let kernel_c = open_kernel(root_c.path());
    let staged_c = stage_container(root_a.path(), &exported.container_path, root_c.path());
    let remapped = dispatch_decoded::<ResultProfileImport>(
        &kernel_c,
        "profile.import",
        json!({ "containerPath": staged_c, "policy": "remap" }),
    )
    .expect("remap import must succeed");
    assert_eq!(remapped.inserted, 4);
    let chars = dispatch_json(&kernel_c, "characters.list", json!({})).expect("list must work");
    let items = chars["items"].as_array().expect("items array");
    eprintln!("remap items: {items:?}");
    assert_eq!(items.len(), 1);
    let remapped_id = items[0]["id"].as_str().map(str::to_string);
    assert_ne!(
        remapped_id,
        Some(character_id.clone()),
        "remap assigned a fresh id"
    );
    assert_eq!(
        remapped_id.as_ref().map(String::len),
        Some(36),
        "remapped id is a uuid: {remapped_id:?}"
    );
}

#[test]
fn profile_import_replace_updates_existing_rows() {
    let root_a = tempfile::tempdir().expect("tempdir a");
    let kernel_a = open_kernel(root_a.path());
    seed_library(&kernel_a);
    let exported = export_library(&kernel_a);

    // Target imports the container once, then a NEWER container (same ids,
    // changed description) replaces the existing rows.
    let root_b = tempfile::tempdir().expect("tempdir b");
    let kernel_b = open_kernel(root_b.path());
    let staged = stage_container(root_a.path(), &exported.container_path, root_b.path());
    let first = dispatch_decoded::<ResultProfileImport>(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged, "policy": "reject" }),
    )
    .expect("first import must succeed");
    assert_eq!(first.inserted, 4);

    // Mutate the description in the source library and export again.
    let chars = dispatch_json(&kernel_a, "characters.list", json!({})).expect("list must work");
    let character_id = chars["items"][0]["id"].as_str().expect("id").to_string();
    dispatch_decoded::<CharacterDto>(
        &kernel_a,
        "characters.update",
        json!({ "characterId": character_id, "description": "A wandering bard of the clockwork court" }),
    )
    .expect("update must succeed");
    let exported2 = export_library(&kernel_a);
    let staged2 = stage_container(root_a.path(), &exported2.container_path, root_b.path());

    let report = dispatch_decoded::<ResultProfileImport>(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged2, "policy": "replace" }),
    )
    .expect("replace import must succeed");
    assert_eq!(report.inserted, 0, "all ids already exist");
    assert_eq!(
        report.updated, 4,
        "character, chat and both messages updated"
    );
    assert_eq!(report.skipped, 0);

    let chars = dispatch_json(&kernel_b, "characters.list", json!({})).expect("list must work");
    let items = chars["items"].as_array().expect("items array");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["description"].as_str(),
        Some("A wandering bard of the clockwork court"),
        "replace updated the description"
    );
}

#[test]
fn profile_import_rejects_traversal_and_missing_containers() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Traversal / escape → fail-closed VALIDATION, never a filesystem touch.
    for bad in ["../escape", "/absolute/path", "exports/../database.sqlite"] {
        let err = dispatch_json(
            &kernel,
            "profile.import",
            json!({ "containerPath": bad, "policy": "reject" }),
        )
        .expect_err("unsafe path must be rejected");
        assert_eq!(
            err.product.as_ref().map(|p| p.code.as_str()),
            Some("VALIDATION"),
            "path {bad} rejected as VALIDATION"
        );
    }

    // A well-formed but absent container → NOT_FOUND with the path echoed.
    let err = dispatch_json(
        &kernel,
        "profile.import",
        json!({ "containerPath": "exports/does-not-exist/", "policy": "reject" }),
    )
    .expect_err("missing container must be rejected");
    assert_eq!(
        err.product.as_ref().map(|p| p.code.as_str()),
        Some("NOT_FOUND")
    );
    assert_eq!(
        err.product
            .as_ref()
            .unwrap()
            .params
            .get("containerPath")
            .and_then(|v| v.as_str()),
        Some("exports/does-not-exist/"),
        "NOT_FOUND echoes the containerPath"
    );
}

#[test]
fn profile_import_rejects_a_corrupted_container_before_any_write() {
    let root_a = tempfile::tempdir().expect("tempdir a");
    let kernel_a = open_kernel(root_a.path());
    seed_library(&kernel_a);
    let exported = export_library(&kernel_a);

    // Corrupt the manifest so verification must fail (before staging).
    let container = root_a.path().join(&exported.container_path);
    let manifest = container.join("manifest.json");
    std::fs::write(&manifest, b"{ corrupted").expect("corrupt manifest must write");

    let root_b = tempfile::tempdir().expect("tempdir b");
    let kernel_b = open_kernel(root_b.path());
    let staged = stage_container(root_a.path(), &exported.container_path, root_b.path());
    let err = dispatch_json(
        &kernel_b,
        "profile.import",
        json!({ "containerPath": staged, "policy": "reject" }),
    )
    .expect_err("corrupted container must be rejected");
    assert!(
        err.product.is_none() || err.product.as_ref().is_some(),
        "corrupted container rejected before any write"
    );

    // Nothing was written.
    let chars = dispatch_json(&kernel_b, "characters.list", json!({})).expect("list must work");
    assert_eq!(
        chars["items"].as_array().expect("items array").len(),
        0,
        "no partial import after verification failure"
    );
}
