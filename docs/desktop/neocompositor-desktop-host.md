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

## Клики по авторским кнопкам

Действия `custom.*` захватываются на нажатии, выполняются один раз при
отпускании в пределах допустимого смещения и отменяются при перетаскивании
или отмене касания. Layout-кнопка исключает одновременное выполнение
геометрического fallback-действия под ней. Меню снимков и уведомление
неизвестного custom-действия запрашивают новый кадр сразу после выполнения.
Регрессии проверяются в `desktop_host::input::tests` с FakeWire без GPU.

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
  блит-пайплайн (шейдер — единый `blit_wgsl::BLIT_WGSL`, его же компилирует
  Android-хост);
- `render(scene, base_color)` — GPU Vello-растр в storage → GPU-копия в `resolve`;
- `present(scroll, header, composer_top)` — фуллскрин-блит `resolve` → swapchain
  (зеркало Android `blit`);
- `set_swapchain_size(w, h)` — дёшево, на каждый `Resized` event: только
  `config` + `surface.configure`; цели и bind group не трогаются, блит между
  produce растягивает предыдущий `resolve` в новый swapchain;
- `resize(w, h)` — дорого, один раз на produce (`produce_and_render`): при
  изменении `targets_size` пересоздаёт цели, `rebuild_bind` и clear
  (контракт «Коричневый фон» ниже сохраняется); swapchain донастраивается
  только если ещё не совпал;
- `snapshot(path)` / `present_and_dump(path)` — диагностика: чтение `resolve`
  до блита и чтение бэкбуфера swapchain ПОСЛЕ блита (`--snapshot PNG` /
  `--swapchain PNG` у раннера). Всё — PNG-дампы, пригодные для гистограммы.

Десктоп-раннер — `crates/presentation-chat/src/bin/neocompositor-desktop.rs`
(feature `desktop-host = ["gpu", "dep:winit", "dep:arboard"]`, только
Windows/macOS). Сам бин — только парсинг аргументов и вызов
`desktop_host::run(RunConfig)`; вся логика хоста живёт в модуле
`crates/presentation-chat/src/desktop_host/` (зеркало структуры
`android_surface.rs`): `state` (конструирование сессии/окна), `produce`
(пересборка документа + Vello-растр — медленный путь), `input`
(указатель/тач, slop-правила, действия), `scroll` (анимации визуального
смещения), `text` (клавиатура в фокусное поле), `frame` (present, blend-окна,
resize, `ApplicationHandler`), `probe` (детерминированные
`--pointer`/`--type`/`--wheel`/`--tick` пробы, плюс диагностическая пауза
`--wait <ms>` реального времени). `App` объявлен в `mod.rs`,
дочерние модули видят приватные поля как потомки — контракт публичного API
не изменился. Платформенный код хоста — только winit-окно и
`instance.create_surface(window)`;
кадры идут по Android-каденции: layout + Vello-растр один раз на `bind`/dirty,
дальше чисто composite-only переблиты на каждый present-кадр.

**Провод выбирается на старте (фаза B3).** `RunConfig.wire:
Option<Box<dyn ProductWire>>` + `RunConfig.chat_id: Option<String>`:
`None`/`None` — in-memory `FakeWire` с `--messages` сид-сообщениями
(дефолтный бин); kernel-провод инжектится из
`neotavern-presentation-kernel-wire` (см. `crates/presentation-kernel-wire/`),
который не может зависеть от `presentation-chat` в обратную сторону —
поэтому kernel-режим оформлен отдельным бином `neocompositor-kernel` в этом
крейте. Сессия хоста — `ChatSession<Box<dyn ProductWire>>` (blanket-impl
`ProductWire for Box<T>` в `presentation-chat/src/wire.rs`). Кадровый цикл
pump'ит живой kernel-стрим: `about_to_wait` держит redraw ~60 Гц, пока
`state().stream_handle` жив (writer-поток ядра коммитит события после
`dispatch_stream`-reply, поэтому `drain_stream(0)` может выйти раньше
терминала); `--dom-dump`/`--snapshot`/`--swapchain` работают одинаково на
обоих проводах.

**Каденс стрима: один produce на бёрст, ≤30/с (аудит плавности).** Хост
выкачивает всю накопившуюся очередь стрим-событий за кадр одним
`ChatSession::pump_stream` (dirty один раз на насос, не на событие), а гейт
33 мс в `frame` ограничивает produce ~30/с (AGENTS §24) — между produces
present показывает прежний растр; терминальный кадр поднимает гейт
немедленно. Гидратация изображений (`refresh_visible_assets`) выполняется
после present и только вне живого скролл-жеста (не внутри produce — иначе
ленд удлинялся на все 32 wire-феча); свежий ассет поднимает один redraw.

**Смена чата отписывается, а не отменяет (срез A аудита).** Контракт
`ProductWire` дополнен методом `drop_stream(handle)` (default no-op):
провод забывает handle, не отменяя ран — kernel-стрим продолжает
коммититься на writer-потоке в durable-лог. `ChatSession::open_chat`/
`confirm_delete_chat` вызывают приватный `reset_stream_state()`:
`drop_stream` + сброс `stream_handle`/`active_run_id`/`streaming_text`/
sequence-курсоров/черновика/текста композера. Двойной `send` при живом
стриме — no-op (guard по `stream_handle`); `drain_stream` поллит до
`Terminal`, не оставляя хвост очереди. Регрессионные тесты:
`presentation-chat/tests/stream_hygiene.rs`,
`presentation-kernel-wire/tests/parity.rs::drop_stream_unsubscribes_without_cancelling_the_run`.

## Запуск

```bash
cargo run --release --manifest-path crates/Cargo.toml -p neotavern-presentation-chat \
  --features desktop-host --bin neocompositor-desktop -- --messages 12
```

**Интерактив: release-сборка предпочтительна, dev-профиль ускорен.** Каждый
клик/скролл/resize пересобирает сцену (Blitz paint + vello-растр) синхронно
на потоке событий. Профиль стоимости одного produce (12 сообщений,
`NEOTA_OPEN_PROFILE=1`): почти всё — `ProductVelloSession::open`
(`initial_build` VirtualDom + Blitz `resolve`), paint/render — единицы мс.
С `[profile.dev.package."*"] opt-level = 2` (deps оптимизированы и в dev;
см. `crates/Cargo.toml`) produce в dev-сборке ~130–180 мс; в release,
замер на этой сцене после этапов A–C, — ~85–95 мс холодного produce
(исторические ~40–80 мс относились к меньшей сцене до роста документов).

**Инкрементальный produce (A2, по умолчанию включён).** Хост держит
`ProductVelloSession` живым между produce-вызовами: после swap'а product
thread_locals и обновления вьюпорта документ не пересобирается, а диффится
(`mark_all_dirty` → `poll` → `resolve(0.0)`) и пере-красится —
`ProductVelloSession::open_or_refresh` в
`crates/presentation-m0-d2/src/lib.rs`. Замер на этой сцене (release):
тёплый produce **~26–33 мс** против ~57–79 мс полного `open`
(poll ~7–10 мс + resolve ~12–18 мс; `NEOTA_OPEN_PROFILE=1` печатает фазу
`refresh viewport/style ... poll ... (dirtied ...) resolve ...`), т.е.
**~2.5–3×** быстрее; холодный первый кадр не изменился. Корректность
закреплена тестами m0-d2 (`refresh_after_open_matches_open_paint_shape`,
`refresh_does_not_accumulate_ua_stylesheets`, `refresh_resizes_the_viewport_in_place`,
`open_or_refresh_kill_switch_forces_open`) и побайтовым совпадением
`--dom-dump` incremental-пути с полным. Контракт: перед `refresh` хост обязан
установить свежий view (`install_product_shell`); изменение insets пере-
запекает UA-стили (remove+re-add, без накопления); `poll=false` (vdom без
работы) — не ошибка. Kill-switch: `NEOTA_INCREMENTAL_PRODUCE=0` возвращает
полный `open` на каждый produce (тот же паттерн, что `NEOTA_INSCENE_IMAGES=0`).

**Контракт инвалидации: `scene_epoch` — единственный переносчик видимости.**
Каждая видимая мутация сессии бампает `scene_epoch`; хост-десктоп наблюдает
его в `about_to_wait` и в голове `frame()` (`App::observe_scene_epoch`) и сам
ставит `dirty` + redraw. Забытый ручной `dirty = true` у места мутации больше
не может «спрятать» изменение — мутация сессии видима всегда (Android-хост
читает тот же epoch как generation сцены). Ручной `dirty` остаётся только для
состояния самого `App` (wallpaper-кэш, размер окна, probe-пути). Мутация без
`bump_scene` — регрессия по определению.

Resize окном пере-верстает
документ живо: `Resized` → `set_swapchain_size` + `dirty` (winit сам
коалесцирует redraw), цели догоняют размер один раз на produce; обои-cover
перегенерируется по порогу ±10% размера прямоугольника, между порогами
шейдер растягивает кэшированный cover. Обновление «produce на каждый event
без коалесинга» или «produce сбрасывающий dirty» — регрессия.

**Смена DPI (перенос окна между мониторами 100%/125%/150%)** обрабатывается
`ScaleFactorChanged` → `App::apply_scale_change`: density обновляется, тёплая
produce-сессия сбрасывается (холодный `open` в новом масштабе — `refresh`
честно отказывается менять scale), wallpaper-cover пере-выводится. До этого
обработчика не было: density фиксировался на старте, и hit-test/layout/blit
навсегда съезжали после переноса окна.

