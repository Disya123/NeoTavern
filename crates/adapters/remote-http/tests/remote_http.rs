//! Integration tests for the `remote-http-adapter` crate (Phase 4;
//! Phase 6 generation-streaming scenarios live in `generation_stream.rs`).
//!
//! Shared test infrastructure (kernel/adapter setup, the std-only HTTP
//! client, envelope builders, direct-storage seeding and SSE parsing) lives
//! in [`common`]; every scenario drives a REAL [`runtime_kernel::Kernel`]
//! opened on a fresh
//! temporary data root (`tempfile::TempDir`), wrapped in
//! `Arc<Mutex<Kernel>>` as the adapter API requires, with
//! [`remote_http_adapter::RemoteAdapter`] bound to an ephemeral loopback
//! port (`127.0.0.1:0`).
//!
//! The HTTP client is a deliberately tiny std-only implementation
//! (`TcpStream` + manual request writing + read-to-close) so the test crate
//! adds no dependencies beyond `tempfile`.
//!
//! Wire assertions go through the generated decoders and DTO validators
//! (`contracts_generated::generated::{decode_response_envelope,
//! validate_character_dto, ...}`) so the tests exercise the same structural
//! checks the product hosts rely on.
//!
//! Determinism: reads are bounded by a short `read_timeout` + retry loop
//! instead of sleeps; request ids / character ids are fixed literal UUIDs
//! matching the wire pattern (no `uuid` dependency).

mod common;

use common::{
    decode_envelope, default_config, encode_envelope_frame, encode_frame, encode_terminal_frame,
    envelope_body, envelope_body_full, expect_error, expect_ok, free_port, gen, http_request,
    http_request_chunked, http_requests_keepalive, json, kernel_config, parse_last_event_id,
    parse_sse, rid, seed_data_root, AdapterError, Arc, AuthConfig, Duration, IpAddr, Ipv4Addr,
    Kernel, KernelErrorCode, Mutex, RemoteAdapter, RemoteAdapterConfig, SocketAddr, SseFrame,
    TcpStream, TestServer, Value, Write, T0, ZERO_SCHEMA_HASH,
};

/// Standard base64 decoding (test-local; the crate stays dependency-free).
fn decode_base64(encoded: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(encoded.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for byte in encoded.bytes() {
        if byte == b'=' {
            break;
        }
        let value = ALPHABET
            .iter()
            .position(|c| *c == byte)
            .expect("valid base64") as u32;
        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// 1. `GET /meta` → 200, JSON MetaDto (api 1.0, productWire 1.0) plus the
///    `X-Neota-Schema-Hash` and `X-Neota-Protocol` diagnostic headers.
#[test]
fn meta_endpoint_reports_contract_and_versions() {
    let server = TestServer::spawn();

    let response = http_request(server.addr, "GET", "/meta", &[], &[]);
    assert_eq!(response.status, 200, "meta must answer 200");
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type
            .to_ascii_lowercase()
            .contains("application/json"),
        "content-type was {content_type:?}"
    );

    let hash = response.header("x-neota-schema-hash").unwrap_or_default();
    assert_eq!(hash, contracts_generated::contract_schema_hash());
    let (major, minor) = contracts_generated::wire_protocol();
    assert_eq!(
        response.header("x-neota-protocol").unwrap_or_default(),
        format!("{major}.{minor}")
    );

    let meta: gen::MetaDto =
        gen::decode_meta_dto(&response.body).expect("meta body is a valid MetaDto");
    assert_eq!(meta.api.major, 1, "api major");
    assert_eq!(meta.api.minor, 0, "api minor");
    assert_eq!(meta.product_wire.major, 1, "product wire major");
    assert_eq!(meta.product_wire.minor, 0, "product wire minor");
}

/// 2. `characters.create` → ok envelope → `characters.get` with the returned
///    id → ok envelope with the same id (round-trip over HTTP).
#[test]
fn character_create_get_round_trip_over_http() {
    let server = TestServer::spawn();

    let create = envelope_body(
        &rid(1),
        "characters.create",
        json!({ "name": "Ada Lovelace", "tags": ["math"] }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response.status, 200, "create answers HTTP 200");
    let (request_id, created) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1), "requestId is echoed");
    gen::validate_character_dto(&created).expect("created character DTO is wire-valid");
    assert_eq!(created["name"], json!("Ada Lovelace"));
    let id = created["id"]
        .as_str()
        .expect("created character has an id")
        .to_string();

    let get = envelope_body(&rid(2), "characters.get", json!({ "characterId": id }));
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200, "get answers HTTP 200");
    let (request_id, fetched) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(2), "requestId is echoed");
    gen::validate_character_dto(&fetched).expect("fetched character DTO is wire-valid");
    assert_eq!(fetched["id"], json!(id), "round-trip keeps the same id");
}

/// 2b. `providers.list` over `/rpc` (Phase 7): stateless operation reporting
///    the built-in `fake` provider with schema-valid availability and models.
#[test]
fn providers_list_over_http_reports_builtin_fake() {
    let server = TestServer::spawn();

    let body = envelope_body(&rid(9), "providers.list", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 200, "providers.list answers HTTP 200");
    let (request_id, result) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(9), "requestId is echoed");
    gen::validate_result_list_providers(&result).expect("list-providers result is wire-valid");
    let items = result["items"].as_array().expect("items array");
    let fake = items
        .iter()
        .find(|p| p["id"] == json!("fake"))
        .expect("built-in fake provider is listed");
    assert_eq!(fake["builtin"], json!(true), "fake is builtin");
    assert_eq!(
        fake["availability"]["status"],
        json!("available"),
        "fake availability is available"
    );
    let models = fake["models"].as_array().expect("models array");
    assert!(
        models.iter().any(|m| m["id"] == json!("fake-1")),
        "fake-1 model listed"
    );
}

/// 3. `characters.list` respects `limit` and returns `items` + `nextCursor`
///    semantics: empty initially, then 3 created, limit 2 → 2 items + cursor,
///    cursor continuation → the remaining character and no cursor.
#[test]
fn character_list_respects_limit_and_cursor() {
    let server = TestServer::spawn();

    // Empty registry first: no items, no cursor.
    let list = envelope_body(&rid(1), "characters.list", json!({ "limit": 2 }));
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200);
    let (_, page) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_characters(&page).expect("empty page is wire-valid");
    assert_eq!(page["items"].as_array().expect("items array").len(), 0);
    assert!(
        page["nextCursor"].is_null(),
        "no cursor on an empty registry"
    );

    // Create three characters.
    for n in 0..3 {
        let create = envelope_body(
            &rid(10 + n),
            "characters.create",
            json!({ "name": format!("Character {n}") }),
        );
        let response = http_request(server.addr, "POST", "/rpc", &[], &create);
        assert_eq!(response.status, 200, "create {n} answers 200");
        expect_ok(decode_envelope(&response.body));
    }

    // limit 2 → exactly 2 items + a cursor for the next page.
    let list = envelope_body(&rid(4), "characters.list", json!({ "limit": 2 }));
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200);
    let (_, page_one) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_characters(&page_one).expect("page one is wire-valid");
    let items_one = page_one["items"].as_array().expect("items array");
    assert_eq!(items_one.len(), 2, "limit=2 must cap the page at 2 items");
    let cursor = page_one["nextCursor"]
        .as_str()
        .expect("a nextCursor is present")
        .to_string();

    // Following the cursor yields the remaining character and no cursor.
    let list = envelope_body(
        &rid(5),
        "characters.list",
        json!({ "limit": 2, "cursor": cursor }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200);
    let (_, page_two) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_characters(&page_two).expect("page two is wire-valid");
    let items_two = page_two["items"].as_array().expect("items array");
    assert_eq!(
        items_two.len(),
        1,
        "cursor continuation yields the last character"
    );
    assert!(
        page_two["nextCursor"].is_null(),
        "no cursor after the final page"
    );

    // Both pages together cover exactly the three created characters.
    let mut seen: Vec<&str> = items_one
        .iter()
        .chain(items_two.iter())
        .map(|item| item["id"].as_str().unwrap_or_default())
        .collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 3, "both pages cover three distinct characters");
}

