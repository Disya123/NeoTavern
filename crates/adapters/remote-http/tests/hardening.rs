//! Phase 4 hardening / Phase 9 adapter tests: pairing/auth gate, rate
//! limiting, bounded audit and the concurrent-stream cap (ТЗ §10).
//!
//! Scenarios drive the same real kernel + adapter as `remote_http.rs`,
//! reusing the shared helpers. New numbered scenarios continue the
//! remote_http.rs numbering (25+).

mod common;

use common::*;
use remote_http_adapter::auth::AuthError;

/// Issues one credential through the adapter's pairing surface.
/// Returns `(credential_id, token)`.
fn pair_token(adapter: &RemoteAdapter) -> (String, String) {
    let (id, token) = adapter.pair(Some("test".to_string())).expect("pairing ok");
    assert!(!id.is_empty());
    (id, token)
}

/// 25. Pairing gate: with auth configured, `/rpc` requires a valid bearer
///     token; `/meta` stays open (handshake surface, no secrets).
#[test]
fn pairing_gate_requires_bearer_token_on_rpc() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        ..default_config()
    });
    let adapter = server.adapter.as_ref().expect("adapter present");

    // /meta is open without a credential.
    let meta = http_request(server.addr, "GET", "/meta", &[], &[]);
    assert_eq!(meta.status, 200, "/meta open for the handshake");

    // /rpc without a token → 401 UNAUTHORIZED (missing_credential).
    let body = envelope_body(&rid(2501), "meta.get", json!({}));
    let no_token = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(no_token.status, 401);
    assert!(
        String::from_utf8_lossy(&no_token.body).contains("missing_credential"),
        "401 carries the missing-credential rule: {}",
        String::from_utf8_lossy(&no_token.body)
    );
    assert!(
        no_token
            .headers
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("WWW-Authenticate") && value == "Bearer"),
        "401 carries WWW-Authenticate: Bearer"
    );

    // Invalid token → 401 UNAUTHORIZED (invalid_credential).
    let bad = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[(
            "Authorization",
            "Bearer deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        )],
        &body,
    );
    assert_eq!(bad.status, 401);
    assert!(String::from_utf8_lossy(&bad.body).contains("invalid_credential"));

    // Valid token → dispatched (200 + ok envelope).
    let (_, token) = pair_token(adapter);
    let good = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(good.status, 200, "valid credential dispatches");
    let (request_id, _) = expect_ok(decode_envelope(&good.body));
    assert_eq!(request_id, rid(2501));

    server.shutdown();
}

/// 26. Auth gate runs BEFORE the body is read: an oversized body without a
///     credential is 401, not 413 (§10: "auth проверяется до чтения body
///     сверх минимального лимита").
#[test]
fn auth_gate_runs_before_body_read() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        max_request_bytes: 1024,
        ..default_config()
    });
    let oversized = vec![b'x'; 4096];
    let response = http_request(server.addr, "POST", "/rpc", &[], &oversized);
    assert_eq!(response.status, 401, "auth gate precedes the body limit");
    assert!(String::from_utf8_lossy(&response.body).contains("missing_credential"));

    // With a valid token the same oversized body hits the 413 limit instead.
    let adapter = server.adapter.as_ref().expect("adapter present");
    let (_, token) = pair_token(adapter);
    let response = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &oversized,
    );
    assert_eq!(
        response.status, 413,
        "body limit applies after the auth gate"
    );

    server.shutdown();
}

/// 27. Pairing lifecycle: revoke takes effect for new calls (no credential
///     leakage, no replay after revoke).
#[test]
fn pairing_revoke_blocks_new_calls() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        ..default_config()
    });
    let adapter = server.adapter.as_ref().expect("adapter present");
    let (_, token) = pair_token(adapter);

    let body = envelope_body(&rid(2701), "meta.get", json!({}));
    let before = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(before.status, 200, "token works before revoke");

    let id = adapter
        .credentials()
        .into_iter()
        .find(|info| !info.revoked)
        .expect("one live credential")
        .id;
    assert!(adapter.revoke(&id), "revoke succeeds");

    let after = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(after.status, 401, "revoked token rejected");

    server.shutdown();
}