Флаги: `--messages <N>` — число сид-сообщений wire (по умолчанию 12);
`--w/--h` — начальный размер окна; `--pointer <x>,<y>` — один симулированный
тап в CSS-координатах через тот же pointer-pipeline, что и мышь (для снапшотов);
`--type "<text>"` — симуляция клавиатурного ввода в текущий focus;
`--hit <x>,<y>` — отладка «кликнул X — сработало Y»: печатает резолв ОБЕИХ
систем хит-теста для точки (геометрический `shell_hit::hit_test` + скелетный
`HitRects::resolve_tap`) против установленного (нарисованного) кадра;
`--snapshot <png>` — дамп `resolve`; `--swapchain <png>` — дамп бэкбуфера после
блита; `--dom-dump <json>` — дерево Theme SDK-хуков после layout
(`data-component` / `data-part` / `data-slot` / `data-role` / `data-action` +
CSS-px rects) для сравнения с React, см.
[`rust-ui-style-port.md`](rust-ui-style-port.md#dom-parity).
Скриптовый replay (порядок аргументов) делает produce между операциями, если
кадр грязный, и всегда пинает один финальный кадр — пробы с `--dom-dump`/
`--snapshot` детерминированы даже когда все операции заклэмпились в no-op.
Хост не выходит сам; для автоматических прогонов есть обёртка
`scripts/probe-host.mjs` (`node scripts/probe-host.mjs -- <аргументы бина>`):
ждёт стабилизации `--snapshot`, затем убивает дерево процессов.

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

- **Фокус-ринг и hover (G5).** В этом Blitz-билде нет псевдоклассов
  (`:hover`/`:focus`), события мыши не доходят до DOM — поэтому видимый
  фидбэк идёт через хост: `pointer_down` публикует Theme SDK identity
  сфокусированного поля (`state.focused_part`), `pointer_move` — hover-цель
  `{action}:{owner-key|-}` из ТОГО ЖЕ hit-rect снапшота, что и тапы
  (`state.hover_target`). Оба сеттера бампают сцену только при ИЗМЕНЕНИИ
  (движение внутри кнопки бесплатно; hover заморожен во время активного
  захвата — press/drag/panel-resize, как в React). Рендер — точные React
  значения из `product.css`: фокус-ринг `box-shadow:0 0 0 3px
rgba(227,138,98,.2)` на композер-поле; hover: default-кнопки `#39342f`,
  primary Send `#f09a73`, иконки сообщений/тулбара `#302c28`/`rgba(33,27,23,.1)`
  - `#f3eee8`; кнопки несут `data-state="hover|idle"`, поле — `focused`.
    Покрытие: легаси-RSX и blueprint-хром симметричны (скелет-гейт
    `blueprint_chrome_skeleton_matches_legacy_rsx` проверяет и атрибуты).
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
- **Оверлеи чата (снапшоты, variant picker)** — через ту же decision-таблицу
  hit-rects: строка снапшота несёт `data-action="open-snapshot"` с
  `data-message-id` = id дочернего чата (`ShellAction::OpenSnapshot`), строка
  пикера — `data-action="swipe-pick"` с `data-ui-key` = id варианта
  (`ShellAction::PickVariant`; синтетический ряд `active-…` только закрывает,
  как `if (!row.active)` в React). Оба поповера закрываются нажатием ВНЕ
  панели (React `document pointerdown`): rect'ы панели/триггера/строк
  опознаются по игле `snapshot*` / `swipe-picker|swipe-pick`. Escape оверлеи
  не закрывает (клавиатурный контур хоста не ведёт оверлеи).
- **Колёсико мыши** над чатом — `session.scroll_chat_by(css_px)` поднимает
  виртуализированное окно вверх от низа (новое состояние
  `ChatRouteState.scroll_offset_css`, позиция clamp к протяжённости сообщений
  в [0, max]; нотч = 100 css px, см. раздел про суб-строчный офсет).
  Скролл идёт на частоте монитора: визуал анимируется в blit-сдвиг
  замороженного растра (present каждый vsync), а продьюсы происходят только
  на лендах — когда blit-drift доходит до запечённого оверскан-ранвея
  (детали в разделе «Оверскан-ранвей» ниже). Жест 600px = 2 продьюса,
  флинг 2000px = 6; полоса на кромке всегда показывает реальные строки
  (запечённые соседние ряды), а не заливку обоями. Это идемпотентная
  добавка к Android-логике: там скролл идёт через BlitzSurfaceInput
  (dioxus hot-path), здесь — тот же ack-контракт через `scroll_ack`.

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

**Горячий путь без сборок view-model.** Нажатие клавиши и pointer-события
читают поля драфта напрямую из состояния (`ChatSession::route_state()`),
а не через полную сборку `shell_view()` (клон персонажей, строк и драфтов
на каждый вызов): на символ было две сборки (чтение + produce), стала одна.
Установленные шелл/чат раздаются рендеру как `Rc` (`current_product_shell` /
`current_product_chat`) — кадр обходится одним data-клоном чата при install
и refcount-клоны на чтение вместо полных копий view-model.

### Hit-rects: геометрия из layout, не из «измеренных полос» (M1)

Все тапы и фокусы десктоп-хоста резолвятся через
`presentation_chat::hit_rects::HitRects` — снапшот прямоугольников всех узлов
с Theme SDK-хуками, снятый с того же Blitz/Taffy layout-прохода, который
нарисовал кадр (`sess.slot_skeleton()`). Приоритет — верхний по порядку
отрисовки; кнопки сообщений несут владельца через `data-message-id`
(`SlotNode.key`). Ручные пиксельные бэнды удалены:
`composer_band()`, зоны Send/Settings/Reset, оффсеты `-32/-64/-96/-128`
кнопок сообщений, координатные бэнды обоих поисков.

**Одна геометрия на жест.** Обе системы хит-теста (геометрический
`shell_hit::hit_test` и скелетный `HitRects`) читают установленный
(`install_product_shell`, `current_product_shell()`) кадр — тот же produce,
что нарисовал экран и снял `hit_rects`. Раньше `pointer_down` строил свежий
`shell_view()` (полный клон view-model на каждое событие мыши), который
расходился с нарисованной геометрией при любой мутации состояния между
produce и Down. Свежий view остаётся только на `pointer_up` для
`character_custom_action` — там семантика «после мутации».

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

Каталог плагинов (`plugins.list`) получил реальные lifecycle-действия.
Панель пересобрана по измеренному стеку (dom-dump 1920×1009): над списком
subtitle 28 + contained-заметка 8+60 + install-бар 8+44 + мета 20 +
паддинг списка 8 — карточки начинаются на 215 px ниже шапки. Карточка
контент-размерная ~200 px (шапка min-40 + permissions ~50 + ряд действий
44 + паддинг 16), шаг 200 + 16; показывают статус (Active/Disabled, рамка
`#63c98d` у активного) и строку разрешённых permissions. Нижний ряд
действий (justify-end, покраска = хит-геометрия `shell_hit.rs::plugins_hit`):
switch 36×20 (тап → `plugins.enable` / `plugins.disable` по текущему
состоянию, ответ — обновлённый ряд) и правее всех uninstall (Trash) с
диалогом подтверждения 320×220 (`plugins.uninstall`, тост «uninstalled»).
Константы зеркалят демо-геометрию: у реальных инсталлов списки permissions
переносятся иначе — миграция хитов на layout-измерение (`HitRects`) —
отслеживаемый follow-up. Фикс-высоты в панели — только `min-height`:
жёсткий `height:` на блоках с детьми-элементами в этом билде Blitz
коллапсирует (ловушка в [chat-ui-recipe.md](chat-ui-recipe.md)).

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
  `Steps` (транскрипт шагов), плюс кнопка `+` (`data-action="actions"`, иконка `Plus`,
  title="More message actions") для переключения в режим действий.
- **Actions mode (`details_mode: "actions"`)**:
  - Нажатие на `+` переключает карточку в меню расширенных действий (`details-action-menu`).
  - Шапка с кнопкой возврата назад (`data-action="details-mode-details"`, иконка `ArrowLeft`).
  - Компактный предпросмотр сообщения (`data-part="details-action-preview"`).
  - Секция Danger Zone (`details-danger-zone`) с заголовком и кнопкой полного удаления сообщения
    и его вариантов (`data-action="delete"`, иконка `Trash`, "Delete message and all versions").
  - Секция основных действий (`details-core-actions`) со списком действий с подписями: `copy`,
    `context`, `edit`, `history`, `regenerate`, `rollback`, `checkpoint`, `branch`, `prompt`, `steps`.
  - Возврат по стрелке `details-mode-details` возвращает карточку в режим просмотра метаданных `details`.
- **Edit mode (`details_mode: "edit"`)**:
  - Переход по кнопке `edit` (`data-action="edit"` или `data-action="details-mode-edit"`).
  - Редактор сообщения (`data-part="details-editor"`): заголовок «Edit message», иконка `PencilSimple`,
    кнопка отмены `details-mode-details` (`X`).
  - Область ввода (`data-part="details-editor-input"`), отображающая `message_edit_draft` (с поддержкой
    ввода в десктопном хосте через `TextFocus::MessageEdit`).
  - Панель кнопок (`details-editor-actions`): Cancel (`details-mode-details`) и Save (`details-save-edit`,
    иконка `Check`, «Save»).
  - Сохранение отправляет `chats.messages.update` по Product Wire, обновляет текст сообщения в сессии,
    сбрасывает черновик и закрывает карточку деталей.

Интеграционные тесты: `message_details_card_open_inspect_and_close`,
`message_details_card_actions_mode_navigation_and_execution`,
`message_details_card_edit_mode_navigation_and_saving` в
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

## Редактор и просмотр карточки персонажа (Character Card Viewer & Edit mode)

Kernel `characters.update` принимает только `name`, `description`, `tags`,
`avatarAssetId`, `profileId`. Панель управления персонажем поддерживает два режима
(`editor_mode: "view"` vs `"edit"`):

- **Переключение режима**: в шапке панели (`SidebarPanelHeader_actions`) кнопка
  `ToggleCharacterEditorMode`: в режиме просмотра отображает `<Pencil>` («Edit card»,
  `data-action="character-edit-mode"`), в режиме редактирования — `<Eye>`
  («View character card», `data-action="character-view-mode"`). При нахождении на других
  вкладках нажатие кнопки `Eye` переключает на вкладку `edit` в режиме просмотра (`view`).
- **Режим просмотра карточки (CharacterCardViewer)**: нередактируемый фасад
  (`data-component="character-card-viewer"`, `data-part="character-viewer"`,
  `data-state="read-only"`, стилизованный классами `.CharacterManagementPanel_viewer*`):
  - Аватар с thumbnail asset, заголовок с именем персонажа (`<h2>`) и чипы тегов
    (`data-part="character-viewer-identity"`, `data-part="character-viewer-tags"`);
  - Заметки создателя (`data-part="character-viewer-creator-notes"`);
  - Раскрывающиеся секции деталей (`data-part="character-viewer-details"`):
    описание (`data-part="character-viewer-description"`) и список приветствий
    (`data-part="character-viewer-greetings"`, первое сообщение и альтернативные
    варианты `data-part="character-viewer-greeting"`).
- **Режим редактирования (EditTab)**: поля пишутся в провод и прокручиваются
  нативным шимом скролла панели (см. «Скролл панели и React-паритет режима
  карточки» ниже). Save — изменённые name+description
  (`TextFocus::CharacterName/Description`,
  `data-part="character-name-input"` / `"character-description-input"`), пустое имя хранит
  текущее, no-op — «No changes.» без вызова. Теги — Add/Remove сразу (`character-tag-input` /
  `character-tag-add` / chip = remove), дубликаты case-insensitive, лимит 32 / 64 символа.

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
  `character_manager_alternate_greetings_add_toggle_and_remove`,
  `character_card_viewer_mode_toggle_and_rendering`.

### Мутатор dioxus-native-dom: паника «invalid key» и вендор-патч blitz-dom

Симптом: процесс умирает по exit 101 — `blitz-dom ... mutator.rs: invalid
key` — при скролле чата, смене панели с последующим ресайзом окна по высоте
и любом сдвиге окна виртуализации сообщений. Корень: dioxus-native-dom
0.8.0-alpha.1 рециклит `ElementId` и GC-ит отцепленные узлы
(`remove_node_if_unparented` → `remove_and_drop_node`), выбрасывая из арены
корень, пока (а) потомки держат `parent` на мёртвый id и (б) маппинги
`ElementId → NodeId` выброшенного поддерева остаются живыми. Любая
последующая правка, идущая по такому id, индексирует мёртвый слот (SlotMap
паникует).

Лечение — bounded-патч вендоренного `crates/vendor/blitz-dom/` (патч-секция
в `crates/Cargo.toml`, как у vello/anyrender): ареный GC отключён
(`remove_node_if_unparented` — no-op), добавлен read-only
`BaseDocument::node_count`. Детали и учёт утечки — в
[`vendor/blitz-dom/NEOTAVERN_PATCH.md`](../../crates/vendor/blitz-dom/NEOTAVERN_PATCH.md).
Без GC ничего не выбрасывается из арены, мёртвых id в стриме правок не
существует. Отцепленные поддеревья копятся вместо этого (~33 узла на
скролл-нотч) — десктопный хост ограничивает рост порогом 8192 узлов: по
достижении тёплая сессия не паркуется, следующий produce холодно
переоткрывает документ (~90 мс release, один кадр). Порог переопределяется
переменной `NEOTA_ARENA_COLD_REOPEN` (диагностика/soak-тесты). Убрать
вендор, когда апстрим blitz-dom/dioxus-native-dom починит GC рецикла id.

Честная граница: контейнмент пока только в десктопном хосте
(`produce_and_render`); Android-хост шарит ту же арену, но его produce
кадры часто холодные (пересоздание surface) — при переносе на Android
добавить тот же порог в `android_surface`.

### Скролл панели и React-паритет режима карточки

React-панели скроллятся нативно; у Blitz-краски overflow-скролла нет. Хост
роутит wheel над панелью в `ChatSession::scroll_panel_by` — смещение клэмпится
по высоте отрендеренного контента (`HitRects::subtree_bottom`: корневой бокс
клипается вьюпортом, экстент дают переливающиеся строки — приветствия, чипы
тегов, карточки, поля формы), а тело вкладки применяет его отрицательным
`margin-top`. Роутинг один для всех вкладок и режимов: игла покрытия и
экстента — `part:floating-tab-content` (корень контента вкладок), поэтому
скроллятся и список карточек, и read-only viewer, и редактор, и advanced/
gallery. Марджин меняется прямо на переиспользованном узле — без ре-креации
по `key`: динамический inline-стиль на reused-узле Blitz применяет, а
keyed-замена большого поддерева на каждый пиксель скролла — лишний чурн
DOM-едитов и известная ловушка «invalid key» в мутаторе dioxus-native-dom
(blitz-dom `node_at_path` по мёртвому узлу стека). Смещение
сбрасывается в 0 при смене панели / вкладки / персонажа. Для проб добавлена
операция `--move x,y` (wheel-роутинг берёт последний трекнутый курсор — в этой
версии winit wheel не несёт позиции), и скриптовый replay делает produce между
операциями, если кадр грязный.

Режим карточки выровнен по React `CharacterManagementPanel`:
`selectCharacter` всегда ставит `editorMode='view'` — выбор персонажа
(включая повторный тап по выбранной карточке) открывает read-only viewer, а
в редактор ведёт кнопка-карандаш в шапке (`ToggleCharacterEditorMode`); дефолт
состояния — тоже `view`. Кнопки action-бара редактора (назад, favorite,
export, duplicate, delete) несут настоящие `data-action` (`custom.characters.*`),
резолвятся через hit-rects и `character_custom_action`; жёсткие пиксельные
полосы `editor_hit` заменены чистым `Absorb` (паттерн M1: геометрия из layout,
не из «измеренных полос»). Inline-оверрайды раскладки message-header /
message-action-bar сняты симметрично в blueprint-ветке (`scene_chat.rs`) и
legacy RSX (`lib.rs`): раскладку даёт packed-класс (React golden: flex row,
wrap, gap 12px; action-bar — wrap, gap 4px), паритет blueprint↔legacy снова
сходится.

### Браузер персонажей: кэш карточек и постраничный load-more

`shell_view()` раньше на каждый produce фильтровал, сортировал и клонировал
весь каталог (`to_lowercase` на строку за кадр). Теперь фильтр+сортировка
собираются один раз на изменение (ревизия каталога, поиск, сортировка —
`ChatSession::filtered_character_cards`, кэш инвалидируют `refresh_characters`
и in-place обновления `characters.update`) и раздаются как `Rc`
(`ProductShellView.characters`). Сетка раскладывает только текущую страницу —
React `useCharacters(limit: 50)`: кнопка `Load more`
(`data-action="custom.characters.load-more"` → `ShellAction::LoadMoreCharacters`)
открывает следующую страницу; DOM ограничен страницей, каталог лежит в памяти.
Тесты: `character_cards_cache_is_shared_until_catalog_or_inputs_change`,
`character_browser_pages_via_load_more`.

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

## Возврат в родительский чат (ChatHeader back-to-parent)

Когда активный чат является дочерней веткой или чекпоинтом (`parent_chat_id != None`),
в шапке чата рядом с кнопками поиска и меню снапшотов отображается кнопка
`data-component="back-to-parent"` с иконкой `ArrowLeft` (17px) и
`aria-label="Back to parent chat"` (паритет с React `ChatHeader.tsx:132-143`,
`ChatPage.tsx:759` `backToParentChatId={chat.data?.parentChatId ?? null}`).
Тап по кнопке классифицируется как `QuickIntent::BackToParentChat` через
`HitRects::resolve_tap` и выполняет `ChatSession::open_parent_chat()`
(`ShellAction::BackToParentChat`), открывая родительский чат в рабочем пространстве.
После перехода в родительский чат (`parent_chat_id == None`) кнопка автоматически
исчезает из разметки и хит-теста. Тест
`chat_header_back_to_parent_button_navigates_to_parent_chat`.

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
(React `setInterfacePreferences`). Opacity / glass blur — визуальные контролы
с заголовком (`SettingsPanel_rangeHeader`, `data-part="range-header"`),
бейджем текущего значения (`SettingsPanel_rangeValue`, `data-part="range-value"`),
кнопками-степперами «−» / «+» (`data-action="*-dec"`, `data-action="*-inc"`)
и визуальным треком прогресса (`data-part="range-track"`, `data-part="range-fill"`,
`role="progressbar"`), поддерживающими точечный шаг `StepUiOpacity(±5)` (0–100,
старт 70) и `StepUiGlassBlur(±4)` (0–40, старт 16), а также циклический клик по треку;
на корень пишутся `--st-custom-ui-opacity`, `--st-custom-glass-blur` /
`--st-effect-glass-blur` и `--st-custom-wallpaper-overlay-alpha` (как React
`setInterfacePreferences`). Blitz `<select>` не интерактивен — цикл как у gallery.
Host-переключатель (только packaged Tauri), Kernel Preview / updater (`backend.meta()`,
desktop update channel) и plugin settings в этом срезе нет. Тесты
`general_settings_language_and_appearance_over_product_wire` и
`general_settings_steppers_and_range_sliders_interactive`.

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

## Темы (Settings → ThemesTab) и Live Theme Engine

Каталог тем живёт на Product Wire (`themes.list` / `activate` / `deactivate` /
`uninstall`; React `ThemesPage` + Settings `ThemesTab`). Вкладка Settings →
Themes: открытие вкладки грузит `themes.list`; строки тем
(64 px, `data-part="theme-row"`, `data-state=active|inactive`) показывают
name / id · vversion · trustState и несут Apply (96 px, `themes.activate`,
ответ = ThemeDto с `active: true`) и delete (диалог 300×200,
`themes.uninstall`, тост «Removed ….»); активная тема показывает бейдж Active и
инертна; пока тема активна, над списком есть «Use built-in theme»
(`themes.deactivate`, «Restored the built-in theme.»).

### Live Theme Engine (Динамический движок тем в нативном рендере)

В отличие от ранних прототипов с зафиксированными токенами, в нативном рендере
(`neotavern-presentation-design-system`, `neotavern-presentation-dioxus-shell`,
`neotavern-presentation-chat`, `neocompositor-desktop`) реализован полнофункциональный
динамический движок тем **Live Theme Engine**:

- **Разрешение токенов Theme SDK Level 1**: Структура `ThemeTokens` и парсер
  `parse_theme_tokens_from_manifest` извлекают дизайн-токены из манифеста темы
  (`manifest.tokens.dark`: поверхности, границы, акценты, текст, радиусы) с
  поддержкой встроенных пресетов (`wii-u-dark`, `kde-plasma`, `amoled`, `dracula`).
- **Генерация скоупированных стилей**: Функция `render_theme_stylesheet` генерирует
  валидный Blitz CSS с селектором `[data-theme-id="{theme_id}"]`, переопределяющий
  CSS Custom Properties (`--st-color-surface-app`, `--st-color-accent-primary`,
  `--st-color-text-primary` и др.), а также стили рейла навигации, боковых панелей,
  пузырей сообщений, кнопок и полей ввода.
- **Динамическая инъекция в Dioxus RSX**: Стили активной темы инжектируются через
  `<style>{active_theme_css}</style>` непосредственно в DOM документа перед отрисовкой
  в Blitz. Цвета заливки рейла (`rail_bg`) и плавающей панели (`panel_bg`) рассчитываются
  динамически на основе `active_theme_tokens`.
- **Мгновенное переключение без перезапуска**: При вызове `themes.activate` или
  «Use built-in theme» сессия пересчитывает токены и CSS в рантайме без перезапуска
  процесса и без перекомпиляции.
- **Интеграционные тесты**: `themes_catalog_activate_deactivate_uninstall_over_product_wire`
  и `live_theme_engine_dynamic_token_switching_and_reset`.

Установка тем из ZIP — host-side возможность: React kernel-плоскость отклоняет её
`UnsupportedError ('themes.install.host-verify')`, порт повторяет это честной ошибкой
`CAPABILITY_UNAVAILABLE` (`ShellAction::InstallTheme`, без выдуманной
`themes.install`-операции — она есть в реестре, но на этой плоскости не
достижима). FakeWire: `themes` (wii-u-dark verified-publisher / kde-plasma
locally-trusted, зеркало `THEME_VALUE`), `THEME_NOT_FOUND` для неизвестных id.

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

**Ошибки не молчат.** Любая ошибка маршрута (`record_error`), стрима
(`GenerationFailed`, `StreamFrame::Error`) проходит через единый
`ChatSession::surface_error`: код пишется в `last_error` (машинный контракт)
и поднимается в `status_message` — тост показывает стабильный код ошибки
(тот же, что легаси-баннер композера; локализация кодов — на хосте, когда у
него появится i18n). Раньше `record_error` не бампал сцену: ошибка могла
вообще не вызвать перерисовку. Сбрасывается новым запросом
(`last_error = None` на send) или авто-скрытием тоста.

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
  сдвигается на 40px) и 20px в хедере ассистентских сообщений; поверх слота
  каждый трек несёт свой in-scene растр `<img src="asset:{id}">`
  (absolute-fill, `object-fit:cover`) — и blueprint (`scene_chat.rs`), и
  легаси-RSX (`lib.rs`): после stage B (image audit) GPU-оверлей выключен по
  умолчанию (`NEOTA_INSCENE_IMAGES=0` возвращает его), и легаси-хром без
  `<img>` деградировал до буквы-заглушки — расходимость ловилась golden-гейтом
  (0.3–0.9% в блоках аватаров). Справа в шапке — иконка
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

