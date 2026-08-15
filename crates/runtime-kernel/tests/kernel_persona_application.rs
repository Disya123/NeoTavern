//! Этап 4 slice 3 kernel integration tests (ADR-0047 waiver 5): the user
//! persona application over the wire — `chats.persona_id` linkage
//! (`chats.create`/`chats.update` with `personaId`, `PERSONA_NOT_FOUND` on an
//! unknown persona) and the prompt pipeline applying the resolved persona
//! name as `{{user}}` (plan `userName` + substituted message content).

use contracts_generated::generated::{
    decode_prompt_plan, ChatDto, MessageRole, PersonaDto, ResultListPersonas,
};
use runtime_kernel::{
    CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode, StreamNotice,
};
use std::time::Duration;

const CHAT_ID: &str = "00000000-0000-4000-8000-000000000001";
const CHARACTER_ID: &str = "00000000-0000-4000-8000-000000000002";
const PERSONA_ID: &str = "00000000-0000-4000-8000-000000000003";

// ---------------------------------------------------------------------------
// Helpers (mirror prompt_plan.rs)
// ---------------------------------------------------------------------------

fn open_kernel(root: &std::path::Path) -> Kernel {
    Kernel::open(KernelConfig {
        expected_schema_hash: contracts_generated::contract_schema_hash().to_string(),
        ffi_abi_version: 1,
        data_root: Some(root.to_path_buf()),
    })
    .expect("kernel must open with the embedded contract's own hash")
}

/// Seeds a character + persona + chat linked to that persona + one user
/// history message containing `{{user}}`, through `neotavern_storage`, then
/// releases the lease.
fn seed_chat_with_persona(root: &std::path::Path) {
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
             VALUES (?1, 'Aria', 'Aria the cheerful guide.', NULL, '[]', \
             '{\"personality\":\"playful and witty\"}', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
            rusqlite::params![CHARACTER_ID],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO personas (id, name, description, avatar, is_default, created_at, updated_at) \
             VALUES (?1, 'Aria User', 'The user persona.', NULL, 1, '2026-08-13T00:00:10Z', '2026-08-13T00:00:10Z')",
            rusqlite::params![PERSONA_ID],
        )
        .expect("seed persona");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, persona_id, created_at, updated_at) \
             VALUES (?1, 'Plan test', ?2, ?3, '2026-08-13T00:01:00Z', '2026-08-13T00:01:00Z')",
            rusqlite::params![CHAT_ID, CHARACTER_ID, PERSONA_ID],
        )
        .expect("seed chat");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, created_at) VALUES \
             ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?1, 'user', '{{user}}: hello Aria', 1, '2026-08-13T00:02:00Z')",
            rusqlite::params![CHAT_ID],
        )
        .expect("seed message");
        Ok::<(), neotavern_storage::StorageError>(())
    })
    .expect("seeding transaction must succeed");
    drop(db);
}

fn dispatch_json(kernel: &Kernel, op: &str, request: serde_json::Value) -> serde_json::Value {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    let response = kernel
        .dispatch(op, &bytes, &flag)
        .expect("dispatch must succeed");
    serde_json::from_slice(&response).expect("response must be valid JSON")
}

fn dispatch_decoded<T: serde::de::DeserializeOwned>(
    kernel: &Kernel,
    op: &str,
    request: serde_json::Value,
) -> Result<T, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel
        .dispatch(op, &bytes, &flag)
        .map(|response| serde_json::from_slice(&response).expect("response must decode as DTO"))
}

fn start_stream(
    kernel: &Kernel,
    op: &str,
    request: serde_json::Value,
) -> Result<runtime_kernel::EventStream, KernelError> {
    let flag = CancellationFlag::new();
    let bytes = serde_json::to_vec(&request).expect("request serialization cannot fail");
    kernel.dispatch_stream(op, &bytes, &flag)
}

