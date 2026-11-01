//! Kernel full-text search tests (M7 Etap-4 cluster 16): `search.query` runs
//! the FTS5 index the v23 migration builds over characters/chats/messages/
//! lorebooks (the legacy `GET /api/v2/search` parity), `search.rebuild`
//! repopulates every index transactionally (the legacy rebuild route), the
//! sync triggers keep the index fresh across edits/deletes, the trash filter
//! hides soft-deleted characters and the legacy `tag` filter applies to the
//! characters scope only.

use contracts_generated::generated::{ResultEmpty, ResultSearch};
use runtime_kernel::{CancellationFlag, Kernel, KernelConfig, KernelError, KernelErrorCode};
use serde_json::{json, Value};

fn open_kernel_with_root(root: &std::path::Path) -> Kernel {
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
    dispatch_json(kernel, op, request)
        .map(|value| serde_json::from_value(value).expect("response must decode as the DTO"))
}

fn search(kernel: &Kernel, request: Value) -> ResultSearch {
    dispatch_decoded(kernel, "search.query", request).expect("search.query must succeed")
}

fn hit_ids(result: &ResultSearch) -> Vec<(String, String)> {
    result
        .items
        .iter()
        .map(|item| (format!("{:?}", item.scope), item.id.clone()))
        .collect()
}

fn create_character(kernel: &Kernel, name: &str, description: &str, tags: Value) -> String {
    let created: Value = dispatch_decoded(
        kernel,
        "characters.create",
        json!({ "name": name, "description": description, "tags": tags }),
    )
    .expect("characters.create must succeed");
    created["id"].as_str().expect("id").to_string()
}

fn create_chat(kernel: &Kernel, character_id: &str, title: &str) -> String {
    let created: Value = dispatch_decoded(
        kernel,
        "chats.create",
        json!({ "characterId": character_id, "title": title }),
    )
    .expect("chats.create must succeed");
    created["id"].as_str().expect("chat id").to_string()
}

fn create_message(kernel: &Kernel, chat_id: &str, content: &str) -> String {
    let created: Value = dispatch_decoded(
        kernel,
        "chats.messages.create",
        json!({ "chatId": chat_id, "role": "user", "content": content }),
    )
    .expect("message must be created");
    created["id"].as_str().expect("message id").to_string()
}

/// Every scope answers a matching query with the right entity.
#[test]
fn search_finds_every_scope() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(
        &kernel,
        "Seraphina",
        "Forest guardian of the woodland cottage",
        json!(["fantasy"]),
    );
    let chat_id = create_chat(&kernel, &character_id, "Forest trip");
    let message_id = create_message(&kernel, &chat_id, "The forest was quiet today");
    dispatch_decoded::<Value>(
        &kernel,
        "lorebooks.create",
        json!({
            "name": "Forest lore",
            "description": "Woodland knowledge",
            "entries": [{ "keys": ["forest"], "content": "The forest hides old shrines." }]
        }),
    )
    .expect("lorebook must be created");

    let result = search(&kernel, json!({ "q": "forest" }));
    assert_eq!(result.query, "forest");
    let hits = hit_ids(&result);
    assert!(hits.contains(&("Characters".to_string(), character_id.clone())));
    assert!(hits.contains(&("Chats".to_string(), chat_id.clone())));
    assert!(hits.contains(&("Messages".to_string(), message_id.clone())));
    assert!(
        hits.iter().any(|(scope, _)| scope == "Lorebooks"),
        "the lorebook must answer the query: {hits:?}"
    );
    // The wire DTO carries a usable snippet and an epoch-ms stamp.
    let character_hit = result
        .items
        .iter()
        .find(|item| item.id == character_id)
        .expect("character hit");
    assert_eq!(character_hit.title, "Seraphina");
    assert!(!character_hit.snippet.is_empty());
    assert!(
        character_hit.timestamp > 1_700_000_000_000,
        "epoch ms stamp"
    );
}

/// Scope filter, the characters-only `tag` filter, name sort and limit.
#[test]
fn search_filters_scopes_tags_and_sorts() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let tagged = create_character(&kernel, "Alpha Brave", "A brave knight", json!(["fantasy"]));
    let untagged = create_character(&kernel, "Brave Two", "Another brave soul", json!([]));

    // Tag filter (characters scope only).
    let filtered = search(
        &kernel,
        json!({ "q": "brave", "scope": "characters", "tag": "fantasy" }),
    );
    assert_eq!(
        hit_ids(&filtered),
        vec![("Characters".to_string(), tagged.clone())]
    );

    // Name sort: case-insensitive title order.
    let sorted = search(
        &kernel,
        json!({ "q": "brave", "scope": "characters", "sort": "name" }),
    );
    let titles: Vec<String> = sorted.items.iter().map(|item| item.title.clone()).collect();
    assert_eq!(titles.len(), 2);
    assert!(titles[0].to_lowercase() <= titles[1].to_lowercase());
    assert_eq!(sorted.items[0].id, tagged);
    assert_eq!(sorted.items[1].id, untagged);

    // Limit cuts the merged list.
    let limited = search(&kernel, json!({ "q": "brave", "limit": 1 }));
    assert_eq!(limited.items.len(), 1);
}

