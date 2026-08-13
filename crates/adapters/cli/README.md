# neotavern-cli

CLI transport for the Runtime Kernel (ТЗ §6.3, Phase 4 CLI hooks): maps **one**
wire request envelope → **one** wire response envelope through the SAME
`runtime_kernel::Kernel` instance the local IPC and HTTP/SSE adapters use.

## Purpose

- **Thin transport.** The CLI owns no storage and no product rules: the
  request is decoded with the generated contract decoder, checked against the
  embedded wire protocol (`major` equality + `minor` ≤ server), and dispatched
  to the kernel; the response is a validated `wire.response.envelope` —
  byte-identical to what the `remote-http-adapter` answers (it reuses the
  adapter's shared envelope layer, so transports cannot drift, §6.3).
- **One writer.** With `--root`, the CLI acquires the exclusive data-root
  lease for its run and releases it on exit — a second writable kernel on the
  same root is refused with a controlled `DATA_ROOT_IN_USE` envelope (§22).
- **No panics on payload.** Every payload-driven failure maps to a controlled
  error envelope or a stderr diagnostic; `unwrap`/`expect` appear only on
  program-internal invariants (ТЗ §87).

## Usage

```text
neotavern-cli --root <data-root> --operation <operationId> '<payload JSON>' [--request-id <uuid>]
neotavern-cli --root <data-root> --envelope            # full request envelope JSON from stdin
neotavern-cli --help
```

Without `--root` the kernel is stateless: `meta.get` works, storage
operations answer a controlled error envelope.

`--operation` builds the request envelope with the embedded protocol
(`wireProtocol` + `schemaHash` from the contract manifest) and a generated
v4 request id (the frozen wire `uuid` format accepts version nibbles 1–5,
not RFC 9562 v7 — see `crates/runtime-kernel/src/product.rs`).
`--envelope` takes the full envelope JSON on stdin (bounded to 1 MiB, §10)
and echoes the request id verbatim — the same semantics a remote client sends
over HTTP.

## Exit codes (stable contract)

| Code | Meaning |
|---|---|
| `0` | Response envelope with `kind: ok` (printed to stdout). |
| `1` | Response envelope with `kind: error` (product/contract error, printed to stdout), OR a transport failure before any envelope existed (diagnostic on stderr, stdout empty). |
| `2` | Usage error (bad arguments). |

Examples:

```sh
# Health check: compatible kernel answers ok (exit 0).
neotavern-cli --operation meta.get '{}'

# Create a character over a data root and read it back.
neotavern-cli --root ~/.neotavern/data --operation characters.create '{"name":"Ada"}'
neotavern-cli --root ~/.neotavern/data --operation characters.get '{"characterId":"<id>"}'

# Script a full envelope (protocol + hash + request id) through stdin.
echo '{"wireProtocol":{"major":1,"minor":0},"schemaHash":"...","requestId":"00000000-0000-4000-8000-000000000001","operationId":"meta.get","payload":{}}' \
  | neotavern-cli --envelope
```

## Tests

```sh
cargo test -p neotavern-cli
```

`tests/cli.rs` spawns the real built binary as a child process and asserts on
exit codes + stdout envelopes through the generated decoders: meta via
`--operation` and via `--envelope` (request id echoed), character
create/get round-trip over a data root, schema-violation → `CONTRACT_VIOLATION`,
unknown operation → `NOT_FOUND`, protocol major mismatch →
`PROTOCOL_MISMATCH`, held data-root lease → `DATA_ROOT_IN_USE`, usage errors
(exit 2), malformed stdin (exit 1, empty stdout) and the 1 MiB stdin bound —
10 scenarios.
