---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/presentation-compatibility-matrix.md
---

# PresentationCompatibilityMatrix (baseline)

**Status:** baseline after D1/D2 GO and [ADR-0051](../adr/0051-android-talkback-webview-fallback.md).
Milestone A is **PASS** (flagged Dioxus Product Wire shell, not cutover).
Milestone B is **PASS**. Milestone C core chat journey batch is **PASS**;
Milestone C remains **STARTED**. Not a product cutover. Owners have not
signed PARITY for Android native UI.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §2.4, §51  
**Boundary:** [presentation-boundary.md](../architecture/presentation-boundary.md)  
**D3:** **DEFERRED**

Allowed statuses: `PARITY` | `ADAPTED` | `CONTAINED` | `DEFERRED` |
`DEFERRED_BY_OWNER` | `WEBVIEW_FALLBACK` | `HOST_CONFORMANCE` | `REMOVED`.

| Capability                             | React / Web                 | Android WebView (rollback) | Android Dioxus/NeoCompositor | Notes                                                           |
| -------------------------------------- | --------------------------- | -------------------------- | ---------------------------- | --------------------------------------------------------------- |
| Product Wire durable state             | PARITY                      | PARITY                     | PARITY (same Kernel)         | Presentation never owns SQLite                                  |
| Chat workspace as main screen          | PARITY                      | PARITY                     | DEFERRED (Milestone C)       | Core chat journey_batch PASS (`2026-08-19T10-29-35-149Z`); not launcher; not cutover |
| Live backdrop glass                    | CONTAINED (CSS)             | CONTAINED (CSS)            | DEFERRED (Milestone B/C)     | GateP:P1 on qualified devices; compositor not in production APK |
| Theme SDK (CSS tokens / shells)        | PARITY                      | PARITY                     | DEFERRED                     | Native theme ABI not chosen                                     |
| Plugin frontend slots / DOM islands    | PARITY                      | PARITY                     | CONTAINED (WebSurface later) | No silent Plugin SDK rewrite                                    |
| Legacy `window.SillyTavern`            | CONTAINED                   | CONTAINED                  | DEFERRED                     | Unmanaged islands stay Web                                      |
| i18n catalogs / RTL                    | PARITY                      | PARITY                     | DEFERRED                     | Same catalogs when native UI exists                             |
| Dioxus native TalkBack                 | n/a                         | n/a                        | DEFERRED_BY_OWNER            | ADR-0051. Harness `SKIPPED` is not RFC §51                      |
| Product accessibility path             | PARITY                      | WEBVIEW_FALLBACK           | WEBVIEW_FALLBACK             | TalkBack/touch exploration → WebView before Rust host           |
| Accessibility (WCAG 2.2 AA / TalkBack) | PARITY (web)                | PARITY (WebView)           | DEFERRED_BY_OWNER            | Semantics PASS on harness; native TalkBack not implemented      |
| Generation streaming / backpressure    | PARITY                      | PARITY                     | PARITY (Wire events)         | Kernel-owned                                                    |
| Deep links / HostConnect               | PARITY                      | PARITY                     | DEFERRED                     | Same Kernel chat id across renderers                            |
| Gboard typing / insets / editor-send   | n/a (web)                   | PARITY (WebView)           | PASS (harness)               | Physical Gboard keys; not owner-signed PARITY                   |
| IME composition contract               | n/a (web)                   | PARITY (WebView)           | HOST_CONFORMANCE             | MockIme/InputConnection; layout may only `commitText`           |
| 10k message virtualization             | PARITY (web virt)           | PARITY                     | DEFERRED (Milestone C)       | Isolated 10k physical PASS on debug harness; not PARITY         |
| Safe mode (disable 3p theme/plugin)    | PARITY                      | PARITY                     | DEFERRED (Milestone C)       | `NEOTA_SAFE_MODE=1` → WebView `MainActivity`                    |
| Production no-WebView cutover          | REMOVED from this milestone | rollback default           | DEFERRED                     | Forbidden until C DoD; WebView stays in the APK                 |

Critical Android journeys stay on WebView until the DEFERRED rows are closed
with owner signatures. Estimated rows cannot be presented as PARITY.
`DEFERRED_BY_OWNER` is an accepted gap, not a silent PASS.
