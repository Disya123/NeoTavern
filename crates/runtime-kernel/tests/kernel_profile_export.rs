//! SEC-02: logical allowlist profile export over Product Wire
//! (`profile.export`), proven behaviorally — not by grepping docs.
//!
//! The container is built from the five product sections only; provider
//! configs and secrets never reach it. The negative test wires a writable
//! SecretStore, sets a provider config with a UNIQUE sentinel API key, then
//! scans every byte of the resulting container (NDJSON sections + manifest)
//! and asserts the sentinel is absent — the archive is a pure allowlist.

use contracts_generated::generated::{
    CharacterDto, ChatDto, MessageDto, ProviderConfigDto, ResultProfileExport,
};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

/// Unique marker that MUST never appear in any export artifact.
const SENTINEL: &str = "sk-super-secret-sentinel-9f3a";

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

/// Recursively reads every file under `dir` as one byte string.
fn read_all_bytes(dir: &Path) -> Vec<u8> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).expect("container dir must exist") {
        let entry = entry.expect("entry");
        let path = entry.path();
        if path.is_dir() {
            all.extend(read_all_bytes(&path));
        } else {
            let mut bytes = Vec::new();
            std::fs::File::open(&path)
                .expect("file must open")
                .read_to_end(&mut bytes)
                .expect("file must read");
            all.extend(bytes);
        }
    }
    all
}

#[test]
fn profile_export_is_an_allowlist_and_never_carries_secrets() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // Product data: one character, one chat, two messages.
    let character = dispatch_decoded::<CharacterDto>(
        &kernel,
        "characters.create",
        json!({ "name": "Aria", "description": "A wandering bard" }),
    )
    .expect("character must be created");
    let chat = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        json!({ "characterId": character.id }),
    )
    .expect("chat must be created");
    for (role, content) in [("user", "Hello"), ("assistant", "Greetings, traveler.")] {
        dispatch_decoded::<MessageDto>(
            &kernel,
            "chats.messages.create",
            json!({ "chatId": chat.id, "role": role, "content": content }),
        )
        .expect("message must be created");
    }

    // A secret enters the system through the SecretStore seam, NOT the DB:
    // set a provider config with the sentinel API key.
    let store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let set = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "apiKey": SENTINEL }),
    )
    .expect("set with a wired store must succeed");
    assert!(set.has_api_key, "the config row reports a stored key");
    // Fail-closed proof: the wire response never echoes the value.
    let raw = dispatch_json(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("get must succeed");
    assert!(
        !raw.to_string().contains(SENTINEL),
        "get must never echo the key"
    );

    // Export the profile (data-only) and read the whole container.
    let result = dispatch_decoded::<ResultProfileExport>(
        &kernel,
        "profile.export",
        json!({ "includeAssets": false }),
    )
    .expect("profile.export must succeed");

    assert_eq!(result.records.characters, 1);
    assert_eq!(result.records.chats, 1);
    assert_eq!(result.records.messages, 2);
    assert_eq!(result.records.lorebooks, 0);
    assert_eq!(result.records.presets, 0);
    assert_eq!(result.assets, 0, "data-only export carries no asset bytes");
    assert!(result.size_bytes > 0);
    assert_eq!(result.manifest_sha256.len(), 64, "sha256 hex");

    let container = root.path().join(&result.container_path);
    assert!(container.join("manifest.json").is_file(), "manifest exists");
    assert!(container.join("characters.ndjson").is_file());
    let manifest_text =
        std::fs::read_to_string(container.join("manifest.json")).expect("manifest read");
    assert!(
        manifest_text.contains("neotavern-export"),
        "manifest carries the format id"
    );

    // SEC-02 negative proof: the sentinel is absent from EVERY byte of the
    // archive — product sections AND manifest. Provider configs are not an
    // export section by construction.
    let all = read_all_bytes(&container);
    let haystack = String::from_utf8_lossy(&all);
    assert!(
        !haystack.contains(SENTINEL),
        "sentinel secret must never reach the export container"
    );
    assert!(
        !haystack.contains("provider_configs"),
        "provider config table must not be an export section"
    );
    assert!(
        !haystack.contains("secret_ref"),
        "opaque secret references must not leak either"
    );

    // The export is a fresh container per call (non-idempotent): a second
    // call yields a different path and the same record counts.
    let again = dispatch_decoded::<ResultProfileExport>(
        &kernel,
        "profile.export",
        json!({ "includeAssets": false }),
    )
    .expect("second export must succeed");
    assert_ne!(again.container_path, result.container_path);
    assert_eq!(again.records, result.records);
}
