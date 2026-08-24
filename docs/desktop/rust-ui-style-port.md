# Rust UI style port — быстрая петля итерации

Developer workflow для переноса стилей из React в нативный Rust-рендер
(Dioxus/Blitz + vello/wgpu) **без** пересборки Rust на каждый «мелкий фикс».
Он покрывает два документально известных источника боли (ADR-0055):

1. ручное переписывание RSX/координат/эвристик в Rust-коде;
2. `PRODUCT_CSS` как `include_str!` — любая правка токена вела к перекомпиляции
   крейта и (на телефоне) gradle/JNI.

## Принцип

**Стили — это данные, а не код на Rust.** Единственный источник правды —
React CSS Modules и токены (`packages/ui`, `apps/web`). Рендерер (Blitz)
умеет CSS, поэтому порт стиля = RSX воспроизводит структуру DOM + имена
классов **один раз**, а дальше оба фронта кормятся **одним и тем же** packed
CSS. Не дотюнивай числа в Rust «под скриншот» — каждый такой твин отдаляет от
источника и рождает новый дифф (аудит это прямо запрещает: «do not retune
`#151311` / `#24211e` from screenshots»).

## Петля (идеальный цикл мелкого фикса)

```text
правка React CSS/токена (apps/web | packages/ui)
  → [авто] python crates/presentation-design-system/scripts/pack_design_system.py
          (или pnpm design:watch, см. ниже)
  → [hot] NEOTA_DEV_HOT_STYLES=1 → продукт читает generated/product.css из файла
          (без cargo вообще; кэш по mtime)
  → [измерение] скриншот-дифф: node scripts/style-golden-diff.mjs
          React-golden PNG vs native raster PNG → дифф-картинка + % совпадения
  → телефон только когда вопрос именно про устройство (драйвер, insets,
          SurfaceView interop, сенсор)
```

## Команды

| Что                                                              | Команда                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Перегенерировать пак вручную                                     | `pnpm design:pack`                                                                                                                                                                                                                                                                                                                    |
| Авто-репак при изменении React CSS (watch)                       | `pnpm design:watch`                                                                                                                                                                                                                                                                                                                   |
| Пиксель-дифф golden-гейт                                         | `node scripts/style-golden-diff.mjs --golden <react.png> --native <native.png> --json`                                                                                                                                                                                                                                                |
| DOM-паритет слотов (чат)                                         | Native: `--dom-dump build/native-dom.json` у `neocompositor-desktop` / `product-shot`. React: `pnpm dom:dump-react -- --url http://127.0.0.1:5173/home --out build/react-dom.json`. Сравнение: `pnpm dom:parity -- --native build/native-dom.json --catalog scripts/dom-parity/chat-slots.json` (опц. `--react build/react-dom.json`) |
| Runtime hot CSS (debug/shell)                                    | `NEOTA_DEV_HOT_STYLES=1` (+ опц. `NEOTA_DEV_HOT_STYLES_PATH=...`)                                                                                                                                                                                                                                                                     |
| Native raster (vello/wgpu, тот же пайплайн, что на Android)      | `cargo run -p neotavern-presentation-m0 --features gpu --bin cm-raster -- --viewport=expanded --out=build/native.png`                                                                                                                                                                                                                 |
| Real-shell raster (PNG, `product_shell_app` через NeoCompositor) | `cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2 --features gpu --bin product-shot -- --w 1280 --h 800 --out shot.png`                                                                                                                                                                                    |
| Windowed shared host (Windows/macOS)                             | `cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-chat --features desktop-host --bin neocompositor-desktop -- --messages 12` (см. [neocompositor-desktop-host.md](neocompositor-desktop-host.md))                                                                                                                |
| Реакт-golden скриншот                                            | Playwright-захват Character Manager (`scripts/ui-oracle/capture.mjs` + golden в `crates/presentation-design-system/generated/react-golden-character-manager.png`)                                                                                                                                                                     |

## Что делает каждый кусок

### 1. Пакер — единственный источник для Rust

`crates/presentation-design-system/scripts/pack_design_system.py` пакет:

