//! Free helper functions split out of the former single-file `session.rs`
//! (B1): slash-command parsing, preset/prompt-block plumbing, height models
//! and display-list mapping. No code changes; `mod.rs` re-exports what used
//! to be public.
use super::*;

/// React `ChatPage.send` `/^\/([^\s]+)(?:\s+(.*))?$/`: first token after `/`,
/// or the whole text when the command name is empty (`/`).
pub(crate) fn slash_command_name(message: &str) -> String {
    let rest = message.strip_prefix('/').unwrap_or(message);
    let name = rest.split_whitespace().next().unwrap_or("");
    if name.is_empty() {
        message.to_string()
    } else {
        name.to_string()
    }
}

pub(crate) fn settings_string(items: &[SettingsItem], key: &str) -> Option<String> {
    let item = items.iter().find(|row| row.key == key)?;
    if let Some(text) = item.value.as_str() {
        return Some(text.to_string());
    }
    let obj = item.value.as_object()?;
    obj.get("value")
        .and_then(Value::as_str)
        .or_else(|| obj.get("locale").and_then(Value::as_str))
        .map(str::to_string)
}

pub(crate) fn settings_unwrapped<'a>(items: &'a [SettingsItem], key: &str) -> Option<&'a Value> {
    let item = items.iter().find(|row| row.key == key)?;
    let value = &item.value;
    if let Some(obj) = value.as_object() {
        if obj.len() == 1 && obj.contains_key("value") {
            return obj.get("value");
        }
    }
    Some(value)
}

/// Host-owned text-completion block ids (`PromptBlockIds` in contracts).
pub(crate) const PROMPT_BLOCK_IDS: &[&str] = &[
    "main-prompt",
    "world-info-before",
    "persona",
    "character-description",
    "character-personality",
    "scenario",
    "world-info-after",
    "dialogue-examples",
    "memory",
    "authors-note",
    "chat-history",
    "post-history-instructions",
];

/// React `PromptBlockEditorDialog` role `<select>` — not the full
/// `MessageRole` union (`tool` / `plugin` stay off the authoring menu).
pub(crate) const PROMPT_BLOCK_ROLES: &[&str] = &["system", "user", "assistant"];

pub(crate) const PROMPT_TRIGGER_IDS: &[&str] = &[
    "normal",
    "continue",
    "impersonate",
    "swipe",
    "regenerate",
    "quiet",
];

/// English golden copy (`settings:invalidPromptTemplatePreset`).
pub(crate) const INVALID_PROMPT_TEMPLATE_PRESET: &str =
    "This file is not a valid prompt template preset.";
/// English golden copy (`settings:invalidGenerationPreset`).
pub(crate) const INVALID_GENERATION_PRESET: &str = "This file is not a valid generation preset.";
pub(crate) const CONTEXT_TOKEN_MIN: i64 = 256;
pub(crate) const CONTEXT_TOKEN_DEFAULT: i64 = 16_032;
pub(crate) const CONTEXT_TOKEN_DEFAULT_MAX: i64 = 200_000;
pub(crate) const CONTEXT_TOKEN_UNLOCKED_MAX: i64 = 10_000_000;

pub(crate) struct SamplerBound {
    pub(crate) id: &'static str,
    pub(crate) min: f64,
    pub(crate) max: f64,
    pub(crate) step: f64,
    pub(crate) integer: bool,
}

/// Mirrors `GENERATION_PARAMETER_BOUNDS` in `packages/contracts/src/provider.ts`.
pub(crate) const SAMPLER_BOUNDS: &[SamplerBound] = &[
    SamplerBound {
        id: "maxTokens",
        min: 1.0,
        max: 200_000.0,
        step: 1.0,
        integer: true,
    },
    SamplerBound {
        id: "temperature",
        min: 0.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topP",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topK",
        min: 0.0,
        max: 100_000.0,
        step: 1.0,
        integer: true,
    },
    SamplerBound {
        id: "minP",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "topA",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "repetitionPenalty",
        min: 0.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "frequencyPenalty",
        min: -2.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "presencePenalty",
        min: -2.0,
        max: 2.0,
        step: 0.01,
        integer: false,
    },
    SamplerBound {
        id: "seed",
        min: -1.0,
        max: 2_147_483_647.0,
        step: 1.0,
        integer: true,
    },
];

pub(crate) fn sampler_bound(id: &str) -> Option<&'static SamplerBound> {
    SAMPLER_BOUNDS.iter().find(|bound| bound.id == id)
}

