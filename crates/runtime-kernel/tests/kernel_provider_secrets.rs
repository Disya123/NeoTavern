//! Named provider secrets + provider source catalog through the kernel
//! (M7 Etap-4 cluster 7, ТЗ §9.4/SEC-01).
//!
//! Proves the canonical multi-key manager: several labelled keys per provider
//! config with exactly one ACTIVE key, the value-free DTOs (list/update report
//! a mask derived from the OPAQUE REFERENCE, never the key), the fail-closed
//! exposure gate around the single reveal operation, the storage-level
//! one-active invariant, the cascade revocation on config delete, and that
//! generation resolves the ACTIVE named key rather than the config-level one.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use contracts_generated::generated::{
    ProviderConfigDto, ProviderSecretDto, ResultEmpty, ResultProviderCatalog,
    ResultProviderSecretCreated, ResultProviderSecretReveal, ResultProviderSecrets,
    ResultSecretsExposure,
};
use provider_sdk::secret::{SecretRef, SecretResolver, SecretValue};
use provider_sdk::ProviderError;
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, StreamNotice};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;
use serde_json::{json, Value};

const CONFIG_ID_SENTINEL: &str = "00000000-0000-4000-8000-0000000000ee";

/// Resolver that hands back the reference itself, so a captured provider
/// request reveals WHICH stored reference the kernel resolved (the ref string
/// encodes namespace and id).
struct RefEchoResolver;

impl SecretResolver for RefEchoResolver {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ProviderError> {
        Ok(SecretValue::new(reference.0.clone()))
    }
}

/// A single-shot raw-TCP mock of an OpenAI-compatible chat-completions
/// endpoint; captures the request for assertions.
struct MockEndpoint {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    captured: Arc<std::sync::Mutex<Option<String>>>,
}

impl MockEndpoint {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock binds");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let captured = Arc::new(std::sync::Mutex::new(None));
        let captured_clone = Arc::clone(&captured);
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    *captured_clone.lock().expect("lock") = Some(read_request(&mut stream));
                    let body = format!(
                        "data: {}\n\ndata: [DONE]\n\n",
                        r#"{"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}"#
                    );
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    return;
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if shutdown_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        });
        Self {
            addr,
            shutdown,
            captured,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn captured_request(&self) -> String {
        self.captured
            .lock()
            .expect("lock")
            .clone()
            .unwrap_or_default()
    }
}

impl Drop for MockEndpoint {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).expect("head read") == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head_text = String::from_utf8_lossy(&head).to_string();
    let content_length: usize = head_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        stream.read_exact(&mut body).expect("body read");
    }
    format!("{head_text}{}", String::from_utf8_lossy(&body))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

fn dispatch_json(kernel: &Kernel, op: &str, request: Value) -> Result<Value, KernelError> {
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
) -> Result<T, KernelError> {
    dispatch_json(kernel, op, request).map(|value| {
        serde_json::from_value(value).expect("response must decode as the expected DTO")
    })
}

/// Creates a `fake`-kind provider config and returns its id.
fn create_config(kernel: &Kernel) -> String {
    dispatch_decoded::<ProviderConfigDto>(
        kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "local", "config": { "model": "mock-1" } }),
    )
    .expect("config set must succeed")
    .id
}

/// Product error code of a failed dispatch (panics for non-product errors).
fn product_code(err: &KernelError) -> String {
    err.product
        .as_ref()
        .expect("expected a product error")
        .code
        .clone()
}