- шрифты Outfit / JetBrains Mono (точные TTF),
- Phosphor regular path'ы (SVG `viewBox 0 0 256 256`),
- тёмный `--st-*` токен-лист и CSS-модули App Shell / Sidebar / Character
  Manager / Personas / Lorebooks / Backgrounds / AI Settings / Plugins /
  Settings / MessageMarkdown / ChatWorkspace / MessageBubble.

Выход — `crates/presentation-design-system/generated/*` (в т.ч. `product.css`,
`phosphor.rs`, шрифты, `react-golden-character-manager.png`). **Пак не изобретает
токены, формы иконок или гарнитуры**, всё берётся из React.

### 2. P1 — runtime hot stylesheet (`NEOTA_DEV_HOT_STYLES`)

`crates/presentation-design-system/src/lib.rs`:

- `product_stylesheets_from_css(css, insets)` — общее ядро bake'а safe-area/
  простых токенов для embedded и hot пути (нельзя разойтись);
- `product_stylesheets_dev(insets)` — когда env `NEOTA_DEV_HOT_STYLES` задан,
  читает `generated/product.css` с диска с mtime-кэшем; иначе бит-в-бит
  идентично `product_stylesheets` (продакшен-путь не меняется);
- `NEOTA_DEV_HOT_STYLES_PATH` — переопределить путь (тесты/кастомные пакеты).

Потребители: `product_shell.rs` (RSX `<style>`),
`presentation-m0-d2::beat_blitz_default_css` (user-agent sheets Blitz). После
правки CSS продьюсер (shell/m0-d2) перезапускается и подхватывает новый файл
**без компиляции Rust**. Следить: `product.css` — это пак из React, поэтому
правь React CSS → `design:watch` перепакует → рестарт продьюсера.

Тесты: `hot_styles_tests` (юнит) + `tests/hot_styles_env.rs` (интеграция
env-переключателя).

### 3. Watch-обёртка (`scripts/watch-design-system.mjs`)

Poll'ит mtime+size по `apps/web/src`, `packages/ui/src`, vendored
шрифты/иконки и сам пакер, и на изменение (debounce) запускает pack.
Флаги: `--once` (CI), `--dry-run`, `--interval-ms`, `--debounce-ms`,
`--quiet`. Бинарник Python: `DESIGN_PACK_PYTHON` (по умолчанию `python` на
Windows, `python3` иначе). Тест: `scripts/watch-design-system.test.mjs`.

### 4. Пиксель-дифф гейт (`scripts/style-golden-diff.mjs` + `scripts/lib/pngcodec.mjs`)

- PNG-кодек без внешних зависимостей (RGBA8/RGB8, бит-глубина 8,
  non-interlaced, фильтры 0–4, проверка CRC) — ровно то, что эмитят
  Playwright и Rust `image::save_buffer`;
- `compareImages` / `buildDiffImage` → метрика `{differentPixels,
percentDifferent, maxChannelDelta}` + дифф-PNG (отличающиеся пиксели —
  красным);
- `--resize nearest` при несовпадении размеров;
- gate-режим `--max-diff <percent>` — exit 1 при превышении;
- тест: `scripts/style-golden-diff.test.mjs` (вкл. CLI end-to-end).

### 5. Oracle-гейт (машинное «похоже/не похоже»)

`scripts/ui-oracle/capture.mjs` + `gate.mjs` сравнивают React
(`data-ui-*`) и нэйтив по четырём осям: семантика, layout, action trace,
растровый хэш (ADR-0055, пилот — Character Manager Cards). Это линейка для
геометрии; пиксель-дифф (§4) — для цвета/растра.

### 5b. Chat golden gate (M0.5, локальный)

`pnpm chat:golden` / `pnpm chat:golden:check`
(`scripts/chat-golden.mjs`) — самогейт чата: goldens — легаси-RSX растры
`neocompositor-desktop` на канонических размерах 1100×760 / 900×700 /
620×800 (`crates/presentation-chat/assets/goldens/`); `check` перерисовывает
те же кадры с blueprint-документом (`--blueprint embedded`) и пиксельно
диффит против них. На эталонной машине расхождение — шум глифового AA
(≤0.0006%, delta ≤1), гейт по умолчанию `--max-diff 0.01 --threshold 2`.

