//! Phase 6 generation durability: state machine, executor and provider
//! routing (ТЗ §78 Фаза 6, §62–64, §18.2; Фаза 7 §55, §60).
//!
//! The generation workflow is a durable, recoverable state machine over the
//! `generation_runs` / `generation_events` tables (storage migration 3):
//!
//! ```text
//! queued → preparing → streaming → completed | failed | cancelling → cancelled
//! non-terminal + lease expiry / process death → interrupted (startup recovery)
//! ```
//!
//! Every transition is a compare-and-swap on the run's `revision` column
//! (`UPDATE ... WHERE id = ? AND revision = ?`); a 0-row CAS re-reads the row
//! and reacts instead of blindly retrying. Each provider step commits the
//! delta event and the run update in ONE transaction, so the durable event
//! log is always consistent with the run row. The executor runs inline on
//! the kernel's writer thread and drains pending commands between provider
//! steps, so unary operations (notably `generation.cancel`) stay serviced
//! while a generation streams.
//!
//! Phase 7: the executor routes each run through the
//! [`ProviderRegistry`](crate::providers::ProviderRegistry) instead of an
//! inline fake. The built-in `fake` adapter (in `built-in-providers`) is a
//! byte-identical port of the Phase 6 inline provider: delta text derives
//! from `sha256(run_key|i)` with `run_key = "{chat_id}|{attempt}"` — no wall
//! clock, so two runs with the same chat id, attempt and model produce
//! byte-identical payloads.

use crate::product;
use crate::providers::ProviderRegistry;
use crate::{CancellationFlag, KernelError, KernelErrorCode, StreamNotice};
use contracts_generated::generated::{
    self, ErrorDto, EventEnvelope, GenerationEvent, GenerationRun, GenerationStatus, MessageDto,
    MessageRole, PagedGenerationEvents, ResultEmpty,
};
use contracts_generated::Issue;
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use provider_sdk::secret::SecretResolver;
use rusqlite::params;
use rusqlite::OptionalExtension;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

/// Executor lease grace period: every transaction (re)writes
/// `lease_expires_at = now + 30s`; a run whose lease has expired (or is
/// NULL) with a non-terminal status is interrupted by startup recovery.
const LEASE_GRACE_SECONDS: i64 = 30;

/// Length cap of the `partialText` preview served by `generation.get`
/// (mirrors the wire `partialText` max length).
const PARTIAL_PREVIEW_LEN: usize = 4096;

/// Default per-run provider deadline (design §Kernel integration): the
/// adapter must finish one generation attempt within this window. Settable
/// per kernel via `Kernel::set_run_timeout` (the writer's
/// [`ProviderState`](crate::providers::ProviderState) carries the live
/// value; this const is the default).
pub(crate) const RUN_TIMEOUT: Duration = Duration::from_secs(60);

/// UTC now as an RFC 3339 wire timestamp (seconds precision).
fn now() -> String {
    product::now()
}

/// The lease expiry timestamp for this transaction: `now + 30s` RFC 3339.
fn lease_expires() -> String {
    use time::format_description::well_known::Rfc3339;
    let expires = time::OffsetDateTime::now_utc() + time::Duration::seconds(LEASE_GRACE_SECONDS);
    match expires.format(&Rfc3339) {
        Ok(formatted) => formatted,
        // Unreachable for `now_utc() + 30s`; controlled fallback keeps the
        // "never panic on transport" contract.
        Err(_) => now(),
    }
}

/// A freshly generated record id (uuid, version nibble rewritten to 4 to
/// satisfy the wire `uuid` format).
fn new_id() -> String {
    product::new_id()
}

/// Classifies a SQLite failure as a kernel storage error in `context`.
fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    product::sqlite(err, context)
}

/// Validates a value against a generated wire checker.
fn validate<T: serde::Serialize>(
    value: &T,
    check: fn(&serde_json::Value) -> Result<(), Vec<Issue>>,
) -> Result<(), KernelError> {
    product::validate(value, check)
}

/// Serializes a validated DTO to response bytes.
fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, KernelError> {
    product::encode(value)
}

/// An internal-invariant failure (tampered database, kernel bug). Never a
/// panic on transport payloads.
fn internal(message: impl Into<String>) -> KernelError {
    KernelError::new(KernelErrorCode::Internal, message)
}

/// Builds a provider-level [`ErrorDto`] (the payload stored in `error_json`
/// and served in the `generation.failed` terminal event).
fn error_dto(code: &str, params: &[(&str, String)]) -> ErrorDto {
    ErrorDto {
        code: code.to_string(),
        params: serde_json::Value::Object(
            params
                .iter()
                .map(|(key, value)| (key.to_string(), serde_json::Value::String(value.clone())))
                .collect(),
        ),
        trace_id: None,
        correlation_id: None,
    }
}

/// `GENERATION_RUN_NOT_FOUND` product error (`runId` param).
fn run_not_found(run_id: &str) -> KernelError {
    KernelError::product(
        "GENERATION_RUN_NOT_FOUND",
        vec![("runId".to_string(), run_id.to_string())],
    )
}

/// `PROMPT_PLAN_NOT_FOUND` product error (`runId` param).
fn prompt_plan_not_found(run_id: &str) -> KernelError {
    KernelError::product(
        "PROMPT_PLAN_NOT_FOUND",
        vec![("runId".to_string(), run_id.to_string())],
    )
}

/// `generation.prompt.plan` — the durable [`PromptPlan`] of a run
/// (ТЗ §9.2, Этап 2.6): what context entered the provider request
/// (system blocks + selected history + the user message), the token counts
/// and every excluded message. Read-only, `app.read`.
pub(crate) fn generation_prompt_plan(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_prompt_plan(request)?;
    let plan = crate::prompt::load_prompt_plan(db, &req.run_id)
        .map_err(|_| prompt_plan_not_found(&req.run_id))?;
    let value = serde_json::to_value(&plan)
        .map_err(|e| internal(format!("prompt plan: serialize: {e}")))?;
    validate(&value, generated::validate_prompt_plan)?;
    encode(&value)
}

/// `GENERATION_RUN_STATE_CONFLICT` product error (`runId`, `status` params).
fn state_conflict(run_id: &str, status: &str) -> KernelError {
    KernelError::product(
        "GENERATION_RUN_STATE_CONFLICT",
        vec![
            ("runId".to_string(), run_id.to_string()),
            ("status".to_string(), status.to_string()),
        ],
    )
}

/// Rejects a run whose status is not one of the recoverable terminal states
/// (`failed`, `cancelled`, `interrupted`) with a state-conflict product
/// error.
fn ensure_recoverable(run: &RunRow) -> Result<(), KernelError> {
    if matches!(run.status.as_str(), "failed" | "cancelled" | "interrupted") {
        Ok(())
    } else {
        Err(state_conflict(&run.run_id, &run.status))
    }
}