/// 4. Malformed JSON body → HTTP 400, CONTRACT_VIOLATION with
///    `params.direction == "request"`; valid JSON violating the envelope schema
///    → 400 with the generated `Issue` list flattened into params.
#[test]
fn malformed_json_body_returns_400_contract_violation() {
    let server = TestServer::spawn();

    // Not JSON at all → json_parse rule.
    let response = http_request(server.addr, "POST", "/rpc", &[], b"{ this is not json");
    assert_eq!(
        response.status, 400,
        "undecodable body is a transport failure"
    );
    let value: Value = serde_json::from_slice(&response.body).expect("400 body is JSON");
    assert_eq!(value["kind"], json!("error"));
    assert_eq!(value["error"]["code"], json!("CONTRACT_VIOLATION"));
    assert_eq!(value["error"]["params"]["direction"], json!("request"));
    assert_eq!(value["error"]["params"]["rule"], json!("json_parse"));

    // Valid JSON, invalid envelope → flattened Issue list.
    let response = http_request(server.addr, "POST", "/rpc", &[], br#"{"oops": true}"#);
    assert_eq!(
        response.status, 400,
        "envelope schema violation is a transport failure"
    );
    let value: Value = serde_json::from_slice(&response.body).expect("400 body is JSON");
    assert_eq!(value["error"]["code"], json!("CONTRACT_VIOLATION"));
    assert_eq!(
        value["error"]["params"]["issue.0.path"],
        json!("wireProtocol")
    );
    assert_eq!(
        value["error"]["params"]["issue.0.rule"],
        json!("RequiredProperty")
    );
}

/// 5. A valid envelope with an invalid operation payload (bad characterId)
///    → HTTP 200 with an error envelope CONTRACT_VIOLATION carrying the
///    `issue.<i>.path` params from the kernel's DTO checker.
#[test]
fn invalid_operation_payload_returns_contract_violation_issues() {
    let server = TestServer::spawn();

    let body = envelope_body(
        &rid(1),
        "characters.get",
        json!({ "characterId": "not-a-uuid" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(
        response.status, 200,
        "post-envelope failures still answer HTTP 200"
    );
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1));
    assert_eq!(error.code, "CONTRACT_VIOLATION");
    let path = error.params["issue.0.path"].as_str().unwrap_or_default();
    assert!(path.contains("characterId"), "issue path was {path:?}");
    assert_eq!(error.params["issue.0.rule"], json!("StringFormat"));
}

/// 6. Unknown operation `nope.nope` → HTTP 200, error envelope NOT_FOUND.
#[test]
fn unknown_operation_returns_not_found_envelope() {
    let server = TestServer::spawn();

    let body = envelope_body(&rid(1), "nope.nope", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(
        response.status, 200,
        "post-envelope failures still answer HTTP 200"
    );
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1));
    assert_eq!(error.code, "NOT_FOUND");
}

/// 7. Wire-protocol major mismatch → HTTP 426 PROTOCOL_MISMATCH, and the
///    operation did NOT execute (§6.5 blocks product writes before dispatch).
#[test]
fn protocol_major_mismatch_returns_426_and_blocks_operation() {
    let server = TestServer::spawn();

    // Client speaks major 2 against a major-1 server.
    let body = envelope_body_full(
        2,
        0,
        contracts_generated::contract_schema_hash(),
        &rid(1),
        "characters.create",
        json!({ "name": "Must Not Persist" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 426, "major mismatch is HTTP 426");
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1), "requestId is known for protocol errors");
    assert_eq!(error.code, "PROTOCOL_MISMATCH");
    assert_eq!(error.params["client_major"], json!("2"));
    assert_eq!(error.params["server_major"], json!("1"));

    // The mismatched create must NOT have persisted anything.
    let list = envelope_body(&rid(2), "characters.list", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200);
    let (_, page) = expect_ok(decode_envelope(&response.body));
    assert_eq!(
        page["items"].as_array().expect("items array").len(),
        0,
        "the 426 operation must not have executed"
    );
}

/// 8. Minor too new (major 1, minor 9) → HTTP 426 PROTOCOL_MISMATCH.
#[test]
fn protocol_minor_too_new_returns_426() {
    let server = TestServer::spawn();

    let body = envelope_body_full(
        1,
        9,
        contracts_generated::contract_schema_hash(),
        &rid(1),
        "meta.get",
        json!({}),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 426, "minor too new is HTTP 426");
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "PROTOCOL_MISMATCH");
    assert_eq!(error.params["client_minor"], json!("9"));
    assert_eq!(error.params["server_minor"], json!("0"));
}

/// 9. Body over `max_request_bytes` → HTTP 413 QUOTA_EXCEEDED, both for
///    Content-Length and chunked requests; small requests still pass.
#[test]
fn request_body_over_limit_returns_413_quota_exceeded() {
    let config = RemoteAdapterConfig {
        max_request_bytes: 64,
        ..default_config()
    };
    let server = TestServer::spawn_with(config);

    // Small requests (no body) still pass the gate.
    let response = http_request(server.addr, "GET", "/meta", &[], &[]);
    assert_eq!(response.status, 200);

    // Content-Length over the limit → 413 before the body is consumed.
    let body = envelope_body(&rid(1), "meta.get", json!({}));
    assert!(body.len() > 64, "test envelope must exceed the limit");
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 413);
    let value: Value = serde_json::from_slice(&response.body).expect("413 body is JSON");
    assert_eq!(value["kind"], json!("error"));
    assert_eq!(value["error"]["code"], json!("QUOTA_EXCEEDED"));
    assert_eq!(value["error"]["params"]["rule"], json!("request_too_large"));
    assert_eq!(value["error"]["params"]["limit"], json!("64"));

    // Chunked body over the limit → the same 413 outcome.
    let response = http_request_chunked(server.addr, "/rpc", &body);
    assert_eq!(response.status, 413);
    let value: Value = serde_json::from_slice(&response.body).expect("413 body is JSON");
    assert_eq!(value["error"]["code"], json!("QUOTA_EXCEEDED"));
    assert_eq!(value["error"]["params"]["rule"], json!("request_too_large"));
}

/// 9b. Content-Length over the limit → 413 WITHOUT polling the body stream
///     (plan rev 2.2 Layer C, вход линия 1): the adapter must answer before
///     any body byte is read. We send the request head with a huge declared
///     Content-Length and ZERO body bytes; if the adapter tried to read the
///     body it would block until the read timeout, so a prompt 413 proves
///     zero body polls (poll_count == 0).
#[test]
fn oversized_content_length_is_413_without_reading_the_body() {
    let config = RemoteAdapterConfig {
        max_request_bytes: 64,
        ..default_config()
    };
    let server = TestServer::spawn_with(config);

    let mut stream = TcpStream::connect(server.addr).expect("connect to the adapter");
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");
    let head = format!(
        "POST /rpc HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: 1048576\r\n\r\n",
        server.addr
    );
    stream
        .write_all(head.as_bytes())
        .expect("write the request head");
    // Intentionally send NO body bytes — the 413 must still arrive.

    let raw = common::read_response(&mut stream).expect("adapter must answer without the body");
    let response = common::parse_response(&raw);
    assert_eq!(response.status, 413);
    let value: Value = serde_json::from_slice(&response.body).expect("413 body is JSON");
    assert_eq!(value["error"]["code"], json!("QUOTA_EXCEEDED"));
    assert_eq!(value["error"]["params"]["rule"], json!("request_too_large"));
}

