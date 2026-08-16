//! NeoTavern runtime kernel — Phase 6: generation durability.
//!
//! A transport-free, in-process dispatcher over the product wire contract
//! (see `packages/contracts/src/wire`). The kernel validates its embedded
//! contract manifest at open time, decodes request payloads through the
//! generated DTO checkers, and returns serialized DTO bytes.
//!
//! The crate is deliberately std-only: no tokio, no HTTP, no platform I/O.
//! Transport lives in the facade layer (`packages/neobackend`).
//!
//! # Writer coordination (ТЗ §22)
//!
//! [`Kernel::open`] spawns ONE dedicated writer thread that owns the
//! [`Database`](neotavern_storage::open::Database). The [`Kernel`] handle
//! only holds command channels, the cached contract meta and open-time
//! storage diagnostics, so it is `Send + Sync`. Every operation — unary or
//! stream — is executed on the writer thread, which is the single writer of
//! the data root. A stream (generation executor) runs inline on the writer
//! thread and drains pending commands between provider steps, so unary
//! operations (including `generation.cancel`) stay serviced mid-generation.

use contracts_generated::generated::{self, MetaDto, MetaDtoApi, MetaDtoProductWire};
use contracts_generated::{Issue, WireError};
use provider_sdk::secret::SecretResolver;
use provider_sdk::ProviderAdapter;
use secret_store::SecretStore;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

pub mod assets;
pub mod backup;
pub mod data;
pub mod export;
pub mod exports;
pub mod generation;
pub mod headless;
pub mod imports;
pub mod local;
pub mod plugins;
pub mod product;
pub mod profiles;
pub mod prompt;
pub mod providers;
pub mod providers_config;
pub mod secrets;
pub mod settings;
mod starter;
pub mod themes;
pub mod tools;

/// FFI ABI version this kernel implements. Must match the embedded manifest's
/// `ffiAbiVersion` (see `contracts_generated::contract_schema_hash`).
pub const FFI_ABI_VERSION: u32 = 1;

/// Product hosts set this to `1` before [`Kernel::open`] so the writer
/// thread seeds the bundled Hazel / Vesper pack once per data root.
/// Kernel unit tests leave it unset so they keep an empty library.
pub const SEED_STARTER_ENV: &str = "NEOTA_SEED_STARTER";

/// Cancellation token threaded through every dispatch.
///
/// Cheap to clone; clones share the underlying flag, so cancelling one clone
/// is observed by every other clone.
#[derive(Debug, Clone)]
pub struct CancellationFlag(Arc<AtomicBool>);

impl CancellationFlag {
    /// Creates a fresh, non-cancelled flag.
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    /// Marks the flag as cancelled. In-flight dispatches observe this on their
    /// next cancellation check.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Returns `true` once [`cancel`](Self::cancel) has been called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

impl Default for CancellationFlag {
    fn default() -> Self {
        Self::new()
    }
}

/// Kernel error codes, mirroring the wire error model
/// (`INTERNAL`, `CONTRACT_VIOLATION`, `CANCELLED`, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelErrorCode {
    /// The caller's contract expectations do not match the embedded manifest.
    ContractMismatch,
    /// A payload failed the generated DTO checker.
    ContractViolation,
    /// The requested operation id is not registered.
    OperationNotFound,
    /// The caller is not authorized for the operation (unused in Phase 1).
    Unauthorized,
    /// An unexpected internal failure.
    Internal,
    /// The operation was cancelled before execution.
    Cancelled,
    /// The data root is already held by another live process (ТЗ §22).
    DataRootInUse,
    /// A storage-layer failure (SQLite, migrations, integrity).
    StorageFailure,
    /// A product record was not found (wire product code `*_NOT_FOUND`, e.g.
    /// `CHARACTER_NOT_FOUND`).
    NotFound,
    /// A product state conflict (wire product code `*_CONFLICT`).
    Conflict,
    /// A provider-level failure. The wire-code mapping
    /// (`PROVIDER_ERROR`) lives in the transport adapter; the kernel only
    /// defines the class so the mapping table has a source code.
    ProviderError,
}

impl std::fmt::Display for KernelErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            KernelErrorCode::ContractMismatch => "contract-mismatch",
            KernelErrorCode::ContractViolation => "contract-violation",
            KernelErrorCode::OperationNotFound => "operation-not-found",
            KernelErrorCode::Unauthorized => "unauthorized",
            KernelErrorCode::Internal => "internal",
            KernelErrorCode::Cancelled => "cancelled",
            KernelErrorCode::DataRootInUse => "data-root-in-use",
            KernelErrorCode::StorageFailure => "storage-failure",
            KernelErrorCode::NotFound => "not-found",
            KernelErrorCode::Conflict => "conflict",
            KernelErrorCode::ProviderError => "provider-error",
        };
        f.write_str(text)
    }
}

impl std::error::Error for KernelErrorCode {}

/// Error surfaced by [`Kernel`] dispatch.
#[derive(Debug, Clone, PartialEq)]
pub struct KernelError {
    /// The error class.
    pub code: KernelErrorCode,
    /// Human-readable detail.
    pub message: String,
    /// Per-path violations from the generated checkers (empty unless
    /// [`KernelErrorCode::ContractViolation`]).
    pub issues: Vec<Issue>,
    /// Diagnostic `(key, value)` parameters (host diagnostics; not part of
    /// the wire product error unless [`Self::product`] is set).
    pub params: Vec<(String, String)>,
    /// Wire product error payload when the failure is product-level (e.g.
    /// `CHARACTER_NOT_FOUND`); the host glue copies this DTO into the
    /// response envelope verbatim.
    ///
    /// Boxed to keep [`KernelError`] under clippy's 128-byte
    /// `result_large_err` threshold (the DTO is ~104 bytes); deref makes the
    /// box transparent at use sites.
    pub product: Option<Box<generated::ProductErrorDto>>,
}

