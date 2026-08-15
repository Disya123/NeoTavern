//! Plan rev 2.2 Layer D — the generated per-operation byte limits must
//! EXACTLY match the contract manifest for EVERY operation (single source of
//! truth: the registry; no hand-written constants). The kernel's
//! `enforce_request_limit` / response gate rely on these functions.

use contracts_generated::generated::{
    self, DEFAULT_REQUEST_LIMIT_BYTES, DEFAULT_RESPONSE_LIMIT_BYTES,
};

/// Manifest ops are keyed by operationId; limits are u64 JSON numbers.
fn manifest_operations() -> serde_json::Map<String, serde_json::Value> {
    let manifest: serde_json::Value =
        serde_json::from_str(contracts_generated::CONTRACT_MANIFEST_JSON)
            .expect("embedded manifest must be valid JSON");
    manifest
        .get("operations")
        .expect("manifest must carry operations")
        .as_object()
        .expect("operations must be an object")
        .clone()
}

fn op_limit(op: &serde_json::Value, field: &str) -> u64 {
    op.get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| panic!("operation must carry numeric {field}"))
}

#[test]
fn every_manifest_operation_has_generated_limits() {
    let ops = manifest_operations();
    assert!(
        ops.len() >= 64,
        "expected the full registry, got {} ops",
        ops.len()
    );
    for (op_id, op) in &ops {
        let request = op_limit(op, "requestLimitBytes");
        let response = op_limit(op, "responseLimitBytes");
        assert_eq!(
            generated::operation_request_limit(op_id),
            Some(request),
            "request limit mismatch for {op_id}"
        );
        assert_eq!(
            generated::operation_response_limit(op_id),
            Some(response),
            "response limit mismatch for {op_id}"
        );
    }
}

#[test]
fn generated_defaults_match_the_registry_maxima() {
    let ops = manifest_operations();
    let max_request = ops
        .values()
        .map(|op| op_limit(op, "requestLimitBytes"))
        .max()
        .expect("registry must not be empty");
    let max_response = ops
        .values()
        .map(|op| op_limit(op, "responseLimitBytes"))
        .max()
        .expect("registry must not be empty");
    assert_eq!(DEFAULT_REQUEST_LIMIT_BYTES, max_request);
    assert_eq!(DEFAULT_RESPONSE_LIMIT_BYTES, max_response);
}

#[test]
fn unknown_operation_has_no_limit() {
    assert_eq!(generated::operation_request_limit("no.such.op"), None);
    assert_eq!(generated::operation_response_limit("no.such.op"), None);
}