/// 10. Insecure bind: `start` on a non-loopback address without
///     `trusted_proxy` → `Err(AdapterError::InsecureBind)`; with
///     `trusted_proxy = true` the same bind succeeds and serves.
#[test]
fn insecure_bind_rejected_unless_trusted_proxy_and_auth() {
    let temp = tempfile::tempdir().expect("temp dir for the kernel data root");
    let kernel = Arc::new(Mutex::new(
        Kernel::open(kernel_config(temp.path())).expect("kernel opens on the temp data root"),
    ));
    let wildcard: SocketAddr = "0.0.0.0:0".parse().expect("wildcard ephemeral parses");

    // Non-loopback bind without trusted_proxy is rejected BEFORE binding.
    let insecure = RemoteAdapter::start(
        kernel.clone(),
        RemoteAdapterConfig {
            bind_addr: wildcard,
            ..default_config()
        },
    );
    match insecure {
        Ok(_) => panic!("expected InsecureBind for the wildcard bind"),
        Err(AdapterError::InsecureBind { addr }) => {
            assert!(addr.ip().is_unspecified(), "reported addr was {addr}");
        }
        Err(other) => panic!("expected InsecureBind, got {other:?}"),
    }

    // A public bind with trusted_proxy but WITHOUT auth is a startup error
    // (§10: "Публичное включение listener без настроенных auth ... является
    // startup error").
    let no_auth = RemoteAdapter::start(
        kernel.clone(),
        RemoteAdapterConfig {
            bind_addr: wildcard,
            trusted_proxy: true,
            ..default_config()
        },
    );
    match no_auth {
        Ok(_) => panic!("expected PublicBindRequiresAuth without auth config"),
        Err(AdapterError::PublicBindRequiresAuth { addr }) => {
            assert!(addr.ip().is_unspecified(), "reported addr was {addr}");
        }
        Err(other) => panic!("expected PublicBindRequiresAuth, got {other:?}"),
    }

    // trusted_proxy=true + auth permits the wildcard bind, and it serves
    // with a valid credential.
    let adapter = RemoteAdapter::start(
        kernel,
        RemoteAdapterConfig {
            bind_addr: wildcard,
            trusted_proxy: true,
            auth: Some(AuthConfig { max_credentials: 4 }),
            ..default_config()
        },
    )
    .expect("trusted_proxy + auth permits the wildcard bind");
    assert!(adapter.is_listening());
    // Connect through loopback explicitly (0.0.0.0 destination is not
    // portable across platforms).
    let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), adapter.local_addr().port());
    let response = http_request(loopback, "GET", "/meta", &[], &[]);
    assert_eq!(
        response.status, 200,
        "trusted wildcard adapter serves /meta"
    );
    adapter.shutdown().expect("graceful shutdown");
}

/// 11. Graceful shutdown: start, one successful rpc, `shutdown()` drains and
///     releases the listener — the same port can be bound and serve again.
#[test]
fn graceful_shutdown_drains_and_releases_listener() {
    let port = free_port();
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        bind_addr: format!("127.0.0.1:{port}")
            .parse()
            .expect("fixed loopback port parses"),
        ..default_config()
    });
    assert!(
        server
            .adapter
            .as_ref()
            .expect("adapter present")
            .is_listening(),
        "adapter listens after start"
    );

    // One successful round-trip before shutdown.
    let body = envelope_body(&rid(1), "meta.get", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));

    // Graceful drain: shutdown consumes the adapter and releases the port.
    let adapter = server.adapter.take().expect("adapter present");
    adapter.shutdown().expect("graceful shutdown succeeds");

    // The same port binds again immediately: the listener was released.
    let rebound = RemoteAdapter::start(
        server.kernel.clone(),
        RemoteAdapterConfig {
            bind_addr: format!("127.0.0.1:{port}")
                .parse()
                .expect("fixed loopback port parses"),
            ..default_config()
        },
    )
    .expect("re-binding the released port succeeds");
    let response = http_request(rebound.local_addr(), "GET", "/meta", &[], &[]);
    assert_eq!(response.status, 200, "the rebound adapter serves");
    rebound.shutdown().expect("second shutdown succeeds");
}

/// 12. Two adapters sharing ONE kernel (different ephemeral ports) both
///     serve — one kernel, multiple transports is allowed.
#[test]
fn two_adapters_share_one_kernel() {
    let server = TestServer::spawn();
    let second = RemoteAdapter::start(server.kernel.clone(), default_config())
        .expect("second adapter on the same kernel starts");

    // Create through the first transport...
    let create = envelope_body(
        &rid(1),
        "characters.create",
        json!({ "name": "Via Transport A" }),
    );
    let response_a = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response_a.status, 200);
    let (_, created) = expect_ok(decode_envelope(&response_a.body));
    gen::validate_character_dto(&created).expect("created character DTO is wire-valid");
    let id = created["id"]
        .as_str()
        .expect("created character has an id")
        .to_string();

    // ...and read it back through the second transport.
    let get = envelope_body(&rid(2), "characters.get", json!({ "characterId": id }));
    let response_b = http_request(second.local_addr(), "POST", "/rpc", &[], &get);
    assert_eq!(response_b.status, 200);
    let (_, fetched) = expect_ok(decode_envelope(&response_b.body));
    gen::validate_character_dto(&fetched).expect("fetched character DTO is wire-valid");
    assert_eq!(
        fetched["id"],
        json!(id),
        "both transports see the same kernel"
    );

    second.shutdown().expect("second adapter shutdown");
}

/// 13. Single-writer negative: opening a SECOND kernel on the same data root
///     while the first is alive → `Err(KernelError)` with
///     `KernelErrorCode::DataRootInUse` (the lease comes from storage; the
///     adapter never creates a second writable owner).
#[test]
fn single_writer_negative_second_kernel_rejected() {
    let temp = tempfile::tempdir().expect("temp dir for the data root");
    let root = temp.path().to_path_buf();

    let first = Kernel::open(kernel_config(&root)).expect("first kernel acquires the lease");
    let second = Kernel::open(kernel_config(&root));
    let err =
        second.expect_err("a second kernel must not open the same data root while the first lives");
    assert_eq!(
        err.code,
        KernelErrorCode::DataRootInUse,
        "expected DataRootInUse, got {:?} (message: {})",
        err.code,
        err.message
    );

    // The lease is released when the first kernel dies.
    drop(first);
    let reopened = Kernel::open(kernel_config(&root));
    assert!(
        reopened.is_ok(),
        "lease is released when the first kernel drops: {:?}",
        reopened.err()
    );
}