pub(crate) fn parse_sampler_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "-" || trimmed == "." || trimmed == "-." {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

pub(crate) fn clamp_sampler_number(id: &str, raw: f64, unlocked: bool) -> f64 {
    if id == "maxContextTokens" {
        let max = if unlocked {
            CONTEXT_TOKEN_UNLOCKED_MAX
        } else {
            CONTEXT_TOKEN_DEFAULT_MAX
        };
        return raw.round().clamp(CONTEXT_TOKEN_MIN as f64, max as f64);
    }
    let Some(bound) = sampler_bound(id) else {
        return raw;
    };
    let stepped = ((raw - bound.min) / bound.step).round() * bound.step + bound.min;
    let clamped = stepped.clamp(bound.min, bound.max);
    (clamped * 1e10).round() / 1e10
}

pub(crate) fn format_sampler_number(value: f64, integer: bool) -> String {
    if integer || value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value:.2}")
    }
}

pub(crate) fn merge_preset_defaults(value: &Value) -> PresetGenerationDefaults {
    let mut merged = PresetGenerationDefaults::default();
    let Ok(incoming) = serde_json::from_value::<PresetGenerationDefaults>(value.clone()) else {
        return merged;
    };
    if let Some(obj) = value.as_object() {
        if obj.contains_key("maxTokens") {
            merged.max_tokens = incoming.max_tokens;
        }
        if obj.contains_key("temperature") {
            merged.temperature = incoming.temperature;
        }
        if obj.contains_key("topP") {
            merged.top_p = incoming.top_p;
        }
        if obj.contains_key("topK") {
            merged.top_k = incoming.top_k;
        }
        if obj.contains_key("minP") {
            merged.min_p = incoming.min_p;
        }
        if obj.contains_key("topA") {
            merged.top_a = incoming.top_a;
        }
        if obj.contains_key("repetitionPenalty") {
            merged.repetition_penalty = incoming.repetition_penalty;
        }
        if obj.contains_key("frequencyPenalty") {
            merged.frequency_penalty = incoming.frequency_penalty;
        }
        if obj.contains_key("presencePenalty") {
            merged.presence_penalty = incoming.presence_penalty;
        }
        if obj.contains_key("seed") {
            merged.seed = incoming.seed;
        }
        if obj.contains_key("reasoning") {
            merged.reasoning = incoming.reasoning;
        }
        if obj.contains_key("stream") {
            merged.stream = incoming.stream;
        }
    }
    merged
}

pub(crate) fn merge_preset_defaults_value(value: &Value) -> Value {
    serde_json::to_value(merge_preset_defaults(value)).unwrap_or_else(|_| json!({}))
}

/// Mirrors `DEFAULT_PROMPT_TEMPLATE` in `packages/contracts/src/promptTemplate.ts`.
pub(crate) fn default_prompt_template() -> Value {
    let blocks: Vec<Value> = PROMPT_BLOCK_IDS
        .iter()
        .map(|id| {
            if *id == "main-prompt" {
                json!({
                    "id": id,
                    "enabled": true,
                    "role": "system",
                    "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
                    "injectionPosition": "relative",
                    "triggers": PROMPT_TRIGGER_IDS,
                    "forbidOverrides": false,
                })
            } else {
                json!({ "id": id, "enabled": true })
            }
        })
        .collect();
    json!({
        "mode": "chat",
        "blocks": blocks,
        "postHistoryInstructions": "Keep the roleplay engaging. Drive the story forward proactively while staying in character.",
    })
}

pub(crate) fn prompt_block_label(id: &str) -> String {
    match id {
        "main-prompt" => "Main Prompt",
        "world-info-before" => "World Info (before)",
        "persona" => "Persona",
        "character-description" => "Character Description",
        "character-personality" => "Character Personality",
        "scenario" => "Scenario",
        "world-info-after" => "World Info (after)",
        "dialogue-examples" => "Dialogue Examples",
        "memory" => "Memory",
        "authors-note" => "Author\u{2019}s Note",
        "chat-history" => "Chat History",
        "post-history-instructions" => "Post-History Instructions",
        _ => "Custom Prompt",
    }
    .into()
}

pub(crate) fn prompt_block_content_editable(id: &str) -> bool {
    !PROMPT_BLOCK_IDS.contains(&id) || matches!(id, "main-prompt" | "post-history-instructions")
}

pub(crate) fn prompt_block_injection_position(block: &Value) -> &'static str {
    match block.get("injectionPosition").and_then(Value::as_str) {
        Some("in-chat") => "in-chat",
        _ => "relative",
    }
}

pub(crate) fn prompt_block_role(block: &Value) -> &'static str {
    prompt_block_role_draft(block.get("role").and_then(Value::as_str).unwrap_or(""))
}

pub(crate) fn prompt_block_role_draft(role: &str) -> &'static str {
    match role {
        "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    }
}

pub(crate) fn default_prompt_block_triggers() -> Vec<String> {
    PROMPT_TRIGGER_IDS
        .iter()
        .map(|id| (*id).to_string())
        .collect()
}