/// 28. Credential store is bounded: pairing beyond `max_credentials` fails
///     with a typed error.
#[test]
fn pairing_store_respects_bounded_cap() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 2 }),
        ..default_config()
    });
    let adapter = server.adapter.as_ref().expect("adapter present");
    adapter.pair(None).expect("first credential");
    adapter.pair(None).expect("second credential");
    assert_eq!(
        adapter.pair(None),
        Err(AuthError::LimitReached),
        "third pairing rejected at cap"
    );
    server.shutdown();
}

/// 29. Rate limiting: a configured limiter rejects over-burst requests with
///     429 RATE_LIMITED + Retry-After.
#[test]
fn rate_limit_rejects_over_burst() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        rate_limit: Some(RateLimitConfig {
            requests_per_second: 1,
            burst: 3,
            max_clients: 16,
        }),
        ..default_config()
    });
    let adapter = server.adapter.as_ref().expect("adapter present");
    let (_, token) = pair_token(adapter);
    let body = envelope_body(&rid(2901), "meta.get", json!({}));

    for _ in 0..3 {
        let response = http_request(
            server.addr,
            "POST",
            "/rpc",
            &[("Authorization", &format!("Bearer {token}"))],
            &body,
        );
        assert_eq!(response.status, 200, "burst requests admitted");
    }
    let limited = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(limited.status, 429, "over-burst request rejected");
    assert!(String::from_utf8_lossy(&limited.body).contains("RATE_LIMITED"));
    assert!(
        limited
            .headers
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("Retry-After") && value == "1"),
        "429 carries Retry-After"
    );

    server.shutdown();
}

/// 30. Concurrent-stream cap: with `max_streams = 1`, a second long-lived
///     stream is rejected 429 RATE_LIMITED (rule `stream_limit`).
#[test]
fn concurrent_stream_cap_rejects_over_limit() {
    // A seeded chat so generation.start can actually open a live stream.
    let mut server = TestServer::spawn_with_config_and_seed(
        RemoteAdapterConfig {
            auth: Some(AuthConfig { max_credentials: 4 }),
            max_streams: 1,
            ..default_config()
        },
        |tx| seed_chat(tx, &rid(3001), &rid(3002)),
    );
    let adapter = server.adapter.as_ref().expect("adapter present");
    let (_, token) = pair_token(adapter);

    let stream_body = envelope_body(
        &rid(3003),
        "generation.start",
        json!({
            "chatId": rid(3002),
            "message": "hello",
            "model": "steps=300;delay-ms=5;tokens-per-step=1"
        }),
    );

    // First stream: open it and wait until the adapter has actually admitted
    // it (the response has started), so the cap slot is held when the second
    // request arrives. The fake provider runs 300 steps × 5ms ≈ 1.5s.
    let mut first_stream = TcpStream::connect(server.addr).expect("connect");
    first_stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");
    let mut request = format!(
        "POST /rpc/stream HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
        server.addr,
        stream_body.len()
    );
    request.push_str(&String::from_utf8_lossy(&stream_body));
    first_stream
        .write_all(request.as_bytes())
        .expect("write request");

    // Wait for the 200 status line (bounded stall budget, like the shared
    // stream helpers).
    let mut head_buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut stalls = 0u32;
    let admitted = loop {
        if let Some(separator) = find_subslice(&head_buf, b"\r\n\r\n") {
            break String::from_utf8_lossy(&head_buf[..separator])
                .to_ascii_lowercase()
                .contains(" 200 ");
        }
        match first_stream.read(&mut chunk) {
            Ok(0) => break false,
            Ok(n) => {
                head_buf.extend_from_slice(&chunk[..n]);
                stalls = 0;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                stalls += 1;
                if stalls > 50 {
                    break false; // ~5s cap
                }
            }
            Err(_) => break false,
        }
    };
    assert!(
        admitted,
        "first stream must be admitted before the second request (head: {})",
        String::from_utf8_lossy(&head_buf)
    );

    // Second stream must be rejected while the first is open.
    let second = http_request(
        server.addr,
        "POST",
        "/rpc/stream",
        &[("Authorization", &format!("Bearer {token}"))],
        &stream_body,
    );
    assert_eq!(second.status, 429, "concurrent stream cap enforced");
    assert!(String::from_utf8_lossy(&second.body).contains("stream_limit"));

    // Drain the first stream to completion (bounded read; the fake provider
    // terminates by itself).
    let _ = read_response(&mut first_stream);
    server.shutdown();
}