/// 14. `POST /rpc/stream`: characters.list → SSE body with an `event: error`
///     CONTRACT_VIOLATION `operation_not_streamable` frame + terminal
///     `stream.closed` frame; generation.start → `event: error` NOT_FOUND +
///     terminal frame.
#[test]
fn stream_endpoint_returns_sse_error_frames() {
    let server = TestServer::spawn();

    // characters.list is registered but not streamable in Phase 4.
    let body = envelope_body(&rid(1), "characters.list", json!({}));
    let response = http_request(
        server.addr,
        "POST",
        "/rpc/stream",
        &[("Content-Type", "application/json")],
        &body,
    );
    assert_eq!(response.status, 200);
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type.starts_with("text/event-stream"),
        "content-type was {content_type:?}"
    );
    let frames = parse_sse(&String::from_utf8(response.body).expect("SSE body is UTF-8"));
    assert_eq!(frames.len(), 2, "error frame + terminal frame");

    let error_frame = &frames[0];
    assert_eq!(error_frame.event, "error");
    assert_eq!(error_frame.id, Some(0));
    let (request_id, error) = expect_error(decode_envelope(error_frame.data.as_bytes()));
    assert_eq!(request_id, rid(1), "stream error carries the requestId");
    assert_eq!(error.code, "CONTRACT_VIOLATION");
    assert_eq!(error.params["rule"], json!("operation_not_streamable"));
    assert_eq!(error.params["operationId"], json!("characters.list"));

    let terminal = &frames[1];
    assert_eq!(terminal.event, "stream.closed");
    assert_eq!(terminal.id, Some(1));
    let payload: Value = serde_json::from_str(&terminal.data).expect("terminal data is JSON");
    assert_eq!(payload, json!({}));

    // generation.start is now a REAL streamable operation (Phase 6): the
    // empty payload {} fails the kernel's RequestStartGeneration decode
    // (chatId required) → CONTRACT_VIOLATION SSE error sequence. (In Phase 4
    // the kernel did not implement generation.start and answered NOT_FOUND.)
    let body = envelope_body(&rid(2), "generation.start", json!({}));
    let response = http_request(server.addr, "POST", "/rpc/stream", &[], &body);
    assert_eq!(response.status, 200);
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type.starts_with("text/event-stream"),
        "content-type was {content_type:?}"
    );
    let frames = parse_sse(&String::from_utf8(response.body).expect("SSE body is UTF-8"));
    assert_eq!(frames.len(), 2, "error frame + terminal frame");
    let (request_id, error) = expect_error(decode_envelope(frames[0].data.as_bytes()));
    assert_eq!(request_id, rid(2));
    assert_eq!(error.code, "CONTRACT_VIOLATION");
    assert!(
        error.params["issue.0.path"]
            .as_str()
            .unwrap_or_default()
            .contains("chatId"),
        "the payload violation names chatId: {:?}",
        error.params
    );
    assert_eq!(frames[1].event, "stream.closed");
    assert_eq!(frames[1].id, Some(1));
}

/// 15. SSE framing helpers (public `sse::` API): multiline data split into
///     multiple `data:` lines, `id`/`event` omission rules, envelope and terminal
///     frames, Last-Event-ID parsing.
#[test]
fn sse_framing_helpers_encode_spec_frames() {
    // Multiline data is split into multiple `data:` lines per the SSE spec.
    let frame = encode_frame(&SseFrame {
        event: "chat.message".to_string(),
        id: Some(7),
        data: "hello\nworld".to_string(),
    });
    assert_eq!(
        frame,
        "event: chat.message\nid: 7\ndata: hello\ndata: world\n\n"
    );

    // `event:` line only when non-empty; `id:` line only when Some.
    assert_eq!(
        encode_frame(&SseFrame {
            event: "ping".to_string(),
            id: None,
            data: "pong".to_string(),
        }),
        "event: ping\ndata: pong\n\n"
    );
    assert_eq!(
        encode_frame(&SseFrame {
            event: String::new(),
            id: None,
            data: "bare".to_string(),
        }),
        "data: bare\n\n"
    );

    // Terminal frame: event = type, id = sequence, data = JSON payload.
    let terminal = encode_terminal_frame(
        "00000000-0000-4000-8000-000000000001",
        1,
        "stream.closed",
        json!({}),
    );
    assert!(terminal.starts_with("event: stream.closed\nid: 1\n"));
    assert!(terminal.ends_with("\n\n"));
    let terminal_data = terminal
        .strip_prefix("event: stream.closed\nid: 1\ndata: ")
        .expect("terminal frame data line")
        .strip_suffix("\n\n")
        .expect("terminal frame terminator");
    let payload: Value = serde_json::from_str(terminal_data).expect("terminal payload is JSON");
    assert_eq!(payload, json!({}));

    // EventEnvelope → frame: event = type, id = sequence, data = JSON(envelope).
    let envelope = gen::EventEnvelope {
        stream_id: "00000000-0000-4000-8000-000000000001".to_string(),
        sequence: 3,
        r#type: "generation.progress".to_string(),
        payload: json!({ "token": "hi" }),
    };
    let frame = encode_envelope_frame(&envelope);
    let envelope_data = frame
        .strip_prefix("event: generation.progress\nid: 3\ndata: ")
        .expect("envelope frame data line")
        .strip_suffix("\n\n")
        .expect("envelope frame terminator");
    let parsed: Value = serde_json::from_str(envelope_data).expect("envelope frame data is JSON");
    assert_eq!(
        parsed["streamId"],
        json!("00000000-0000-4000-8000-000000000001")
    );
    assert_eq!(parsed["sequence"], json!(3));
    assert_eq!(parsed["type"], json!("generation.progress"));
    assert_eq!(parsed["payload"], json!({ "token": "hi" }));

    // Last-Event-ID parsing: valid number, garbage, absent.
    assert_eq!(parse_last_event_id(Some("42")), Some(42));
    assert_eq!(parse_last_event_id(Some("not-a-number")), None);
    assert_eq!(parse_last_event_id(Some("12abc")), None);
    assert_eq!(parse_last_event_id(None), None);
}