fn seed_chat(root: &std::path::Path) {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    let mut db = neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("fresh data root must open");
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
             VALUES ('00000000-0000-4000-8000-000000000002', 'Aria', NULL, NULL, '[]', '{}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            [],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
             VALUES ('00000000-0000-4000-8000-000000000001', 'Secrets test', '00000000-0000-4000-8000-000000000002', '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            [],
        )
        .expect("seed chat");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
}

fn drain_until_terminal(stream: &mut runtime_kernel::EventStream) {
    loop {
        match stream.next_notice(Duration::from_secs(30)) {
            Some(StreamNotice::Committed { .. }) => {}
            Some(StreamNotice::Terminal { .. }) => return,
            None => panic!("stream ended without a terminal notice"),
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// The catalog is stateless (a kernel without a data root answers it) and lists
/// only sources the kernel can materialize into an adapter.
#[test]
fn catalog_is_stateless_and_lists_materializable_sources() {
    let kernel = Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: None,
    })
    .expect("stateless kernel opens");

    let catalog =
        dispatch_decoded::<ResultProviderCatalog>(&kernel, "providers.catalog", json!({}))
            .expect("catalog must succeed without storage");
    let ids: Vec<&str> = catalog.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, vec!["openai", "openai-compatible", "fake"]);

    let openai = &catalog.items[0];
    assert_eq!(openai.adapter_kind, "openai");
    assert_eq!(
        openai.default_base_url.as_deref(),
        Some("https://api.openai.com/v1")
    );
    assert!(openai.api_key_required);
    assert!(openai.base_url_editable);
    // No sampler knobs exist in the kernel adapter contract yet — an empty
    // list is the honest answer (the UI hides what cannot be sent).
    assert!(openai.sampler_support.is_empty());

    let compatible = &catalog.items[1];
    assert_eq!(compatible.adapter_kind, "openai-compatible");
    assert!(compatible.default_base_url.is_none());
    assert!(!compatible.api_key_required);
    assert!(compatible.base_url_editable);

    let fake = &catalog.items[2];
    assert_eq!(fake.adapter_kind, "fake");
    assert!(!fake.api_key_required);
    assert!(!fake.base_url_editable);

    // Strict empty request: unknown fields are rejected.
    let err = dispatch_json(&kernel, "providers.catalog", json!({ "extra": true }))
        .expect_err("catalog must reject unknown request fields");
    assert!(
        err.product.is_none(),
        "a contract violation, not a product error"
    );
}

// ---------------------------------------------------------------------------
// Named secrets CRUD + the one-active invariant
// ---------------------------------------------------------------------------

#[test]
fn named_secrets_crud_keeps_one_active_key_and_never_carries_values() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let config_id = create_config(&kernel);

    // Nothing stored yet.
    let empty = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("empty list");
    assert!(empty.items.is_empty());

    // First key becomes active automatically (legacy parity).
    let first_value = "sk-first-sentinel-AAAA";
    let created = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": first_value, "label": "primary" }),
    )
    .expect("create first");
    let first_id = created.id.clone();
    assert!(store
        .has(&format!("provider-secret:{config_id}"), &first_id)
        .expect("store has"));

    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list after create");
    assert_eq!(listed.items.len(), 1);
    let first = &listed.items[0];
    assert_eq!(first.id, first_id);
    assert_eq!(first.provider_id, config_id);
    assert_eq!(first.label.as_deref(), Some("primary"));
    assert!(first.active);
    // The mask is derived from the OPAQUE REFERENCE: bullets plus its tail,
    // never the key.
    assert!(first.masked.starts_with('•'), "masked: {:?}", first.masked);
    assert!(!first.masked.contains(first_value));
    let dto_json = serde_json::to_string(&listed).expect("serialize list");
    assert!(
        !dto_json.contains(first_value),
        "the list DTO must never carry a secret value"
    );

    // Second key becomes active; the first one steps down.
    let second_value = "sk-second-sentinel-BBBB";
    let second_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": second_value, "label": "backup" }),
    )
    .expect("create second")
    .id;
    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list two");
    assert_eq!(listed.items.len(), 2);
    assert_eq!(listed.items[0].id, second_id, "active key lists first");
    assert!(listed.items[0].active);
    assert!(!listed.items[1].active, "the older key is inactive");

    // Re-activating the older key atomically deactivates its sibling.
    let reactivated = dispatch_decoded::<ProviderSecretDto>(
        &kernel,
        "providers.secrets.update",
        json!({ "providerId": config_id, "secretId": first_id, "active": true }),
    )
    .expect("activate first");
    assert!(reactivated.active);
    assert_eq!(reactivated.label.as_deref(), Some("primary"));
    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list after reactivate");
    assert_eq!(listed.items[0].id, first_id);
    assert!(listed.items[0].active);
    assert!(!listed.items[1].active);

    // Renaming; an empty label clears it.
    let renamed = dispatch_decoded::<ProviderSecretDto>(
        &kernel,
        "providers.secrets.update",
        json!({ "providerId": config_id, "secretId": first_id, "label": "  " }),
    )
    .expect("clear label");
    assert!(renamed.label.is_none(), "blank label clears the field");

    // Deleting the ACTIVE key reactivates the most recent remaining key.
    let deleted = dispatch_decoded::<ResultEmpty>(
        &kernel,
        "providers.secrets.delete",
        json!({ "providerId": config_id, "secretId": first_id }),
    )
    .expect("delete active");
    assert_eq!(deleted, ResultEmpty {});
    assert!(
        !store
            .has(&format!("provider-secret:{config_id}"), &first_id)
            .expect("store has"),
        "deleting the row revokes the stored value"
    );
    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list after delete");
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, second_id);
    assert!(listed.items[0].active, "the remaining key is reactivated");
}