pub(crate) fn prompt_block_triggers(block: &Value) -> Vec<String> {
    match block.get("triggers").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| PROMPT_TRIGGER_IDS.contains(id))
            .map(str::to_string)
            .collect(),
        None => default_prompt_block_triggers(),
    }
}

pub(crate) fn prompt_block_forbid_overrides(block: &Value) -> bool {
    block
        .get("forbidOverrides")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn prompt_block_model(block: &Value) -> String {
    clamp_prompt_block_model(block.get("model").and_then(Value::as_str).unwrap_or(""))
}

pub(crate) fn clamp_prompt_block_model(value: &str) -> String {
    value.chars().take(256).collect()
}

pub(crate) fn prompt_block_u32(block: &Value, key: &str, default: u32) -> u32 {
    block
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n.min(9999) as u32)
        .unwrap_or(default)
}

pub(crate) fn parse_prompt_injection_u32(raw: &str, default: u32) -> u32 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default;
    }
    trimmed
        .parse::<u32>()
        .ok()
        .map(|n| n.min(9999))
        .unwrap_or(default)
}

pub(crate) fn sanitize_prompt_int_draft(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(4)
        .collect()
}

/// Sequential `custom-N` ids that satisfy `CustomPromptBlockIdSchema`
/// (`^custom-[A-Za-z0-9][A-Za-z0-9._-]*$`, minLength 8). React uses UUID;
/// the native host stays deterministic without a `uuid` crate.
pub(crate) fn next_custom_prompt_id(blocks: &[Value]) -> String {
    let mut n = 1u32;
    loop {
        let candidate = format!("custom-{n}");
        let taken = blocks
            .iter()
            .any(|block| block.get("id").and_then(Value::as_str) == Some(candidate.as_str()));
        if !taken {
            return candidate;
        }
        n = n.saturating_add(1);
        if n == u32::MAX {
            return "custom-overflow".into();
        }
    }
}

pub(crate) fn is_terminal_prompt_block_id(id: &str) -> bool {
    matches!(id, "chat-history" | "post-history-instructions")
}

pub(crate) fn prompt_block_json_id(block: &Value) -> Option<&str> {
    block.get("id").and_then(Value::as_str)
}

/// React `normalizePromptBlockOrder`: movable blocks first, then the two
/// terminal anchors in semantic order.
pub(crate) fn normalize_prompt_block_order(blocks: Vec<Value>) -> Vec<Value> {
    let mut movable = Vec::new();
    let mut chat_history = None;
    let mut post_history = None;
    for block in blocks {
        match block.get("id").and_then(Value::as_str) {
            Some("chat-history") if chat_history.is_none() => chat_history = Some(block),
            Some("post-history-instructions") if post_history.is_none() => {
                post_history = Some(block)
            }
            _ => movable.push(block),
        }
    }
    movable.extend(chat_history);
    movable.extend(post_history);
    movable
}

/// React `PromptTemplateEditor.reorderBlocks`. `from`/`to` index the
/// normalized full list; terminals stay pinned after the movable prefix.
pub(crate) fn reorder_prompt_blocks(blocks: Vec<Value>, from: usize, to: usize) -> Vec<Value> {
    let normalized = normalize_prompt_block_order(blocks);
    let Some(moved_id) = normalized
        .get(from)
        .and_then(prompt_block_json_id)
        .map(str::to_string)
    else {
        return normalized;
    };
    if is_terminal_prompt_block_id(&moved_id) {
        return normalized;
    }
    let target_id = normalized
        .get(to)
        .and_then(prompt_block_json_id)
        .map(str::to_string);
    let mut movable: Vec<Value> = normalized
        .iter()
        .filter(|block| {
            prompt_block_json_id(block).is_some_and(|id| !is_terminal_prompt_block_id(id))
        })
        .cloned()
        .collect();
    let Some(from_movable) = movable
        .iter()
        .position(|block| prompt_block_json_id(block) == Some(moved_id.as_str()))
    else {
        return normalized;
    };
    let Some(target_movable) = (match target_id.as_deref() {
        Some(id) if is_terminal_prompt_block_id(id) => Some(movable.len().saturating_sub(1)),
        Some(id) => movable
            .iter()
            .position(|block| prompt_block_json_id(block) == Some(id)),
        None => Some(from_movable),
    }) else {
        return normalized;
    };
    let removed = movable.remove(from_movable);
    let insert_at = target_movable.min(movable.len());
    movable.insert(insert_at, removed);
    let terminals: Vec<Value> = normalized
        .iter()
        .filter(|block| prompt_block_json_id(block).is_some_and(is_terminal_prompt_block_id))
        .cloned()
        .collect();
    normalize_prompt_block_order(movable.into_iter().chain(terminals).collect())
}