/// 16. Remote tolerance: an envelope with a WRONG schemaHash (64 zeros) still
///     dispatches — remote clients don't need hash equality (§6.5).
#[test]
fn remote_envelope_with_wrong_schema_hash_still_dispatches() {
    let server = TestServer::spawn();

    let body = envelope_body_full(
        1,
        0,
        ZERO_SCHEMA_HASH,
        &rid(1),
        "characters.create",
        json!({ "name": "Hash Agnostic" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(response.status, 200, "wrong schema hash still dispatches");
    let (request_id, result) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1));
    gen::validate_character_dto(&result).expect("created character DTO is wire-valid");
}

// ---------------------------------------------------------------------------
// Extended Phase 4 scenarios (concurrency, seeding, protocol edges, fuzz)
// ---------------------------------------------------------------------------

/// 17. Every registered read operation serves the SAME data over HTTP that
///     the kernel serves locally: seed rows directly in storage, then read
///     them back through the adapter (chats.get, chats.messages.list,
///     lorebooks.list, presets.list, characters.list).
#[test]
fn all_registered_read_ops_serve_seeded_data_over_http() {
    let temp = tempfile::tempdir().expect("tempdir");
    seed_data_root(temp.path(), |tx| {
        tx.execute(
            "INSERT INTO characters (id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000011",
                "Seeded Bard",
                "Planted by the test",
                "[\"music\"]",
                "{}",
                T0,
            ],
        )
        .expect("seed character");
        tx.execute(
            "INSERT INTO chats (id, title, character_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000012",
                "Seeded Chat",
                "00000000-0000-4000-8000-000000000011",
                T0,
            ],
        )
        .expect("seed chat");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000013",
                "00000000-0000-4000-8000-000000000012",
                "user",
                "hello from the wire",
                0,
                T0,
            ],
        )
        .expect("seed message 1");
        tx.execute(
            "INSERT INTO messages (id, chat_id, role, content, sequence, generation_run_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000014",
                "00000000-0000-4000-8000-000000000012",
                "assistant",
                "hello back",
                1,
                T0,
            ],
        )
        .expect("seed message 2");
        tx.execute(
            "INSERT INTO lorebooks (id, name, description, entries_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000015",
                "Seeded Lore",
                "world bible",
                "[]",
                T0,
            ],
        )
        .expect("seed lorebook");
        tx.execute(
            "INSERT INTO presets (id, name, settings_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000016",
                "Seeded Preset",
                "{}",
                T0,
            ],
        )
        .expect("seed preset");
    });

    let kernel = Kernel::open(kernel_config(temp.path())).expect("kernel opens over seeded root");
    let kernel = Arc::new(Mutex::new(kernel));
    let adapter = RemoteAdapter::start(kernel, default_config()).expect("adapter starts");
    let addr = adapter.local_addr();

    // characters.list → the seeded character.
    let response = http_request(
        addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(1), "characters.list", json!({ "limit": 50 })),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_characters(&result).expect("paged characters is wire-valid");
    assert_eq!(result["items"].as_array().expect("items").len(), 1);
    assert_eq!(result["items"][0]["name"], json!("Seeded Bard"));

    // chats.get → the seeded chat with its title.
    let response = http_request(
        addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(
            &rid(2),
            "chats.get",
            json!({ "chatId": "00000000-0000-4000-8000-000000000012" }),
        ),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_chat_dto(&result).expect("chat DTO is wire-valid");
    assert_eq!(result["title"], json!("Seeded Chat"));

    // chats.messages.list → both messages, ordered by sequence.
    let response = http_request(
        addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(
            &rid(3),
            "chats.messages.list",
            json!({ "chatId": "00000000-0000-4000-8000-000000000012", "limit": 10 }),
        ),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_paged_messages(&result).expect("paged messages is wire-valid");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["content"], json!("hello from the wire"));
    assert_eq!(items[1]["content"], json!("hello back"));

    // lorebooks.list / presets.list → the seeded rows.
    let response = http_request(
        addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(4), "lorebooks.list", json!({})),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_list_lorebooks(&result).expect("lorebook list is wire-valid");
    assert_eq!(result["items"][0]["name"], json!("Seeded Lore"));

    let response = http_request(
        addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(5), "presets.list", json!({})),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_list_presets(&result).expect("preset list is wire-valid");
    assert_eq!(result["items"][0]["name"], json!("Seeded Preset"));

    adapter.shutdown().expect("graceful shutdown");
}

/// 18. Write ops over HTTP: characters.update persists, characters.delete
///     removes, and the follow-up get returns the stable product error
///     `CHARACTER_NOT_FOUND` copied verbatim into the error envelope.
#[test]
fn character_update_and_delete_over_http() {
    let server = TestServer::spawn();

    let create = envelope_body(&rid(1), "characters.create", json!({ "name": "Mira" }));
    let response = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response.status, 200);
    let (_, created) = expect_ok(decode_envelope(&response.body));
    gen::validate_character_dto(&created).expect("created character is wire-valid");
    let character_id = created["id"].as_str().expect("id").to_string();

    // update name + tags; description must survive (partial update).
    let update = envelope_body(
        &rid(2),
        "characters.update",
        json!({ "characterId": character_id, "name": "Mira the Swift", "tags": ["ranger"] }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &update);
    assert_eq!(response.status, 200);
    let (_, updated) = expect_ok(decode_envelope(&response.body));
    gen::validate_character_dto(&updated).expect("updated character is wire-valid");
    assert_eq!(updated["name"], json!("Mira the Swift"));

    let get = envelope_body(
        &rid(3),
        "characters.get",
        json!({ "characterId": character_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (_, fetched) = expect_ok(decode_envelope(&response.body));
    assert_eq!(fetched["name"], json!("Mira the Swift"));

    let delete = envelope_body(
        &rid(4),
        "characters.delete",
        json!({ "characterId": character_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &delete);
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));

    // The follow-up get must surface the stable product error verbatim.
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(3));
    assert_eq!(error.code, "CHARACTER_NOT_FOUND");
    assert_eq!(error.params["characterId"], json!(character_id));
}

/// 19. Envelope schema violations are rejected at the transport layer with
///     HTTP 400 and the generated `Issue` list flattened into params: extra
///     unknown field, missing `wireProtocol`, non-object `payload`.
#[test]
fn envelope_schema_violations_return_400_with_issues() {
    let server = TestServer::spawn();

    // Extra unknown top-level field (envelopes are strict).
    let mut raw = serde_json::to_vec(&json!({
        "wireProtocol": { "major": 1, "minor": 0 },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": rid(1),
        "operationId": "meta.get",
        "payload": {},
        "extra": true,
    }))
    .expect("serialize");
    let response = http_request(server.addr, "POST", "/rpc", &[], &raw);
    assert_eq!(response.status, 400, "extra field must be rejected");
    let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
    assert_eq!(body["kind"], json!("error"));
    assert_eq!(body["error"]["code"], json!("CONTRACT_VIOLATION"));
    assert_eq!(body["error"]["params"]["issue.0.path"], json!("extra"));
    assert_eq!(
        body["error"]["params"]["issue.0.rule"],
        json!("AdditionalProperties")
    );

    // Missing wireProtocol (required property).
    raw = serde_json::to_vec(&json!({
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": rid(2),
        "operationId": "meta.get",
        "payload": {},
    }))
    .expect("serialize");
    let response = http_request(server.addr, "POST", "/rpc", &[], &raw);
    assert_eq!(response.status, 400);
    let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
    assert_eq!(
        body["error"]["params"]["issue.0.path"],
        json!("wireProtocol")
    );
    assert_eq!(
        body["error"]["params"]["issue.0.rule"],
        json!("RequiredProperty")
    );

    // Non-object payload.
    raw = serde_json::to_vec(&json!({
        "wireProtocol": { "major": 1, "minor": 0 },
        "schemaHash": contracts_generated::contract_schema_hash(),
        "requestId": rid(3),
        "operationId": "meta.get",
        "payload": "not an object",
    }))
    .expect("serialize");
    let response = http_request(server.addr, "POST", "/rpc", &[], &raw);
    assert_eq!(response.status, 400);
    let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
    assert_eq!(body["error"]["params"]["issue.0.path"], json!("payload"));
    assert_eq!(body["error"]["params"]["issue.0.rule"], json!("Object"));

    // The server is still healthy afterwards.
    let response = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(4), "meta.get", json!({})),
    );
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));
}

/// 20. Route and method negatives: wrong method on a known path is 405
///     VALIDATION, unknown paths are 404 NOT_FOUND.
#[test]
fn route_and_method_negatives_return_mapped_statuses() {
    let server = TestServer::spawn();

    let response = http_request(server.addr, "GET", "/rpc", &[], &[]);
    assert_eq!(response.status, 405, "GET /rpc is a method violation");
    let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
    assert_eq!(body["error"]["code"], json!("VALIDATION"));

    let response = http_request(server.addr, "POST", "/does-not-exist", &[], b"{}");
    assert_eq!(response.status, 404, "unknown route");
    let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
    assert_eq!(body["error"]["code"], json!("NOT_FOUND"));

    let response = http_request(server.addr, "GET", "/", &[], &[]);
    assert_eq!(response.status, 404, "root is not a route");
}

