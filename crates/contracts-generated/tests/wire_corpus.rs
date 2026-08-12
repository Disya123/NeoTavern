//! Wire-corpus integration test: drives every generated `decode_*` fn against
//! the canonical fixture corpus emitted by `tools/contract-codegen/codegen.mjs`.
//!
//! Requires `packages/contracts/generated/fixtures/{corpus.json,<fixture>.json}`
//! to exist at test runtime (produced by the codegen step, which also emits
//! `crates/contracts-generated/src/generated.rs`).

use contracts_generated::generated::{
    decode_backup_dto, decode_character_dto, decode_chat_dto, decode_error_dto,
    decode_event_envelope, decode_generation_event, decode_generation_run,
    decode_generation_status, decode_lorebook_dto, decode_message_dto, decode_message_role,
    decode_meta_dto, decode_paged_characters, decode_paged_chats, decode_paged_generation_events,
    decode_paged_messages, decode_preset_dto, decode_request_cancel_generation,
    decode_request_create_character, decode_request_delete_character,
    decode_request_discard_generation, decode_request_empty, decode_request_envelope,
    decode_request_get_character, decode_request_get_chat, decode_request_get_generation_run,
    decode_request_keep_partial_generation, decode_request_list_characters,
    decode_request_list_chats, decode_request_list_generation_events, decode_request_list_messages,
    decode_request_retry_generation, decode_request_start_generation,
    decode_request_update_character, decode_response_envelope, decode_result_empty,
    decode_result_list_backups, decode_result_list_lorebooks, decode_result_list_presets,
};
use contracts_generated::{contract_schema_hash, wire_protocol, WireError};
use serde::de::DeserializeOwned;
use std::fmt::Debug;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

/// Directory holding `corpus.json` and the fixture files, resolved at test
/// runtime from the crate manifest (repo layout: `crates/contracts-generated`).
const FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/generated/fixtures"
);

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(FIXTURES_DIR).join(name)
}

fn read_fixture(name: &str) -> Vec<u8> {
    let path = fixture_path(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()))
}

