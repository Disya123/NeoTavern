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
    self, ErrorDto, EventEnvelope, FreeObject, GenerationEvent, GenerationRun, GenerationStatus,
    GenerationStep, MessageDto, MessageRole, PagedGenerationEvents, ResultEmpty,
};
use contracts_generated::Issue;
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use provider_sdk::secret::SecretResolver;
use provider_sdk::ProviderAdapter;
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
    /// The outstanding normalized tool call of a waiting-for-tool run
    /// (migration 6). `Some` means the run is durably waiting on the host's
    /// `generation.tool.result` for this exact tool call.
    pending_tool_call_json: Option<String>,
    lease_expires_at: Option<String>,
    started_at: String,
    updated_at: String,
}

/// Column list shared by every `generation_runs` read.
const RUN_COLUMNS: &str = "id, source_run_id, chat_id, attempt, status, provider, model, \
     request_snapshot_json, revision, cancel_requested, last_event_sequence, partial_length, \
     error_json, message_id, pending_tool_call_json, lease_expires_at, started_at, updated_at";

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
        pending_tool_call_json: row
            .get(14)
            .map_err(|e| sqlite(e, "generation: read pending_tool_call_json"))?,
        lease_expires_at: row
            .get(15)
            .map_err(|e| sqlite(e, "generation: read lease_expires_at"))?,
        started_at: row
            .get(16)
            .map_err(|e| sqlite(e, "generation: read started_at"))?,
        updated_at: row
            .get(17)
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
        status: run_status_enum(run)?,
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

