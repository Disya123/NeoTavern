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
`TapIntent::{Quick(Send|Stop|ComposerSettings|ComposerReset|ScrollLatest),
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

Триггер — per-message footer-действие «Prompt plan» (иконка `BookOpenText`:
канонический React `TextAlignLeft` нет в native Phosphor-паке, путь тот же
`data-action="prompt"`) на строках, чей `generation_run_id` установлен (React
`MessageDetailsCardV2` гейтится по `meta.generationRunId`). Тап резолвит run id
строки (`open_prompt_plan_for_message`) и открывает диалог; строка без run и
streaming-ряд — честный no-op / `GENERATION_RUN_NOT_FOUND`. Кнопка есть в
blueprint-документе (`message-action-prompt`, action `chat.message.prompt`) и
в legacy RSX с тем же условием. Диалог 640×560 (`shell_hit::dialog_hit`:
backdrop/close → `ClosePromptPlan`, тело Absorb) рендерит четыре состояния React
`PromptPlanPanel`: ошибка (`role=alert`, `isError`), «This run has no recorded
prompt plan.» (`PROMPT_PLAN_NOT_FOUND` → null, как в React-хуке), и контент плана
(`generation.prompt.plan` — одноразовый запрос/ответ, без SSE): мета-dl
(Model/Instruct format/Tokenizer±approximate/Tokens: Input · Response reserve ·
Context limit), over-budget-алерт, секции System blocks / Selected messages
(`data-role`), Excluded from context (всегда; пустая → «Nothing was excluded.»,
`token_budget` → «Removed by token budget»). FakeWire записывает durable-план
при старте генерации (зеркало kernel `prompt_plans`), `chats.delete` чистит
планы чата. Тесты `prompt_plan_over_product_wire`,
`tap_prompt_on_row_opens_prompt_plan`.

## Транскрипт шагов прогона (RunTranscriptPanel)

Footer-действие «Steps» (`data-action="steps"`, иконка `List` — native-пакет
не несёт React `ListChecks`) на строках с `generation_run_id` открывает диалог
640×560 (`OpenRunTranscript` / `CloseRunTranscript`). Запрос —
`generation.events` (`workflowId` = run id, `limit` 50); UI показывает только
конверты `generation.step` (sequence / type / status / attempt / createdAt).
Tool `input`/`output` в view не попадают (SEC-07). Неизвестный run → ошибка
внутри диалога (`GENERATION_RUN_NOT_FOUND`), пустой журнал → «No durable run
steps recorded for this run.». План промпта и транскрипт взаимоисключающие.
FakeWire пишет пару `provider_turn` + `final_commit` при `generation.start` /
`retry` (без tool payload) и сидирует журнал демо-ответа. Тест
`run_transcript_lists_generation_steps_without_tool_payloads`.

## Детали сообщения (MessageDetailsCardV2)

Действие в строке действий сообщения `data-action="details"` (иконка `TextAlignLeft`,
title="Message details") открывает модальную карточку с расширенными метаданными генерации
(`OpenMessageDetails` / `CloseMessageDetails`, закрытие по клику на оверлей, крестику
`data-action="details-close"` или клавише Esc).

Карточка (`data-component="MessageDetailsCard"`, CSS `MessageDetailsCardV2.module.css`):
- **Header**: имя автора, аватар / `Robot`-иконка, бейджи (`Lightning` со счётчиком токенов,
  `ChatCircleDots` с числом вариантов ответа), кнопка закрытия `X`.
- **Metadata list**: `Sent at` (`CalendarBlank`), `Model` (`Robot`), `Generation time` (`Timer`).
  Метаданные извлекаются из `message.meta.payload` (`model`, `durationMs`,
  `totalTokens`/`tokens`/`tokenCount`).
- **Content preview**: блок предпросмотра текста сообщения (`data-part="details-content"`).
- **Footer actions**: кнопки `Copy`, `Context` (toggle excluded), `Prompt` (план промпта),
  `Steps` (транскрипт шагов).

Интеграционный тест: `message_details_card_open_inspect_and_close` в
`crates/presentation-chat/tests/compositor_host.rs`.

## Исключение из контекста (toggleMessageContext)

`data-action="context"`: `chats.messages.update` с `meta.manualExcluded`
(kernel заменяет весь объект meta; сессия мержит флаг на клон текущего
payload). Первое исключение — тост «Excluded from prompt context.», возврат —
«Included in prompt context.». Строка несёт `data-excluded` и иконку Eye /
EyeSlash. Оценка контекста не считает `manualExcluded`. Streaming-ряд — no-op;
чужой id — `MESSAGE_NOT_FOUND`. FakeWire заменяет meta целиком. Тест
`toggle_message_context_flips_manual_excluded`.

## Снятие checkpoint-связи (deleteCheckpoint)

`data-action="delete-checkpoint"` рисуется только при `checkpointChatId`.
Confirm-диалог 300×200 (Cancel / Remove): `chats.messages.update` с
`clearCheckpointChatId: true` обнуляет связь; snapshot-чат остаётся в списке.
Тост «Checkpoint link removed.». `chats.snapshots.create` (checkpoint) локально
выставляет `checkpoint_chat_id` на исходном сообщении. Тест
`delete_checkpoint_clears_the_snapshot_link`.

## Дубликат персонажа (duplicateSelectedCharacter)

Кнопка Duplicate в editor-баре (`ShellAction::DuplicateCharacter`) зовёт
`characters.create` с именем `"{name} copy"` и копией description / tags /
avatar. Автоселект + pin + вкладка Edit, тост «Created {name}.». Поля
вне native create-контракта (галерея, extra spec) не копируются. Тест
`duplicate_character_creates_a_named_copy`.

## Редактор персонажа (name / description / tags / greetings)

Kernel `characters.update` принимает только `name`, `description`, `tags`,
`avatarAssetId`, `profileId`. Native Edit-таб поднимает эти поля наверх
(без скролла панели) и пишет их в провод: Save — изменённые name+description
(`TextFocus::CharacterName/Description`, `data-part="character-name-input"` /
`"character-description-input"`), пустое имя хранит текущее, no-op — «No
changes.» без вызова. Теги — Add/Remove сразу (`character-tag-input` /
`character-tag-add` / chip = remove), дубликаты case-insensitive, лимит 32 /
64 символа.

Для полей `first_message`, `creator_notes` и `alternate_greetings` native shell
предоставляет интерактивный черновик:
- `data-part="character-first-message-input"` (`TextFocus::CharacterFirstMessage`)
  и `"character-creator-notes-input"` (`TextFocus::CharacterCreatorNotes`) с оценкой
  числа токенов `≈ N tokens`;
- Секция Alternate Greetings с аккордеоном (`data-state="open|closed"`, `aria-expanded`),
  кнопками добавления (`ShellAction::AddAlternateGreeting`, `data-action="character-greeting-add"`),
  раскрытия (`ShellAction::ToggleAlternateGreeting(idx)`, `data-action="character-greeting-toggle"`),
  удаления (`ShellAction::RemoveAlternateGreeting(idx)`, `data-action="character-greeting-remove"`),
  и многострочным полем ввода `character-greeting-input` (`TextFocus::CharacterGreeting(idx)`);
- Полноценный ввод с клавиатуры и стирание через Backspace в десктопном композиторе.
Тост Save — `Saved {name}.` (`characters:saveSuccess`). Тесты:
`character_editor_name_description_tags_over_product_wire`,
`character_manager_alternate_greetings_add_toggle_and_remove`.

## Галерея персонажа (GalleryTab)

У галереи нет Product Wire-операций: kernel-плоскость честно пуста (React
`useCharacterGallery` возвращает `{ items: [] }`, upload/delete —
`UnsupportedError('characters.gallery.upload'|'.delete')`), а каталог живёт
на legacy-контуре `/api/v2/characters/:id/gallery`. Native не выдумывает
`characters.gallery.*`. Если у персонажа есть аватар (Hazel), сетка показывает
его как primary-figure (`data-state="primary"`, `data-part="gallery-figure"`,
через `character_avatar_with_asset` — без `data:` URI); без аватара — empty
state «No gallery images». «Add image» (`data-part="gallery-add"`) остаётся
включённой, как в React: нажатие → `CAPABILITY_UNAVAILABLE` с
`params.operationId = "characters.gallery.upload"`
(`ShellAction::UploadGalleryImage` + `gallery_hit`). Колонки `1→2→3→4→1` и
сортировка `oldest↔newest` живут в состоянии сессии (Blitz `<select>` не
интерактивен; `CycleGalleryColumns` / `CycleGallerySort`). Тест
`character_gallery_is_honest_empty_or_primary_and_upload_reports_capability_unavailable`.

## Поиск в шапке чата (ChatHeader search)

`data-action="header-search"` открывает оверлей вместо identity: поле запроса
(до 500 символов), счётчик совпадений по **всем** сообщениям чата (не только
видимому окну, React `searchMatchCount`), закрытие сбрасывает query. Ряды с
совпадением получают `data-state="match"`; видимое окно **не фильтруется**.
Подсчёт — case-insensitive `indexOf`-цикл, как React `countTextMatches`.
Пока оверлей открыт, blueprint-chrome честно падает в legacy RSX. Тест
`header_search_counts_matches_without_filtering_rows`.

## Slash-команды (честный not-found)

React `ChatPage.send` не отправляет текст, начинающийся с `/`, в generation:
сначала plugin/legacy slash, иначе ошибка `plugins:slashNotFound`
(«Unknown slash command: /{{command}}»), composer **не** чистится. Native
шелл не несёт plugin/legacy runtime, поэтому любой `/cmd` —
`SLASH_COMMAND_NOT_FOUND` (`params.command` = имя команды) **до**
`chats.messages.create` / `generation.start`; composer остаётся. Тест
`slash_command_not_found_does_not_send_over_the_wire`.

## Settings → General

React `GeneralTab`: язык пишется в `settings.update` (`language`, `{ value }`),
остальная appearance — Zustand. Native повторяет это: `CycleLanguage`
`en → ru → pseudo` (English / Русский / Pseudo (debug); copy шелла остаётся
English golden), `dir` из кода языка. Scale / font / contrast / motion /
chat style / avatar style / позиции сообщений / «Open Home when the app
starts» живут в сессии и выставляют `data-ui-scale`, `data-ui-contrast`,
`data-ui-font`, `data-ui-motion`, `data-chat-style`, `data-chat-avatar-style`,
`data-user-message-position`, `data-character-message-position` на корне
(React `setInterfacePreferences`). Opacity / glass blur — циклы шагом
`+5` (0–100, старт 70) и `+4` (0–40, старт 16), потому что Blitz range
не интерактивен; на корень пишутся `--st-custom-ui-opacity`,
`--st-custom-glass-blur` / `--st-effect-glass-blur` и
`--st-custom-wallpaper-overlay-alpha` (как React `setInterfacePreferences`).
Blitz `<select>` не интерактивен — цикл как у gallery. Host-переключатель
(только packaged Tauri), Kernel Preview / updater (`backend.meta()`,
desktop update channel) и plugin settings в этом срезе нет. Тест
`general_settings_language_and_appearance_over_product_wire`.

## Diagnostics (Settings → General)

React `DiagnosticsPanel` на kernel-плоскости читает `diagnostics.export`
(SEC-07 allowlist: versions/counts, без секретов, путей и пользовательского
контента) и **не** legacy `DiagnosticsSnapshot` (`useDiagnostics` → `null`).
Native повторяет это: открытие General / «Run diagnostics» зовёт
`diagnostics.export`. Метрики: Local kernel (`appVersion`), Product wire,
Schema (`rev N (hash…)`), Storage format, SQLite, Settings, Generation runs.
Legacy JSON-download, Kernel Preview badge и desktop updater — Tauri-only,
их нет. Rebuild search / Clear thumbnail cache остаются включёнными, как
React browser kernel: нажатие → `CAPABILITY_UNAVAILABLE`
(`search.rebuild` / `diagnostics.cache`), без выдуманной wire-операции.
Тест `diagnostics_export_and_legacy_maintenance_over_product_wire`.

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

## AI Settings: провайдеры и пресеты

Панель AI Settings (API / Config) теперь с реальными данными: `providers.list`
возвращает адаптеры (kernel статeless-реестр по умолчанию регистрирует
детерминированный built-in `fake` — id "fake", name "Fake Provider", модель
fake-1, capabilities tools/streaming), `presets.list` — пресеты kind
`generation` (DB-контур kernel). Карточки (`data-part="provider-card"` /
`preset-card`, 60 px, геометрия `catalog_panel_hit` с rows_top 52) выбираются:
`SelectProvider` / `SelectPreset` персистят выбор через `settings.update`
(ключи `activeProviderConfigId` / `activeGenerationPresetId` — как React
kernel-мост `updateSettings`), активная карточка получает `data-state="active"`.
Wire-side выбор провайдера на запрос остаётся в `generation.start` (отдельной
операции «select provider» нет). Полный редактор профиля (config CRUD,
discovery моделей, ключи) — legacy-контур; на kernel-плоскости React его
части гейтятся UnsupportedError и в этот порт не переносятся. FakeWire:
провайдер fake + пресеты Balanced/Creative в demo(), пустые в default().
Тест `ai_providers_and_presets_over_product_wire`.

## Data: резервные копии

Вкладка Data (Settings) перенесена с заглушки на Product Wire: открытие
вкладки грузит `backups.list`, «Create backup» вызывает `backups.create`
(kernel моделирует все копии как user-initiated/manual) и обновляет каталог,
строки (`data-component="backup-entry"`, 64 px + 4) несут Restore
(`backups.restore`; kernel делает staged restore + activation вокруг
переоткрытия БД). `activation_pending` маппится в подсказку перезапуска — как
React `useRestoreBackup.restartRequired`. Схема ответа требует hex-SHA256
контрольную сумму (64 lowercase hex) — fake-фикстуры соблюдают её. FakeWire:
2 копии (status completed) в demo(), пустой каталог (честное «no backups») в
default(); restore неизвестного id → `NOT_FOUND`. Геометрия зеркалится между
`settings_tab.rs::data_tab` и `shell_hit.rs::data_hit` (migration + activation
блоки сверху, затем padding 12 + title 20 + gap 8 + hint 32 + gap 8 +
actions 36 + gap 8; rows 64 + 4). Тест
`backups_list_create_restore_over_product_wire`.

Над бэкапами — React `DataMigrationPanel` и `ActivationStatusPanel`.
SillyTavern ZIP-import на kernel-плоскости нет (`UnsupportedError
('imports.sillytavern.analyze')`); native не выдумывает wire-операцию:
кнопка «Analyze archive» → `CAPABILITY_UNAVAILABLE`. Активация data-root
(`data.activation.status`) read-only: layout v1/v2, active root / id,
журнал, баннер pending. Demo — committed restore без pending; default —
пустой журнал. Тест
`data_activation_status_and_sillytavern_import_honesty_over_product_wire`.

## Character Advanced: lorebooks

React `CharacterLorebooks` на вкладке Advanced: открытие грузит
`lorebooks.list`, список фильтруется по `characterId` выбранного персонажа.
«New book for {name}» → `lorebooks.create` с `characterId` и переходом в
панель lorebooks (имя `New lorebook`). «Open lorebooks» открывает ту же
панель без create. Unlink в React шлёт `{ characterId: null }`, но wire DTO
это ещё не выражает (`null is not expressible yet`); native не делает
тихий no-op, а отдаёт `CAPABILITY_UNAVAILABLE`
(`lorebooks.update.unlink`). Demo-книга «Kestrel Vales» глобальная
(`characterId` отсутствует). Секция lorebooks стоит сверху Advanced, чтобы
hit-test в Blitz не требовал скролла через prompt-поля. Тест
`character_lorebooks_create_open_and_unlink_honesty_over_product_wire`.

## Display macros (`{{user}}` / `{{char}}`)

Committed-пузыри раскрывают display-макросы как React `expandDisplayMacros`
(`packages/shared/src/macros.ts`): `{{user}}` — активная персона (chat →
app → default, fallback `User`), `{{char}}` — имя персонажа (fallback
`Assistant`); time/date/random и `macro-variables` тоже портированы.
Unknown macros не трогаются. Streaming-ряд остаётся сырым. Тест
`display_macros_expand_user_and_char_on_committed_rows`.

## Tool activity badge

React `ToolActivityBadge` (`data-component="tool-activity"`, `role="status"`)
показывается над streaming-пузырём, пока run ждёт durable `tool_call`
(`GenerationEvent::GenerationStep`, status `waiting`). Native читает только
`step.input.toolCall.name` (fallback `"tool"`); arguments/output в
`ProductChatView` не попадают (SEC-07). Любой другой step type, completed /
failed / cancelled и новый `generation.start` снимают бейдж. Иконка Phosphor
`Lightning` в packed native set нет — бейдж текстовый (`Running tool: {name}…`).
Дефолтный FakeWire `generation.start` по-прежнему стримит только delta +
completed; шаг инжектируется через `apply_stream_frame`. Тест
`tool_activity_badge_from_waiting_tool_call_step`.

## AI Settings: память (Memories)

Третий таб панели AI Settings переносит React `MemoryEditor` на `memories.*`:
открытие таба грузит `memories.list`, карточки показывают scope+ключи
(Global / имя персонажа — key1, key2), содержимое и переключатель Enabled
(частичный `memories.update` только с `enabled`). Inline-редактирование
(кнопка Edit → черновик в карточке, Save/Cancel) и форма создания
(Content, Keys через запятую, scope Global/Character с циклическим выбором
персонажа вместо `<select>`, Add memory) идут через `memories.create` /
`memories.update`. Валидации React воспроизведены клиентски без wire-вызова:
«Memory content is required.» и «A character is required…»
(`memory_form_error`). Удаление — диалог 300×200 → `memories.delete`
(неизвестный id → `MEMORY_NOT_FOUND`, как kernel product.rs). Текстовые поля
получают клавиатуру через `TextFocus::MemoryContent/MemoryKeys`
(`data-part="memory-content-input"` / `"memory-keys-input"`). Геометрия
зеркалится между `ai_settings_tab.rs::memories_tab` и
`shell_hit.rs::memories_hit` (heading 20 + hint 16, gaps 8; карточки 112 /
172 в редактировании; форма создания 156). FakeWire: 2 памяти (global +
character-scoped к демо-персонажу) в demo(), пусто в default(). Тест
`memories_crud_over_product_wire`.

## AI Settings: Advanced (Chat template)

Четвёртый таб — React `AdvancedPromptSettings` + `ChatTemplateEditor`.
Каталога instruct-форматов на kernel-плоскости нет (`useInstructFormats` →
`{ formats: [] }`, legacy `/settings/instruct-formats`); native не выдумывает
wire-операцию. Выбор native ↔ custom: native пишет `instruct-format` и
`instruct-format-id` как `{ value: null }`; custom сначала локальный (как
React `if (value === 'custom') return`), Save — объект ChatML-шаблона в
`instruct-format`. Поля custom-шаблона (system / user / assistant / tool /
suffix / stopping strings) правятся локально, как React-textarea, и уходят
на провод только по Save (`data-part="instruct-*-input"`, клавиатура
`TextFocus::Instruct*`). Prompt mode chat ↔ text пишет `prompt-template.mode`.
В text-режиме native показывает список блоков (`DEFAULT_PROMPT_TEMPLATE`,
12 host-owned ids) и toggle `enabled` — сразу `settings.update`, без
debounce React (250 ms). Пресеты `presets.list` kind `prompt-template`:
цикл Unsaved ↔ сохранённые (как React `<select>`), Save обновляет
активный `presets.update` или открывает диалог имени (`presets.create`),
Rename / Duplicate / Delete через те же модалки, что и generation Config.
Активный id — kebab `active-prompt-template-preset-id`. Custom-блоки:
Add prompt (`custom-N`, детерминированный id без `uuid`) вставляет блок
перед `chat-history` / `post-history-instructions` и открывает компактный
редактор name+content (`data-component="prompt-block-editor"`,
`TextFocus::PromptBlockName/Content`). Remove только на `data-kind=custom`.
Save синкает `postHistoryInstructions`, если редактируется терминальный
контентный блок. Up/Down на ряду (текст «Up»/«Down» — CaretUp нет в
packed set) переставляют movable-блоки сразу через `settings.update`;
терминалы и шаг вниз на якорь — no-op, как React `moveBlock`. Placement
в редакторе: цикл Relative ↔ In-chat (локальный draft до Save), Depth и
Order (`TextFocus::PromptBlockDepth/Order`, 0–9999) только при in-chat;
ряд показывает `@ {depth}`. Role: цикл System → User → AI Assistant
(локальный draft до Save). Triggers: шесть чипов Normal / Continue /
Impersonate / Swipe / Regenerate / Quiet (локальный draft до Save;
опущенный список = все виды, снятие последнего чипа возвращает полный
набор). Forbid Overrides: Switch только при editable content и role
System (локальный draft до Save). Model: свободный id (React `ModelMenu`,
`TextFocus::PromptBlockModel`, max 256) и кнопка Load; без активного
провайдера поле не правится, Load на kernel-плоскости честно даёт
`CAPABILITY_UNAVAILABLE` (`providers.models.discovery`). Import/export:
host-owned JSON-конверт `{ version: 1, kind: "prompt-template", name, data }`
(как React download / `<input type=file>`). Export паркует `last_export`
для файлового синка десктопа; import читает путь и пишет `presets.create` +
`settings.update` (`prompt-template` + `active-prompt-template-preset-id`).
Невалидный файл — copy `settings:invalidPromptTemplatePreset`. Drag и
token audit остаются на React (`usePromptContextAudit` на kernel даёт
`UnsupportedError('prompt.context-audit')`). Кнопка Add стоит над списком (без
скролла панели 12+ рядов уводили бы её за край). Motion
`data-ui-motion=reduced` ещё и ставит `--st-motion-duration-*` на шелл
(Blitz не матчит `:root[data-ui-motion]`). Тесты
`chat_template_editor_native_custom_over_product_wire`,
`custom_instruct_fields_edit_and_save_over_product_wire`,
`prompt_template_blocks_toggle_over_product_wire`,
`prompt_template_presets_over_product_wire`,
`prompt_template_custom_blocks_over_product_wire`,
`prompt_template_reorder_blocks_over_product_wire`,
`prompt_template_block_placement_over_product_wire`,
`prompt_template_block_role_over_product_wire`,
`prompt_template_block_triggers_over_product_wire`,
`prompt_template_block_forbid_overrides_over_product_wire`,
`prompt_template_block_model_binding_over_product_wire`,
`prompt_template_import_export_over_product_wire`.

## AI Settings: управление пресетами

Config-таб вырос из списка карточек в редактор React
`GenerationPresetEditor`: выбор карточки (`presets.list`, kind generation)
применяет значения пресета через один `settings.update`
(`activeGenerationPresetId` + `maxContextTokens` + `generationDefaults` — как
React `selectPreset`). Тулбар управления: Save as / Rename (диалог 320×220 с
инпутом имени, `TextFocus::PresetName`) → `presets.create` / `presets.update`,
Duplicate → `presets.create` «<name> (copy)» с автоселектом, Delete → диалог
300×200 → `presets.delete` + сброс активного id. Unlock-context (локальный
Switch, clamp `maxContextTokens` к 200_000 при выключении) и компактные
числовые поля самплеров (11 параметров + reasoning/stream Switch) правят
живой draft; Apply пишет `settings.update` (`maxContextTokens` +
`generationDefaults` + `activeGenerationPresetId`). Range-слайдеры React
остаются на React-плоскости (Blitz не умеет `<input type=range>`).
Import/export: host-owned JSON-конверт `{ version: 1, kind: "generation",
name, data }` (как React download / `<input type=file>`). Export паркует
`last_export`; import читает путь и пишет `presets.create` +
`settings.update` (`activeGenerationPresetId` + `maxContextTokens` +
`generationDefaults`). Невалидный файл — copy
`settings:invalidGenerationPreset`. Неизвестный id →
`PRESET_NOT_FOUND` (как kernel product.rs). FakeWire: пресеты Balanced
(8192/0.8) и Creative (16384/1.1) с реальными данными в demo(). Геометрия
зеркалится между `ai_settings_tab.rs::presets_tab` и
`shell_hit.rs::presets_config_hit`. Тесты
`generation_preset_management_over_product_wire`,
`generation_preset_import_export_over_product_wire`,
`generation_preset_sampler_editing_over_product_wire`.

## AI Settings: профили подключений

API-таб перенесён на `providers.config.*` (как React `ProviderProfileEditor`
на kernel-плоскости): открытие панели грузит `providers.config.list`, строки
профилей (имя · provider · честное «API key saved/not set» — само значение
никогда не покидает SecretStore), тап = выбор (`settings.update`
`activeProviderConfigId` = id конфига, не адаптера). «New profile» → диалог
320×240 (цикл по зарегистрированным адаптерам вместо `<select>` каталога —
`providers.catalog` на kernel-плоскости UnsupportedError; инпут имени) →
`providers.config.set` (upsert по паре provider+name) + автоселект. Delete →
`providers.config.delete`; удаление активного профиля сбрасывает выбор.
Имена схемой ограничены lowercase-hyphen. Адаптеры из `providers.list`
остаются ниже как read-only секция. Model discovery остаётся UnsupportedError
на React kernel-плоскости и не переносится. FakeWire: профиль local-fake в
demo(), пусто в default(). Геометрия зеркалится между `providers_tab` и
новым `providers_hit`. Тесты `provider_profiles_crud_over_product_wire`,
обновлённый `ai_providers_and_presets_over_product_wire`.

## Редактирование сообщения и история правок

Инлайн-редактор и карточка истории перенесены с React `MessageBubble` /
`MessageRevisionHistoryCard`. `data-action="edit"` открывает редактор прямо в
пузыре: текст-плейсхолдер `part:message-edit-input` (фокус клавиатуры через
`TextFocus::MessageEdit`) + Save/Cancel (`message-edit-save` /
`message-edit-cancel`, ключуются `data-message-id` строки). Save вызывает
`chats.messages.update`: пустой или неизменённый черновик просто закрывает
редактор без wire-вызова (паритет React), успешное обновление пишет статус
«Message updated.», ошибка оставляет черновик открытым. Ядро при изменении
контента записывает предыдущий текст как immutable-ревизию;
`data-action="history"` (кнопка добавлена и в канонический документ чата
`ui-blueprint-document-chat-v1.json` после rollback) открывает оверлей-карту
с историей из `chats.messages.revisions.list` («No previous versions.» для
чистых строк), Close — `message-history-close`. Чужой id даёт честный
`MESSAGE_NOT_FOUND`. При открытии другого чата редактор/история закрываются.
Blueprint-chrome пока не покрывает эти интерактивные состояния — кадр честно
уходит в legacy-RSX (`warn_uncovered_variant("interactive-edit")`). Тест
`message_edit_records_revisions_over_product_wire`.

## Снапшоты чата: checkpoint / branch и меню

Кнопки Checkpoint / Branch в инлайн-ряде сообщения теперь реальны:
`chats.snapshots.create` замораживает префикс чата до сообщения включительно
в новый дочерний чат (`parentChatId`/`origin`/`sourceMessageId`; для
checkpoint источник дополнительно линкуется `checkpointChatId`). Пользователь
остаётся в текущем чате (паритет React: тост с действием перехода), статус
«Checkpoint/Branch created (N messages copied).», дочерний чат появляется в
списке чатов. Триггер меню снапшотов — новая кнопка GitBranch в хедере
(и в каноническом документе `ui-blueprint-document-chat-v1.json` как
`custom.chat.snapshots-menu`): открытие грузит `chats.snapshots.list`
(дочерние чаты, новые сверху), строки «title · origin · N messages» открывают
чат, тап вне панели закрывает меню (паритет outside-click React), пустой
список честно пишет «No checkpoints or branches yet.» Геометрия панели
зеркалится между `snapshots_menu_panel` и новым `snapshots_menu_hit`.
Blueprint-chrome при открытом меню уходит в legacy-RSX
(`warn_uncovered_variant("interactive-edit")`). Чужой id даёт честный
`MESSAGE_NOT_FOUND`, чужой родитель при list — `CHAT_NOT_FOUND`. При смене
чата меню закрывается. Тест `chat_snapshots_checkpoint_branch_over_product_wire`.

## Свайпы: счётчик вариантов и пикер

`MessageSwipePager` получил недостающие части React-эталона: hydrated-счётчик
"current/total" (`data-part="swipe-counter"`, `aria-live="polite"` — React
`chat:swipeCounter`) и trigger пикера вариантов
(`data-action="swipe-picker"`, caret-down) между кнопками previous/next; в
канонический документ чата добавлен узел `swipe-picker` с действием
`chat.message.swipe-picker` (новый литерал в `UiActionIdSchema` и вариант
`UiActionV1::ChatMessageSwipePicker`). Kernel-plane сообщения не несут
перестановочных полей, поэтому счётчик гидратируется из кэша
`chats.messages.variants.list` (позиция по совпадению контента, иначе
неявная последняя строка = total; скрывается при пустом, как React `total <= 1`).
Тап по триггеру открывает поповер `MessageVariantPicker` (список stored
вариантов + активного контента, `data-part="swipe-row-{id}"`, индекс
"N/M" tabular-nums, preview 140 символов, пустой список — честное
"No other variants" при загруженном результате; blueprint-chrome при этом
честно уходит в legacy-RSX). Выбор строки вызывает `variants.activate`,
пересчитывает сообщения и счётчик, закрывает поповер; тап вне поповера
закрывает его (паритет React outside-click; геометрия зеркалится между
`variant_picker_popover` и `variant_picker_hit`, попаер-лейбл рендерится
только непустым в обеих ветках). Фикстура `FakeWire::with_message_count`
сеяла «оригинал» с хардкод-контентом, не совпадавшим с реальным текстом
хвостового сообщения (например `![photo 5]` при count кратном 5) — теперь
позиция 0 берёт фактический контент хвоста. Тест
`variant_picker_and_swipe_counter_over_product_wire`.

## Экспорт чата

Строка чата в панели Chats получила третью зону Export (rename / export /
delete, 44px каждая — `chats_hit` расширен до 132px): `chats.export`
возвращает kind-тегированный JSON-документ (`neotavern-chat-export`) в
base64; сессия декодирует его и паркует в `last_export` со статусом
«Export ready: …». Хост-синка платформенна: React скачивает файл в браузер,
десктопный bin пишет любой припаркованный `last_export` на диск
(`NEOTA_EXPORT_DIR` или `<cwd>/exports/<filename>`) и отражает путь в
статусе — тот же синк для карточек персонажа и JSON prompt-template.
Чужой chatId даёт честный `CHAT_NOT_FOUND`. Тест `chat_export_over_product_wire`.

## Лорбук: редактор книги

Book-таб панели Lorebooks теперь сохраняет метаданные через
`lorebooks.update` (React `BookTab`: имя — save-on-blur, описание — debounced
autosave; в хосте обе правки сведены в явную кнопку Save, поля получают
фокус клавиатуры `TextFocus::LorebookName/LorebookDescription`). На провод
идут только реально изменившиеся поля; пустое обрезанное имя хранит старое
(React никогда не пишет пустые имена), no-op сохранение не вызывает wire
(«No changes.»). Успех обновляет карточку в списке и сеет черновики заново,
статус «Book updated.». Delete в action bar ведёт к общему диалогу удаления.
Геометрия — новый `lorebook_book_hit` (bar: Back слева 140px, Delete+Save
справа). Тест `lorebook_meta_update_over_product_wire`.

## Персона: редактор

Edit-таб панели Personas сохраняет имя и описание через `personas.update`
(React сохраняет имя по blur и описание с debounce; в хосте — явная кнопка
Save, поля получают фокус клавиатуры `TextFocus::PersonaName/
PersonaDescription`). Семантика зеркальна редактору книги: на провод идут
только изменённые поля, пустое обрезанное имя хранит старое, no-op — без
wire-вызова («No changes.»), успех обновляет карточку и пересеивает
черновики со статусом «Persona updated.». Геометрия — новый
`persona_edit_hit` (bar: Back слева 160px, Duplicate absorb, Delete+Save
справа). Тест `persona_meta_update_over_product_wire`.

## Карточки персонажей: импорт и экспорт

Кнопка Import в тулбаре карточек теперь открывает диалог (React использует
скрытый `<input type=file>`; нативный хост честно спрашивает путь к файлу,
`TextFocus::CardPath`). Подтверждение делает двухшаговый провод: `assets.put`
(kind `card`, base64) → `imports.character.card`; ядро парсит
SillyTavern-карточку и дедуплицирует по sha256 контента — повторный импорт
того же файла возвращает существующего персонажа (`created == false`,
статус «Already imported (…)»), первый — «Imported …» с автоселектом.
Экспорт — кнопка DownloadSimple в action bar редактора:
`characters.export.card` (JSON) паркует SillyTavern-контейнер в
`last_export`, bin пишет файл в `exports/` (тот же синк, что у чатов).
FakeWire парсит V2/flat JSON; PNG-чанк `chara` — kernel-only (честный
`VALIDATION` вместо фейкового парса), png-экспорт тоже не синтезируется.
Чужой id → `CHARACTER_NOT_FOUND`. Тест
`character_card_import_export_over_product_wire`.

## Профили: импорт контейнера

Settings → Profiles: вместо честной заглушки — реальная форма импорта
(паритет React `ProfilesPanel`): относительный путь контейнера
(`TextFocus::ProfileImportPath`), циклическая кнопка политики дубликатов
Reject/Replace/Remap, кнопка Import. `profile.import` возвращает счётчики
inserted/updated/skipped + orphans; статус «Imported: N inserted, …», путь
очищается как в React. Успех обновляет characters/chats/lorebooks/presets
(React инвалидирует те же библиотечные запросы). Пустой путь отклоняется
клиентски без wire-вызова. FakeWire не парсит реальные контейнеры —
возвращает честный пустой проход (0/0/0). Тест
`profile_import_over_product_wire`.

### plugins.install — вне скоупа переноса

`plugins.install` на kernel-плоскости принимает уже верифицированные
метаданные пакета: сам staging (ZIP с проверкой путей / Git) выполняет хост
— React в браузере честно бросает `UnsupportedError('…host-verify')`.
Перенос потребовал бы реализовать подсистему верификации пакетов (AGENTS
§19), поэтому нативный хост зеркалит React-поведение: установка плагинов
через этот экран недоступна, список/enable/disable/uninstall работают.

## Отправка сообщения (Send) и кнопка Stop

Композер (`data-part="composer"` в `product_chat_app`) получил кнопку **Send**
(`st-button`, реальный класс React-шита) у правого края бар. Во время активного
потока генерации (`ctx.streaming == true`) кнопка Send динамически заменяется
на кнопку **Stop** (`data-action="stop"`, `data-variant="danger"`, иконка
`StopCircle`, лейбл "Stop", фон `#b91c1c` / текст `#fee2e2`), как и в React
`ChatComposer.tsx`. Тап по ней (`QuickIntent::Stop` / `QuickAction::Stop` /
`ShellAction::StopGeneration`) вызывает `session.cancel_generation()`,
отправляя команду `generation.cancel` по Product Wire и останавливая стрим.
Десктоп-хост при этом отдаёт сессии **честную ширину чат-вьюпорта**: с открытым
сайдбаром на некомпактном окне это `window - rail(60) - panel(380)` (раньше
передавалась вся ширина окна, и чат-workspace 1100px уезжал за экран —
композер/заголовок клипались). `ChatSession::sidebar_open()` — новый геттер для
этого решения.

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
   контента строки с вариантами (позиция 0 = оригинал).    FakeWire сидирует 3
   варианта у хвостового ответа демо-чата; `variants.create/delete` в
   FakeWire пока не реализованы (свайпам не нужны). Тест:
   `swipes_cycle_variants_and_stop_at_edges`; e2e: тап → paths растут,
   `kernel_messages` неизменен.
