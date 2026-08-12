//! Request/response envelope mapping between the HTTP adapter and the wire
//! contract (`wire.request.envelope` / `wire.response.envelope`).
//!
//! This module owns the three mapping rules the adapter applies exactly:
//! transport failures (an HTTP status before a usable envelope exists), the
//! wire-protocol check (§6.5), and the kernel error → canonical wire code
//! table (§10).

use contracts_generated::generated::{
    validate_response_envelope, ErrorDto, RequestEnvelope, ResponseEnvelope,
};
use contracts_generated::{Issue, WireError, WireErrorKind, CONTRACT_MANIFEST_JSON};
use runtime_kernel::{KernelError, KernelErrorCode};
use std::sync::LazyLock;

/// Failure to decode or build an envelope, carrying the HTTP status the
/// adapter must answer and the canonical wire error code + params for the
/// response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeFailure {
    /// HTTP status for the response (400 / 413 / 426 / 500).
    pub http_status: u16,
    /// Canonical wire error code, e.g. `"CONTRACT_VIOLATION"`.
    pub code: &'static str,
    /// Wire `error.params` pairs (`key` → string value).
    pub params: Vec<(String, String)>,
}

/// Outcome of the wire-protocol version check against the embedded manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolVerdict {
    /// `client_major == server_major` and `client_minor <= server_minor`.
    Compatible,
    /// The client speaks a different major version; the operation must not
    /// execute (§6.5).
    MajorMismatch {
        /// Major version the client advertised.
        client_major: i64,
        /// Major version of the embedded contract manifest.
        server_major: i64,
    },
    /// Same major, but the client requires a newer minor than this server.
    MinorTooNew {
        /// Minor version the client advertised.
        client_minor: i64,
        /// Minor version of the embedded contract manifest.
        server_minor: i64,
    },
}

/// Decodes a `wire.request.envelope` JSON body.
///
/// Wire failures are mapped to transport-level [`EnvelopeFailure`]s: invalid
/// JSON → 400 `CONTRACT_VIOLATION` (`direction=request`, `rule=json_parse`);
/// schema violations → 400 `CONTRACT_VIOLATION` with the generated issues
/// flattened into `issue.<i>.path` / `issue.<i>.rule` params; an internal
/// decode bug → 500 `INTERNAL`.
pub fn decode_request_envelope(bytes: &[u8]) -> Result<RequestEnvelope, EnvelopeFailure> {
    contracts_generated::generated::decode_request_envelope(bytes).map_err(map_wire_error)
}

/// Maps a generated wire-decoding failure to the transport [`EnvelopeFailure`]
/// the adapter must answer.
fn map_wire_error(err: WireError) -> EnvelopeFailure {
    match err.kind {
        WireErrorKind::Parse => EnvelopeFailure {
            http_status: 400,
            code: "CONTRACT_VIOLATION",
            params: vec![
                ("direction".to_string(), "request".to_string()),
                ("rule".to_string(), "json_parse".to_string()),
            ],
        },
        WireErrorKind::Violation => EnvelopeFailure {
            http_status: 400,
            code: "CONTRACT_VIOLATION",
            params: flatten_issues(&err.issues),
        },
        WireErrorKind::Internal => EnvelopeFailure {
            http_status: 500,
            code: "INTERNAL",
            params: Vec::new(),
        },
    }
}

/// Flattens generated validation issues into stable `issue.<i>.path` /
/// `issue.<i>.rule` wire params for clients.
fn flatten_issues(issues: &[Issue]) -> Vec<(String, String)> {
    let mut params = Vec::with_capacity(issues.len() * 2);
    for (i, issue) in issues.iter().enumerate() {
        params.push((format!("issue.{i}.path"), issue.path.clone()));
        params.push((format!("issue.{i}.rule"), issue.rule.clone()));
    }
    params
}