/// 31. Audit log: gate decisions are recorded without token material.
#[test]
fn audit_records_gate_events_without_secrets() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        ..default_config()
    });
    let adapter = server.adapter.as_ref().expect("adapter present");

    let body = envelope_body(&rid(3101), "meta.get", json!({}));
    let denied = http_request(server.addr, "POST", "/rpc", &[], &body);
    assert_eq!(denied.status, 401);

    let (_, token) = pair_token(adapter);
    let granted = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        &body,
    );
    assert_eq!(granted.status, 200);

    let events = adapter.audit_events();
    assert!(
        events
            .iter()
            .any(|event| event.kind == AuditKind::AuthDenied),
        "auth denial recorded"
    );
    assert!(
        events
            .iter()
            .any(|event| event.kind == AuditKind::AuthGranted),
        "auth grant recorded"
    );
    // No token material (64 hex chars of the raw token) may appear anywhere
    // in the audit.
    for event in &events {
        assert!(
            !event.detail.contains(&token),
            "audit event must not carry token material: {:?}",
            event
        );
    }

    server.shutdown();
}

/// 32. SSE credential re-check: revoking the credential mid-stream
///     terminates the stream with a `credential_revoked` error frame before
///     the terminal event (§10: "SSE/WebSocket повторно проверяет срок
///     действия/revocation credential").
#[test]
fn stream_terminates_on_credential_revocation() {
    let mut server = TestServer::spawn_with_config_and_seed(
        RemoteAdapterConfig {
            auth: Some(AuthConfig { max_credentials: 4 }),
            ..default_config()
        },
        |tx| seed_chat(tx, &rid(3200), &rid(3201)),
    );
    let adapter = server.adapter.as_ref().expect("adapter present");
    let (credential_id, token) = pair_token(adapter);

    // A long-running stream (300 steps × 5ms ≈ 1.5s) so revocation lands
    // well before the terminal event.
    let stream_body = envelope_body(
        &rid(3202),
        "generation.start",
        json!({
            "chatId": rid(3201),
            "message": "hello",
            "model": "steps=300;delay-ms=5;tokens-per-step=1"
        }),
    );

    let mut stream = TcpStream::connect(server.addr).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");
    let mut request = format!(
        "POST /rpc/stream HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
        server.addr,
        stream_body.len()
    );
    request.push_str(&String::from_utf8_lossy(&stream_body));
    stream.write_all(request.as_bytes()).expect("write request");

    // Wait for admission (response header), then give the executor a moment
    // to emit its first deltas before we revoke.
    let mut head_buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut stalls = 0u32;
    let admitted = loop {
        if let Some(separator) = find_subslice(&head_buf, b"\r\n\r\n") {
            break String::from_utf8_lossy(&head_buf[..separator])
                .to_ascii_lowercase()
                .contains(" 200 ");
        }
        match stream.read(&mut chunk) {
            Ok(0) => break false,
            Ok(n) => {
                head_buf.extend_from_slice(&chunk[..n]);
                stalls = 0;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                stalls += 1;
                if stalls > 50 {
                    break false;
                }
            }
            Err(_) => break false,
        }
    };
    assert!(admitted, "stream admitted before revocation");
    std::thread::sleep(Duration::from_millis(300));

    // Revoke mid-stream: the next poll batch must terminate the stream.
    assert!(
        adapter.revoke(&credential_id),
        "credential revoked mid-stream"
    );

    // Drain to EOF and assert the termination sequence.
    let raw = read_response(&mut stream).expect("stream closes after revocation");
    let body = String::from_utf8_lossy(&raw);
    assert!(
        body.contains("credential_revoked"),
        "revoked stream carries the credential_revoked error frame"
    );
    assert!(
        body.contains("stream.closed"),
        "revoked stream terminates with stream.closed"
    );
    assert!(
        !body.contains("generation.completed"),
        "stream must terminate before the run completes"
    );
    // The error frame precedes the terminal frame.
    let error_at = body
        .find("credential_revoked")
        .expect("error frame present");
    let closed_at = body.find("stream.closed").expect("terminal frame present");
    assert!(error_at < closed_at, "error frame precedes stream.closed");

    server.shutdown();
}