impl KernelError {
    fn new(code: KernelErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            issues: Vec::new(),
            params: Vec::new(),
            product: None,
        }
    }

    /// Creates an error with diagnostic `(key, value)` parameters.
    pub fn with_params(
        code: KernelErrorCode,
        message: impl Into<String>,
        params: Vec<(String, String)>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            issues: Vec::new(),
            params,
            product: None,
        }
    }

    /// Builds a product-level error carrying the wire
    /// [`generated::ProductErrorDto`].
    ///
    /// The kernel-level class is derived from the stable wire code:
    /// `*_NOT_FOUND` codes map to [`KernelErrorCode::NotFound`], `*_CONFLICT`
    /// codes to [`KernelErrorCode::Conflict`], `PROVIDER_*` codes to
    /// [`KernelErrorCode::ProviderError`], and every other product code to
    /// [`KernelErrorCode::Conflict`].
    pub fn product(code: impl Into<String>, params: Vec<(String, String)>) -> Self {
        let code = code.into();
        let kernel_code = if code.ends_with("_NOT_FOUND") {
            KernelErrorCode::NotFound
        } else if code.starts_with("PROVIDER_") {
            KernelErrorCode::ProviderError
        } else {
            KernelErrorCode::Conflict
        };
        let params_value = serde_json::Value::Object(
            params
                .into_iter()
                .map(|(key, value)| (key, serde_json::Value::String(value)))
                .collect(),
        );
        Self {
            code: kernel_code,
            message: format!("product error {code}"),
            issues: Vec::new(),
            params: Vec::new(),
            product: Some(Box::new(generated::ProductErrorDto {
                code,
                params: params_value,
                trace_id: None,
                correlation_id: None,
            })),
        }
    }
}

impl From<WireError> for KernelError {
    /// Payload decode failures are always contract violations, never panics.
    fn from(wire: WireError) -> Self {
        Self {
            code: KernelErrorCode::ContractViolation,
            message: wire.message,
            issues: wire.issues,
            params: Vec::new(),
            product: None,
        }
    }
}

impl From<neotavern_storage::StorageError> for KernelError {
    /// Storage failures surface as kernel errors with the stable storage code
    /// preserved; the data-root lease conflict keeps its dedicated code
    /// (ТЗ §22: controlled `data_root_in_use`).
    fn from(err: neotavern_storage::StorageError) -> Self {
        let code = match err.code {
            neotavern_storage::StorageErrorCode::DataRootInUse => KernelErrorCode::DataRootInUse,
            _ => KernelErrorCode::StorageFailure,
        };
        KernelError::new(code, format!("storage {:?}: {}", err.code, err.message))
    }
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "kernel error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for KernelError {}

/// Configuration required to open a [`Kernel`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelConfig {
    /// The schema hash the caller expects the embedded contract manifest to
    /// carry. Must equal `contracts_generated::contract_schema_hash()`.
    pub expected_schema_hash: String,
    /// FFI ABI version the caller expects; must equal [`FFI_ABI_VERSION`].
    pub ffi_abi_version: u32,
    /// Optional local data root. `None` keeps the kernel stateless
    /// (in-memory test harness). When set, the kernel acquires the exclusive
    /// data-root lease and opens SQLite through the storage crate (ТЗ §22/31);
    /// the writer thread holds the single writable connection for its
    /// lifetime.
    pub data_root: Option<std::path::PathBuf>,
}

/// A notice delivered to a stream consumer by [`EventStream::next_notice`].
///
/// Notices are an optimization over polling `generation.events`: the durable
/// event log is the canonical source of truth, so a dropped notice is never
/// a correctness problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamNotice {
    /// The generation executor durably committed every event with sequence
    /// `<= through_sequence` for the run.
    Committed { through_sequence: i64 },
    /// The run reached a terminal state; `last_sequence` is the sequence of
    /// the terminal event (the final event in the run's durable log).
    Terminal { last_sequence: i64 },
}

/// A live generation stream returned by [`Kernel::dispatch_stream`].
///
/// The consumer polls [`next_notice`](Self::next_notice) and replays the
/// durable `generation.events` log for the run (the run id is
/// [`stream_id`](Self::stream_id)). The underlying executor runs on the
/// kernel's writer thread and keeps producing even if this handle is dropped
/// — the run is durable and recoverable.
#[derive(Debug)]
pub struct EventStream {
    rx: mpsc::Receiver<StreamNotice>,
    stream_id: String,
}

impl EventStream {
    /// The run id this stream is generating (== the `streamId` of every
    /// event envelope in the run's durable log).
    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    /// Waits up to `timeout` for the next notice.
    ///
    /// Returns `None` on timeout **or** when the stream has ended (the
    /// executor finished and the notice channel closed). Consumers should
    /// poll `generation.events` after a timeout and treat a terminal event
    /// type as the end of the stream.
    pub fn next_notice(&mut self, timeout: Duration) -> Option<StreamNotice> {
        self.rx.recv_timeout(timeout).ok()
    }
}