#[test]
fn delete_deactivates_without_reactivation_when_keys_remain_inactive() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let config_id = create_config(&kernel);

    let first_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": "sk-one" }),
    )
    .expect("create first")
    .id;
    let second_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": "sk-two" }),
    )
    .expect("create second")
    .id;
    // Manually deactivate (the update API also allows active:false).
    dispatch_decoded::<ProviderSecretDto>(
        &kernel,
        "providers.secrets.update",
        json!({ "providerId": config_id, "secretId": second_id, "active": false }),
    )
    .expect("deactivate second");
    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list");
    assert!(
        listed.items.iter().all(|item| !item.active),
        "no key is active after explicit deactivation"
    );

    // Deleting an inactive key leaves the others untouched.
    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "providers.secrets.delete",
        json!({ "providerId": config_id, "secretId": first_id }),
    )
    .expect("delete inactive");
    let listed = dispatch_decoded::<ResultProviderSecrets>(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect("list after delete");
    assert_eq!(listed.items.len(), 1);
    assert!(!listed.items[0].active);
}

// ---------------------------------------------------------------------------
// Exposure gate around reveal
// ---------------------------------------------------------------------------

#[test]
fn reveal_fails_closed_until_the_host_enables_exposure() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let config_id = create_config(&kernel);
    let value = "sk-reveal-sentinel-CCCC";
    let secret_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": value }),
    )
    .expect("create")
    .id;

    // Default policy: OFF.
    let exposure =
        dispatch_decoded::<ResultSecretsExposure>(&kernel, "secrets.exposure", json!({}))
            .expect("exposure must answer");
    assert!(!exposure.allow_secrets_exposure);

    let err = dispatch_json(
        &kernel,
        "providers.secrets.reveal",
        json!({ "providerId": config_id, "secretId": secret_id }),
    )
    .expect_err("reveal must fail closed with the policy off");
    assert_eq!(product_code(&err), "SECRETS_EXPOSURE_DISABLED");
    assert!(
        !err.message.contains(value),
        "the error must never carry the value"
    );

    // The host opts in (legacy NEOTA_ALLOW_SECRETS_EXPOSURE parity).
    kernel.set_secrets_exposure(true);
    let exposure =
        dispatch_decoded::<ResultSecretsExposure>(&kernel, "secrets.exposure", json!({}))
            .expect("exposure must answer");
    assert!(exposure.allow_secrets_exposure);

    let revealed = dispatch_decoded::<ResultProviderSecretReveal>(
        &kernel,
        "providers.secrets.reveal",
        json!({ "providerId": config_id, "secretId": secret_id }),
    )
    .expect("reveal must succeed with the policy on");
    assert_eq!(revealed.value, value);

    // Revealing an unknown secret is a 404-parity product error.
    let err = dispatch_json(
        &kernel,
        "providers.secrets.reveal",
        json!({ "providerId": config_id, "secretId": "00000000-0000-4000-8000-0000000000ff" }),
    )
    .expect_err("unknown secret must fail");
    assert_eq!(product_code(&err), "PROVIDER_SECRET_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Fail-closed boundaries and cascade revocation
// ---------------------------------------------------------------------------

#[test]
fn secrets_ops_fail_closed_and_scope_to_their_config() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // No SecretStore seam: create fails closed, nothing is written.
    let err = dispatch_json(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": CONFIG_ID_SENTINEL, "value": "sk-nope" }),
    )
    .expect_err("create without a store must fail");
    assert_eq!(product_code(&err), "SECRET_UNAVAILABLE");

    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    // With a store but an unknown provider config.
    let err = dispatch_json(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": CONFIG_ID_SENTINEL, "value": "sk-nope" }),
    )
    .expect_err("create for a missing config must fail");
    assert_eq!(product_code(&err), "PROVIDER_CONFIG_NOT_FOUND");

    let config_id = create_config(&kernel);
    let err = dispatch_json(
        &kernel,
        "providers.secrets.update",
        json!({
            "providerId": config_id,
            "secretId": "00000000-0000-4000-8000-0000000000ff",
            "active": true
        }),
    )
    .expect_err("updating a missing secret must fail");
    assert_eq!(product_code(&err), "PROVIDER_SECRET_NOT_FOUND");

    let err = dispatch_json(
        &kernel,
        "providers.secrets.delete",
        json!({
            "providerId": config_id,
            "secretId": "00000000-0000-4000-8000-0000000000ff"
        }),
    )
    .expect_err("deleting a missing secret must fail");
    assert_eq!(product_code(&err), "PROVIDER_SECRET_NOT_FOUND");

    // A secret of one config is invisible through another config's address.
    let secret_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": "sk-scoped" }),
    )
    .expect("create")
    .id;
    let other_id = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({ "provider": "fake", "name": "other" }),
    )
    .expect("second config")
    .id;
    let err = dispatch_json(
        &kernel,
        "providers.secrets.delete",
        json!({ "providerId": other_id, "secretId": secret_id }),
    )
    .expect_err("cross-config address must not resolve");
    assert_eq!(product_code(&err), "PROVIDER_SECRET_NOT_FOUND");
    assert!(
        store
            .has(&format!("provider-secret:{config_id}"), &secret_id)
            .expect("store has"),
        "the untouched secret keeps its value"
    );

    // Deleting the config revokes every named store value (cascade parity).
    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "providers.config.delete",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("config delete");
    assert!(
        !store
            .has(&format!("provider-secret:{config_id}"), &secret_id)
            .expect("store has"),
        "config delete must revoke the named key value"
    );
    let err = dispatch_json(
        &kernel,
        "providers.secrets.list",
        json!({ "providerId": config_id }),
    )
    .expect_err("listing after the config delete must 404");
    assert_eq!(product_code(&err), "PROVIDER_CONFIG_NOT_FOUND");
}

