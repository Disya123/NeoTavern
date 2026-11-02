//! App-event log (M7 Этап-4 cluster 18).
//!
//! The legacy contour pushed `chat.created`, `chat.message.*`,
//! `generation.finished/error`, `plugin.*` and `chat.message.block.changed`
//! over one SSE relay fed by an in-memory bus. The canonical plane has a
//! single writer and durable state, so the honest equivalent is an
//! append-only, resumable log instead of a socket:
//!
//! - every client-relevant mutation appends its event **inside the same
//!   transaction** as the data change, so no client can observe an event
//!   without its data (or a change without its event);
//! - subscribers resume from the last `sequence` they saw (`events.poll` with
//!   an exclusive `afterSequence`), so a reconnect or a second tab never
//!   depends on being connected at the exact moment of the change;
//! - the log is bounded by [`RETENTION`] rows, pruned by the writer in the
//!   same transaction, and a poll reports `truncated` when the requested
//!   cursor has already aged out — the subscriber then resets its caches
//!   instead of silently pretending it saw every change.
//!
//! Payloads are deliberately small and id-only (never message text or
//! secrets): the subscriber re-reads what it needs through the normal read
//! operations, so an event can never smuggle stale product data.
//!
//! The push transport is a host concern and not part of this contract: the
//! wire exposes the cursor, and each host may poll it, bridge it to SSE, or
//! forward it into the plugin sandbox.

use contracts_generated::generated::{self, AppEvent, FreeObject, ResultAppEventsPage};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, Connection};
use serde_json::Value;

use crate::product::{self, now};
use crate::KernelError;

/// How many events the log keeps. Older rows are pruned by the writer inside
/// the same transaction as the mutation; a cursor that fell out of the window
/// yields `truncated`.
pub(crate) const RETENTION: i64 = 2048;

/// Durable names of the events the kernel emits. They mirror the legacy
/// browser relay (`BROWSER_APP_EVENTS` in `@neotavern/contracts`) plus the
/// host-side plugin and message-block events that relay forwarded; the kernel
/// invents no name the subscribers cannot already handle.
pub(crate) const CHAT_CREATED: &str = "chat.created";
pub(crate) const CHAT_MESSAGE_CREATED: &str = "chat.message.created";
pub(crate) const CHAT_MESSAGE_UPDATED: &str = "chat.message.updated";
pub(crate) const CHAT_MESSAGE_DELETED: &str = "chat.message.deleted";
pub(crate) const CHAT_MESSAGE_BLOCK_CHANGED: &str = "chat.message.block.changed";
pub(crate) const GENERATION_FINISHED: &str = "generation.finished";
pub(crate) const GENERATION_ERROR: &str = "generation.error";
pub(crate) const PLUGIN_INSTALLED: &str = "plugin.installed";
pub(crate) const PLUGIN_ACTIVATED: &str = "plugin.activated";
pub(crate) const PLUGIN_DISABLED: &str = "plugin.disabled";
pub(crate) const PLUGIN_DELETED: &str = "plugin.deleted";

/// Append one event to the durable log and prune rows outside the retention
/// window. Call this inside the transaction that performs the mutation.
pub(crate) fn append(conn: &Connection, event: &str, payload: Value) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO app_events (event, payload_json, created_at) VALUES (?1, ?2, ?3)",
        params![event, payload.to_string(), now()],
    )
    .map_err(|e| StorageError::from_sqlite(e, "app_events: insert"))?;
    let max: Option<i64> = conn
        .query_row("SELECT MAX(sequence) FROM app_events", [], |row| row.get(0))
        .map_err(|e| StorageError::from_sqlite(e, "app_events: max sequence"))?;
    if let Some(max) = max {
        let cutoff = max - RETENTION;
        if cutoff > 0 {
            conn.execute(
                "DELETE FROM app_events WHERE sequence <= ?1",
                params![cutoff],
            )
            .map_err(|e| StorageError::from_sqlite(e, "app_events: prune"))?;
        }
    }
    Ok(())
}

/// Convenience wrapper for the id-only payloads every emission uses.
pub(crate) fn payload(entries: &[(&str, &str)]) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert((*key).to_string(), Value::String((*value).to_string()));
    }
    Value::Object(map)
}

/// `chat.message.block.changed` payload: which block of which message of
/// which chat changed (the legacy relay forwarded the same three ids).
pub(crate) fn block_payload(chat_id: &str, message_id: &str, block_id: &str) -> Value {
    payload(&[
        ("chatId", chat_id),
        ("messageId", message_id),
        ("blockId", block_id),
    ])
}

/// `events.poll` — one page of the app-event log after an exclusive cursor.
/// Resumable, side-effect free and monotonic: the client echoes the last
/// `sequence` it saw. `truncated` marks a cursor that aged out of retention.
pub(crate) fn events_poll(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_app_events_poll(request)?;
    let after = req.after_sequence.unwrap_or(-1);
    let limit = product::page_limit(req.limit);
    let mut items: Vec<AppEvent> = Vec::new();
    let mut has_more = false;
    let truncated;
    {
        let conn = db.conn();
        let oldest: Option<i64> = conn
            .query_row("SELECT MIN(sequence) FROM app_events", [], |row| row.get(0))
            .map_err(|e| product::sqlite(e, "app_events: min sequence"))?;
        // A cursor is only "truncated" when the subscriber HAD a position and
        // the rows right after it are gone. A fresh subscriber (`-1`) simply
        // starts at the oldest retained row.
        truncated = after >= 0 && oldest.is_some_and(|oldest| after + 1 < oldest);

        let mut stmt = conn
            .prepare(
                "SELECT sequence, event, payload_json, created_at FROM app_events \
                 WHERE sequence > ?1 ORDER BY sequence LIMIT ?2",
            )
            .map_err(|e| product::sqlite(e, "app_events: prepare"))?;
        let mut rows = stmt
            .query(params![after, limit + 1])
            .map_err(|e| product::sqlite(e, "app_events: query"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| product::sqlite(e, "app_events: row"))?
        {
            if items.len() >= limit as usize {
                // Probe row past the page: a page-full of rows means more.
                has_more = true;
                break;
            }
            let sequence: i64 = row
                .get(0)
                .map_err(|e| product::sqlite(e, "app_events: sequence"))?;
            let event: String = row
                .get(1)
                .map_err(|e| product::sqlite(e, "app_events: event"))?;
            let payload_json: String = row
                .get(2)
                .map_err(|e| product::sqlite(e, "app_events: payload"))?;
            let created_at: String = row
                .get(3)
                .map_err(|e| product::sqlite(e, "app_events: created_at"))?;
            // Payloads are written by the kernel itself as JSON objects; a
            // scalar or malformed row (corruption) degrades to an empty object
            // instead of failing the whole page.
            let payload: Value = match serde_json::from_str::<Value>(&payload_json) {
                Ok(Value::Object(map)) => Value::Object(map),
                _ => Value::Object(serde_json::Map::new()),
            };
            items.push(AppEvent {
                sequence,
                event,
                payload: FreeObject { payload },
                created_at,
            });
        }
    }
    let dto = ResultAppEventsPage {
        items,
        has_more,
        truncated,
    };
    product::validate(&dto, generated::validate_result_app_events_page)?;
    product::encode(&dto)
}