/// Checks the request's `wireProtocol` against the embedded manifest
/// (`contracts_generated::wire_protocol`).
///
/// Compatible requires `client_major == server_major` and
/// `client_minor <= server_minor`. `schemaHash` is deliberately NOT compared
/// (§6.5: remote clients are not required to match it).
pub fn check_protocol(env: &RequestEnvelope) -> ProtocolVerdict {
    let (server_major, server_minor) = contracts_generated::wire_protocol();
    if env.wire_protocol.major != server_major {
        ProtocolVerdict::MajorMismatch {
            client_major: env.wire_protocol.major,
            server_major,
        }
    } else if env.wire_protocol.minor > server_minor {
        ProtocolVerdict::MinorTooNew {
            client_minor: env.wire_protocol.minor,
            server_minor,
        }
    } else {
        ProtocolVerdict::Compatible
    }
}

/// Returns the serialized payload of `env.payload` — the operation request
/// DTO bytes passed to kernel dispatch.
///
/// Never fails for a validated envelope; the error arm is defensive only.
pub fn operation_payload_bytes(env: &RequestEnvelope) -> Result<Vec<u8>, EnvelopeFailure> {
    serde_json::to_vec(&env.payload).map_err(|_| internal_failure("payload_serialize"))
}

/// Builds the validated `{"kind":"ok","requestId":...,"result":...}` response
/// envelope body. `result` must be a JSON object per the wire contract.
pub fn build_ok_response(
    request_id: &str,
    result: serde_json::Value,
) -> Result<Vec<u8>, EnvelopeFailure> {
    serialize_response(&ResponseEnvelope::Ok {
        request_id: request_id.to_string(),
        result,
    })
}

/// Builds the validated `{"kind":"error","requestId":...,"error":{...}}`
/// response envelope body. `params` become the string-valued
/// `error.params` object.
pub fn build_error_response(
    request_id: &str,
    code: &str,
    params: Vec<(String, String)>,
) -> Result<Vec<u8>, EnvelopeFailure> {
    let params = serde_json::Value::Object(
        params
            .into_iter()
            .map(|(key, value)| (key, serde_json::Value::String(value)))
            .collect(),
    );
    serialize_response(&ResponseEnvelope::Error {
        request_id: request_id.to_string(),
        error: ErrorDto {
            code: code.to_string(),
            params,
            trace_id: None,
            correlation_id: None,
        },
    })
}

/// Maps a kernel dispatch error to a validated error-envelope JSON body.
///
/// When `err.product` is set, its DTO (`code`, `params`, `traceId`,
/// `correlationId`) is copied into the envelope verbatim — product codes like
/// `CHARACTER_NOT_FOUND` pass through untouched and the diagnostic
/// `err.params` are ignored. Otherwise the [`KernelErrorCode`] → canonical
/// wire code table applies:
///
/// | `KernelErrorCode` | wire code |
/// |---|---|
/// | `ContractMismatch`, `ContractViolation` | `CONTRACT_VIOLATION` |
/// | `OperationNotFound` | `NOT_FOUND` |
/// | `Unauthorized` | `UNAUTHORIZED` |
/// | `Cancelled` | `CANCELLED` |
/// | `DataRootInUse` | `DATA_ROOT_IN_USE` |
/// | `StorageFailure`, `Internal` | `INTERNAL` |
/// | `NotFound` | `NOT_FOUND` |
/// | `Conflict` | `CONFLICT` |
/// | `ProviderError` | `PROVIDER_ERROR` |
///
/// `err.params` diagnostics and the generated `err.issues` (flattened to
/// `issue.<i>.path` / `issue.<i>.rule`) are merged into the envelope params.
pub fn kernel_error_envelope(err: &KernelError, request_id: &str) -> Vec<u8> {
    let envelope = match &err.product {
        Some(product) => ResponseEnvelope::Error {
            request_id: request_id.to_string(),
            error: ErrorDto {
                code: product.code.clone(),
                params: product.params.clone(),
                trace_id: product.trace_id.clone(),
                correlation_id: product.correlation_id.clone(),
            },
        },
        None => {
            let mut params = err.params.clone();
            params.extend(flatten_issues(&err.issues));
            ResponseEnvelope::Error {
                request_id: request_id.to_string(),
                error: ErrorDto {
                    code: canonical_code(err.code).to_string(),
                    params: serde_json::Value::Object(
                        params
                            .into_iter()
                            .map(|(key, value)| (key, serde_json::Value::String(value)))
                            .collect(),
                    ),
                    trace_id: None,
                    correlation_id: None,
                },
            }
        }
    };
    match serialize_response(&envelope) {
        Ok(bytes) => bytes,
        // Unreachable: string-only params always validate. The static
        // fallback keeps every code path panic-free.
        Err(_) => INTERNAL_FALLBACK.to_vec(),
    }
}