/// One command sent to the kernel's writer thread. All replies are
/// rendezvous-style `sync_channel(1)` pairs owned by the caller.
enum Command {
    /// A unary operation: execute and reply with the serialized response.
    Unary {
        op: String,
        req: Vec<u8>,
        cancel: CancellationFlag,
        reply: mpsc::SyncSender<Result<Vec<u8>, KernelError>>,
    },
    /// A stream operation (`generation.start` / `generation.retry`): create
    /// the run, reply with the notice channel, then run the executor inline.
    Stream {
        op: String,
        req: Vec<u8>,
        cancel: CancellationFlag,
        reply: mpsc::SyncSender<Result<StreamStart, KernelError>>,
    },
    /// Sets the host-provided secret-resolution seam (ТЗ §68). Applied
    /// immediately (even mid-generation, at the next step boundary) and
    /// acknowledged.
    SetSecretResolver {
        resolver: Arc<dyn SecretResolver>,
        reply: mpsc::SyncSender<()>,
    },
    /// Sets the host-provided writable SecretStore seam (ТЗ §9.4, §SEC-01).
    /// Used by the provider-config operations to store API keys; only the
    /// opaque reference lands in `provider_configs`. Applied immediately and
    /// acknowledged.
    SetSecretStore {
        store: Arc<dyn SecretStore>,
        reply: mpsc::SyncSender<()>,
    },
    /// Registers a runtime provider adapter (e.g. an OpenAI-compatible
    /// instance built from a stored provider config, ТЗ §9.3). Applied
    /// immediately and acknowledged.
    RegisterProvider {
        adapter: Arc<dyn ProviderAdapter>,
        reply: mpsc::SyncSender<()>,
    },
    /// Registers a tool contract (wire `wire.tool.spec`, ТЗ §8.3): the
    /// kernel validates provider tool calls against it and durably waits for
    /// the host-submitted result; it never executes tools itself. Applied
    /// immediately and acknowledged.
    RegisterTool {
        spec: generated::ToolSpec,
        reply: mpsc::SyncSender<()>,
    },
    /// Sets the per-run provider deadline for future generations (default
    /// [`generation::RUN_TIMEOUT`]). Applied immediately and acknowledged.
    SetRunTimeout {
        timeout: Duration,
        reply: mpsc::SyncSender<()>,
    },
    /// Offline restore (ТЗ §10.4, М5 slice 39): the writer closes the
    /// database + lease, restores the verified backup container over the
    /// active root and re-opens the database, replying with the serialized
    /// `backups.restore` result. Runs only in the main writer loop (it takes
    /// the [`Database`] by value); when queued from inside a generation it
    /// waits for the executor to finish, like stream commands.
    Restore {
        req: Vec<u8>,
        reply: mpsc::SyncSender<Result<Vec<u8>, KernelError>>,
    },
    /// Orderly shutdown: stop the writer loop (mid-generation this sets a
    /// stop flag observed at the executor's next step boundary) and ack.
    Shutdown { reply: mpsc::SyncSender<()> },
}

/// The reply payload of a [`Command::Stream`]: the run id and the consumer's
/// end of the notice channel.
struct StreamStart {
    stream_id: String,
    notices: mpsc::Receiver<StreamNotice>,
}

/// The runtime kernel: contract-validated dispatch over optional durable
/// storage. The kernel is the single writer of its data root while it lives.
///
/// The kernel is a cheap `Send + Sync` handle: a command channel to the
/// dedicated writer thread (which owns the
/// [`Database`](neotavern_storage::open::Database)) plus cached contract
/// meta and open-time storage diagnostics. Dropping the kernel sends an
/// orderly shutdown command and joins the writer thread.
#[derive(Debug)]
pub struct Kernel {
    cmd_tx: mpsc::Sender<Command>,
    meta: MetaDto,
    has_storage: bool,
    storage_diagnostics: Option<StorageDiagnostics>,
    writer: Option<std::thread::JoinHandle<()>>,
}

/// Storage-layer version report for diagnostics and recovery mode (cached at
/// open time — the writer thread owns the connection afterwards).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageDiagnostics {
    /// `storageFormat` from the database metadata (ТЗ §28).
    pub storage_format: Option<i64>,
    /// `schemaRevision` (`PRAGMA user_version`, ТЗ §29/30).
    pub schema_revision: Option<i64>,
    /// The bundled SQLite library version (ТЗ §23 baseline).
    pub sqlite_version: String,
}

/// Builds the `wire.meta.dto` describing this kernel build.
fn build_meta() -> MetaDto {
    MetaDto {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        // API and product wire protocol are both 1.0 in this phase.
        api: MetaDtoApi { major: 1, minor: 0 },
        product_wire: MetaDtoProductWire { major: 1, minor: 0 },
        minimum_client_version: None,
        features: HashMap::from([("core".to_string(), 1)]),
    }
}

/// Executes `handle_meta_get` against the cached meta.
fn handle_meta_get(meta: &MetaDto, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    // Strict empty request: `{}` exactly, any extra field is a violation.
    generated::decode_empty_request_dto(request)?;
    let value = serde_json::to_value(meta).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("failed to serialize meta response: {err}"),
        )
    })?;
    generated::validate_meta_dto(&value).map_err(|issues| KernelError {
        code: KernelErrorCode::ContractViolation,
        message: "kernel meta dto failed validation".to_string(),
        issues,
        params: Vec::new(),
        product: None,
    })?;
    product::encode(&value)
}

/// Stable product error for a payload that exceeds the declared wire byte
/// limit (`PAYLOAD_TOO_LARGE`).
fn payload_too_large(op: &str, bytes: usize, limit: usize) -> KernelError {
    KernelError::product(
        "PAYLOAD_TOO_LARGE",
        vec![
            ("operationId".to_string(), op.to_string()),
            ("bytes".to_string(), bytes.to_string()),
            ("limit".to_string(), limit.to_string()),
        ],
    )
}

/// Rejects a request whose byte length exceeds the operation's declared
/// wire limit BEFORE any parse (plan rev 2.2 Layer C, вход линия 2 — the
/// transport-agnostic second barrier after the transports' bounded readers).
/// The limits are generated from the registry (`operation_request_limit`),
/// so no hand-written constants can drift.
pub(crate) fn enforce_request_limit(op: &str, req: &[u8]) -> Result<(), KernelError> {
    let limit = generated::operation_request_limit(op)
        .unwrap_or(generated::DEFAULT_REQUEST_LIMIT_BYTES) as usize;
    if req.len() > limit {
        return Err(payload_too_large(op, req.len(), limit));
    }
    Ok(())
}

/// Runs a unary operation against the writer's database (when present).
///
/// Product operations require durable storage: a stateless kernel (no
/// `data_root`) yields [`KernelErrorCode::StorageFailure`]. `meta.get` does
/// not go through this path and stays available stateless.
fn with_db_opt<F>(
    db: Option<&mut neotavern_storage::open::Database>,
    f: F,
) -> Result<Vec<u8>, KernelError>
where
    F: FnOnce(&mut neotavern_storage::open::Database) -> Result<Vec<u8>, KernelError>,
{
    match db {
        Some(db) => f(db),
        None => Err(KernelError::new(
            KernelErrorCode::StorageFailure,
            "operation requires durable storage",
        )),
    }
}