fn drain_until_terminal(stream: &mut runtime_kernel::EventStream, timeout: Duration) {
    loop {
        match stream.next_notice(timeout) {
            Some(StreamNotice::Committed { .. }) => {}
            Some(StreamNotice::Terminal { .. }) => return,
            None => panic!("stream ended without a terminal notice"),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// `chats.create`/`chats.get`/`chats.update` carry `personaId`; an unknown
/// persona is a stable `PERSONA_NOT_FOUND` with the `personaId` param.
#[test]
fn chat_persona_linkage_over_wire() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());

    // personas.create → id.
    let persona = dispatch_decoded::<PersonaDto>(
        &kernel,
        "personas.create",
        serde_json::json!({ "name": "Aria User" }),
    )
    .expect("personas.create must succeed");
    let persona2 = dispatch_decoded::<PersonaDto>(
        &kernel,
        "personas.create",
        serde_json::json!({ "name": "Zoe" }),
    )
    .expect("personas.create must succeed");

    // character + chat with personaId.
    let character = dispatch_decoded::<contracts_generated::generated::CharacterDto>(
        &kernel,
        "characters.create",
        serde_json::json!({ "name": "Aria", "description": "Guide." }),
    )
    .expect("characters.create must succeed");
    let chat = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        serde_json::json!({
            "characterId": character.id,
            "title": "Persona chat",
            "personaId": persona.id,
        }),
    )
    .expect("chats.create with personaId must succeed");
    assert_eq!(chat.persona_id.as_deref(), Some(persona.id.as_str()));

    // get echoes personaId; the other chat (no persona) omits it.
    let fetched = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.get",
        serde_json::json!({ "chatId": chat.id }),
    )
    .expect("chats.get must succeed");
    assert_eq!(fetched.persona_id.as_deref(), Some(persona.id.as_str()));
    let plain = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        serde_json::json!({ "characterId": character.id }),
    )
    .expect("chats.create without personaId must succeed");
    assert_eq!(plain.persona_id, None);

    // update re-links the persona and renames in one call.
    let updated = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.update",
        serde_json::json!({
            "chatId": chat.id,
            "title": "Renamed",
            "personaId": persona2.id,
        }),
    )
    .expect("chats.update with personaId must succeed");
    assert_eq!(updated.title, "Renamed");
    assert_eq!(updated.persona_id.as_deref(), Some(persona2.id.as_str()));

    // title-only update keeps the persona; an empty update is a no-op.
    let title_only = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.update",
        serde_json::json!({ "chatId": chat.id, "title": "Renamed again" }),
    )
    .expect("chats.update title-only must succeed");
    assert_eq!(title_only.persona_id.as_deref(), Some(persona2.id.as_str()));
    let noop = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.update",
        serde_json::json!({ "chatId": chat.id }),
    )
    .expect("chats.update with no fields must succeed");
    assert_eq!(noop.title, "Renamed again");

    // Unknown persona on create / update → PERSONA_NOT_FOUND (NotFound class).
    let err = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.create",
        serde_json::json!({
            "characterId": character.id,
            "personaId": "99999999-9999-4999-8999-999999999999",
        }),
    )
    .expect_err("unknown persona must be rejected");
    assert_eq!(err.code, KernelErrorCode::NotFound);
    assert!(
        err.message.contains("PERSONA_NOT_FOUND"),
        "message: {}",
        err.message
    );
    let err = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.update",
        serde_json::json!({
            "chatId": chat.id,
            "personaId": "99999999-9999-4999-8999-999999999999",
        }),
    )
    .expect_err("unknown persona on update must be rejected");
    assert_eq!(err.code, KernelErrorCode::NotFound);

    // Deleting the linked persona clears the chat's reference (SET NULL).
    dispatch_decoded::<contracts_generated::generated::ResultEmpty>(
        &kernel,
        "personas.delete",
        serde_json::json!({ "personaId": persona2.id }),
    )
    .expect("personas.delete must succeed");
    let after_delete = dispatch_decoded::<ChatDto>(
        &kernel,
        "chats.get",
        serde_json::json!({ "chatId": chat.id }),
    )
    .expect("chats.get must succeed");
    assert_eq!(after_delete.persona_id, None, "ON DELETE SET NULL");
}

/// The prompt plan resolves the chat's user persona and applies it as
/// `{{user}}` across the selected history AND the current input.
#[test]
fn prompt_plan_applies_user_persona_macro() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat_with_persona(root.path());
    let kernel = open_kernel(root.path());

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "{{user}}: hello Aria",
            "provider": "fake",
            "model": "steps=4",
        }),
    )
    .expect("generation.start must open a stream");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    let plan_bytes = dispatch_json(
        &kernel,
        "generation.prompt.plan",
        serde_json::json!({ "runId": run_id }),
    );
    let plan = decode_prompt_plan(&serde_json::to_vec(&plan_bytes).expect("plan to bytes"))
        .expect("schema-valid plan");

    assert_eq!(
        plan.user_name.as_deref(),
        Some("Aria User"),
        "plan carries the resolved user persona name"
    );
    // History user message and the current input both render {{user}}.
    let history_user = plan
        .messages
        .iter()
        .find(|m| m.role == MessageRole::User && m.content.contains("hello Aria"))
        .expect("history user message in plan");
    assert_eq!(history_user.content, "Aria User: hello Aria");
    let last = plan.messages.last().expect("user input in plan");
    assert_eq!(last.role, MessageRole::User);
    assert_eq!(last.content, "Aria User: hello Aria");
    // The character-card persona block still exists (card personality).
    assert!(
        plan.system_blocks.iter().any(|b| b.source == "persona"),
        "card persona block kept"
    );
}