/// Dispatches one corpus entry to the generated decoder for its `schemaId`.
///
/// Every schemaId the corpus can contain is covered here; an unknown id fails
/// loudly instead of silently passing.
fn dispatch(schema_id: &str, bytes: &[u8], valid: bool) {
    match schema_id {
        "wire.meta.dto" => corpus_case(schema_id, decode_meta_dto, bytes, valid),
        "wire.character.dto" => corpus_case(schema_id, decode_character_dto, bytes, valid),
        "wire.chat.dto" => corpus_case(schema_id, decode_chat_dto, bytes, valid),
        "wire.message.dto" => corpus_case(schema_id, decode_message_dto, bytes, valid),
        "wire.backup.dto" => corpus_case(schema_id, decode_backup_dto, bytes, valid),
        "wire.lorebook.dto" => corpus_case(schema_id, decode_lorebook_dto, bytes, valid),
        "wire.preset.dto" => corpus_case(schema_id, decode_preset_dto, bytes, valid),
        "wire.paged.characters" => corpus_case(schema_id, decode_paged_characters, bytes, valid),
        "wire.paged.chats" => corpus_case(schema_id, decode_paged_chats, bytes, valid),
        "wire.paged.messages" => corpus_case(schema_id, decode_paged_messages, bytes, valid),
        "wire.generation.event" => corpus_case(schema_id, decode_generation_event, bytes, valid),
        "wire.generation.status" => corpus_case(schema_id, decode_generation_status, bytes, valid),
        "wire.generation.run" => corpus_case(schema_id, decode_generation_run, bytes, valid),
        "wire.message.role" => corpus_case(schema_id, decode_message_role, bytes, valid),
        "wire.paged.generation-events" => {
            corpus_case(schema_id, decode_paged_generation_events, bytes, valid)
        }
        "wire.request.get-generation-run" => {
            corpus_case(schema_id, decode_request_get_generation_run, bytes, valid)
        }
        "wire.request.retry-generation" => {
            corpus_case(schema_id, decode_request_retry_generation, bytes, valid)
        }
        "wire.request.keep-partial-generation" => {
            corpus_case(schema_id, decode_request_keep_partial_generation, bytes, valid)
        }
        "wire.request.discard-generation" => {
            corpus_case(schema_id, decode_request_discard_generation, bytes, valid)
        }
        "wire.request.list-generation-events" => {
            corpus_case(schema_id, decode_request_list_generation_events, bytes, valid)
        }
        "wire.error.dto" => corpus_case(schema_id, decode_error_dto, bytes, valid),
        "wire.request.empty" => corpus_case(schema_id, decode_request_empty, bytes, valid),
        "wire.request.list-characters" => {
            corpus_case(schema_id, decode_request_list_characters, bytes, valid)
        }
        "wire.request.get-character" => {
            corpus_case(schema_id, decode_request_get_character, bytes, valid)
        }
        "wire.request.create-character" => {
            corpus_case(schema_id, decode_request_create_character, bytes, valid)
        }
        "wire.request.update-character" => {
            corpus_case(schema_id, decode_request_update_character, bytes, valid)
        }
        "wire.request.delete-character" => {
            corpus_case(schema_id, decode_request_delete_character, bytes, valid)
        }
        "wire.request.list-chats" => {
            corpus_case(schema_id, decode_request_list_chats, bytes, valid)
        }
        "wire.request.get-chat" => corpus_case(schema_id, decode_request_get_chat, bytes, valid),
        "wire.request.list-messages" => {
            corpus_case(schema_id, decode_request_list_messages, bytes, valid)
        }
        "wire.request.start-generation" => {
            corpus_case(schema_id, decode_request_start_generation, bytes, valid)
        }
        "wire.request.cancel-generation" => {
            corpus_case(schema_id, decode_request_cancel_generation, bytes, valid)
        }
        "wire.result.empty" => corpus_case(schema_id, decode_result_empty, bytes, valid),
        "wire.result.list-backups" => {
            corpus_case(schema_id, decode_result_list_backups, bytes, valid)
        }
        "wire.result.list-lorebooks" => {
            corpus_case(schema_id, decode_result_list_lorebooks, bytes, valid)
        }
        "wire.result.list-presets" => {
            corpus_case(schema_id, decode_result_list_presets, bytes, valid)
        }
        "wire.request.envelope" => corpus_case(schema_id, decode_request_envelope, bytes, valid),
        "wire.response.envelope" => corpus_case(schema_id, decode_response_envelope, bytes, valid),
        "wire.event.envelope" => corpus_case(schema_id, decode_event_envelope, bytes, valid),
        other => panic!("corpus references unknown schemaId: {other}"),
    }
}

/// Checks the decoder verdict matches the corpus expectation and round-trips
/// valid entries (decode → re-serialize → decode → equal value).
fn corpus_case<T: DeserializeOwned + PartialEq + Debug + serde::Serialize>(
    schema_id: &str,
    decode: fn(&[u8]) -> Result<T, WireError>,
    bytes: &[u8],
    valid: bool,
) {
    let first = decode(bytes);
    assert_eq!(
        first.is_ok(),
        valid,
        "{schema_id}: expected is_ok() == {valid}, got {first:?}"
    );
    if valid {
        let dto =
            first.unwrap_or_else(|e| panic!("{schema_id}: valid fixture failed to decode: {e}"));
        let reencoded = serde_json::to_vec(&dto).expect("a decoded DTO must always re-serialize");
        let second = decode(&reencoded)
            .unwrap_or_else(|e| panic!("{schema_id}: re-encoded fixture failed to decode: {e}"));
        assert_eq!(dto, second, "{schema_id}: round-trip changed the value");
    }
}

/// Deterministic xorshift32 step (Marsaglia, 2003).
fn xorshift32(mut state: u32) -> u32 {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    state
}

/// Every generated decoder, uniformed to `Result<(), WireError>`.
///
/// Each closure calls its free function by path, so it captures nothing and
/// coerces to a plain `fn` pointer.
type DecoderFn = fn(&[u8]) -> Result<(), WireError>;

