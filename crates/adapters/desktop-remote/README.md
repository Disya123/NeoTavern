# neotavern-desktop-remote

Optional **Desktop Remote Access** host service (Phase 9, ТЗ §10): a thin,
host-owned wrapper around the hardened Phase 4
[`remote-http-adapter`](../remote-http) that exposes the desktop app's
in-process [`runtime-kernel`](../../runtime-kernel) over HTTP/SSE.

The service owns no product state and no kernel. `start` hands the SAME
`Arc<Mutex<Kernel>>` the local Tauri host uses to the remote adapter, so the
kernel mutex stays the single writer: concurrent local IPC and remote HTTP
operations share one transaction coordinator. Turning Remote Access off (the
default) means the desktop process owns no listener at all.

## Service contract

```rust
RemoteAccessService::new(config_file: PathBuf) -> Self   // load config
config()  -> RemoteAccessConfig                           // current config
set_config(cfg) -> Result<(), ServiceError>               // MustStopFirst while running
persist() -> Result<(), ServiceError>                     // atomic temp+rename
status()  -> ServiceStatus                                // diagnostics snapshot
start(kernel: Arc<Mutex<Kernel>>) -> Result<SocketAddr, ServiceError>  // idempotent
stop()    -> Result<(), ServiceError>                     // idempotent
pair(label: Option<String>) -> Result<(String, String), ServiceError>   // (id, token)
revoke(id: &str) -> Result<bool, ServiceError>
```

`ServiceStatus` carries `running`, `addr: Option<SocketAddr>`, `streams`,
`credentials: Vec<CredentialInfoDto>` (id / label / revoked /
created_at_unix_millis — never token material), `audit_events: usize` (count),
`auth_enabled` and `last_error: Option<String>`.

`ServiceError` variants are stable: `InsecureBind`, `AuthDisabled`,
`NotRunning`, `MustStopFirst`, `ConfigIo(String)`, `Start(String)`,
`Internal(String)`.

## Config file

The service reads/writes `remote-access.json` in the Tauri app-config
directory (host-owned, NOT the kernel data root). All methods take `&self` so
the service works as Tauri managed state.

```json
{
  "bind": "127.0.0.1",
  "port": 0,
  "trusted_proxy": false,
  "auth_enabled": true,
  "allowed_origins": [],
  "max_streams": 8
}
```

- `bind`/`port`: listener address; `port: 0` = ephemeral (resolved in
  `status().addr`).
- `trusted_proxy`: opt-in for a non-loopback bind; off by default.
- `auth_enabled`: pairing gate; on by default.
- `allowed_origins`: CORS allowlist, deny-by-default when empty.
- `max_streams`: concurrent SSE stream cap (bounded streams).

Every field carries `#[serde(default)]`, so missing/partial/older config
files degrade field-by-field. A corrupt file loads defaults AND records the
failure in `status().last_error`. The file is written atomically (temp +
rename in the same directory); parent dirs are created lazily on save.
The pairing store is in-memory (the adapter owns no durable credentials), so
credentials are re-paired per session.

## Security posture

- **Off by default** — no listener until `start`.
- **Loopback by default** — `127.0.0.1`, ephemeral port.
- **Public binds gated** — a non-loopback bind fails with `InsecureBind`
  before any listener exists unless `trusted_proxy` is set; a public bind
  also requires auth (enforced inside the adapter).
- **Auth on by default** — every `/rpc` and `/rpc/stream` call needs a
  scoped bearer token issued by `pair`; the adapter stores only SHA-256
  verifiers, tokens are never logged, `revoke` stops new calls and
  terminates long-lived streams.
- **Bounded** — credential store capped at 16, streams capped by
  `max_streams`, audit log bounded at 256 events, 1 MiB request cap,
  64 worker connections, 5s drain.

## Lifecycle

`new` → `set_config` (only while stopped) → `start` (idempotent) →
`pair`/`revoke` → `stop` (idempotent). `start` → `stop` → `start` cycles
cleanly; the adapter holds no durable state, so restart does not disturb the
kernel.

## Tests

```sh
cargo test -p neotavern-desktop-remote
cargo clippy -p neotavern-desktop-remote --all-targets -- -D warnings
cargo fmt -p neotavern-desktop-remote
```

Tests drive a real stateless kernel (`data_root: None`, schema hash + FFI ABI
version from the embedded manifest) and a std-only `TcpStream` HTTP client
mirroring the remote-http adapter's test helper. The concurrent test calls
the kernel directly through the same dispatch path the tauri-local host uses
(`kernel.lock().dispatch("meta.get", b"{}", &CancellationFlag::new())`) while
the remote HTTP path hits `/rpc` with a paired token.
