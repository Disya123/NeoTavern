//! Deterministic boundary fuzz (ТЗ §80 Nightly / §6.8): every generated
//! `decode_*` fn must return a controlled `WireError` on arbitrary input —
//! never panic, never hang. Two stages:
//!
//! 1. Raw-bytes fuzz: random buffers (lengths 0..512, skewed short) driven
//!    through all 45 decoders.
//! 2. Structural fuzz: valid values from the canonical fixture corpus are
//!    randomly mutated (field deletion, type swaps, string corruption,
//!    unknown keys, array splicing) and re-decoded.
//!
//! The PRNG is a fixed-seed xorshift64 — results are byte-reproducible.
//! Iteration counts are overridable via `NT_CONTRACT_FUZZ_ITERS` so the
//! nightly schedule can scale the budget without touching code.

use contracts_generated::generated::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

const FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/generated/fixtures"
);

/// Small deterministic PRNG (xorshift64). Fixed seed ⇒ reproducible corpus.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn byte(&mut self) -> u8 {
        (self.next() & 0xff) as u8
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// One wrong-type replacement value per call (avoids a const array of
/// non-const-constructible `Number`).
fn wrong_type(rng: &mut Rng) -> serde_json::Value {
    match rng.below(5) {
        0 => serde_json::Value::Null,
        1 => serde_json::Value::Bool(false),
        2 => serde_json::Value::Number(serde_json::Number::from(0)),
        3 => serde_json::Value::String(String::new()),
        _ => serde_json::Value::Array(Vec::new()),
    }
}

fn fuzz_iters() -> usize {
    std::env::var("NT_CONTRACT_FUZZ_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000)
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = PathBuf::from(FIXTURES_DIR).join(name);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!("fixture {name} missing: {e} (run tools/contract-codegen/codegen.mjs first)")
    })
}

/// All generated decoders share the signature `&[u8] -> Result<T, WireError>`
/// and are total fns: for EVERY byte slice they must return a controlled
/// result, never panic. The macro builds a non-capturing trampoline (function
/// item paths don't capture), so each entry coerces to `fn(&[u8]) ->
/// Result<(), ()>`.
macro_rules! probe {
    ($name:literal, $f:ident) => {{
        fn trampoline(bytes: &[u8]) -> Result<(), ()> {
            let _ = $f(bytes);
            Ok(())
        }
        ($name, trampoline as fn(&[u8]) -> Result<(), ()>)
    }};
}

/// Type-erased decoder probe: `&[u8]` → controlled `Result` (never panics).
type Probe = fn(&[u8]) -> Result<(), ()>;

fn decode_probes() -> Vec<(&'static str, Probe)> {
    vec![
        probe!("backup_dto", decode_backup_dto),
        probe!("character_dto", decode_character_dto),
        probe!("chat_dto", decode_chat_dto),
        probe!("empty_request_dto", decode_empty_request_dto),
        probe!("empty_result_dto", decode_empty_result_dto),
        probe!("error_dto", decode_error_dto),
        probe!("event_envelope", decode_event_envelope),
        probe!("generation_event", decode_generation_event),
        probe!("generation_run", decode_generation_run),
        probe!("generation_status", decode_generation_status),
        probe!("lorebook_dto", decode_lorebook_dto),
        probe!("message_dto", decode_message_dto),
        probe!("message_role", decode_message_role),
        probe!("meta_dto", decode_meta_dto),
        probe!("paged_characters", decode_paged_characters),
        probe!("paged_chats", decode_paged_chats),
        probe!("paged_generation_events", decode_paged_generation_events),
        probe!("paged_messages", decode_paged_messages),
        probe!("preset_dto", decode_preset_dto),
        probe!("provider_availability", decode_provider_availability),
        probe!("provider_dto", decode_provider_dto),
        probe!("provider_model", decode_provider_model),
        probe!(
            "request_cancel_generation",
            decode_request_cancel_generation
        ),
        probe!("request_create_character", decode_request_create_character),
        probe!("request_delete_character", decode_request_delete_character),
        probe!(
            "request_discard_generation",
            decode_request_discard_generation
        ),
        probe!("request_empty", decode_request_empty),
        probe!("request_envelope", decode_request_envelope),
        probe!("request_get_character", decode_request_get_character),
        probe!("request_get_chat", decode_request_get_chat),
        probe!(
            "request_get_generation_run",
            decode_request_get_generation_run
        ),
        probe!(
            "request_keep_partial_generation",
            decode_request_keep_partial_generation
        ),
        probe!("request_list_characters", decode_request_list_characters),
        probe!("request_list_chats", decode_request_list_chats),
        probe!(
            "request_list_generation_events",
            decode_request_list_generation_events
        ),
        probe!("request_list_messages", decode_request_list_messages),
        probe!("request_retry_generation", decode_request_retry_generation),
        probe!("request_start_generation", decode_request_start_generation),
        probe!("request_update_character", decode_request_update_character),
        probe!("response_envelope", decode_response_envelope),
        probe!("result_empty", decode_result_empty),
        probe!("result_list_backups", decode_result_list_backups),
        probe!("result_list_lorebooks", decode_result_list_lorebooks),
        probe!("result_list_presets", decode_result_list_presets),
        probe!("result_list_providers", decode_result_list_providers),
    ]
}