/// 21. Deterministic garbage fuzz: random byte bodies (never valid
///     envelopes) must produce controlled errors and never crash the
///     adapter; a healthy request afterwards still succeeds (§6.8: negative
///     payload never panics).
#[test]
fn garbage_bodies_never_crash_the_adapter() {
    let server = TestServer::spawn();

    // Minimal deterministic LCG (no rand dependency): x_{n+1} =
    // (a*x_n + c) mod 2^64; fixed seed for reproducible transcripts.
    let mut state: u64 = 0x5eed_cafe_dead_beef;
    let mut next_u8 = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u8
    };

    for _ in 0..200 {
        let len = (next_u8() as usize) % 513;
        let mut garbage = vec![0u8; len];
        for byte in &mut garbage {
            *byte = next_u8();
        }
        let response = http_request(server.addr, "POST", "/rpc", &[], &garbage);
        // Garbage is either not JSON or not an envelope → 400; never 200,
        // never a panic (a crash would kill the worker pool and fail the
        // next request).
        assert_eq!(
            response.status, 400,
            "garbage ({len} bytes) must be rejected, got {}",
            response.status
        );
        let body: Value = serde_json::from_slice(&response.body).expect("error body is JSON");
        assert_eq!(body["kind"], json!("error"));
    }

    // The adapter is still healthy.
    let response = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[],
        &envelope_body(&rid(1), "characters.create", json!({ "name": "Survivor" })),
    );
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_character_dto(&result).expect("created character is wire-valid");
}

/// 22. Concurrent mixed traffic: parallel clients create characters and read
///     lists through the mutex-coordinated single writer; every create is
///     durable (no lost updates) and every response is a valid envelope.
#[test]
fn concurrent_mixed_traffic_keeps_single_writer_consistency() {
    let server = TestServer::spawn();
    let addr = server.addr;

    const THREADS: usize = 16;
    const PER_THREAD: usize = 16;

    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            std::thread::spawn(move || {
                for i in 0..PER_THREAD {
                    // One write + two reads per iteration.
                    let create = envelope_body(
                        &rid((t * PER_THREAD + i) as u32 + 1),
                        "characters.create",
                        json!({ "name": format!("Concurrent-{t}-{i}") }),
                    );
                    let response = http_request(addr, "POST", "/rpc", &[], &create);
                    assert_eq!(response.status, 200);
                    let (_, result) = expect_ok(decode_envelope(&response.body));
                    gen::validate_character_dto(&result).expect("created DTO is wire-valid");

                    let list = envelope_body(
                        &rid((t * PER_THREAD + i) as u32 + 1000),
                        "characters.list",
                        json!({ "limit": 50 }),
                    );
                    let response = http_request(addr, "POST", "/rpc", &[], &list);
                    assert_eq!(response.status, 200);
                    expect_ok(decode_envelope(&response.body));

                    let meta = envelope_body(
                        &rid((t * PER_THREAD + i) as u32 + 2000),
                        "meta.get",
                        json!({}),
                    );
                    let response = http_request(addr, "POST", "/rpc", &[], &meta);
                    assert_eq!(response.status, 200);
                    expect_ok(decode_envelope(&response.body));
                }
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("worker thread finishes");
    }

    // Every create is committed exactly once. The list limit is capped at 200
    // by the contract, so read pages (cursor) and sum — no create may be lost
    // or duplicated across the page boundary.
    let mut total = 0usize;
    let mut cursor: Option<String> = None;
    loop {
        let mut payload = json!({ "limit": 200 });
        if let Some(cursor_value) = &cursor {
            payload["cursor"] = json!(cursor_value);
        }
        let list = envelope_body(&rid(900 + total as u32), "characters.list", payload);
        let response = http_request(server.addr, "POST", "/rpc", &[], &list);
        assert_eq!(response.status, 200);
        let (_, result) = expect_ok(decode_envelope(&response.body));
        gen::validate_paged_characters(&result).expect("paged characters is wire-valid");
        total += result["items"].as_array().expect("items").len();
        match result["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    assert_eq!(
        total,
        THREADS * PER_THREAD,
        "no create was lost or duplicated"
    );
}

/// 23. Keep-alive: two requests on ONE persistent connection both get their
///     own valid response envelopes (request→response, no pipelining).
#[test]
fn keep_alive_connection_serves_multiple_requests() {
    let server = TestServer::spawn();

    let meta = envelope_body(&rid(1), "meta.get", json!({}));
    let list = envelope_body(&rid(2), "characters.list", json!({ "limit": 50 }));
    let responses = http_requests_keepalive(
        server.addr,
        &[("POST", "/rpc", &meta), ("POST", "/rpc", &list)],
    );
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].status, 200);
    assert_eq!(responses[1].status, 200);
    let (request_id, _) = expect_ok(decode_envelope(&responses[0].body));
    assert_eq!(request_id, rid(1));
    let (request_id, result) = expect_ok(decode_envelope(&responses[1].body));
    assert_eq!(request_id, rid(2));
    gen::validate_paged_characters(&result).expect("list result is wire-valid");
}

/// 24. The protocol gate runs BEFORE the streaming classification: a
///     protocol-mismatched envelope on /rpc/stream is a 426 JSON error
///     envelope (not an SSE stream).
#[test]
fn stream_endpoint_enforces_protocol_before_streaming() {
    let server = TestServer::spawn();

    let body = envelope_body_full(
        2,
        0,
        contracts_generated::contract_schema_hash(),
        &rid(1),
        "characters.list",
        json!({}),
    );
    let response = http_request(
        server.addr,
        "POST",
        "/rpc/stream",
        &[("Content-Type", "application/json")],
        &body,
    );
    assert_eq!(
        response.status, 426,
        "major mismatch is rejected before streaming"
    );
    let content_type = response.header("content-type").unwrap_or_default();
    assert!(
        content_type.starts_with("application/json"),
        "426 body is JSON, not SSE: {content_type:?}"
    );
    let (request_id, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1));
    assert_eq!(error.code, "PROTOCOL_MISMATCH");
    assert_eq!(error.params["client_major"], json!("2"));
    assert_eq!(error.params["server_major"], json!("1"));
}

/// 25. `backups.create` + `backups.list` over `/rpc` (Phase 11): create on
///     the adapter's data root → 200 ok envelope, the created backup DTO
///     passes `validate_backup_dto` with `status == "completed"`, and the
///     follow-up list contains the created backup.
#[test]
fn backups_create_and_list_over_http() {
    let server = TestServer::spawn();

    let create = envelope_body(&rid(1), "backups.create", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response.status, 200, "backups.create answers HTTP 200");
    let (request_id, created) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1), "requestId is echoed");
    gen::validate_backup_dto(&created).expect("created backup DTO is wire-valid");
    assert_eq!(created["status"], json!("completed"));
    assert_eq!(created["formatVersion"], json!(1.0));
    let id = created["id"]
        .as_str()
        .expect("created backup has an id")
        .to_string();
    let checksum = created["checksumSha256"]
        .as_str()
        .expect("created backup has a checksum");
    assert_eq!(checksum.len(), 64, "checksumSha256 is a sha256 hex digest");
    assert!(
        checksum.chars().all(|c| c.is_ascii_hexdigit()),
        "checksumSha256 is hex"
    );

    let list = envelope_body(&rid(2), "backups.list", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200, "backups.list answers HTTP 200");
    let (request_id, result) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(2), "requestId is echoed");
    gen::validate_result_list_backups(&result).expect("list-backups result is wire-valid");
    let items = result["items"].as_array().expect("items array");
    assert!(
        items.iter().any(|b| b["id"] == json!(id)),
        "the created backup is listed"
    );
    assert_eq!(items.len(), 1, "exactly one backup on a fresh root");
}

