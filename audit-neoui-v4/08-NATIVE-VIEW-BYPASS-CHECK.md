# Проверка: не подменяется ли Rust UI нативными TextView/RecyclerView/Canvas/скрытыми WebView

## ТЗ дословно

> Не подменять Rust UI нативными `TextView`, `RecyclerView`, `Canvas` или скрытыми `WebView`.

Проверка — по коду Rust canary (`PresentationChatActivity`) и по Blitz/Vello рендеру.

---

## 1. TextView

### Где найден

`apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt:131-195`

```kotlin
header = TextView(this)
header.alpha = 0.01f
header.setBackgroundColor(Color.TRANSPARENT)
header.contentDescription = "Chat header"
header.isClickable = false
header.isFocusable = true

messages = View(this) // не TextView, но тоже native
messages.alpha = 0.01f

composer = PresentationChatComposer(this) // extends EditText (подкласс TextView)
composer.alpha = 0.01f

send = Button(this) // Button extends TextView
send.alpha = 0.01f
```

4 view добавляются в `FrameLayout` рядом с `SurfaceView` (`root.addView(surfaceView, MATCH_PARENT)` + `root.addView(header...)` и т.д.) — но **изначально 0.01 alpha и TRANSPARENT**, не GONE. Позже `syncChatOverlay()` / `attachChatOverlay()` / `destroyChatOverlay()` переключает между «overlay attached» (видимый чат-оверлей) и detached (только SurfaceView).

В detached состоянии (`onCreate`):

```kotlin
header.importantForAccessibility = NO_HIDE_DESCENDANTS
messages.importantForAccessibility = NO_HIDE_DESCENDANTS
composer.hint = null; send.text = ""
setContentView(root) // только SurfaceView видим
```

В attached (`isChatRouteVisible()==true`):

```kotlin
header.importantForAccessibility = YES
messages.importantForAccessibility = YES
composer.hint = "Message"; send.text = "Send"
root.addView(header, LayoutParams(MATCH_PARENT, 96, TOP))
root.addView(messages, LayoutParams(MATCH_PARENT, MATCH_PARENT))
root.addView(composer, LayoutParams(MATCH_PARENT, WRAP_CONTENT, BOTTOM) + rightMargin=160)
root.addView(send, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, BOTTOM|END))
```

### Является ли это подменой Rust UI?

**Нет, но нарушает букву.**

- **Primary renderer — `SurfaceView` + `wgpu` + `Vello` + `NeoCompositor`**, не TextView. Текст чата, карточки персонажей, аватары — рендерятся в GPU `android_surface.rs` → `presentFrame`. TextView не рисует сообщения.
- **Роль native views — IME и a11y мост:**
  - `PresentationChatComposer: EditText` — нужен для Gboard `InputConnection` (Blitz не владеет Android `InputConnection` — non-goal ТЗ §3). Комментарий в `lib.rs`: `An invisible platform IME bridge is retained for Gboard.`
  - `header/messages` — `contentDescription = "Chat header, ${title}, ${count} messages"` + `talkback` trail; нужны для `AccessibilityDelegateCompat` и `announceForAccessibility("Streaming")`.
  - Без них Gboard не покажет клавиатуру, TalkBack не найдёт узел (Blitz TalkBack — `DEFERRED_BY_OWNER`).

**Почему `alpha=0.01`, а не `INVISIBLE`/`GONE`?** — хак:

- `GONE` убирает view из layout и a11y дерева — TalkBack не найдёт.
- `INVISIBLE` остаётся в layout, но некоторые OEM/Accessibility не фокусят `INVISIBLE`.
- `alpha=0.01` — остаётся `VISIBLE` для системы, но почти прозрачный для глаза и не попадает в `isOpaque` оптимизацию. Скриншот может поймать faint 1% blend, но на `#151311` фоне — невидимо.

