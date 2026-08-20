# PresentationCompatibilityMatrix (migration target)

**Status:** baseline after D1/D2 GO and [ADR-0051](../adr/0051-android-talkback-webview-fallback.md),
extended by [ADR-0052](../adr/0052-webview-removal.md) (production no-WebView
cutover) and [ADR-0053](../adr/0053-android-120hz-release-budget.md) (120-Hz
release budget). Milestone A **PASS**. Milestone B **PASS**. Milestone C core
chat journey batch **PASS**; Milestone C remains **STARTED** pending owner
signatures on the `PARITY` rows below. Cutover is **STARTED / CANARY**.
Physical canary batch is **PASS** (8/8 `HOST_CANARY_PASS`); it is not
production cutover.

This document now records the **signed migration target** for the full Rust
cutover. Rows marked `PARITY (target)` are the acceptance gate of
[ADR-0052](../adr/0052-webview-removal.md): they reach owner-signed `PARITY`
only when the listed evidence is produced (device-overlay `≤1 dp` versus the
React golden, physical `canary_batch`, and — for glass/compositor — the
[ADR-0053](../adr/0053-android-120hz-release-budget.md) budget). Until then
the row keeps its prior `DEFERRED`/`CONTAINED` status and is **not** claimed
as `PARITY`.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §2.4, §51  
**Boundary:** [presentation-boundary.md](../architecture/presentation-boundary.md)  
**D3:** **DEFERRED** (Web stays React; no Web-Dioxus unification)

Allowed statuses: `PARITY` | `ADAPTED` | `CONTAINED` | `DEFERRED` |
`DEFERRED_BY_OWNER` | `WEBVIEW_FALLBACK` | `HOST_CONFORMANCE` | `REMOVED`.

**Owner list (sign-off required before cutover):**
- Product owner: `Disya123 <gamedisya@gmail.com>`
- Theme: same owner (native theme ABI not chosen; CSS tokens packed flat)
- Plugins: same owner (`CONTAINED` WebSurface only)
- i18n/RTL: same owner (same catalogs)
- Accessibility: `DEFERRED_BY_OWNER` re-confirmed via [ADR-0051](../adr/0051-android-talkback-webview-fallback.md)

| Capability                             | React / Web                 | Android WebView (fallback)  | Android Dioxus/NeoCompositor | Notes (target / evidence)                                                                 |
| -------------------------------------- | --------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Product Wire durable state             | PARITY                      | PARITY                      | PARITY (same Kernel)         | Presentation never owns SQLite                                                            |
| Chat workspace as main screen          | PARITY                      | PARITY                      | PARITY (target)              | Core chat journey_batch PASS; gated on `≤1 dp` overlay + physical `canary_batch`         |
| Live backdrop glass                    | CONTAINED (CSS)             | CONTAINED (CSS)             | PARITY (qualified) / CONTAINED (degraded) | GateP:P1; gated on [ADR-0053](../adr/0053-android-120hz-release-budget.md) budget; compositor in APK |
| Theme SDK (CSS tokens / shells)        | PARITY                      | PARITY                      | PARITY (target)              | Flat-packed `--st-*` tokens; no native theme ABI                                        |
| Plugin frontend slots / DOM islands    | PARITY                      | PARITY                      | CONTAINED (WebSurface)       | [ADR-0054](../adr/0054-plugin-visual-surface-contained.md); no silent Plugin SDK rewrite |
| Legacy `window.SillyTavern`            | CONTAINED                   | CONTAINED                   | CONTAINED (WebSurface)       | Unmanaged islands stay in `WebSurface`                                                   |
| i18n catalogs / RTL                    | PARITY                      | PARITY                      | PARITY (target)              | Same catalogs; `lang`/`dir` on Blitz root                                                |
| Dioxus native TalkBack                 | n/a                         | n/a                         | DEFERRED_BY_OWNER            | [ADR-0051](../adr/0051-android-talkback-webview-fallback.md); not RFC §51                |
| Product accessibility path             | PARITY                      | WEBVIEW_FALLBACK            | WEBVIEW_FALLBACK             | TalkBack/touch exploration → WebView before Rust host                                    |
| Accessibility (WCAG 2.2 AA / TalkBack) | PARITY (web)                | PARITY (WebView)            | DEFERRED_BY_OWNER            | Semantics PASS on harness; native TalkBack not implemented                               |
| Generation streaming / backpressure    | PARITY                      | PARITY                      | PARITY (Wire events)         | Kernel-owned                                                                             |
| Deep links / HostConnect               | PARITY                      | PARITY                      | PARITY (target)              | Same Kernel chat id; notification opens Rust host                                        |
| Gboard typing / insets / editor-send   | n/a (web)                   | PARITY (WebView)            | PARITY (target)              | Physical Gboard keys already harness PASS; owner signature pending                       |
| IME composition contract               | n/a (web)                   | PARITY (WebView)            | HOST_CONFORMANCE             | MockIme/InputConnection; layout may only `commitText`                                    |
| 10k message virtualization             | PARITY (web virt)           | PARITY                      | PARITY (target)              | Isolated 10k physical PASS on debug harness; gated on `composite_only_frames>0` re-run   |
| Safe mode (disable 3p theme/plugin)    | PARITY                      | PARITY                      | PARITY (target)              | `NEOTA_SAFE_MODE=1` → WebView `MainActivity` fallback                                     |
| Production no-WebView cutover          | REMOVED from this milestone | fallback only              | PARITY (target)              | [ADR-0052](../adr/0052-webview-removal.md); WebView removed from main-screen APK         |

Critical Android journeys reach Rust `PARITY` only when the `PARITY (target)`
rows are closed with owner signatures and `≤1 dp` evidence. Estimated rows
cannot be presented as PARITY. `DEFERRED_BY_OWNER` is an accepted gap, not a
silent PASS. `WEBVIEW_FALLBACK` remains the accessibility path until native
Dioxus TalkBack is implemented.