/// Asserts the decoder returns without panicking for the given input.
/// A panic here fails the test — exactly §6.8/§80: "Любой panic на
/// произвольном input является test failure".
fn no_panic(name: &str, probe: Probe, input: &[u8]) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let _ = probe(input);
    }));
    assert!(
        outcome.is_ok(),
        "decoder {name} panicked on {}-byte input",
        input.len()
    );
}

#[test]
fn raw_bytes_never_panic_any_decoder() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let probes = decode_probes();
    let iters = fuzz_iters();
    let mut calls = 0usize;
    for _ in 0..iters {
        // Length skew: mostly short (0..64), some mid (64..256), few larger.
        let len = match rng.below(10) {
            0..=6 => rng.below(64),
            7..=8 => rng.below(256),
            _ => rng.below(512),
        };
        let mut bytes = Vec::with_capacity(len);
        for _ in 0..len {
            bytes.push(rng.byte());
        }
        let (name, probe) = probes[rng.below(probes.len())];
        no_panic(name, probe, &bytes);
        calls += 1;
    }
    assert_eq!(calls, iters, "fuzz loop underran");
}

/// Structural mutations of valid fixture values: the decoder must survive
/// malformed-but-plausible JSON (wrong types, missing/extra fields, corrupt
/// discriminators) with a controlled error, not a panic.
#[test]
fn mutated_fixtures_never_panic() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let seeds: Vec<(String, Vec<u8>)> = [
        "corpus.json",
        "providers-list-request.json",
        "providers-list-response.json",
    ]
    .iter()
    .map(|name| (name.to_string(), fixture_bytes(name)))
    .collect();
    let probes = decode_probes();

    let iters = fuzz_iters().max(1000);
    let mut calls = 0usize;
    for _ in 0..iters {
        let (_, seed) = rng.pick(&seeds);
        let mut value: serde_json::Value =
            serde_json::from_slice(seed).expect("seed fixtures are valid JSON");
        // 1–4 recursive mutations.
        for _ in 0..(1 + rng.below(4)) {
            mutate(&mut rng, &mut value);
        }
        let mutated = serde_json::to_vec(&value).expect("mutated value serializes");
        // Every decoder is fair game — the mutated value is fed to a random
        // decoder; most will reject it, none may panic.
        let (name, probe) = probes[rng.below(probes.len())];
        no_panic(name, probe, &mutated);
        calls += 1;
    }
    assert_eq!(calls, iters, "fuzz loop underran");
}

/// Recursively corrupts a JSON value in place (char-boundary safe).
fn mutate(rng: &mut Rng, value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if map.is_empty() {
                *value = serde_json::Value::Null;
                return;
            }
            match rng.below(4) {
                // Delete a random field.
                0 => {
                    let key = map.keys().nth(rng.below(map.len())).unwrap().clone();
                    map.remove(&key);
                }
                // Replace a random field's value with a wrong-type value.
                1 => {
                    let key = map.keys().nth(rng.below(map.len())).unwrap().clone();
                    let replacement = wrong_type(rng);
                    map.insert(key, replacement);
                }
                // Insert an unknown key.
                2 => {
                    map.insert(format!("x{}", rng.below(1_000_000)), wrong_type(rng));
                }
                // Corrupt a string value in place (char-boundary safe).
                _ => {
                    for v in map.values_mut() {
                        if let serde_json::Value::String(s) = v {
                            if !s.is_empty() {
                                let chars: Vec<char> = s.chars().collect();
                                let idx = rng.below(chars.len());
                                let mut replaced = chars.clone();
                                replaced[idx] = char::from_u32((0x20 + rng.below(0x5f)) as u32)
                                    .expect("0x20..0x7e is a valid char");
                                *s = replaced.into_iter().collect();
                                return;
                            }
                        }
                    }
                }
            }
        }
        serde_json::Value::Array(items) => {
            if items.is_empty() {
                *value = serde_json::Value::Null;
                return;
            }
            match rng.below(3) {
                // Drop a random element.
                0 => {
                    let idx = rng.below(items.len());
                    items.remove(idx);
                }
                // Append a wrong-type element.
                1 => items.push(wrong_type(rng)),
                // Recurse into a random element.
                _ => {
                    let idx = rng.below(items.len());
                    mutate(rng, &mut items[idx]);
                }
            }
        }
        _ => {
            // Scalars become a different scalar type.
            *value = wrong_type(rng);
        }
    }
}
