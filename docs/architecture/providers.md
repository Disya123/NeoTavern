# Providers (ТЗ §55–§56, Фаза 7)

> **Status.** Phase 7 + Этап 2.5 implemented: portable provider contract
> (`crates/provider-sdk`), built-in adapters (`crates/built-in-providers`),
> provider configuration storage (migration 4), kernel executor seam with
> deadline/cancellation, the conformance suite, and the **production
> OpenAI-compatible adapter** (`crates/provider-openai-compat`) with
> secret-out-of-DB execution (ТЗ §9.3/§9.4).

A **provider** executes one generation attempt: it turns a sanitized request
into a bounded stream of text deltas plus normalized usage, or a typed error.
Everything the kernel executes for local generation goes through the
`ProviderAdapter` contract — the kernel knows no vendor types (§55).

## Crates

| Crate                           | Role                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/provider-sdk`           | Portable adapter contract: `ProviderAdapter`, `ProviderError`, `EmitStatus`, `CancelToken`, deadline/`RetryPolicy`/`Usage`, secret seams (`SecretRef`/`SecretValue`/`SecretResolver`). std-only, no async. |
| `crates/built-in-providers`     | Built-in adapters: `FakeProvider` (deterministic, fault-injectable) and `RecordedProvider` (JSON script replay) + conformance suite + fixtures.                                                            |
| `crates/provider-openai-compat` | Production OpenAI-compatible adapter (Этап 2.5): chat-completions streaming over a minimal blocking HTTP/1.1 client with rustls TLS (OS trust store), bounded SSE reads (SEC-04), normalized errors.       |

## The adapter contract

```rust
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &str;            // wire `provider` field
    fn name(&self) -> &str;
    fn builtin(&self) -> bool;
    fn models(&self) -> Vec<ProviderModel>;
    fn availability(&self) -> Availability;      // §60, side-effect-free
    fn generate(
        &self,
        request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError>;
}
```

Guarantees an adapter must uphold:

- **One billable attempt per `generate` call.** No internal retry loop; a
  repeat is a new user-visible `generation.retry` attempt (§55, §87). The
  conformance suite proves this with a call counter.
- **Cooperative cancellation.** Adapters check `CancelToken` and the request
  `Deadline` between work units. `EmitStatus::Stop` from the executor means
  the run was cancelled — the adapter stops immediately; late output never
  reaches the chat (§63).
- **Normalized errors.** `ProviderError { code, message, params, retryable }`
  with stable codes `timeout | cancelled | unavailable | request-invalid |