**Оценка:** это **костыль**, но не «подмена Rust UI». ТЗ запрещает подмену **рендера** — здесь рендер остаётся Rust. Тем не менее, дословное чтение ТЗ будет флагом. Нужен либо:
- ADR-исключение: «4 hidden native views как IME/a11y мост, не primary renderer», или
- замена на `INVISIBLE` + `importantForAccessibility=YES` + `setAlpha(0f)` + `setWillNotDraw(false)` + явный `AccessibilityNodeInfo` (без визуала).

**Проверено, что не используется как скрытый рендерер:**
- `composerWatcher` / `afterTextChanged` — только `PresentationChatNative.saveDraft(text)`, не рендер.
- `bindSnapshot` — только `contentDescription` + лог, не `setText(messages)`.

---

## 2. RecyclerView

Греп по `RecyclerView` в `crates/presentation-chat`, `crates/neocompositor`, `crates/presentation-dioxus-shell`, `apps/android/app/src/main/java/com/neotavern/mobile/Presentation*` — **0 матчей**.

Виртуализация — `crates/chat-viewport` (`HeightIndex`, `ViewportSession`, `TileCache`, `PredictorBudgets`) + `PresentationSession.publish()` — pure Rust, не `RecyclerView`.

```rust
// crates/chat-viewport/src/tiles.rs
pub struct TileCache { entries: HashMap<TileId, TileDescriptor>, cap_entries: 256, cap_bytes: 4*1024*1024 }
```

✅ PASS — RecyclerView не используется.

---

## 3. Canvas (Android `android.graphics.Canvas`)

Греп по `Canvas` в canary path — только `crates/vendor/vello`, `blitz-paint` (CPU `Canvas2D` для форм), не в `PresentationChatActivity`. Рендер чата — `wgpu::RenderPipeline` + `vello::Renderer` (GPU), не `Canvas.drawText/drawBitmap`.

`crates/neocompositor/src/visual_surface.rs` — `VisualSurface` использует `SharedGpuContext`, не `Canvas`.

`crates/presentation-design-system` — `phosphor_path` — SVG path, не `Canvas`.

✅ PASS — Canvas как primary renderer не используется.

---

## 4. Скрытый WebView

### Проверка в Rust activity

`PresentationChatActivity.kt:992-1032`

```kotlin
private fun logWebViewAbsence() {
  val found = hasWebView(window.decorView)
  journeyLog?.talkback("webview_in_tree=$found")
}
private fun hasWebView(view: View): Boolean {
  if (view is WebView) return true
  if (view is ViewGroup) for (i in 0 until childCount) if (hasWebView(childAt(i))) return true
  return false
}
```

- Вызывается в `onCreate` после `setContentView(root)` — должен вернуть `false`.
- `AndroidManifest` — `PresentationChatActivity` не объявляет `<WebView>`.

Греп `WebView` в `crates/presentation-chat/src/*.rs` — **0** (кроме комментариев `WebView is not a route fallback`).

### Проверка в `MainActivity` (ожидаемо WebView)

`MainActivity.kt` — `WebView(this)` — **ожидаемо**, это rollback harness, не скрытый. Логирует `m1-origin profile=...` и `m1-refresh`.

**Скрытый WebView внутри Rust path:** ❌ не найден.

**WebView в APK:** остаётся в `MainActivity` — честно, не скрыт.

✅ PASS.

---

## 5. Сводка

| Компонент | Найден в Rust path | Роль | Вердикт |
|---|---|---|---|
| `TextView`/`Button`/`EditText` | Да, 4 штуки, alpha 0.01 | IME + a11y мост | ⚠️ костыль, не primary renderer — требует ADR-исключение |
| `RecyclerView` | Нет | — | ✅ |
| `Canvas` (Android) | Нет | — | ✅ |
| Скрытый `WebView` | Нет | — | ✅ |

**Рекомендация:** переоформить 4 view как явный `PlatformImeBridge` + `A11yOverlay` с `INVISIBLE` и документацией, или зафиксировать исключение в `docs/adr/0051` как part of `WEBVIEW_FALLBACK` → `NATIVE_A11Y_BRIDGE`.