- version controls `history/regenerate/swipe-previous/swipe-next`. Кнопки
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

- Мультитач: touch-драг с флингом на десктопе работает (один палец, общие
  с Android константы `scroll_dynamics`); второй палец игнорируется. Скролл
  идёт через compositor fast path + scroll-blit с продвижением контента
  (ack-петля этапа 3, общая для хостов: `scroll_ack::ScrollAckLoop` +
  `PresentationSession::rebase_scroll_window`); honest-остатки — в разделе
  «Этап 3» (кадр задержки advance на Android, оценочные высоты строк в
  fast-path bounds).
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

## Скролл-динамика: общее ядро хостов (Android parity)

Динамика скролла обоих нативных хостов вынесена в один модуль
`crates/presentation-chat/src/scroll_dynamics.rs` (общий крейт; бины хостов
держат только surface/input-обвязку — требование «один хост — везде»):

- **Пёрышковая инерция (fling)**: константы Android-цикла —
  `GLIDE_DECAY_PER_TICK = 0.94` за 60 Гц vsync-тик (`GLIDE_TICK_NS = 8_333_333`),
  порог остановки `GLIDE_STOP_VELOCITY = 12` CSS px/s. `glide_decay(v, dt)`
  масштабирует показатель степени под реальный dt кадра; при dt = тику это
  ровно бывший inline `host.velocity *= 0.94` (бит-идентично, без powf-обхода).
  `android_surface.rs` теперь вызывает `glide_decay`/`glide_active` из модуля,
  поведение не менялось (порог применяется к затухающей величине, как раньше).
