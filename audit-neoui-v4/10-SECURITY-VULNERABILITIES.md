# Уязвимости и hardening

## 1. WebView bridge — XSS / file access

**Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/MainActivity.kt:161-228`

| Мера | Реализация | Оценка |
|---|---|---|
| `allowFileAccess=false` | ✅ | Bundled assets доступны через `file:///android_asset` / `WebViewAssetLoader`, но `file://` не читает `filesDir`. |
| `MIXED_CONTENT_NEVER_ALLOW` | ✅ | Блокирует http subresource внутри https. |
| `allowUniversalAccessFromFileURLs` только для `MeasurementOrigin.Profile.File` | ✅ | Track B (AssetLoader HTTPS) — false. |
| `evaluateJavascript` safe-area | ✅ low risk | Вводится только числа `px` из `WindowInsets`/`systemDimenPx`, не user input. |
| `JsEscaping.kt` | ✅ | Экранирует `\`, `'`, `\n`, `<0x20` как `\uXXXX`. |
| `@JavascriptInterface` | ✅ | Только `call/poll/cancel/notifyReady`, нет `eval`. |

**Не найдено:** `addJavascriptInterface` для arbitrary JS, `loadUrl("javascript:...")` с user input.

**Риск:** `WebViewAssetLoader` `AssetsPathHandler` — если SPA сделает `fetch("/assets/../../filesDir")`, handler нормализует путь? `WebViewAssetLoader` внутри `androidx.webkit` нормализует — должен вернуть 404. Не проверяли ручным fuzz, но по доке — safe.

---

## 2. JNI transport — buffer / handle / panic

**Файл:** `crates/adapters/android-jni/src/lib.rs`

- `MAX_REQUEST_LEN` (mobile-ffi) проверяется до аллокации.
- `MAX_RESPONSE_LEN = 64 MiB` — defensive growth bound, не contract limit.
- `ffi_call` loop — `NT_ERR_BUFFER` сообщает `out_len`, `out.resize` только если `out_len <= MAX_RESPONSE_LEN`, иначе `Internal`.
- Opaque handles — `i64` pointer + `AtomicI64::new(i64::MAX)` virtual handles; `kernel_ptr(handle)` → `JniError::InvalidArg` при stale, не UB; `double-free` — no-op.
- `catch_unwind` на каждой JNI entry — паника → `KernelException` (`NT_ERR_INTERNAL`), не пересекает JNI boundary.

**Вердикт:** ✅ PASS — транспорт fail-closed.

**Мелкий риск:** `JniError::from_envelope_failure` мэпит любую не-INTERNAL code как `Contract` — потеря granularity. Не уязвимость.

---

## 3. Secrets — Keystore / SecretStore

- `apps/android/app/src/main/java/com/neotavern/mobile/KeystoreSecretStore.kt` — Android Keystore-backed storage (тесты `KeystoreSecretStoreInstrumentedTest`).
- `packages/contracts/src/presentation/boundary.ts` — presentation never owns secrets; `session.rs` не трогает `SecretStore`.
- `docs/adr/0040-secret-store-port-format.md` — format/version + AEAD.

**Проверка:** Греп `SECRET|apiKey|token` в `crates/presentation-chat/src/*` — 0 прямых доступов к секретам. ✅

---

## 4. CAMERA / permission bridge

`MainActivity.kt:178-195, 190-195` — только `RESOURCE_VIDEO_CAPTURE`, иначе `deny()`. `pendingCameraRequest` хранит `PermissionRequest` до grant, затем `grant(arrayOf(...))` или `deny()`. `onRequestPermissionsResult` очищает `pendingCameraRequest`.

**Риск:** `pendingCameraRequest` не обнуляется при `onDestroy` — если Activity пересоздаётся при запросе, утечёт callback. Но `requestPermissions` — Activity-scoped, пересоздание пересоздаст Activity, старый `pendingCameraRequest` потеряется, новый запрос — новый grant. Не уязвимость, но UX-глюк.

---

## 5. Cleartext

`network_security_config.xml` + `AndroidManifest usesCleartextTraffic="true"` — `base-config cleartextTrafficPermitted=true` для LAN HostConnect.

**Threat model:**
- Злоумышленник в LAN может MITM `http://` plugin fetch или `http://` HostConnect.
- Защита: `WebView` CSP, `MIXED_CONTENT_NEVER_ALLOW`, plugin broker `SEC-03` (DNS + `remoteAddress` check), HostConnect bearer + `Origin: null` CORS.

**Оценка:** ⚠️ P2 — широкий `base-config true` вместо `domain-config` для LAN hosts. Осознанный trade-off, задокументирован в `network_security_config.xml` комментарии. Рекомендация — сузить (см. `07-*`), но не critical сейчас.

---

## 6. HostConnect / deep links

`PresentationChatLaunch.parseChatId` / `parseProfile` — валидация `chatId` перед `rememberChatId`. `KernelHost.holder(dataRoot)` — только `filesDir/neotavern` или `filesDir/neotavern-isolated-10k` (hardcoded), не произвольный `dataRoot` из intent (кроме `isolated-10k` debug). ✅

---

## 7. Plugin sandbox (для полноты)

- `docs/adr/0050` — `VisualSurfaceFrameIngress` (trusted) vs `PluginVisualSurface` (untrusted, Milestone D) — split честно.
- `crates/neocompositor/src/surface_fallback.rs` — `NonSampleableWebView / SecureVideo` — не sampleable, `OpaquePanel/PosterFrame` fallback, не копируется.

Не в scope текущей canary, но аудит не нашёл обхода: `compile_surface_plan` до `compile_passes`, capability + fallback — один `SceneEpoch`.

---

## 8. DoS векторы

| Вектор | Статус | Где |
|---|---|---|
| Large `assets.content` base64 → decode | ⚠️ P1 | `avatar.rs` — нет preflight |
| Many `characters.list` avatars → unbounded cache | ⚠️ P1 | `avatar_gpu.rs` |
| 40×50 мс poll loop блокирует executor | ⚠️ P2 | `PresentationChatActivity.sendComposer` |
| Single-thread executor HOL | ⚠️ P2 | `KernelHolder.kt` |

---

## 9. Итог security

| Класс | Найдено | Критичность |
|---|---|---|
| XSS via WebView bridge | 0 | — |
| Arbitrary file read via WebView | 0 | `allowFileAccess=false` |
| JNI panic/UB | 0 | `catch_unwind` + handle checks |
| Secret leak | 0 | presentation не трогает |
| **DoS OOM image decode** | **1** | **P1** — нужен preflight |
| Broad cleartext | 1 | P2 — осознанно, можно сузить |
| Permission leak | 0 | — |