/// The trash filter: soft-deleted characters leave the index RESULTS (not the
/// index) and come back after `characters.restore`.
#[test]
fn search_hides_trashed_characters_until_restored() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let kept = create_character(&kernel, "Unicorn Keeper", "Keeps unicorns", json!([]));
    let trashed = create_character(&kernel, "Unicorn Rider", "Rides unicorns", json!([]));

    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "characters.delete",
        json!({ "characterId": trashed }),
    )
    .expect("soft delete must succeed");
    let result = search(&kernel, json!({ "q": "unicorn", "scope": "characters" }));
    assert_eq!(
        hit_ids(&result),
        vec![("Characters".to_string(), kept.clone())]
    );

    dispatch_decoded::<Value>(
        &kernel,
        "characters.restore",
        json!({ "characterId": trashed }),
    )
    .expect("restore must succeed");
    let result = search(&kernel, json!({ "q": "unicorn", "scope": "characters" }));
    let ids: Vec<String> = result.items.iter().map(|item| item.id.clone()).collect();
    assert!(ids.contains(&kept));
    assert!(ids.contains(&trashed));
}

/// Sync triggers keep the index fresh; `search.rebuild` converges back to the
/// base tables after any drift.
#[test]
fn search_triggers_stay_fresh_and_rebuild_converges() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());
    let character_id = create_character(&kernel, "Wanderer", "Desert drifter", json!([]));
    let chat_id = create_chat(&kernel, &character_id, "Desert nights");
    let message_id = create_message(&kernel, &chat_id, "A unique sandstorm token");
    let lorebook: Value = dispatch_decoded(
        &kernel,
        "lorebooks.create",
        json!({
            "name": "Travel notes",
            "entries": [{ "keys": ["dragon"], "content": "A dragon sleeps under the dune." }]
        }),
    )
    .expect("lorebook must be created");
    let lorebook_id = lorebook["id"].as_str().expect("lorebook id").to_string();

    // UPDATE trigger: new text is searchable, old text is gone.
    dispatch_decoded::<Value>(
        &kernel,
        "characters.update",
        json!({ "characterId": character_id, "description": "Jungle explorer now" }),
    )
    .expect("update must succeed");
    assert!(!search(&kernel, json!({ "q": "jungle" })).items.is_empty());
    assert!(search(&kernel, json!({ "q": "drifter" })).items.is_empty());

    // Lorebook rename: the book now answers its new name through the index.
    dispatch_decoded::<Value>(
        &kernel,
        "lorebooks.update",
        json!({ "lorebookId": lorebook_id, "name": "Dragon codex" }),
    )
    .expect("lorebook rename must succeed");
    let by_name = search(&kernel, json!({ "q": "codex" }));
    assert!(hit_ids(&by_name)
        .iter()
        .any(|(scope, _)| scope == "Lorebooks"));
    // Entry content inside entries_json is indexed for the book.
    let by_entry = search(&kernel, json!({ "q": "dune" }));
    assert!(hit_ids(&by_entry)
        .iter()
        .any(|(scope, _)| scope == "Lorebooks"));

    // DELETE trigger: the removed message leaves the index.
    dispatch_decoded::<ResultEmpty>(
        &kernel,
        "chats.messages.delete",
        json!({ "chatId": chat_id, "messageId": message_id }),
    )
    .expect("message delete must succeed");
    assert!(search(&kernel, json!({ "q": "sandstorm" }))
        .items
        .is_empty());

    // Rebuild: empty result (legacy parity), and every surviving entity is
    // found again purely from the rebuilt indexes.
    let rebuilt: ResultSearch =
        dispatch_decoded(&kernel, "search.rebuild", json!({})).expect("rebuild must succeed");
    assert_eq!(rebuilt.query, "");
    assert!(rebuilt.items.is_empty());
    assert!(!search(&kernel, json!({ "q": "jungle" })).items.is_empty());
    assert!(!search(&kernel, json!({ "q": "desert" })).items.is_empty());
    assert!(search(&kernel, json!({ "q": "sandstorm" }))
        .items
        .is_empty());
}

/// Contract honesty: an empty `q` and an unknown `sort` are contract
/// violations; token-free text (punctuation only) is an honest empty result.
#[test]
fn search_rejects_contract_violations_and_empty_token_sets() {
    let root = tempfile::tempdir().expect("tempdir");
    let kernel = open_kernel_with_root(root.path());

    let empty_q: KernelError = dispatch_json(&kernel, "search.query", json!({ "q": "" }))
        .expect_err("empty q must be a contract violation");
    assert_eq!(empty_q.code, KernelErrorCode::ContractViolation);

    let bad_sort: KernelError = dispatch_json(
        &kernel,
        "search.query",
        json!({ "q": "x", "sort": "random" }),
    )
    .expect_err("unknown sort must be a contract violation");
    assert_eq!(bad_sort.code, KernelErrorCode::ContractViolation);

    // Punctuation-only text produces no FTS terms — an honest empty page.
    let result = search(&kernel, json!({ "q": "!!! ???" }));
    assert_eq!(result.query, "!!! ???");
    assert!(result.items.is_empty());
}