/// Executes one unary operation on the writer thread.
fn handle_unary(
    db: Option<&mut neotavern_storage::open::Database>,
    meta: &MetaDto,
    state: &mut providers::ProviderState,
    op: &str,
    req: &[u8],
    cancel: &CancellationFlag,
    lease_owner: &str,
) -> Result<Vec<u8>, KernelError> {
    if cancel.is_cancelled() {
        return Err(KernelError::new(
            KernelErrorCode::Cancelled,
            "operation cancelled before dispatch",
        ));
    }
    // Вход, линия 2: reject over-limit payloads BEFORE any parse (the
    // transports already bound the read; this covers CLI/FFI/JNI/Tauri).
    enforce_request_limit(op, req)?;
    let result = match op {
        "meta.get" => handle_meta_get(meta, req),
        // Phase 7: stateless provider registry listing (like meta.get — no
        // durable storage required).
        "providers.list" => providers::handle_providers_list(&state.registry, req),
        // Этап 2.7: stateless tool registry listing (declarative contracts).
        "generation.tools.list" => tools::generation_tools_list(&state.tools, req),
        // Phase 3 product CRUD over durable storage.
        "characters.list" => with_db_opt(db, |db| product::characters_list(db, req)),
        "characters.get" => with_db_opt(db, |db| product::characters_get(db, req)),
        "characters.create" => with_db_opt(db, |db| product::characters_create(db, req)),
        "characters.update" => with_db_opt(db, |db| product::characters_update(db, req)),
        "characters.delete" => with_db_opt(db, |db| product::characters_delete(db, req)),
        "chats.list" => with_db_opt(db, |db| product::chats_list(db, req)),
        "chats.get" => with_db_opt(db, |db| product::chats_get(db, req)),
        "chats.create" => with_db_opt(db, |db| product::chats_create(db, req)),
        "chats.update" => with_db_opt(db, |db| product::chats_update(db, req)),
        "chats.delete" => with_db_opt(db, |db| product::chats_delete(db, req)),
        "chats.export" => with_db_opt(db, |db| exports::chats_export(db, req)),
        "chats.messages.list" => with_db_opt(db, |db| product::messages_list(db, req)),
        "chats.messages.create" => with_db_opt(db, |db| product::messages_create(db, req)),
        "chats.messages.update" => with_db_opt(db, |db| product::messages_update(db, req)),
        "chats.messages.delete" => with_db_opt(db, |db| product::messages_delete(db, req)),
        "chats.snapshots.create" => with_db_opt(db, |db| product::chats_snapshots_create(db, req)),
        "chats.snapshots.rollback" => {
            with_db_opt(db, |db| product::chats_snapshots_rollback(db, req))
        }
        "chats.snapshots.list" => with_db_opt(db, |db| product::chats_snapshots_list(db, req)),
        "chats.messages.variants.list" => {
            with_db_opt(db, |db| product::message_variants_list(db, req))
        }
        "chats.messages.variants.create" => {
            with_db_opt(db, |db| product::message_variants_create(db, req))
        }
        "chats.messages.variants.delete" => {
            with_db_opt(db, |db| product::message_variants_delete(db, req))
        }
        "chats.messages.variants.activate" => {
            with_db_opt(db, |db| product::message_variants_activate(db, req))
        }
        "chats.messages.revisions.list" => {
            with_db_opt(db, |db| product::message_revisions_list(db, req))
        }
        "chats.messages.drafts.get" => with_db_opt(db, |db| product::message_drafts_get(db, req)),
        "chats.messages.drafts.save" => with_db_opt(db, |db| product::message_drafts_save(db, req)),
        "chats.messages.drafts.commit" => {
            with_db_opt(db, |db| product::message_drafts_commit(db, req))
        }
        "chats.messages.drafts.discard" => {
            with_db_opt(db, |db| product::message_drafts_discard(db, req))
        }
        "lorebooks.list" => with_db_opt(db, |db| product::lorebooks_list(db, req)),
        "lorebooks.get" => with_db_opt(db, |db| product::lorebooks_get(db, req)),
        "lorebooks.create" => with_db_opt(db, |db| product::lorebooks_create(db, req)),
        "lorebooks.update" => with_db_opt(db, |db| product::lorebooks_update(db, req)),
        "lorebooks.delete" => with_db_opt(db, |db| product::lorebooks_delete(db, req)),
        "lorebooks.entries.list" => with_db_opt(db, |db| product::lorebooks_entries_list(db, req)),
        "lorebooks.entries.create" => {
            with_db_opt(db, |db| product::lorebooks_entries_create(db, req))
        }
        "lorebooks.entries.update" => {
            with_db_opt(db, |db| product::lorebooks_entries_update(db, req))
        }
        "lorebooks.entries.delete" => {
            with_db_opt(db, |db| product::lorebooks_entries_delete(db, req))
        }
        "presets.list" => with_db_opt(db, |db| product::presets_list(db, req)),
        "presets.get" => with_db_opt(db, |db| product::presets_get(db, req)),
        "presets.create" => with_db_opt(db, |db| product::presets_create(db, req)),
        "presets.update" => with_db_opt(db, |db| product::presets_update(db, req)),
        "presets.delete" => with_db_opt(db, |db| product::presets_delete(db, req)),
        "memories.list" => with_db_opt(db, |db| product::memories_list(db, req)),
        "memories.create" => with_db_opt(db, |db| product::memories_create(db, req)),
        "memories.update" => with_db_opt(db, |db| product::memories_update(db, req)),
        "memories.delete" => with_db_opt(db, |db| product::memories_delete(db, req)),
        "personas.list" => with_db_opt(db, |db| product::personas_list(db, req)),
        "personas.get" => with_db_opt(db, |db| product::personas_get(db, req)),
        "personas.create" => with_db_opt(db, |db| product::personas_create(db, req)),
        "personas.update" => with_db_opt(db, |db| product::personas_update(db, req)),
        "personas.delete" => with_db_opt(db, |db| product::personas_delete(db, req)),
        // Provider configuration (ТЗ §9.4): secrets go to the SecretStore
        // seam, only opaque references reach the database. `set` also
        // hydrates the adapter registry (М5 slice 48).
        "providers.config.set" => {
            let store = state.secret_store.clone();
            with_db_opt(db, |db| {
                providers_config::set(db, store.as_ref(), &mut state.registry, req)
            })
        }
        "providers.config.get" => with_db_opt(db, |db| {
            providers_config::get(db, state.secret_store.as_ref(), req)
        }),
        "providers.config.list" => with_db_opt(db, |db| {
            providers_config::list(db, state.secret_store.as_ref(), req)
        }),
        "providers.config.delete" => with_db_opt(db, |db| {
            providers_config::delete(db, state.secret_store.as_ref(), req)
        }),
        // Этап 4 slice 5 remainder: canonical content-addressed AssetStore.
        "assets.put" => with_db_opt(db, |db| assets::assets_put(db, req)),
        "assets.get" => with_db_opt(db, |db| assets::assets_get(db, req)),
        "assets.content" => with_db_opt(db, |db| assets::assets_content(db, req)),
        "assets.delete" => with_db_opt(db, |db| assets::assets_delete(db, req)),
        "imports.character.card" => with_db_opt(db, |db| imports::imports_character_card(db, req)),
        "characters.export.card" => with_db_opt(db, |db| exports::characters_export_card(db, req)),
        // Этап 4 slice 6: canonical Extensions-context registry (SEC-05).
        "plugins.list" => with_db_opt(db, |db| plugins::plugins_list(db, req)),
        "plugins.install" => with_db_opt(db, |db| plugins::plugins_install(db, req)),
        "plugins.uninstall" => with_db_opt(db, |db| plugins::plugins_uninstall(db, req)),
        "plugins.enable" => with_db_opt(db, |db| plugins::plugins_enable(db, req)),
        "plugins.disable" => with_db_opt(db, |db| plugins::plugins_disable(db, req)),
        // Этап 4 slice 6 part 2: canonical Theme-SDK registry (SEC-05).
        "themes.list" => with_db_opt(db, |db| themes::themes_list(db, req)),
        "themes.install" => with_db_opt(db, |db| themes::themes_install(db, req)),
        "themes.uninstall" => with_db_opt(db, |db| themes::themes_uninstall(db, req)),
        "themes.activate" => with_db_opt(db, |db| themes::themes_activate(db, req)),
        "themes.deactivate" => with_db_opt(db, |db| themes::themes_deactivate(db, req)),
        // Этап 4 slice 5 remainder part 2: canonical Configuration
        // profiles (unblocks per-profile SEC-02 export filtering).
        "profiles.list" => with_db_opt(db, |db| profiles::profiles_list(db, req)),
        "profiles.create" => with_db_opt(db, |db| profiles::profiles_create(db, req)),
        "profiles.rename" => with_db_opt(db, |db| profiles::profiles_rename(db, req)),
        "profiles.delete" => with_db_opt(db, |db| profiles::profiles_delete(db, req)),
        // Этап 4 slice 7: canonical non-secret settings + SEC-07 diagnostics.
        "settings.get" => with_db_opt(db, |db| settings::settings_get(db, req)),
        "settings.update" => with_db_opt(db, |db| settings::settings_update(db, req)),
        "diagnostics.export" => with_db_opt(db, |db| settings::diagnostics_export(db, req)),
        // SEC-01.1: value-free secret-backend mode surface (stateless seam).
        "secrets.status" => secrets::secrets_status(state.secret_store.as_ref(), req),
        "secrets.lock" => secrets::secrets_lock(state.secret_store.as_ref(), req),
        // Phase 6 generation operations.
        "generation.cancel" => {
            with_db_opt(db, |db| generation::generation_cancel(db, req, lease_owner))
        }
        "generation.get" => with_db_opt(db, |db| generation::generation_get(db, req)),
        "generation.events" => with_db_opt(db, |db| generation::generation_events(db, req)),
        "generation.keep" => with_db_opt(db, |db| generation::generation_keep(db, req)),
        "generation.discard" => with_db_opt(db, |db| generation::generation_discard(db, req)),
        "generation.prompt.plan" => {
            with_db_opt(db, |db| generation::generation_prompt_plan(db, req))
        }
        // Этап 2.7: submit a tool result and resume a waiting-for-tool run.
        "generation.tool.result" => with_db_opt(db, |db| {
            generation::generation_tool_result(
                db,
                req,
                &state.registry,
                &state.tools,
                state.run_timeout,
                state.secret_resolver.clone(),
                cancel,
                lease_owner,
            )
        }),
        // Phase 11 portable data (ТЗ §40–§41): backup containers.
        "backups.create" => with_db_opt(db, |db| backup::backups_create(db, req)),
        "backups.list" => with_db_opt(db, |db| backup::backups_list(db, req)),
        // Data lifecycle (ТЗ §10.2–§10.3): durable activation status.
        "data.activation.status" => with_db_opt(db, |db| data::data_activation_status(db, req)),
        // Phase 11 / SEC-02: logical allowlist profile export.
        "profile.export" => with_db_opt(db, |db| export::profile_export(db, req)),
        // М5 slice 42: apply a verified profile export container (SEC-02 round trip).
        "profile.import" => with_db_opt(db, |db| export::profile_import(db, req)),
        _ => Err(KernelError::new(
            KernelErrorCode::OperationNotFound,
            format!("unknown operation: {op}"),
        )),
    };
    // Выход, per-op precision layer: the shared encode is already bounded at
    // the registry maximum during serialization; here an op whose declared
    // response limit is smaller is rejected after (bounded) construction.
    match result {
        Ok(bytes) => {
            let limit = generated::operation_response_limit(op)
                .map(|l| l as usize)
                .unwrap_or(generated::DEFAULT_RESPONSE_LIMIT_BYTES as usize);
            if bytes.len() > limit {
                Err(payload_too_large(op, bytes.len(), limit))
            } else {
                Ok(bytes)
            }
        }
        Err(err) => Err(err),
    }
}