/// Canonical wire error code for a kernel error class (the §10 table).
fn canonical_code(code: KernelErrorCode) -> &'static str {
    match code {
        KernelErrorCode::ContractMismatch | KernelErrorCode::ContractViolation => {
            "CONTRACT_VIOLATION"
        }
        KernelErrorCode::OperationNotFound => "NOT_FOUND",
        KernelErrorCode::Unauthorized => "UNAUTHORIZED",
        KernelErrorCode::Cancelled => "CANCELLED",
        KernelErrorCode::DataRootInUse => "DATA_ROOT_IN_USE",
        KernelErrorCode::StorageFailure | KernelErrorCode::Internal => "INTERNAL",
        KernelErrorCode::NotFound => "NOT_FOUND",
        KernelErrorCode::Conflict => "CONFLICT",
        // Phase 6: provider-level failures (unknown provider, invalid model
        // grammar, mid-generation provider step errors) surface as the wire
        // product code PROVIDER_ERROR.
        KernelErrorCode::ProviderError => "PROVIDER_ERROR",
    }
}

/// Serializes a response envelope after validating it through the generated
/// wire checker; any failure is an adapter-internal bug, surfaced as a
/// controlled 500 [`EnvelopeFailure`] instead of a panic.
fn serialize_response(envelope: &ResponseEnvelope) -> Result<Vec<u8>, EnvelopeFailure> {
    let value =
        serde_json::to_value(envelope).map_err(|_| internal_failure("response_serialize"))?;
    validate_response_envelope(&value).map_err(|_| internal_failure("response_invalid"))?;
    serde_json::to_vec(&value).map_err(|_| internal_failure("response_serialize"))
}

/// Builds a 500 `INTERNAL` failure for an adapter-internal invariant break.
fn internal_failure(rule: &'static str) -> EnvelopeFailure {
    EnvelopeFailure {
        http_status: 500,
        code: "INTERNAL",
        params: vec![("rule".to_string(), rule.to_string())],
    }
}

/// Static wire-valid error envelope used only on an unreachable internal
/// invariant break (never for wire-derived input).
const INTERNAL_FALLBACK: &[u8] =
    b"{\"kind\":\"error\",\"requestId\":\"00000000-0000-4000-8000-000000000000\",\"error\":{\"code\":\"INTERNAL\",\"params\":{}}}";

/// Embedded contract manifest parsed once per process. It is a compile-time
/// constant; the fallback only guards against a packaging bug.
static CONTRACT_MANIFEST: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(CONTRACT_MANIFEST_JSON).unwrap_or(serde_json::Value::Null)
});