pub(crate) fn prompt_block_views(template: &Value) -> Vec<PromptBlockView> {
    let Some(blocks) = template.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut views: Vec<PromptBlockView> = blocks
        .iter()
        .filter_map(|block| {
            let id = block.get("id")?.as_str()?.to_string();
            let enabled = block
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| prompt_block_label(&id));
            let custom = !PROMPT_BLOCK_IDS.contains(&id.as_str());
            let injection_in_chat = prompt_block_injection_position(block) == "in-chat";
            let injection_depth = prompt_block_u32(block, "injectionDepth", 4);
            Some(PromptBlockView {
                id,
                name,
                enabled,
                custom,
                can_move_up: false,
                can_move_down: false,
                injection_in_chat,
                injection_depth,
            })
        })
        .collect();
    let n = views.len();
    for i in 0..n {
        let terminal = is_terminal_prompt_block_id(&views[i].id);
        let next_terminal = views
            .get(i + 1)
            .is_some_and(|next| is_terminal_prompt_block_id(&next.id));
        views[i].can_move_up = !terminal && i > 0;
        views[i].can_move_down = !terminal && i + 1 < n && !next_terminal;
    }
    views
}

pub(crate) fn prompt_template_is_complete(template: &Value) -> bool {
    let Some(blocks) = template.get("blocks").and_then(Value::as_array) else {
        return false;
    };
    if blocks.len() < PROMPT_BLOCK_IDS.len() {
        return false;
    }
    let ids: Vec<&str> = blocks
        .iter()
        .filter_map(|block| block.get("id").and_then(Value::as_str))
        .collect();
    if ids.len() != blocks.len() {
        return false;
    }
    if !PROMPT_BLOCK_IDS.iter().all(|id| ids.contains(id)) {
        return false;
    }
    let n = ids.len();
    ids[n - 2] == "chat-history" && ids[n - 1] == "post-history-instructions"
}

/// React `PromptTemplateEditor.importPreset`: envelope `{ data, name }` or a
/// bare template object. Forces `mode: "text"` and requires the 12 host-owned
/// ids with terminal anchors last.
pub(crate) fn parse_prompt_template_import(
    bytes: &[u8],
    fallback_name: &str,
) -> Option<(String, Value)> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let (imported_name, mut candidate) = if let Some(obj) = raw.as_object() {
        if obj.contains_key("data") {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name);
            (name.to_string(), obj.get("data")?.clone())
        } else {
            (fallback_name.to_string(), raw)
        }
    } else {
        return None;
    };
    if !candidate.is_object() {
        return None;
    }
    if let Some(obj) = candidate.as_object_mut() {
        obj.insert("mode".into(), json!("text"));
    }
    if !prompt_template_is_complete(&candidate) {
        return None;
    }
    let trimmed = imported_name.trim();
    let name = if trimmed.is_empty() {
        "prompt-template".to_string()
    } else {
        trimmed.chars().take(500).collect()
    };
    Some((name, candidate))
}

pub(crate) fn json_export_filename(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let base = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    let mut safe = String::new();
    for ch in base.chars() {
        if safe.len() >= 80 {
            break;
        }
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            safe.push('-');
        } else if !ch.is_control() {
            safe.push(ch);
        }
    }
    if safe.is_empty() {
        format!("{fallback}.json")
    } else {
        format!("{safe}.json")
    }
}

/// React `GenerationPresetEditor.importPreset`: envelope `{ data, name }` or a
/// bare `GenerationPresetData` object. `maxContextTokens` must sit in the
/// contract range; `generationDefaults` is a required object.
pub(crate) fn parse_generation_preset_import(
    bytes: &[u8],
    fallback_name: &str,
) -> Option<(String, Value)> {
    let raw: Value = serde_json::from_slice(bytes).ok()?;
    let (imported_name, candidate) = if let Some(obj) = raw.as_object() {
        if obj.contains_key("data") {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name);
            (name.to_string(), obj.get("data")?.clone())
        } else {
            (fallback_name.to_string(), raw)
        }
    } else {
        return None;
    };
    if !generation_preset_data_is_valid(&candidate) {
        return None;
    }
    let trimmed = imported_name.trim();
    let name = if trimmed.is_empty() {
        "generation".to_string()
    } else {
        trimmed.chars().take(500).collect()
    };
    Some((name, candidate))
}

pub(crate) fn generation_preset_data_is_valid(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if obj
        .keys()
        .any(|key| key != "maxContextTokens" && key != "generationDefaults")
    {
        return false;
    }
    let Some(tokens) = obj.get("maxContextTokens").and_then(Value::as_i64) else {
        return false;
    };
    if !(CONTEXT_TOKEN_MIN..=CONTEXT_TOKEN_UNLOCKED_MAX).contains(&tokens) {
        return false;
    }
    match obj.get("generationDefaults") {
        Some(Value::Object(defaults)) => {
            const ALLOWED: &[&str] = &[
                "maxTokens",
                "temperature",
                "topP",
                "topK",
                "minP",
                "topA",
                "repetitionPenalty",
                "frequencyPenalty",
                "presencePenalty",
                "seed",
                "reasoning",
                "reasoningEffort",
                "stop",
                "stream",
            ];
            defaults.keys().all(|key| ALLOWED.contains(&key.as_str()))
        }
        _ => false,
    }
}