7. **Context / Prompt / Steps / Details / delete-checkpoint — подключены.**
   `data-action="context"` → `chats.messages.update` (`meta.manualExcluded`);
   `prompt` → `generation.prompt.plan` по `generationRunId` строки;
   `steps` → `generation.events` (только `generation.step`, без tool payload);
   `details` → `MessageDetailsCardV2` (метаданные генерации, токены, время);
   `delete-checkpoint` → confirm + `clearCheckpointChatId`. Edit / history /
   checkpoint / branch уже были подключены ранее (см. CHANGELOG).

**Распознавание (M1/M2):** общая таблица решений `hit_rects::resolve_tap`
классифицирует ВСЕ задокументированные действия строки —
`context/edit/copy/checkpoint/branch/delete/rollback/prompt/steps/details/delete-checkpoint`
+ version controls `history/regenerate/swipe-previous/swipe-next`. Кнопки
version controls не несут собственного `data-message-id`; их владельцем
становится ближайший ключевой предок из skeleton-цепочки (`effective_key`),
поэтому тап по регенерации всегда знает свою строку. Un-keyed действие без
ключевого предка отбрасывается. Android copy остаётся честным skip
(`clipboard_bridge_pending`); остальные kind исполняются в JNI так же, как
на десктопе.

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
- Все builtin-действия сообщения реальны: copy (клипборд хоста; Android —
  честный skip), delete (`chats.messages.delete`), edit
  (`chats.messages.update` + ревизии), history (`chats.messages.revisions.list`),
  context (`meta.manualExcluded`), prompt (`generation.prompt.plan`), steps
  (`generation.events`), details (`MessageDetailsCardV2`),
  checkpoint/branch (`chats.snapshots.create`),
  delete-checkpoint (`clearCheckpointChatId`) и rollback
  (`chats.snapshots.rollback`).
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
