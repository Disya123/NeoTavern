//! Prompt pipeline (ТЗ §9.1–§9.2, Этап 2.6): builds the immutable
//! [`PromptPlan`] a generation run executes against.
//!
//! The plan records *what context entered the provider request* — system
//! blocks (character/persona/lorebook), the selected chat history, the user
//! message, token counts and every excluded message — so the user can later
//! inspect what was included or cut (§9.2). The plan is stored durably
//! (`prompt_plans`, migration 5) and handed to adapters as the
//! instruct-neutral `messages` array (AGENTS.md §9: plain role/content array
//! until provider-specific serialization).
//!
//! Tokenization is deliberately an **approximate local heuristic**
//! (`heuristic-v1`, flagged `approximateTokens: true`): the kernel has no
//! model-specific tokenizer yet, and ТЗ/AGENTS allow an approximate fallback
//! only with an explicit warning. A Tiktoken-compatible registry replaces it
//! later without touching the plan contract.

use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::{KernelError, KernelErrorCode};

/// Bounded history window scanned per plan (ordered by `sequence` DESC).
const MAX_HISTORY_MESSAGES: i64 = 128;
/// Fallback model context window when the provider model carries no limit.
const DEFAULT_CONTEXT_LIMIT: i64 = 8192;
/// Cap on injected lorebook blocks per plan (SEC/resource bound).
const MAX_LOREBOOK_BLOCKS: usize = 24;
/// Cap on lorebook entries scanned per plan.
const MAX_LOREBOOK_ENTRIES: usize = 2000;
/// Cap on memory rows scanned per plan (SEC/resource bound).
const MAX_MEMORY_ROWS: usize = 1000;
/// Cap on injected memory blocks per plan (SEC/resource bound).
const MAX_MEMORY_BLOCKS: usize = 24;
/// Per-message token overhead charged by the heuristic estimator.
const MESSAGE_OVERHEAD_TOKENS: u64 = 3;
/// Stable id of the instruct-neutral message form this pipeline emits.
pub const INSTRUCT_FORMAT_PLAIN_MESSAGES: &str = "plain-messages-v1";

/// One system block source (shown to the user in the plan).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptBlock {
    /// Block source: `character` | `persona` | `lorebook`.
    pub source: String,
    /// Rendered block text.
    pub text: String,
}

/// One message excluded from the plan, with the reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptExcluded {
    /// Message id that did not enter the plan.
    pub message_id: String,
    /// Stable exclusion reason (`token_budget`).
    pub reason: String,
}

/// One rendered prompt message (instruct-neutral role/content pair).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    /// Wire role: `system` | `user` | `assistant`.
    pub role: String,
    /// Message content.
    pub content: String,
}

/// Immutable prompt plan (ТЗ §9.2). Serde-serializes camelCase so the stored
/// `plan_json` equals the wire `wire.prompt.plan` shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPlan {
    /// Generation run this plan belongs to.
    pub run_id: String,
    /// Chat the run executes in.
    pub chat_id: String,
    /// Provider identifier (wire `provider` field).
    pub provider: String,
    /// Model string selected by the caller.
    pub model: String,
    /// Instruct format id. This pipeline emits the instruct-neutral message
    /// array (`plain-messages-v1`); template rendering (ChatML/Alpaca…) is a
    /// later stage.
    pub instruct_format: String,
    /// Tokenizer profile id (`heuristic-v1`).
    pub tokenizer_profile: String,
    /// `true` when the tokenizer is an approximate heuristic, not a
    /// model-specific tokenizer (always true today).
    pub approximate_tokens: bool,
    /// Model context window used for budgeting.
    pub context_limit: i64,
    /// Tokens reserved for the provider response.
    pub response_reserved: i64,
    /// Estimated input tokens after truncation.
    pub input_tokens: u64,
    /// `true` when the plan still exceeds the available budget after dropping
    /// all unpinned history (the provider may reject the request).
    pub over_budget: bool,
    /// Resolved user persona name (`chats.persona_id` → `personas.name`,
    /// ADR-0047 waiver 5) — the value substituted for `{{user}}`. Absent when
    /// the chat has no linked persona (omitted from the wire payload, never
    /// `null`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    /// System blocks (character / persona / lorebook) shown to the user.
    pub system_blocks: Vec<PromptBlock>,
    /// Final instruct-neutral message array (system + history + user).
    pub messages: Vec<PromptMessage>,
    /// Messages excluded from the plan (oldest unpinned first) with reasons.
    pub excluded: Vec<PromptExcluded>,
    /// Plan creation time (RFC 3339).
    pub created_at: String,
}