/// 33. CORS deny-by-default: with an empty origin allowlist every request
///     carrying an `Origin` header is rejected 403 `ORIGIN_NOT_ALLOWED`
///     (preflight included) and no `Access-Control-*` header is emitted
///     (§10: "CORS/Origin policy deny-by-default").
#[test]
fn cors_denies_every_origin_by_default() {
    let mut server = TestServer::spawn_with(default_config());
    let adapter = server.adapter.as_ref().expect("adapter present");

    // An actual request (even a public /meta GET) with a browser Origin.
    let denied = http_request(
        server.addr,
        "GET",
        "/meta",
        &[("Origin", "https://evil.example")],
        &[],
    );
    assert_eq!(
        denied.status, 403,
        "browser-originated /meta denied by default"
    );
    assert!(String::from_utf8_lossy(&denied.body).contains("ORIGIN_NOT_ALLOWED"));
    assert!(
        !denied
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("Access-Control-Allow-Origin")),
        "no CORS headers for a disallowed origin"
    );

    // A preflight OPTIONS with an Origin is denied the same way.
    let preflight = http_request(
        server.addr,
        "OPTIONS",
        "/rpc",
        &[("Origin", "https://evil.example")],
        &[],
    );
    assert_eq!(preflight.status, 403, "preflight denied by default");
    assert!(!preflight
        .headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("Access-Control-Allow-Origin")));

    // No-Origin clients (CLI/SDK) keep working untouched.
    let meta = http_request(server.addr, "GET", "/meta", &[], &[]);
    assert_eq!(meta.status, 200, "no-Origin client unaffected");

    // The denial is audited without secret material.
    assert!(
        adapter
            .audit_events()
            .iter()
            .any(|event| event.kind == AuditKind::OriginDenied),
        "origin denial recorded in the audit"
    );

    server.shutdown();
}

/// 33b. Opaque `Origin: null` (packaged Android WebView / file:) is still
///      denied on an open loopback adapter, and admitted only when the
///      pairing gate is configured — the bearer is then the CSRF control.
#[test]
fn cors_admits_opaque_null_origin_only_when_auth_is_on() {
    let mut open = TestServer::spawn_with(default_config());
    let denied = http_request(open.addr, "GET", "/meta", &[("Origin", "null")], &[]);
    assert_eq!(
        denied.status, 403,
        "Origin null stays denied without pairing"
    );
    open.shutdown();

    let mut gated = TestServer::spawn_with(RemoteAdapterConfig {
        auth: Some(AuthConfig { max_credentials: 4 }),
        ..default_config()
    });
    let allowed = http_request(gated.addr, "GET", "/meta", &[("Origin", "null")], &[]);
    assert_eq!(
        allowed.status, 200,
        "opaque origin admitted when pairing is on"
    );
    assert!(
        allowed
            .headers
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("Access-Control-Allow-Origin")
                && value == "null"),
        "CORS allow-origin echoes the opaque origin"
    );
    gated.shutdown();
}