- **Плавный wheel (desktop)**: `SmoothScroll` — ease-out (cubic) анимация к
  цели за ~120 мс; нотч в полёте делает `retarget` от текущей сэмплированной
  позиции (цепочка нотчей не прыгает). Сэмплирование — по абсолютному
  монотонному времени, поэтому кадр, пришедший с опозданием, садится на
  правильное смещение, а не пропускает шаги.
- **Touch (desktop, один указатель)**: контакт проходит тот же `pointer_down`/
  `pointer_up`, что и мышь (тач-тап = тап мышью, включая hit-rects таблицу
  решений); контакт, захваченный контролом, не скроллит (slop-проверка
  выполняется в `pointer_up`, как у Android pending-tap). Драг по канвасу
  скроллит 1:1 (`scroll_chat_by(dy)`), оценка скорости — как на Android
  (`(prev_y − y)/dt` в CSS px); релиз с |v| > порога стартует флинг на общих
  константах. Синтезированные дигитайзером mouse-события того же контакта
  подавляются. Мультитача нет (второй палец игнорируется).
- **Драйв кадров**: `about_to_wait` крутит `request_redraw` +
  `WaitUntil(1ms)`, пока анимация жива (wheel ease-out, флинг или тач-драг).
  Таймер короче vsync-интервала НАМЕРЕННО: пейсером служит сам present —
  `get_current_texture` на FIFO-свопчейне блокируется до выхода буфера, так
  что кадры выравниваются по герцовке монитора (включая 144 Гц). Прежний
  8мс-таймер на 144 Гц попадал МЕЖДУ vsync-ами — интервалы кадров
  чередовались 7/14 мс и скролл джаддерил. Простой окна по-прежнему 0% CPU
  (`ControlFlow::Wait`).
- **Порядок кадра** (важен для плавности): продьюс (если dirty) →
  `acquire` → сэмпл анимации → `blit`. Продьюс до acquire, потому что он
  может переконфигурировать свопчейн/реаллоцировать растры — нельзя с
  выданной текстурой кадра. Сэмпл — строго после acquire: на видимом окне
  acquire возвращается на границе vsync (буфер только что ушёл со скан-аута),
  поэтому сэмпл, взятый там, опережает показ кадра ровно на один рефреш.
  Разделение present на `acquire`/`blit` существует именно ради этого.
  Финальная фаза: часы анимации (`monotonic_ns`) на живом пути тикают от
  `predicted_display_ns` — последний возврат acquire плюс EMA интервалов
  возвратов — то есть от предсказанного момента скан-аута; дрожь таймера
  пробуждения (±несколько мс относительно vsync) вообще не доезжает до
  видимого движения. Пробный часы (детерминированные скрипты) имеют
  приоритет.
- **Пробуждение на dirty**: residual-ленд в конце жеста происходит ПОСЛЕ
  produce-гейта кадра (сэмпл идёт после acquire), поэтому `about_to_wait`
  держит отдельную ветку `dirty && !streaming` с re-arm 1мс — без неё петля
  уходила бы в `Wait` и окно замирало на сдвинутом растре до следующего
  ввода (реальный дедлок кадровой петли, пойманный фрейм-таймингом).
- **Изменение размера**: `Resized` обновляет только layout-состояние и
  dirty. Свопчейн НЕ переконфигурируется на событии: между событием и
  продьюсом переконфигурированный свопчейн сэмплировал бы СТАРЫЙ резолв
  через НОВОЕ doc-окно (максимизация давала сжатую среднюю полосу с чёрными
  полями и хромом из двух раскладок). Пока продьюс не догнал, DWM сам
  растягивает последний согласованный кадр; `PresentSurface::resize` в
  продьюсе переконфигурирует и реаллоцирует атомарно. Случайный
  устаревший свопчейн лечится в `acquire` (Outdated → configure текущим
  конфигом + один ретрай).
- **Диагностика кадренса**: `NEOTA_FRAME_TIMING=1` печатает на каждый
  present `[frame-timing] dt/acquire/produce/drift` — интервал блитов,
  ожидание acquire, длительность последнего продьюса и текущий blit-дрейф;
  рядом `[runway] band_top/band_bottom/canvas` — экстенты полосы и канвы
  (из них считаются направленные капы). Охота за порчей кадра:
  `NEOTA_FRAME_DUMPS=<n>` + `NEOTA_DUMP_DIR=<dir>` пишут каждую n-ю пару
  «что сэмплировал blit (resolve) / что ушло в свопчейн», а
  `NEOTA_DOM_DUMP_ALL` — скелет DOM каждого продьюса (`dom_NNN.json`):
  битый resolve при чистом DOM = дубль в DOM/сцене; чистый resolve с битым
  свопчейном = слой blit/present.
  Проба `--wait <ms>` — пауза реального времени внутри реплея (окно успевает
  выйти на передний план до скриптованного жеста; без неё FIFO-поведение
  перекрытого окна не имеет vsync-фазы). Нюанс проб: `--wheel` до первого
  продьюса — no-op (ещё нет `scroll_max_css`), начинайте с `--wait`.
- **Пробы**: `--wheel <dy>` (нотч через живой `wheel`-путь) и `--tick <ms>`
  (шаг детерминированных probe-часов + один шаг анимации). Probe-часы живут,
  пока скриптованная анимация в полёте, затем возвращаются к wall time.
  Анимационные операции (`--wheel`/`--tick`) реплеятся ПО ОДНОЙ НА КАДР:
  реальное колесо размазывает нотчи по кадрам, и ease рендерится между ними —
  слитые в один кадр нотчи схлопывали жест в один прыжок, и середина жеста
  (дрейф, ранвей, кап-лендинги) вообще не существовала. Детерминированные
  часы заводятся операцией `--tick`; скрипт из одних `--wheel` живёт на
  wall-часах (замороженный clock-at-0 останавливал анимацию и лендинги
  навсегда). Нотчи `--wheel` ДО первой `--tick` сэмплируются по wall-времени.
  Верификация (эта машина, Vulkan): `--wheel 40 --tick 120` → лог
  `smooth-scroll landed: 0.0 -> 40.0`, снапшот отличается от базового;
  `--wheel 40 --tick 60` → `smooth-scroll -> 35.0` — ровно
  `40 × ease_out_cubic(0.5)` (0.875), easing сходится бит-в-бит.
- **Тесты**: `scroll_dynamics` (6 юнит: константы Android, масштабирование dt,
  порог, ease-out, ретаргет, точная посадка) + в `tests/compositor_host.rs`:
  `smooth_wheel_scroll_lands_exactly_on_target_through_session` (нотч, цепочка
  ретаргетом, клэмп у 0) и `fling_glide_matches_shared_android_recurrence_through_session`
  (рекуррентность флинга = рекуррентности Android-цикла).

