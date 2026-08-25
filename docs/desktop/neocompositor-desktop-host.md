# NeoCompositor host — Windows/macOS (общий с Android)

Экспериментальный (non-production) десктоп-хост, который гоняет ровно тот же
продуктовый маршрут, что и Android-`SurfaceView` хост
(`crates/presentation-chat/src/android_surface.rs`):
`ProductWire → Dioxus → Blitz → NeoCompositor/presentation-session → vello →
swapchain`, только в нативном winit-окне. См. границы
[`docs/architecture/presentation-boundary.md`](../architecture/presentation-boundary.md)
и ADR-0038: это не production-вырезание, а исследовательский хост.

**Контракт порта применим и здесь:** никакого хардкода презентационных
констант, стили React не менять (CSS копируется из React-билда бит-в-бит,
бейки токенов — только в пакере), React — golden source, паритет измеряется
(раздел «Porting rules» в
[`presentation-boundary.md`](../architecture/presentation-boundary.md)).

## Принцип: один хост — везде

Android-хост `GpuSurface` платформенно-нейтрален **кроме одного входа** —
`wgpu::Surface` (Android строит её из `ANativeWindow`). Всё остальное — выбор
адаптера/устройства, смещение к non-sRGB `Rgba8Unorm` swapchain, Vello-storage
цель + sampled `resolve`-аккумулятор, фуллскрин-блит-пайплайн и `present` на
каждый vsync — не зависит от платформы.

`crates/presentation-chat/src/vello_gpu.rs::PresentSurface` — этот общий хост:

- `open(instance, surface, w, h)` — поиск адаптера (Vulkan в приоритете),
  `request_vello_device`, `plan_vello_target`, выбор формата поверхности
  (`pick_surface_format` предпочитает non-sRGB `Rgba8Unorm`/`Bgra8Unorm`),
  блит-пайплайн (тот же `BLIT_WGSL`, что в Android);
- `render(scene, base_color)` — GPU Vello-растр в storage → GPU-копия в `resolve`;
- `present(scroll, header, composer_top)` — фуллскрин-блит `resolve` → swapchain
  (зеркало Android `blit`);
- `resize(w, h)` — пересоздать цели, пересоздать блит-bind group
  (`rebuild_bind`) и сконфигурировать swapchain заново;
- `snapshot(path)` / `present_and_dump(path)` — диагностика: чтение `resolve`
  до блита и чтение бэкбуфера swapchain ПОСЛЕ блита (`--snapshot PNG` /
  `--swapchain PNG` у раннера). Всё — PNG-дампы, пригодные для гистограммы.

Десктоп-раннер — `crates/presentation-chat/src/bin/neocompositor-desktop.rs`
(feature `desktop-host = ["gpu", "dep:winit"]`, только Windows/macOS). Его
платформенный код — только winit-окно и `instance.create_surface(window)`;
кадры идут по Android-каденции: layout + Vello-растр один раз на `bind`/dirty,
дальше чисто composite-only переблиты на каждый present-кадр.

## Запуск

```bash
cargo run --release --manifest-path crates/Cargo.toml -p neotavern-presentation-chat \
  --features desktop-host --bin neocompositor-desktop -- --messages 12
```

**Интерактив — только release-сборка.** Каждый клик/скролл пересоздаёт сцену
(Blitz paint + vello-растр) синхронно на потоке событий. В debug-сборке это
~550 мс на апдейт (окно «туго»/лагает); в release — ~40–80 мс (холодный paint
после простоя чуть дороже, тёплый путь ~40 мс). Чинится сборкой, а не фокусом:
`cargo run --release`.