fn all_decoders() -> [DecoderFn; 39] {
    [
        |b| decode_meta_dto(b).map(|_| ()),
        |b| decode_character_dto(b).map(|_| ()),
        |b| decode_chat_dto(b).map(|_| ()),
        |b| decode_message_dto(b).map(|_| ()),
        |b| decode_message_role(b).map(|_| ()),
        |b| decode_backup_dto(b).map(|_| ()),
        |b| decode_lorebook_dto(b).map(|_| ()),
        |b| decode_preset_dto(b).map(|_| ()),
        |b| decode_paged_characters(b).map(|_| ()),
        |b| decode_paged_chats(b).map(|_| ()),
        |b| decode_paged_messages(b).map(|_| ()),
        |b| decode_generation_event(b).map(|_| ()),
        |b| decode_generation_status(b).map(|_| ()),
        |b| decode_generation_run(b).map(|_| ()),
        |b| decode_paged_generation_events(b).map(|_| ()),
        |b| decode_error_dto(b).map(|_| ()),
        |b| decode_request_empty(b).map(|_| ()),
        |b| decode_request_list_characters(b).map(|_| ()),
        |b| decode_request_get_character(b).map(|_| ()),
        |b| decode_request_create_character(b).map(|_| ()),
        |b| decode_request_update_character(b).map(|_| ()),
        |b| decode_request_delete_character(b).map(|_| ()),
        |b| decode_request_list_chats(b).map(|_| ()),
        |b| decode_request_get_chat(b).map(|_| ()),
        |b| decode_request_list_messages(b).map(|_| ()),
        |b| decode_request_start_generation(b).map(|_| ()),
        |b| decode_request_cancel_generation(b).map(|_| ()),
        |b| decode_request_get_generation_run(b).map(|_| ()),
        |b| decode_request_retry_generation(b).map(|_| ()),
        |b| decode_request_keep_partial_generation(b).map(|_| ()),
        |b| decode_request_discard_generation(b).map(|_| ()),
        |b| decode_request_list_generation_events(b).map(|_| ()),
        |b| decode_result_empty(b).map(|_| ()),
        |b| decode_result_list_backups(b).map(|_| ()),
        |b| decode_result_list_lorebooks(b).map(|_| ()),
        |b| decode_result_list_presets(b).map(|_| ()),
        |b| decode_request_envelope(b).map(|_| ()),
        |b| decode_response_envelope(b).map(|_| ()),
        |b| decode_event_envelope(b).map(|_| ()),
    ]
}

#[test]
fn corpus_dispatch_and_round_trip() {
    let corpus: serde_json::Value = serde_json::from_slice(&read_fixture("corpus.json"))
        .expect("corpus.json must be valid JSON");
    let entries = corpus.as_array().expect("corpus.json must be a JSON array");
    assert!(
        entries.len() >= 30,
        "corpus.json looks incomplete: {} entries",
        entries.len()
    );
    for entry in entries {
        let schema_id = entry
            .get("schemaId")
            .and_then(|v| v.as_str())
            .expect("corpus entry missing schemaId");
        let file = entry
            .get("file")
            .and_then(|v| v.as_str())
            .expect("corpus entry missing file");
        let valid = entry
            .get("valid")
            .and_then(|v| v.as_bool())
            .expect("corpus entry missing valid");
        let bytes = read_fixture(file);
        dispatch(schema_id, &bytes, valid);
    }
}

#[test]
fn garbage_inputs_never_panic() {
    let decoders = all_decoders();
    // Deterministic xorshift32 stream: 512 slices, lengths 0..512.
    let mut inputs: Vec<Vec<u8>> = Vec::with_capacity(512);
    let mut state: u32 = 0x9E37_79B9;
    for len in 0..512usize {
        let mut slice = Vec::with_capacity(len);
        for _ in 0..len {
            state = xorshift32(state);
            slice.push((state >> 24) as u8);
        }
        inputs.push(slice);
    }
    for slice in &inputs {
        for decode in &decoders {
            let outcome = catch_unwind(AssertUnwindSafe(|| decode(slice)));
            assert!(
                outcome.is_ok(),
                "a decoder panicked on {} bytes of garbage",
                slice.len()
            );
        }
    }
}

#[test]
fn manifest_constants() {
    let hash = contract_schema_hash();
    assert_eq!(
        hash.len(),
        64,
        "schemaHash must be exactly 64 chars, got {hash}"
    );
    assert!(
        hash.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "schemaHash must be lowercase hex, got {hash}"
    );
    assert_eq!(wire_protocol(), (1, 0), "wire protocol must be 1.0");
}
