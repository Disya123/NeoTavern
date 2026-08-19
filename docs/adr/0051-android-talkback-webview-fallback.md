# ADR-0051: Defer native Dioxus TalkBack; product a11y is WebView fallback

Date: 2026-08-19. Status: **Accepted**.
Related: [RFC §51](../rfc/neoui-v4-android-presentation-backend.md),
[presentation-boundary.md](../architecture/presentation-boundary.md),
[presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md),
[ADR-0049](0049-track-d-dioxus-presentation.md).

## Context

The Milestone C debug harness journey batch on Xiaomi `8f5c2b7c` is **PASS**
for core chat (send round-trip, isolated 10k, Gboard typing/insets/editor-send,
lifecycle, safe mode). TalkBack was operator-waived:
`talkback_journey = SKIPPED`.

RFC §51 Exit still lists a TalkBack corpus. Treating `SKIPPED` as that Exit
item would ship TalkBack users into an unsupported Dioxus/Rust renderer.

Native TalkBack on the Dioxus path is not being implemented in this slice.

## Decision

1. **`talkback_journey = SKIPPED` is not RFC §51 satisfaction.** Core chat
   journey batch PASS does not close Milestone C and does not claim native
   TalkBack parity.
2. **Dioxus native TalkBack = `DEFERRED_BY_OWNER`.** No native TalkBack
   journey is required to start a guarded canary.
3. **Product accessibility path = `WEBVIEW_FALLBACK`.**

```text
TalkBack / touch exploration enabled → WebView rollback
TalkBack disabled + qualified device + canary flag → Dioxus/Rust
```

The selector MUST run **before** creating a Rust presentation host
(`System.loadLibrary` / JNI open). Touch exploration must never initialize
the Dioxus host.

4. **Gboard evidence is split.**
   - Physical Gboard typing, insets, and editor-send: harness **PASS**.
   - IME composition/cursor/delete APIs: deterministic MockIme /
     InputConnection conformance. A Gboard layout MAY send only
     `commitText` and is not required to call `setComposingText`.

## Alternatives

1. **Block canary until native TalkBack PASS.** Rejected: operator waived
   TalkBack; blocking would freeze the Rust chat path for an unimplemented
   a11y renderer.
2. **Ship Dioxus to TalkBack users anyway.** Rejected: unsupported renderer.
3. **Require `setComposingText` from physical Gboard.** Rejected: layout-
   specific; Alphabet/Russian Gboard on the admission device commits letters.

## Consequences

- Milestone C stays **STARTED**. Cutover is **STARTED / CANARY** once the
  guarded `MainActivity` selector lands; the physical canary batch stays
  **NOT_RUN** until a later Xiaomi pass.
- Compatibility matrix records `DEFERRED_BY_OWNER` and
  `WEBVIEW_FALLBACK`; neither is owner-signed PARITY.
- Canary physical batch MUST include an accessibility fallback case:
  touch exploration on → WebView, Rust host not created.
- WebView remains in the production APK.
