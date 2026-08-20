# WebView lifecycle, hardening, последовательная замена

## ТЗ

> Android WebView должен быть последовательно заменён Rust-маршрутами и в итоге удалён.

---

## Как реализована последовательность

### Manifest и entry points

```xml
<!-- apps/android/app/src/main/AndroidManifest.xml -->
<activity android:name=".MainActivity" exported="true" configChanges="orientation|screenSize|keyboardHidden" />
<activity android:name=".PresentationChatActivity" label="NeoTavern" exported="true"
          launchMode="singleTop" resizeableActivity="true"
          windowSoftInputMode="adjustResize"
          configChanges="orientation|screenSize|keyboardHidden">
  <intent-filter>
    <action android:name="android.intent.action.MAIN"/>
    <category android:name="android.intent.category.LAUNCHER"/>
  </intent-filter>
</activity>
```

- `PresentationChatActivity` — LAUNCHER (иконка). `MainActivity` — harness для `connectedDebugAndroidTest` и WebView E2E.
- Оба шарят `KernelHost.holder(filesDir/neotavern)` — один `database.sqlite`, без второго writer.

### Guarded selector (до Rust host)

`MainActivity.kt:605-693 tryHandoffDioxusCanary()` — выполняется в `onCreate` **до** `WebView`, `Kernel acquire`, `loadLibrary`:

```
safe mode? → WebView
kill switch? → WebView        // neotavern_presentation_canary kill
crashLoop (3× Dioxus fail without ready)? → WebView
touchExplorationEnabled? → WebView   // ADR-0051, TalkBack
deviceQualified? (!emulator && vulkanHardware && !softwareRenderer) → else WebView
canaryFlag? (NEOTA_DIOXUS_SHELL=1 persisted) → else WebView
→ else PresentationChatActivity (Rust)
```

Логика честно пишет `presentation_renderer=WEBVIEW/RUST reason=... rust_host_allowed=...`.

`PresentationChatActivity` при своей инициализации **не** делает fallback в WebView (кроме `rollbackCanaryIfNeeded` при `missing_jni`/`load_failed`, но остаётся на Rust activity, просто с `chat_route=false` — WebView не создаёт).

### Not-yet-migrated

`crates/presentation-dioxus-shell/src/product_shell.rs` — rail items `personas/lorebooks/backgrounds/ai-settings/plugins/settings` → `NotYetMigrated` surface, не WebView.

`docs/architecture/presentation-boundary.md:79` — `Unmigrated rail panels render not-yet-migrated; they do not fall back to WebView.`

### Что остаётся WebView

| Компонент | Статус | План удаления |
|---|---|---|
| `MainActivity` WebView | retained как harness и rollback | `instrumented tests + rollback` — пока нужен |
| `PresentationChatActivity` | Rust SurfaceView | canary |
| `WebViewAssetLoader` HTTPS | опциональный M1 Track B, не default | — |
| production APK WebView | в APK | `presentation-compatibility-matrix.md:35` — `DEFERRED` (no date) |

**Вердикт последовательности:** ✅ PASS — замена guard-ирована, не «big bang».  
**Вердикт удаления:** ⚠️ PARTIAL — удаление заявлено, но без дедлайна/owner. Нужен отдельный `WEBVIEW_REMOVAL` ADR с `Milestone D/E` и условием `Character Manager visual golden PASS`.

---

## Hardening WebView (MainActivity)

### Settings

```kotlin
// MainActivity.kt:161-168
web.settings.javaScriptEnabled = true // нужен для bundled UI
web.settings.domStorageEnabled = true
web.settings.allowFileAccess = false // ← правильно
web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
web.settings.allowUniversalAccessFromFileURLs = (origin == File) // только file://
web.settings.allowFileAccessFromFileURLs = // не трогается (default false)
```

**Правильно:**
- `allowFileAccess=false` — даже при `file:///android_asset/web/index.html` assets доступны, но `file://` из JS не читает произвольный `filesDir`.
- `MIXED_CONTENT_NEVER_ALLOW` — http subresource внутри https не грузится.
- `WebViewAssetLoader` (`https://appassets.androidplatform.net`) — когда включён, `shouldInterceptRequest` перехватывает только `appassets.androidplatform.net`, остальное — `super`.

