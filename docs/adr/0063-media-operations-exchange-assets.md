# ADR-0063 — Media operations exchange assets, never bytes

**Status:** accepted; implemented for `providers.transcribe`,
`providers.speech` and `providers.images` (rounds 52–54)
**Date:** 2026-11-04
**Supersedes:** nothing. **Related:** ADR-0061 (chunked ingestion), ADR-0038
(kernel owns product state, no second backend surface), ADR-0059 (React-primary,
remote Web Client is a product), ТЗ §5.1 (AssetStore), ТЗ §19 (provider
governor), cutover-registry row 8 tail (speech / images / transcribe).

## Context

Three provider routes are the last "missing" wire ops in the cutover registry
(row 8 tail): text-to-speech synthesis, image generation, and audio
transcription. They are not logic-starved — the legacy sidecar serves them and
the kernel has provider configs, secrets, model discovery and a connectivity
test — they are **shape**-starved:

- their request or response carries binary payloads (audio, images,
  multipart uploads) that a JSON DTO cannot hold at a useful size;
- ADR-0061 removed the excuse for the request half (callers can stage bytes and
  pass an `assetId`), but it says nothing about the response half;
- the asset plane already exists and is content-addressed (`__neotavern_assets`,
  `assets.content` with a 4 MiB response cap), so the product already has one
  honest way to move bytes toward a client.

Without a decision the row stays parked, the sidecar keeps a feature, and the
stage-6 deletion cannot proceed.

## Decision

**Media operations are ordinary wire ops whose DTOs carry asset references and
metadata, never media bytes.** Concretely:

1. **Inputs are staged assets.** Any binary input (audio to transcribe, an image
   to edit, a voice sample) enters through the ADR-0061 family
   (`assets.upload.begin|append|finish`) and is addressed by `assetId`. The
   kernel never accepts a filesystem path, a URL it must fetch, or an inline
   base64 body above the existing `assets.put` cap.

2. **Outputs are published assets.** TTS audio and generated images are written
   by the kernel into the asset plane with a dedicated kind
   (`generated-audio`, `generated-image`), and the op returns
   `{ asset: AssetDto, …metadata }` — the same shape `assets.put` returns. The
   client renders/downloads through `assets.content` (for payloads within the
   4 MiB response cap) or a bounded range read (the `plugins.blobs.read`
   pattern, generalised as `assets.read` if a real payload needs it). No
   response DTO ever embeds a media body.

3. **Three operations, one shape:**

   | op                            | request                                                             | response                            |
   | ----------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
   | `providers.speech.synthesize` | `{ provider, model, text (≤ 8 K chars), voice?, format? }`          | `{ asset: AssetDto }`               |
   | `providers.images.generate`   | `{ provider, model, prompt, size?, count ≤ 4, inputImageAssetId? }` | `{ assets: AssetDto[] }`            |
   | `providers.transcribe`        | `{ provider, model, audioAssetId, language? }`                      | `{ text, segments? , durationMs? }` |

   All are `transactional`, `non-idempotent` (each call may cost money and
   produce different bytes), `app.write`, and return provider failures as
   `PROVIDER_*` product codes with the attempt accounting `providers.test`
   already reports. Deterministic behaviour in tests comes from the built-in
   `fake` provider, never from a mocked transport.

4. **Caps are explicit.** `text ≤ 8 KiB`, `prompt ≤ 8 KiB`, `count ≤ 4`,
   input `assetId` size ≤ the provider's documented limit and ≤ 64 MiB,
   response asset size ≤ 64 MiB. Anything above is a `VALIDATION` refusal, not
   a truncated result.

5. **Streaming is out of scope for v1.** A synthesis that produces a long
   recording is published as ONE asset; incremental playback would be a
   different op (`assets.read` ranges) and is deliberately not promised here.
   The document records this as a known limitation rather than a hidden one.

## Consequences

- Row 8 tail becomes ordinary per-route work: the transport question is
  answered, the remaining work is the provider port methods, the three handlers
  and the UI flip.