/// Drains every command currently queued on the writer channel, executing
/// unary operations inline, queueing stream commands for after the current
/// stream, applying provider-state setters immediately, and acknowledging
/// shutdowns (which set `stop`).
///
/// This runs between provider steps of an inline generation executor, which
/// is how unary operations (notably `generation.cancel`) stay serviced while
/// a generation is running. Returns `true` when a shutdown was observed.
fn drain_pending(
    db: &mut neotavern_storage::open::Database,
    meta: &MetaDto,
    state: &mut providers::ProviderState,
    cmd_rx: &mpsc::Receiver<Command>,
    pending: &mut Vec<Command>,
    stop: &mut bool,
    lease_owner: &str,
) -> bool {
    let mut shutdown = false;
    while let Ok(cmd) = cmd_rx.try_recv() {
        match cmd {
            Command::Unary {
                op,
                req,
                cancel,
                reply,
            } => {
                let result = handle_unary(Some(db), meta, state, &op, &req, &cancel, lease_owner);
                let _ = reply.send(result);
            }
            Command::Stream {
                op,
                req,
                cancel,
                reply,
            } => {
                // At most one stream runs at a time; the rest queue until the
                // current executor reaches a step boundary and finishes.
                pending.push(Command::Stream {
                    op,
                    req,
                    cancel,
                    reply,
                });
            }
            Command::SetSecretResolver { resolver, reply } => {
                state.secret_resolver = Some(resolver);
                let _ = reply.send(());
            }
            Command::SetSecretStore { store, reply } => {
                state.secret_store = Some(store);
                let _ = reply.send(());
            }
            Command::RegisterProvider { adapter, reply } => {
                state.registry.register(adapter);
                let _ = reply.send(());
            }
            Command::RegisterTool { spec, reply } => {
                state.tools.register(spec);
                let _ = reply.send(());
            }
            Command::SetRunTimeout { timeout, reply } => {
                state.run_timeout = timeout;
                let _ = reply.send(());
            }
            Command::Restore { req, reply } => {
                // Restore takes the Database by value; it cannot run inside a
                // generation's step drain. Queue it for the main loop after
                // the current stream finishes (same policy as Stream).
                pending.push(Command::Restore { req, reply });
            }
            Command::Shutdown { reply } => {
                shutdown = true;
                *stop = true;
                let _ = reply.send(());
            }
        }
    }
    shutdown
}

