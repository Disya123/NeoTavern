# neotavern-headless

Headless host for the Runtime Kernel (ТЗ §11.3): a composition root that
opens a canonical data-root, wires an explicit SecretStore backend, and binds
the existing [`remote-http-adapter`](../remote-http) — the adapter stays a
library; this crate is the long-running server the Web Client talks to.

The host owns no product database and no domain rules. Every `/rpc` request
is the frozen Product Wire envelope dispatched to the SAME
`runtime_kernel::Kernel` instance local IPC and the CLI use (one writer
coordinator, ТЗ §22).

## Purpose

- **Thin host.** `Kernel::open` + `RemoteAdapter::start`. No second schema,
  no Fastify, no in-process product logic.
- **Loopback by default.** `127.0.0.1:8080`. A non-loopback bind is a
  startup error unless `--remote-exposure` (`NEOTA_REMOTE_EXPOSURE=1`) opts
  in; a public bind still requires `--auth` (adapter
  `PublicBindRequiresAuth`, ТЗ §10 / §11.3.1).
- **Documented secret policy.** Default `env` (`NEOTA_SECRET_*`, read-only).
  `session` (process memory) and `unavailable` (fail-closed) are explicit
  `--secret-backend` choices. There is never a plaintext fallback (SEC-01).

## Usage

```text
neotavern-headless --root <data-root> [options]
```

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--root` / `NEOTA_DATA_ROOT` | required | Canonical data-root (exclusive lease). |
| `--bind` / `NEOTA_BIND` | `127.0.0.1:8080` | Listen address. Tests use `127.0.0.1:0`. |
| `--remote-exposure` / `NEOTA_REMOTE_EXPOSURE=1` | off | Allow a non-loopback bind (`trusted_proxy`). |
| `--auth` / `NEOTA_HEADLESS_AUTH=1` | off on loopback | Pairing gate on `/rpc` and `/rpc/stream`. Required for a public bind. Prints `credential-id` and `token` once on stderr. |
| `--allowed-origin` / `NEOTA_ALLOWED_ORIGINS` | empty (deny-by-default) | CORS exact-match allowlist (repeatable flag; comma-separated env). |
| `--secret-backend` / `NEOTA_SECRET_BACKEND` | `env` | `env` \| `session` \| `unavailable`. |

CLI flags override env. Stdout is a single `listening <ip:port>` line; the
process then waits for **stdin EOF** and drains in-flight HTTP (exit 0).
Ctrl+C kills the process — durable generation runs recover on the next open
(ТЗ §8.3 interrupted / recoverable terminal). Tokens never go to stdout,
logs, or the product database.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | `--help`, or a clean drain after stdin EOF. |
| `1` | Kernel open / bind / pairing / shutdown failure (diagnostic on stderr). |
| `2` | Usage error. |

## Tests

```sh
cargo test --manifest-path crates/Cargo.toml -p neotavern-headless
```

Library tests cover argument/env parsing (empty env snapshot so host
`NEOTA_*` cannot leak in). The integration suite spawns the real binary:
loopback `/meta`, character create/get over `/rpc`, `InsecureBind` and
`PublicBindRequiresAuth` before any public listener, the auth gate
(401 then bootstrap token), `--help` and missing `--root`.

## Constraints

- Do not add a second SQLite connection or product DTO in this crate.
- Do not log secret values or pairing tokens (stderr bootstrap token is
  the one-time pairing surface, matching Desktop Remote Access).
- TLS termination is an operator/proxy concern in front of
  `--remote-exposure`; this host speaks plaintext HTTP on the bound socket
  (ADR-0030).