**Только локально:** растр wgpu/vello не воспроизводим между машинами и
драйверами, поэтому в общий CI гейт не ставится. Бинарнику некуда спешить —
скрипт ждёт появления/стабилизации снапшота (mtime после запуска) и сам
завершает процесс; путь переопределяется `NEOTA_DESKTOP_BIN`. Тесты
констант: `scripts/chat-golden.test.mjs`. После flip-а ADR-0056 capture
явно уходит в легаси флагом `--legacy-chrome` — goldens остаются снимком
рукописного RSX, а check рендерит blueprint.

Полная петля правки UI как данных (документ → валидация → хост → гейты):
[`chat-ui-recipe.md`](chat-ui-recipe.md).

### 6. Общий десктоп-хост (`PresentSurface` + `neocompositor-desktop`)

Тот же продуктовый маршрут (ProductWire → Dioxus → Blitz → NeoCompositor →
vello → swapchain), что гоняет Android-`SurfaceView` хост, в нативном winit-окне
на Windows/macOS. Общий хост живёт в `presentation-chat/src/vello_gpu.rs`
(`PresentSurface`), платформенного остаётся только `wgpu::Surface`. Запуск и
честные ограничения — см.
[`neocompositor-desktop-host.md`](neocompositor-desktop-host.md).

### 7. DOM-паритет слотов (`scripts/dom-parity/`)

Скриншот не говорит, _какой_ узел сдвинут. Оба дерева дампятся одним JSON
по документированным Theme SDK хукам — `data-component`, `data-part`,
`data-slot`, `data-role`, `data-action` (+ CSS-px rect). CSS Module-классы и
React fiber в дамп не входят (ADR-0055: React DOM — oracle, не native ABI).

```text
React (Playwright)                          NeoCompositor (Blitz layout)
dump-react.mjs --url …                      --dom-dump native-dom.json
        \                                         /
         → compare.mjs --catalog chat-slots.json
```

Каталог `scripts/dom-parity/chat-slots.json` — обязательные слоты чата из
`ChatWorkspace` / `ChatHeader` / `ChatComposer` / `MessageBubble`. `compare`
выходит 1, если native не публикует слот. Side-by-side `--react` + `--native`
показывает identities только слева/справа (без угадывания по PNG).

**Строгий гейт (M0):** флаг `--fail-on-diff` превращает side-by-side из отчёта
в блокер — любой identity, существующий только с одной стороны или с другой
счётчиком (включая высоты хром-бэндов), даёт exit 1. Высоты
`slot:chat.header` / `slot:chat.composer` сверяются с React в CSS-px
(`--rect-tolerance`, по умолчанию ±1px) — это прямой паритет `chrome_metrics()`
с оракулом и защита от класса дрейфа «композер уехал / пузыри обрезаны».

Полный строгий прогон требует живой дев-стенд и выполняется локально/пре-пуш:

```bash
pnpm dev &  # Vite 5173 + Fastify 8000
pnpm dom:dump-react -- --url http://127.0.0.1:5173/chats/<id> \
  --out build/react-dom.json --viewport 1100x760
cargo build --manifest-path crates/Cargo.toml -p neotavern-presentation-chat \
  --features desktop-host --bin neocompositor-desktop
crates/target/debug/neocompositor-desktop --w 1100 --h 760 --dom-dump build/native-dom.json
node scripts/dom-parity/compare.mjs --react build/react-dom.json \
  --native build/native-dom.json --catalog scripts/dom-parity/chat-slots.json \
  --fail-on-diff
```

CI пока гоняет детерминированные части гейтов (каталог слотов через vitest,
свежесть `product.css` через `design:pack:check`, Rust-тесты workspace);
полноценный React-vs-native job ждёт решения по сервисам дев-стенда в CI.

React-дамп требует живой дев-стенд (`pnpm dev`: Vite 5173 + Fastify 8000) и
живой чат: `pnpm dom:dump-react -- --url http://127.0.0.1:5173/chats/<id> --out
build/react-dom.json --viewport 1100x760` (`--viewport` выравнивает окно с
native-дампом, иначе виртуализация сравнивает разные объёмы строк; playwright
берётся из стандартного `@playwright/test`). Native dump не требует окна:
`product-shot --dom-dump …` или `inspect_slot_skeleton` в тестах
(`chat_slot_skeleton_covers_react_workspace_contract`).