pub(crate) fn default_custom_instruct() -> Value {
    json!({
        "id": "custom-chatml",
        "version": 1,
        "system": "<|im_start|>system\n{{{content}}}<|im_end|>\n",
        "user": "<|im_start|>user\n{{{content}}}<|im_end|>\n",
        "assistant": "<|im_start|>assistant\n{{{content}}}<|im_end|>\n",
        "tool": "<|im_start|>tool\n{{{content}}}<|im_end|>\n",
        "promptSuffix": "<|im_start|>assistant\n",
        "stopStrings": ["<|im_end|>"],
    })
}

pub(crate) fn instruct_role_text(format: &Option<Value>, key: &str) -> String {
    format
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(crate) fn instruct_stop_text(format: &Option<Value>) -> String {
    format
        .as_ref()
        .and_then(|value| value.get("stopStrings"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Painted pitch between message rows: the canvas flex `gap: 24px` plus the
/// article's own `margin-top:8px;margin-bottom:8px`
/// (`message_bubble_style`). The presentation height index adds it to every
/// row so the index's cumulative px equals the painted canvas positions —
/// without it the window selection and the sub-row offset drift from the
/// paint by the pitch per row (rows select at wrong offsets and the viewport
/// grows a void at the bottom). Verified against painted dom-dumps: row
/// top-to-top = box height + exactly this constant.
pub(crate) const ROW_GAP_CSS: f64 = 40.0;

pub(crate) fn virtualized_window(
    messages: &[MessageDto],
    viewport_height: f64,
    scroll_from_bottom_css: f64,
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
    height_corrections: &HashMap<String, (f64, f64)>,
) -> (Vec<VisibleRow>, PresentOutcome, f64) {
    let mut index = HeightIndex::new();
    for message in messages {
        let (height, kind) = corrected_height_kind(message, height_corrections);
        let _ = index.push(
            LogicalItemId(message.sequence as u64),
            height + ROW_GAP_CSS,
            kind,
        );
    }
    let viewport_height = viewport_height.max(1.0);
    let extent = index.extent();
    if messages.is_empty() || extent <= viewport_height {
        return (
            visible_rows(messages, assistant_author, macros),
            PresentOutcome {
                decision: PresentDecision::Prepared,
                blank_px: 0.0,
                waited_on_producer: false,
                snapshot: GeometrySnapshot::empty(),
            },
            0.0,
        );
    }
    let mut viewport = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(64, 256 * 1024),
        viewport_height,
        8_333_333,
    );
    let extent = viewport.index().extent();
    let budget = (extent - viewport_height).max(0.0);
    let scroll = scroll_from_bottom_css.max(0.0).min(budget);
    viewport.teleport(budget - scroll);
    let outcome = viewport.present();
    let start = viewport.offset();
    let span = viewport
        .index()
        .span_covering(start, start + viewport_height);
    // px of the first window row hidden above the viewport top. The painter
    // pulls the message canvas up by exactly this amount so rows land at
    // their true scrolled positions: the window selection alone only swaps
    // whole rows (the paint has no scroll offset of its own), which snapped
    // every land to a row boundary — the "flipping a book" scroll.
    let hidden_above = {
        let index = viewport.index();
        let cum_before: f64 = (0..span.start)
            .filter_map(|i| index.height_at(i).map(|(_, h, _)| h))
            .sum();
        (start - cum_before).max(0.0)
    };
    let mut visible = Vec::new();
    for i in span.start..span.end {
        if let Some((id, _, _)) = viewport.index().height_at(i) {
            if let Some(message) = messages.iter().find(|row| row.sequence as u64 == id.0) {
                visible.push(message_visible_row(message, assistant_author, macros));
            }
        }
    }
    if visible.is_empty() {
        visible = visible_rows(messages, assistant_author, macros);
        return (visible, outcome, 0.0);
    }
    (visible, outcome, hidden_above)
}

/// Single shared height baseline (A3 unification): `estimate_height` (the
/// presentation window) and `compositor_height_index` (the compositor
/// viewport) must derive from one model so the hydration window and the
/// painted window do not drift apart. Text-heavy rows keep the content-based
/// estimate; the compositor only raises rows to its bubble baseline and adds
/// the photo over-cover on top — never below it.
pub(crate) const COMPOSITOR_ROW_CSS: f64 = 56.0;

pub(crate) fn estimate_height(message: &MessageDto) -> f64 {
    // Script-aware width proxy: UTF-8 byte length double-counts Cyrillic and
    // quadruple-counts emoji, so those rows were baselined 2-4x too tall.
    // `estimate_tokens` weights chars by measured script density instead;
    // PX_PER_TOKEN keeps Latin single-byte text identical to the old byte
    // model (bytes/8 at ~4.6 chars/token).
    const PX_PER_TOKEN: f64 = 4.6 / 8.0;
    let tokens = estimate_tokens(&message.content) as f64;
    48.0 + (tokens * PX_PER_TOKEN).min(160.0)
}

/// A learned painted height applies only while the row's current estimate
/// still matches the estimate captured at learn time — an edited row
/// invalidates its own correction without any explicit invalidation path.
pub(crate) fn corrected_height_kind(
    message: &MessageDto,
    corrections: &HashMap<String, (f64, f64)>,
) -> (f64, HeightKind) {
    match corrections.get(&message.id) {
        Some((measured, captured)) if *captured == estimate_height(message) => {
            (*measured, HeightKind::Exact)
        }
        _ => {
            // Photo rows paint ~436px of raster (the same over-cover the
            // compositor index applies). Without it the presentation window
            // under-estimates image rows ~5x, so the budget, the window
            // selection and the scroll max all drift from the paint until
            // learning catches up row by row.
            let base = estimate_height(message);
            let has_photo =
                !neotavern_presentation_dioxus_shell::asset_image_refs(&message.content).is_empty();
            (
                base + if has_photo { 436.0 } else { 0.0 },
                HeightKind::Estimated,
            )
        }
    }
}

/// The single shared row-height read (L3): the measured painted height when
/// a fresh correction exists, the estimate otherwise.
pub(crate) fn corrected_height(
    message: &MessageDto,
    corrections: &HashMap<String, (f64, f64)>,
) -> f64 {
    corrected_height_kind(message, corrections).0
}

pub(crate) fn visible_rows(
    messages: &[MessageDto],
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
) -> Vec<VisibleRow> {
    let start = messages.len().saturating_sub(PRODUCT_PATH_VISIBLE);
    messages[start..]
        .iter()
        .map(|row| message_visible_row(row, assistant_author, macros))
        .collect()
}

pub(crate) fn message_visible_row(
    message: &MessageDto,
    assistant_author: &str,
    macros: &crate::macros::MacroContext,
) -> VisibleRow {
    let content = crate::macros::replace_macros(&message.content, macros);
    let model = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("model"))
        .and_then(|m| m.as_str())
        .or_else(|| message.meta.payload.get("model").and_then(|m| m.as_str()))
        .map(|s| s.to_string());
    let generation_time = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("durationMs"))
        .and_then(|d| d.as_u64())
        .map(|ms| format!("{:.1}s", ms as f64 / 1000.0));
    let token_count = message
        .meta
        .payload
        .get("generation")
        .and_then(|g| g.get("usage"))
        .and_then(|u| u.get("totalTokens"))
        .and_then(|t| t.as_i64())
        .or_else(|| {
            message
                .meta
                .payload
                .get("tokenCount")
                .and_then(|t| t.as_i64())
        })
        .or_else(|| message.meta.payload.get("tokens").and_then(|t| t.as_i64()));
    VisibleRow {
        id: message.id.clone(),
        role: role_name(&message.role).into(),
        content: content.clone(),
        kind: row_kind(&content),
        author: if message.role == MessageRole::User {
            "You".into()
        } else {
            assistant_author.to_string()
        },
        timestamp: neotavern_presentation_dioxus_shell::format_timestamp(&message.created_at),
        run_id: message.generation_run_id.clone(),
        manual_excluded: manual_excluded(&message.meta),
        checkpoint_chat_id: message.checkpoint_chat_id.clone(),
        // React `MessageSwipePager` counter ("N/M"). Kernel-plane messages do
        // not carry the legacy permutation fields (translateMessage reports
        // 0/null) — the label hydrates from the variants cache in `view()`,
        // exactly like the React query-derived `currentSwipe`.
        swipe_label: String::new(),
        model,
        generation_time,
        token_count,
    }
}

pub(crate) fn pick_active_persona<'a>(
    personas: &'a [PersonaDto],
    chat_persona_id: Option<&str>,
    app_persona_id: Option<&str>,
) -> Option<&'a PersonaDto> {
    if let Some(id) = chat_persona_id {
        if let Some(row) = personas.iter().find(|item| item.id == id) {
            return Some(row);
        }
    }
    if let Some(id) = app_persona_id {
        if let Some(row) = personas.iter().find(|item| item.id == id) {
            return Some(row);
        }
    }
    personas.iter().find(|item| item.is_default)
}