step-failed | network-fault`. `params` never contain secrets, raw user
  content or vendor payloads (§85).
- **No vendor leakage.** Vendor types/payloads stay inside the adapter.

The kernel maps provider errors to product codes: `step-failed` →
`PROVIDER_STEP_FAILED`, `timeout` → `PROVIDER_TIMEOUT`, `network-fault` →
`PROVIDER_NETWORK_FAULT`, `unavailable` → `PROVIDER_UNAVAILABLE`,
`request-invalid` → `PROVIDER_MODEL_INVALID`; `cancelled` becomes the run's
`cancelled` terminal state.

## Built-in adapters

### FakeProvider

Deterministic, fault-injectable provider used by the durability tests and as
the default when no provider is configured. Model string grammar
(`;`-separated, all optional):

| Key               | Default | Range   | Meaning                               |
| ----------------- | ------- | ------- | ------------------------------------- |
| `steps`           | 8       | 1–64    | delta steps                           |
| `fail-at`         | –       | 1–steps | `StepFailed` before step N            |
| `delay-ms`        | 0       | 0–200   | sleep per step (cancel/timeout tests) |
| `tokens-per-step` | 6       | 1–256   | delta text length                     |

Delta text for step `i` derives from `sha256("{chat_id}|{attempt}|{i}")`
(first 8 hex chars) — same request ⇒ byte-identical streams across processes
(Local/Remote equivalence, §78 Фаза 6 exit gate). One model is exposed:
`fake-1` (context limit 8192).

### RecordedProvider

Replays a JSON `RecordedScript` (`delta` / `sleep` / `fail` steps) selected by
the `model` field — recorded non-secret fixtures for conformance and future
regression (§78 Фаза 7 deliverable). Fixtures live in
`crates/built-in-providers/fixtures/`.

## Configuration and secrets (§55, §68)

Migration 4 adds `provider_configs`:

```sql
provider_configs (
  id PK, provider, name, config_json DEFAULT '{}', secret_ref,
  created_at, updated_at, UNIQUE (provider, name)
)
```

- Non-secret settings live in `config_json`; secrets live **only** as
  `secret_ref` references. The value never enters the DB, request snapshots,
  backups, logs or diagnostics.
- Resolution goes through the host-provided `SecretResolver` seam
  (`Kernel::set_secret_resolver`): OS keychain on Desktop, Keystore on
  Android, restricted file/env on Headless. `SecretValue` is an opaque box
  whose `Debug` prints `<redacted>`.
- Unavailable/locked secure storage yields a typed `unavailable` error —
  plaintext fallback is forbidden (§87).

## OpenAI-compatible provider (Этап 2.5)

`crates/provider-openai-compat` implements the contract against the OpenAI
**chat completions streaming** protocol (`POST {baseUrl}/chat/completions`,
SSE `data:` frames) — OpenAI and any OpenAI-compatible endpoint (vLLM,
llama.cpp, LocalAI, gateways). It is a production adapter: not a built-in of
the kernel registry, but built from a stored `provider_configs` row and
registered at runtime:

```rust
let adapter = OpenAICompatProvider::from_config("openai", &config_dto["config"])?;
kernel.register_provider(Arc::new(adapter));   // Command::RegisterProvider
```

Non-secret `config_json` keys: `baseUrl` (required), `models[]`
(`id`/`name`/`contextLimit`/`maxOutputTokens`; empty → one default model),
`timeoutMs`, `maxResponseBytes` (SEC-04 body budget, default 16 MiB),
`organization`, `maxTokens`.

Secret handling at execution time (§9.4):

1. the executor reads the first `provider_configs` row for the run's provider
   (alphabetically by `name`) and takes its `secret_ref`;
2. the kernel resolves it through the host `SecretResolver` seam just before
   `generate` and hands the value via `ProviderRequest.api_key`;
3. the adapter uses it only for the `Authorization: Bearer …` header and
   drops it afterwards — it never appears in the request body, errors, logs,
   snapshots or the database;
4. no config/secret → `Ok(None)` and the adapter fails with
   `request-invalid` (`PROVIDER_MODEL_INVALID`); a `secret_ref` without a
   resolver seam → fail-closed `unavailable` (`PROVIDER_UNAVAILABLE`).

Transport: a minimal blocking HTTP/1.1 client over `std::net::TcpStream`
(no async runtime; the kernel is a synchronous single-writer process) with
rustls TLS verified against the **OS trust store**
(`rustls-platform-verifier` — no bundled root bundle). Bounded reads:
response body capped at `maxResponseBytes`, connection destroyed immediately
on breach; cancellation and the per-run deadline are re-checked between every
chunk. HTTP statuses (401/403 → `unavailable`, 4xx → `request-invalid`,
429/5xx → `step-failed` retryable) and SSE `error` events normalize to
`ProviderError`; the key and raw payloads never appear in errors.

Tests (`crates/provider-openai-compat`, 12 unit tests) run against a raw-TCP
mock of an OpenAI-compatible endpoint (chunked/content-length SSE, HTTP
errors, slow streams for cancel/deadline, byte budget, key-not-in-body);
`crates/runtime-kernel/tests/providers_openai.rs` (3 tests) proves the whole
kernel path: `providers.config.set` (key → SecretStore) → register →
`providers.list` → `generation.start` streams deltas and saves the assistant
message durably, with the resolved key on the wire and no plaintext in
`database.sqlite`.

Tool-call/reasoning events and config-instance selection in the run model
arrive with the generation run/step slice (Этап 2.7).

## Availability (§60)

`providers.list` (wire op, `app.read`) reports every registered adapter as
`wire.provider.dto`: id/name/builtin plus the discriminated availability
union (`available` | `degraded{code,detail?}` | `unavailable{code,detail?}`)
and the model list. Availability probes are cheap and side-effect-free.

## Execution path

```text
generation.start/retry (durable run, sanitized snapshot)
        ↓ writer-coordinator thread
resolve adapter by run.provider (default "fake")
        ↓
adapter.generate(ProviderRequest{provider_id, model, input, run_key, deadline, api_key?})
        ↓ emit(ProviderEvent::Delta) per step
executor commits delta event + CAS run update (+ checkpoint every 4th)
        ↓
atomic terminal commit (final message + terminal event)
```

The per-run deadline is enforced inside the adapter (`Deadline`); the
cancellation token is the same flag the `generation.cancel` operation sets.
Usage accounting (`Usage{steps, output_chars}`) is normalized at the adapter
boundary.

## Conformance suite

`crates/built-in-providers/tests/conformance.rs` applies one battery to every
adapter: usage accounting, cancel mid-stream, timeout, fault injection,
`Stop`-on-first-emit, determinism, secret-redaction absence, side-effect-free
availability, and the one-attempt-per-call counter. New adapters must pass
the same battery (§83 Provider SDK).

## Related documents

- [Generation durability](generation-durability.md) — the durable workflow the
  executor drives.
- [Wire contracts](wire-contracts.md) — `providers.list` and provider DTOs.
- [Runtime Kernel README](../../crates/runtime-kernel/README.md) — provider
  registry seam.
