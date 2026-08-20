# Каталог реальных багов, костылей и хрупкостей

> Каждый пункт — проверяемый факт с файлом:строкой. Severity: P0 blocker, P1 major, P2 minor, P3 nit.

## P0 — blocker (требует фикса до cutover)

### P0-01 — Hidden native views с alpha 0.01

- **Файлы:** `apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt:131-174, 192-195, 1049-1132`
- **Что:** `header.alpha=0.01f`, `messages.alpha=0.01f`, `composer.alpha=0.01f`, `send.alpha=0.01f` + `BackgroundColor=TRANSPARENT`. Views остаются `VISIBLE` для a11y, но визуально почти невидимы.
- **Почему костыль:** `INVISIBLE`/`GONE` убрали бы из a11y, `alpha 0.01` — хак. Даёт overdraw (ещё один layer), может попасть в `PixelCopy` скриншот как faint ghost (1% blend на тёмном `#151311` — ≈ `#151311` vs `#171412`, 2/255 diff, но на high-contrast теме — заметнее). Нарушает дословное «не подменять нативными TextView».
- **Фикс:** Заменить на `INVISIBLE` + `importantForAccessibility=YES` + `isFocusable=true` + `ViewCompat.setAccessibilityDelegate` (уже есть) или вынести в `PlatformImeBridge` с `InputConnection` без `EditText` (требует `BaseInputConnection` вручную). Или ADR-исключение.

---

## P1 — major (влияет на стабильность/визуал/память)

### P1-02 — Naive CSS flatten

- **Файл:** `crates/presentation-design-system/src/lib.rs:53-124` (`bake_insets`, `collapse_max_px`, `collapse_calc_px_sum`, `parse_px_token`)
- **Что:** `.replace("var(--nt-safe-area-…)", "12px")` + строковый поиск `max(` / `calc(` без токенизации. `collapse_two_arg_fn` ищет `max(` → `left,right` → `parse_px_token` → `format!("{}px")`. `collapse_calc_px_sum` — только `A + B` с `px`.
- **Почему баг:** Сломается на `max(8px, calc(4px + var(--x)))`, `/* comment */ max(`, `@media`, `var(--st-color-accent, #e38a62)`. Будущий React токен `padding: max(16px, env(safe-area-inset-top))` уже дал 0 в WebView (фиксили), Rust flatten сломается аналогично.
- **Фикс:** Парсить через `cssparser`/`lightningcss` или snapshot golden CSS тест.

### P1-03 — Unbounded avatar cache

- **Файлы:** `crates/presentation-chat/src/avatar_gpu.rs:73` (`textures: HashMap<String, CachedAvatar>`), `crates/presentation-chat/src/session.rs: avatar_thumbs: HashMap<String, AvatarThumb>`
- **Что:** `insert` без evict, без `PressureController` интеграции. Каждый `avatar_asset_id` — 192×192×4 ≈ 144 KiB GPU + 144 KiB RAM. При 200 персонажей — 28 MiB.
- **Почему баг:** Нарушает `AGENTS.md §20` — каждый cache должен иметь memory limit, TTL, versioned key, explicit invalidation. Сейчас только key (asset_id) есть.
- **Фикс:** LRU с `DEFAULT_PRESSURE_CAP_BYTES` или `TileCache`-like `cap_entries: 64` + `pressure` reclamation.

### P1-04 — Image decode без preflight (OOM)

- **Файл:** `crates/presentation-chat/src/avatar.rs:32-67` (`thumbnail_from_bytes`, `premultiplied_cover_thumbnail`)
- **Что:** `ImageReader::new(Cursor::new(bytes)).with_guessed_format().decode()` — аллоцирует `w×h×4` сразу. Нет проверки `bytes.len()` или `image_dimensions` до decode.
- **Почему баг:** Вредоносный `assets.content` (через compromised provider или plugin) может вернуть 10k×10k PNG — 400 MB декодированного, OOM на mid-tier Android (3-4 GB RAM). `AVATAR_DISPLAY_URI_MAX_CHARS` проверяется только **после** перекодирования в PNG, не до.
- **Фикс:** `if bytes.len() > 5_000_000 { return None; }` + `image::image_dimensions` check + `w*h > 4096*4096 → None`.

### P1-05 — Single-thread executor HOL blocking

- **Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/KernelHolder.kt:36` (`Executors.newSingleThreadExecutor()`), `PresentationChatActivity.kt:716-760` (`sendComposer` → `holder.executor.execute { pollStream(50) ×40 }`)
- **Что:** Все wire-вызовы (`chats.list`, `characters.list`, `assets.content`, `chats.get`, `messages.list`, `generation.start/poll/retry/prepend`) — в одной очереди. `sendComposer` занимает executor на до 2 сек (40×50 мс poll). `refreshFromRoute` тоже 40 polls.
- **Почему баг:** Если пользователь быстро скроллит (prepend) во время streaming, `prependOlder` ждёт конца send-poll-цикла — UI зависает (overlays не обновляются). Не ANR (не main thread), но `ChatSession` state не обновляется, скриншот-тест может флакнуть.
- **Фикс:** Отдельный `streamExecutor` для poll loop или `withTimeout`/кооперативная отмена через `AtomicBoolean`.

---

## P2 — minor (хрупкость, не краш)

### P2-06 — Emulator Vulkan detection по подстроке

- **Файл:** `crates/presentation-chat/src/vello_gpu.rs:207-214`
- **Что:** `info.name.to_ascii_lowercase().contains("goldfish"|"gfxstream"|"swiftshader"|"android emulator")`
- **Почему хрупко:** OEMы называют адаптер `Adreno (TM) 710` — OK, но если появится `SwiftShader 16.0.0` software fallback на реальном девайсе (редко, но бывает после driver bug) — пропустит. И наоборот, новый emulator `gfxstream` может переименоваться.
- **Фикс:** Проверять `info.device_type == Cpu` **и** `backend == Vulkan` как primary, подстрока — fallback.

### P2-07 — cssPx integer truncation

- **Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/MainActivity.kt:414-418` (`cssPx`), `PresentationChatActivity stashSafeArea`
- **Что:** `(physicalPx / density).toInt()` — truncation, не round. На density 2.625, 44 px → 16 px (16.76→16), ошибка 0.76 px.
- **Почему хрупко:** Glass ROI и `chrome_metrics` в Dioxus используют `round`, WebView safe-area — `toInt`, Rust safe-area — `top/scale` float — diff до 1 px. На `box-shadow` / `border-radius: 10px` — не заметно, но на `width: 60px` rail — может дать 1 px щель.
- **Фикс:** `((physicalPx / density) + 0.5f).toInt()` или `.roundToInt()`.