pub(crate) fn settings_macro_variables(items: &[SettingsItem]) -> HashMap<String, String> {
    let Some(value) = settings_unwrapped(items, "macro-variables") else {
        return HashMap::new();
    };
    let Some(obj) = value.as_object() else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(key, item)| item.as_str().map(|text| (key.clone(), text.to_string())))
        .collect()
}

pub(crate) fn role_name(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

pub(crate) fn row_kind(content: &str) -> RowKind {
    let image = content.contains("![");
    let markdown = content.contains("**") || content.contains('\n');
    match (image, markdown) {
        (true, true) => RowKind::Mixed,
        (true, false) => RowKind::Image,
        _ => RowKind::Markdown,
    }
}

/// Script-aware token estimation, ported from
/// `packages/shared/src/estimateTokens.ts` (the shared isomorphic fallback
/// counter). Measured densities: Latin ~5.1 chars/token, Cyrillic ~4.0,
/// CJK ~1.7, digits ~2.0, punctuation/space ~3.0, emoji ~1.1. Contributes
/// `1/rate` per character so mixed text stays within a few percent of the
/// exact tokenizer.
pub(crate) fn estimate_tokens(text: &str) -> u64 {
    const EMOJI_RATE: f64 = 1.1;
    const CJK_RATE: f64 = 1.7;
    const CYRILLIC_RATE: f64 = 4.0;
    const DIGIT_RATE: f64 = 2.0;
    const LETTER_RATE: f64 = 4.6;
    const OTHER_RATE: f64 = 3.0;
    let mut tokens = 0.0f64;
    for ch in text.chars() {
        let rate = if is_emoji(ch) {
            EMOJI_RATE
        } else if is_cjk(ch) {
            CJK_RATE
        } else if ('\u{0400}'..='\u{04FF}').contains(&ch) {
            CYRILLIC_RATE
        } else if ch.is_ascii_digit() {
            DIGIT_RATE
        } else if ch.is_alphabetic() {
            LETTER_RATE
        } else {
            OTHER_RATE
        };
        tokens += 1.0 / rate;
    }
    tokens.round() as u64
}

pub(crate) fn is_emoji(ch: char) -> bool {
    ('\u{1F000}'..='\u{1FAFF}').contains(&ch)
        || ('\u{2600}'..='\u{27BF}').contains(&ch)
        || ('\u{FE00}'..='\u{FE0F}').contains(&ch)
        || ('\u{1F1E6}'..='\u{1F1FF}').contains(&ch)
}

pub(crate) fn is_cjk(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        || ('\u{3400}'..='\u{4DBF}').contains(&ch)
        || ('\u{3040}'..='\u{30FF}').contains(&ch)
        || ('\u{AC00}'..='\u{D7AF}').contains(&ch)
}

pub(crate) fn manual_excluded(meta: &FreeObject) -> bool {
    meta.payload.get("manualExcluded") == Some(&Value::Bool(true))
}

/// Variant picker row preview (React `PREVIEW_MAX_LENGTH = 140`): the first
/// 140 characters of the variant content — a byte-safe char-bounded slice.
pub(crate) fn preview_text(content: &str) -> String {
    content.chars().take(140).collect()
}

pub(crate) fn with_manual_excluded(meta: &FreeObject, excluded: bool) -> FreeObject {
    let mut payload = meta.payload.clone();
    match &mut payload {
        Value::Object(map) => {
            map.insert("manualExcluded".into(), json!(excluded));
        }
        _ => {
            payload = json!({ "manualExcluded": excluded });
        }
    }
    FreeObject { payload }
}

/// Non-overlapping case-insensitive count, matching React `ChatHeader`
/// `countTextMatches` (`indexOf` loop).
pub(crate) fn count_text_matches(text: &str, query: &str) -> u64 {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return 0;
    }
    let haystack = text.to_lowercase();
    let mut count = 0u64;
    let mut offset = 0usize;
    while offset < haystack.len() {
        let Some(found) = haystack[offset..].find(&needle) else {
            break;
        };
        count += 1;
        offset += found + needle.len();
        if needle.is_empty() {
            break;
        }
    }
    count
}