/// The writer thread: owns the [`Database`], runs startup recovery, and
/// executes every command. Stream commands run their executor inline and
/// drain the command channel between provider steps.
fn writer_main(
    mut db: Option<neotavern_storage::open::Database>,
    cmd_rx: mpsc::Receiver<Command>,
    meta: MetaDto,
    lease_owner: String,
) {
    if let Some(db) = &mut db {
        if let Err(err) = generation::recover(db) {
            eprintln!("kernel: startup generation recovery failed: {err}");
        }
    }
    // Phase 7 provider state: the adapter registry plus the host-provided
    // secret-resolution seam and the per-run deadline.
    let mut state = providers::ProviderState::new_builtins();
    // М5 slice 48: hydrate adapters for every stored provider config so a
    // configured production provider (e.g. openai) is generatable right after
    // startup without host-side wiring. Best-effort: a malformed or unknown
    // config is skipped with a diagnostic, never a startup failure.
    if let Some(db) = &db {
        if let Err(err) = providers_config::hydrate(db, &mut state.registry) {
            eprintln!("kernel: provider config hydration failed: {err}");
        }
    }
    // Bundled Hazel / Vesper (same assets as the legacy Fastify pack). The
    // avatar PNG exceeds the wire `assets.put` cap, so seeding runs here on
    // the writer thread — never through dispatch. Best-effort: a failure
    // logs and retries on the next open; it never blocks the kernel.
    if let Some(db) = &mut db {
        starter::seed_if_needed(db);
    }
    let mut stop = false;
    let mut pending: Vec<Command> = Vec::new();
    while !stop {
        let cmd = match pending.first() {
            Some(_) => pending.remove(0),
            None => match cmd_rx.recv() {
                Ok(cmd) => cmd,
                // All senders dropped (e.g. the Kernel was leaked without a
                // Drop): exit and release the data-root lease.
                Err(_) => break,
            },
        };
        match cmd {
            Command::Unary {
                op,
                req,
                cancel,
                reply,
            } => {
                let result = handle_unary(
                    db.as_mut(),
                    &meta,
                    &mut state,
                    &op,
                    &req,
                    &cancel,
                    &lease_owner,
                );
                let _ = reply.send(result);
            }
            Command::Stream {
                op,
                req,
                cancel,
                reply,
            } => {
                let launch = match db.as_mut() {
                    Some(db) => generation::stream_start(db, &op, &req, &lease_owner),
                    None => Err(KernelError::new(
                        KernelErrorCode::StorageFailure,
                        "operation requires durable storage",
                    )),
                };
                match launch {
                    Err(err) => {
                        let _ = reply.send(Err(err));
                    }
                    Ok(launch) => {
                        let _ = reply.send(Ok(StreamStart {
                            stream_id: launch.stream_id.clone(),
                            notices: launch.notice_rx,
                        }));
                        if let Some(db) = db.as_mut() {
                            // Snapshot the provider state for this run: the
                            // deadline, secret seam, adapter registry and
                            // tool registry are fixed at stream start; later
                            // Set*/Register* commands affect the next run.
                            let run_timeout = state.run_timeout;
                            let secret_resolver = state.secret_resolver.clone();
                            let registry = state.registry.clone();
                            let tools = state.tools.clone();
                            let mut drain = |db: &mut neotavern_storage::open::Database| {
                                drain_pending(
                                    db,
                                    &meta,
                                    &mut state,
                                    &cmd_rx,
                                    &mut pending,
                                    &mut stop,
                                    &lease_owner,
                                )
                            };
                            let result = generation::execute_stream(
                                db,
                                &launch.stream_id,
                                &launch.notice_tx,
                                &mut drain,
                                &lease_owner,
                                &registry,
                                run_timeout,
                                secret_resolver,
                                &cancel,
                                &tools,
                            );
                            if let Err(err) = result {
                                eprintln!("kernel: generation executor failed: {err}");
                            }
                        }
                    }
                }
            }
            Command::SetSecretResolver { resolver, reply } => {
                state.secret_resolver = Some(resolver);
                let _ = reply.send(());
            }
            Command::SetSecretStore { store, reply } => {
                state.secret_store = Some(store);
                let _ = reply.send(());
            }
            Command::RegisterProvider { adapter, reply } => {
                state.registry.register(adapter);
                let _ = reply.send(());
            }
            Command::RegisterTool { spec, reply } => {
                state.tools.register(spec);
                let _ = reply.send(());
            }
            Command::SetRunTimeout { timeout, reply } => {
                state.run_timeout = timeout;
                let _ = reply.send(());
            }
            Command::Restore { req, reply } => {
                // Restore takes the Database by value: the handler closes the
                // connection + lease, swaps the active root and re-opens the
                // database, returning the new handle alongside the result.
                let (db_next, result) = match db.take() {
                    Some(db) => {
                        let (next_db, result) = backup::backups_restore(db, &req);
                        (Some(next_db), result)
                    }
                    None => (
                        None,
                        Err(KernelError::new(
                            KernelErrorCode::StorageFailure,
                            "operation requires durable storage",
                        )),
                    ),
                };
                db = db_next;
                let _ = reply.send(result);
            }
            Command::Shutdown { reply } => {
                stop = true;
                let _ = reply.send(());
            }
        }
    }
    // `db` (and its data-root lease) is dropped here.
}

