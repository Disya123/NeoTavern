# Архитектурные нарушения и границы

## 1. Single source of truth — Kernel vs Presentation

**Инвариант:** `Rust Runtime Kernel` — единственный владелец durable product state; Presentation только *потребляет* Product Wire.

**Проверка:**
- `crates/presentation-chat/src/wire.rs:16-30` — `trait ProductWire { call, start_stream, poll_stream, cancel_stream }` — презентация никогда не открывает `Kernel::open` напрямую, только через `PresentationChatWire(holder.session, envelopes)`.
- `crates/presentation-chat/src/session.rs:90-120` — `ChatSession::open` грузит `chats.get`/`messages.list` через wire, не SQLite.
- `crates/presentation-dioxus-shell/src/lib.rs` — `does not import Kernel, storage, or network crates`.

**Вердикт:** ✅ PASS. Архитектурная граница соблюдена. Единственный нюанс — `AvatarThumb` кеш (`session.rs: avatar_thumbs: HashMap<String, AvatarThumb>`) хранит производные байты, но не product truth; это деривация, не второй источник.

---

## 2. WebView lifecycle — guarded canary vs «скрытый второй владелец кадров»

**Канон:** `MainActivity` (WebView) — public renderer и rollback; `PresentationChatActivity` (Rust SurfaceView) — canary, выбирается **до** `System.loadLibrary`/`Kernel acquire`.

**Реализация:**
```
MainActivity.tryHandoffDioxusCanary() — 700 строк, секция 606-693
  → читает prefs + extras
  → проверяет safeMode / killSwitch / crashLoop(3) / touchExploration / deviceQualified / canaryFlag
  → если rustHostAllowed → PresentationCanaryHost.launch(...) + finish()
```

`AndroidManifest.xml`:
- `MainActivity` — `exported=true`, **без** intent-filter (тестовый harness)
- `PresentationChatActivity` — `exported=true`, `singleTop`, `LAUNCHER` — иконка на дом. экране

**Нарушения:** нет. Но есть архитектурный **долг**:
- Две activity с похожим именем — риск путаницы в `adb`/`dumpsys`. Логи `presentation_renderer=RUST/WEBVIEW` помогают, но нужен `docs/android/README.md` с таблицей «куда попал».
- `KernelHost` — процесс-глобальный `object` с `current: KernelHolder?` и `@Synchronized holder()`. Если `MainActivity` и `PresentationChatActivity` параллельно вызовут `holder()` (напр., при быстром рестарте), второй получит тот же holder, но `acquire()/release()` рефкаунт может уйти в 0 между ними. Сейчас `KernelHolder.release()` делает `executor.shutdown()` перманентно; повторный `acquire()` бросит `IllegalStateException`. Код `PresentationCanaryHost.launch` не ловит этот кейс — теоретический `IllegalStateException` при hot-restart.
- **Рекомендация:** добавить `KernelHost.resetIfReleased()` или ловить `IllegalStateException` в `PresentationChatActivity.onCreate: holder.acquire()` и пересоздать holder.

---

## 3. Product Wire — единственная шина

- `packages/contracts/src/wire/registry.ts` — единственный реестр операций; `buildProductWireRegistry()` генерирует TS и Rust DTO.
- `crates/presentation-dioxus-shell/src/lib.rs: assert_registered_command` — любая presentation команда проверяется против `wire-operation-ids.json`, иначе `UnknownCommand`.
- `crates/presentation-chat/src/session.rs` — все эффекты (`chats.create`, `characters.list`, `assets.content`, `generation.start/retry`) идут через `call_decode`.

**Нарушение попытки обойти Wire?** Не найдено. `NeotavernBridge` (WebView) и `PresentationChatWire` (Rust) используют один `EnvelopeBuilder.fromHandshake`.

---

## 4. Theme / Plugin / i18n границы

- `presentation-compatibility-matrix.md` — каждая capability имеет ровно один статус `PARITY/ADAPTED/CONTAINED/DEFERRED/DEFERRED_BY_OWNER/WEBVIEW_FALLBACK`.
- Theme SDK — `DEFERRED` честно; нет попытки выдать `DEFERRED` за `PARITY`.
- Plugin — `CONTAINED (WebSurface later)` и `TRUSTED VisualSurfaceFrameIngress` vs `PluginVisualSurface`. Split зафиксирован в `docs/adr/0050-visual-surface-ingress-vs-plugin.md`.

**Нарушение?** Нет, но есть **риск дрейфа**: `crates/presentation-design-system` пакует `generated/product.css`, сгенерированный из `packages/ui` CSS Modules. Если React поменяет токен, Rust пакет не пересоберётся автоматически — нужен CI `check-design-system-pack`.

---

## 5. Запрет foundational private fork

Инвариант NeoUI v4 §8: `permanent foundational forks: 0`, `active downstream patches ≤8`, `rebase ≤1 engineer-day`.

Факт:
- `crates/Cargo.toml [patch.crates-io] anyrender/blitz-paint/vello = { path = "vendor/..." }`
- `crates/presentation-m0-d2/src/lib.rs: D2_PATCH_LINES = 294`, `D2_REBASE_ANYRENDER_0111 = "PASS"`, `missing_upstream_capabilities()` честно перечисляет `host_node_marker`, `host_text_fragment` как локальные патчи.
- `crates/vendor/README` (внутри vendor) — не foundational fork layout/text, а bounded patches.

**Вердикт:** ✅ PASS, но долг: `anyrender 0.11` патчи **не** в апстриме; каждый патч должен иметь `upstream issue/PR` — сейчас `NOT_AVAILABLE` для Blitz newer.

---

## 6. D3 DEFERRED — честно, но без владения стоимостью

ADR-0049: `D3 = DEFERRED — Android Rust path + Web React; no unification mandate`.

Это архитектурно честно, но порождает двойную стоимость: две реализации чата (React `apps/web` + Dioxus `product_chat_app`). `docs/adr/0049` честно называет альтернативу «D3=single UI now — would force Web Dioxus rewrite. Deferred.» — риск не скрыт.

**Рекомендация:** зафиксировать staffing/owner для поддержки двух UI, иначе `DEFERRED` превратится в вечный «dual UI tax».

---

## 7. Мелкие граничные замечания

| Файл:строка | Что | Почему граница |
|---|---|---|
| `crates/neocompositor/src/lib.rs:31-33` | `NEOTA_NEOCOMPOSITOR=1` flagged, not cutover | Честно, не нарушение |
| `crates/presentation-m0/src/lib.rs:1-13` | M0 probe crates остаются probes, не production JNI | Граница probe vs production сохранена |
| `crates/presentation-perf-probe/*` | debug probe, not production JNI | Граница debug vs production сохранена |