pub(crate) fn run_step_from_envelope(
    envelope: contracts_generated::generated::EventEnvelope,
) -> Option<RunStepView> {
    if envelope.r#type != "generation.step" {
        return None;
    }
    let event: GenerationEvent = serde_json::from_value(envelope.payload).ok()?;
    let GenerationEvent::GenerationStep { step } = event else {
        return None;
    };
    let step_type = match step.r#type {
        contracts_generated::generated::GenerationStepType::ProviderTurn => "provider_turn",
        contracts_generated::generated::GenerationStepType::ToolCall => "tool_call",
        contracts_generated::generated::GenerationStepType::ToolResult => "tool_result",
        contracts_generated::generated::GenerationStepType::FinalCommit => "final_commit",
    };
    let status = match step.status {
        contracts_generated::generated::GenerationStepStatus::Running => "running",
        contracts_generated::generated::GenerationStepStatus::Waiting => "waiting",
        contracts_generated::generated::GenerationStepStatus::Completed => "completed",
        contracts_generated::generated::GenerationStepStatus::Failed => "failed",
    };
    Some(RunStepView {
        sequence: step.sequence,
        step_type: step_type.into(),
        status: status.into(),
        attempt: step.attempt,
        created_at: step.created_at,
    })
}

/// React `ChatPage.onStep`: a waiting `tool_call` stores only
/// `step.input.toolCall.name` (fallback `"tool"`). Any other step type, or a
/// non-waiting tool_call, clears the badge. Arguments and results are never
/// copied into session state (SEC-07).
pub(crate) fn apply_generation_step(
    state: &mut ChatRouteState,
    step: &contracts_generated::generated::GenerationStep,
) {
    use contracts_generated::generated::{GenerationStepStatus, GenerationStepType};
    match step.r#type {
        GenerationStepType::ToolCall if matches!(step.status, GenerationStepStatus::Waiting) => {
            state.tool_activity_name = Some(tool_call_display_name(&step.input));
        }
        _ => {
            state.tool_activity_name = None;
        }
    }
}

