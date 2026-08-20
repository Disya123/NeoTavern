# Аудит миграции Android UI на Rust — Executive Summary

**Дата:** 2026-08-19 (вторая половина)  
**Ревизия аудита:** 1.0  
**Область:** `apps/android`, `crates/neocompositor`, `crates/presentation-*`, `crates/chat-viewport`, `crates/adapters/android-jni`, `docs/rfc/neoui-v4*`, `docs/adr/0049*`, `docs/architecture/presentation-boundary.md`  
**Инструмент:** статический анализ + выборочный runtime-trace review (без запуска физического 120-Hz девайса в этом прогоне; опираемся на `docs/rfc/*-adjudication.json`, логи стендов Xiaomi `8f5c2b7c`)  
**Статус цели Present Loop:** `STARTED / CANARY`, не production cutover — честно.

---

## Коротко: проходит ли миграция проверку «просто Rust»?

| Требование | Вердикт | Комментарий |
|---|---|---|
| **React — эталон внешнего вида + web-версия** | ✅ PASS | React остаётся golden: `apps/web`, `@neotavern/ui`, пак `crates/presentation-design-system` пакует точные файлы шрифтов Outfit/JetBrains Mono, токены `--st-*`, Phosphor SVG. `product_shell.rs`/`product_chat_app` копируют React классы и CSS-module имена. |
| **Android WebView последовательно заменяется Rust-маршрутами и удаляется** | ⚠️ PARTIAL | Замена последовательна и guarded: `MainActivity` остаётся WebView-rollback, `PresentationChatActivity` — Rust SurfaceView. Селектор `PresentationRendererPolicy` перед `System.loadLibrary`. Удаление WebView **DEFERRED** (известный gap, не скрывается). В APK WebView остаётся; удаление без milestone и даты — риск «вечного canary». |
| **Не использовать React Native** | ✅ PASS | RN отсутствует в `package.json`, `pnpm-workspace.yaml`, `crates/Cargo.toml`. Первый-party Android пишется Dioxus RSX → Blitz. |
| **Не подменять Rust UI нативными TextView/RecyclerView/Canvas/скрытыми WebView** | ⚠️ HACK | В `PresentationChatActivity` 4 нативных view (`TextView` header, `View` messages, `PresentationChatComposer extends EditText`, `Button` send) существуют с `alpha=0.01f` как IME/accessibility мост, не как primary renderer. **Не скрытый WebView** (проверка `hasWebView()` + лог). Но сам приём `alpha 0.01` — костыль, нарушает букву ТЗ, требует исключения/переоформления в явный `INVISIBLE` + `importantForAccessibility`. |
| **Синтаксис Android-компонентов — Dioxus RSX** | ✅ PASS | `crates/presentation-dioxus-shell/src/product_shell.rs` + `product_chat_app` — `rsx!{}`. Kotlin RSX отсутствует. |
| **Цель present loop — настоящие 120 Hz** | ⚠️ CONDITIONAL PASS | Дизайн на 120 Hz: `Choreographer.VsyncCallback` + `preferredFrameTimeline` API34, `requestHighestRefresh`, `8_333_333 ns` бюджет. Физический Xiaomi даёт `observed 120.00001 Hz`. Но sustained 120 Hz **не доказан как release budget**: `input-to-present p99 20.65 ms` помечен как *reference-device baseline*, не бюджет; `composite_only_frames>0 && layout_rebuilds_on_scroll==0` помечено `PENDING_PHYSICAL`. |
| **Scroll/transform/opacity/glass не триггерят Dioxus/layout/shaping/raster** | ✅ PASS (архитектурно) | `CompositorFastPath::present` — без аллокаций, без mailbox lock, без producer callback. `AnimationProperty::compositor_sampleable` только Translation/Opacity; остальное `NeedsProducer`. `RasterDecision::CompositeOnly` vs `SelectionOnly`. Тесты `fast_path.rs` на 10k кадров держат `producer_requests==0`, `raster_invalidations==0`. |
| **CPU декодирует картинки в фоне, но CPU full-frame raster запрещён** | ✅ PASS | `crates/presentation-chat/src/avatar.rs` декодирует `image::decode` + `resize_exact` на `holder.executor` (фоновый singleThread), не на render thread. `vello_gpu::software_raster_debug_enabled()` false по умолчанию; `production_host_line` логирует `cpu_full_frame_raster=0`, `renderer=vello-gpu`. Диагностический tiled-raster — один проход, не full-frame. |
| **Никаких GPU readback / cross-device copies в production path** | ✅ PASS (протокольно) | `SharedGpuContext` / `SharedGpuFactory` — один `DeviceIdentity`, `DeviceEpoch`, `CpuReadbackForbidden`, `CrossDeviceCopyForbidden`, `PollWaitForbidden`. Телеметрия `image_readbacks=0 cross_device_copies=0`. Реальный readback (`peek_texture_rgba`) только в диагностических бисекциях, не в present. |
| **Не объявлять visual parity / PASS при визуально неправильном скриншоте** | ✅ PASS | Docs честно: `docs/architecture/presentation-boundary.md` — «This is **not** a visual golden PASS (≤1 dp diff is not signed) and **not** WebView removal». `presentation-compatibility-matrix.md` помечает Character Manager, Theme, Plugin как `DEFERRED`. Canary adjudication `milestone-c-canary.md` не переписывает `milestone-c-adjudication.json` (`canary=false`). |