### P2-08 — ellipsize эвристика

- **Файл:** `crates/presentation-dioxus-shell/src/product_shell.rs:104-123`
- **Что:** `advance = fontSize * 0.52`, `maxChars = avail / advance`. Для Outfit Variable 20 px, 0.52 — средняя, но `W` шире, `i` уже. `character_manager_title` использует это для header title.
- **Почему хрупко:** На `viewport_css_width=1080` может дать 5-6 символов запаса vs React `text-overflow: ellipsis` (шейпер exact). Длинный title `Character Management Long Name` может обрезаться раньше/позже.
- **Фикс:** Либо delegation в `parley` measure, либо snapshot-тест title.

### P2-09 — Safe area race (late insets)

- **Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt:536-599`
- **Что:** `bindSafeAreaInsets` ставит listener на `decorView` и `root`, then `root.post { getRootWindowInsets }`. `flushSafeArea` вызывает `PresentationChatNative.setSafeArea` только если `nativeReady==true`. Первый `stashSafeArea` до `surfaceChanged` — дропается.
- **Почему хрупко:** Первый кадр после `onCreate` рендерится с `insets=0`, затем `surfaceChanged` + `post { requestApplyInsets }` — второй кадр с правильными. Пользователь может увидеть 1-frame jump rail/header (16 мс). Не краш, но jank.
- **Фикс:** Кэшировать `lastSafeArea` и `pushSafeArea` сразу при `nativeReady=true` (уже делает, но `synchronized(lastSafeArea)` копирует — нужно гарантировать `requestApplyInsets` до первого `present`).

### P2-10 — hasWebView рекурсия на decorView

- **Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/PresentationChatActivity.kt:1035-1047`
- **Что:** Рекурсивный обход всего дерева без `maxDepth`. На глубоко вложенном `FrameLayout` (хотя сейчас плоско) — stack overflow теоретически.
- **Почему nit:** Практически плоско, глубина 3-4. Но `logWebViewAbsence` вызывается на каждый `onCreate` + `talkback` trail — лишние логи.

### P2-11 — KernelHolder `isReleased` race на hot-restart

- **Файл:** `apps/android/app/src/main/java/com/neotavern/mobile/KernelHolder.kt:53-96`, `KernelHost.kt:25-42`
- **Что:** `release()` внутри `synchronized(lock)` ставит `released=true` + `executor.shutdown()`. `holder()` проверяет `!isReleased` вне `KernelHost` lock? Нет, `KernelHost.holder()` — `@Synchronized`, проверяет `h.isReleased` под lock. Но `acquire()` бросает `IllegalStateException` если `released==true` (проверка под lock). Hot-restart: `GenerationService` держит refcount 1, `MainActivity` финиширует, `PresentationChatActivity` ещё не `acquired` — race между `release()` (refcount 0 → shutdown) и новым `holder()` — может вернуть новый holder, но старый `GenerationService` ещё шлёт `poll` на старый executor (shutdown → `RejectedExecutionException`).
- **Почему minor:** Сейчас `GenerationService` использует тот же `KernelHost.holder`, refcount не уходит в 0 между activities (foreground service держит). Но при crash-loop (3 fails) — `resetGuards` + `armKillSwitch` может дойти до 0.
- **Фикс:** `KernelHolder` публичный `tryAcquire(): Boolean` или `KernelHost.holderOrNew` с try/catch.

---

## P3 — nit / debt

### P3-12 — `presentation-boundary.md` «M0 probe crates remain probes» — debt на документацию

Не баг, но каждый новый `crates/presentation-*` должен иметь `README.md` с purpose/inputs/constraints — сейчас только `neocompositor`, `chat-viewport`, `presentation-dioxus-shell` имеют.

### P3-13 — `allow(dead_code)` в `presentation-chat/src/lib.rs:25,31`, `android_surface.rs:114,116`

Подавляет warning, но скрывает неиспользуемый код (avatar_gpu debug paths). Лучше `#[cfg(feature = "gpu")]`.

### P3-14 — `Broad cleartext` — см. `10-SECURITY-VULNERABILITIES.md`.

---

## Сводная статистика

| Severity | Count | Файлов |
|---|---|---|
| P0 | 1 | 1 activity |
| P1 | 4 | 3 crates + 1 kt |
| P2 | 6 | 5 файлов |
| P3 | 3 | 3 файла |

Все P0/P1 требуют фикса до `production_cutover`. P2 — до `Milestone C PASS` (RFC §51). P3 — на debt backlog.
