---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/presentation-compatibility-matrix.md
---

# PresentationCompatibilityMatrix (baseline)

**Status:** baseline after D1/D2 GO. Milestone A is **PASS** (flagged
Dioxus Product Wire shell, not cutover). Milestone B is **PASS**
(independent physical PERF/device-loss registry). Not a product cutover.
Owners have not signed PARITY for Android native UI.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §2.4  
**Boundary:** [presentation-boundary.md](../architecture/presentation-boundary.md)  
**D3:** **DEFERRED**

Allowed statuses: `PARITY` | `ADAPTED` | `CONTAINED` | `DEFERRED` | `REMOVED`.

| Capability                             | React / Web                 | Android WebView (rollback) | Android Dioxus/NeoCompositor | Notes                                                           |
| -------------------------------------- | --------------------------- | -------------------------- | ---------------------------- | --------------------------------------------------------------- |
| Product Wire durable state             | PARITY                      | PARITY                     | PARITY (same Kernel)         | Presentation never owns SQLite                                  |
| Chat workspace as main screen          | PARITY                      | PARITY                     | DEFERRED (Milestone C)       | Live Product Wire route in `presentation-chat`; debug harness `PresentationChatActivity`; not PARITY; not launcher; not cutover |
| Live backdrop glass                    | CONTAINED (CSS)             | CONTAINED (CSS)            | DEFERRED (Milestone B/C)     | GateP:P1 on qualified devices; compositor not in production APK |
| Theme SDK (CSS tokens / shells)        | PARITY                      | PARITY                     | DEFERRED                     | Native theme ABI not chosen                                     |
| Plugin frontend slots / DOM islands    | PARITY                      | PARITY                     | CONTAINED (WebSurface later) | No silent Plugin SDK rewrite                                    |
| Legacy `window.SillyTavern`            | CONTAINED                   | CONTAINED                  | DEFERRED                     | Unmanaged islands stay Web                                      |
| i18n catalogs / RTL                    | PARITY                      | PARITY                     | DEFERRED                     | Same catalogs when native UI exists                             |
| Accessibility (WCAG 2.2 AA / TalkBack) | PARITY (web)                | PARITY (WebView)           | DEFERRED (Milestone C)       | Dioxus tree has TalkBack roles/order; not owner-signed PARITY               |
| Generation streaming / backpressure    | PARITY                      | PARITY                     | PARITY (Wire events)         | Kernel-owned                                                    |
| Deep links / HostConnect               | PARITY                      | PARITY                     | DEFERRED                     |                                                                 |
| Gboard / IME composer                  | n/a (web)                   | PARITY (WebView)           | DEFERRED (Milestone C)       | Debug harness EditText + IME inset; not owner-signed PARITY     |
| 10k message virtualization             | PARITY (web virt)           | PARITY                     | DEFERRED (Milestone C)       | `chat-viewport` visible window on live Wire pages; not PARITY   |
| Safe mode (disable 3p theme/plugin)    | PARITY                      | PARITY                     | DEFERRED (Milestone C)       | `NEOTA_SAFE_MODE=1` escapes harness to WebView `MainActivity`   |
| Production no-WebView cutover          | REMOVED from this milestone | rollback default           | DEFERRED                     | Forbidden until C DoD                                           |

Critical Android journeys stay on WebView until the DEFERRED rows are closed
with owner signatures. Estimated rows cannot be presented as PARITY.
