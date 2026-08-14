# provider-openai-compat

Production OpenAI-compatible provider adapter for the NeoTavern Runtime Kernel
(ТЗ §9.3, Этап 2.5).

Implements the frozen [`provider_sdk::ProviderAdapter`] contract against the
OpenAI **chat completions streaming** protocol (`POST {baseUrl}/chat/completions`,
SSE `data:` frames) — works with OpenAI and any OpenAI-compatible endpoint
(vLLM, llama.cpp, LocalAI, gateways).

## What it does

- **Config-driven**: built from the non-secret `config` object stored by
  `providers.config.set` (`baseUrl`, `models`, `timeoutMs`,
  `maxResponseBytes`, `organization`, `maxTokens`).
- **Secrets stay out**: the API key is never part of the config. The kernel
  resolves the config's `secret_ref` through its SecretResolver seam at
  execution time and hands the value via `ProviderRequest::api_key` only for
  the outgoing `Authorization` header (ТЗ §9.4). The adapter never stores,
  logs, or echoes the key.
- **Blocking, no async runtime**: the kernel is a synchronous single-writer
  process; the adapter speaks plain HTTP/1.1 over `std::net::TcpStream` and
  TLS via rustls verified against the OS trust store
  (`rustls-platform-verifier` — no bundled root bundle).
- **Bounded streaming (SEC-04)**: the response body is capped at
  `maxResponseBytes`; the connection is destroyed immediately when the cap is
  exceeded. Cancellation and the per-run deadline are re-checked between
  every chunk.
- **Normalized errors**: HTTP statuses and SSE `error` events map to stable
  `provider_sdk::ProviderErrorCode`s with advisory retryable flags; the key
  and raw payloads never appear in errors.

## Usage

```rust
use provider_openai_compat::OpenAICompatProvider;
use provider_sdk::ProviderAdapter;

let provider = OpenAICompatProvider::from_config_json(
    "openai",
    r#"{"baseUrl": "https://api.openai.com/v1",
        "models": [{"id": "gpt-4o-mini", "contextLimit": 128000}]}"#,
)?;
// kernel.register_provider(Arc::new(provider));
```

## Development

```bash
cargo test -p provider-openai-compat
```

Tests run a raw TCP mock of an OpenAI-compatible endpoint (chunked SSE,
content-length, HTTP errors, slow streams for cancellation/deadline, byte
budget) — no external network required.

## Constraints

- One billable attempt per `generate` call — no internal retry (retries are
  new user-visible attempts, §55).
- Only text deltas are streamed today; tool-call/reasoning events arrive with
  the generation run/step model (Этап 2.7).
- TLS verification uses the OS trust store; a custom CA bundle is out of
  scope for the adapter.