/// The wire run status: the v3 `CHECK` stores `streaming` while a run waits
/// on a tool result (migration 6 keeps the CHECK untouched), so the wire
/// `waiting_for_tool` status is DERIVED from the pending-tool marker (ТЗ
/// §8.3: `WaitingForTool` is the durable waiting state).
fn run_status_enum(run: &RunRow) -> Result<GenerationStatus, KernelError> {
    if run.status == "streaming" && run.pending_tool_call_json.is_some() {
        return Ok(GenerationStatus::WaitingForTool);
    }
    status_enum(&run.status)
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
///
/// A **waiting-for-tool** run (§8.3) has NO live executor — its stream
/// session ended at the durable waiting transition — so `generation.cancel`
/// finalizes the `cancelled` terminal itself (marker cleared), matching
/// `WaitingForTool → Cancelling → Cancelled`.
pub(crate) fn generation_cancel(
    db: &mut Database,
    request: &[u8],
    lease_owner: &str,
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_cancel_generation(request)?;
    let run_id = req.workflow_id.clone();
    let mut run = load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    let updated_at = now();
    let mut done = false;
    for _ in 0..8 {
        match run.status.as_str() {
            "queued" | "preparing" | "streaming" => {
                let was_waiting = run.pending_tool_call_json.is_some();
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
                // No executor is left to observe the flag on a waiting run:
                // finalize the cancel durably (clears the pending marker).
                if was_waiting {
                    run = reload(db, &run_id)?;
                    let _seq = terminal_cancelled(db, run, lease_owner)?;
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
    // A waiting-for-tool run has no partial output yet and must not be
    // treated as a keep failure: return the run (the UI shows the waiting
    // state and the tool call step).
    if run.pending_tool_call_json.is_some() {
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
                    "UPDATE generation_runs SET partial_length = 0, \
                     pending_tool_call_json = NULL, revision = revision + 1, \
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
    // Вход, линия 2 (defense-in-depth on the writer thread): reject
    // over-limit payloads BEFORE any parse.
    crate::enforce_request_limit(op, request)?;
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

// ---------------------------------------------------------------------------
// Durable step journal (ТЗ §8.3, Этап 2.7)
// ---------------------------------------------------------------------------

/// The next per-run step sequence (0-based, gapless): `MAX(sequence)+1`.
fn next_step_sequence(conn: &rusqlite::Connection, run_id: &str) -> Result<i64, KernelError> {
    conn.query_row(
        "SELECT COALESCE(MAX(sequence), -1) + 1 FROM generation_steps WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )
    .map_err(|e| sqlite(e, "generation: next step sequence"))
}

/// Serializes a step DTO to its stored `input_json`/`output_json` (bounded
/// JSON, never secrets).
fn step_json(value: &serde_json::Value) -> Result<String, KernelError> {
    serde_json::to_string(value)
        .map_err(|e| internal(format!("generation step payload: serialize: {e}")))
}

/// Outcome of a step-commit attempt (mirrors [`DeltaOutcome`]).
enum StepCommit {
    /// Committed; carries the fresh row.
    Applied(Box<RunRow>),
    /// The CAS lost; the caller re-reads and reacts.
    Conflict,
}

/// Commits ONE immutable step row (`generation_steps`) plus its
/// `generation.step` event, in ONE transaction with a CAS on the run's
/// `revision`/`last_event_sequence` (mirrors [`commit_delta`]).
#[allow(clippy::too_many_arguments)]
fn commit_step(
    db: &mut Database,
    run: &RunRow,
    step_type: &str,
    status: &str,
    idempotency_key: &str,
    input: Option<&serde_json::Value>,
    output: Option<&serde_json::Value>,
    notice_tx: &mpsc::Sender<StreamNotice>,
    lease_owner: &str,
) -> Result<StepCommit, KernelError> {
    let seq = run.last_event_sequence + 1;
    let step_seq = next_step_sequence(db.conn(), &run.run_id)?;
    let step_id = new_id();
    let created_at = now();
    let input_json = match input {
        Some(value) => step_json(value)?,
        None => "{}".to_string(),
    };
    let output_json = match output {
        Some(value) => Some(step_json(value)?),
        None => None,
    };
    let dto = GenerationStep {
        step_id: step_id.clone(),
        run_id: run.run_id.clone(),
        sequence: step_seq,
        r#type: step_type_enum(step_type)?,
        status: step_status_enum(status)?,
        attempt: run.attempt,
        idempotency_key: idempotency_key.to_string(),
        input: input.cloned(),
        output: output.cloned(),
        error: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };
    validate(&dto, generated::validate_generation_step)?;
    let event_payload = event_payload(&GenerationEvent::GenerationStep { step: dto })?;
    let changed = db.transaction(|tx| {
        let changed = tx
            .execute(
                "UPDATE generation_runs SET last_event_sequence = ?1, revision = revision + 1, \
                 lease_owner = ?2, lease_expires_at = ?3, updated_at = ?4 \
                 WHERE id = ?5 AND revision = ?6",
                params![
                    seq,
                    lease_owner,
                    &lease_expires(),
                    &created_at,
                    run.run_id,
                    run.revision
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: step cas"))?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO generation_steps \
             (run_id, sequence, step_id, step_type, status, attempt, idempotency_key, \
              input_json, output_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                run.run_id,
                step_seq,
                &step_id,
                step_type,
                status,
                run.attempt,
                idempotency_key,
                &input_json,
                &output_json,
                &created_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: step insert"))?;
        tx.execute(
            "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
             VALUES (?1, ?2, 'generation.step', ?3, ?4)",
            params![run.run_id, seq, &event_payload, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: step event"))?;
        Ok(true)
    })?;
    if !changed {
        return Ok(StepCommit::Conflict);
    }
    send_committed(notice_tx, seq);
    Ok(StepCommit::Applied(Box::new(reload(db, &run.run_id)?)))
}

/// Maps a step type string to the wire enum (values are kernel-internal
/// constants; an unexpected value is a controlled internal error).
fn step_type_enum(step_type: &str) -> Result<generated::GenerationStepType, KernelError> {
    use generated::GenerationStepType as T;
    Ok(match step_type {
        "provider_turn" => T::ProviderTurn,
        "tool_call" => T::ToolCall,
        "tool_result" => T::ToolResult,
        "final_commit" => T::FinalCommit,
        other => {
            return Err(internal(format!("invalid generation step type: {other}")));
        }
    })
}

/// Maps a step status string to the wire enum (values are kernel-internal
/// constants; an unexpected value is a controlled internal error).
fn step_status_enum(step_status: &str) -> Result<generated::GenerationStepStatus, KernelError> {
    use generated::GenerationStepStatus as S;
    Ok(match step_status {
        "running" => S::Running,
        "waiting" => S::Waiting,
        "completed" => S::Completed,
        "failed" => S::Failed,
        other => {
            return Err(internal(format!("invalid generation step status: {other}")));
        }
    })
}

/// Commits the durable waiting transition of a run whose provider turn
/// produced a tool call (ТЗ §8.3): ONE transaction CASes the run
/// (`last_event_sequence += 2`, `pending_tool_call_json` set, lease refresh),
/// then journals the `provider_turn` step (completed) and the `tool_call`
/// step (waiting) with their `generation.step` events. The run keeps
/// `status = 'streaming'`; the wire derives `waiting_for_tool`.
fn commit_tool_call_transition(
    db: &mut Database,
    run: &RunRow,
    tool_call: &generated::ToolCall,
    notice_tx: &mpsc::Sender<StreamNotice>,
    lease_owner: &str,
) -> Result<StepCommit, KernelError> {
    let seq1 = run.last_event_sequence + 1;
    let seq2 = run.last_event_sequence + 2;
    let step_seq = next_step_sequence(db.conn(), &run.run_id)?;
    let provider_step_id = new_id();
    let tool_step_id = new_id();
    let created_at = now();
    let input_json = serde_json::to_string(&serde_json::json!({ "toolCall": tool_call }))
        .map_err(|e| internal(format!("tool call payload: serialize: {e}")))?;
    let tool_call_json = serde_json::to_string(tool_call)
        .map_err(|e| internal(format!("pending tool call: serialize: {e}")))?;
    let turn_dto = GenerationStep {
        step_id: provider_step_id.clone(),
        run_id: run.run_id.clone(),
        sequence: step_seq,
        r#type: generated::GenerationStepType::ProviderTurn,
        status: generated::GenerationStepStatus::Completed,
        attempt: run.attempt,
        idempotency_key: format!("turn-{seq1}"),
        input: Some(serde_json::json!({ "model": run.model })),
        output: None,
        error: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };
    let call_dto = GenerationStep {
        step_id: tool_step_id.clone(),
        run_id: run.run_id.clone(),
        sequence: step_seq + 1,
        r#type: generated::GenerationStepType::ToolCall,
        status: generated::GenerationStepStatus::Waiting,
        attempt: run.attempt,
        idempotency_key: format!("tool-call-{}", tool_call.id),
        input: Some(serde_json::json!({ "toolCall": tool_call })),
        output: None,
        error: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };
    validate(&turn_dto, generated::validate_generation_step)?;
    validate(&call_dto, generated::validate_generation_step)?;
    let turn_payload = event_payload(&GenerationEvent::GenerationStep { step: turn_dto })?;
    let call_payload = event_payload(&GenerationEvent::GenerationStep { step: call_dto })?;
    let changed = db.transaction(|tx| {
        let changed = tx
            .execute(
                "UPDATE generation_runs SET last_event_sequence = ?1, \
                 pending_tool_call_json = ?2, revision = revision + 1, lease_owner = ?3, \
                 lease_expires_at = ?4, updated_at = ?5 WHERE id = ?6 AND revision = ?7",
                params![
                    seq2,
                    &tool_call_json,
                    lease_owner,
                    &lease_expires(),
                    &created_at,
                    run.run_id,
                    run.revision
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: tool-call cas"))?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO generation_steps \
             (run_id, sequence, step_id, step_type, status, attempt, idempotency_key, \
              input_json, output_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'provider_turn', 'completed', ?4, ?5, '{}', NULL, ?6, ?6)",
            params![
                run.run_id,
                step_seq,
                &provider_step_id,
                run.attempt,
                format!("turn-{seq1}"),
                &created_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: turn step insert"))?;
        tx.execute(
            "INSERT INTO generation_steps \
             (run_id, sequence, step_id, step_type, status, attempt, idempotency_key, \
              input_json, output_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'tool_call', 'waiting', ?4, ?5, ?6, NULL, ?7, ?7)",
            params![
                run.run_id,
                step_seq + 1,
                &tool_step_id,
                run.attempt,
                format!("tool-call-{}", tool_call.id),
                &input_json,
                &created_at
            ],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: tool-call step insert"))?;
        tx.execute(
            "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
             VALUES (?1, ?2, 'generation.step', ?3, ?4)",
            params![run.run_id, seq1, &turn_payload, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: turn step event"))?;
        tx.execute(
            "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
             VALUES (?1, ?2, 'generation.step', ?3, ?4)",
            params![run.run_id, seq2, &call_payload, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: tool-call step event"))?;
        Ok(true)
    })?;
    if !changed {
        return Ok(StepCommit::Conflict);
    }
    send_committed(notice_tx, seq1);
    send_committed(notice_tx, seq2);
    Ok(StepCommit::Applied(Box::new(reload(db, &run.run_id)?)))
}

/// Commits the `tool_result` step and clears the run's pending marker —
/// the durable resume of a waiting-for-tool run (ТЗ §8.3
/// `WaitingForTool → Running`). ONE transaction: CAS (`last_event_sequence`,
/// `pending_tool_call_json = NULL`), insert the step row, insert the
/// `generation.step` event.
fn commit_tool_result_step(
    db: &mut Database,
    run: &RunRow,
    tool_call: &generated::ToolCall,
    result: &serde_json::Value,
    notice_tx: &mpsc::Sender<StreamNotice>,
    lease_owner: &str,
) -> Result<StepCommit, KernelError> {
    let seq = run.last_event_sequence + 1;
    let step_seq = next_step_sequence(db.conn(), &run.run_id)?;
    let step_id = new_id();
    let created_at = now();
    let dto = GenerationStep {
        step_id: step_id.clone(),
        run_id: run.run_id.clone(),
        sequence: step_seq,
        r#type: generated::GenerationStepType::ToolResult,
        status: generated::GenerationStepStatus::Completed,
        attempt: run.attempt,
        idempotency_key: format!("tool-result-{}", tool_call.id),
        input: Some(serde_json::json!({ "toolCall": tool_call })),
        output: Some(result.clone()),
        error: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };
    validate(&dto, generated::validate_generation_step)?;
    let event_payload = event_payload(&GenerationEvent::GenerationStep { step: dto })?;
    let input_json = serde_json::to_string(&serde_json::json!({ "toolCall": tool_call }))
        .map_err(|e| internal(format!("tool result payload: serialize: {e}")))?;
    let output_json = serde_json::to_string(result)
        .map_err(|e| internal(format!("tool result payload: serialize: {e}")))?;
    let changed = db.transaction(|tx| {
        let changed = tx
            .execute(
                "UPDATE generation_runs SET last_event_sequence = ?1, pending_tool_call_json = NULL, \
                 revision = revision + 1, lease_owner = ?2, lease_expires_at = ?3, updated_at = ?4 \
                 WHERE id = ?5 AND revision = ?6",
                params![
                    seq,
                    lease_owner,
                    &lease_expires(),
                    &created_at,
                    run.run_id,
                    run.revision
                ],
            )
            .map_err(|e| StorageError::from_sqlite(e, "generation: tool-result cas"))?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO generation_steps \
             (run_id, sequence, step_id, step_type, status, attempt, idempotency_key, \
              input_json, output_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'tool_result', 'completed', ?4, ?5, ?6, ?7, ?8, ?8)",
            params![run.run_id, step_seq, &step_id, run.attempt, format!("tool-result-{}", tool_call.id), &input_json, &output_json, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: tool-result step insert"))?;
        tx.execute(
            "INSERT INTO generation_events (run_id, sequence, type, payload_json, created_at) \
             VALUES (?1, ?2, 'generation.step', ?3, ?4)",
            params![run.run_id, seq, &event_payload, &created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation: tool-result step event"))?;
        Ok(true)
    })?;
    if !changed {
        return Ok(StepCommit::Conflict);
    }
    send_committed(notice_tx, seq);
    Ok(StepCommit::Applied(Box::new(reload(db, &run.run_id)?)))
}

/// Journals the closing steps of a successful run (provider turn completed +
/// final commit completed) before the atomic terminal commit. Both steps are
/// advisory diagnostics; the durable message row + `generation.completed`
/// event remain the canonical terminal record.
fn commit_turn_final_steps(
    db: &mut Database,
    run: &RunRow,
    notice_tx: &mpsc::Sender<StreamNotice>,
    lease_owner: &str,
) -> Result<(), KernelError> {
    let run = run.clone();
    match commit_step(
        db,
        &run,
        "provider_turn",
        "completed",
        &format!("turn-{}", run.last_event_sequence + 1),
        Some(&serde_json::json!({ "model": run.model })),
        None,
        notice_tx,
        lease_owner,
    )? {
        StepCommit::Applied(next) => {
            commit_step(
                db,
                &next,
                "final_commit",
                "completed",
                "final",
                Some(&serde_json::json!({})),
                None,
                notice_tx,
                lease_owner,
            )?;
        }
        StepCommit::Conflict => {
            // Lost CAS: the run changed under us; the terminal commit below
            // re-reads and reacts. Steps are advisory, so proceed.
        }
    }
    Ok(())
}

/// `TOOL_RESULT_STALE` product error: a tool result submitted for a run that
/// is not waiting on the matching tool call.
fn tool_result_stale(run_id: &str, tool_call_id: &str) -> KernelError {
    KernelError::product(
        "TOOL_RESULT_STALE",
        vec![
            ("runId".to_string(), run_id.to_string()),
            ("toolCallId".to_string(), tool_call_id.to_string()),
        ],
    )
}

/// The prompt plan of a run, building and storing it on the FIRST turn and
/// loading the stored plan on resumed turns (idempotent by run id).
fn ensure_prompt_plan(
    db: &mut Database,
    run: &RunRow,
    provider: &str,
    model: &str,
    input: &str,
    adapter: &Arc<dyn ProviderAdapter>,
) -> Result<crate::prompt::PromptPlan, KernelError> {
    if crate::prompt::prompt_plan_exists(db, &run.run_id)? {
        return crate::prompt::load_prompt_plan(db, &run.run_id);
    }
    let context_limit = adapter
        .models()
        .iter()
        .find(|m| m.id == model)
        .and_then(|m| m.context_limit)
        .unwrap_or(0);
    let plan = crate::prompt::build_prompt_plan(
        db,
        &crate::prompt::PlanInput {
            run_id: run.run_id.clone(),
            chat_id: run.chat_id.clone(),
            message: input,
            provider,
            model,
            context_limit,
            response_reserved: 0,
        },
    )?;
    crate::prompt::insert_prompt_plan(db, &plan)?;
    Ok(plan)
}

/// The number of tool calls already committed for a run (the loop-guard
/// budget, ТЗ §8.3).
fn count_tool_calls(conn: &rusqlite::Connection, run_id: &str) -> Result<usize, KernelError> {
    conn.query_row(
        "SELECT COUNT(*) FROM generation_steps WHERE run_id = ?1 AND step_type = 'tool_call'",
        params![run_id],
        |row| row.get(0),
    )
    .map(|n: i64| n as usize)
    .map_err(|e| sqlite(e, "generation: count tool calls"))
}

/// The working context appended to a resumed provider turn (§8.3): the
/// assistant message carrying the tool call and the matching `tool`-role
/// result message. JSON-encoded payloads are staged in `scratch_json` and
/// the tool-call entry in `scratch_calls` (both owned by the caller) so the
/// returned messages can borrow them without leaking.
fn build_tool_context<'a>(
    tool_call: &'a generated::ToolCall,
    result: &'a serde_json::Value,
    scratch_json: &'a mut Vec<String>,
    scratch_calls: &'a mut Vec<provider_sdk::PromptToolCall<'a>>,
) -> Vec<provider_sdk::PromptMessage<'a>> {
    let arguments =
        serde_json::to_string(&tool_call.arguments).unwrap_or_else(|_| "{}".to_string());
    scratch_json.push(arguments);
    let result_json = serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string());
    scratch_json.push(result_json);
    let arguments_ref = &scratch_json[scratch_json.len() - 2];
    let result_ref = &scratch_json[scratch_json.len() - 1];
    scratch_calls.push(provider_sdk::PromptToolCall {
        id: &tool_call.id,
        name: &tool_call.name,
        arguments: arguments_ref,
    });
    vec![
        provider_sdk::PromptMessage {
            role: "assistant",
            content: "",
            tool_calls: Some(scratch_calls.as_slice()),
            tool_call_id: None,
        },
        provider_sdk::PromptMessage {
            role: "tool",
            content: result_ref,
            tool_calls: None,
            tool_call_id: Some(&tool_call.id),
        },
    ]
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
        meta: FreeObject {
            payload: serde_json::Value::Object(Default::default()),
        },
        checkpoint_chat_id: None,
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
                     pending_tool_call_json = NULL, last_event_sequence = ?2, \
                     revision = revision + 1, lease_owner = ?3, \
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
                     pending_tool_call_json = NULL, last_event_sequence = ?2, \
                     revision = revision + 1, lease_owner = ?3, \
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
                     pending_tool_call_json = NULL, last_event_sequence = ?1, \
                     revision = revision + 1, lease_owner = ?2, \
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

/// Outcome of one provider turn.
enum TurnOutcome {
    /// The run was committed terminal by this turn (completed / failed /
    /// cancelled / shutdown-progress).
    Terminal,
    /// The run is durably waiting on a tool result (`generation.tool.result`).
    WaitingForTool,
}

/// Runs ONE provider turn for a `streaming` run: resolves the adapter secret,
/// ensures the prompt plan, builds the provider request (plan messages +
/// resumed-turn tool context + declared tools), streams the adapter's deltas
/// through the emit bridge, and handles the outcome:
///
/// - a `ToolCall` event is validated against the tool registry (capability +
///   argument schema, §8.3) and, when valid, commits the durable waiting
///   transition; the turn ends `WaitingForTool`;
/// - an invalid/unknown tool call or an exhausted tool budget fails the run
///   with a stable terminal code;
/// - normal completion journals the closing steps and commits the atomic
///   terminal (one assistant message, §8.3);
/// - provider errors map to the stable terminal codes.
///
/// `drain` is the writer's command-drain seam (`None` on resumed turns run
/// from a unary operation, where no stream is active). `tool_call_count` is
/// the loop-guard budget (tool calls already committed for the run).
#[allow(clippy::too_many_arguments)]
fn provider_turn_once(
    db: &mut Database,
    mut run: RunRow,
    adapter: &Arc<dyn ProviderAdapter>,
    extra_messages: &[provider_sdk::PromptMessage<'_>],
    notice_tx: &mpsc::Sender<StreamNotice>,
    mut drain: Option<&mut dyn FnMut(&mut Database) -> bool>,
    lease_owner: &str,
    run_timeout: Duration,
    secret_resolver: Option<Arc<dyn SecretResolver>>,
    cancel: &CancellationFlag,
    tool_registry: &crate::tools::ToolRegistry,
    tool_call_count: usize,
) -> Result<TurnOutcome, KernelError> {
    let provider_name = run.provider.clone().unwrap_or_else(|| "fake".to_string());
    let model = run.model.clone().unwrap_or_default();
    let input = snapshot_message(&run.request_snapshot_json);
    let run_key = format!("{}|{}", run.chat_id, run.attempt);
    // Resolve the provider secret (API key) at execution time (ТЗ §9.4).
    let api_key = match resolve_provider_api_key(db, &provider_name, secret_resolver.as_deref()) {
        Ok(key) => key,
        Err(err) => {
            let error = provider_error_dto(&err, &run.run_id, &provider_name, &model);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            return Ok(TurnOutcome::Terminal);
        }
    };
    // Prompt pipeline: the first turn builds and stores the plan; resumed
    // turns load the stored plan (ТЗ §9.2, Этап 2.6/2.7).
    let plan = ensure_prompt_plan(db, &run, &provider_name, &model, &input, adapter)?;
    let mut plan_messages: Vec<provider_sdk::PromptMessage<'_>> = plan
        .messages
        .iter()
        .map(|m| provider_sdk::PromptMessage {
            role: &m.role,
            content: &m.content,
            tool_calls: None,
            tool_call_id: None,
        })
        .collect();
    plan_messages.extend_from_slice(extra_messages);
    let specs = tool_registry.list();
    let tool_specs: Vec<provider_sdk::ToolSpec<'_>> = specs
        .iter()
        .map(|s| provider_sdk::ToolSpec {
            id: &s.id,
            name: &s.name,
            description: &s.description,
            input_schema: &s.input_schema,
        })
        .collect();
    // Capability negotiation (ТЗ §9.3): when this turn would send tool
    // calls, a provider that does not declare tool support must fail BEFORE
    // the network request with `CAPABILITY_UNAVAILABLE` — never silently
    // degrade to a no-tools turn.
    if !tool_specs.is_empty() && !adapter.capabilities().tools {
        let error = error_dto(
            "CAPABILITY_UNAVAILABLE",
            &[
                ("provider", provider_name.clone()),
                ("model", model.clone()),
                ("capability", "tools".to_string()),
            ],
        );
        let seq = terminal_failed(db, run, error, lease_owner)?;
        send_terminal(notice_tx, seq);
        return Ok(TurnOutcome::Terminal);
    }
    let request = provider_sdk::ProviderRequest {
        provider_id: adapter.id(),
        model: &model,
        input: &input,
        run_key: &run_key,
        deadline: Some(provider_sdk::policy::Deadline::after(run_timeout)),
        api_key: api_key.as_deref(),
        messages: Some(&plan_messages),
        tools: if tool_specs.is_empty() {
            None
        } else {
            Some(&tool_specs)
        },
    };
    let cancel_token = provider_sdk::CancelToken::new(cancel.0.as_ref());
    let mut shutdown_seen = false;
    let mut emit_error: Option<KernelError> = None;
    // Set when this turn itself committed a terminal (tool rejection).
    let mut terminal_seq: Option<i64> = None;
    // Set when this turn durably committed the waiting transition.
    let mut waiting = false;
    // 0-based delta index (checkpoint rhythm) == committed delta count.
    let mut emitted = 0usize;
    let mut emit = |event: provider_sdk::ProviderEvent| -> provider_sdk::EmitStatus {
        match event {
            provider_sdk::ProviderEvent::Delta { text } => {
                // (a) Service queued commands; a shutdown commits progress.
                if let Some(drain) = drain.as_mut() {
                    if drain(db) {
                        shutdown_seen = true;
                        return provider_sdk::EmitStatus::Stop;
                    }
                }
                // (b) Re-read: a durable cancel decides this delta.
                match reload(db, &run.run_id) {
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
                // (c) Durable commit; a lost CAS re-reads on the next emit.
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
            }
            provider_sdk::ProviderEvent::ToolCall {
                id: _,
                name,
                arguments,
            } => {
                // (a) Service queued commands; a shutdown commits progress.
                if let Some(drain) = drain.as_mut() {
                    if drain(db) {
                        shutdown_seen = true;
                        return provider_sdk::EmitStatus::Stop;
                    }
                }
                // (b) Re-read: a durable cancel decides this tool call.
                match reload(db, &run.run_id) {
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
                // (c) Capability + schema validation (ТЗ §8.3): the call must
                // name a registered tool and conform to its input schema.
                let spec = match tool_registry.find(&name) {
                    Some(spec) => spec,
                    None => {
                        let error = error_dto("TOOL_NOT_FOUND", &[("toolName", name.clone())]);
                        let seq = match terminal_failed(db, run.clone(), error, lease_owner) {
                            Ok(seq) => seq,
                            Err(err) => {
                                emit_error = Some(err);
                                return provider_sdk::EmitStatus::Stop;
                            }
                        };
                        terminal_seq = Some(seq);
                        return provider_sdk::EmitStatus::Stop;
                    }
                };
                if let Err(message) =
                    crate::tools::validate_arguments(&spec.input_schema, &arguments)
                {
                    let error = error_dto(
                        "TOOL_ARGS_INVALID",
                        &[("toolName", name.clone()), ("detail", message)],
                    );
                    let seq = match terminal_failed(db, run.clone(), error, lease_owner) {
                        Ok(seq) => seq,
                        Err(err) => {
                            emit_error = Some(err);
                            return provider_sdk::EmitStatus::Stop;
                        }
                    };
                    terminal_seq = Some(seq);
                    return provider_sdk::EmitStatus::Stop;
                }
                // (d) Loop guard (budgets, §8.3): a run may perform at most
                // MAX_TOOL_CALLS tool calls.
                if tool_call_count >= crate::tools::MAX_TOOL_CALLS {
                    let error = error_dto(
                        "TOOL_LOOP_LIMIT",
                        &[("limit", crate::tools::MAX_TOOL_CALLS.to_string())],
                    );
                    let seq = match terminal_failed(db, run.clone(), error, lease_owner) {
                        Ok(seq) => seq,
                        Err(err) => {
                            emit_error = Some(err);
                            return provider_sdk::EmitStatus::Stop;
                        }
                    };
                    terminal_seq = Some(seq);
                    return provider_sdk::EmitStatus::Stop;
                }
                // (e) Durable waiting transition: the kernel assigns the
                // stable toolCallId (uuid), journals the provider turn + tool
                // call steps and stores the pending marker.
                let tool_call = generated::ToolCall {
                    id: new_id(),
                    name,
                    arguments,
                };
                match commit_tool_call_transition(db, &run, &tool_call, notice_tx, lease_owner) {
                    Ok(StepCommit::Applied(next)) => {
                        run = *next;
                        waiting = true;
                    }
                    Ok(StepCommit::Conflict) => {
                        // Lost CAS: re-read on the next emit; the adapter is
                        // stopped (this turn produced a tool call).
                        waiting = true;
                    }
                    Err(err) => {
                        emit_error = Some(err);
                    }
                }
                provider_sdk::EmitStatus::Stop
            }
        }
    };
    let result = adapter.generate(&request, cancel_token, &mut emit);
    // A commit-side failure (storage, invariant) wins over whatever the
    // adapter reported — the run stays non-terminal for startup recovery.
    if let Some(err) = emit_error {
        return Err(err);
    }
    if shutdown_seen {
        commit_shutdown_progress(db, &run)?;
        return Ok(TurnOutcome::Terminal);
    }
    // This turn committed a terminal itself (tool rejection): the terminal
    // event is already durable; deliver the notice and stop.
    if let Some(seq) = terminal_seq {
        send_terminal(notice_tx, seq);
        return Ok(TurnOutcome::Terminal);
    }
    if waiting {
        // The run is durably waiting for a tool result. The stream session
        // ends with a terminal notice (no further notices will arrive for
        // this stream); consumers follow the run via `generation.events` /
        // `generation.get` (status `waiting_for_tool`) and resume with
        // `generation.tool.result`.
        send_terminal(notice_tx, run.last_event_sequence);
        return Ok(TurnOutcome::WaitingForTool);
    }
    match result {
        Ok(_usage) => {
            // All deltas committed: journal the closing steps, then the
            // atomic terminal commit (one assistant message, §8.3).
            commit_turn_final_steps(db, &run, notice_tx, lease_owner)?;
            let full_text = concat_delta_text(db.conn(), &run.run_id)?;
            let seq = terminal_completed(db, run, &full_text, lease_owner)?;
            send_terminal(notice_tx, seq);
            Ok(TurnOutcome::Terminal)
        }
        Err(err) => {
            use provider_sdk::ProviderErrorCode as Code;
            // A cancelled attempt (executor Stop, adapter-observed cancel)
            // commits the durable cancelled terminal — not a failure.
            if err.code == Code::Cancelled {
                let seq = terminal_cancelled(db, run, lease_owner)?;
                send_terminal(notice_tx, seq);
                return Ok(TurnOutcome::Terminal);
            }
            let error = provider_error_dto(&err, &run.run_id, &provider_name, &model);
            let seq = terminal_failed(db, run, error, lease_owner)?;
            send_terminal(notice_tx, seq);
            Ok(TurnOutcome::Terminal)
        }
    }
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
/// adapters (the built-ins ignore it). Этап 2.7: a provider turn that emits a
/// normalized tool call leaves the run durably `waiting_for_tool`; the host
/// resumes it via `generation.tool.result`.
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
    tool_registry: &crate::tools::ToolRegistry,
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
    let mut drain = Some(drain);
    let _ = provider_turn_once(
        db,
        run,
        &adapter,
        &[],
        notice_tx,
        drain
            .as_mut()
            .map(|d| d as &mut dyn FnMut(&mut Database) -> bool),
        lease_owner,
        run_timeout,
        secret_resolver,
        cancel,
        tool_registry,
        0,
    )?;
    Ok(())
}

/// `generation.tool.result` — submit a tool result and resume a
/// waiting-for-tool run (ТЗ §8.3 `WaitingForTool → Running`).
///
/// Validates the run is durably waiting on the EXACT `toolCallId` (else a
/// stable `TOOL_RESULT_STALE`), journals the `tool_result` step, clears the
/// pending marker, appends the assistant tool-call + `tool`-role result to
/// the working context and runs the next provider turn inline. The response
/// is the run DTO — the run may be `completed`, `waiting_for_tool` (further
/// tool calls) or `failed` afterwards.
#[allow(clippy::too_many_arguments)]
pub(crate) fn generation_tool_result(
    db: &mut Database,
    request: &[u8],
    registry: &ProviderRegistry,
    tool_registry: &crate::tools::ToolRegistry,
    run_timeout: Duration,
    secret_resolver: Option<Arc<dyn SecretResolver>>,
    cancel: &CancellationFlag,
    lease_owner: &str,
) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_generation_tool_result(request)?;
    let run_id = req.run_id.clone();
    let run = load_run(db.conn(), &run_id)?.ok_or_else(|| run_not_found(&run_id))?;
    // The run must be durably waiting on this exact tool call.
    if run.status != "streaming" || run.pending_tool_call_json.is_none() {
        return Err(tool_result_stale(&run_id, &req.tool_call_id));
    }
    let pending_json = run.pending_tool_call_json.as_ref().expect("checked above");
    let pending: generated::ToolCall = serde_json::from_str(pending_json)
        .map_err(|e| internal(format!("pending tool call payload malformed: {e}")))?;
    if pending.id != req.tool_call_id {
        return Err(tool_result_stale(&run_id, &req.tool_call_id));
    }
    // Journal the durable tool_result step and clear the pending marker.
    let (notice_tx, _notice_rx) = mpsc::channel::<StreamNotice>();
    let next =
        match commit_tool_result_step(db, &run, &pending, &req.result, &notice_tx, lease_owner)? {
            StepCommit::Applied(next) => *next,
            StepCommit::Conflict => {
                return Err(internal("generation tool result could not make progress"));
            }
        };
    // Resolve the adapter (an unknown provider fails the resumed run).
    let provider_name = next.provider.clone().unwrap_or_else(|| "fake".to_string());
    let adapter = match registry.find(&provider_name) {
        Some(adapter) => adapter,
        None => {
            let error = error_dto("PROVIDER_UNAVAILABLE", &[("provider", provider_name)]);
            let seq = terminal_failed(db, next, error, lease_owner)?;
            send_terminal(&notice_tx, seq);
            let run = reload(db, &run_id)?;
            let dto = run_to_dto(db.conn(), &run)?;
            validate(&dto, generated::validate_generation_run)?;
            return encode(&dto);
        }
    };
    // Working context of the resumed turn (§8.3).
    let mut scratch_json: Vec<String> = Vec::new();
    let mut scratch_calls: Vec<provider_sdk::PromptToolCall<'_>> = Vec::new();
    let extra = build_tool_context(&pending, &req.result, &mut scratch_json, &mut scratch_calls);
    let tool_call_count = count_tool_calls(db.conn(), &run_id)?;
    let _ = provider_turn_once(
        db,
        next,
        &adapter,
        &extra,
        &notice_tx,
        None,
        lease_owner,
        run_timeout,
        secret_resolver,
        cancel,
        tool_registry,
        tool_call_count,
    )?;
    let run = reload(db, &run_id)?;
    let dto = run_to_dto(db.conn(), &run)?;
    validate(&dto, generated::validate_generation_run)?;
    encode(&dto)
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
            "UPDATE generation_runs SET status = 'interrupted', \
             pending_tool_call_json = NULL, lease_expires_at = NULL, \
             revision = revision + 1, updated_at = ?1 \
             WHERE status IN ('queued','preparing','streaming','cancelling') \
               AND (lease_expires_at IS NULL OR lease_expires_at < ?1)",
            params![&updated_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "generation recovery: interrupt stale runs"))
    })?;
    Ok(())
}