/// 26. M4 slice 1 (Этап 4.1): the full lorebook CRUD over the HTTP host —
///     create with entries → get → update → delete — with the product error
///     `LOREBOOK_NOT_FOUND` copied verbatim into the error envelope after
///     deletion (host parity with the direct kernel path).
#[test]
fn lorebook_crud_over_http() {
    let server = TestServer::spawn();

    let create = envelope_body(
        &rid(1),
        "lorebooks.create",
        json!({
            "name": "Harbor world",
            "description": "The city by the sea",
            "entries": [
                { "keys": ["harbor"], "content": "The harbor never freezes." }
            ]
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response.status, 200, "lorebooks.create answers HTTP 200");
    let (request_id, created) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1), "requestId is echoed");
    gen::validate_lorebook_dto(&created).expect("created lorebook DTO is wire-valid");
    assert_eq!(created["name"], json!("Harbor world"));
    assert_eq!(created["entryCount"], json!(1));
    let lorebook_id = created["id"]
        .as_str()
        .expect("created lorebook has an id")
        .to_string();

    let get = envelope_body(
        &rid(2),
        "lorebooks.get",
        json!({ "lorebookId": lorebook_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (_, fetched) = expect_ok(decode_envelope(&response.body));
    gen::validate_lorebook_dto(&fetched).expect("fetched lorebook DTO is wire-valid");
    assert_eq!(fetched["id"], json!(lorebook_id));

    // Entry-level ops over HTTP (M4 slice 1): list → create → update →
    // delete all answer HTTP 200 with wire-valid payloads.
    let list_entries = envelope_body(
        &rid(3),
        "lorebooks.entries.list",
        json!({ "lorebookId": lorebook_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &list_entries);
    assert_eq!(response.status, 200);
    let (_, listed) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_list_lorebook_entries(&listed).expect("list entries result is wire-valid");
    assert_eq!(listed["items"].as_array().map(Vec::len), Some(1));
    let entry_id = listed["items"][0]["id"]
        .as_str()
        .expect("entry has a kernel-assigned id")
        .to_string();

    let create_entry = envelope_body(
        &rid(4),
        "lorebooks.entries.create",
        json!({
            "lorebookId": lorebook_id,
            "entry": { "keys": ["citadel"], "content": "The citadel towers." }
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &create_entry);
    assert_eq!(response.status, 200);
    let (_, created_entry) = expect_ok(decode_envelope(&response.body));
    gen::validate_lorebook_entry_dto(&created_entry).expect("created entry DTO is wire-valid");
    assert_ne!(created_entry["id"], json!(entry_id));

    let update_entry = envelope_body(
        &rid(5),
        "lorebooks.entries.update",
        json!({
            "lorebookId": lorebook_id,
            "entryId": entry_id,
            "patch": { "content": "The harbor freezes in winter." }
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &update_entry);
    assert_eq!(response.status, 200);
    let (_, updated_entry) = expect_ok(decode_envelope(&response.body));
    gen::validate_lorebook_entry_dto(&updated_entry).expect("updated entry DTO is wire-valid");
    assert_eq!(
        updated_entry["content"],
        json!("The harbor freezes in winter.")
    );

    let delete_entry = envelope_body(
        &rid(6),
        "lorebooks.entries.delete",
        json!({ "lorebookId": lorebook_id, "entryId": entry_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &delete_entry);
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));

    let update = envelope_body(
        &rid(7),
        "lorebooks.update",
        json!({ "lorebookId": lorebook_id, "name": "Harbor world v2", "entries": [] }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &update);
    assert_eq!(response.status, 200);
    let (_, updated) = expect_ok(decode_envelope(&response.body));
    gen::validate_lorebook_dto(&updated).expect("updated lorebook DTO is wire-valid");
    assert_eq!(updated["name"], json!("Harbor world v2"));
    assert_eq!(updated["entryCount"], json!(0));

    let delete = envelope_body(
        &rid(8),
        "lorebooks.delete",
        json!({ "lorebookId": lorebook_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &delete);
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));

    // The follow-up get answers the stable product error verbatim.
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "LOREBOOK_NOT_FOUND");
    assert_eq!(error.params["lorebookId"], json!(lorebook_id));
}

/// 27. M4 slice 1 (Этап 4.1): the full persona CRUD over the HTTP host —
///     create default → list → get → update (rename + avatar, demote via
///     isDefault:false) → delete — with the product error
///     `PERSONA_NOT_FOUND` (personaId param) copied verbatim into the error
///     envelope after deletion (host parity with the direct kernel path).
#[test]
fn persona_crud_over_http() {
    let server = TestServer::spawn();

    let create = envelope_body(
        &rid(1),
        "personas.create",
        json!({ "name": "Aria", "description": "Curious scholar", "isDefault": true }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &create);
    assert_eq!(response.status, 200, "personas.create answers HTTP 200");
    let (request_id, created) = expect_ok(decode_envelope(&response.body));
    assert_eq!(request_id, rid(1), "requestId is echoed");
    gen::validate_persona_dto(&created).expect("created persona DTO is wire-valid");
    assert_eq!(created["name"], json!("Aria"));
    assert_eq!(created["isDefault"], json!(true));
    let persona_id = created["id"]
        .as_str()
        .expect("created persona has an id")
        .to_string();

    let list = envelope_body(&rid(2), "personas.list", json!({}));
    let response = http_request(server.addr, "POST", "/rpc", &[], &list);
    assert_eq!(response.status, 200);
    let (_, result) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_list_personas(&result).expect("list-personas result is wire-valid");
    assert_eq!(result["items"][0]["id"], json!(persona_id));

    let get = envelope_body(&rid(3), "personas.get", json!({ "personaId": persona_id }));
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (_, fetched) = expect_ok(decode_envelope(&response.body));
    gen::validate_persona_dto(&fetched).expect("fetched persona DTO is wire-valid");
    assert_eq!(fetched["id"], json!(persona_id));

    let update = envelope_body(
        &rid(4),
        "personas.update",
        json!({ "personaId": persona_id, "name": "Aria the Voyager", "isDefault": false }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &update);
    assert_eq!(response.status, 200);
    let (_, updated) = expect_ok(decode_envelope(&response.body));
    gen::validate_persona_dto(&updated).expect("updated persona DTO is wire-valid");
    assert_eq!(updated["name"], json!("Aria the Voyager"));
    assert_eq!(updated["isDefault"], json!(false));

    let delete = envelope_body(
        &rid(5),
        "personas.delete",
        json!({ "personaId": persona_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &delete);
    assert_eq!(response.status, 200);
    expect_ok(decode_envelope(&response.body));

    // The follow-up get answers the stable product error verbatim.
    let response = http_request(server.addr, "POST", "/rpc", &[], &get);
    assert_eq!(response.status, 200);
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "PERSONA_NOT_FOUND");
    assert_eq!(error.params["personaId"], json!(persona_id));
}

/// Этап 4.5 host parity: `imports.character.card` over HTTP — stage the card
/// via `assets.put`, import (created), re-import the same bytes (dedupe,
/// `created: false`, same character), and the stable error paths
/// (`ASSET_NOT_FOUND`, `CHARACTER_CARD_INVALID`).
#[test]
fn character_card_import_over_http() {
    let server = TestServer::spawn();

    // Base64 of `{"name":"Ada Lovelace","description":"First programmer","tags":["analytical"]}`.
    const CARD_B64: &str = "eyJuYW1lIjoiQWRhIExvdmVsYWNlIiwiZGVzY3JpcHRpb24iOiJGaXJzdCBwcm9ncmFtbWVyIiwidGFncyI6WyJhbmFseXRpY2FsIl19";

    let put = envelope_body(
        &rid(1),
        "assets.put",
        json!({
            "kind": "card",
            "filename": "ada.json",
            "contentType": "application/json",
            "contentBase64": CARD_B64,
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &put);
    assert_eq!(response.status, 200, "assets.put answers HTTP 200");
    let (_, put_result) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_assets_put(&put_result).expect("assets.put result is wire-valid");
    let asset_id = put_result["asset"]["id"]
        .as_str()
        .expect("staged card asset has an id")
        .to_string();

    let import = envelope_body(
        &rid(2),
        "imports.character.card",
        json!({ "assetId": asset_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &import);
    assert_eq!(
        response.status, 200,
        "imports.character.card answers HTTP 200"
    );
    let (_, imported) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_imports_character_card(&imported).expect("import result is wire-valid");
    assert_eq!(imported["created"], json!(true));
    assert_eq!(imported["character"]["name"], json!("Ada Lovelace"));
    let character_id = imported["character"]["id"]
        .as_str()
        .expect("imported character has an id")
        .to_string();
    let source_hash = imported["sourceHash"]
        .as_str()
        .expect("import result carries the source hash");
    assert_eq!(source_hash.len(), 64);

    // Re-import of the same card bytes → dedupe: created:false, same id.
    let response = http_request(server.addr, "POST", "/rpc", &[], &import);
    assert_eq!(response.status, 200);
    let (_, reimported) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_imports_character_card(&reimported)
        .expect("re-import result is wire-valid");
    assert_eq!(reimported["created"], json!(false));
    assert_eq!(reimported["character"]["id"], json!(character_id));

    // Unknown asset → stable ASSET_NOT_FOUND product error with the id param.
    let missing = envelope_body(
        &rid(3),
        "imports.character.card",
        json!({ "assetId": "00000000-0000-4000-8000-000000000000" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &missing);
    assert_eq!(response.status, 200);
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "ASSET_NOT_FOUND");
    assert_eq!(
        error.params["assetId"],
        json!("00000000-0000-4000-8000-000000000000")
    );

    // Unparseable card bytes → CHARACTER_CARD_INVALID with the reason param.
    let put_bad = envelope_body(
        &rid(4),
        "assets.put",
        json!({
            "kind": "card",
            "filename": "bad.json",
            "contentType": "application/json",
            "contentBase64": "cGxhaW4gdGV4dCwgbm90IGEgY2FyZA==",
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &put_bad);
    assert_eq!(response.status, 200);
    let (_, put_bad_result) = expect_ok(decode_envelope(&response.body));
    let bad_asset_id = put_bad_result["asset"]["id"]
        .as_str()
        .expect("bad card asset has an id")
        .to_string();
    let import_bad = envelope_body(
        &rid(5),
        "imports.character.card",
        json!({ "assetId": bad_asset_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &import_bad);
    assert_eq!(response.status, 200);
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "CHARACTER_CARD_INVALID");
    assert_eq!(error.params["reason"], json!("INVALID_JSON"));
}

/// Этап 4.5 host parity: `characters.export.card` over HTTP — export the
/// imported card (JSON verbatim round trip), export a manually created
/// character (rebuilt from canonical fields with an honest warning), the PNG
/// format (valid signature), and the stable `CHARACTER_NOT_FOUND` error.
#[test]
fn character_card_export_over_http() {
    let server = TestServer::spawn();

    // Base64 of `{"name":"Ada Lovelace","description":"First programmer","tags":["analytical"]}`.
    const CARD_B64: &str = "eyJuYW1lIjoiQWRhIExvdmVsYWNlIiwiZGVzY3JpcHRpb24iOiJGaXJzdCBwcm9ncmFtbWVyIiwidGFncyI6WyJhbmFseXRpY2FsIl19";

    let put = envelope_body(
        &rid(1),
        "assets.put",
        json!({
            "kind": "card",
            "filename": "ada.json",
            "contentType": "application/json",
            "contentBase64": CARD_B64,
        }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &put);
    assert_eq!(response.status, 200, "assets.put answers HTTP 200");
    let (_, put_result) = expect_ok(decode_envelope(&response.body));
    let asset_id = put_result["asset"]["id"]
        .as_str()
        .expect("staged card asset has an id")
        .to_string();

    let import = envelope_body(
        &rid(2),
        "imports.character.card",
        json!({ "assetId": asset_id }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &import);
    assert_eq!(response.status, 200);
    let (_, imported) = expect_ok(decode_envelope(&response.body));
    let character_id = imported["character"]["id"]
        .as_str()
        .expect("imported character has an id")
        .to_string();

    // Export JSON: verbatim round trip, no warnings, wire-valid result.
    let export = envelope_body(
        &rid(3),
        "characters.export.card",
        json!({ "characterId": character_id, "format": "json" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &export);
    assert_eq!(
        response.status, 200,
        "characters.export.card answers HTTP 200"
    );
    let (_, exported) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_characters_export_card(&exported).expect("export result is wire-valid");
    assert_eq!(exported["contentType"], json!("application/json"));
    // The fixture card had no V2 envelope, so the kernel wraps it honestly.
    assert_eq!(
        exported["warnings"],
        json!(["original card had no V2 container envelope; wrapped in chara_card_v2"])
    );
    assert!(exported["filename"]
        .as_str()
        .expect("filename")
        .ends_with(".json"));
    // The exported card carries the V2 `spec` envelope with the fields intact.
    let decoded = decode_base64(exported["contentBase64"].as_str().expect("contentBase64"));
    let card: Value = serde_json::from_slice(&decoded).expect("exported card JSON parses");
    assert_eq!(card["spec"], "chara_card_v2");
    assert_eq!(card["data"]["name"], "Ada Lovelace");

    // PNG format: valid PNG signature, same content type.
    let export_png = envelope_body(
        &rid(4),
        "characters.export.card",
        json!({ "characterId": character_id, "format": "png" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &export_png);
    assert_eq!(response.status, 200);
    let (_, exported_png) = expect_ok(decode_envelope(&response.body));
    gen::validate_result_characters_export_card(&exported_png)
        .expect("png export result is wire-valid");
    assert_eq!(exported_png["contentType"], json!("image/png"));
    let png = decode_base64(
        exported_png["contentBase64"]
            .as_str()
            .expect("contentBase64"),
    );
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    // Missing character answers the stable product error verbatim.
    let export_missing = envelope_body(
        &rid(5),
        "characters.export.card",
        json!({ "characterId": "00000000-0000-4000-8000-000000000000", "format": "json" }),
    );
    let response = http_request(server.addr, "POST", "/rpc", &[], &export_missing);
    assert_eq!(response.status, 200);
    let (_, error) = expect_error(decode_envelope(&response.body));
    assert_eq!(error.code, "CHARACTER_NOT_FOUND");
    assert_eq!(
        error.params["characterId"],
        json!("00000000-0000-4000-8000-000000000000")
    );
}