Флаги: `--messages <N>` — число сид-сообщений wire (по умолчанию 12);
`--w/--h` — начальный размер окна; `--pointer <x>,<y>` — один симулированный
тап в CSS-координатах через тот же pointer-pipeline, что и мышь (для снапшотов);
`--type "<text>"` — симуляция клавиатурного ввода в текущий focus;
`--snapshot <png>` — дамп `resolve`; `--swapchain <png>` — дамп бэкбуфера после
блита; `--dom-dump <json>` — дерево Theme SDK-хуков после layout
(`data-component` / `data-part` / `data-slot` / `data-role` / `data-action` +
CSS-px rects) для сравнения с React, см.
[`rust-ui-style-port.md`](rust-ui-style-port.md#dom-parity).

### Blueprint-хром (канонический по умолчанию с ADR-0056)

Внутренний хром чата — хедер, вьюпорт со строками сообщений и композер —
рендерится из встроенного канонического `UiBlueprintDocumentV1`: структура
(узлы, вложенность, порядок, действия) и презентация (лейблы, иконки,
токен-стили) читаются из JSON — правка документа меняет UI без
перекомпиляции. Полная петля правки (валидация, инструменты, гейты):
[`chat-ui-recipe.md`](chat-ui-recipe.md).

Приоритет источников: `--blueprint <path|embedded>` →
`NEOTA_CHAT_BLUEPRINT_DOC=<path>` → embedded-документ по умолчанию.
Safe-mode выход на рукописный RSX: `--legacy-chrome` или
`NEOTA_LEGACY_CHROME=1` (его же использует золотой capture-гейт).
Компактная высота (≤240 CSS px) рендерится из документа и закреплена
золотой строкой 900×220; overlay/nested — только M0 perf-probe сценарии
(не product UI), для активного blueprint-источника они кадрово уходят в
легаси с однократным уведомлением в stderr (ADR-0056).
Верификация release-артефакта — `pnpm blueprint:packaged-check`
(матрица дефолт/откат/приоритеты/битый-документ)
(без флага и без неё работает легаси-RSX). Канонический документ —
[`packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json`](../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json);
файл по пути перечитывается при изменении mtime; строки сообщений
разворачиваются из шаблона `chat-message` документа (действия
`parameter:"messageId"` привязываются к конкретной строке). Презентация
(классы, inline-стили, иконки) пока остаётся таблицей по стабильным node-id в
`presentation-dioxus-shell/src/scene_chat.rs`. Сломанный документ не роняет
чат — включается легаси-фоллбек. Паритет скелета (теги, хуки, действия,
геометрия ±0.5px) с легаси для всех трёх слотов закреплён тестом
`blueprint_chrome_skeleton_matches_legacy_rsx`
(`crates/presentation-chat/tests/compositor_host.rs`). Компактный режим
(<240 px высоты), nested-dialog и overlay-варианты chrome пока всегда рисует
легаси.

## Ввод (клик и скролл)

Окно кликабельно и скроллится:

- **Клик (левая кнопка).** winit-перо → CSS-координаты (`physical / density`) →
  `shell_hit::hit_test(shell_view, x, y)` — тот же hit-test, что на Android.
  Tap захватывается на `Down` (`PendingUi`), отменяется при сдвиге за
  16 CSS-px (как `try_push`), на `Up` применяется `ShellHit::Action` через
  `session.apply_shell_action` → dirty → перерисовка. Работают: рейл
  (menu-toggle, переключение панелей home/characters/personas/...), панель
  персонажей (карточки, табы cards/edit/advanced/gallery, фаворит, удаление,
  «назад»), диалоги создания/удаления, кнопка закрытия панели.
- **Вкладки AI Settings (API/Config) и Settings (General/Host)** —
  `catalog_panel_hit` в `shell_hit.rs` бьёт таб-ряд тех панелей, что не
  каталог списков, и отдаёт `SetTab` → сессия уже переключает `ai_tab` /
  `settings_tab` (проверено мульти-тапом: `SetPanel("providers") → SetTab("presets")`,
  `SetPanel("settings") → SetTab("host")`).
- **Каталог плагинов** — реальные строки `plugins.list` (FakeWire сидит 2
  демо-плагина) рендерятся React-честно: класс `st-card` (скин-примитив,
  который React даёт через `cx('st-card', styles.card)`) + структура
  `PluginsPage_cardHeader/pluginIcon/identity/cardMeta/sourceBadge/status`;
  `data-state` = статус (active/error по enabled), зелёная рамка включённого
  инлайнится из React-правила `.PluginsPage_card[data-state='active']`
  (в Blitz атрибутные селекторы ненадёжны). Card-клика в React нет — карточку
  и не делаем «выделяемой» (это была бы выдумка).
- **Колёсико мыши** над чатом — `session.scroll_chat_by(css_px)` поднимает
  виртуализированное окно вверх от низа (новое состояние
  `ChatRouteState.scroll_offset_css`, позиция clamp к протяжённости сообщений).
  Это идемпотентная добавка к Android-логике: там скролл идёт через
  BlitzSurfaceInput (dioxus hot-path), здесь — тот же результат через
  `virtualized_window`.

Проверка pipeline: бинарь принимает **несколько** `--pointer x,y` и реплеит их
последовательно (`tap ->` в логе; каждый следующий hit-testуется по состоянию,
мутированному предыдущим) — это харнесс для пошаговых сценариев панелей,
например `--pointer 30,370 --pointer 120,300` → `SetPanel("plugins")` +
каталог = 2 карточки. Одинокая проверка: `--pointer 30,175` на рейле → в логе
`tap -> SetPanel("personas")`, UI перерисовывается (hist дампа меняется:
113KB → 98KB).

## Панель Home/Chats: список чатов и переключение

Рейл-кнопка Home на десктопе открывает `ChatManagementPanel` поверх рабочего
пространства (как в React; на компакте ≤600 CSS-px нижняя навигация по-прежнему
возвращает в чат закрытием сайдбара). Панель рендерит реальные строки
`chats.list`: FakeWire сидит второй чат «Archived ideas» (2 сообщения,
последовательности с 0x40, чтобы производные id не пересекались с демо-чатом).
Структура и классы — из React-компонента:
`ChatManagementPanel_chatList/chatRow/chatLink/chatAvatar/chatCopy` +
`characterLabel`, `data-state="active|idle"` у открытого чата. Тап по строке →
`ShellAction::SelectChat` → durable `chats.get` + `chats.messages.list`:
сообщения и счётчик шапки меняются на живом окне (`kernel_messages 12 → 2`),
скролл сбрасывается, список перечитывается.

Кнопка «New chat» (`newChatAction`) — React-кнопка `st-button`
primary/sm с Plus-иконкой (`chat:newChat`): тап → `ShellAction::CreateChat` →
durable `chats.create` на закреплённого персонажа → список перечитывается,
свежий чат открывается в рабочем пространстве (`kernel_messages=0`).

Поиск-тулбар (`.toolbar` / `.searchControl`, placeholder `chat:searchPlaceholder`)
фильтрует строки по заголовку на клиенте — как React `searchInput`. Фокус
поля — bin-local (как поиск персонажей): тап в полосу поля ставит
`TextFocus::ChatSearch`, клавиатура/`--type` идут в `session.set_chat_search`.

Хит-тест панели откалиброван по живому рендеру (цветовое картирование
снапшота 1100×760, x=250): собственный `SidebarPanelHeader` панели добавляет
высоту над контентом, поэтому якоря взяты из измеренных пикселей — поле
[86,130), кнопка [146,190), строки списка с 198 с шагом ~76+4px (высота
строки определяется контентом chatCopy: strong + span + characterLabel).
Это измеренные артефакты рендера; при смене шрифта/масштаба их нужно
переснять.

## Клавиатурный ввод (фокус → композер / поиск)

Winit-клавиатура подключена (бинарь): тап по композеру (`slot:chat.composer`)
или по полю поиска Character Manager (`component:text-field+part:search`)
ставит bin-local `focus` (`TextFocus::{Composer, CharacterSearch, …}`), затем
символы и Backspace идут в `session.set_composer_text` /
`set_character_search` (вью-модель уже владела этими строками — не хватало
только событий). Харнесс `--type "<text>"` воспроизводит ввод после тапов,
установивших фокус:

- композер: `--pointer 700,650 --type "hello"` → `typed … -> composer="hello"`;
- поиск персонажей: `--pointer 200,190 --type "zzz"` → `search="zzz"` и в логе
  `characters=0` — живой фильтр сетки (пустое состояние вместо карточек).

Фокус очищается тапом в любую другую точку. Клавиатура/фокус — пока bin-local
(не переносится в общий `PresentSurface`), как и скролл-колёсико.

### Hit-rects: геометрия из layout, не из «измеренных полос» (M1)

Все тапы и фокусы десктоп-хоста резолвятся через
`presentation_chat::hit_rects::HitRects` — снапшот прямоугольников всех узлов
с Theme SDK-хуками, снятый с того же Blitz/Taffy layout-прохода, который
нарисовал кадр (`sess.slot_skeleton()`). Приоритет — верхний по порядку
отрисовки; кнопки сообщений несут владельца через `data-message-id`
(`SlotNode.key`). Ручные пиксельные бэнды удалены:
`composer_band()`, зоны Send/Settings/Reset, оффсеты `-32/-64/-96/-128`
кнопок сообщений, координатные бэнды обоих поисков.

**Единая таблица решений для всех хостов:** `hit_rects::resolve_tap()` →
`TapIntent::{Quick(Send|ComposerSettings|ComposerReset|ScrollLatest),
MessageCopy{row_id}, MessageDelete{row_id}, None}` — десктоп-бин и Android
(`try_push`/`presentFrame`) исполняют одни и те же интенты против одной и той
же `ChatSession`, поэтому поведение идентично ПК-версии. Общий press-slop —
`presentation_chat::TOUCH_SLOP_CSS` (16 CSS px). Регрессионные тесты:
`hit_rects::tests::resolve_tap_maps_the_shared_decision_table`,
`compositor_host::hit_rects_resolve_actions_from_layout_not_bands`.

Ограничение (честно): `MessageCopy` на Android пока пропускается
(`copy_skipped reason=clipboard_bridge_pending`) — моста на системный
ClipboardManager ещё нет; delete/send/settings/reset/scroll работают.
Панельные списки/табы Character Manager остаются на `shell_hit`-регионах до
переноса экранов на blueprint (M2).

## Контекст-метр композера (ContextUsagePanel)

Триггер `composer-context` (иконка Database + процент в правой группе
тулбара) открывает popover `context-usage-panel` — паритет React
`ContextUsagePanel`: сводка (заголовок «Draft estimate», `prompt / limit`),
метрики 2×2 (usage %, available, prompt tokens, reserve) и разбивку из пяти
категорий (history/world info/character/persona/other) с пропорциональными
заливками.

Плоскость харнесса не имеет prompt-аудита, поэтому панель всегда в состоянии
черновой оценки (React `isExact: false`): история + draft считаются
скрипт-осознанным оценщиком (`session.rs::estimate_tokens`, порт
`packages/shared/src/estimateTokens.ts`), лимит = `CONTEXT_TOKEN_DEFAULT`
(16 032), резерв = 4 000; вся сумма попадает в `chat_history` — ровно как в
fallback-ветке `summarizeContextUsage`. Точная аудиторная сводка приходит из
Kernel `prompt.context.preview` на упакованном хосте.

Механика: узел `composer-context-panel` живёт в blueprint-документе между
toolbar и field; видимость решает рендерер (`render_context_panel_slot`,
общий для blueprint- и legacy-хрома — контракт скелет-паритета требует узел в
обоих деревьях). Закрытая панель = `display:none` (пустой блок занимает
строчный бокс и сдвигает композер). Тап — `QuickIntent::ComposerContext`
(hit-rects → `ChatSession::toggle_context_panel`), display-only состояние,
Wire-команды не создаёт. Композер при открытой панели переключается на
content-driven `min-height` (закрытый держит фиксированную высоту — taffy
распределяет внутренний flex по-разному между `height`/`min-height`, что
уводит goldens на несколько px).

## Панель лорбуков: записи (LorebookPanel EntriesTab)

Порт React `LorebookPanel` вкладки Entries: у выбранного лорбука (таб
`entries` после `SelectLorebook`) вместо пустой заглушки теперь рендерится
тулбар (Back to books / Add entry), подсказка и список строк
(`data-part="entry-row"`, высота 64 px, строки: ключ-заголовок, сниппет
контента до 120 символов, бейджи Constant/Selective) с row-действиями в
правых 132 px: switch enabled (36×20, тап → `lorebooks.entries.update`),
edit (PencilSimple), delete (Trash).

Данные — реальный Wire: `lorebooks.entries.list` грузится при входе во
вкладку; демо-лорбук (`DEMO_LOREBOOK_ID`, «Kestrel Vales») в `FakeWire`
получил две записи, чтобы панель показывала настоящие строки. EntryDialog
(Add/Edit entry, 400×520, геометрия зеркалит `shell_hit::dialog_hit`) —
поля Keywords/Secondary keywords/Content + свитчи Always include
(constant), Selective (primary + secondary match), Enabled; сохранение —
`lorebooks.entries.create` / `lorebooks.entries.update`, удаление — диалог
подтверждения и `lorebooks.entries.delete`; счётчик книги (`entry_count`)
следует за записями. Счётчик токенов в диалоге — скрипт-осознанный
`estimate_tokens` (тот же порт, что у контекст-метра). Wire-DTO записи не
несёт позицию/метаданные (kernel-owned), поэтому поля position в форме
честно нет.

## Настройки → Профили (ProfilesPanel)

Порт React `ProfilesPanel` во вкладке Profiles панели Settings: вместо
статичной заглушки («Active profile: Built-in») теперь реальный CRUD над
Product Wire — список грузится через `profiles.list` при открытии панели
настроек, демо-плоскость `FakeWire` сеет профили «Main» и «Caravan».

Инлайн-форма создания (поле `data-part="profile-create-name"` + кнопка
Create) уходит в `profiles.create`; строки списка (`data-part="profile-row"`,
64 px) несут действия в правых 132 px: export (`profile.export`, SEC-02 —
Kernel строит контейнер и возвращает верифицированный отчёт; тост показывает
честные счётчики characters/chats/messages), rename (инлайн-режим: поле
`data-part="profile-rename-input"` + Save/Cancel, `profiles.rename`), delete
(диалог подтверждения 300×200, `profiles.delete`; персонажи остаются
непривязанными — ничего не удаляется). Импорт — честная подпись без поля
пути: пикером владеет упакованный хост.

Геометрия вью-модели зеркалится между `settings_tab.rs::profiles_tab` и
`shell_hit.rs::profiles_hit` (label 16 + gap 8 → create row 36; import-блок
104; заголовок списка 40; строки 64 + 4) — как у записей лорбука. Фокус
клавиатуры: `TextFocus::ProfileCreateName` / `ProfileRename` в desktop-бине
резолвятся по `data-part` из rects, ввод идёт в сессионные setter'ы.

## Плагины: жизненный цикл (plugins.enable / disable / uninstall)

Каталог плагинов (`plugins.list`) получил реальные lifecycle-действия:
карточка (112 px, фиксированная геометрия, зеркалит `shell_hit.rs::plugins_hit`:
subtitle 28, contained-заметка 56, install-бар 36, мета 20, карточки 112 + 16)
показывает статус (Active/Disabled, рамка `#63c98d` у активного), строку
разрешённых permissions и нижний ряд действий: switch (36×20, тап →
`plugins.enable` / `plugins.disable` по текущему состоянию, ответ — обновлённый
ряд) и uninstall (Trash) с диалогом подтверждения 320×220
(`plugins.uninstall`, тост «uninstalled»).

Safe mode (`error_code == SAFE_MODE`) отключает все lifecycle-действия —
React на safe-mode-странице тоже всё блокирует. Установка остаётся честным
задизейбленным контролом (пикер — упакованный хост); Frontend-слоты плагинов
по-прежнему CONTAINED в WebSurface (ADR-0054), карточка — только Wire-каталог.

## Чаты: переименование и удаление (ChatManagementPanel)

Панель Home/Chats получила rename/delete (React `ChatManagementPanel`):
каждая строка чата (76 px, измеренная геометрия, зеркалит
`shell_hit.rs::chats_hit`) несёт действия в правых 88 px — rename
(PencilSimple, диалог 320×220 с полем `data-part="chat-rename-input"` +
Save/Cancel, `chats.update` с `title`) и delete (Trash, диалог 300×200,
`chats.delete`). Пустой заголовок закрывает диалог без Wire-вызова (no-op
guard React). Если удалён открытый чат, сессия сбрасывает workspace-состояние
(chat/messages/draft), чтобы следующий refresh не упёрся в CHAT_NOT_FOUND —
React при этом навигирует прочь. Список перечитывается через `chats.list`,
тост «Chat renamed.» / «Chat deleted.». Фокус клавиатуры — `TextFocus::ChatRename`.

## Панель плана промпта (PromptPlanPanel)

Триггер — per-message footer-действие «Prompt plan» (TextAlignLeft) на строках,
чей `generation_run_id` установлен (React `MessageDetailsCardV2` гейтится по
`meta.generationRunId`); кнопка добавлена в blueprint-документ
(`message-action-prompt`, action `chat.message.prompt`) и в legacy RSX с тем же
условием — skeleton-parity сохранён. Диалог 640×560 (`shell_hit::dialog_hit`:
backdrop/close → `ClosePromptPlan`, тело Absorb) рендерит четыре состояния React
`PromptPlanPanel`: ошибка (`role=alert`, `isError`), «This run has no recorded
prompt plan.» (`PROMPT_PLAN_NOT_FOUND` → null, как в React-хуке), и контент плана
(`generation.prompt.plan` — одноразовый запрос/ответ, без SSE): мета-dl
(Model/Instruct format/Tokenizer±approximate/Tokens: Input · Response reserve ·
Context limit), over-budget-алерт, секции System blocks / Selected messages
(`data-role`), Excluded from context (всегда; пустая → «Nothing was excluded.»,
`token_budget` → «Removed by token budget»). FakeWire записывает durable-план
при старте генерации (зеркало kernel `prompt_plans`), `chats.delete` чистит
планы чата. Тест `prompt_plan_over_product_wire`.

## Фоны (BackgroundsPanel)

У фонов нет Product Wire-операций: kernel-плоскость честно пуста (React
`useBackgrounds` возвращает `{ items: [] }`, upload/delete — `UnsupportedError`),
а каталог живёт на legacy-контуре `/api/v2/backgrounds` (docs/api/README.md).
Панель поэтому — честное пустое состояние React: hint «PNG, JPEG, WebP or GIF.
Originals stay on this device.», empty state «No backgrounds yet», и **включённая**
кнопка «Upload background» (`data-part="backgrounds-upload"`, variant primary) —
как в React: нажатие не выдумывает Wire-операцию, а повторяет kernel-plane
`UnsupportedError('backgrounds.upload')` → `CAPABILITY_UNAVAILABLE`
(`ShellAction::UploadBackground` + `backgrounds_hit`). Сам wallpaper-слой
(`data-part="chat-wallpaper"`) уже рендерится в legacy-хроме workspace
(прозрачный — изображения нет); apply/delete/context menu при пустом каталоге
недостижимы. Тест
`backgrounds_panel_is_honest_empty_and_upload_reports_capability_unavailable`.

## Темы (Settings → ThemesTab)

Каталог тем живёт на Product Wire (`themes.list` / `activate` / `deactivate` /
`uninstall`; React `ThemesPage` + Settings `ThemesTab`). Вкладка Settings →
Themes теперь реальная: открытие вкладки грузит `themes.list`; строки тем
(64 px, `data-part="theme-row"`, `data-state=active|inactive`) показывают
name / id · vversion · trustState и несут Apply (96 px, `themes.activate`,
ответ = ThemeDto с `active: true`) и delete (диалог 300×200,
`themes.uninstall`, тост «Removed ….»); активная тема показывает бейдж Active и
инертна; пока тема активна, над списком есть «Use built-in theme»
(`themes.deactivate`, «Restored the built-in theme.»). Активный id прокидывается
на корень шелла как `data-theme-id` (React `applyInstalledTheme` ставит
`data-theme-id` на `<html>`); токены остаются на упакованной dark-теме — в этом
порте нет механизма подмены `--st-*` переменных. Установка — host-side
возможность: React kernel-плоскость отклоняет её `UnsupportedError
('themes.install.host-verify')`, порт повторяет это честной ошибкой
`CAPABILITY_UNAVAILABLE` (`ShellAction::InstallTheme`, без выдуманной
`themes.install`-операции — она есть в реестре, но на этой плоскости не
достижима). FakeWire: `themes` (wii-u-dark verified-publisher / kde-plasma
locally-trusted, зеркало `THEME_VALUE`), `THEME_NOT_FOUND` для неизвестных id.
Тест `themes_catalog_activate_deactivate_uninstall_over_product_wire`.

## Секреты (Settings → SecretsTab)

Вкладка Settings → Secrets читает `secrets.status` при открытии (React
`useSecretsStatus`, `staleTime: 30_000`) и рендерит React `SecretsPanel`:
заголовок + hint, карточку режима (`data-state=kind`: Portable encrypted /
Machine-bound (environment) / Session-only / Secret storage unavailable с
честными hints), флаги Persistent/Writable/Available/Stored records/Portable
format (vN), locked-hint при `available=false && kind=portable`, кнопку
«Lock now» (`data-part="lock-secrets"`) только для доступного portable-хранилища
(React `canLock`) и no-reveal-ноту. Значения секретов никогда не рендерятся —
DTO value-free по контракту. Lock (`secrets.lock`) перечитывает статус (React
инвалидирует query) — хранилище честно показывает `available=false`; без
подключённого хранилища (`kind == "unavailable"`) lock падает честным
`CAPABILITY_UNAVAILABLE` (kernel `secrets.rs`), как fail-closed. FakeWire:
статус portable (зеркало `SECRETS_STATUS_VALUE`) в demo(), unavailable в
default(). Тест `secrets_status_and_lock_over_product_wire`.

## Инструменты (Settings → ToolsTab)

Вкладка Settings → Tools читает `generation.tools.list` при открытии (React
`useGenerationTools`) и рендерит `ToolsPanel`: заголовок «Tool registry» + hint
(«The kernel validates provider tool calls against them but never executes tools
itself…»), затем строки `data-component="tool-entry"` — Wrench + name,
description (или «No description provided.») и `data-part="tool-required"` с
обязательными аргументами из `inputSchema.required` («Requires: city») либо
«No required arguments.». Аргументы и результаты никогда не попадают на эту
поверхность; пустой реестр — успех, не ошибка (kernel `generation_tools_list`):
честное «No tools registered by this host.». Поверхность read-only — других
tools-операций в UI нет (`generation.tool.result` — Этап 4). FakeWire: реестр
с фикстурой `TOOL_SPEC_VALUE` (lookup-weather) в demo(), пустой в default().
Тест `tools_registry_list_over_product_wire`.

## Отправка сообщения (Send)

Композер (`data-part="composer"` в `product_chat_app`) получил кнопку **Send**
(`st-button`, реальный класс React-шита) у правого края бар. Десктоп-хост при
этом отдаёт сессии **честную ширину чат-вьюпорта**: с открытым сайдбаром на
некомпактном окне это `window - rail(60) - panel(380)` (раньше передавалась
вся ширина окна, и чат-workspace 1100px уезжал за экран — композер/заголовок
клипались). `ChatSession::sidebar_open()` — новый геттер для этого решения.

Полный сценарий «фокус → ввод → Send» проверяется харнессом (опы тапы/ввод
идут в порядке аргументов):
`--pointer 700,720 --type "hello" --pointer 1050,724` →
`typed … -> composer="hello"`, `composer send tapped`,
produced `kernel_messages=14` (было 12 — durable-сообщение создано
через `chats.messages.create`), кнопка видна в снимке (текст `#d7e3f0` у
правого края полосы).

## Phase C: тосты и модалки

**Тост (`status_message`).** Сессия уже ставила `status_message` на успешные
действия (создание/удаление персонажа/персоны/лорбука и т. п.). Хост это
поднял до жизни: вью-модель рендерит полоску внизу-слева
(`data-component="toast"`, `role="status"`), а бинарь авто-скрывает её через
`status_shown_at` + `clear_status_message()` (таймер 3.5 c, polling ~10 Гц пока
тост жив). Визуал — бейк `.st-card` (фон `#292522` / рамка `#39342f` / радиус
16 / тень `rgba(0,0,0,.35)`) + текст `#f3eee8`: в React-сборке нет CSS
продуктового тоста, поэтому это документированный waiver (см. parity-заметки в
`presentation-boundary.md`).

**Модалки (создание/удаление персонажа) — теперь реально рендерятся.** Диалоги
живут у корня shell (сабдерево панели клипается `overflow:hidden`-предком).
Геометрия — по JSON-токенам React (`CharacterManagementPanel_createForm`,
`_dialogActions`), центрируется над чат-областью тем же расчётом, что
`shell_hit::dialog_hit` (`chat_x0 = rail(60) + panel(380)` на некомпактном
окне). В join-верификации: снапшот с открытым диалогом добавляет ~35 path к
сцене и ~108k px поверхности `st-card` в ректе [610..930]x[200..560].

Два Blitz-сюрприза, найденных и задокументированных здесь (важно для
любого будущего UI-элемента у корня shell):

1. **Вызов компонента (`{fn(...)}` / `fn()` внутри `if`/`then`) в дереве RSX
   этого хоста дропается.** Работают только инлайн-условия с инлайн-маркапом
   (`if cond { div … }`) и прямые слоты `{ fn() }` БЕЗ условной обёртки.
   Поэтому модалки развёрнуты инлайном у корня, а не через helper-функцию.
2. **`.dialog-overlay`-атрибут из React CSS убивает inline-геометрию.** Пакер
   копирует `[data-component='dialog-overlay'] { position:relative; inset:0;
z-index:1000 }`; в каскаде Blitz это правило перебивает inline
   `position:absolute; left:610px; …`, и диалог схлопывался/терялся (0 px diff
   против «без диалога» при любых вариантах). Решение: на позиционируемом боксе
   НЕ ставить `data-component="dialog-overlay"/"dialog-content"` — поверхность
   даёт инлайн-бейк `.st-card` + inline-геометрия, как у тоста.

**Сценарий создания через харнесс** (тапы/ввод в порядке аргументов):
`--pointer 100,150 --pointer 700,250 --type "Memo" --pointer 830,530` →
OpenCreate → фокус Name-поля → ввод (create_name = «New characterMemo») →
ConfirmCreate → `characters=2` (durable через wire), тост «Character created.»
показывается и авто-гаснет (второй produced следом). Хит-тест полей/кнопок
диалога синхронизирован с геометрией рендера (`dialog_hit` в `shell_hit.rs`
отдаёт Confirm/Close по половинам action-ряда, внешний тап — Close).

## Паритет бабла сообщения: хедер, markdown-отступы, плейсхолдер

Сверка со скриншотом React-приложения вскрыла три видимых расхождения — все
закрыты значениями из React-источников:

1. **Хедер сообщения** (`MessageBubble` header): над контентом строка
   `message-header` → `message-author` (assistant → имя закреплённого
   персонажа, user → «You») + `message-timestamp` (en-US Intl-лейбл RFC3339:
   «Aug 12, 2026, 10:00 AM»; нераспознанная форма → элемент не рендерится,
   как условный `<time>` в React). Токены: sm=0.8125rem(13px),
   xs=0.75rem(12px), primary #f3eee8, muted #998f87.
2. **Markdown-отступы**: упакованный лист содержит правила
   `.MessageMarkdown_root > … p/ul/li/code/strong/em/q`, но Blitz не матчит
   child-combinator `>` и не применяет HTML UA-дефолты (p/ul/li текут
   инлайн) — блоки слипались («msg 1item onecode»). Значения правил и явные
   `display:block` / `display:list-item` забейкены инлайн на элементы
   (паттерн диалогов): p/ul/ol margin 0 0 8px (:last-child 0), заголовки
   12/8 + #f3eee8 700, blockquote с левым бордером #e8943a, code #c5bbb2 на
   #302c28 (radius 10, mono), em #919191, q #e8943a, ссылки #f0a07d; спискам
   отданы UA-дефолты (padding-left 24, disc/decimal). Верификация — прямым
   осмотром снапшота: абзац, пункты списка и код-пилюля читаются отдельно.
3. **Плейсхолдер композера**: был жёсткий «Message», стал React
   `home:composerPlaceholder` с именем персонажа — «Message Hazel…».

4. **Тёплая тема чата (значения из упакованного листа и токенов)**:
   рабочая область `#1b1917` (`--st-color-surface-primary`), шапка/композер
   `#24211e` (surface-secondary), обои-пробник `#302c28` (tertiary). Баблы —
   по правилу `data-chat-style='paragraphs'`: ассистент `rgb(38,34,31)` с
   бордером `#39342f`, пользователь `rgb(54,34,27)` с бордером
   `rgb(105,76,61)` и `margin-left:auto`; оба `border-radius:16px`,
   `width:fit-content; max-width:78ch; padding:8px 12px`, текст
   `#f3eee8`. Композер: плейсхолдер приглушён `#998f87`
   (`--st-color-text-muted`), при вводе — primary; Send — primary-кнопка
   `#e38a62` / текст `#2a130b`, radius 10. Иконки действий — muted.
   Плейсхолдер asset-картинок перекрашен в tertiary + border (был холодный
   синий). M0-пробник overlay/nested-dialog больше не включается сессией:
   chrome всегда `HeaderComposer` (React-хром = шапка + композер);
   `TripleGlass`/`PaintOrder` остались для perf-probe сценариев.

Дополнено тем же проходом:

- **Аватары персонажа в чате**: `ProductChatView.character_avatar_asset`
  (asset id закреплённого персонажа) рендерит стандартные слоты
  `avatar-fallback` — 32px в шапке чата (класс `headerAvatar`, заголовок
  сдвигается на 40px) и 20px в хедере ассистентских сообщений; поверх слотов
  существующий GPU-оверлей рисует реальные тумбнейли (`image_paints_from_layout`
  красит любой узел с непустым `data-avatar-asset`). Справа в шапке — иконка
  поиска (MagnifyingGlass 17, muted).
- **Табы панели наверх**: упакованный css протекал `order:1`
  (`[data-component='tabs-content']`) не на тот узел, и Blitz ставил
  tabs-list ПОСЛЕ контента (замер `tab_debug_rects`: список был на y=674 при
  контейнере y=61). Инлайн `order:0` на списке / `order:1` на scroll-content
  - `position:static;z-index:0` дают порядок React: шапка → табы → тулбар →
    поиск → список. Диагностика осталась в `tab_debug_rects` (m0-d2) и тесте
    `tab_rects_debug_dump`.

- **`asset:`-изображения в markdown** рендерятся блоком `message-image`
  (раньше схема не принималась `split_images` и сырой текст фото-ссылки шёл
  в бабл; дублирующий спан из lib.rs убран). Реальные текстуры thumbs —
  следующий шаг, сейчас честный плейсхолдер-блок.
- **Автор резолвится во всех путях** видимых рядов — включая ранний выход
  виртуализации (`extent <= viewport` → fallback `visible_rows`), где раньше
  проскальзывал fallback «Assistant» вместо имени персонажа.
- **Структурная верификация**: `ProductPaintLayout` получил пробы DOM —
  `markdown_code_nodes`, `markdown_image_blocks`, `author_css_width`; тесты
  `chat_markdown_structure_reaches_the_blitz_dom` и `markdown_minimal_probe`
  проверяют, что code/image узлы и резолвленный автор («Hazel», ~34 CSS px,
  а не fallback ~60px) реально доходят до Blitz DOM, а не только до парсера.

Верификация: юнит-тест `message_rows_carry_react_header_and_composer_placeholder`;
живой дамп — баблы выросли 46→69 CSS-px (хедер + отступы), в вьюпорте есть
пятна code-фона #302c28 и primary-текста #f3eee8.

## Действия у сообщений: copy + delete, «лайка» в React нет

Инлайн-ряд действий сообщения — это React `MessageBubble` header
(`apps/web/src/components/messageActions.ts` — единый источник id, порядка,
иконок и labels). Замер по golden-исходнику даёт честные выводы:

1. **«Лайк» в React не существует.** Канонический ряд
   `BUILTIN_MESSAGE_ACTION_ORDER` = context, edit, copy, regenerate, history,
   checkpoint, branch, delete-checkpoint, delete, rollback — кнопки «like» нет,
   и `MessageDto` не несёт поля liked. Изобретать её нельзя (портинг-правила),
   поэтому она не портируется — это измеренный waiver, а не пропуск.
2. **Copy — настоящий builtin** (`data-action="copy"`, иконка `Copy`, label
   `chat:copyMessage`). Он портирован: каждая бабл несёт
   `data-part="message-actions"` с кнопкой у правого верхнего угла; хит-тест
   берет ректы рядов из paint-layout (`ProductPaintLayout.messages` по
   `data-message-id`) — те же window CSS-px, что и pointer-pipeline. Запись в
   OS-клипборд — capability хоста (`arboard`, только `desktop-host`): общий
   `PresentSurface` остаётся OS-нейтральным (на Android это будет сервис
   клипборда). После успешной записи сессия показывает честный тост «Message
   copied to clipboard.» (авто-гаснет, как остальные).
3. **Delete — второй подключённый builtin** (`data-action="delete"`, иконка
   `Trash`). Тап идёт в durable `chats.messages.delete`
   (`RequestDeleteMessage{chatId,messageId}`), сообщение уходит из стора
   FakeWire и из кэша сессии, счётчик чата декрементируется, тост «Message
   deleted.». FakeWire отвечает `MESSAGE_NOT_FOUND` на чужой id.
4. **Rollback — третий подключённый builtin** (`data-action="rollback"`,
   «Rollback to here»). Тап идёт в durable `chats.snapshots.rollback`
   (`RequestSnapshotsRollback{chatId,toMessageId}`): стор удаляет всё ПОСЛЕ
   цели (более высокие sequence), сама цель остаётся и становится хвостом;
   видимое окно перестраивается из авторитетного стора (цель может лежать вне
   закэшированной страницы), счётчик чата уменьшается на `result.deleted`,
   тост «Chat rolled back (N messages removed).». FakeWire отвечает
   `MESSAGE_NOT_FOUND` на чужой id; checkpoint-child пока не создаётся
   (`checkpointChatId` честно отсутствует). E2E: `--pointer 938,339` →
   `rollback tapped`, `kernel_messages 12 → 4`.
5. **Regenerate — version-controls builtin подключён** (`data-action="regenerate"`).
   Тап идёт в durable `generation.retry`
   (`RequestRetryGeneration{sourceRunId}`) с СОБСТВЕННЫМ source-run строки
   (`MessageDto.generation_run_id`) — регенерируется именно этот ответ, а не
   безусловно последний. Строка без сохранённого run даёт честный
   `GENERATION_RUN_NOT_FOUND`. FakeWire добавляет перегенерированный ответ в
   хвост ("retry of …"); вариантные/ревизионные замены остаются за kernel.
   Тест: `regenerate_retries_the_row_source_run`; e2e: тап по кнопке →
   `kernel_messages 12 → 13`.
6. **Swipes — version-controls builtin подключены**
   (`data-action="swipe-previous"` / `"swipe-next"`). Тап идёт в
   `chats.messages.variants.list` + `.activate`: активированный вариант
   становится контентом сообщения (kernel-семантика), видимое окно
   перестраивается из авторитетного стора; тост «Variant N of M.», на краях —
   «No more variants.» без смены контента. Позиция выводится из совпадения
   контента строки с вариантами (позиция 0 = оригинал). FakeWire сидирует 3
   варианта у хвостового ответа демо-чата; `variants.create/delete` в
   FakeWire пока не реализованы (свайпам не нужны). Тест:
   `swipes_cycle_variants_and_stop_at_edges`; e2e: тап → paths растут,
   `kernel_messages` неизменен. History (revisions) остаётся honest-skip —
   у нэйтива пока нет поверхности для списка ревизий.

Остальные builtin-действия (edit/checkpoint) теперь рисуются в
инлайн-ряде для визуального паритета с React; подключённые к поведению —
copy, delete, rollback, regenerate и swipes. Edit / snapshots / history
остаются waiver.

**Распознавание (M1/M2):** общая таблица решений `hit_rects::resolve_tap`
классифицирует ВСЕ задокументированные действия строки —
`context/edit/copy/checkpoint/branch/delete/rollback` + version controls
`history/regenerate/swipe-previous/swipe-next`. Кнопки version controls не
несут собственного `data-message-id`; их владельцем становится ближайший
ключевой предок из skeleton-цепочки (`effective_key`), поэтому тап по
регенерации всегда знает свою строку. Не подключённые к поведению виды
логируются честно (`not wired yet` / `not_wired_yet`) и никогда не
срабатывают вслепую; un-keyed действие без ключевого предка отбрасывается.

Верификация end-to-end (снапшот + реальный клипборд ОС):
`--pointer 1032,100` (copy первого сообщения) → в логе
`message … copied (25 chars) to clipboard`, `Get-Clipboard` возвращает текст
сообщения (его markdown-строка с asset-thumb ссылкой), тост виден в дампе.
`--pointer 1068,100` (delete того же ряда) → `kernel_messages 12 → 11`, тост
«Message deleted.». Тапы харнесса реплеятся после прогревочного layout-прохода:
геометрия рядов существует до первого хит-теста.

## Честные ограничения (чего НЕТ)

- Drag-скролл инерцией и мультитач: десктоп использует колёсико +
  `scroll_offset_css` (без физ.инерции); пёрышко-инерция Android — через
  `ChatCompositor::compositor_tick`, не перенесено.
- Из builtin-действий сообщения портированы copy (реальный клипборд хоста) и
  delete (durable `chats.messages.delete`). Edit / checkpoint / rollback
  рисуются в инлайн-ряде для визуального паритета с React `messageActions.ts`,
  но пока не меняют Kernel-состояние (нет inline-editor / snapshots).
- Wallpaper — светлая плоскость фасада + тёмный overlay, не фото React
  golden (фото-ассет в хост не бандлится). `backdrop-filter` Blitz не
  умеет; панели полупрозрачные через `rgba`, не live glass.
- Device insets (статус-бар/вырез) — Android-only, пока десктопная сессия не
  учится отдавать физические insets.
- Swapchain живёт на `Rgba8Unorm` (non-sRGB) по замыслу — как на Android;

## React chrome: composer, resize, wallpaper

Десктопный split больше не вычитает `60+380` из `set_surface_size`. Окно
целиком — CSS viewport; `is_compact` считается по ширине окна, а не по
остатку после панели (иначе окно ~900 CSS-px прятало чат). `main` —
`flex:1`, чат-workspace — колонка 100%×100% (шапка / вьюпорт / композер),
а не абсолютные px от урезанной ширины.

- **Свернуть меню**: `ToggleRail` / кнопка close панели ставят
  `sidebar_open=false`; рейл 60px остаётся, чат расширяется.
- **Drag-to-resize**: `panel_width` в сессии, хит-зона 8px на правом крае
  панели (`data-part=resize-handle`), clamp 260–720 как
  `--st-shell-panel-min-width` / `--st-shell-panel-max-width`.
- **Composer**: toolbar Settings / Reset / «4%», поле с placeholder
  `Message Hazel…`, нижний ряд List / ArrowDown / MagicWand, Send +
  `PaperPlaneRight`. Settings открывает панель settings.
- **Демо-каталог**: Hazel, Seraphina, Vayle в `FakeWire::demo` и
  `with_message_count`. `character_catalog` по-прежнему один Hazel
  (тест «characters without a chat»).

## Аватарки персонажей (GPU-оверлей — теперь общий)

Аватар в shell-дереве — всегда только заглушка-буква (`data-part`=
`avatar-initial`): Blitz/paint-путь не несёт пикселей (`data:` URI в Dioxus
дереве нет). Реальная картинка монтируется на GPU поверх `resolve` через то же
`AvatarGpu`, что на Android, и теперь доступно и в `PresentSurface`:

- сессия тянет thumb через Product Wire `assets.content`
  (`refresh_characters` → `hydrate_character_avatars`);
- `PresentSurface::upload_avatar` кладёт премультипленные 192×192 cover-thumbs
  в GPU-кеш (`AvatarGpu`, LRU);
- `image_paints_from_layout(sess.paint_layout(), density, ready_token)` собирает
  ректы `data-avatar-asset` (header 44 / card 48);
- `PresentSurface::composite_avatars` рисует их в `resolve` ДО блита в
  swapchain — бит-в-бит логика Android `overlay_avatars` /
  `composite_avatar_overlay`. `ProductVelloSession::paint` пересобирает
  `paint_layout` каждый кадр, так что при переключении панелей ректы не
  застаиваются (персона-панель: `avatars=0`).

Верификация: снапшот содержит портретные тона демо-аватара (`avatars=2`);
синтетическая полоска-заглушка исчезла. Демо-ассет `assets.content` в
`FakeWire` — настоящий портрет Hazel (1024×1536 из
`apps/server/data/files/avatars/`, даунскейл 192×288 через `include_bytes!` +
runtime-base64), раньше был прозрачный 1×1 («картинки не было вовсе»).
sRGB-перекодировка в шейдере блита, если цель sRGB.

## Десктопный split-layout (важная правка Blitz-compat CSS)

При старте на широком окне (non-compact > 600 CSS-px) чат рисовался пустым —
чистый `#151311`-холст («коричневый фон»). Причина: в Blitz-compat-сабсете
AppShell
`crates/presentation-design-system/scripts/pack_design_system.py` лежали
компактные оверрайды `.AppShell_shell[data-sidebar='open'] .Sidebar_sidebar {
flex:1 1 auto; width:100% }` и
`.Sidebar_panelOpen { max-width:none }`, которые растягивали сайдбар на всю
ширину и схлопывали `.AppShell_mainShifted` (чат) в ноль; правило
`.AppShell_mainShifted { display:none }` при открытом сайдбаре дублировало это.
Фикс: эти компактные оверрайды убраны (телефонный компакт-драуэр держится на
inline-стилях RSX, регрессия отсутствует — скриншот 360×800 бит-в-бит тот же).
Non-compact теперь показывает сайдбар + чат рядом. Все стили — из React
источника через пакер, числа не тюнились.

## «Коричневый фон» в окне: протухший блит-bind после resize

Даже после того как в `resolve` появился чат, экран продолжал быть полностью
`#151311`. Диагностика по думпам показала: `resolve` — 175 цветов, а бэкбуфер
swapchain после `present()` — 1 цвет (`#151311`, LoadOp-клир). Причина: Windows
при старте реально меняет размер окна (`(1100,760) -> (1424,714)` →
`(1100,760)` → `(1920,1009)`), а `resize()` пересоздавал цели Vello, но блит
`bind group` продолжал ссылаться на resolve-текстуру, созданную в `open()` —
то есть на **старый, очищенный** resolve. `render()`/`render_to_texture` и
`snapshot()` писали в новый resolve, поэтому «внутри» всё было живо, а на экран
уходил коричневый клир.

Фикс в `vello_gpu.rs`: `PresentSurface` хранит `bind_layout` и `sampler`, и
`resize()` вызывает `rebuild_bind()`, перепривязывая блит к свежему `resolve`.
Проверено: readback swapchain после блита бит-в-бит равен `resolve` (175 цветов),
а OS-level захват живого окна совпадает 1:1 (rail + сайдбар персонажей + чат).

Вывод для миграции Android на `PresentSurface`: контролируйте, что любой
`resize`/re-alloc целей пересоздаёт зависящие от них bind groups.

## Паритет с Android

`PresentSurface` повторяет `GpuSurface`/`blit` из `android_surface.rs` 1:1
(Vello-storage цель, convert Copy/Compute, scroll-blend окно в uniform, canvas
clear `#151311`, покруг `acquire_*`). Android пока использует свой хост;
перевод Android на `PresentSurface` — механическая миграция, которая не должна
менять поведение `android_surface.rs`.