Честные границы (историческое, до этапов 2–3): скролл тогда шёл через
re-produce на кадр анимации (~30 мс тёплый produce → фактические ~30 fps в
движении). Этап 2 перевёл анимации на blit-сдвиг замороженного растра, этап
3 замкнул ack-петлю с продвижением контента — см. соответствующие разделы
ниже; инерционные константы и кривые общие. Drag-скролл мышью не
добавлялся (мышь — колёсико, как в React golden).

## Скролл-блендинг: 2D-окно в blit (этап 1 fast-path скролла)

Архитектурный анализ (пересмотр допущения «перенести скролл как на Android»
одним куском): fast-path скролл Android — `compositor_tick` + gesture_delta в
`CompositorFastPath` — работает в синтетическом property-дереве
(`commit_properties` объявляет scroll-контейнер высотой 8 вьюпортов независимо
от DOM) и сдвигает **замороженный** растер через blit. Петля sync-back
(mailbox → ack → re-produce с продвижением окна) не потребляется ни одним
хостом — контент во время флинга не продвигается. Копировать это на десктоп
«как есть» нельзя: сломало бы split-layout (вертикальный бэнд сдвинул
сайдбар) и content-correctness. План из двух этапов:

- **Этап 1 (этот коммит)**: blend-окно blit стало 2D-прямоугольником. WGSL
  (`BLIT_WGSL`, текст идентичен в `vello_gpu.rs` и `android_surface.rs`) читает
  `array<vec4<f32>, 2>`: `(offset_y, band_top, band_bottom, srgb)` +
  `(band_left, band_right)`; uniform 16 → 32 байта в обоих хостах.
  `PresentSurface::present` / `present_and_dump` принимают `BlitWindow`
  (физические px; `default()` = plain blit — прежнее поведение бит-в-бит).
  Android передаёт full-width (0..1) — поведение не менялось. Проба
  `--blit-shift <dy_css>`: один сдвинутый present + swapchain-дамп.
  Пиксельная верификация (Vulkan, 1100×760, бэнд 56..586 × 440..1100):
  header/сайдбар/композер — 0 изменившихся пикселей; сдвинутый контент —
  `shift[y] == base[y+40]` бит-в-бит (0 из 323 400 px); филлер — ровно
  #151311; регрессия без пробы — max diff 1/255 на 7 px из 836k (GPU-шум LSB).
- **Этап 2 (выполнен, см. ниже)**: анимации скролла десктопа (wheel ease-out,
  touch drag/fling) едут как blit-сдвиг замороженного растра (`present` с
  реальным `BlitWindow`, ~0 re-produce на кадр), синхронизация в session
  одним `scroll_chat_by(net)` в конце жеста/анимации (grab в `pointer_down`
  приземляет анимацию до hit-теста — hit-ректы всегда совпадают с экраном).
- **Этап 3 (выполнен, см. ниже)**: ack-петля ядра (mailbox → ack →
  re-produce с продвижением окна) — флинг больше не скроллит замороженный
  растр ни на одном хосте.

Заодно починена сломанная сборка ветки под Android: JNI-диспетчер тапов
отставал от портов (не покрывал `QuickIntent::Stop` и
`MessageActionKind::SwipePicker` / `SwipePickerClose` — их добавили только в
десктопный бин). Плечи зеркалят десктопное поведение
(`cancel_generation`, `open_variant_picker`, `close_variant_picker`);
`cargo check --target aarch64-linux-android --features android-jni,gpu` —
зелёный.

### Этап 2 (выполнен): анимации скролла через blit-сдвиг + sync-back

Скролл-анимации десктопа (wheel ease-out, touch-драг, флинг) больше не
re-produce'ят кадр: они двигают **визуальное смещение**
(`visual_scroll_css`), а разница «визуал − запечённый оффсет» презентится как
blit-сдвиг через `BlitWindow` (замороженный растр, ~0 produce на кадр).
Посадка (sync-back) — один клэмпнутый `scroll_chat_by(visual − baked)`:

- по завершении анимации/жеста (eased-сэмпл дошёл до цели, флинг затух,
  драг отпущен без скорости, `TouchPhase::Cancelled`);
- по drift-cap: визуал убегает дальше половины высоты чат-бэнда → ранняя
  посадка с produce, чтобы филлер не закрыл весь вьюпорт;
- grab: `pointer_down` приземляет анимацию ДО захвата с синхронным produce —
  hit-ректы всегда совпадают с тем, что на экране.
  Клэмп визуала ≥ 0 (без rubber-band, как Android); `ScrollLatest` и любые
  внеанимационные изменения оффсета синхронизируют визуал с запечённым
  состоянием. Кэш бэнд-геометрии (`chat_band`/`shift_cap_css`) обновляется на
  каждом produce (resize/панель — честно).

Верификация (Vulkan, пробы с детерминированными probe-часами):

- `--wheel 40 --tick 120` → садится ровно в 40; **2 produce суммарно
  (стартовые), 0 на анимацию**; resolve бит-в-бит равен этапу 1 (2 px LSB).
- `--wheel 40 --tick 60` (mid-flight) → swapchain = точный сдвиг 35 px:
  `shift[y] == base[y+35]` — 0 из 326 700 px; филлер снизу — ровно #151311;
  header/сайдбар/композер нетронуты (0–6 px LSB-шума).
- `--wheel 400 --tick 80` → drift-cap посадка внутри кадра: 3 produce,
  промежуточная запечка на ~385 px до завершения анимации.
- Регрессия без проб: вывод идентичен этапу 1 (7 px LSB-шум из 836k).

Честная граница этапа 2: во время сдвига контент заморожен (новые строки
появляются только при посадке); филлер за пределами растроенного окна
совпадает с фоном чата (тёмная тема), но поверх photo-wallpaper виден как
плоская полоса на время сдвига.

### Этап 3 (выполнен): ack-петля ядра — fast path продвигает контент

До этого среза флинг на **обоих** хостах скроллил замороженный растр:
Android двигал visual-offset в kernel fast path (`CompositorFastPath`) до
синтетического `content_extent = 8 × height`, никогда не перепродуцируя
окно; десктоп перепродуцировал только по drift-cap/финалу. Этап 3 замыкает
петлю **mailbox → ack → re-produce с продвижением окна**, общую для хостов:

- **Общая политика** — `scroll_ack::ScrollAckLoop` (рядом со
  `scroll_dynamics`): хранит окно, под которое запечён текущий растр
  (`presented`), drift-cap (половина чат-бэнда, floor 24 css px) и
  in-flight ack. Решение `due(visual, gesture_active)`: cap-кросс при
  активном жесте, любой остаточный дрейф (> 0.5 css px) после его
  завершения. Десктоп использует её вместо бывших `shift_cap_css` +
  ручного `visual − session`; Android — ту же структуру в `GpuHost`.
- **Ядро** — `PresentationSession::rebase_scroll_window(base_y, mode)`:
  честный rebase fast path на запечённое окно. `Advance` (same-epoch ack,
  `seq = applied`) сохраняет visual непрерывным: committed = base, unacked
  = visual − base. Если жест затух между решением и rebase (ack
  отклонён как stale: acknowledged == applied), visual по построению равен
  цели advance — фолбэк-телепорт пиксельно точен (проверяется
  `visual == base`, иначе отказ). `Teleport` (epoch+1) — для jumps окна
  (ScrollLatest, действия пользователя): visual следует за окном, velocity
  fast path сбрасывается. Плюс `scroll_unacked_y()` — honest blit-сдвиг
  (visual − committed). `commit_properties` теперь берёт **реальный**
  content extent из `ViewportSession::index().extent()` вместо
  синтетического `8 × height` — флинг ограничен историями чата, а не
  константой, короткие чаты не скроллятся в пустоту.
- **Android** (`android_surface.rs` + `android_jni.rs`): в `present_frame`
  после gesture-тика ack-петля решает, нужен ли advance; решение уходит в
  `SCROLL_ADVANCE`, JNI-фаза bind применяет его через
  `ChatSession::scroll_chat_by` и перепродуцирует **даже посреди жеста**
  (для обычного dirty гейт «не скроллим» сохранён — посторонний re-bind
  посреди флинга телепортировал бы visual). `bind_host` после `bind_list`
  сажает ack-петлю на новое окно и ставит `rebase_due`; `present_frame`
  потребляет его **после тика** (same-epoch ack видит applied >
  acknowledged). Blit-сдвиг = unacked (до первого rebase совпадает с
  прежним raw visual). Режим rebase: Advance, если запечённое окно
  совпало с целью in-flight advance (±0.5), иначе Teleport. Неудачный
  bind отменяет in-flight — петля не застревает.
- **Desktop** — та же петля, синхронная: `land_scroll` = advance + produce
  - `ack.land` в одном кадре; `present_window` читает сдвиг из
    `ack.drift`; поведение бит-в-бит как в этапе 2.

Верификация (Vulkan, 1100×760, chat-колонка 424..1100):

- `--wheel 40 --tick 60` (mid-flight) → сдвиг 35 px **бит-в-бит**: 0 из
  310 284 px внутри chat-колонки; результат совпадает с `--blit-shift 35`
  (7 px LSB) — fast path этапа 2 сохранён.
- `--wheel 400 --tick 80` → cap-посадка в кадре: 3 produce (старт,
  промежуточная запечка, финал) — как в этапе 2, но решение через
  `ack.due()`.
- Регрессия без проб: 2 px LSB из 836k.
- `scroll_ack` — 6 unit-тестов; ядро —
  `scroll_rebase_keeps_visual_continuous_and_teleports_on_jump`
  (непрерывность, stale-фолбэк, телепорт); обе цели `cargo check`
  (desktop + `aarch64-linux-android`) зелёные; прогоны
  presentation-chat/session/chat-viewport/neocompositor зелёные.
- Android-хост проверен на уровне контрактов ядра и компиляции —
  рантайм-проверка на устройстве в этом окружении невозможна.

### Ограничение drift-кэпа: bleed-полоса ≤ 96px (смягчение «обрезается»)

Ведущая кромка blit-сдвига не имеет запечённого контента — шейдер заливает её
filler'ом, и полоса росла вместе с дрейфом до половины chat-полосы (~300px
мид-флинга). Для frozen-raster хостов (десктопный band-blit) кэп теперь
`ack_cap_for_band(band)` = min(пол-Band, **96px**), floor `MIN_ACK_CAP_CSS`:
полоса-filler ограничена кромкой экрана, каденс re-produce на wheel-скоростях
не меняется (нотч ~40px до кэпа не дотягивается). Android сохраняет пол-Band:
его fast path композитит строки (ChatCompositor), filler-полосы там нет.