impl Kernel {
    /// Opens a kernel, validating the caller's contract expectations against
    /// the embedded manifest, then spawning the writer thread.
    ///
    /// # Errors
    ///
    /// [`KernelErrorCode::ContractMismatch`] when the expected schema hash or
    /// FFI ABI version does not match the embedded contract; storage-layer
    /// errors (lease conflicts, corruption, ...) propagate from `open`.
    pub fn open(config: KernelConfig) -> Result<Kernel, KernelError> {
        let actual = contracts_generated::contract_schema_hash();
        if config.expected_schema_hash != actual {
            return Err(KernelError::new(
                KernelErrorCode::ContractMismatch,
                format!(
                    "schema hash mismatch: caller expects {}, embedded manifest has {}",
                    config.expected_schema_hash, actual
                ),
            ));
        }
        if config.ffi_abi_version != FFI_ABI_VERSION {
            return Err(KernelError::new(
                KernelErrorCode::ContractMismatch,
                format!(
                    "ffi abi version mismatch: caller expects {}, kernel implements {}",
                    config.ffi_abi_version, FFI_ABI_VERSION
                ),
            ));
        }
        let db = match &config.data_root {
            Some(root) => {
                let mut progress = |p: neotavern_storage::migrations::MigrationProgress| {
                    // Structured diagnostics hook for the host (Phase 2:
                    // stderr only; the observability module lands later).
                    eprintln!("storage: applying migration {} ({})", p.id, p.name);
                };
                Some(neotavern_storage::open::open(
                    root,
                    &neotavern_storage::baseline::ConnectionPolicy::default(),
                    &mut progress,
                )?)
            }
            None => None,
        };
        let (has_storage, storage_diagnostics) = match &db {
            Some(db) => (
                true,
                Some(StorageDiagnostics {
                    storage_format: db.storage_format().ok(),
                    schema_revision: db.schema_revision().ok(),
                    sqlite_version: neotavern_storage::baseline::sqlite_libversion().to_string(),
                }),
            ),
            None => (false, None),
        };
        let meta = build_meta();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        // Per-kernel executor identity for the generation lease (ТЗ §63).
        let lease_owner = product::new_id();
        let writer_meta = meta.clone();
        let writer = std::thread::Builder::new()
            .name("kernel-writer".to_string())
            .spawn(move || writer_main(db, cmd_rx, writer_meta, lease_owner))
            .map_err(|err| {
                KernelError::new(
                    KernelErrorCode::Internal,
                    format!("failed to spawn writer thread: {err}"),
                )
            })?;
        Ok(Kernel {
            cmd_tx,
            meta,
            has_storage,
            storage_diagnostics,
            writer: Some(writer),
        })
    }

    /// Builds the `wire.meta.dto` describing this kernel build.
    pub fn meta(&self) -> MetaDto {
        self.meta.clone()
    }

    /// Storage-layer diagnostics for this kernel instance (ТЗ §86: version
    /// reporting), captured at open time. `None` when the kernel runs
    /// stateless.
    pub fn storage_diagnostics(&self) -> Option<StorageDiagnostics> {
        self.storage_diagnostics.clone()
    }

    /// Whether this kernel holds durable storage.
    pub fn has_storage(&self) -> bool {
        self.has_storage
    }

    /// Dispatches `operation_id` over `request` bytes.
    ///
    /// Cancellation is checked first: a cancelled flag yields
    /// [`KernelErrorCode::Cancelled`]. Unknown operation ids yield
    /// [`KernelErrorCode::OperationNotFound`]. Request payloads are decoded
    /// through the generated DTO checkers, so malformed input is a
    /// [`KernelErrorCode::ContractViolation`] — never a panic.
    ///
    /// The generation stream operations (`generation.start`,
    /// `generation.retry`) must go through
    /// [`dispatch_stream`](Self::dispatch_stream); dispatching them here
    /// yields [`KernelErrorCode::OperationNotFound`].
    pub fn dispatch(
        &self,
        operation_id: &str,
        request: &[u8],
        cancel: &CancellationFlag,
    ) -> Result<Vec<u8>, KernelError> {
        if cancel.is_cancelled() {
            return Err(KernelError::new(
                KernelErrorCode::Cancelled,
                "operation cancelled before dispatch",
            ));
        }
        if matches!(operation_id, "generation.start" | "generation.retry") {
            return Err(KernelError::new(
                KernelErrorCode::OperationNotFound,
                format!("operation {operation_id} must use dispatch_stream"),
            ));
        }
        // Вход, линия 2 (transport-agnostic): reject over-limit payloads
        // BEFORE the body is copied to the writer thread or parsed.
        enforce_request_limit(operation_id, request)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        // `backups.restore` (ТЗ §10.4) runs as a dedicated writer command: it
        // closes and re-opens the database (offline restore), so it cannot go
        // through the unary `with_db_opt` path.
        if operation_id == "backups.restore" {
            self.cmd_tx
                .send(Command::Restore {
                    req: request.to_vec(),
                    reply: reply_tx,
                })
                .map_err(|_| {
                    KernelError::new(KernelErrorCode::Internal, "kernel writer thread terminated")
                })?;
        } else {
            self.cmd_tx
                .send(Command::Unary {
                    op: operation_id.to_string(),
                    req: request.to_vec(),
                    cancel: cancel.clone(),
                    reply: reply_tx,
                })
                .map_err(|_| {
                    KernelError::new(KernelErrorCode::Internal, "kernel writer thread terminated")
                })?;
        }
        reply_rx.recv().map_err(|_| {
            KernelError::new(KernelErrorCode::Internal, "kernel writer thread terminated")
        })?
    }

