---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/desktop/rust-ui-style-port.md
---

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

| Что                                                              | Команда                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Перегенерировать пак вручную                                     | `pnpm design:pack`                                                                                                                                                                                                     |
| Авто-репак при изменении React CSS (watch)                       | `pnpm design:watch`                                                                                                                                                                                                    |
| Пиксель-дифф golden-гейт                                         | `node scripts/style-golden-diff.mjs --golden <react.png> --native <native.png> --json`                                                                                                                                 |
| DOM-паритет слотов (чат)                                         | Native: `--dom-dump build/native-dom.json` у `neocompositor-desktop` / `product-shot`. React: `pnpm dom:dump-react -- --url http://127.0.0.1:5173/home --out build/react-dom.json`. Сравнение: `pnpm dom:parity -- --native build/native-dom.json --catalog scripts/dom-parity/chat-slots.json` (опц. `--react build/react-dom.json`) |
| Runtime hot CSS (debug/shell)                                    | `NEOTA_DEV_HOT_STYLES=1` (+ опц. `NEOTA_DEV_HOT_STYLES_PATH=...`)                                                                                                                                                      |
| Native raster (vello/wgpu, тот же пайплайн, что на Android)      | `cargo run -p neotavern-presentation-m0 --features gpu --bin cm-raster -- --viewport=expanded --out=build/native.png`                                                                                                  |
| Real-shell raster (PNG, `product_shell_app` через NeoCompositor) | `cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2 --features gpu --bin product-shot -- --w 1280 --h 800 --out shot.png`                                                                     |
| Windowed shared host (Windows/macOS)                             | `cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-chat --features desktop-host --bin neocompositor-desktop -- --messages 12` (см. [neocompositor-desktop-host.md](neocompositor-desktop-host.md)) |
| Реакт-golden скриншот                                            | Playwright-захват Character Manager (`scripts/ui-oracle/capture.mjs` + golden в `crates/presentation-design-system/generated/react-golden-character-manager.png`)                                                      |

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

### 6. Общий десктоп-хост (`PresentSurface` + `neocompositor-desktop`)

Тот же продуктовый маршрут (ProductWire → Dioxus → Blitz → NeoCompositor →
vello → swapchain), что гоняет Android-`SurfaceView` хост, в нативном winit-окне
на Windows/macOS. Общий хост живёт в `presentation-chat/src/vello_gpu.rs`
(`PresentSurface`), платформенного остаётся только `wgpu::Surface`. Запуск и
честные ограничения — см.
[`neocompositor-desktop-host.md`](neocompositor-desktop-host.md).

### 7. DOM-паритет слотов (`scripts/dom-parity/`)

Скриншот не говорит, *какой* узел сдвинут. Оба дерева дампятся одним JSON
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
  родителя и во флексе, и в блочном лейауте (схлопнутый user-пузырь) — новые
  нативные узлы стилизуются inline, data-* остаются контрактом;
- менять токены `#151311` / `#24211e` / радиусы — они приходят из React dark
  sheet;
- вносить новые зависимости ради диффа/вочера — кодек и watch уже
  реализованы на stdlib;
- включать live glass на маршруте, пока непрозрачные скриншоты не совпали
  (policy `presentation-boundary.md`).

## Продакшен-безопасность

Весь hot/dev-механизм выключен по умолчанию: без `NEOTA_DEV_HOT_STYLES` пути
бит-в-бит идентичны embedded (`product_stylesheets_dev` ≡
`product_stylesheets`). Паки/бины — не production-вырезание, см.
`presentation-boundary.md` и ADR-0038 (как и остальные `presentation-*`).