### Bridge

```kotlin
// MainActivity.kt:225-228
web.addJavascriptInterface(bridge, "__neotavernMobile") // до loadUrl
// bridge = NeotavernBridge(session, executor, mainHandler, webView, onStreamOpened, ...)
```

- `NeotavernBridge.kt` — `@JavascriptInterface` только `call`, `poll`, `cancel`, `notifyReady`; нет `eval` произвольного JS в Kotlin.
- `JsEscaping.kt:19` — экранирование `\`, `'`, `\n`, `<0x20` как `\uXXXX` перед `evaluateJavascript`.

### Injected CSS safe-area

`MainActivity.captureWindowInsets` + `publishSafeAreaCss` — `evaluateJavascript` с `setProperty(..., 'important')` для `--nt-safe-area-*`. Контент — только числа `px` из `systemDimenPx` или `WindowInsets`, не user input — XSS риск низкий.

### Network security

```xml
<!-- network_security_config.xml -->
<base-config cleartextTrafficPermitted="true">
  <trust-anchors><certificates src="system"/></trust-anchors>
</base-config>
```
```xml
<!-- AndroidManifest.xml -->
<application android:usesCleartextTraffic="true" ...>
```

**ADR-0030 justification:** Headless/Desktop Remote Access говорит plaintext HTTP на LAN (без TLS), Android host должен достучаться до IP из QR. Pairing bearer + CORS — гейты, cleartext — только транспорт.

**Риск:** `cleartextTrafficPermitted=true` на `base-config` — разрешает cleartext **везде**, не только `appassets.androidplatform.net` или введённый пользователем host. Злоумышленник в той же Wi-Fi может MITM `http://` plugin fetch? Но plugin network broker (SEC-03) и `WebViewAssetLoader` HTTPS уже ограничивают; однако `WebView` может грузить `http://` subresource если страница сама его вставит (хотя `MIXED_CONTENT_NEVER_ALLOW` + CSP в `apps/web/index.html` должны блокировать).

**Рекомендация (P2):** сузить до:
```xml
<domain-config cleartextTrafficPermitted="true">
  <domain includeSubdomains="true">appassets.androidplatform.net</domain>
  <domain includeSubdomains="false">localhost</domain>
  <domain includeSubdomains="false">127.0.0.1</domain>
</domain-config>
<base-config cleartextTrafficPermitted="false"> ...
```
Но тогда ручной LAN IP от HostConnect сломается — нужен `usesCleartextTraffic` per-host. Текущий широкий `true` — осознанный trade-off, задокументированный, не скрытый.

### CAMERA

- `AndroidManifest: <uses-permission CAMERA/>` + `required=false`, `WebChromeClient.onPermissionRequest` — только `RESOURCE_VIDEO_CAPTURE`, иначе `deny()`. Runtime запрос через `ActivityCompat.requestPermissions` с `pendingCameraRequest`.

Риск низкий: QR pairing — optional, без камеры ставится.

---

## Process death и lifecycle

- `MainActivity.onDestroy` — `bridge.close()` (JS delivery stop, streams stay), `holder.release()` (refcount--, shutdown если 0), `webView.destroy()`.
- `GenerationService` — `FOREGROUND_SERVICE_DATA_SYNC`, `ForegroundExecutionCoordinator.claim(handle, wireStreamId)` перед `startForegroundService`; service держит свой `holder.acquire()` — kernel не умирает при убитой Activity.
- `PresentationChatActivity.onSaveInstanceState` — сохраняет `chatId`, `profile`, `composer` текст; `onCreate` восстанавливает `composer.setText` + `PresentationChatNative.saveDraft` + `holder.executor` ребилд сцены.

**Найден архитектурный риск (P2):** `KernelHolder` single-thread executor HOL описан в `11-BUGS-AND-HACKS-CATALOG.md`.

---

## Вывод

- Последовательная замена — ✅ реализована и логирована.
- Hardening WebView — ✅ без грубых дыр, `allowFileAccess=false` + `MIXED_CONTENT_NEVER_ALLOW`.
- Удаление WebView — ⚠️ без даты, остаётся canary. Рекомендуется `WEBVIEW_REMOVAL` ADR.
- Cleartext — ⚠️ глобально разрешён, осознанно, но можно сузить.