Состояние на 2026-08: side-by-side для живого чата — «only in React: 0».
Нативная поверхность публикует весь набор хуков React-чата: обёртку
`chat-message-list`, `message-body`/`message-art` внутри фрейма, действия
`context`/`branch` в панели и `history`/`regenerate` + `message-swipe-pager`
в контролах версий, слоты оболочки `status.area`, `modal.layer`
(plugin-runtime-layer) и legacy-острова `slot:legacy.*`. Оставшиеся
«only in native» — сценарные различия (открытая панель управления персонажами,
10 seed-сообщений против живого чата) и намеренные нативные дополнения
(`action:composer-*`, `action:scroll-latest` для hit-testing).

## Запрещено (выучено на боли)

- править числа в `product_shell.rs` под скриншот — правь источник (React CSS /
  рецепт blueprint);
- полагаться на упакованные классы для новых контейнеров чата: атрибутные
  селекторы листа (`[data-component=…]`) с `margin-*: auto` Blitz резолвит мимо
  родителя и во флексе, и в блочном лееауте (схлопнутый user-пузырь) — новые
  нативные узлы стилизуются inline, data-* остаются контрактом;
- сочетать `justify-content` (flex-end/space-between) с `margin-*: auto`
  соседнего flex-item в одной строке: этот Blitz/Taffy распределяет свободное
  место дважды, и правый элемент улетает за родителя (~+385px на строке Send).
  Рабочая пара — `justify-content: flex-start|normal` + авто-маржин (визуал
  идентичен React `.composerActions`). Изоляция примера:
  `cargo run -p neotavern-presentation-m0-d2 --example send_layout_probe`;
- размерять chat-колонку от `viewport_width`: это ширина всего окна. База —
  `ProductChatView.column_width` (окно минус rail/панель,
  `shell_hit::chat_origin_from_parts`);
- менять токены `#151311` / `#24211e` / радиусы — они приходят из React dark
  sheet;
- вносить новые зависимости ради диффа/вочера — кодек и watch уже
  реализованы на stdlib;
- включать live glass на маршруте, пока непрозрачные скриншоты не совпали
  (policy `presentation-boundary.md`).

## Late Blitz fallbacks (каскадные победители)

`pack_design_system.py` эммитит `LATE_BLITZ_FALLBACKS` **после** всех листов
(конец `generated/product.css`). Ранний chat-блок `BLITZ_NEUTRALIZE` стоит до
сплющенных модулей и проигрывает равную специфичность — поздний блок выигрывает
каскад. Правила на 2026-08:

- `.AppShell_main/.AppShell_mainShifted`: `flex: 1 1 0%` — Blitz резолвит
  flex-basis auto по контенту, `<main>` раздувался под колонку 1080px, и
  пузыри обрезались краем окна;
- `.ChatWorkspace_workspace { width: 100% }` — `min(100%, 1080px)` Blitz
  считает не от того containing block; центрирование >1080px нативно
  сознательно не эмулируется.

### Stacking context (z-index) — хостинг крашит позицию

Blitz хойстит `z-index > 0` узлы в stacking context родителя (`draw_children` →
`pos_z_hoisted_children`) и рисует их с `parent_style_transform.pre_translate(pos)`,
где `pos` — поле stacking context, которое **не заполняется**: хостированный узел
рисуется в (0,0) контекста плюс свой `final_layout.location`. Пока корень
контекста сидит в (0,0) (например, rail с `z-index: 40` внутри shell) — не
видно; как только родитель позиционирован (chat-view/page на x=440), хостированные
дети уезжают: заголовок и композер рисовались на `440 + own_loc` вместо
`440 + 200 (workspace) + 0 (panel) + own_loc` — композер визуально уезжал влево,
«изображения (аватары) поверх всего», send не в своей колонке на FullHD. Лечение:
`LATE_BLITZ_FALLBACKS` обнуляет `z-index` у `.ChatWorkspace_chatHeader` и
`.ChatWorkspace_composerWrapper` (стек в нативном flex-flow не нужен; проверено
на 1920×1080, 1560×900, 1424×714, 1100×820 и legacy-пути).