/// Returns the `eventSchemaId` from the embedded contract manifest for
/// streaming operations (`Some`), `None` for non-streaming or unknown ones.
///
/// Today only `generation.start` declares an event schema
/// (`wire.generation.event`); every other frozen operation returns `None`.
pub fn operation_event_schema_id(operation_id: &str) -> Option<String> {
    CONTRACT_MANIFEST
        .get("operations")?
        .get(operation_id)?
        .get("eventSchemaId")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts_generated::generated::{ProductErrorDto, RequestEnvelopeWireProtocol};
    use serde_json::json;

    const REQUEST_ID: &str = "00000000-0000-4000-8000-000000000001";
    const SCHEMA_HASH: &str = "23f0f3e86e5f4d6bca779a8372e4d69f7e06aa1b53d39c43361ed00e5baf0a41";

    /// A minimal, wire-shaped request envelope for a given protocol version.
    fn envelope(major: i64, minor: i64) -> RequestEnvelope {
        RequestEnvelope {
            wire_protocol: RequestEnvelopeWireProtocol { major, minor },
            schema_hash: SCHEMA_HASH.to_string(),
            request_id: REQUEST_ID.to_string(),
            operation_id: "characters.list".to_string(),
            payload: json!({}),
        }
    }

    /// Serializes a JSON value to bytes; failure is impossible for a Value.
    fn json_bytes(value: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&value)
            .unwrap_or_else(|e| panic!("serializing a JSON value cannot fail: {e}"))
    }

    /// Decodes a response envelope the adapter itself built.
    fn decode_envelope(body: &[u8]) -> ResponseEnvelope {
        match contracts_generated::generated::decode_response_envelope(body) {
            Ok(env) => env,
            Err(e) => panic!("envelope built by the adapter must decode, got {e:?}"),
        }
    }

    #[test]
    fn protocol_check_accepts_server_version() {
        let (major, minor) = contracts_generated::wire_protocol();
        assert_eq!(
            check_protocol(&envelope(major, minor)),
            ProtocolVerdict::Compatible
        );
    }

    #[test]
    fn protocol_check_accepts_minor_below_or_equal() {
        let (major, server_minor) = contracts_generated::wire_protocol();
        assert_eq!(
            check_protocol(&envelope(major, server_minor)),
            ProtocolVerdict::Compatible
        );
    }

    #[test]
    fn protocol_check_rejects_major_mismatch() {
        let (server_major, _) = contracts_generated::wire_protocol();
        let client_major = server_major + 1;
        assert_eq!(
            check_protocol(&envelope(client_major, 0)),
            ProtocolVerdict::MajorMismatch {
                client_major,
                server_major,
            }
        );
    }

    #[test]
    fn protocol_check_rejects_minor_above_server() {
        let (major, server_minor) = contracts_generated::wire_protocol();
        let client_minor = server_minor + 1;
        assert_eq!(
            check_protocol(&envelope(major, client_minor)),
            ProtocolVerdict::MinorTooNew {
                client_minor,
                server_minor,
            }
        );
    }

    #[test]
    fn decode_request_accepts_valid_envelope() {
        match decode_request_envelope(&json_bytes(json!({
            "wireProtocol": { "major": 1, "minor": 0 },
            "schemaHash": SCHEMA_HASH,
            "requestId": REQUEST_ID,
            "operationId": "characters.list",
            "payload": {},
        }))) {
            Ok(env) => assert_eq!(env.operation_id, "characters.list"),
            Err(f) => panic!("valid envelope must decode, got {f:?}"),
        }
    }

    #[test]
    fn decode_request_maps_json_parse_failure() {
        match decode_request_envelope(b"{not json") {
            Ok(_) => panic!("garbage JSON must not decode"),
            Err(f) => {
                assert_eq!(f.http_status, 400);
                assert_eq!(f.code, "CONTRACT_VIOLATION");
                assert_eq!(
                    f.params,
                    vec![
                        ("direction".to_string(), "request".to_string()),
                        ("rule".to_string(), "json_parse".to_string()),
                    ]
                );
            }
        }
    }

    #[test]
    fn decode_request_maps_schema_violation_with_flattened_issues() {
        // Valid JSON missing `operationId` and `payload`.
        let body = br#"{"wireProtocol":{"major":1,"minor":0},"schemaHash":"23f0f3e86e5f4d6bca779a8372e4d69f7e06aa1b53d39c43361ed00e5baf0a41","requestId":"00000000-0000-4000-8000-000000000001"}"#;
        match decode_request_envelope(body) {
            Ok(_) => panic!("incomplete envelope must not decode"),
            Err(f) => {
                assert_eq!(f.http_status, 400);
                assert_eq!(f.code, "CONTRACT_VIOLATION");
                let path0 = ("issue.0.path".to_string(), "operationId".to_string());
                let rule0 = ("issue.0.rule".to_string(), "RequiredProperty".to_string());
                let path1 = ("issue.1.path".to_string(), "payload".to_string());
                let rule1 = ("issue.1.rule".to_string(), "RequiredProperty".to_string());
                assert!(f.params.contains(&path0));
                assert!(f.params.contains(&rule0));
                assert!(f.params.contains(&path1));
                assert!(f.params.contains(&rule1));
            }
        }
    }

    #[test]
    fn decode_request_maps_internal_failure_to_500() {
        let failure = map_wire_error(WireError::internal("typed decode failed after check"));
        assert_eq!(failure.http_status, 500);
        assert_eq!(failure.code, "INTERNAL");
        assert!(failure.params.is_empty());
    }

    #[test]
    fn operation_payload_bytes_round_trips_payload() {
        let mut env = envelope(1, 0);
        env.payload = json!({ "limit": 10, "name": "Ada" });
        let bytes =
            operation_payload_bytes(&env).unwrap_or_else(|f| panic!("payload serialize: {f:?}"));
        let parsed: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("payload round-trip: {e}"));
        assert_eq!(parsed, json!({ "limit": 10, "name": "Ada" }));
    }

    #[test]
    fn build_ok_response_creates_validated_ok_envelope() {
        let result = json!({ "id": REQUEST_ID });
        let bytes = build_ok_response(REQUEST_ID, result.clone())
            .unwrap_or_else(|f| panic!("ok build: {f:?}"));
        match decode_envelope(&bytes) {
            ResponseEnvelope::Ok {
                request_id,
                result: got,
            } => {
                assert_eq!(request_id, REQUEST_ID);
                assert_eq!(got, result);
            }
            other => panic!("expected ok envelope, got {other:?}"),
        }
    }

    #[test]
    fn build_ok_response_rejects_non_object_result() {
        // The wire contract requires `result` to be an object.
        match build_ok_response(REQUEST_ID, json!([1, 2, 3])) {
            Ok(_) => panic!("non-object result must be rejected"),
            Err(f) => {
                assert_eq!(f.http_status, 500);
                assert_eq!(f.code, "INTERNAL");
            }
        }
    }

    #[test]
    fn build_error_response_creates_validated_error_envelope() {
        let bytes = build_error_response(
            REQUEST_ID,
            "NOT_FOUND",
            vec![("operationId".to_string(), "nope.nope".to_string())],
        )
        .unwrap_or_else(|f| panic!("error build: {f:?}"));
        match decode_envelope(&bytes) {
            ResponseEnvelope::Error { request_id, error } => {
                assert_eq!(request_id, REQUEST_ID);
                assert_eq!(error.code, "NOT_FOUND");
                assert_eq!(error.params, json!({ "operationId": "nope.nope" }));
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn build_error_response_rejects_empty_code() {
        match build_error_response(REQUEST_ID, "", Vec::new()) {
            Ok(_) => panic!("empty code must be rejected"),
            Err(f) => {
                assert_eq!(f.http_status, 500);
                assert_eq!(f.code, "INTERNAL");
            }
        }
    }

    #[test]
    fn kernel_error_maps_all_codes_to_canonical_wire_codes() {
        let cases: &[(KernelErrorCode, &str)] = &[
            (KernelErrorCode::ContractMismatch, "CONTRACT_VIOLATION"),
            (KernelErrorCode::ContractViolation, "CONTRACT_VIOLATION"),
            (KernelErrorCode::OperationNotFound, "NOT_FOUND"),
            (KernelErrorCode::Unauthorized, "UNAUTHORIZED"),
            (KernelErrorCode::Cancelled, "CANCELLED"),
            (KernelErrorCode::DataRootInUse, "DATA_ROOT_IN_USE"),
            (KernelErrorCode::StorageFailure, "INTERNAL"),
            (KernelErrorCode::Internal, "INTERNAL"),
            (KernelErrorCode::NotFound, "NOT_FOUND"),
            (KernelErrorCode::Conflict, "CONFLICT"),
            (KernelErrorCode::ProviderError, "PROVIDER_ERROR"),
        ];
        assert_eq!(
            cases.len(),
            11,
            "the canonical table must cover every KernelErrorCode variant"
        );
        for (kernel_code, wire_code) in cases {
            let err = KernelError::with_params(*kernel_code, "test", Vec::new());
            let body = kernel_error_envelope(&err, REQUEST_ID);
            match decode_envelope(&body) {
                ResponseEnvelope::Error { request_id, error } => {
                    assert_eq!(request_id, REQUEST_ID);
                    assert_eq!(
                        error.code.as_str(),
                        *wire_code,
                        "mapping for {kernel_code:?}"
                    );
                }
                other => panic!("expected error envelope for {kernel_code:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn kernel_error_merges_params_and_flattens_issues() {
        let err = KernelError {
            code: KernelErrorCode::ContractViolation,
            message: "payload failed validation".to_string(),
            issues: vec![Issue::new("payload/characterId", "StringFormat")],
            params: vec![("hint".to_string(), "expected-uuid".to_string())],
            product: None,
        };
        let body = kernel_error_envelope(&err, REQUEST_ID);
        match decode_envelope(&body) {
            ResponseEnvelope::Error { error, .. } => {
                assert_eq!(error.code, "CONTRACT_VIOLATION");
                assert_eq!(
                    error.params,
                    json!({
                        "hint": "expected-uuid",
                        "issue.0.path": "payload/characterId",
                        "issue.0.rule": "StringFormat",
                    })
                );
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn kernel_error_copies_product_dto_verbatim() {
        let err = KernelError::product(
            "CHARACTER_NOT_FOUND",
            vec![("characterId".to_string(), REQUEST_ID.to_string())],
        );
        let body = kernel_error_envelope(&err, REQUEST_ID);
        match decode_envelope(&body) {
            ResponseEnvelope::Error { request_id, error } => {
                assert_eq!(request_id, REQUEST_ID);
                assert_eq!(error.code, "CHARACTER_NOT_FOUND");
                // Product params pass through untouched (not remapped or
                // merged with kernel diagnostics).
                assert_eq!(error.params, json!({ "characterId": REQUEST_ID }));
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn kernel_error_preserves_product_trace_and_correlation() {
        let err = KernelError {
            code: KernelErrorCode::NotFound,
            message: "product error".to_string(),
            issues: Vec::new(),
            params: vec![("diagnostic".to_string(), "must-not-leak".to_string())],
            product: Some(Box::new(ProductErrorDto {
                code: "BACKUP_NOT_FOUND".to_string(),
                params: json!({ "backupId": "b1" }),
                trace_id: Some("trace-1".to_string()),
                correlation_id: Some(REQUEST_ID.to_string()),
            })),
        };
        let body = kernel_error_envelope(&err, REQUEST_ID);
        match decode_envelope(&body) {
            ResponseEnvelope::Error { error, .. } => {
                assert_eq!(error.code, "BACKUP_NOT_FOUND");
                assert_eq!(error.params, json!({ "backupId": "b1" }));
                assert_eq!(error.trace_id.as_deref(), Some("trace-1"));
                assert_eq!(error.correlation_id.as_deref(), Some(REQUEST_ID));
            }
            other => panic!("expected error envelope, got {other:?}"),
        }
    }

    #[test]
    fn event_schema_id_returns_some_for_generation_start() {
        // Verified against packages/contracts/generated/contract-manifest.json:
        // generation.start is the only frozen operation with an eventSchemaId.
        assert_eq!(
            operation_event_schema_id("generation.start").as_deref(),
            Some("wire.generation.event")
        );
    }

    #[test]
    fn event_schema_id_none_for_known_non_streaming_ops() {
        assert_eq!(operation_event_schema_id("characters.list"), None);
        assert_eq!(operation_event_schema_id("generation.cancel"), None);
    }

    #[test]
    fn event_schema_id_none_for_unknown_ops() {
        assert_eq!(operation_event_schema_id("nope.nope"), None);
    }
}
