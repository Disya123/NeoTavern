# Аудит миграции Android UI на Rust (просто Rust) — NeoTavern NeoUI v4

**Дата:** 2026-08-19  
**Gate:** `GateP:P1` подписан, `D1=Track D GO` / `D2=Dioxus GO` / `D3=DEFERRED` (ADR-0049), Milestone B PASS, Milestone C STARTED / CANARY, cutover STARTED / CANARY, не production cutover.  
**Фокус:** найти реальные баги, костыли, уязвимости и архитектурные нарушения по 10 требованиям из задания; не писать код, только аудит.

> Подробности — в `00-EXECUTIVE-SUMMARY.md` и `01-*` … `12-*`. Это индекс.

## Как читать

1. Начни с `00-EXECUTIVE-SUMMARY.md` — 10 требований в таблице, Top-8 находок.
2. `01-COMPLIANCE-MATRIX.md` — дословная матрица ТЗ → PASS/PARTIAL/HACK с доказательствами.
3. `02-*` … `10-*` — глубокий разбор каждого требования + смежных инвариантов.
4. `11-BUGS-AND-HACKS-CATALOG.md` — единственный источник truth для каждого бага (file:line, severity, fix).
5. `12-EVIDENCE-AND-REPRO.md` — как воспроизвести каждую проверку локально.

## Карта файлов

| Файл | Что внутри |
|---|---|
| `00-EXECUTIVE-SUMMARY.md` | Коротко: проходит ли «просто Rust» и 8 критичных находок |
| `01-COMPLIANCE-MATRIX.md` | 10 требований + kill-first Gates → PASS/PARTIAL |
| `02-ARCHITECTURE-VIOLATIONS.md` | Kernel vs Presentation, WebView lifecycle, D3 debt, patch discipline |
| `03-PERFORMANCE-120HZ-FAST-PATHS.md` | 120 Hz VsyncCallback, fast paths, 10k-кадров тест |
| `04-VISUAL-PARITY-GLASS.md` | React golden, packed CSS flatten, live glass, почему не PASS |
| `05-GPU-INTEROP-NO-READBACK.md` | SharedGpuContext, no readback / no cross-device |
| `06-IMAGE-DECODE-VS-RASTER.md` | CPU decode в фоне vs CPU full-frame raster запрещён |
| `07-WEBVIEW-LIFECYCLE-AND-HARDENING.md` | Guarded canary, WebView hardening, cleartext |
| `08-NATIVE-VIEW-BYPASS-CHECK.md` | TextView/RecyclerView/Canvas/hidden WebView — детекция |
| `09-DIOXUS-RSX-SYNTAX.md` | `rsx!` аналогия React |
| `10-SECURITY-VULNERABILITIES.md` | XSS, JNI, Keystore, CAMERA, DoS |
| `11-BUGS-AND-HACKS-CATALOG.md` | 14 багов P0-P3 с file:line и фиксом |
| `12-EVIDENCE-AND-REPRO.md` | Команды repro, ключи артефактов, что не запускали |

## Итог одной строкой

Миграция архитектурно честна (не объявляет ложный PASS, не использует RN, не делает CPU raster, не делает readback), но имеет 1 P0-костыль (`alpha 0.01` native views), 4 P1 бага (CSS flatten, unbounded avatar cache, OOM decode, HOL executor) и отсутствие даты удаления WebView — требуют фикса до production cutover.

## Куда дальше

- Владелец продукта: подписать `WEBVIEW_REMOVAL` ADR или продлить `DEFERRED` с датой.
- Инженер: P0/P1 из `11-*` в бэклог Milestone C.
- QA: физический `PENDING_PHYSICAL` прогон для `composite_only_frames` + калибровочный ADR 120 Hz budget.
