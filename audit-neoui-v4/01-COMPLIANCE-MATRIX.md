# Матрица соответствия ТЗ NeoUI v4 (просто Rust)

Источник требований — корневое `Техническое задание_ NeoUI v4.md` (редакция 4.5, GateP:P1) и его каноническая копия `docs/rfc/neoui-v4-android-presentation-backend.md` rev 4.6; решения Gates — `docs/rfc/gate-p-decision-draft.md`, `docs/rfc/d1-d2-decision.md`, `docs/adr/0049-track-d-dioxus-presentation.md`, `docs/architecture/presentation-boundary.md`.

| # | Формулировка ТЗ (дословно/сжато) | Статус | Доказательство | Риск если оставить |
|---|---|---|---|---|
| 1 | **React остаётся эталоном внешнего вида и web-версией** | ✅ PASS | `packages/ui/src/styles/tokens.css`, `crates/presentation-design-system/generated/product.css` пакует `--st-*` токены, `character_card_description` зеркалит React `description \|\| "No character description yet."`. `phosphor_path` — Phosphor regular. `product_shell_title` vs React `SidebarPanelHeader`. Фикстура `packages/contracts/src/presentation/fixtures/canonical-chat.json` — React ↔ Dioxus golden parity тест в `presentation-boundary.test.ts`. | — |
| 2 | **Android WebView должен быть последовательно заменён Rust-маршрутами и в итоге удалён** | ⚠️ PARTIAL | Последовательность честная: `MainActivity` (WebView) + `PresentationChatActivity` (Rust SurfaceView) + guarded `PresentationRendererPolicy` (safeMode/killSwitch/touchExploration/deviceQualified/flag). Canary `STARTED / CANARY`, `not-yet-migrated` для rail-панелей. Но удаление — `DEFERRED` в `presentation-compatibility-matrix.md:35`, без даты/owner в roadmap. | Вечный canary; удвоенная поддержка; WebView остаётся attack surface. |
| 3 | **Не использовать React Native** | ✅ PASS | Греп по `react-native` — 0 матчей в `package.json`, `Cargo.toml`, `apps/android/*`. Dioxus/Blitz — единственный producer. | — |
| 4 | **Не подменять Rust UI нативными TextView/RecyclerView/Canvas/скрытыми WebView** | ⚠️ HACK | `PresentationChatActivity.kt:131-195` — 4 native view (`TextView`, `View`, `PresentationChatComposer:EditText`, `Button`) с `alpha=0.01f` живут рядом с `SurfaceView`. Не primary renderer, но букве противоречит. `RecyclerView`/`Canvas` — 0 использований в Rust path. `WebView` в Rust activity — 0 (проверка `hasWebView`). | Ложное срабатывание сканера «native bypass»; overdraw; скриншот-шум. |
| 5 | **Синтаксис компонентов Android — Dioxus RSX, аналогичный React** | ✅ PASS | `crates/presentation-dioxus-shell/src/product_shell.rs: rsx!{ div { data-component: "…" }}`; `product_chat_app` — `rsx!` с `style` строкой. Котлин RSX отсутствует. | — |
| 6 | **Цель present loop — настоящие 120 Hz** | ⚠️ CONDITIONAL | `MainActivity.applyPreferredDisplayMode()` → `DisplayRefreshPolicy.chooseHighestRefresh` + `web.setRequestedFrameRate` (API35). `PresentationChatActivity.startPresentLoop()` — `Choreographer.VsyncCallback` с `preferredFrameTimeline` (API33). Xiaomi trace: `requested 120.00001 Hz mode 2, observed 120.00001 Hz`. Но `milestone-b-exit.json: release_budget_calibration_adr: null`, `presentation-boundary.md` помечает p99 20.65 мс как baseline, не бюджет; `compositor-driven smooth scroll = PENDING_PHYSICAL`. | Объявить 120 Hz без калибровки = ложный PASS. |
| 7 | **Scroll/transform/opacity/glass не должны вызывать Dioxus/layout/shaping/raster** | ✅ PASS | `neocompositor/src/fast_path.rs: present()` — без аллокаций, без `mailbox.try_lock`, без producer. `animation.rs: compositor_sampleable()` только `Translation/Opacity`. `pass_graph.rs: compile_passes` режет glass barriers без мержа растровых run. Тест `fast_path.rs: ten_thousand_frames_do_not_call_producer_or_raster` держит 10k кадров `present()` с `producer_requests==0`. `ChatCompositor.telemetry_line` отдельно считает `layout_rebuilds_on_scroll`. | — |
| 8 | **CPU может декодировать изображения в фоне, но CPU full-frame raster запрещён** | ✅ PASS | `avatar.rs: thumbnail_from_bytes` — `image::ImageReader::decode` + `resize_exact(FilterType::Triangle)` на `holder.executor` (фон), не в `present`. `vello_gpu.rs: software_raster_debug_enabled()` false; `production_host_line(... cpu_full_frame_raster=0 ...)`. Tiled raster — `Scene::append(translate)` на tile-sized target, не full-frame CPU. | — |
| 9 | **Никаких GPU readback и cross-device copies в production path** | ✅ PASS | `shared_device.rs: SharedGpuContext::open` — один `DeviceIdentity`/`DeviceEpoch`, `TextureUsageFlags::CPU_READBACK` отсутствует; `SharedGpuError::CpuReadbackForbidden/CrossDeviceCopyForbidden/PollWaitForbidden`. `InteropTelemetry { image_readbacks:0, cross_device_copies:0 }`. `vello_diag::peek_texture_rgba` только в диагностических бисекциях. | — |
| 10 | **Не объявлять visual parity или PASS, если скриншот визуально неправильный** | ✅ PASS | `docs/architecture/presentation-boundary.md:223-296` явно: «This is **not** a visual golden PASS (≤1 dp diff is not signed) and **not** WebView runtime removal». `presentation-compatibility-matrix.md` — Character Manager `DEFERRED`, не `PARITY`. `milestone-c-canary.md: canary_batch PASS` не переписывает `milestone-c-adjudication.json` (`canary=false`). | — |