/// Whether `status` is a terminal state (immutable for the attempt).
fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

/// Maps a `generation_runs.status` string to the wire
/// [`GenerationStatus`]. Values are CHECK-constrained; an unexpected value
/// means a tampered database and surfaces as a controlled internal error.
fn status_enum(status: &str) -> Result<GenerationStatus, KernelError> {
    match status {
        "queued" => Ok(GenerationStatus::Queued),
        "preparing" => Ok(GenerationStatus::Preparing),
        "streaming" => Ok(GenerationStatus::Streaming),
        "completed" => Ok(GenerationStatus::Completed),
        "failed" => Ok(GenerationStatus::Failed),
        "cancelling" => Ok(GenerationStatus::Cancelling),
        "cancelled" => Ok(GenerationStatus::Cancelled),
        "interrupted" => Ok(GenerationStatus::Interrupted),
        other => Err(internal(format!("invalid generation run status: {other}"))),
    }
}

/// A `generation_runs` row, loaded in the fixed column order below.
#[derive(Debug, Clone)]
struct RunRow {
    run_id: String,
    source_run_id: Option<String>,
    chat_id: String,
    attempt: i64,
    status: String,
    provider: Option<String>,
    model: Option<String>,
    request_snapshot_json: String,
    revision: i64,
    cancel_requested: bool,
    last_event_sequence: i64,
    partial_length: i64,
    error_json: Option<String>,
    message_id: Option<String>,
    lease_expires_at: Option<String>,
    started_at: String,
    updated_at: String,
}

/// Column list shared by every `generation_runs` read.
const RUN_COLUMNS: &str = "id, source_run_id, chat_id, attempt, status, provider, model, \
     request_snapshot_json, revision, cancel_requested, last_event_sequence, partial_length, \
     error_json, message_id, lease_expires_at, started_at, updated_at";

/// Loads one run row; `None` when absent.
fn load_run(conn: &rusqlite::Connection, run_id: &str) -> Result<Option<RunRow>, KernelError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM generation_runs WHERE id = ?1"
        ))
        .map_err(|e| sqlite(e, "generation: load run prepare"))?;
    let mut rows = stmt
        .query(params![run_id])
        .map_err(|e| sqlite(e, "generation: load run query"))?;
    match rows
        .next()
        .map_err(|e| sqlite(e, "generation: load run row"))?
    {
        Some(row) => Ok(Some(row_to_run(row)?)),
        None => Ok(None),
    }
}

fn row_to_run(row: &rusqlite::Row) -> Result<RunRow, KernelError> {
    Ok(RunRow {
        run_id: row
            .get(0)
            .map_err(|e| sqlite(e, "generation: read run_id"))?,
        source_run_id: row
            .get(1)
            .map_err(|e| sqlite(e, "generation: read source_run_id"))?,
        chat_id: row
            .get(2)
            .map_err(|e| sqlite(e, "generation: read chat_id"))?,
        attempt: row
            .get(3)
            .map_err(|e| sqlite(e, "generation: read attempt"))?,
        status: row
            .get(4)
            .map_err(|e| sqlite(e, "generation: read status"))?,
        provider: row
            .get(5)
            .map_err(|e| sqlite(e, "generation: read provider"))?,
        model: row
            .get(6)
            .map_err(|e| sqlite(e, "generation: read model"))?,
        request_snapshot_json: row
            .get(7)
            .map_err(|e| sqlite(e, "generation: read snapshot"))?,
        revision: row
            .get(8)
            .map_err(|e| sqlite(e, "generation: read revision"))?,
        cancel_requested: row
            .get(9)
            .map_err(|e| sqlite(e, "generation: read cancel_requested"))
            .map(|v: i64| v != 0)?,
        last_event_sequence: row
            .get(10)
            .map_err(|e| sqlite(e, "generation: read last_event_sequence"))?,
        partial_length: row
            .get(11)
            .map_err(|e| sqlite(e, "generation: read partial_length"))?,
        error_json: row
            .get(12)
            .map_err(|e| sqlite(e, "generation: read error_json"))?,
        message_id: row
            .get(13)
            .map_err(|e| sqlite(e, "generation: read message_id"))?,
        lease_expires_at: row
            .get(14)
            .map_err(|e| sqlite(e, "generation: read lease_expires_at"))?,
        started_at: row
            .get(15)
            .map_err(|e| sqlite(e, "generation: read started_at"))?,
        updated_at: row
            .get(16)
            .map_err(|e| sqlite(e, "generation: read updated_at"))?,
    })
}

/// Re-loads a run row by id; a vanished row is an internal-invariant failure.
fn reload(db: &Database, run_id: &str) -> Result<RunRow, KernelError> {
    load_run(db.conn(), run_id)?.ok_or_else(|| {
        internal(format!(
            "generation run vanished during execution: {run_id}"
        ))
    })
}

/// Loads the ordered delta texts of a run (the committed `generation.delta`
/// payloads, ascending by sequence).
fn load_delta_texts(conn: &rusqlite::Connection, run_id: &str) -> Result<Vec<String>, KernelError> {
    let mut stmt = conn
        .prepare(
            "SELECT payload_json FROM generation_events \
             WHERE run_id = ?1 AND type = 'generation.delta' ORDER BY sequence",
        )
        .map_err(|e| sqlite(e, "generation: delta texts prepare"))?;
    let mut rows = stmt
        .query(params![run_id])
        .map_err(|e| sqlite(e, "generation: delta texts query"))?;
    let mut texts = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| sqlite(e, "generation: delta texts row"))?
    {
        let payload_json: String = row
            .get(0)
            .map_err(|e| sqlite(e, "generation: delta texts payload"))?;
        let event: GenerationEvent = serde_json::from_str(&payload_json)
            .map_err(|err| internal(format!("generation delta payload malformed: {err}")))?;
        match event {
            GenerationEvent::GenerationDelta { text } => texts.push(text),
            other => {
                return Err(internal(format!(
                    "generation.delta event row carries unexpected type: {other:?}"
                )));
            }
        }
    }
    Ok(texts)
}

/// Concatenated committed delta text — the durable partial/final message
/// content. Always derived from the committed event log, never from
/// executor-local state.
fn concat_delta_text(conn: &rusqlite::Connection, run_id: &str) -> Result<String, KernelError> {
    Ok(load_delta_texts(conn, run_id)?.concat())
}