/// Without a linked persona the plan omits `userName` and passes the message
/// through verbatim (no macro substitution).
#[test]
fn prompt_plan_without_persona_passes_message_verbatim() {
    let root = tempfile::tempdir().expect("tempdir");
    // Same seed minus the persona reference: reuse the fixture and clear it.
    seed_chat_with_persona(root.path());
    {
        let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
        let db = neotavern_storage::open::open(
            root.path(),
            &neotavern_storage::baseline::ConnectionPolicy::default(),
            &mut progress,
        )
        .expect("root must open");
        db.conn()
            .execute(
                "UPDATE chats SET persona_id = NULL WHERE id = ?1",
                rusqlite::params![CHAT_ID],
            )
            .expect("clear persona");
        drop(db);
    }
    let kernel = open_kernel(root.path());

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "{{user}}: hello",
            "provider": "fake",
            "model": "steps=4",
        }),
    )
    .expect("generation.start must open a stream");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    let plan_bytes = dispatch_json(
        &kernel,
        "generation.prompt.plan",
        serde_json::json!({ "runId": run_id }),
    );
    let plan = decode_prompt_plan(&serde_json::to_vec(&plan_bytes).expect("plan to bytes"))
        .expect("schema-valid plan");
    assert_eq!(plan.user_name, None, "no persona → no userName");
    let last = plan.messages.last().expect("user input in plan");
    assert_eq!(last.role, MessageRole::User);
    assert_eq!(last.content, "{{user}}: hello", "verbatim, no substitution");
}

/// Personas over the wire are unaffected by the chat linkage (regression
/// guard for the reordered conversion + the new chats FK).
#[test]
fn persona_list_after_chat_linkage() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel(root.path());
    dispatch_decoded::<PersonaDto>(
        &kernel,
        "personas.create",
        serde_json::json!({ "name": "Aria User" }),
    )
    .expect("personas.create must succeed");
    let list =
        dispatch_decoded::<ResultListPersonas>(&kernel, "personas.list", serde_json::json!({}))
            .expect("personas.list must succeed");
    assert_eq!(list.items.len(), 1);
}

/// Memory/RAG retrieval (ТЗ §4.4, Этап 4 slice 3): the prompt plan injects
/// keyword-activated memory blocks scoped to the chat's character, skipping
/// disabled rows, other characters' memories and key-less passive notes.
#[test]
fn prompt_plan_retrieves_scoped_memories_by_keyword() {
    let root = tempfile::tempdir().expect("tempdir");
    seed_chat_with_persona(root.path());
    {
        let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
        let mut db = neotavern_storage::open::open(
            root.path(),
            &neotavern_storage::baseline::ConnectionPolicy::default(),
            &mut progress,
        )
        .expect("root must open");
        db.transaction(|tx| {
            for (id, scope, character_id, keys, content, enabled) in [
                ("mem-1", "global", None, r#"["city"]"#, "The city sleeps.", 1),
                (
                    "mem-2",
                    "character",
                    Some(CHARACTER_ID),
                    r#"["tea"]"#,
                    "Alice likes tea.",
                    1,
                ),
                ("mem-3", "global", None, r#"["city"]"#, "Should not appear.", 0),
                (
                    "mem-4",
                    "character",
                    Some("00000000-0000-4000-8000-00000000dead"),
                    r#"["ghost"]"#,
                    "Other character's memory.",
                    1,
                ),
                ("mem-5", "global", None, "[]", "Passive note.", 1),
            ] {
                tx.execute(
                    "INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position, metadata_json, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, '{}', '2026-08-13T00:05:00Z', '2026-08-13T00:05:00Z')",
                    rusqlite::params![id, scope, character_id, keys, content, enabled],
                )
                .expect("seed memory");
            }
            Ok::<(), neotavern_storage::StorageError>(())
        })
        .expect("memory seeding transaction must succeed");
        drop(db);
    }
    let kernel = open_kernel(root.path());

    let mut stream = start_stream(
        &kernel,
        "generation.start",
        serde_json::json!({
            "chatId": CHAT_ID,
            "message": "tea in the city",
            "provider": "fake",
            "model": "steps=4",
        }),
    )
    .expect("generation.start must open a stream");
    let run_id = stream.stream_id().to_string();
    drain_until_terminal(&mut stream, Duration::from_secs(30));

    let plan_bytes = dispatch_json(
        &kernel,
        "generation.prompt.plan",
        serde_json::json!({ "runId": run_id }),
    );
    let plan = decode_prompt_plan(&serde_json::to_vec(&plan_bytes).expect("plan to bytes"))
        .expect("schema-valid plan");

    let memory_texts: Vec<&str> = plan
        .system_blocks
        .iter()
        .filter(|b| b.source == "memory")
        .map(|b| b.text.as_str())
        .collect();
    assert!(
        memory_texts.contains(&"The city sleeps."),
        "global memory activated: {memory_texts:?}"
    );
    assert!(
        memory_texts.contains(&"Alice likes tea."),
        "character memory activated for the chat's character: {memory_texts:?}"
    );
    assert!(
        !memory_texts.contains(&"Should not appear."),
        "disabled memory must not activate: {memory_texts:?}"
    );
    assert!(
        !memory_texts
            .iter()
            .any(|t| t.contains("Other character's memory.")),
        "other-character memory must not activate: {memory_texts:?}"
    );
    assert!(
        !memory_texts.iter().any(|t| t.contains("Passive note.")),
        "key-less memory must not activate: {memory_texts:?}"
    );
    assert_eq!(
        plan.user_name.as_deref(),
        Some("Aria User"),
        "persona resolution is independent of memory retrieval"
    );
}