/// 34. CORS with an explicit allowlist: preflight answers 204 + the CORS
///     headers, allowed actual requests carry `Access-Control-Allow-Origin`,
///     and any other origin is still 403.
#[test]
fn cors_allowlist_serves_only_configured_origins() {
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        allowed_origins: vec!["https://app.example".to_string()],
        ..default_config()
    });

    // Preflight from the allowed origin.
    let preflight = http_request(
        server.addr,
        "OPTIONS",
        "/rpc",
        &[
            ("Origin", "https://app.example"),
            ("Access-Control-Request-Method", "POST"),
        ],
        &[],
    );
    assert_eq!(preflight.status, 204, "allowed preflight answers 204");
    let header_of = |name: &str| {
        preflight
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(
        header_of("access-control-allow-origin"),
        Some("https://app.example")
    );
    assert_eq!(
        header_of("access-control-allow-methods"),
        Some("GET, POST, OPTIONS")
    );
    assert_eq!(
        header_of("access-control-allow-headers"),
        Some("Authorization, Content-Type, Last-Event-ID")
    );
    assert_eq!(
        header_of("access-control-allow-private-network"),
        Some("true")
    );
    assert_eq!(header_of("vary"), Some("Origin"));

    // An actual request from the allowed origin carries the CORS headers.
    let body = envelope_body(&rid(3401), "meta.get", json!({}));
    let admitted = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("Origin", "https://app.example")],
        &body,
    );
    assert_eq!(admitted.status, 200, "allowed origin dispatches");
    assert_eq!(
        admitted
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("access-control-allow-origin"))
            .map(|(_, value)| value.as_str()),
        Some("https://app.example")
    );
    assert!(admitted
        .headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("vary")));
    let (request_id, _) = expect_ok(decode_envelope(&admitted.body));
    assert_eq!(request_id, rid(3401));

    // A different origin is still denied on every route.
    let foreign = http_request(
        server.addr,
        "GET",
        "/meta",
        &[("Origin", "https://other.example")],
        &[],
    );
    assert_eq!(foreign.status, 403, "unlisted origin denied even on /meta");
    assert!(!foreign
        .headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("Access-Control-Allow-Origin")));

    server.shutdown();
}

/// 35. Forwarded headers are honored only from configured trusted proxies
///     (§10: "forwarded client/proto headers принимаются только от
///     configured proxy addresses"): behind a trusted proxy the rate-limit
///     bucket keys by the `X-Forwarded-For` client IP; from any other peer
///     the header is ignored (a client cannot self-spoof the bucket key).
#[test]
fn forwarded_headers_honored_only_from_trusted_proxies() {
    // Server trusting the loopback peer: X-Forwarded-For decides the bucket.
    let mut server = TestServer::spawn_with(RemoteAdapterConfig {
        rate_limit: Some(RateLimitConfig {
            requests_per_second: 1,
            burst: 3,
            max_clients: 16,
        }),
        trusted_proxies: vec!["127.0.0.1".parse().expect("loopback parses")],
        ..default_config()
    });

    let body = envelope_body(&rid(3501), "meta.get", json!({}));
    for _ in 0..3 {
        let response = http_request(
            server.addr,
            "POST",
            "/rpc",
            &[("X-Forwarded-For", "198.51.100.7")],
            &body,
        );
        assert_eq!(
            response.status, 200,
            "burst admitted for the forwarded client"
        );
    }
    let limited = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("X-Forwarded-For", "198.51.100.7")],
        &body,
    );
    assert_eq!(limited.status, 429, "forwarded client's bucket exhausted");

    // A different forwarded client has its own bucket.
    let other = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("X-Forwarded-For", "198.51.100.8")],
        &body,
    );
    assert_eq!(other.status, 200, "per-forwarded-client buckets");

    // Garbage forwarded value falls back to the peer bucket (fresh key).
    let garbage = http_request(
        server.addr,
        "POST",
        "/rpc",
        &[("X-Forwarded-For", "not-an-ip")],
        &body,
    );
    assert_eq!(
        garbage.status, 200,
        "garbage forwarded value ignored safely"
    );
    server.shutdown();

    // Control: WITHOUT a trusted proxy the header is ignored — every request
    // (different forwarded values included) shares the peer's bucket.
    let mut control = TestServer::spawn_with(RemoteAdapterConfig {
        rate_limit: Some(RateLimitConfig {
            requests_per_second: 1,
            burst: 3,
            max_clients: 16,
        }),
        ..default_config()
    });
    for n in 0..3 {
        let response = http_request(
            control.addr,
            "POST",
            "/rpc",
            &[("X-Forwarded-For", &format!("198.51.100.{n}"))],
            &body,
        );
        assert_eq!(response.status, 200, "untrusted peer: request {n} admitted");
    }
    let spoofed = http_request(
        control.addr,
        "POST",
        "/rpc",
        &[("X-Forwarded-For", "198.51.100.99")],
        &body,
    );
    assert_eq!(
        spoofed.status, 429,
        "untrusted peer cannot rotate the forwarded header past the peer bucket"
    );
    control.shutdown();
}