/// Inputs for [`build_prompt_plan`] — the durable run facts plus budget
/// hints from the resolved provider model.
#[derive(Debug, Clone)]
pub struct PlanInput<'a> {
    /// Generation run id (also the plan id).
    pub run_id: String,
    /// Chat the run executes in.
    pub chat_id: String,
    /// Sanitized user input (the run snapshot's `message`).
    pub message: &'a str,
    /// Provider identifier.
    pub provider: &'a str,
    /// Model string.
    pub model: &'a str,
    /// Model context window (adapter-declared); 0 → [`DEFAULT_CONTEXT_LIMIT`].
    pub context_limit: i64,
    /// Tokens reserved for the response; 0 → `min(2048, limit/4)`.
    pub response_reserved: i64,
}

/// Local approximate token estimator (`heuristic-v1`).
///
/// Non-CJK characters cost 1 token per 4 (ceil), CJK characters (CJK
/// Unified Ideographs, kana, hangul, CJK compat) cost 1 token each, plus a
/// small per-message overhead. This mirrors common char-based heuristics;
/// it is approximate by design and flagged as such in the plan.
pub fn estimate_tokens(text: &str, messages: usize) -> u64 {
    let mut cjk: u64 = 0;
    let mut other: u64 = 0;
    for ch in text.chars() {
        let cp = ch as u32;
        let is_cjk = (0x3400..=0x4dbf).contains(&cp)
            || (0x4e00..=0x9fff).contains(&cp)
            || (0x3040..=0x30ff).contains(&cp)
            || (0xac00..=0xd7af).contains(&cp)
            || (0xf900..=0xfaff).contains(&cp);
        if is_cjk {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other.div_ceil(4) + (messages as u64 * MESSAGE_OVERHEAD_TOKENS)
}

/// Parses one lorebook `entries_json` array into retrieval candidates.
///
/// Defensive: any malformed entry is skipped (never fails the plan); unknown
/// entry fields are preserved in the stored row untouched (AGENTS.md §11).
struct LorebookEntry {
    keys: Vec<String>,
    secondary_keys: Vec<String>,
    constant: bool,
    selective: bool,
    content: String,
}

fn parse_lorebook_entries(entries_json: &str) -> Vec<LorebookEntry> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(entries_json) else {
        return Vec::new();
    };
    let Some(array) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in array {
        let Some(obj) = item.as_object() else {
            continue;
        };
        // Disabled entries never activate.
        if obj.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        let str_vec = |key: &str| -> Vec<String> {
            obj.get(key)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default()
        };
        let Some(content) = obj.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push(LorebookEntry {
            keys: str_vec("keys"),
            secondary_keys: str_vec("secondaryKeys"),
            constant: obj
                .get("constant")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            selective: obj
                .get("selective")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            content: content.to_string(),
        });
    }
    out
}

/// Scans every lorebook for activated entries (constant entries always;
/// keyword entries on case-insensitive substring match; selective entries
/// additionally need a secondary key) and returns the ranked blocks.
///
/// Limitation (documented): the kernel schema has no character↔lorebook
/// linkage yet, so all books are scanned; scoping arrives with lorebook CRUD
/// cutover. The activation rules mirror the legacy retrieval
/// (`apps/server/src/lib/lorebookRetrieval.ts`).
fn retrieve_lorebook_blocks(db: &Database, context_text: &str) -> Vec<PromptBlock> {
    let mut stmt = match db
        .conn()
        .prepare("SELECT entries_json FROM lorebooks ORDER BY created_at DESC, id DESC")
    {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut blocks: Vec<PromptBlock> = Vec::new();
    let mut scanned: usize = 0;
    let haystack = context_text.to_lowercase();
    for row in rows {
        let Ok(entries_json) = row else { continue };
        for entry in parse_lorebook_entries(&entries_json) {
            scanned += 1;
            if scanned > MAX_LOREBOOK_ENTRIES {
                break;
            }
            if entry.constant {
                blocks.push(PromptBlock {
                    source: "lorebook".to_string(),
                    text: entry.content,
                });
                continue;
            }
            if entry.keys.is_empty() {
                continue;
            }
            let matched = entry
                .keys
                .iter()
                .filter(|key| {
                    let key = key.trim().to_lowercase();
                    !key.is_empty() && haystack.contains(&key)
                })
                .count();
            if matched == 0 {
                continue;
            }
            if entry.selective
                && !entry
                    .secondary_keys
                    .iter()
                    .any(|key| haystack.contains(&key.trim().to_lowercase()))
            {
                continue;
            }
            blocks.push(PromptBlock {
                source: "lorebook".to_string(),
                text: entry.content,
            });
        }
    }
    // Constant blocks keep their author order; keyword entries follow.
    blocks.truncate(MAX_LOREBOOK_BLOCKS);
    blocks
}

/// Retrieves memory blocks (ТЗ §4.4, Этап 4 slice 3): rows scoped to the
/// chat's character (`scope = 'global'` or `'character'` matching the chat's
/// character) are activated when any non-empty `keys` value appears in the
/// context text. The kernel table has no FTS, so retrieval is the honest
/// keyword heuristic `memory-keyword-v1` — keys matched against a lowercase
/// haystack, bounded by [`MAX_MEMORY_ROWS`] scanned and
/// [`MAX_MEMORY_BLOCKS`] injected, ordered by `position` then recency.
fn retrieve_memory_blocks(db: &Database, chat_id: &str, context_text: &str) -> Vec<PromptBlock> {
    let mut stmt = match db.conn().prepare(
        "SELECT m.keys_json, m.content FROM memories m \
         JOIN chats ch ON ch.id = ?1 \
         WHERE m.enabled = 1 AND (m.scope = 'global' OR m.character_id = ch.character_id) \
         ORDER BY m.position ASC, m.created_at DESC, m.id DESC",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(params![chat_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut blocks: Vec<PromptBlock> = Vec::new();
    let mut scanned: usize = 0;
    let haystack = context_text.to_lowercase();
    for row in rows {
        let Ok((keys_json, content)) = row else { continue };
        scanned += 1;
        if scanned > MAX_MEMORY_ROWS {
            break;
        }
        let keys: Vec<String> = match serde_json::from_str(&keys_json) {
            Ok(keys) => keys,
            Err(_) => continue,
        };
        if keys.is_empty() {
            continue;
        }
        let matched = keys
            .iter()
            .filter(|key| {
                let key = key.trim().to_lowercase();
                !key.is_empty() && haystack.contains(&key)
            })
            .count();
        if matched == 0 {
            continue;
        }
        blocks.push(PromptBlock {
            source: "memory".to_string(),
            text: content,
        });
        if blocks.len() >= MAX_MEMORY_BLOCKS {
            break;
        }
    }
    blocks
}

/// Loads the chat's character (name/description) and the character-card
/// persona (`ext_json.personality`, SillyTavern card field) as system blocks.
fn character_system_blocks(db: &Database, chat_id: &str) -> Result<Vec<PromptBlock>, KernelError> {
    let row = db
        .conn()
        .query_row(
            "SELECT c.name, c.description, c.ext_json
             FROM characters c
             JOIN chats ch ON ch.character_id = c.id
             WHERE ch.id = ?1",
            params![chat_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|e| {
            KernelError::new(
                KernelErrorCode::NotFound,
                format!("prompt plan: chat or character not found for chat {chat_id}: {e}"),
            )
        })?;
    let name = row.0.unwrap_or_default();
    let description = row.1.unwrap_or_default();
    let ext_json = row.2.unwrap_or_else(|| "{}".to_string());
    let mut blocks = Vec::new();
    if !description.trim().is_empty() {
        blocks.push(PromptBlock {
            source: "character".to_string(),
            text: description,
        });
    }
    // Persona: the raw SillyTavern card field (if the host preserved it in
    // ext_json). Missing → no persona block.
    let persona = match serde_json::from_str::<serde_json::Value>(&ext_json) {
        Ok(value) => value
            .get("personality")
            .or_else(|| value.get("persona"))
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    };
    if !persona.is_empty() {
        let text = if name.trim().is_empty() {
            persona
        } else {
            format!("{name}: {persona}")
        };
        blocks.push(PromptBlock {
            source: "persona".to_string(),
            text,
        });
    }
    Ok(blocks)
}

/// Loads the chat's recent non-tool messages in chronological order with
/// their ids (bounded by [`MAX_HISTORY_MESSAGES`]) — ids let the plan report
/// exactly which messages were excluded.
fn chat_history(db: &Database, chat_id: &str) -> Result<Vec<(String, PromptMessage)>, KernelError> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, role, content FROM messages \
             WHERE chat_id = ?1 AND role IN ('system','user','assistant') \
             ORDER BY sequence DESC LIMIT ?2",
        )
        .map_err(|e| StorageError::from_sqlite(e, "prompt plan: prepare history"))?;
    let rows = stmt
        .query_map(params![chat_id, MAX_HISTORY_MESSAGES], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| StorageError::from_sqlite(e, "prompt plan: query history"))?;
    let mut reversed: Vec<(String, PromptMessage)> = Vec::new();
    for row in rows {
        let (id, role, content) =
            row.map_err(|e| StorageError::from_sqlite(e, "prompt plan: history row"))?;
        reversed.push((id, PromptMessage { role, content }));
    }
    reversed.reverse();
    Ok(reversed)
}

/// Resolves the user persona name of a chat (`chats.persona_id` →
/// `personas.name`, ADR-0047 waiver 5). `None` when the chat has no linked
/// persona or the referenced persona was deleted (`ON DELETE SET NULL`).
fn resolve_user_name(db: &Database, chat_id: &str) -> Result<Option<String>, KernelError> {
    let name = db
        .conn()
        .query_row(
            "SELECT p.name FROM personas p JOIN chats ch ON ch.persona_id = p.id \
             WHERE ch.id = ?1",
            params![chat_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| StorageError::from_sqlite(e, "prompt plan: resolve user name"))?;
    Ok(name.filter(|n| !n.trim().is_empty()))
}

/// Substitutes the `{{user}}` macro in a message content (ADR-0047 waiver 5)
/// when a user persona name is resolved; otherwise the content passes through
/// verbatim. Historical user-role messages are substituted too — mirroring
/// the legacy macro stage, which renders `{{user}}` at prompt-build time
/// across the selected history and the current input.
fn apply_user_macro(content: &str, user_name: Option<&str>) -> String {
    match user_name {
        Some(name) if !name.is_empty() => content.replace("{{user}}", name),
        _ => content.to_string(),
    }
}

/// Builds the immutable [`PromptPlan`] for one generation run (ТЗ §9.2).
///
/// Stages (AGENTS.md §8 order): character/persona → lorebook → history
/// selection → token budget → context shifting (drop oldest unpinned) →
/// instruct-neutral message array. The final plan is stored durably by the
/// caller; this function performs no writes.
pub fn build_prompt_plan(db: &Database, input: &PlanInput<'_>) -> Result<PromptPlan, KernelError> {
    let character_blocks = character_system_blocks(db, &input.chat_id)?;
    let user_name = resolve_user_name(db, &input.chat_id)?;
    let history = chat_history(db, &input.chat_id)?;

    // Lorebook activation context: the user message plus the tail of recent
    // history (cheap, bounded).
    let tail: String = history
        .iter()
        .rev()
        .take(8)
        .map(|(_, m)| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let lorebook_blocks = retrieve_lorebook_blocks(db, &format!("{}\n{tail}", input.message));
    // Memory/RAG (ТЗ §4.4, Этап 4 slice 3): keyword activation on the user
    // message + recent history tail, scoped to the chat's character. The
    // kernel has no FTS yet — retrieval is the documented `memory-keyword-v1`
    // heuristic (keys matched against the haystack), never a silent claim of
    // semantic retrieval.
    let memory_blocks = retrieve_memory_blocks(db, &input.chat_id, &format!("{}\n{tail}", input.message));

    // Stage order mirrors AGENTS §8: character/persona → lorebook → memory.
    let mut system_blocks = character_blocks;
    system_blocks.extend(lorebook_blocks);
    system_blocks.extend(memory_blocks);
    system_blocks.retain(|b| !b.text.trim().is_empty());

    // System message: merge all system blocks (kept under the budget).
    let system_text = system_blocks
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut messages: Vec<PromptMessage> = Vec::new();
    if !system_text.trim().is_empty() {
        messages.push(PromptMessage {
            role: "system".to_string(),
            content: system_text,
        });
    }
    let mut history_ids: Vec<String> = Vec::new();
    for (id, message) in history {
        history_ids.push(id);
        // `{{user}}` is rendered at plan-build time across the selected
        // history (ADR-0047 waiver 5) — mirroring the legacy macro stage.
        messages.push(PromptMessage {
            role: message.role,
            content: apply_user_macro(&message.content, user_name.as_deref()),
        });
    }
    messages.push(PromptMessage {
        role: "user".to_string(),
        content: apply_user_macro(input.message, user_name.as_deref()),
    });

    // Token budget (heuristic): reserve response room, then drop the oldest
    // unpinned history messages until the input fits.
    let context_limit = if input.context_limit > 0 {
        input.context_limit
    } else {
        DEFAULT_CONTEXT_LIMIT
    };
    let response_reserved = if input.response_reserved > 0 {
        input.response_reserved.min(context_limit / 2)
    } else {
        (context_limit / 4).min(2048)
    };
    let available = (context_limit - response_reserved).max(0) as u64;

    let tokens_of = |messages: &[PromptMessage]| -> u64 {
        messages
            .iter()
            .map(|m| estimate_tokens(&m.content, 1))
            .sum::<u64>()
    };
    let mut excluded: Vec<PromptExcluded> = Vec::new();
    let mut over_budget = false;
    // Drop the oldest unpinned history messages (index 1 = oldest history;
    // the system prompt at index 0 and the user message stay pinned).
    while tokens_of(&messages) > available && messages.len() > 2 && !history_ids.is_empty() {
        messages.remove(1);
        excluded.push(PromptExcluded {
            message_id: history_ids.remove(0),
            reason: "token_budget".to_string(),
        });
    }
    if tokens_of(&messages) > available {
        over_budget = true;
    }

    Ok(PromptPlan {
        run_id: input.run_id.clone(),
        chat_id: input.chat_id.clone(),
        provider: input.provider.to_string(),
        model: input.model.to_string(),
        instruct_format: INSTRUCT_FORMAT_PLAIN_MESSAGES.to_string(),
        tokenizer_profile: "heuristic-v1".to_string(),
        approximate_tokens: true,
        context_limit,
        response_reserved,
        input_tokens: tokens_of(&messages),
        over_budget,
        user_name,
        system_blocks,
        messages,
        excluded,
        created_at: neotavern_storage::now_utc_rfc3339(),
    })
}

/// Inserts a plan into the durable `prompt_plans` table (one plan per run).
pub fn insert_prompt_plan(db: &mut Database, plan: &PromptPlan) -> Result<(), KernelError> {
    let plan_json = serde_json::to_string(plan).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("prompt plan: serialize plan: {err}"),
        )
    })?;
    db.conn()
        .execute(
            "INSERT INTO prompt_plans (run_id, chat_id, plan_json, created_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(run_id) DO UPDATE SET plan_json = excluded.plan_json",
            params![plan.run_id, plan.chat_id, plan_json, plan.created_at],
        )
        .map_err(|e| StorageError::from_sqlite(e, "prompt plan: insert"))?;
    Ok(())
}

/// Whether a run already has a stored plan (the resumed-turn fast path of the
/// executor: the plan is built once, on the first provider turn).
pub fn prompt_plan_exists(db: &Database, run_id: &str) -> Result<bool, KernelError> {
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM prompt_plans WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| StorageError::from_sqlite(e, "prompt plan: exists"))?;
    Ok(count > 0)
}

/// Loads the stored plan for a run (for `generation.prompt-plan`).
pub fn load_prompt_plan(db: &Database, run_id: &str) -> Result<PromptPlan, KernelError> {
    let plan_json: String = db
        .conn()
        .query_row(
            "SELECT plan_json FROM prompt_plans WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|_| {
            KernelError::new(
                KernelErrorCode::NotFound,
                format!("prompt plan: no plan for run {run_id}"),
            )
        })?;
    serde_json::from_str(&plan_json).map_err(|err| {
        KernelError::new(
            KernelErrorCode::Internal,
            format!("prompt plan: deserialize stored plan: {err}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn plan_input<'a>(message: &'a str, limit: i64) -> PlanInput<'a> {
        PlanInput {
            run_id: "11111111-1111-4111-8111-111111111111".to_string(),
            chat_id: "22222222-2222-4222-8222-222222222222".to_string(),
            message,
            provider: "fake",
            model: "fake-1",
            context_limit: limit,
            response_reserved: 0,
        }
    }

    #[test]
    fn heuristic_estimator_counts_cjk_and_latin() {
        let latin = estimate_tokens("hello world", 1);
        assert!(latin > 0);
        // "hello world" is 11 non-CJK chars → ceil(11/4)=3 + overhead 3.
        assert_eq!(latin, 6);
        // Four CJK chars ≈ 4 tokens + overhead.
        let cjk = estimate_tokens("你好世界", 1);
        assert_eq!(cjk, 7);
    }

    #[test]
    fn system_blocks_merge_into_single_system_message() {
        let _temp = tempfile::tempdir().expect("tempdir");
        let db = open_test_db(_temp.path());
        let plan = build_prompt_plan(&db, &plan_input("hi", 8192)).expect("plan builds");
        assert_eq!(plan.messages[0].role, "system");
        assert!(plan.messages[0].content.contains("Aria"));
        assert!(plan.messages[0].content.contains("cheerful"));
        assert_eq!(plan.messages.last().unwrap().role, "user");
        assert_eq!(plan.messages.last().unwrap().content, "hi");
        assert!(
            plan.approximate_tokens,
            "heuristic tokenizer is approximate"
        );
    }

    #[test]
    fn history_is_selected_and_oldest_dropped_on_budget() {
        let _temp = tempfile::tempdir().expect("tempdir");
        let db = open_test_db(_temp.path());
        // Budget 32 → available 24 < 26 estimated tokens → the oldest
        // history message must be dropped (the system prompt and the user
        // message stay pinned).
        let plan = build_prompt_plan(&db, &plan_input("hi", 32)).expect("plan builds");
        assert!(plan.messages.len() >= 2);
        assert!(
            !plan.excluded.is_empty(),
            "tiny budget must drop the oldest history message"
        );
        assert_eq!(
            plan.excluded[0].message_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "excluded id must be the oldest message"
        );
        assert_eq!(plan.excluded[0].reason, "token_budget");
        // The user message is always pinned last.
        assert_eq!(plan.messages.last().unwrap().content, "hi");
        // The second history message survived.
        assert!(
            plan.messages.iter().any(|m| m.content == "second"),
            "newest history message survives truncation"
        );
    }

    #[test]
    fn lorebook_keyword_entries_activate() {
        let _temp = tempfile::tempdir().expect("tempdir");
        let db = open_test_db(_temp.path());
        db.conn()
            .execute(
                "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at) \
                 VALUES ('44444444-4444-4444-8444-444444444444', 'world', NULL, \
                 '[{\"keys\":[\"crystal\"],\"content\":\"The crystal hums.\",\"enabled\":true}]', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                [],
            )
            .expect("lorebook insert");
        let plan =
            build_prompt_plan(&db, &plan_input("where is the crystal?", 8192)).expect("plan");
        let lore = plan
            .system_blocks
            .iter()
            .any(|b| b.source == "lorebook" && b.text.contains("hums"));
        assert!(lore, "keyword match must inject the entry");
        let plan2 = build_prompt_plan(&db, &plan_input("nothing relevant", 8192)).expect("plan2");
        assert!(
            !plan2.system_blocks.iter().any(|b| b.source == "lorebook"),
            "no keyword → no lorebook block"
        );
    }

    #[test]
    fn plan_serializes_camel_case_like_the_wire_dto() {
        let _temp = tempfile::tempdir().expect("tempdir");
        let db = open_test_db(_temp.path());
        let plan = build_prompt_plan(&db, &plan_input("hi", 8192)).expect("plan");
        let json = serde_json::to_value(&plan).expect("serialize");
        assert!(json.get("runId").is_some(), "runId camelCase");
        assert!(json.get("instructFormat").is_some());
        assert!(json.get("approximateTokens").is_some());
        assert!(json.get("systemBlocks").is_some());
        assert!(json.get("inputTokens").is_some());
    }

    /// Opens a fresh data root at `root` with the full schema + one
    /// character/chat and two history messages. The caller must keep `root`
    /// alive (the returned [`Database`] holds the root lease).
    fn open_test_db(root: &Path) -> Database {
        let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
        let db = neotavern_storage::open::open(
            root,
            &neotavern_storage::baseline::ConnectionPolicy::default(),
            &mut progress,
        )
        .expect("fresh data root must open");
        db.conn()
            .execute(
                "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) \
                 VALUES ('33333333-3333-4333-8333-333333333333', 'Aria', 'A cheerful guide.', NULL, '[]', \
                 '{\"personality\":\"playful\"}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                [],
            )
            .expect("character insert");
        db.conn()
            .execute(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) \
                 VALUES ('22222222-2222-4222-8222-222222222222', 'test', \
                 '33333333-3333-4333-8333-333333333333', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
                [],
            )
            .expect("chat insert");
        db.conn()
            .execute(
                "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES \
                 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'user', 'oldest', 1, '2026-08-13T00:00:00Z'), \
                 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'assistant', 'second', 2, '2026-08-13T00:00:00Z')",
                [],
            )
            .expect("messages insert");
        db
    }
}