pub(crate) fn tool_call_display_name(input: &Option<Value>) -> String {
    input
        .as_ref()
        .and_then(|value| value.get("toolCall"))
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("tool")
        .to_string()
}

#[cfg(test)]
mod height_estimate_tests {
    use super::*;
    use contracts_generated::generated::{FreeObject, MessageRole};

    fn msg(content: &str) -> MessageDto {
        MessageDto {
            id: "m".into(),
            chat_id: "c".into(),
            role: MessageRole::User,
            content: content.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            sequence: 1,
            generation_run_id: None,
            meta: FreeObject {
                payload: serde_json::json!({}),
            },
            checkpoint_chat_id: None,
        }
    }

    #[test]
    fn estimate_height_is_script_aware() {
        let latin = msg(&"a".repeat(400));
        let cyrillic = msg(&"а".repeat(400)); // U+0430, 2 bytes in UTF-8
        let emoji = msg(&"😀".repeat(50)); // 4 bytes each

        // Latin keeps the old byte-model calibration (400 chars -> ~50px
        // above the 48px base; estimate_tokens rounds to whole tokens).
        let latin_h = estimate_height(&latin);
        assert!((latin_h - 98.025).abs() < 0.01, "latin: {latin_h}");
        // Cyrillic was 2x inflated by UTF-8 byte length (148px); the script
        // model lands on the Latin baseline plus the wider-glyph margin.
        let cyr_h = estimate_height(&cyrillic);
        assert!((cyr_h - 105.5).abs() < 0.01, "cyrillic: {cyr_h}");
        assert!(cyr_h > latin_h, "cyrillic glyphs are wider, not narrower");
        // Emoji stays proportional to its on-screen advance, not its 4-byte
        // encoding: a 50-emoji row beats a 50-char Latin row but is far from
        // the 200-byte penalty.
        let emoji_h = estimate_height(&emoji);
        let latin50 = estimate_height(&msg(&"a".repeat(50)));
        assert!(emoji_h > latin50, "emoji {emoji_h} vs latin {latin50}");
    }

    #[test]
    fn height_corrections_replace_estimates_until_content_changes() {
        let mut row = msg("hello");
        row.sequence = 3;
        let estimate = estimate_height(&row);
        let corrections = HashMap::from([(
            row.id.clone(),
            (250.0, estimate), // painted 250px, captured at this estimate
        )]);

        // Fresh correction: the measured painted height wins, marked Exact.
        let (height, kind) = corrected_height_kind(&row, &corrections);
        assert_eq!(height, 250.0);
        assert_eq!(kind, HeightKind::Exact);

        // The row is edited (content changed): the captured estimate no
        // longer matches, the correction self-invalidates.
        row.content = "hello, edited".into();
        let (height, kind) = corrected_height_kind(&row, &corrections);
        assert_eq!(height, estimate_height(&row));
        assert_eq!(kind, HeightKind::Estimated);
    }

    #[test]
    fn height_correction_lru_evicts_oldest() {
        let mut state = ChatRouteState::default();
        for i in 0..600 {
            state.learn_height_correction(&format!("m{i}"), 100.0, 90.0);
        }
        assert!(state.height_corrections.len() <= 512);
        // The first 88 ids were evicted; the newest survive.
        assert!(!state.height_corrections.contains_key("m0"));
        assert!(state.height_corrections.contains_key("m599"));
        // A re-learn of an existing id refreshes without re-inserting order.
        state.learn_height_correction("m599", 120.0, 90.0);
        assert_eq!(state.height_correction("m599"), Some(120.0));
    }
}