/// Renders the wire [`GenerationRun`] DTO for a run row, including the
/// `partialText` preview (first ≤4096 chars of the concatenated deltas) and
/// the parsed `error` from `error_json`.
fn run_to_dto(conn: &rusqlite::Connection, run: &RunRow) -> Result<GenerationRun, KernelError> {
    let deltas = load_delta_texts(conn, &run.run_id)?;
    let full: String = deltas.concat();
    let preview: String = full.chars().take(PARTIAL_PREVIEW_LEN).collect();
    let partial_truncated = run.partial_length > PARTIAL_PREVIEW_LEN as i64;
    let error = match &run.error_json {
        Some(json) => Some(
            serde_json::from_str::<ErrorDto>(json)
                .map_err(|err| internal(format!("generation run error_json malformed: {err}")))?,
        ),
        None => None,
    };
    Ok(GenerationRun {
        run_id: run.run_id.clone(),
        source_run_id: run.source_run_id.clone(),
        chat_id: run.chat_id.clone(),
        attempt: run.attempt,
        status: status_enum(&run.status)?,
        provider: run.provider.clone(),
        model: run.model.clone(),
        revision: run.revision,
        last_event_sequence: run.last_event_sequence,
        partial_text_length: run.partial_length,
        partial_text: if run.partial_length > 0 {
            Some(preview)
        } else {
            None
        },
        partial_truncated,
        error,
        message_id: run.message_id.clone(),
        lease_expires_at: run.lease_expires_at.clone(),
        started_at: run.started_at.clone(),
        updated_at: run.updated_at.clone(),
    })
}

// ---------------------------------------------------------------------------
// Unary operations
// ---------------------------------------------------------------------------

/// `generation.cancel` — durable cancel request (design §2).
///
/// A run in `{queued, preparing, streaming}` transitions to `cancelling`
/// with `cancel_requested = 1`; the executor observes that at its next step
/// boundary and commits `cancelled` + the terminal event. Cancelling an
/// already-`cancelling` run is idempotent. A terminal or `interrupted` run
/// yields `GENERATION_RUN_STATE_CONFLICT`.
pub(crate) fn generation_cancel(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_cancel_generation(request)?;
    let run_id = req.workflow_id.clone();
    let mut run = load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    let updated_at = now();
    let mut done = false;
    for _ in 0..8 {
        match run.status.as_str() {
            "queued" | "preparing" | "streaming" => {
                let changed = db.transaction(|tx| {
                    tx.execute(
                        "UPDATE generation_runs SET status = 'cancelling', cancel_requested = 1, \
                         revision = revision + 1, updated_at = ?1 WHERE id = ?2 AND revision = ?3",
                        params![&updated_at, &run_id, run.revision],
                    )
                    .map_err(|e| StorageError::from_sqlite(e, "generation_cancel: cas"))
                })?;
                if changed == 0 {
                    // CAS lost: re-read and react (never a blind retry).
                    run = reload(db, &run_id)?;
                    continue;
                }
                done = true;
                break;
            }
            // Idempotent: the executor is already committing the cancel.
            "cancelling" => {
                done = true;
                break;
            }
            other => return Err(state_conflict(&run_id, other)),
        }
    }
    if !done {
        return Err(internal("generation cancel could not make progress"));
    }
    let dto = ResultEmpty {};
    validate(&dto, generated::validate_result_empty)?;
    encode(&dto)
}

/// `generation.get` — the run DTO with the partial-text preview.
pub(crate) fn generation_get(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_get_generation_run(request)?;
    let run =
        load_run(db.conn(), &req.workflow_id)?.ok_or_else(|| run_not_found(&req.workflow_id))?;
    let dto = run_to_dto(db.conn(), &run)?;
    validate(&dto, generated::validate_generation_run)?;
    encode(&dto)
}

/// `generation.events` — the run's durable event log, ascending by sequence.
pub(crate) fn generation_events(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_list_generation_events(request)?;
    let run_id = req.workflow_id.clone();
    // Product-level gate: the run must exist.
    load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    let after = req.after_sequence.unwrap_or(-1);
    let limit = product::page_limit(req.limit);
    let mut items: Vec<EventEnvelope> = Vec::new();
    let mut has_more = false;
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT sequence, type, payload_json FROM generation_events \
                 WHERE run_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT ?3",
            )
            .map_err(|e| sqlite(e, "generation_events: prepare"))?;
        let mut rows = stmt
            .query(params![&run_id, after, limit + 1])
            .map_err(|e| sqlite(e, "generation_events: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sqlite(e, "generation_events: row"))?
        {
            if items.len() >= limit as usize {
                // Probe row past the page: a page-full of rows means more.
                has_more = true;
                break;
            }
            let sequence: i64 = row
                .get(0)
                .map_err(|e| sqlite(e, "generation_events: sequence"))?;
            let r#type: String = row
                .get(1)
                .map_err(|e| sqlite(e, "generation_events: type"))?;
            let payload_json: String = row
                .get(2)
                .map_err(|e| sqlite(e, "generation_events: payload"))?;
            let payload: serde_json::Value = serde_json::from_str(&payload_json)
                .map_err(|err| internal(format!("generation event payload malformed: {err}")))?;
            items.push(EventEnvelope {
                stream_id: run_id.clone(),
                sequence,
                r#type,
                payload,
            });
        }
    }
    let dto = PagedGenerationEvents { items, has_more };
    validate(&dto, generated::validate_paged_generation_events)?;
    encode(&dto)
}