## Дополнительные инварианты ТЗ (kill-first)

| Инвариант | Статус |
|---|---|
| `GateP:P1` подписан owner `Disya123` | ✅ `gate-p-decision-draft.md` |
| `D1=Track D GO` + `D2=Dioxus GO`, `D3=DEFERRED` (ADR-0049) | ✅ |
| `M0-D1a/D1b PASS` host-side, но `android_gpu_capture=false` (честно) | ✅ |
| `M0-D2 PASS` host-side, producer seam доказан на `anyrender 0.11 + patch` | ✅ с оговоркой — патчи локальные, не апстрим (`missing_upstream_capabilities`) |
| `Milestone B PASS` — независимые PERF-01…22 + device-loss на физике | ✅ `milestone-b-exit.json` (physical, admissible) |
| `Milestone C` core chat journey batch PASS, но RFC §51 TalkBack waived → `DEFERRED_BY_OWNER/WEBVIEW_FALLBACK` | ⚠️ честный gap, не скрыт |
| `canary_batch PASS` (8/8, Xiaomi) — не путать с GPU-renderer cutover | ✅ `milestone-c-canary.md: HOST_CANARY_PASS` |

## Open gaps (честно зафиксированы продуктом, не баги аудита)

- Theme SDK v2 `DEFERRED`
- Plugin SDK `CONTAINED (WebSurface later)` — не silent rewrite
- i18n/RTL `DEFERRED`
- 10k virtualization `DEFERRED` (isolated 10k harness PASS, не PARITY)
- Live backdrop glass `DEFERRED (Milestone B/C)` — GateP:P1 qualified devices only
- Production no-WebView cutover `DEFERRED`

## Что должен поправить следующий ADR/сабмит

1. Явный `WEBVIEW_REMOVAL` milestone с owner/date или явный «WebView остаётся как fallback для a11y» — сейчас `presentation-boundary.md` говорит «WebView retained until Character Manager visual golden PASS», но без даты.
2. Калибровочный ADR для 120 Hz release budget (сейчас `null`) — иначе `composite_only_frames` нельзя объявить PASS.
3. Формальное исключение для 4 hidden native views или их рефактор.