Честный фикс (overscan-запекание) — отдельный срез по шеллу, и вот почему он
не «маленький»: band = вьюпорт = clip (`overflow:hidden`), оверсан-строкам
внутри band физически нет места; вынос за клип упирается в (а) z-order —
шапка рисуется раньше вьюпорта, а `z-index` в Blitz сломан (поддерево
hoist'ится к стекинг-контексту на первом layout и не пере-якорится — кейс
шапки задокументирован в `lib.rs`), и (б) однорастровую архитектуру present —
оверскан под полупрозрачным композером сэмплился бы композитным пикселем
(призрак chrome в контенте). Кандидаты на настоящий фикс: выделенный
overscan-растр в present-пайплайне (вторая текстура + расширенный src-диапазон
в blit-шейдере) либо построчный композитор десктопа по образцу Android.

Честные границы этапа 3: (1) на Android advance отстаёт от решения на один
кадр (решение в present_frame, применение в bind-фазе следующего
presentFrame) — окно checkerboard'а [cap, cap + движение кадра]; (2) при
перепродуцировании после гидрации аватаров высоты строк меняются
(компактный заголовок → полный) — лендинг честно запекает новое окно,
поэтому растр лендинга ≠ база+сдвиг в демо-сиде; это свойство виртуализации
продюсера, а не ack-петли (два лендинга бит-в-бит идентичны между собой);
(3) fast-path bounds — оценочные высоты строк (`56 px × density`), точные
высоты из продуктового окна — будущий срез.

### Покраска виртуализированного окна: суб-строчный офсет (это и был «листаю книгу»)

До этого среза окно виртуализации **выбирало** строки по офсету, но покраска
этот офсет не применяла: канвас сообщений рисовался от верха вьюпорта,
top-aligned. Скролл выглядел как перелистывание книги — между продьюсами
виден только blit-сдвиг (≤96px), а каждая посадка меняла набор строк целиком
со «щелчком» на границу строки, и стартовый экран показывал середину чата
вместо новых сообщений. Три корня в одной цепочке:

- **Гэп-осведомлённый индекс высот** (`session/helpers.rs`,
  `ROW_GAP_CSS = 40px`): шаг покраски между строками = канвасный `gap:24px` +
  собственные `margin-top/bottom:8px` статьи (`message_bubble_style`).
  Индекс презентационного окна добавляет его к высоте каждой строки, так что
  кумулятивные px индекса = позиции покраски. Без него окно выбиралось на
  16–40px/строку раньше реального контента.
- **Фото-овер-кавер в оценке** (`corrected_height_kind`): строки с
  `![…]`-картинками красятся ~436px растра; тот же over-cover, что
  композиторский индекс применял всегда. Без него фото-строки оценивались
  в ~56px (×5 недооценка) — окно и budget уплывали до тех пор, пока
  обучение не догонит строку за строкой.
- **Суб-строчный офсет в покраску** (`ProductChatView.chat_window_offset_css`):
  `virtualized_window` возвращает px первой строки окна, скрытые над верхом
  вьюпорта; оба рендера (blueprint `scene_chat.rs` + легаси `lib.rs`)
  тянут канвас вверх `margin-top:-{offset}px` — **без ключа** (высокочастотное
  значение; key-flip перевешивал бы поддерево строк на каждой посадке).
  Двигатель: инлайн-стиль на reused-узле обновляется при смене значения
  атрибута — проверено пробами.