/// `generation.keep` — persist the partial output as an assistant message
/// (design §4). Idempotent: a run that already has `message_id` is returned
/// unchanged; `partial_length == 0` yields `NO_PARTIAL_OUTPUT`.
pub(crate) fn generation_keep(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_keep_partial_generation(request)?;
    let run_id = req.workflow_id.clone();
    let mut run = load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    ensure_recoverable(&run)?;
    if run.message_id.is_some() {
        return keep_response(db, &run);
    }
    if run.partial_length == 0 {
        return Err(KernelError::product(
            "NO_PARTIAL_OUTPUT",
            vec![("runId".to_string(), run_id.clone())],
        ));
    }
    let full_text = concat_delta_text(db.conn(), &run_id)?;
    let message_id = new_id();
    let chat_id = run.chat_id.clone();
    let created_at = now();
    for _ in 0..8 {
        let outcome = db.transaction(|tx| {
            // CAS first: on conflict, no message row is written.
            let changed = tx
                .execute(
                    "UPDATE generation_runs SET message_id = ?1, revision = revision + 1, \
                     updated_at = ?2 WHERE id = ?3 AND revision = ?4",
                    params![&message_id, &created_at, &run_id, run.revision],
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation_keep: cas"))?;
            if changed == 0 {
                return Ok(false);
            }
            let msg_seq: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE chat_id = ?1",
                    params![&chat_id],
                    |row| row.get(0),
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation_keep: message sequence"))?;
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
                 VALUES (?1, ?2, 'assistant', ?3, ?4, ?5, ?6)",
                params![&message_id, &chat_id, &full_text, msg_seq, &run_id, &created_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation_keep: insert message"))?;
            Ok(true)
        })?;
        if outcome {
            break;
        }
        run = reload(db, &run_id)?;
        ensure_recoverable(&run)?;
        if run.message_id.is_some() {
            break;
        }
        if run.partial_length == 0 {
            return Err(KernelError::product(
                "NO_PARTIAL_OUTPUT",
                vec![("runId".to_string(), run_id.clone())],
            ));
        }
    }
    let run = reload(db, &run_id)?;
    if run.message_id.is_none() {
        return Err(internal("generation keep could not make progress"));
    }
    keep_response(db, &run)
}

fn keep_response(db: &mut Database, run: &RunRow) -> Result<Vec<u8>, KernelError> {
    let dto = run_to_dto(db.conn(), run)?;
    validate(&dto, generated::validate_generation_run)?;
    encode(&dto)
}

/// `generation.discard` — purge the run's durable event log and partial
/// length (design §4). Idempotent: a second discard on the same recoverable
/// run is a no-op success.
pub(crate) fn generation_discard(
    db: &mut Database,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_discard_generation(request)?;
    let run_id = req.workflow_id.clone();
    let mut run = load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    ensure_recoverable(&run)?;
    let updated_at = now();
    for _ in 0..8 {
        let outcome = db.transaction(|tx| {
            // CAS first: on conflict, the events stay untouched.
            let changed = tx
                .execute(
                    "UPDATE generation_runs SET partial_length = 0, revision = revision + 1, \
                     updated_at = ?1 WHERE id = ?2 AND revision = ?3",
                    params![&updated_at, &run_id, run.revision],
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation_discard: cas"))?;
            if changed == 0 {
                return Ok(false);
            }
            tx.execute(
                "DELETE FROM generation_events WHERE run_id = ?1",
                params![&run_id],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation_discard: delete events"))?;
            Ok(true)
        })?;
        if outcome {
            break;
        }
        run = reload(db, &run_id)?;
        ensure_recoverable(&run)?;
    }
    let run = reload(db, &run_id)?;
    if run.partial_length != 0 {
        return Err(internal("generation discard could not make progress"));
    }
    let dto = run_to_dto(db.conn(), &run)?;
    validate(&dto, generated::validate_generation_run)?;
    encode(&dto)
}

// ---------------------------------------------------------------------------
// Stream setup + executor
// ---------------------------------------------------------------------------

/// A stream launch: the run id plus both ends of the notice channel. The
/// writer replies to the caller with the receiver and keeps the sender for
/// the inline executor.
///
/// The notice channel is unbounded (`std` `mpsc::channel`): notices are tiny
/// and the consumer polls every ~250 ms, so at most a handful accumulate,
/// while the `Terminal` notice is never dropped on a transiently-full
/// buffer. The durable event log remains canonical — a consumer that stops
/// polling still converges by replaying `generation.events`.
pub(crate) struct StreamLaunch {
    /// The created run id (== `EventStream::stream_id`).
    pub stream_id: String,
    /// The executor's end of the notice channel.
    pub notice_tx: mpsc::Sender<StreamNotice>,
    /// The consumer's end of the notice channel.
    pub notice_rx: mpsc::Receiver<StreamNotice>,
}

/// Creates a durable run for `generation.start` / `generation.retry`
/// (design §4) and the notice channel the executor will publish to.
pub(crate) fn stream_start(
    db: &mut Database,
    op: &str,
    request: &[u8],
    lease_owner: &str,
) -> Result<StreamLaunch, KernelError> {
    let (notice_tx, notice_rx) = mpsc::channel();
    let run_id = new_id();
    let (source_run_id, chat_id, attempt, provider, model, snapshot_json) = match op {
        "generation.start" => {
            let req = generated::decode_request_start_generation(request)?;
            if !product::chat_exists(db.conn(), &req.chat_id)? {
                return Err(KernelError::product(
                    "CHAT_NOT_FOUND",
                    vec![("chatId".to_string(), req.chat_id.clone())],
                ));
            }
            let provider = req.provider.clone();
            let model = req.model.clone();
            let snapshot_json =
                snapshot_json(&req.chat_id, &req.message, &req.provider, &req.model);
            (None, req.chat_id.clone(), 1, provider, model, snapshot_json)
        }
        "generation.retry" => {
            let req = generated::decode_request_retry_generation(request)?;
            let source = load_run(db.conn(), &req.source_run_id)?
                .ok_or_else(|| run_not_found(&req.source_run_id))?;
            ensure_recoverable(&source)?;
            (
                Some(source.run_id.clone()),
                source.chat_id.clone(),
                source.attempt + 1,
                source.provider.clone(),
                source.model.clone(),
                source.request_snapshot_json.clone(),
            )
        }
        other => {
            return Err(KernelError::new(
                KernelErrorCode::OperationNotFound,
                format!("operation {other} must use dispatch"),
            ));
        }
    };
    let created_at = now();
    let lease = lease_expires();
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO generation_runs \
             (id, source_run_id, chat_id, attempt, status, provider, model, request_snapshot_json, \
              revision, cancel_requested, last_event_sequence, partial_length, error_json, \
              message_id, lease_owner, lease_expires_at, started_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, 0, 0, -1, 0, NULL, NULL, ?8, ?9, ?10, ?10)",
            params![
                &run_id,
                source_run_id,
                &chat_id,
                attempt,
                &provider,
                &model,
                &snapshot_json,
                lease_owner,
                &lease,
                &created_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation stream: insert run"))
    })?;
    Ok(StreamLaunch {
        stream_id: run_id,
        notice_tx,
        notice_rx,
    })
}

/// The sanitized request snapshot stored on the run and reused by retry:
/// exactly the request DTO fields, `None` fields omitted.
fn snapshot_json(
    chat_id: &str,
    message: &str,
    provider: &Option<String>,
    model: &Option<String>,
) -> String {
    let mut snapshot = serde_json::Map::new();
    snapshot.insert("chatId".to_string(), serde_json::json!(chat_id));
    snapshot.insert("message".to_string(), serde_json::json!(message));
    if let Some(provider) = provider {
        snapshot.insert("provider".to_string(), serde_json::json!(provider));
    }
    if let Some(model) = model {
        snapshot.insert("model".to_string(), serde_json::json!(model));
    }
    serde_json::Value::Object(snapshot).to_string()
}

/// Delivers a `Committed` notice. The channel is unbounded, so this only
/// fails when the consumer dropped the stream — the durable event log stays
/// canonical either way.
fn send_committed(notice_tx: &mpsc::Sender<StreamNotice>, through_sequence: i64) {
    let _ = notice_tx.send(StreamNotice::Committed { through_sequence });
}

/// Delivers the `Terminal` notice. Like [`send_committed`], this only fails
/// when the consumer is gone; a live consumer always receives it.
fn send_terminal(notice_tx: &mpsc::Sender<StreamNotice>, last_sequence: i64) {
    let _ = notice_tx.send(StreamNotice::Terminal { last_sequence });
}

/// Outcome of a CAS-guarded status transition.
enum StepOutcome {
    /// Transition applied; carries the fresh row.
    Proceed(Box<RunRow>),
    /// A cancel raced the transition and the run was committed `cancelled`;
    /// carries the terminal event sequence.
    Cancelled(i64),
    /// The run is already terminal; nothing more to do.
    AlreadyTerminal,
}

/// CAS-transitions the run to `new_status` (with a lease refresh). On a
/// lost CAS the row is re-read and the reaction is decided there — a
/// `cancelling` run is committed `cancelled`, a terminal run stops, anything
/// else retries with the fresh revision. Never a blind retry.
fn cas_status(
    db: &mut Database,
    mut run: RunRow,
    new_status: &str,
    lease_owner: &str,
) -> Result<StepOutcome, KernelError> {
    let updated_at = now();
    let lease = lease_expires();
    for _ in 0..8 {
        let changed = db.transaction(|tx| {
            tx.execute(
                "UPDATE generation_runs SET status = ?1, revision = revision + 1, \
                 lease_owner = ?2, lease_expires_at = ?3, updated_at = ?4 \
                 WHERE id = ?5 AND revision = ?6",
                params![
                    new_status,
                    lease_owner,
                    &lease,
                    &updated_at,
                    run.run_id,
                    run.revision
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: status cas"))
        })?;
        if changed > 0 {
            return Ok(StepOutcome::Proceed(Box::new(reload(db, &run.run_id)?)));
        }
        run = reload(db, &run.run_id)?;
        if run.status == "cancelling" || run.cancel_requested {
            let seq = terminal_cancelled(db, run, lease_owner)?;
            return Ok(StepOutcome::Cancelled(seq));
        }
        if is_terminal(&run.status) {
            return Ok(StepOutcome::AlreadyTerminal);
        }
        // Otherwise retry the transition against the fresh revision.
    }
    Err(internal(format!(
        "generation status transition to {new_status} could not make progress"
    )))
}

/// Outcome of a per-step durable commit.
enum DeltaOutcome {
    /// Delta (+ optional checkpoint) committed; carries the fresh row.
    Applied(Box<RunRow>),
    /// The CAS lost; re-read the row and react at the next step boundary.
    Conflict,
}

/// Commits one provider delta: the delta event and the run update in ONE
/// transaction (design §3). Every 4th delta (0-based delta index `% 4 == 3`)
/// also commits a `generation.checkpoint` event carrying its own global
/// sequence — the run's event sequence is global, monotonous and gapless.
fn commit_delta(
    db: &mut Database,
    run: &RunRow,
    text: &str,
    delta_index: usize,
    notice_tx: &mpsc::Sender<StreamNotice>,
    lease_owner: &str,
) -> Result<DeltaOutcome, KernelError> {
    let delta_seq = run.last_event_sequence + 1;
    let checkpoint = delta_index % 4 == 3;
    let end_seq = if checkpoint { delta_seq + 1 } else { delta_seq };
    let new_partial = run.partial_length + text.len() as i64;
    let delta_payload = event_payload(&GenerationEvent::GenerationDelta {
        text: text.to_string(),
    })?;
    let checkpoint_payload = if checkpoint {
        Some(event_payload(&GenerationEvent::GenerationCheckpoint {
            sequence: end_seq,
            partial_length: new_partial,
        })?)
    } else {
        None
    };
    let updated_at = now();
    let lease = lease_expires();
    let changed = db.transaction(|tx| {
        // CAS first: on a lost CAS nothing is written (no orphan events).
        let changed = tx
            .execute(
                "UPDATE generation_runs SET last_event_sequence = ?1, \
                 partial_length = partial_length + ?2, revision = revision + 1, \
                 lease_owner = ?3, lease_expires_at = ?4, updated_at = ?5 \
                 WHERE id = ?6 AND revision = ?7",
                params![
                    end_seq,
                    text.len() as i64,
                    lease_owner,
                    &lease,
                    &updated_at,
                    run.run_id,
                    run.revision
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: delta cas"))?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
             VALUES (?1, ?2, 'generation.delta', ?3, ?4)",
            params![run.run_id, delta_seq, &delta_payload, &updated_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: delta event"))?;
        if let Some(checkpoint_payload) = &checkpoint_payload {
            tx.execute(
                "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
                 VALUES (?1, ?2, 'generation.checkpoint', ?3, ?4)",
                params![run.run_id, end_seq, checkpoint_payload, &updated_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: checkpoint event"))?;
        }
        Ok(true)
    })?;
    if !changed {
        return Ok(DeltaOutcome::Conflict);
    }
    send_committed(notice_tx, end_seq);
    Ok(DeltaOutcome::Applied(Box::new(reload(db, &run.run_id)?)))
}

/// Serializes a [`GenerationEvent`] to its stored `payload_json`, validating
/// the wire shape (a kernel-internal DTO bug must fail loudly, not store a
/// corrupt log row).
fn event_payload(event: &GenerationEvent) -> Result<String, KernelError> {
    let value = serde_json::to_value(event)
        .map_err(|err| internal(format!("failed to serialize generation event: {err}")))?;
    validate(&value, generated::validate_generation_event)?;
    serde_json::to_string(&value)
        .map_err(|err| internal(format!("failed to serialize generation event: {err}")))
}

/// Outcome of a terminal commit attempt.
enum TerminalCommit {
    /// Committed; carries the terminal event sequence.
    Applied(i64),
    /// The CAS lost; the caller re-reads and reacts.
    Conflict,
}

/// Terminal commit: `completed` — assistant message INSERT + status CAS +
/// terminal event, ONE transaction (design §3). The message sequence is
/// computed before the transaction; the kernel is the single writer, so no
/// concurrent message insert can interleave.
fn terminal_completed(
    db: &mut Database,
    mut run: RunRow,
    full_text: &str,
    lease_owner: &str,
) -> Result<i64, KernelError> {
    let message_id = new_id();
    let chat_id = run.chat_id.clone();
    let created_at = now();
    let msg_seq: i64 = db
        .conn()
        .query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE chat_id = ?1",
            params![&chat_id],
            |row| row.get(0),
        )
        .map_err(|e| sqlite(e, "generation completed: message sequence"))?;
    let message_dto = MessageDto {
        id: message_id.clone(),
        chat_id: chat_id.clone(),
        role: MessageRole::Assistant,
        content: full_text.to_string(),
        created_at: created_at.clone(),
        sequence: msg_seq,
        generation_run_id: Some(run.run_id.clone()),
    };
    validate(&message_dto, generated::validate_message_dto)?;
    let event_payload = event_payload(&GenerationEvent::GenerationCompleted {
        final_message: message_dto,
    })?;
    for _ in 0..8 {
        let seq = run.last_event_sequence + 1;
        let outcome = db.transaction(|tx| {
            let changed = tx
                .execute(
                    "UPDATE generation_runs SET status = 'completed', message_id = ?1, \
                     last_event_sequence = ?2, revision = revision + 1, lease_owner = ?3, \
                     lease_expires_at = ?4, updated_at = ?5 WHERE id = ?6 AND revision = ?7",
                    params![&message_id, seq, lease_owner, lease_expires(), &created_at, run.run_id, run.revision],
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation completed: cas"))?;
            if changed == 0 {
                return Ok(TerminalCommit::Conflict);
            }
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at) \
                 VALUES (?1, ?2, 'assistant', ?3, ?4, ?5, ?6)",
                params![&message_id, &chat_id, full_text, msg_seq, run.run_id, &created_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation completed: insert message"))?;
            tx.execute(
                "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
                 VALUES (?1, ?2, 'generation.completed', ?3, ?4)",
                params![run.run_id, seq, &event_payload, &created_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation completed: terminal event"))?;
            Ok(TerminalCommit::Applied(seq))
        })?;
        match outcome {
            TerminalCommit::Applied(committed) => return Ok(committed),
            TerminalCommit::Conflict => {
                run = reload(db, &run.run_id)?;
                if run.status == "cancelling" || run.cancel_requested {
                    return terminal_cancelled(db, run, lease_owner);
                }
                if is_terminal(&run.status) {
                    return Ok(run.last_event_sequence);
                }
                // Otherwise retry against the fresh revision.
            }
        }
    }
    Err(internal(
        "generation completed commit could not make progress",
    ))
}

/// Terminal commit: `failed` — status CAS + terminal `generation.failed`
/// event (payload carries the provider [`ErrorDto`]).
fn terminal_failed(
    db: &mut Database,
    mut run: RunRow,
    error: ErrorDto,
    lease_owner: &str,
) -> Result<i64, KernelError> {
    let error_json = serde_json::to_string(&error)
        .map_err(|err| internal(format!("failed to serialize provider error: {err}")))?;
    let event_payload = event_payload(&GenerationEvent::GenerationFailed { error })?;
    for _ in 0..8 {
        let seq = run.last_event_sequence + 1;
        let updated_at = now();
        let lease = lease_expires();
        let outcome = db.transaction(|tx| {
            let changed = tx
                .execute(
                    "UPDATE generation_runs SET status = 'failed', error_json = ?1, \
                     last_event_sequence = ?2, revision = revision + 1, lease_owner = ?3, \
                     lease_expires_at = ?4, updated_at = ?5 WHERE id = ?6 AND revision = ?7",
                    params![
                        &error_json,
                        seq,
                        lease_owner,
                        &lease,
                        &updated_at,
                        run.run_id,
                        run.revision
                    ],
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation failed: cas"))?;
            if changed == 0 {
                return Ok(TerminalCommit::Conflict);
            }
            tx.execute(
                "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
                 VALUES (?1, ?2, 'generation.failed', ?3, ?4)",
                params![run.run_id, seq, &event_payload, &updated_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation failed: terminal event"))?;
            Ok(TerminalCommit::Applied(seq))
        })?;
        match outcome {
            TerminalCommit::Applied(committed) => return Ok(committed),
            TerminalCommit::Conflict => {
                run = reload(db, &run.run_id)?;
                if run.status == "cancelling" || run.cancel_requested {
                    return terminal_cancelled(db, run, lease_owner);
                }
                if is_terminal(&run.status) {
                    return Ok(run.last_event_sequence);
                }
            }
        }
    }
    Err(internal("generation failed commit could not make progress"))
}

/// Terminal commit: `cancelled` — status CAS + terminal
/// `generation.cancelled` event.
fn terminal_cancelled(
    db: &mut Database,
    mut run: RunRow,
    lease_owner: &str,
) -> Result<i64, KernelError> {
    let event_payload = event_payload(&GenerationEvent::GenerationCancelled)?;
    for _ in 0..8 {
        let seq = run.last_event_sequence + 1;
        let updated_at = now();
        let lease = lease_expires();
        let outcome = db.transaction(|tx| {
            let changed = tx
                .execute(
                    "UPDATE generation_runs SET status = 'cancelled', \
                     last_event_sequence = ?1, revision = revision + 1, lease_owner = ?2, \
                     lease_expires_at = ?3, updated_at = ?4 WHERE id = ?5 AND revision = ?6",
                    params![
                        seq,
                        lease_owner,
                        &lease,
                        &updated_at,
                        run.run_id,
                        run.revision
                    ],
                )
                .map_err(|e| StorageError::from_sqlite(e, "generation cancelled: cas"))?;
            if changed == 0 {
                return Ok(TerminalCommit::Conflict);
            }
            tx.execute(
                "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
                 VALUES (?1, ?2, 'generation.cancelled', ?3, ?4)",
                params![run.run_id, seq, &event_payload, &updated_at],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation cancelled: terminal event"))?;
            Ok(TerminalCommit::Applied(seq))
        })?;
        match outcome {
            TerminalCommit::Applied(committed) => return Ok(committed),
            TerminalCommit::Conflict => {
                run = reload(db, &run.run_id)?;
                if run.status == "cancelling" || run.cancel_requested {
                    // Another cancel raced us; retry the cancelled commit.
                    continue;
                }
                if is_terminal(&run.status) {
                    return Ok(run.last_event_sequence);
                }
            }
        }
    }
    Err(internal(
        "generation cancelled commit could not make progress",
    ))
}

/// Shutdown mid-run: the run stays non-terminal (recovery marks it
/// `interrupted` on the next open) but its lease is cleared so recovery can
/// act immediately. No terminal event is committed.
fn commit_shutdown_progress(db: &mut Database, run: &RunRow) -> Result<(), KernelError> {
    let updated_at = now();
    let _ = db.transaction(|tx| {
        tx.execute(
            "UPDATE generation_runs SET lease_expires_at = NULL, revision = revision + 1, \
             updated_at = ?1 WHERE id = ?2 AND revision = ?3",
            params![&updated_at, run.run_id, run.revision],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation shutdown: progress commit"))
    })?;
    Ok(())
}

/// Runs the generation executor for `stream_id` inline on the writer thread.
///
/// Between provider steps `drain` is invoked (it services queued unary
/// operations — notably `generation.cancel` — and reports whether a shutdown
/// was requested). On shutdown the executor commits progress and exits; the
/// run stays non-terminal for startup recovery.
///
/// Phase 7: the run is executed by the adapter resolved from `registry`
/// (`run.provider`, defaulting to `"fake"`), with a per-run deadline of
/// `run_timeout` and the host-provided `_secret_resolver` seam available to
/// adapters (the built-ins ignore it). Deltas stream through the `emit`
/// bridge below, which re-checks the durable run between steps so late
/// output after a cancel never reaches the chat (§63).
#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_stream(
    db: &mut Database,
    stream_id: &str,
    notice_tx: &mpsc::Sender<StreamNotice>,
    drain: &mut dyn FnMut(&mut Database) -> bool,
    lease_owner: &str,
    registry: &ProviderRegistry,
    run_timeout: Duration,
    secret_resolver: Option<Arc<dyn SecretResolver>>,
    cancel: &CancellationFlag,
) -> Result<(), KernelError> {
    let mut run = reload(db, stream_id)?;
    // First step boundary: service anything queued during setup.
    if drain(db) {
        commit_shutdown_progress(db, &run)?;
        return Ok(());
    }
    run = reload(db, stream_id)?;
    // queued → preparing (before provider resolution).
    match cas_status(db, run, "preparing", lease_owner)? {
        StepOutcome::Proceed(next) => run = *next,
        StepOutcome::Cancelled(seq) => {
            send_terminal(notice_tx, seq);
            return Ok(());
        }
        StepOutcome::AlreadyTerminal => return Ok(()),
    }
    // preparing → streaming (before the first delta).
    match cas_status(db, run, "streaming", lease_owner)? {
        StepOutcome::Proceed(next) => run = *next,
        StepOutcome::Cancelled(seq) => {
            send_terminal(notice_tx, seq);
            return Ok(());
        }
        StepOutcome::AlreadyTerminal => return Ok(()),
    }
    // Provider resolution: an unknown provider fails the run with a terminal
    // `generation.failed` event (unchanged product behavior).
    let provider_name = run.provider.clone().unwrap_or_else(|| "fake".to_string());
    let adapter = match registry.find(&provider_name) {
        Some(adapter) => adapter,
        None => {
            let error = error_dto("PROVIDER_UNAVAILABLE", &[("provider", provider_name)]);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            return Ok(());
        }
    };
    // Build the sanitized provider request from the durable snapshot: the
    // input is the snapshot's `message` string (missing/non-string → "").
    let model = run.model.clone().unwrap_or_default();
    let input = snapshot_message(&run.request_snapshot_json);
    let run_key = format!("{}|{}", run.chat_id, run.attempt);
    // Resolve the provider secret (API key) at execution time (ТЗ §9.4):
    // the first stored provider config for this provider, alphabetically by
    // name, contributes its `secret_ref`; the kernel resolves it through the
    // host's SecretResolver seam just-in-time and drops it after the
    // attempt. No store/resolver/config → `None` (adapters decide).
    let api_key = match resolve_provider_api_key(db, &provider_name, secret_resolver.as_deref()) {
        Ok(key) => key,
        Err(err) => {
            let error = provider_error_dto(&err, &run.run_id, &provider_name, &model);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            return Ok(());
        }
    };
    // Prompt pipeline (ТЗ §9.2, Этап 2.6): build the immutable PromptPlan —
    // character/persona/lorebook system blocks + bounded selected history +
    // the user message, with a heuristic token budget and explicit
    // truncation — and store it durably BEFORE the provider attempt. The
    // plan's instruct-neutral message array is what the provider serializes
    // (adapters fall back to `input` when no plan is present). A plan that
    // cannot be built or stored fails the run with a stable
    // `PROMPT_PLAN_FAILED` terminal: the pipeline is now mandatory for run
    // execution, and a run must not execute without the context it claims.
    let context_limit = adapter
        .models()
        .iter()
        .find(|m| m.id == model)
        .and_then(|m| m.context_limit)
        .unwrap_or(0);
    let plan = match crate::prompt::build_prompt_plan(
        db,
        &crate::prompt::PlanInput {
            run_id: run.run_id.clone(),
            chat_id: run.chat_id.clone(),
            message: &input,
            provider: &provider_name,
            model: &model,
            context_limit,
            response_reserved: 0,
        },
    ) {
        Ok(plan) => plan,
        Err(_err) => {
            let error = error_dto("PROMPT_PLAN_FAILED", &[("runId", run.run_id.clone())]);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            return Ok(());
        }
    };
    if let Err(err) = crate::prompt::insert_prompt_plan(db, &plan) {
        let error = error_dto("PROMPT_PLAN_FAILED", &[("runId", run.run_id.clone())]);
        let seq = terminal_failed(db, run, error, lease_owner)?;
        send_terminal(notice_tx, seq);
        return Err(err);
    }
    let plan_messages: Vec<provider_sdk::PromptMessage<'_>> = plan
        .messages
        .iter()
        .map(|m| provider_sdk::PromptMessage {
            role: &m.role,
            content: &m.content,
        })
        .collect();
    let request = provider_sdk::ProviderRequest {
        provider_id: adapter.id(),
        model: &model,
        input: &input,
        run_key: &run_key,
        deadline: Some(provider_sdk::policy::Deadline::after(run_timeout)),
        api_key: api_key.as_deref(),
        messages: Some(&plan_messages),
    };
    let cancel_token = provider_sdk::CancelToken::new(cancel.0.as_ref());
    let mut shutdown_seen = false;
    let mut emit_error: Option<KernelError> = None;
    // 0-based delta index (checkpoint rhythm) == committed delta count.
    let mut emitted = 0usize;
    let mut emit = |event: provider_sdk::ProviderEvent| -> provider_sdk::EmitStatus {
        let provider_sdk::ProviderEvent::Delta { text } = event;
        // (a) Service queued commands; a shutdown commits progress and stops.
        if drain(db) {
            shutdown_seen = true;
            return provider_sdk::EmitStatus::Stop;
        }
        // (b) Re-read: a durable cancel (or a shutdown-flavoured conflict)
        // decides this delta; late deltas are never committed.
        match reload(db, stream_id) {
            Ok(next) => run = next,
            Err(err) => {
                emit_error = Some(err);
                return provider_sdk::EmitStatus::Stop;
            }
        }
        if run.status == "cancelling" || run.cancel_requested {
            return provider_sdk::EmitStatus::Stop;
        }
        if is_terminal(&run.status) {
            return provider_sdk::EmitStatus::Stop;
        }
        // (c) Durable commit; a lost CAS re-reads on the next emit (loop-top
        // semantics preserved).
        match commit_delta(db, &run, &text, emitted, notice_tx, lease_owner) {
            Ok(DeltaOutcome::Applied(next)) => run = *next,
            Ok(DeltaOutcome::Conflict) => {}
            Err(err) => {
                emit_error = Some(err);
                return provider_sdk::EmitStatus::Stop;
            }
        }
        emitted += 1;
        provider_sdk::EmitStatus::Continue
    };
    let result = adapter.generate(&request, cancel_token, &mut emit);
    // A commit-side failure (storage, invariant) wins over whatever the
    // adapter reported — the run stays non-terminal for startup recovery.
    if let Some(err) = emit_error {
        return Err(err);
    }
    if shutdown_seen {
        commit_shutdown_progress(db, &run)?;
        return Ok(());
    }
    match result {
        Ok(_usage) => {
            // All deltas committed: atomic terminal commit.
            let full_text = concat_delta_text(db.conn(), stream_id)?;
            let seq = terminal_completed(db, run, &full_text, lease_owner)?;
            send_terminal(notice_tx, seq);
            Ok(())
        }
        Err(err) => {
            use provider_sdk::ProviderErrorCode as Code;
            // A cancelled attempt (executor Stop, adapter-observed cancel)
            // commits the durable cancelled terminal — not a failure.
            if err.code == Code::Cancelled {
                let seq = terminal_cancelled(db, run, lease_owner)?;
                send_terminal(notice_tx, seq);
                return Ok(());
            }
            let error = provider_error_dto(&err, &run.run_id, &provider_name, &model);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            Ok(())
        }
    }
}

/// Maps a normalized provider error to the terminal `generation.failed`
/// [`ErrorDto`] (stable wire codes, params only — never the message, never
/// secret or raw payload material).
fn provider_error_dto(
    err: &provider_sdk::ProviderError,
    run_id: &str,
    provider: &str,
    model: &str,
) -> ErrorDto {
    use provider_sdk::ProviderErrorCode as Code;
    match err.code {
        Code::StepFailed => {
            let mut params = vec![("runId".to_string(), run_id.to_string())];
            if let Some((_, step)) = err.params.iter().find(|(key, _)| key == "step") {
                params.push(("step".to_string(), step.clone()));
            }
            error_dto(
                "PROVIDER_STEP_FAILED",
                &params
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.clone()))
                    .collect::<Vec<_>>(),
            )
        }
        Code::Timeout => error_dto("PROVIDER_TIMEOUT", &[("runId", run_id.to_string())]),
        Code::NetworkFault => error_dto("PROVIDER_NETWORK_FAULT", &[("runId", run_id.to_string())]),
        Code::Unavailable => error_dto(
            "PROVIDER_UNAVAILABLE",
            &[("provider", provider.to_string())],
        ),
        Code::RequestInvalid => {
            let model_param = err
                .params
                .iter()
                .find(|(key, _)| key == "model")
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| model.to_string());
            error_dto("PROVIDER_MODEL_INVALID", &[("model", model_param)])
        }
        // Cancelled is handled by the caller (durable cancelled terminal).
        Code::Cancelled => error_dto("PROVIDER_CANCELLED", &[("runId", run_id.to_string())]),
    }
}

/// The sanitized input handed to the provider: the `message` string from the
/// run's request snapshot. A missing/non-string field (or a tampered
/// snapshot) yields `""` — never a panic on stored payloads.
fn snapshot_message(snapshot_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(snapshot_json)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Resolves the run's provider API key at execution time (ТЗ §9.4).
///
/// The first `provider_configs` row for the run's provider (alphabetically
/// by name) contributes its `secret_ref`; the host's SecretResolver seam
/// turns it into the value used only to build the outgoing provider request.
///
/// - No config / no `secret_ref` → `Ok(None)` (adapter decides; a keyless
///   adapter errors itself).
/// - A config with a `secret_ref` but no resolver seam → fail-closed
///   `ProviderError::Unavailable` (no plaintext fallback, §87).
/// - Resolver failures propagate as typed provider errors (terminal run).
fn resolve_provider_api_key(
    db: &Database,
    provider: &str,
    resolver: Option<&dyn SecretResolver>,
) -> Result<Option<String>, provider_sdk::ProviderError> {
    let secret_ref: Option<String> = db
        .conn()
        .query_row(
            "SELECT secret_ref FROM provider_configs WHERE provider = ?1 \
             ORDER BY name ASC LIMIT 1",
            params![provider],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| {
            provider_sdk::ProviderError::with(
                provider_sdk::ProviderErrorCode::StepFailed,
                "failed to read provider secret reference",
                vec![("provider".to_string(), provider.to_string())],
            )
        })?
        .flatten();
    let Some(reference) = secret_ref else {
        return Ok(None);
    };
    let resolver = resolver.ok_or_else(|| {
        provider_sdk::ProviderError::with(
            provider_sdk::ProviderErrorCode::Unavailable,
            "secure storage is not available to resolve the provider secret",
            vec![("provider".to_string(), provider.to_string())],
        )
    })?;
    let value = resolver
        .resolve(&provider_sdk::secret::SecretRef(reference))
        .map_err(|mut err| {
            if err.params.is_empty() {
                err.params
                    .push(("provider".to_string(), provider.to_string()));
            }
            err
        })?;
    Ok(Some(value.expose().to_string()))
}

// ---------------------------------------------------------------------------
// Startup recovery (design §5)
// ---------------------------------------------------------------------------

/// Startup recovery, run once by the writer thread before serving commands:
/// every non-terminal run whose lease has expired (or was cleared) is marked
/// `interrupted` for the attempt. The exclusive data-root lease guarantees no
/// live executor elsewhere, so this is the lease/identity check ТЗ §63
/// requires.
pub(crate) fn recover(db: &mut Database) -> Result<(), KernelError> {
    let updated_at = now();
    db.transaction(|tx| {
        tx.execute(
            "UPDATE generation_runs SET status = 'interrupted', lease_expires_at = NULL, \
             revision = revision + 1, updated_at = ?1 \
             WHERE status IN ('queued','preparing','streaming','cancelling') \
               AND (lease_expires_at IS NULL OR lease_expires_at < ?1)",
            params![&updated_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation recovery: interrupt stale runs"))
    })?;
    Ok(())
}