    /// Dispatches a stream operation (`generation.start` / `generation.retry`)
    /// and returns the live [`EventStream`] for the new run.
    ///
    /// The run is created durably before this returns; the executor then runs
    /// on the kernel's writer thread, committing each provider step atomically.
    /// Consumers poll [`EventStream::next_notice`] and replay the durable
    /// `generation.events` log. Cancelling a run goes through
    /// `generation.cancel` on [`dispatch`](Self::dispatch).
    ///
    /// # Errors
    ///
    /// [`KernelErrorCode::OperationNotFound`] for non-stream operations;
    /// [`KernelErrorCode::StorageFailure`] on a stateless kernel; product
    /// errors (`CHAT_NOT_FOUND`, `GENERATION_RUN_NOT_FOUND`,
    /// `GENERATION_RUN_STATE_CONFLICT`) from the run setup.
    pub fn dispatch_stream(
        &self,
        operation_id: &str,
        request: &[u8],
        cancel: &CancellationFlag,
    ) -> Result<EventStream, KernelError> {
        if cancel.is_cancelled() {
            return Err(KernelError::new(
                KernelErrorCode::Cancelled,
                "operation cancelled before dispatch",
            ));
        }
        if !matches!(operation_id, "generation.start" | "generation.retry") {
            return Err(KernelError::new(
                KernelErrorCode::OperationNotFound,
                format!("operation {operation_id} must use dispatch"),
            ));
        }
        // Вход, линия 2 (transport-agnostic): reject over-limit payloads
        // BEFORE the body is copied to the writer thread or parsed.
        enforce_request_limit(operation_id, request)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.cmd_tx
            .send(Command::Stream {
                op: operation_id.to_string(),
                req: request.to_vec(),
                cancel: cancel.clone(),
                reply: reply_tx,
            })
            .map_err(|_| {
                KernelError::new(KernelErrorCode::Internal, "kernel writer thread terminated")
            })?;
        let start = reply_rx.recv().map_err(|_| {
            KernelError::new(KernelErrorCode::Internal, "kernel writer thread terminated")
        })??;
        Ok(EventStream {
            rx: start.notices,
            stream_id: start.stream_id,
        })
    }

    /// Sets the host-provided secret-resolution seam (ТЗ §68).
    ///
    /// The kernel stores only the resolver handle — never resolved values —
    /// and passes it to the generation executor for adapters that need
    /// secrets; the built-in providers ignore the seam. The command is
    /// acknowledged fire-and-forget (5s rendezvous timeout): a busy writer
    /// thread applies it at its next step boundary, and a timed-out ack is
    /// ignored (the setting still lands).
    pub fn set_secret_resolver(&self, resolver: Arc<dyn SecretResolver>) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::SetSecretResolver {
            resolver,
            reply: reply_tx,
        });
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }

    /// Sets the per-run provider deadline for future generations (default
    /// 60s, [`generation::RUN_TIMEOUT`]). Applied to runs started after this
    /// command is processed; fire-and-forget ack like
    /// [`set_secret_resolver`](Self::set_secret_resolver).
    pub fn set_run_timeout(&self, timeout: Duration) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::SetRunTimeout {
            timeout,
            reply: reply_tx,
        });
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }

    /// Sets the host-provided writable SecretStore seam (ТЗ §9.4, §SEC-01).
    ///
    /// The provider-config operations store API keys through this seam; the
    /// database keeps only the opaque reference. Without a seam,
    /// `providers.config.set` with an `apiKey` fails with the stable
    /// `SECRET_UNAVAILABLE` product error — there is never a plaintext
    /// fallback. Fire-and-forget ack like
    /// [`set_secret_resolver`](Self::set_secret_resolver).
    pub fn set_secret_store(&self, store: Arc<dyn SecretStore>) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::SetSecretStore {
            store,
            reply: reply_tx,
        });
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }

    /// Registers a runtime provider adapter (ТЗ §9.3).
    ///
    /// Hosts build production adapters (e.g. an OpenAI-compatible instance
    /// from a stored `provider_configs` row) and register them here; the
    /// adapter becomes visible to `providers.list` and generation dispatch
    /// immediately. Fire-and-forget ack like
    /// [`set_secret_resolver`](Self::set_secret_resolver).
    pub fn register_provider(&self, adapter: Arc<dyn ProviderAdapter>) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::RegisterProvider {
            adapter,
            reply: reply_tx,
        });
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }

    /// Registers a tool contract (ТЗ §8.3, Этап 2.7).
    ///
    /// The kernel validates provider tool calls against the registered
    /// contract (capability + argument schema) and durably waits for the
    /// host-submitted result; it never executes tools itself. Fire-and-forget
    /// ack like [`set_secret_resolver`](Self::set_secret_resolver).
    pub fn register_tool(&self, spec: generated::ToolSpec) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::RegisterTool {
            spec,
            reply: reply_tx,
        });
        let _ = reply_rx.recv_timeout(Duration::from_secs(5));
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        // Orderly shutdown: the writer stops (mid-generation it commits
        // progress at the next step boundary), closes the database and exits.
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let _ = self.cmd_tx.send(Command::Shutdown { reply: reply_tx });
        let _ = reply_rx.recv();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}