#[test]
fn config_has_api_key_tracks_the_active_named_secret() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());
    let config_id = create_config(&kernel);

    let config = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("config get");
    assert!(!config.has_api_key, "no key yet");

    let secret_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": "sk-active" }),
    )
    .expect("create")
    .id;
    let config = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("config get");
    assert!(
        config.has_api_key,
        "an active named key makes hasApiKey true"
    );

    // A deactivated key no longer counts.
    dispatch_decoded::<ProviderSecretDto>(
        &kernel,
        "providers.secrets.update",
        json!({ "providerId": config_id, "secretId": secret_id, "active": false }),
    )
    .expect("deactivate");
    let config = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.get",
        json!({ "provider": "fake", "name": "local" }),
    )
    .expect("config get");
    assert!(
        !config.has_api_key,
        "only an ACTIVE key counts as hasApiKey"
    );
}

// ---------------------------------------------------------------------------
// Generation resolves the ACTIVE named key
// ---------------------------------------------------------------------------

#[test]
fn generation_prefers_the_active_named_secret_over_the_config_key() {
    let endpoint = MockEndpoint::spawn();
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat(root.path());
    let kernel = open_kernel(root.path());
    kernel.set_secret_resolver(Arc::new(RefEchoResolver));
    let store = Arc::new(MemorySecretStore::new());
    kernel.set_secret_store(store.clone());

    // A config-level key (the single-key path) …
    let config_id = dispatch_decoded::<ProviderConfigDto>(
        &kernel,
        "providers.config.set",
        json!({
            "provider": "openai",
            "name": "local",
            "config": { "baseUrl": endpoint.base_url(), "model": "mock-1" },
            "apiKey": "sk-config-level",
        }),
    )
    .expect("config set with a key")
    .id;
    // … and an ACTIVE named key that must win.
    let secret_id = dispatch_decoded::<ResultProviderSecretCreated>(
        &kernel,
        "providers.secrets.create",
        json!({ "providerId": config_id, "value": "sk-named-active" }),
    )
    .expect("create named key")
    .id;

    let flag = CancellationFlag::new();
    let mut stream = kernel
        .dispatch_stream(
            "generation.start",
            &serde_json::to_vec(&json!({
                "chatId": "00000000-0000-4000-8000-000000000001",
                "message": "Hello",
                "provider": "openai",
                "model": "mock-1"
            }))
            .expect("serialize"),
            &flag,
        )
        .expect("generation.start must succeed");
    drain_until_terminal(&mut stream);

    let request = endpoint.captured_request();
    let expected_ref = format!("session:provider-secret:{config_id}:{secret_id}");
    assert!(
        request.contains(&format!("Authorization: Bearer {expected_ref}")),
        "the ACTIVE named key must be resolved; captured request:\n{request}"
    );
    assert!(
        !request.contains("session:provider:openai:local"),
        "the config-level key must not be used while an active named key exists"
    );
}