**Итоговая оценка:** **миграция «просто Rust» архитектурно честна, но не готова к объявлению production cutover.** 2 условных риска (WebView-вечность, 120 Hz sustained) и 1 буквальный костыль (alpha 0.01) требуют исправления/ADR-исключения до снятия canary.

---

## Критические находки (Top-8)

1. **P0-костыль — 4 hidden native Views с alpha 0.01** (`PresentationChatActivity.kt:131-195, 1072-1131`). Нарушает дословное чтение ТЗ, даёт лишний overdraw и риск скриншот-шума. Замена: `INVISIBLE` + явные `AccessibilityNodeInfo` или `Compose` семантика, или формальное исключение с обоснованием.
2. **P1 — naive CSS flatten (`bake_insets`, `collapse_max/calc`)** (`presentation-design-system/src/lib.rs:57-123`). Строковый `.replace` вместо CSS-парсера — сломается при будущих токенах.
3. **P1 — unbounded avatar cache** (`avatar_gpu.rs:73, textures: HashMap<String, CachedAvatar>` без LRU/evict, вне `PressureController`). Рост памяти при большом `characters.list`.
4. **P1 — отсутствие preflight для image decode** (`avatar.rs:32-67`). `ImageReader::decode` полного файла до `resize_exact`; нет лимита `content-length`/`dimensions` — OOM от вредоносного `assets.content`.
5. **P2 — Vulkan emulator detection по подстроке** (`vello_gpu.rs:207-214`). Хрупко для OEM.
6. **P2 — single-threaded `KernelHolder.executor`** (`KernelHolder.kt:36`). `GenerationService` стрим-насос (40×50 мс) блокирует очередь всех wire-вызовов — head-of-line.
7. **P2 — WebView `cleartextTrafficPermitted=true` глобально** (`network_security_config.xml` + `AndroidManifest usesCleartextTraffic`). Допустимо по ADR-0030, но расширяет MITM-поверхность на весь APK, не только LAN host.
8. **P3 — `ellipsize_css` эвристика 0.52×font** (`product_shell.rs:104-123`) — расходится с реальным шейпингом Outfit, может дать расхождение в 1-2 символа vs React `text-overflow: ellipsis`.

Остальные 20+ мелких замечаний — в `11-BUGS-AND-HACKS-CATALOG.md`.

---

## Что не является нарушением, но часто путают

- **WebView в APK** — не нарушение, пока canary `STARTED`. Нарушением будет объявить cutover без `PresentationCompatibilityMatrix` PARITY подписей.
- **Tiled GPU raster на первый bind** — не CPU full-frame raster. Это `Scene::append(translate)` на tile-sized target, один `SharedGpuContext`.
- **Avatar CPU decode** — разрешён ТЗ («CPU может декодировать изображения в фоне»).

---

## Рекомендованные действия до снятия canary

- [ ] ADR-исключение или рефактор `alpha 0.01` → семантический невидимый мост.
- [ ] Установить дедлайн/милстоун удаления WebView (`D3` или отдельный `WEBVIEW_REMOVAL` ADR).
- [ ] Подключить `avatar_gpu` к `PressureController` / `TileCache` budget.
- [ ] Добавить preflight `dimensions + byte_len` до `decode` в `avatar.rs`.
- [ ] Заменить CSS строковые замены на `lightningcss`/`cssparser` или snapshot-тест golden CSS.
- [ ] Калибровочный ADR для 120 Hz release budget (сейчас `release_budget_calibration_adr: null`).
- [ ] Физический `PENDING_PHYSICAL` прогон для `composite_only_frames`/`layout_rebuilds_on_scroll`.

Детальные доказательства — в файлах `01-*` … `12-*`.