Цикл обучения высот замкнут **доводочным продьюсом** (`produce_and_render`):
`learn_measured_heights` возвращает «изменилось ли» — изменившаяся коррекция
перевзводит `dirty` + `request_redraw` (луп безграничен только до
стабильного layout'а: устойчивая раскладка не переучивается). Без доводки
первый кадр после открытия красился по оценкам — стартовое окно сидело на
середине списка. Дампы проб это уважают: estimate-продьюс не съедает
`--dom-dump` — путь доживает до доводочного кадра. `--snapshot` наоборот
перезаписывается каждым продьюсом: выживший файл = последний
спродюсенный кадр (усевшееся конечное состояние жеста), а не первый
случайно стабильный.

Диагностика окна выбора: `NEOTA_WIN_DEBUG=1` печатает на каждом продьюсе
`[win-debug] scroll/extent/budget/start/span/lead/trail` и высоты всех рядов
индекса (estimate vs learned) — прямой взгляд в `virtualized_window` при
охоте за пустотами/сдвигами окна.

Клэмпы границ: `ChatSession::scroll_max_css()` = (протяжённость − вьюпорт)
по тем же гэп-осведомлённым высотам; `scroll_chat_by` клэмпит в [0, max]
(до этого верх не клэмпился вовсе — оверскролл вверх рос неограниченно);
цель колеса и визуал анимации клэмпятся тем же максимумом (кэш на хосте
обновляется на каждом produce). **Репин прижатого верха**: флинг к топу
клэмпится по extent'у, известному на импульсе; когда обучение вырастает
в extent, produce репинит прижатый офсет (`set_scroll_offset_css`) — один
флинг доезжает до верха, а не застревает посередине (прыжок едет следующим
продьюсом: текущий растр садится на своё окно, снапа нет).

Сопутствующее: нотч колеса `WHEEL_LINE_CSS` 40 → **100px** (winit отдаёт
1 строку/нотч и не применяет системную настройку «строк на нотч»; 40px против
браузерных ~120 читалось как «ничего не листается»); `ScrollLatest` был
**инвертирован** (+1e6 шёл к самым старым, а не к новым — теперь −1e6,
посадка в 0).

### Оверскан-ранвей: скролл на частоте монитора (история: «книга» → produce-driven → blit)

Эволюция модели показа. Первая жалоба «листается как книга» вскрыла
blit-сдвиг замороженного растра с заливкой кромки обоями; её сменила модель
«продьюс = кадр» с квантованием лендов до 33 мс (30 fps визуала, ~8% CPU).
Финальная модель возвращает vsync-blit, но с **запечённым оверсканом**:
на кромке полосы показываются реальные строки, поэтому продьюсы нужны
только на лендах — раз в несколько сотен пикселей жеста.

Механика (все константы в одном месте — `CHAT_OVERSCAN_CSS` в
`product_path.rs`, 256 css px):

- **Окно красит соседние ряды**: `virtualized_window` расширяет span на
  ±2 ряда за полосу; `hidden_above` растёт на высоту lead-рядов (канва
  съезжает вверх на те же px — ряды полосы не двигаются). Бокс вьюпорта
  absolute ±`CHAT_OVERSCAN_CSS` за панель клипает их — они красятся под
  полупрозрачным хромом и за краями панели.
- **Растр выше экрана**: `PresentSurface::resize(w, h, overscan_phys)`
  аллоцирует scene/resolve высотой `h + 2×overscan`; doc-сцена красится в
  среднее окно (`Scene::append` с translate +overscan).
- **Blit-маппинг**: экран мапится в среднее окно растра
  (`doc_y = uv.y × scale + top`, uniform `scroll[3].zw`), сдвиг нормируется
  к высоте растра; `scroll[4].xy` — окно источника: ЗАПЕЧЁННЫЕ РЯДЫ КАНВАСА
  (`BlitWindow.src_top/src_bottom`, абсолютные строки растра; хост считает
  их из кэша продьюса `chat_canvas_css` и добавляет overscan-полосы РОВНО
  ОДИН раз, клампя к краям растра — кламп к css 0/css_h срезал бы ранвей
  внутри полос, а повторное добавление overscan в шейдере уводило окно на
  полосу вниз и заливало верх полосы на покое). Оно НЕ равно всему растру:
  под
  полосой doc-сцена рисует КОМПОЗЕР, и незажатый сдвиг размазывал призрак
  композера по нижнему краю полосы (двойной композер в скролле + «рывки» на
  каждой посадке — призрак прыгал). Строки за канвой уходят в старую ветку
  заливки обоями/флатом, как при старом капе 96px. Юниформ — 5 строк
  (80 байт) у обоих хостов; Android пишет flat-маппинг и старый банд — его
  поведение не менялось.
- **Направленные капы из ранвея**: `ScrollAckLoop::set_runway_caps(older,
  newer)` — кап привязан к ТОМУ краю, который сдвиг реально обнажает.
  Знаки: визуальный офсет растёт к СТАРЫМ сообщениям (0 = низ/новейшие),
  blit сэмплит `doc − drift` (сдвиг контента = перемещение К визуалу), т.е.
  ПОЛОЖИТЕЛЬНЫЙ дрейф двигает контент ВНИЗ и обнажает ВЕРХНИЙ край полосы —
  ограничен запасом НАД полосой (`cap_older`); отрицательный двигает вверх и
  ограничен запасом ПОД полосой (`cap_newer`). История: сначала пара была
  перепутана в одну сторону, при починке призрака композера — в другую;
  финальная пара выверена трекингом контента по кадрам (позитивный дрейф =
  контент вниз = верхний край). Кэп берётся из клипнутых боксом extents
  канвы (`chat_canvas_top_css`/`chat_canvas_bottom_css`). На нижнем пине
  запас вниз ~0 (под полосой рядов нет — там композер): кап садится на пол
  12px, и петля честно пересаживается каждые ~12px — у пина по-другому
  нельзя.
  `advance_and_land_scroll` = сэмпл анимации + ленд на пересечении капа;
  по окончании жеста остаток садится через ack-эпсилон.
- **Драг двигает визуал напрямую** (blit 1:1, ноль задержки); посадки —
  на капе. Поле `pending_drag_css` удалено.
- **chrome-block**: хедер и пилюля несут `data-action="chrome-block"`
  (`TapIntent::None`) — тапы по неинтерактивным зонам хрома не проваливаются
  к action-кнопкам оверскан-рядов, нарисованным позади (семантика
  overlay в React: дети хрома в DFS-хвосте выигрывают первыми).
- **Chrome-split (стадия 2): хром красится в отдельные сцены.** Один обход
  дерева (`ProductVelloSession::paint_split`, m0-d2) выдаёт ТРИ vello-сцены:
  контент + хедер + пилюля. Маршрутизация — в вендорном blitz-paint:
  у корня `chrome-block`-поддерева painter вызывает
  `PaintScene::set_chrome_route(Header|Composer)`, при выходе из поддерева
  возвращает `Main`; сцены без хука (Android) игнорируют маршрут и красят как
  раньше. Маршрут решается по АБСОЛЮТНОМУ y (сумма `final_layout.location.y`
  по цепочке предков): taffy-координата относительна родителю, а пилюля живёт
  внутри `composer-sticky` (её собственный location = 0) — относительный тест
  увозил весь композер в header-сцену, IDENTITY-аппенд рисовал его посреди
  банды (призрак композера на свипе), а настоящая нижняя полоса оставалась
  пустой. `ChromeRouterSink` (m0-d2) делегирует каждый вызов сцены по
  маршруту; producer-стрим пишется только с Main-маршрута. Аппенды в
  продьюсе: контент — `+overscan` (среднее окно), хедер — IDENTITY (верхняя
  полоса растра), пилюля — `+2×overscan` (нижняя полоса). Асимметричный бокс
  вьюпорта (`top: −(CHAT_OVERSCAN_CSS − header_h); bottom: 0`) в обоих
  рендерах: строки не заходят в полосы хрома.
- **Композит хрома в шейдере**: экранные зоны хрома (вне банды) сэмплируют
  свои полосы и накладывают ИХ поверх несдвинутого сэмпла контента как
  source-over (`rgb = chrome.rgb + rgb·(1−chrome.a)`) — полупрозрачный хром
  честно смешивается со строками позади, ровно как инлайн-покраска до
  сплита. Простое сложение (без альфы) пересвечивало хром. Банд свободен от
  хрома по построению: полосы лежат вне окна источника и вне досягаемости
  капов, дрейф физически не может занести хром в контент.
- **Панельная заливка прозрачных сэмплов**: всё, что не покрывают обои,
  заливается цветом панели — и под запечёнными строками (прозрачные межстрочные
  зазоры и незапечённый ранвей), и в filler-ветке за канвой. Очищенный растр
  больше не читается как чёрный: на свипе обнажённый край полосы — ровная
  панельная заливка (тот же вид, что давал старый filler-кап 96px), а не
  чёрная полоса.
- **Строки в ранвее (стадия 3): корневой клип покраски расширен на оверскан.**
  Вендорский обход красил только окно экрана — корневой клип = точный
  вьюпорт, поэтому любые ряды/хвосты рядов, разложенные выше css 0
  (lead-ряды окна и подсрочный офсет), отсекались ДО покраски и в полосу
  растра не попадали: и на свипе (дрейф сэмплирует css < 0 → плоская
  пустота до капа), и в покое (граница ряда у верха банды оставляла
  [0..граница] плоской — сотни px пустоты на фото-рядах). Теперь
  `paint_split(filter, CHAT_OVERSCAN_CSS)` зовёт `paint_scene_expanded`
  (blitz-paint): корневой клип растягивается на `clip_expand_css` css px
  во все стороны, ряды красятся в полосы растра (overscan-бокс
  `[−(256−56)..1009]` режет их ровно по границе полос хрома), шейдер
  сэмплирует их при дрейфе в обе стороны. Односценовый `paint()` (Android)
  и под-документы остаются на точном клипе. Панельная заливка (выше)
  остаётся честной для зазоров МЕЖДУ рядами и для хвостов за пределами
  окна выбора.

  Верификация (release-проба `--wheel 120 ×10` вглубь к старым, 1920×1009):
  resolve-пики полосы [56..256phys] = 100% непрозрачных сэмплов с текстом/
  фото (до фикса — 0%); покой при scroll=1200 — банд заполнен, плоские
  пробежки в банде = только штатные межстрочные гэпы 40px; покой пина
  (scroll-to max) — окно = верхние ряды, банд заполнен; трекинг свипа —
  монотонный ease-out (−94→−2px), 0 шагов назад; `header=37 / composer=83`
  путей сцен хрома не изменились. `cargo test -p neotavern-presentation-chat
  --lib` (34) — зелёные; сломанные тест-таргеты m0-d2 — известный долг HEAD
  (15 ошибок на чистом HEAD, stash-проверка), не этого среза.

  Верификация chrome-split (release-проба 5×`--wheel 40`, 1920×1009, 122
  кадра): тёмных (чёрных) строк на свипе — 0 на всех кадрах; трекинг
  контента — 0 шагов назад, 0 скачков >24px на 119 парах кадров; пики
  растра подтверждают запечённые полосы (пилюля `[30,27,25,α230]`,
  кнопка Send `[227,138,98,255]`); покой структурно совпадает с
  до-сплитным (те же строки, одинарный композер, плейсхолдер и бордер на
  местах); `cargo test -p neotavern-presentation-chat --features gpu` (51),
  shell (4), fmt/clippy по затронутым крейтам — зелёные (сломанный
  тест-таргет m0-d2 — известный долг HEAD, не этого среза).
- **Snapshot-проба** читает среднее окно растра (origin y = overscan), так
  что goldens остаются размера окна.

**Про data-neoui:glass**: атрибут/класс `neoui-glass` — это ВЫРЕЗАНИЕ
контента под узлом (в растре под стеклом остаётся только фон узла, сквозь
него видны обои — «wallpaper cutout»). Для продуктового хрома это ломало и
React-паритет (в React строки видны сквозь 70% стекло), и оверскан (ряды
под хедером стирался). Glass снят с хедера и пилюли в обоих рендерах —
их полупрозрачные фоны (rgba 0.78–0.88) теперь честно красятся поверх
строк; `glass=2` в логе продьюса исчез (продуктовый хром больше не несёт
барьеров), M0-стабы (`TripleGlass`/`NestedDialog`) атрибут сохранили.

Верификация (release-пробы, 1100×760): непрерывность `--wheel 37` →
`--wheel 137` = общие строки ровно +100.0px; mid-flight полосы показывают
контент (std 11–48 у верха банды на тике 15мс флинга 2000px, нулей и
плоской заливки нет); жест 600px = 2 продьюса, флинг 2000px = 6 (тёплые
9–14 мс); swapchain-дамп: хедер/пилюля на местах, контент по всей полосе;
goldens пересняты (0.0000%, 4 размера); `scroll_ack`-тесты, live_wire
(196 тестов), shell (19), android-target check — зелёные.

### Оверлей-структура workspace: React-паритет (это был «композер отдельным блоком»)

React `ChatWorkspace.module.css`: вьюпорт занимает **всю** панель
(grid-row 1), хедер — абсолютный оверлей с blur-стеклом, композер — sticky
внутри скролла: сообщения едут ПОД хромом. Натив же красил три непрозрачные
flex-полосы (хедер/бокс/композер) — «поле ввода как отдельный блок». Теперь
структура зеркалит React в обоих рендерах:

- viewport — full-height (`flex:1` при out-of-flow хроме), scroll body
  несёт `padding-top = header + pad` (строки в тех же px, что и в старой
  полосной раскладке) и `padding-bottom = 12px` (React `space-md`);
- хедер — `position:absolute;top:0;left/right:{pad}px` **без z-index**
  (не-auto z-index Blitz поднимает поддерево в stacking-context и не
  возвращает при relayout — см. комментарий в `lib.rs`); слои — порядок DOM:
  `[viewport, header, composer]`; поповеры сессии сохраняют свой
  положительный z-index и остаются поверх всего;
- композер — absolute-обёртка снизу (`composer-sticky`), пилла плавает над
  панелью на `composer_float_css` (16px desktop / 8px compact = React
  chat-composer-edge-inset); строки заезжают под пиллу и видны сквозь её
  полупрозрачный фон (glass-вырезание с хрома снято — см. раздел
  «Оверскан-ранвей», абзац про `data-neoui:glass`);
- поповеры вьюпорта (снапшоты, variant-picker, детали, история) перенаборы
  ниже хедера: `top = header_h + 12px` (та же визуальная позиция, что в
  полосной раскладке);
- `chrome_metrics` теперь вычитает float-инсет: раньше метрика вьюпорта
  игнорировала 16px обёртки и полоса математически заходила под пилюлю
  (последняя строка красилась на 8px ПОД верхом пилюли). Поповеры-калькуляторы
  в `shell_hit` (`composer_bottom`) синхронизированы с инсетом.

DOM-порядок хрома в `lib.rs` (legacy и blueprint ветки собираются в одном
месте): блок хедера перенесён ПОСЛЕ блока вьюпорта — за счёт этого хедер и
композер красятся поверх строк; skeleton parity-гейт прошёл без правок
теста, goldens пересняты (0.0000%).

Верификация (пробы dom-dump, 1920×1009, release):

- старт (офсет 0): новые строки прижаты к низу — lastBottom=803 при
  верхе пилюли 819 (16px зазор = scroll pad), окно = последние строки,
  верхняя строка частично заезжает под стеклянный хедер (как в React);
- геометрия оверлеев: хедер y=0 h=56 (absolute), вьюпорт h=1009
  (full-height), пилла 819..993, обёртка до 1009 (флоат 16px);
- `--wheel 37` → `--wheel 137`: те же строки сдвинулись ровно на +100px,
  сверху вошла новая строка и кровоточит под хедером — непрерывность;
- `--wheel 100000`: топ списка, скрытый офсет 0, первая строка от верха
  канваса;
- mid-flight `--wheel 200 --tick 60`: eased-офсет 100 из 200;
- контракт-тест `chat_scroll_window_is_continuous_and_pins_both_edges`
  (live_wire) закрепляет инварианты окна;
- golden-гейт после переснятия базы: 0.0000% на 4 размерах.

## Image-пайплайн: этап A аудита (cover-fit, радиусы, snap, мипмапы)

Корневой аудит изображений — в
[native-image-pipeline-audit.md](native-image-pipeline-audit.md); его этап A
(«остановить кровотечение», без смены архитектуры) выполнен:

- **Cover-fit в `AVATAR_WGSL`**: uniform получил `tex_aspect`; фрагмент
  сэмплирует центральный регион текстуры под аспект dest-ректа. Квадрат
  192² кропится в 4:5-слот галереи (`object-fit: cover` React-семантика), а
  не растягивается; обои (аспект совпадает) — identity.
- **Радиус клипа из слота**: RSX эмитит `data-avatar-radius` рядом с
  `data-avatar-asset` (scene_chat: 16 — шапка чата, 18 — аватар сообщения —
  круги; product_shell: 10 = `--st-radius-control`). Дефолт для слотов без
  атрибута — прежний `AVATAR_CLIP_RADIUS_CSS`. Аватары шапки/сообщений
  перестали быть «квадратными в круге».
- **Pixel-snap**: dest-ректы `round(css × scale)` — края оверлея больше не
  полупиксельные против резкой сцены.
- **Мипмапы**: цепочка строится на CPU при upload (премультиплицированный
  даунсэмпл линеен; wgpu 29 не имеет `generate_mipmaps`) с
  `MipmapFilterMode::Linear` — минификация 192² → 32–108 px без алиасинга.
- Удалена мёртвая `AVATAR_OVERLAY`-ветка Android (static + JNI else-if +
  `composite_avatar_overlay`) — никто не ставил флаг.

Верификация (Vulkan, 1100×760): дифф против прежнего кадра — 10 676 px из
836 000, кластеры строго в аватарных зонах (слоты сайдбара, шапка чата),
остальной кадр бит-в-бит; шапка визуально круг; mid-flight сдвиг
`--wheel 40 --tick 60` с `--wallpaper`: 525 px шума из 286 624 в
chat-колонке, header/composer — 0 diff, филлер — #151311; попутно починен
некомпилируемый тест `inline_phosphor_svg_paints_a_fill` (паттерн без `..`).
Остаётся из аудита: этап B (in-scene Image brush — z-order, modal-клипы,
message-image) и этап C (обои вне blit-сдвига, токенизация, миниатюры ядра).

## Этап B: картинки в сцене (2026-09-05)

Аватары и фото-сообщения больше не рисуются пост-проходом поверх кадра —
они часть vello-сцены, поэтому z-order (модалки, панели), клипы и opacity
работают сами:

- **DOM**: аватарные слоты и markdown-фото несут `<img src="asset:{id}">`
  (absolute fill в слоте, `object-fit: contain` + max-height 420 у фото).
- **Провайдер**: `LocalNetProvider` (`presentation-m0-d2/src/asset_net.rs`)
  резолвит `asset:{id}` из процесса-LRU `AssetStore` (64 записи / 32 MiB);
  `data:`-растровые URI — как раньше; SVG по-прежнему не разрешён.
- **Гидрация**: аватары — PNG 192² из `insert_avatar_thumb`
  (`display_png_from_thumb`); фото сообщений — аспект-сохраняющая миниатюра
  ≤768px (JPEG q82 / PNG с альфой) из `hydrate_message_assets`
  (парсер `asset_image_refs`, лимит 32 фетча за проход).
- **Sink**: `brush_ref` кодирует `Paint::Image` в vello (persistent image
  atlas). Репро-тест `gpu_vello_image_brush_rasterizes_on_the_sampled_target`
  держит контракт «пиксели картинки попадают в sampled-таргет».
- **Kill-switch**: `NEOTA_INSCENE_IMAGES=0` возвращает Stage A-поведение
  (Image-браши дропаются, GPU-оверлей аватаров снова рисует).
- Оценка высот строк с фото в `compositor_height_index` — `56+436` CSS px,
  иначе overscan открывает прозрачную щель (debug_assert chat-viewport).

Верификация: desktop-снапшот (`--messages 3 --snapshot`) — фото-сообщение
и все аватары рисуются в сцене при отключённом оверлее; репро-тест
атласа зелёный; 95/95 `compositor_host` (включая blueprint-parity и новый
контракт `raster_images > 0`); демо-данные переведены с `asset:thumb-N`
(нарушал UUID-контракт `assets.content`) на детерминированные UUID.
Android: `cargo check --target aarch64-linux-android` зелёный; первый
запуск на устройстве — проверить скриншотом (атлас на device Vulkan не
воспроизводим в этой среде), при регрессии — escape-hatch выше.

## Этап C: обои вне blit-сдвига, токены, kernel-миниатюры (2026-09-06)

**Обои — фиксированная подложка blit-шейдера.** Фото больше не запекается в
`resolve` до blit: `PresentSurface::upload_wallpaper(epoch, thumb)` + `set_wallpaper_rect`
кладут текстуру (биндинги 3/4) и рект в uniform (расширен 32→64 байта, строки
2/3: uv-рект + enable + dim-альфа). Шейдер сэмплирует обои по НЕсдвинутому uv
внутри ректа (fixed under-scroll), under-composite поверх премультиплицированной
сцены; регион бэнда past-the-end показывает фото вместо плоского филлера
#151311 (без обоев шейдер бит-в-бит прежний). Рект — layout-рект
`part:chat-wallpaper` из slot-скелета: дива обоев/дима перенесены внутрь
`main#chat-workspace` (bleed −12px = `--st-space-md`), поэтому фото не светится
сквозь сайдбар. Дим (React-градиент внутри `.wallpaper`) — в шейдере
(`scroll[3].y` = `ui_opacity/100·0.45`), сценовый див дима в wallpaper-режиме
прозрачен. `composite_wallpaper_under`/`AvatarGpu::blit_under`/`pipeline_under`
и `WALLPAPER_ASSET_ID` удалены. Общий `BLIT_WGSL` десктопа и Android
идентичен; Android держит wallpaper-строки нулями (1×1 dummy-текстура).

**Токенизация слотов.** `ThemeTokens` получил size-токены Theme SDK
(`control-height*`, `space-{sm,md,xl}`, парсинг из манифеста, `*_px`-хелперы).
Аватарные слоты (шапка 32 = `2xs`, сообщение 36 = `xs`, карточка 52 =
`large` — было 48, parity-fix, редактор 64 = `calc(large+md)`, панельный
header 44 = `control-height`) и `data-avatar-radius` рендерятся из токенов;
viewerAvatar = React-паритет (`contain`, `radius-control`).

**Миниатюры на стороне ядра.** Новый wire-op `assets.thumb`
(`assetId` + `maxPx 16..1024` → `format/width/height/contentBase64`): ядро
декодирует с preflight-лимитами (≤64 MiB, ≤16384 px оси, ≤64 MP), делает
aspect-сохраняющую миниатюру (JPEG q82 / PNG с альфой) и кэширует в
`<data-root>/cache/thumbnails/{sha256}-{maxPx}-v1.{ext}` (атомарно, §12).
Гидрация аватаров (192) и фото сообщений (768) ходит в `assets.thumb` —
оригиналы (2.2 MiB base64) по проводу не передаются; `AvatarThumb` без
cover-кропа (кадрирование делают cover-fit/object-fit).

Верификация: `--swapchain` снапшоты — обои только в workspace, при
`--blit-shift 280` фото/дим неподвижны; contracts 114 + `contracts:check`;
kernel (4 новых thumb-теста), chat 42+95+26+1, shell 15, design-system 27,
m0-d2, session — зелёные; android check presentation-chat зелёный (kernel
на android-таргете не проверяем — нет NDK для `ring`).

## Волна 2 «хвост корректности» (2026-09-08)

**Честный «Context N%».** Триггер контекст-панели больше не пишет хардкод
«Context 4%»: один хелпер `scene_chat::context_meter_label` строит
«Context N%»/«N%» из `usage_percent` (blueprint-ветка через
`render_button`, legacy-RSX — прямо в `product_chat_app`). Нет оценки —
«Context 0%».

**Clamp модалок.** `modal_geometry` паркует диалоги выше вьюпорта у верхней
кромки (`y = ((height - dh) * 0.5).max(0.0)`), а не уводит в минус.

**chats_hit из layout-токенов.** Геометрия хитов домашней панели выведена
из общего модуля `chats_tab::chats_layout` (тот же источник, что рендер):
тамбл-пэддинги, поиск 44px, дивайдер 1px, кнопка 44px (замер), гэп 8px.
Высота строки теперь по форме строки: строка с `character_label` — 76px
(замер живого рендера), без — 59px (−17px мета-строка); рендер пиннит
высоту `<li>` из того же токена, так что хит и краска совпадают по
построению. Верхний якорь — прежний `header_bottom`. До фикса хит считал
все строки по 76px и уезжал с 3-й строки смешанного списка.

**Скрипт-чувствительный `estimate_height`.** База высоты строки
(A3-модель: окно гидрации и композитор) считалась по UTF-8-байтам —
кириллица завышалась ×2, эмодзи ×4. Теперь через `estimate_tokens`
(плотности скриптов), PX_PER_TOKEN калибрует латиницу 1:1 к прежней
модели; кэп +160px сохранён.

**Коррекция высот по факту покраски (L3).** Оценка — эвристика; измерение —
истина. Каждый produce отдаёт painted-ректы строк
(`paint_layout().messages`), сессия запоминает их в bounded-LRU
(`height_corrections`, кэп 512, AGENTS §20) с capture-оценкой: правка
содержимого строки сама инвалидирует коррекцию (capture-оценка перестаёт
совпадать). Все три потребителя высот читают одно `row_height_css` /
`corrected_height`: окно виртуализации (`virtualized_window`, помечено
`HeightKind::Exact`), индекс композитора (`compositor_height_index` —
измеренная строка без «+436 за фото»: замер уже включает реальную высоту
фото) и окно гидрации через тот же индекс. Обучение не бампает сцену —
коррекция подхватывается следующим produce, петли produce нет.

**Карточка деталей живёт вне видимого окна.** `ProductChatView.details_row`
резолвится из ПОЛНОГО списка сообщений (React держит объект сообщения, не
срез окна): скролл владельца за окно больше не схлопывает карточку.

**JNI: transport-ключ ≠ run id.** `last_run_id` не отдаёт синтетический
ключ `s<pointer>` как `sourceRunId` (ретраи падали бы с
GENERATION_RUN_NOT_FOUND): ядро получает реальный run id из события
(`generation.step.runId` / `generation.completed.generationRunId`);
`stream_key_from_frame`/`run_id_from_frame`/`is_synthetic_stream_key`
переехали в `wire.rs` (тестируемы на десктопе), FakeWire получил
JNI-паритетный режим `with_synthetic_stream_keys`.

**Rc→Arc для кэша карточек.** `CharacterCardsCache.cards` и
`ProductShellView.characters` — `Arc<Vec<..>>` (Send): JNI-статик
`ROUTE: Mutex<Option<ChatSession<..>>>` требует Send, `Rc` ломал
android-сборку среза C. Заодно закрыты два старых разрыва android-таргета:
`shell_without_avatars` через `Arc::make_mut`, `produce_and_raster`
получил обязательный `AssetStore` (аргумент #6 `ProductVelloSession::open`).
Android check `--target aarch64-linux-android --features android-jni,gpu`
зелёный.

**Не менялось (ложное срабатывание аудита).** «stale `<` → `<=`» в
`m0-d2/lib.rs:213`: события живого роута несут один `generation`, поэтому
`<=` отбрасывал бы все кадры стрима после первого — оставлено как есть.
