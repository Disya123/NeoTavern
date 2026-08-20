# Доказательства и как воспроизвести

## 1. Как мы проверяли (без домыслов)

- **Рабочая директория:** `E:\AI\Work\NeoTavern` (проверено `pwd`)
- **Инструменты:** `read` (line-numbered), `grep`, `glob`, `pwsh` `Get-ChildItem`/`Get-Content`. Все утверждения — с `file:line`.
- **Физические следы:** брались из `docs/rfc/*-adjudication.json`, `docs/rfc/*-physical-runbook.md`, `docs/rfc/milestone-*.md` — не перезапускали `connectedDebugAndroidTest` в этом прогоне, но сверили `cargo test` логи (`cargo-full*.log`) и `vitest-*.log` на наличие PASS записей.

---

## 2. Ключевые файлы — что читали

| Файл | Строки | Что доказали |
|---|---|---|
| `apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt` | 1-1142 | 4 hidden native views, alpha 0.01, SurfaceView primary, no WebView, guarded canary |
| `apps/android/app/src/main/java/com/neotavern/mobile/MainActivity.kt` | 1-700 | WebView hardening, guarded handoff, safe-area publish |
| `apps/android/app/src/main/java/com/neotavern/mobile/KernelHolder.kt` | 1-119 | singleThreadExecutor, refcount, release shutdown |
| `apps/android/app/src/main/AndroidManifest.xml` | 1-60 | LAUNCHER — PresentationChatActivity, cleartext true |
| `apps/android/app/src/main/res/xml/network_security_config.xml` | 1-14 | base-config cleartext true |
| `crates/neocompositor/src/fast_path.rs` | 1-250 | present без alloc/lock/producer |
| `crates/neocompositor/src/animation.rs` | 1-200 | compositor_sampleable только Translation/Opacity |
| `crates/neocompositor/src/scroll.rs` | 1-250 | AsyncScrollState visual=committed+unacked, ack rebase |
| `crates/neocompositor/src/shared_device.rs` | 1-300 | SharedGpuContext, SecondDevice, CpuReadbackForbidden |
| `crates/neocompositor/tests/shared_device.rs` | 1-300 | 10 тестов на no readback / no cross-device |
| `crates/neocompositor/src/display_list.rs` | 1-250 | NeoDisplayList, GlassBoundary, EffectKind |
| `crates/neocompositor/src/pass_graph.rs` | 1-300 | compile_passes, barriers_cut_raster_runs |
| `crates/presentation-chat/src/avatar.rs` | 1-120 | decode на CPU, premultiply, resize 192 |
| `crates/presentation-chat/src/avatar_gpu.rs` | 1-150 | upload via write_texture, unbounded HashMap |
| `crates/presentation-chat/src/vello_gpu.rs` | 1-250 | software_raster_debug, Rgba8Unorm, production_host_line |
| `crates/presentation-chat/src/android_surface.rs` | 1-250 | GpuSurface, wgpu Vulkan, tile raster, logs |
| `crates/presentation-chat/src/session.rs` | 1-250 | ChatSession via ProductWire, avatar cache |
| `crates/presentation-dioxus-shell/src/product_shell.rs` | 1-400 | rsx!, packed React CSS, avatar fallback |
| `crates/presentation-design-system/src/lib.rs` | 1-200 | bake_insets, collapse_max/calc, fonts |
| `docs/architecture/presentation-boundary.md` | 1-296 | Milestone A/B/C статусы, «not visual golden PASS» |
| `docs/rfc/milestone-b-exit.json` | 1-100 | 17 PERF PASS, release_budget null |
| `docs/rfc/milestone-c-canary.md` | 1-120 | 8/8 canary PASS, PENDING_PHYSICAL |
| `docs/adr/0049-track-d-dioxus-presentation.md` | 1-60 | D1/D2 GO, D3 DEFERRED |

---

## 3. Команды для локального repro (скопируй)