**Обновление (vendor-фикс):** трассировка `NEOTA_TEXT_TRACE` показала, что
z-index — не единственный источник. Хойстнутые поддеревья (включая
blueprint-хедер с упакованным `position: absolute`) красятся от позиции,
**сохранённой при первой раскладке**: после resize 1424→1920 хедер оставался на
456/472 (parent_tx=440), пока viewport перекладывался на 656/672. Ни `z-index:
auto`, ни `position: relative` в CSS это не чинят — хойст-структура не
пере-якорится. Фикс в `crates/vendor/blitz-paint/src/render.rs`
(`fresh_hoist_offset`): offset хойстнутого ребёнка теперь считается при каждой
отрисовке как сумма `final_layout.location` layout-предков между hoist-целью и
ребёнком (сохранённая позиция — только fallback, если цель не найдена). CSS-фоллбек
(`position: relative; z-index: auto`) оставлен как страховка: нативным бандам
стек не нужен.

### Центрирование колонки нативно

`min()`/авто-маржины Blitz считает мимо родителя, поэтому геометрия чата
задаётся inline-пикселями в `product_chat_app` (lib.rs) и `product_shell.rs`:

- `<main>`: класс `AppShell_mainShifted` снят — его `margin-left: calc(60px +
  min(clamp(...), calc(100% - 60px)))` Blitz резолвит неверно на широких окнах;
  маржин не нужен (flex-row уже ставит main после rail+panel), фон
  `rgba(27,25,23,0.7)` инлайнится;
- workspace: `position:absolute; left:{chat_margin}px; width:{column}px` внутри
  relative page (margin/auto-centering на capped-колонке Blitz рисует в обход
  скелета);
- диагностика: `NEOTA_SCENE_DUMP=1` печатает stream-заливки с bbox
  (`StreamOp::Draw` теперь несёт `rect`/`fill_rgba`), `NEOTA_LAYOUT_PEEK=1` —
  абсолютные rect'ы Blitz-дерева перед `paint_scene` (сравнение paint vs
  skeleton: `--dom-dump`).

Композер: React держит его внутри scroll-viewport через `position: sticky`,
которого в Blitz нет. Нативный RSX (`product_chat_app`) хойстит
`composer-sticky` из viewport'а сиблингом-полосой — тем же контрактом, что уже
используют `chrome_metrics()`/компоситорные бэнды, поэтому последний экран
всегда заканчивается над стеклом без CSS-хаков.

## Продакшен-безопасность

Весь hot/dev-механизм выключен по умолчанию: без `NEOTA_DEV_HOT_STYLES` пути
бит-в-бит идентичны embedded (`product_stylesheets_dev` ≡
`product_stylesheets`). Паки/бины — не production-вырезание, см.
`presentation-boundary.md` и ADR-0038 (как и остальные `presentation-*`).

## Размерное соглашение и no-clip гейт

Контракт шелла по ширине окна:

- `viewport > 600` — рейл (60px) + панель фиксированной ширины
  (`panel_width`, clamp 260..720, по умолчанию 380) + чат.
- `viewport <= 600` (compact, паритет React `@media (max-width: 600px)`) —
  панель раскрывается на всю ширину окна минус рейл
  (`width: calc(100% - 60px)`), чат скрывается до закрытия панели.

Десктоп-окно Tauri имеет `min_inner_size(360×520)`; автономный хост
`neocompositor-desktop` — тест-хост и минимума не имеет (он обязан уметь
рендерить любые размеры, включая compact-height goldens 900×220).

Класс дефекта «панель фиксированной ширины рисуется за краем узкого окна»
закрыт автоматическим **no-clip guard** в `pnpm blueprint:packaged-check`
(этап 7): хост рендерится на 283×945, 360×640 и 900×220, и для каждого
кадра проверяется, что ни один «светлый» пиксель контента (текст/акцент,
R>120 && G>110) не лежит в пределах 2px от правого или нижнего края окна.
Тёмные full-bleed фоны у края допустимы и игнорируются; колонка рейла
(x < 60) у нижнего края исключена — рейл прибивает свою нижнюю иконку к
инсету, и на суб-минимальной высоте она подрезается by design (в продукте
min-height 520). Любая регрессия адаптивности падает на release-гейте, а не
на глазах у пользователя.