- The kernel stays the single writer of product state: generated media is
  deduplicated by content, backed up with the data root, and never lives in
  SQLite (AGENTS.md §11).
- The asset plane grows a "generated" kind, so an orphan sweep can treat
  regenerable media differently from user originals — the same distinction
  `diagnostics.cache.clear` already makes.
- The legacy `/api/v2` speech/images/transcribe routes retire with the sidecar
  at stage 6; nothing in the kernel depends on them.

## Alternatives

- **Base64 in DTOs with a raised response cap** — rejected: it moves the 1 MiB
  wall instead of removing it, inflates every response by 33 %, and the envelope
  decoder cannot stream.
- **A binary body type on Product Wire** — rejected: it would bypass the
  contract compiler, the schema gates and the generated Rust DTOs, i.e. create
  exactly the second transport ADR-0038 forbids.
- **Host-side media (Tauri/CLI command)** — rejected for the remote Web Client:
  its only channel is Product Wire, so a host-only path would make the feature
  desktop-exclusive by accident.
- **Direct provider URLs to the client** — rejected: it leaks credentials to
  the sandbox/browser and breaks the provider governor and the secret store
  model.

## Implementation note (round 52)

`providers.transcribe` is the first operation ported on this ADR and it exercises
every rule the contract needs:

- the request carries `audioAssetId` (ADR-0061 staging) plus an optional model
  override and BCP-47 hint — no bytes, no base64;
- the kernel resolves the ADDRESSED config (`config_adapter`), so endpoint, key
  and model follow that row; the model is never guessed (request override, else
  the config's model, else `PROVIDER_MODEL_REQUIRED`);
- the staged audio is size-checked **before** the file is read
  (`AUDIO_TOO_LARGE` at 64 MiB) and the row's `size_bytes` is compared with the
  file's, so a truncated asset is a storage failure rather than a partial
  transcript;
- `ProviderAdapter::transcribe` defaults to `CAPABILITY_UNAVAILABLE`, so a
  provider that cannot transcribe refuses honestly instead of answering an empty
  text (`crates/runtime-kernel/tests/provider_media.rs` pins this with the
  `recorded` adapter);
- the result is text + the two facts a provider may report (language, duration).
  No segments: the kernel does not model subtitles and would otherwise have to
  invent them.

Speech and images reuse the exchange with the opposite direction of travel
(kernel stages the produced bytes as `generated-audio` / `generated-image` and
returns the asset id); they need the two adapters to declare the capability
before they can be claimed.

## Speech: the other direction (round 53)

`providers.speech` is the mirror image and it exercises the outbound half of the
exchange:

- text in, nothing binary in the request; `voice`/`format` are passed through as
  the caller wrote them (the kernel does not maintain a voice registry);
- the adapter returns bytes plus the content type it ACTUALLY produced, and the
  kernel stages them with `assets.publish_bytes(kind = "generated-audio",
filename = speech.<ext>)` — the extension follows the content type, not the
  requested format, so a provider that answers `audio/wav` to an `mp3` request
  is filed honestly;
- content-addressed publish means identical audio dedupes to one row (pinned by
  a test), and the response carries the asset id + content type + size, so a
  client can address the bytes without a second metadata round-trip;
- an empty body is `SPEECH_EMPTY_AUDIO` (not a zero-byte asset) and anything over
  8 MiB is `AUDIO_TOO_LARGE` — the same ceiling as the op's response budget;
- a provider without the capability answers `CAPABILITY_UNAVAILABLE` through the
  adapter default, exactly like transcription.

## Images: the same outbound half (round 54)

`providers.images` closes the row. It reuses the speech mechanism verbatim — one
asset per call, `generated-image` kind, 16 MiB cap, honest refusal when the
adapter lacks the method — and deliberately drops the legacy `n` parameter: a
batch would need partial-failure semantics the wire does not have, and a caller
that wants three images can call three times. The provider-reported
`width`/`height` are passed through as optional facts; the kernel never decodes
the image to guess them.