```bash
# 1. Проверить, что Rust не использует RecyclerView/Canvas/WebView как primary
rg -n "RecyclerView|android\.graphics\.Canvas|WebView" crates/presentation-chat/src crates/neocompositor/src
# → 0 матчей (кроме комментариев)

# 2. Проверить, что alpha 0.01 действительно 4 штуки
rg -n "alpha = 0\.01f" apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt
# → 4

# 3. Проверить Dioxus RSX
rg -n "rsx!" crates/presentation-dioxus-shell/src
# → product_shell.rs: много

# 4. Проверить no CPU full-frame raster в production
rg -n "software_raster_debug_enabled|production_host_line|cpu_full_frame_raster" crates/presentation-chat/src
# → все gated by flag

# 5. Проверить shared device no readback
cargo test -p neotavern-neocompositor --test shared_device -- --nocapture
# → format_is_explicit_and_forbids_cpu_readback PASS

# 6. Проверить fast path 10k кадров
cargo test -p neotavern-neocompositor --test fast_path -- ten_thousand_frames --nocapture
# → PASS, producer_requests==0

# 7. Проверить WebView hardening
rg -n "allowFileAccess|mixedContentMode|allowUniversalAccessFromFileURLs" apps/android/app/src/main/java/com/neotavern/mobile/MainActivity.kt
# → false, NEVER_ALLOW, == File

# 8. Проверить visual parity не объявлен PASS
rg -n "visual golden PASS|NOT.*PASS|DEFERRED" docs/architecture/presentation-boundary.md docs/rfc/presentation-compatibility-matrix.md -- -i
# → This is not a visual golden PASS … DEFERRED

# 9. Проверить 120 Hz present loop VsyncCallback
rg -n "VsyncCallback|preferredFrameTimeline|presentFrame" apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt crates/presentation-chat/src/android_surface.rs
# → оба файла

# 10. Проверить avatar unbounded cache
rg -n "HashMap.*CachedAvatar|HashMap.*AvatarThumb" crates/presentation-chat/src
# → avatar_gpu.rs, session.rs

# 11. Собрать canary APK и логи (требует Android SDK + Xiaomi 8f5c2b7c)
./apps/android/scripts/build-libs.sh --release
./gradlew :app:assembleRelease -p apps/android
adb install -r apps/android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n com.neotavern.mobile/.MainActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1
adb logcat -s NeoTavern:V NeoTavernI2P:V | grep -E "presentation_renderer=|present vsync=|cpu_full_frame_raster"
```

---

## 4. Физические артефакты (не генерировали заново)

- `docs/rfc/m0-track-comparison.md` — треки A/B/C/D сравнение, D2 120 Hz observed
- `docs/rfc/perf-15-adjudication.json` — PERF-15 PASS (pressure)
- `docs/rfc/perf-22-adjudication.json` — PERF-22 PASS (surface fallback, real WebView+SurfaceView)
- `docs/rfc/device-loss-adjudication.json` — PASS
- `docs/rfc/input-to-present-adjudication.json` — p99 20.65 ms baseline
- `docs/rfc/milestone-c-adjudication.json` — SUCCESS `2026-08-19T10-29-35-149Z` (8 journeys, TalkBack SKIPPED)
- `docs/rfc/milestone-c-canary.json` — HOST_CANARY_PASS 60a4d6a

Каждый содержит `record` path и `admissible: true`.

---

## 5. Что не воспроизводили (и почему)

- Не запускали `connectedDebugAndroidTest` на эмуляторе в этом прогоне — тяжёлый, 11 инструментальных тестов; опирались на уже закоммиченный `acceptance-ledger.json` и `cargo-full*.log`.
- Не делали RenderDoc capture — требует AGI хоста и физического Vulkan; `android_gpu_capture=false` честно в `presentation-m0` crate, не пытались объявить PASS.
- Не открывали Figma для pixel-perfect скриншот сравнения — `presentation-boundary.md` уже честно помечает `≤1 dp diff is not signed`.
