# Предпроектная техническая спецификация: NeoUI v4 — Android presentation backend и 120-Hz live-glass compositor

**Проект:** NeoTavern  
**Редакция:** 4.5 (pre-gate evidence admission)  
**Дата:** 2026-08-17  
**Статус:** Draft Proposal / не является действующим каноном до Gate P и утверждающих ADR  
**Целевой путь в репозитории:** `docs/rfc/neoui-v4-android-presentation-backend.md`  
**Repository migration:** OPEN — корневая копия не считается перемещённой этой редакцией  
**Лицензия продукта:** GNU AGPL-3.0  
**Основной production target:** Android  
**Будущий mobile target:** iOS  
**Production Web на старте:** существующий React-клиент  
**Исследуемый performance target:** 120 Hz на поддерживаемых high-refresh mobile devices  
**Кандидат в hard visual invariant:** настоящий динамический live backdrop glass  

---

# 0. Исполнительная развилка

Этот документ **не утверждает миграцию Android UI**, Dioxus, NeoBlitz либо
собственный compositor как принятое решение. Он задаёт kill-first программу,
которая должна доказать или отвергнуть их до изменения production-канона.

До прохождения `Gate P` документ MUST храниться и цитироваться как proposal. Он
MUST NOT:

- отменять действующие ADR о React/WebView, Theme SDK или Plugin SDK;
- разрешать массовую миграцию экранов;
- использоваться как основание для обещания сроков production cutover;
- утверждать, что Android получает «тот же UI быстрее» без нового presentation
  ABI и отдельной parity-оценки.

Ниже описан самый дорогой кандидат `Track D`. Он становится целевой архитектурой
только после прохождения последовательных продуктовых и технических gates.

Кандидат NeoUI v4 отказывается от двух крайностей:

1. полностью собственного UI engine уровня NeoUI v2;
2. полного делегирования mobile rendering стороннему UI toolkit/compositor.

Архитектура-кандидат `Track D`:

```text
Rust Runtime Kernel
        │
        │ versioned Product Wire
        ▼
Presentation Models
        │
        ▼
Dioxus VirtualDom
        │
        │ bounded UI mutations
        ▼
NeoBlitz Adapter
DOM/style/layout/text/hit-test services
        │
        │ ordered NeoDisplayList
        │ paint chunks + effect/surface boundaries
        ▼
NeoScene
        │
        ▼
NeoCompositor
wgpu · layers · damage · glass · media · surfaces
        │
        ▼
Vulkan / Metal / platform presentation
```

Track D переиспользует upstream components для перечисленных generic задач
только после compatibility/conformance gates; статус production-ready не
предполагается из названия зависимости:

- component runtime;
- reconciliation;
- style resolution;
- layout;
- text shaping;
- font fallback;
- text rasterization;
- accessibility integration;
- базового input/IME integration;
- стандартной растеризации UI.

В Track D NeoTavern самостоятельно владеет только performance-critical composition layer:

```text
NeoScene
NeoCompositor
NeoGlass
NeoMedia composition bridge
PluginVisualSurface
damage/layer cache
frame scheduling fast paths
GPU resource lifecycle
```

Критическое условие осуществимости: upstream UI stack не рассматривается как
готовая единственная плоская текстура. NeoBlitz MUST уметь записать paint output
в упорядоченный display list и сохранить явные границы, в которых NeoCompositor
должен прочитать уже скомпозированный backdrop. `GlassSurface`, media и plugin
surface являются paint/compositing boundaries, а не обычными потомками одной
финальной bitmap.

Это потенциальное, а не уже принятое изменение относительно предыдущего
канона. Оно требует отдельного superseding ADR с перечислением отменяемых
решений, migration/rollback plan и владельца.

Track D рассматривает ограниченный product-owned compositor, потому что требования
NeoTavern могут включать одновременно live backdrop glass, длинные
виртуализированные чаты, streaming, touch и дисплеи 60/90/120 Hz, включая слабые
Android GPU. Само наличие этих желаний не доказывает, что Track D дешевле
альтернатив.

При этом Track D **не должен возвращаться к полному Custom Engine Profile v2**.

## 0.1. Нормативность и незакрытые решения

`MUST`, `MUST NOT`, `SHOULD`, `MAY` используются в нормативном смысле.

- `MUST`/`MUST NOT` блокируют соответствующий milestone.
- `SHOULD` допускает отклонение только с зафиксированной причиной, owner и
  benchmark evidence.
- `MAY` не создаёт обязательной capability.

Название конкретного upstream renderer-а (Vello, другой AnyRender backend либо
иной pinned backend) не является архитектурной гарантией. Compatibility PR MUST
фиксировать конкретный commit, публичные extension points и проверенные
capabilities. ТЗ запрещает опираться на непубличную внутреннюю структуру
upstream без ADR и rebase budget.

Нормативные требования ниже условны относительно выбранного track: `MUST` внутри
Track D означает «обязательно, если Track D принят», но не означает, что продукт
уже обязан принять Track D.

## 0.2. Три независимых решения

NeoUI v4 MUST NOT приниматься одним пакетным голосованием. Требуются три
независимых решения:

| ID | Решение | Что доказывает | Что не доказывает |
|---|---|---|---|
| D1 | Кто владеет Android frame/composition path | измеренный WebView-class bottleneck и сравнительный prototype | необходимость Dioxus |
| D2 | На чём пишется first-party Android UI | стоимость producer integration, paint seam и delivery | необходимость двух UI на всех платформах |
| D3 | Один presentation UI или раздельные Android/Web реализации | продуктовая parity-модель, штат и roadmap | пригодность конкретного renderer backend |

Правила принятия:

- `D1=product compositor` не подразумевает `D2=Dioxus`;
- `D2=Dioxus` не подразумевает немедленный rewrite всего Android UI;
- `D3=dual UI` требует отдельного многолетнего ownership/cost decision;
- отказ любого решения не отменяет Rust Kernel и Product Wire;
- каждый ADR MUST иметь альтернативы, evidence, owner, rollback и superseded ADRs.

## 0.3. Gate P — продуктовая необходимость

На дату редакции 4.5 Gate P **не выбран**. Статус `UNDECIDED` блокирует M0,
implementation milestones и изменение production-канона.

До любого compositor/engine prototype product owner MUST письменно выбрать один
вариант. Единственное исключение — bounded pre-M0 measurement week из раздела
0.3.1:

```text
GateP:P0 — live backdrop glass на Android не является MUST
GateP:P1 — live backdrop glass является MUST только на capability-qualified devices
GateP:P2 — live backdrop glass является MUST на всём поддерживаемом Android matrix
```

Префикс `GateP:` обязателен вне этого подраздела, чтобы не путать значения
продуктового gate с plugin tiers `Plugin:P0…P5` из раздела 28.

Если выбран `GateP:P0`, Track D закрывается как избыточный и запускается дешёвый
WebView/native-toolkit optimization track. Если выбран `GateP:P1` или
`GateP:P2`, решение
должно включать допустимые degraded semantics, поддерживаемую device matrix и
ценность, оправдывающую новый presentation ABI.

`Gate P` также утверждает:

- перечень критических Android journeys;
- допустимый разрыв функций с Web;
- статус Theme SDK и Plugin SDK на Android;
- максимальный migration budget и owner;
- совместимость программы с другими крупными инициативами;
- критерий остановки, если prototype не проходит.

Без этого Milestone 0 не начинается.

Рабочая рекомендация proposal — обсуждать `GateP:P1` как наиболее проверяемый
компромисс либо `GateP:P0` как дешёвый отказ от hard live glass. Это не заменяет
подпись product owner. `GateP:P2` запрещено принимать без явной нижней границы
поддерживаемого Android matrix, evidence по low tier и утверждённого
staffing/thermal/degraded-mode budget.

Gate P фиксируется коротким decision record:

```text
decision: GateP:P0 | GateP:P1 | GateP:P2
owner:
date:
input evidence: BaselineReport M-1 revision
qualified device definition:
allowed degraded semantics:
critical Android journeys:
budget/capacity ceiling:
revisit/kill trigger:
```

Пустое поле означает, что Gate P не пройден.

## 0.3.1. Pre-M0 measurement week (M-1)

До Gate P разрешён один bounded measurement-only work package `M-1` длительностью
не более пяти рабочих дней. Он не создаёт NeoCompositor, не меняет production UI
и не разрешает Dioxus migration.

Scope M-1:

```text
Track A: current WebView + current effects
Track A0: current WebView + glass off/static
Track B: WebViewAssetLoader/HTTPS origin + bounded effects, если поднимается без rewrite
same APK content fixture
same physical device set and settings
same warm/cold run protocol
```

Минимальный device set: один low/mid Android из текущей поддержки и один
high-refresh reference. Если доступен известный проблемный OEM, он добавляется,
но отсутствие третьего устройства не продлевает M-1 автоматически.

`BaselineReport M-1` MUST содержать сырые trace/capture references и таблицу:

```text
device / OS / WebView version
supported_modes
requested_frame_rate
observed_display_mode and callback rate
application-caused frame misses and longest streak
input-to-present where measurable
live/static/no-glass semantic result
thermal state at start/end and refresh downgrade
memory and APK/startup delta for B
implementation effort actually spent
known measurement limitations
```

M-1 не может получить extension «чтобы заодно попробовать compositor». Его
выход — данные для GateP:P0/P1/P2, а не GO для Track D.

## 0.3.2. Pre-Gate technical artifacts

Нормативный M0 не начинается до `GateP:P1` либо `GateP:P2`. Если до
прохождения Gate P уже был выполнен bounded technical run, он:

- маркируется `PRE-GATE`, даже если runner или ветка имели имя
  `M0-D1a`;
- не меняет `GateP=UNDECIDED`, не запускает D1b и не выдаёт
  `D1=Track D GO`;
- останавливается после безопасного сбора artifacts и не получает
  scope extension;
- MAY быть позже допущен к M0 только письменным evidence-admission
  record после `GateP:P1/P2`;
- при допуске оценивается по той же редакции acceptance criteria,
  а не по упрощённым retroactive rules.

Evidence-admission record фиксирует source revision/diff, APK hash,
environment, raw logs, captures, пропущенные criteria и owner. Если среду
или bytes сборки нельзя однозначно воспроизвести, artifact может
обосновать следующий прогон, но не PASS.

## 0.4. Competing tracks

До `D1` сравниваются не лозунги, а одинаковый измеримый fixture:

| Track | Backend | Обязательная проверка | Возможный исход |
|---|---|---|---|
| A | текущий WebView, glass off/static | high-refresh request, scroll/frame trace | дешёвый production fallback |
| B | WebView + `WebViewAssetLoader`/HTTPS asset origin + bounded effects | тот же fixture | WebView остается owner compositor |
| C | Compose/Flutter/иной native toolkit без product compositor | scroll + native blur feasibility | native UI без собственного engine |
| D | product compositor + выбранный UI producer | ordered backdrop barrier + shared GPU device | максимальная capability и стоимость |

Asset origin сам по себе не считается доказательством улучшенного compositor
пути. Каждая гипотеза получает trace и одинаковые device/thermal условия.

`D1` принимает самый дешёвый track, который выполняет утверждённый Gate P. Track
D запрещено выбирать только потому, что он технически интереснее.

До завершения M-1 статус данных явный:

| Track | Evidence status в этой редакции |
|---|---|
| A/A0 | `MEASURED` emulator-only morning fixture; physical `BLOCKED`; evening AVD A/A0 **`INVALID_FOR_COMPARISON`** |
| B | `MEASURED` emulator-only morning fixture; physical `BLOCKED`; evening AVD B **`INVALID_FOR_COMPARISON`** |
| C | `NOT MEASURED` |
| D | `NOT BUILT — запрещён до Gate P` (PRE-GATE D1a: desktop `BLOCKED`; evening AVD **`BLOCKED / NON-ADMISSIBLE`**) |

Перед Gate P публикуется `BaselineReport M-1` с измеренными A/A0/B и только
оценочными C/D. Он достаточен для выбора важности live glass, но **не** для D1.

После GateP:P1/P2 M0-D1a/b добавляет измеренный Track D. Если Track C остаётся
реалистичным конкурентом требованиям Gate P, до D1 decision выполняется его
bounded equivalent probe. Только после этого публикуется финальный
`TrackComparison`:

```text
same physical devices and content fixture
requested/observed refresh mode
frame timeline and application-caused misses
live/static/no-glass semantic result
thermal/power snapshot
prototype effort and estimated migration surface
known platform/OEM blockers
evidence status: measured | estimated | unavailable
```

Строки `estimated` не могут выиграть D1 и не могут быть представлены как
benchmark. Если A, B или C уже выполняет Gate P в согласованном качестве, Track
D требует отдельного product justification; иначе программа останавливается на
более дешёвом track.

## 0.5. Документ и действующий репозиторий

До утверждающего ADR:

- действующие repository contracts имеют приоритет над этим proposal;
- единственный допустимый target path этого proposal —
  `docs/rfc/neoui-v4-android-presentation-backend.md`;
- размещение как `docs/<file>.md`, в корне либо среди действующих ТЗ запрещено;
- ни один кодовый PR не может ссылаться на этот документ как на уже принятый
  rewrite mandate;
- superseding ADR MUST перечислить затронутые React, WebView, Theme SDK,
  Plugin SDK, localization и delivery contracts по фактическим именам/версиям
  из репозитория на момент решения;
- если repository baseline расходится с предположениями этого документа,
  исправляется proposal, а не история проекта задним числом.

Repository status этой редакции — `OPEN`. Изменение считается завершённым
только отдельным repository PR, который:

1. выполняет `git mv` корневой 4.2/актуальной копии в указанный `docs/rfc/` path,
   сохраняя историю;
2. обновляет RFC index/README и помечает документ `Draft / Non-canonical`;
3. удаляет дублирующую корневую копию либо оставляет только короткий tombstone
   link, если это требует documentation policy;
4. подтверждает, что canonical docs и ADR не ссылаются на proposal как на
   принятое решение;
5. проходит обычный documentation review.

Одна строка `Статус: Proposal` внутри файла не заменяет это перемещение. Пока PR
не merged, документ должен считаться внешним review artifact, а не частью
repository governance.

Baseline, который MUST быть проверен по текущему repository перед ADR, включает
как минимум заявленные в ревью конфликты:

| Область | Предполагаемый действующий contract | Конфликт Track D |
|---|---|---|
| First-party Web UI | React/Vite presentation | Android пишется второй раз |
| Android host | WebView/file-origin contract (в ревью: ADR-0034) | меняется owner кадров и main renderer |
| Product boundary | React → Product Wire → Kernel (в ревью: ADR-0038) | Dioxus требует нового adapter/ADR |
| Theme SDK | CSS tokens/cascade layers/`data-*`/shell themes | не переносится в typed nodes 1:1 |
| Plugin frontend | React slots/DOM islands/legacy `window` globals | требует нового ABI либо WebSurface |
| i18n/a11y | Web catalogs и component semantics | нужен parity contract для native UI |

Номера и формулировки считаются reference из ревью, а не установленным фактом:
ADR owner обязан сослаться на актуальные файлы/commit и исправить таблицу до
Gate P/D3.

## 0.6. Как читать объём документа

Документ намеренно хранит подробный conditional design, чтобы после GO не
повторять уже известные compositor ошибки. Это не означает, что все разделы
одновременно входят в approved backlog.

| Слой | Разделы | Статус до evidence |
|---|---|---|
| Decision gates | 0–8, 47–49 | предмет текущего proposal/review |
| Kill probe | 10.1 и 48 | единственный разрешённый engine scope до D1/D2 |
| Conditional implementation design | 9–46, 50–58 | справочник; не implementation mandate |
| Production acceptance | 43–45, 51–56 | активируется после соответствующих GO |

Команда MUST планировать ближайший gate, а не весь текст как одну mega-feature.
Наличие детального будущего требования не разрешает начать его реализацию до
entry criteria milestone.

---

# 1. Основной продуктовый инвариант

Этот раздел активируется только при `GateP:P1/P2`. До Gate P live glass и
120-Hz являются проверяемыми гипотезами, а не обещанным release contract.

На capability-qualified 120-Hz mobile device принятый Track D MUST иметь
возможность отображать основной chat experience:

```text
virtualized chat
+ streaming content
+ images
+ live glass header
+ live glass composer
+ animations
+ inline sampleable media/plugin surfaces
```

с использованием одного 120-Hz presentation path.

Один refresh interval при 120 Hz составляет приблизительно:

```text
8.33 ms
```

Production renderer MUST проектироваться исходя из этого budget с первого
delivery milestone. Узкий Milestone 0 проверяет возможность такого пути, но не
обязан уже выполнять весь production corpus.

После принятия Track D 120 Hz не является дополнительным quality mode после
завершения renderer-а.

Это blocking release requirement для capability-qualified profile, но не
единственный kill-критерий feasibility prototype.

---

# 2. Цели

## 2.1. Mobile performance

NeoUI MUST:

- поддерживать 60/90/120-Hz presentation;
- не выполнять Dioxus reconciliation на каждый display frame;
- не выполнять полный layout на каждый scroll frame;
- не выполнять text shaping на render thread;
- не декодировать изображения на render thread;
- не ожидать UI/layout/raster worker на render thread;
- не выполнять Product Wire round trip на каждый frame;
- поддерживать compositor-owned scroll и animation fast paths;
- вычислять async spatial transforms per node, включая sticky/fixed/nested
  scroll, а не одним global scroll delta;
- сохранять неделимые ancestor effect scopes вокруг backdrop boundaries;
- обновлять selection/caret без повторного shaping и без нарушения paint order;
- сохранять screen-space position/velocity continuity при уточнении virtual
  geometry;
- не показывать uninitialized/transparent gap при выходе scroll за fully prepared
  overscan;
- использовать retained scene;
- использовать bounded damage;
- переиспользовать render targets;
- ограничивать GPU upload;
- поддерживать adaptive glass quality без отключения live backdrop semantics.

Предыдущая архитектура уже требовала measured performance, host-owned scrolling/animation/editing, отсутствие per-frame Product Wire round trip и device-specific measured degradation.

## 2.2. Product architecture

NeoUI MUST сохранять:

- Rust Runtime Kernel;
- application/domain layer;
- canonical persistent storage;
- Product Wire;
- generation pipeline;
- provider architecture;
- plugin capability model;
- security boundaries.

Rust Runtime Kernel остаётся владельцем durable product state; UI host не получает product repository либо provider authority. Этот принцип сохраняется из NeoUI v2.

## 2.3. Visual architecture

NeoUI MUST обеспечивать:

- настоящий live backdrop glass;
- nested glass в поддерживаемых комбинациях;
- glass над scrolling content;
- glass над sampleable video/plugin output;
- clip/transform/opacity;
- stable animation;
- правильную работу при display rotation/resize;
- color-space и alpha correctness.

## 2.4. Product compatibility и migration truth

Новый Android backend является новым presentation implementation и MAY стать
новым presentation ABI. Product Wire не превращает существующий React UI,
темы, переводы или frontend plugins в Dioxus UI автоматически.

До `D2/D3 GO` создаётся `PresentationCompatibilityMatrix` минимум для:

```text
critical routes and states
commands and shortcuts
Theme SDK capabilities
Plugin SDK slots/islands/globals
legacy extension journeys
i18n namespaces and formatting
RTL and accessibility semantics
deep links, auth and recovery
release/update ownership
```

Для каждой capability допускается только один явный статус:

```text
PARITY       — эквивалентное поведение и acceptance tests
ADAPTED      — новый versioned Android API с migration path
CONTAINED    — работает только в WebSurface/panel/fullscreen с ограничениями
DEFERRED     — отсутствует до указанного milestone
REMOVED      — сознательно удалена продуктовым решением
```

Слова «общий Kernel» и «общий Product Wire» не могут использоваться вместо этой
матрицы. Android cutover запрещён, пока владельцы продукта, тем, плагинов,
локализации и accessibility не подпишут соответствующие строки.

## 2.5. Success metrics программы

Программа имеет четыре независимых результата:

1. visual/performance capability;
2. product parity либо согласованный capability gap;
3. engineering sustainability и upgrade cost;
4. delivery cost относительно Track A/B/C.

Prototype, который показывает красивый 120-Hz glass, но требует foundational
fork, не имеет Theme/Plugin plan либо удваивает UI-команду без утверждённого
budget, не считается общим GO.

---

# 3. Non-goals

NeoUI v4 MUST NOT реализовывать самостоятельно:

- универсальный HTML browser;
- DOM/CSS/JavaScript compatibility runtime;
- Unicode shaping engine;
- font rasterizer;
- собственный универсальный glyph atlas stack;
- Android `InputConnection` как штатную реализацию;
- general-purpose Gesture Arena;
- accessibility framework;
- arbitrary JavaScript-to-native compiler;
- full React compatibility layer;
- общий browser-class WebRender/WebKit compositor;
- arbitrary raw GPU API для plugins.

NeoCompositor является **product compositor**, а не новым браузером.

До `D2/D3 GO` также являются non-goals Milestone 0:

- 10k virtualization;
- production Markdown и streaming;
- sticky/fixed/nested scroll completeness;
- cross-tile selection;
- full IME/TalkBack corpus;
- media/plugin platform;
- Theme SDK v2;
- migration первого production route.

Эти задачи остаются обязательными для последующих milestones, но не могут
скрыть ранний ответ на paint-boundary/shared-device kill-вопрос.

---

# 4. Целевая архитектура-кандидат Track D

Схема ниже не является repository canon до принятия D1/D2/D3. Блок
`UI Producer` намеренно параметризован: Dioxus+NeoBlitz — первый кандидат, а не
логическое следствие собственного compositor.

```text
┌─────────────────────────────────────────────┐
│ Rust Runtime Kernel                         │
│ agents · storage · providers · generation  │
└─────────────────────┬───────────────────────┘
                      │
                 Product Wire
                      │
┌─────────────────────▼───────────────────────┐
│ Presentation Models                         │
│ immutable snapshots · commands · policies  │
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│ UI Producer candidate                       │
│ Dioxus/NeoBlitz or approved replacement     │
└─────────────────────┬───────────────────────┘
                      │ mutations
┌─────────────────────▼───────────────────────┐
│ Paint/Layout Adapter                         │
│ style · layout · text · hit-test · raster   │
└─────────────────────┬───────────────────────┘
                      │ ordered display list
                      │ paint/effect boundaries
┌─────────────────────▼───────────────────────┐
│ NeoScene                                    │
│ retained chunks · layers · clips · transforms│
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│ NeoCompositor                               │
│ wgpu · glass · damage · media · surfaces   │
└─────────────────────┬───────────────────────┘
                      │
             Vulkan / Metal / GPU
```

Orthogonal paths:

```text
Platform IME ───────────────┐
Platform Accessibility ─────┼─→ NeoBlitz/host adapters
Platform Lifecycle ─────────┘

NeoPlugin IR
    ↓
NeoPluginRuntime
    ↓
StandardUI / Canvas2D / VisualSurface / WebSurface
```

---

# 5. Ownership matrix

Таблица описывает Track D при `D2=Dioxus`; до D2 колонка default implementation
является гипотезой prototype.

| Capability | NeoTavern ownership | Default implementation |
|---|---:|---|
| Product state | полный | Rust Kernel |
| Storage/providers/agents | полный | Rust Kernel |
| Product Wire | полный | NeoTavern |
| Presentation models | полный | NeoTavern |
| First-party reconciliation | adapter/tests | Dioxus |
| Component runtime | adapter/tests | Dioxus |
| Style resolution | requirements/tests | NeoBlitz/upstream |
| Layout | requirements/tests | NeoBlitz/upstream |
| Text shaping | requirements/tests | upstream text stack |
| Glyph rasterization | requirements/tests | upstream raster stack |
| IME session | contract/tests | platform |
| Accessibility | semantic contract/virtualization adapter/tests | platform/upstream + NeoTavern adapter |
| Generic gestures | requirements/tests | host/upstream |
| Standard UI rasterization | adapter/tests | NeoBlitz raster backend |
| Paint-order segmentation | полный | NeoBlitz bridge + NeoScene |
| Spatial/scroll/effect property trees | полный | NeoBlitz bridge + NeoScene/NeoCompositor |
| Interaction-ready selection paint | adapter/tests | upstream text data + NeoCompositor ops |
| Virtual range prediction/preparation | полный | NeoChatViewport coordinator |
| Async scroll physics/geometry remap | полный | NeoChatViewport + NeoCompositor |
| Retained composition | полный | NeoCompositor |
| Damage/layer caching | полный | NeoCompositor |
| Live glass | полный | NeoGlass |
| GPU surface/device policy | полный | NeoCompositor |
| Media composition | полный | NeoMedia bridge |
| Plugin VisualSurface | полный | NeoPluginRuntime + NeoCompositor |
| Plugin permissions | полный | NeoPluginRuntime |
| Legacy Web compatibility | containment | WebSurface |
| Web production renderer | adapter | existing React/DOM |

---

# 6. Dioxus First-Party Runtime candidate

Dioxus является кандидатом D2, а не утверждённым следствием D1. First-party
NeoTavern Android UI SHOULD писаться как обычный Rust/Dioxus UI только после
`D2 GO`.

Canonical path:

```text
PresentationModel
      ↓
Dioxus component
      ↓
VirtualDom
      ↓
mutation batch
      ↓
NeoBlitz Adapter
```

Dioxus не является владельцем product state.

Dioxus component MAY владеть:

- transient open/closed state;
- hover;
- local selection;
- presentation-only toggles;
- ephemeral UI state.

Dioxus MUST NOT владеть:

- chat persistence;
- provider configuration authority;
- canonical message state;
- agent execution;
- storage transactions;
- durable plugin permissions.

`D2 GO` требует:

- реальный Android prototype на pinned Dioxus/Blitz revisions;
- публичный либо upstreamable paint-boundary seam;
- shared-device path без readback/cross-device copy;
- оценку отсутствующих layout/text/input/a11y возможностей;
- upgrade/rebase experiment на следующую совместимую upstream revision;
- сравнительную стоимость минимум одного альтернативного producer;
- отсутствие foundational private fork.

Если gate не пройден, меняется UI producer/paint substrate. Это не является
автоматическим отказом от D1 product compositor.

---

# 7. Отказ от NeoCompiler для first-party UI

NeoCompiler v3 планировался как frontend/HIR/LIR/AOT/runtime infrastructure для first-party UI и plugins.

В NeoUI v4 это разделяется.

## First-party UI

```text
Rust
→ Dioxus
→ VirtualDom
→ NeoBlitz
```

First-party UI MUST NOT требовать:

- NeoTSX → Kotlin emitter;
- Desktop emitter;
- generated first-party UI IR;
- runtime interpreter для собственного product shell.

## Plugins

NeoCompiler сохраняется только как:

```text
NeoPluginCompiler
```

или как plugin-oriented mode `NeoCompiler`.

Он отвечает за:

- NeoTSX plugin subset;
- validation;
- capability analysis;
- NeoPlugin IR;
- package format;
- schema evolution;
- diagnostics;
- static limits.

Таким образом NeoUI IR становится **plugin ABI**, а не внутренним UI representation всего приложения.

---

# 8. NeoBlitz

`NeoBlitz` является bounded integration layer-кандидатом над upstream stack.
Наличие модульных crates, AnyRender abstraction либо Android example не
считается доказательством нужного paint seam, production maturity или
пригодности конкретного OEM GPU.

Он MUST предоставлять NeoTavern:

- style resolution;
- layout;
- text measurement;
- text shaping integration;
- standard element geometry;
- hit-test geometry;
- scroll extent information;
- focus/semantic hooks;
- standard raster/display output.

NeoBlitz дополнительно MUST предоставлять paint bridge:

```rust
pub trait NeoPaintBridge {
    fn build_display_list(
        &mut self,
        document: &CommittedDocument,
        request: PaintRequest,
        sink: &mut dyn NeoPaintSink,
    ) -> Result<DisplayListBuild, PaintBuildError>;
}
```

Bridge MUST:

- обходить document в каноническом CSS/host paint order;
- записывать обычные paint commands без немедленного flatten в final surface;
- сохранять stacking-context, clip-chain, spatial-tree, opacity и isolation
  semantics;
- публиковать explicit scroll/sticky/fixed constraints и hit-test items;
- сохранять balanced non-distributive effect scopes, а не только effective
  opacity на leaf chunk;
- выделять interaction-ready text fragments из box background без собственного
  shaping;
- вызывать typed host hook для `GlassSurface`, `MediaSurface`,
  `PluginVisualSurface` и `ExternalSurfaceBoundary`;
- завершать текущий paint chunk до barrier и начинать новый после него;
- возвращать стабильные chunk/boundary IDs и source generations для
  incremental reuse;
- быть детерминированным для одинакового committed document snapshot.

Текущий upstream может иметь модульную paint abstraction, но это не считается
доказанной интеграцией автоматически. M0-D2 MUST подтвердить на pinned
commit, что bridge сохраняет paint order и позволяет render-to-sampleable-target
на production Android backend.

NeoBlitz MUST NOT становиться отдельным NeoTavern browser fork.

Сохраняется fork discipline v3, но line-count не может подменять capability
gate:

```text
permanent foundational forks: 0
active downstream patches: <= 8
full rebase target: <= 1 engineer-day
```

Каждый downstream patch MUST иметь reproducer, conformance test, upstream issue/PR
либо documented reason не upstream-ить, owner и removal trigger. Размер patch set
фиксируется, но произвольный лимит строк не является доказательством bounded
fork: изменение paint traversal на 1 900 строк всё равно foundational, если без
него нельзя обновить upstream.

Допустимый порядок решений:

1. собственная реализация публичного `PaintScene`/recording sink либо другого
   стабильного upstream extension point;
2. небольшой upstreamable hook для typed custom paint node;
3. отдельный NeoTavern paint adapter над публичными DOM/layout snapshots;
4. замена только paint substrate.

Шаги 3–4 требуют ADR с оценкой CSS paint fidelity, rebase cost и staffing.

Если mobile architecture требует систематического форка layout/text/style
internals либо приватного обхода DOM, запускается
`ADR-REPLACE-NEOBLITZ-SUBSTRATE`. Нельзя объявлять M0-D2 пройденным на mock
display list, который не построен реальным Dioxus → NeoBlitz path.

Milestone 0 не должен сначала строить собственные property trees,
virtualization, selection и plugin system, а затем проверять этот seam. В probe
разрешены только структуры, минимально необходимые для сохранения paint order,
effect scope и sampleable targets тестовой сцены.

---

# 9. Retained NeoScene

NeoScene не является вторым DOM.

Это renderer-facing retained representation, построенное из ordered display
list. Порядок элементов в списке является частью визуальной семантики, а не
подсказкой для renderer-а.

Минимальный interchange contract:

```rust
pub struct NeoDisplayList {
    pub generation: u64,
    pub spatial_tree: SpatialTreeSnapshot,
    pub clip_tree: ClipTreeSnapshot,
    pub effect_tree: EffectTreeSnapshot,
    pub ops: Arc<[NeoPaintOp]>,
}

pub enum NeoPaintOp {
    BeginEffectScope(EffectScopeId),
    EndEffectScope(EffectScopeId),
    PaintChunk(PaintChunk),
    BackdropBarrier(GlassBoundary),
    TextFragment(TextPaintFragment),
    Selection(SelectionPaintOp),
    Caret(CaretPaintOp),
    Image(ImageLayer),
    Media(MediaLayer),
    PluginSurface(PluginSurfaceLayer),
    ExternalSurface(ExternalSurfaceBoundary),
}

pub struct PaintChunk {
    pub id: PaintChunkId,
    pub generation: u64,
    pub paint_order: PaintOrderKey,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
    pub bounds: Rect,
    pub payload: RecordedPaint,
}
```

`RecordedPaint` является bounded, versioned adapter payload. Это не raw pointer
на upstream scene и не обещание, что произвольные команды одного renderer-а
будут вечным ABI. Compatibility PR MUST либо доказать replay pinned backend-ом,
либо конвертировать payload в NeoTavern-owned recording format.

NeoScene compiler MAY объединять соседние `PaintChunk`, но MUST NOT менять
визуальный результат. Запрещено объединять через:

- `BackdropBarrier`;
- sampleable media/plugin surface;
- external-surface boundary;
- incompatible clip/effect/isolation scope;
- blend/filter operation, требующую уже накопленный destination;
- resource/device epoch.

`BeginEffectScope`/`EndEffectScope` являются properly nested и валидируются как
часть display list. Их нельзя удалять только потому, что промежуточные chunks
оказались пустыми: scope может определять backdrop root, group opacity, mask,
blend либо isolation semantics.

Каждый op получает конечные spatial/clip/effect references. Состояние не должно
неявно «протекать» через удалённый или reordered chunk.

NeoScene MUST NOT хранить:

- arbitrary Dioxus component objects;
- mutable product models;
- raw plugin pointers;
- decoded unbounded image buffers;
- platform text input objects.

## 9.1. Paint-order и stacking-context conformance

Display-list bridge MUST сохранять проверяемый порядок как минимум для:

- background/border/content/outline;
- sibling `z-index`, negative/auto/positive stacking levels;
- nested opacity, transform, clip, mask и isolation;
- scroll/sticky/fixed spatial nodes в заявленном mobile subset;
- overlay/portal, selection/caret и focus ring;
- glass перед собственным material/foreground content;
- media/plugin surface между обычными UI chunks.

Spatial state MUST быть деревом, а не одним scroll transform:

```rust
pub enum SpatialNodeKind {
    ReferenceFrame { local_transform: Transform },
    Scroll {
        scroll_id: ScrollId,
        scrollport: Rect,
        content_extent: LogicalRect,
    },
    Sticky {
        scroll_id: ScrollId,
        normal_origin: Point,
        constraint_rect: Rect,
        insets: LogicalInsets,
        valid_scroll_range: LogicalRange,
    },
    Fixed { containing_block: SpatialNodeId },
}
```

Каждый paint/hit-test/selection/glass op ссылается на свой `SpatialNodeId`.
Compositor вычисляет world transform узла из всей ancestor chain и актуальных
offset каждого `ScrollId`. `Sticky` получает compositor-owned clamp внутри
опубликованного constraint rectangle; `Fixed` компенсирует только scroll своего
containing-block chain. `position: fixed` внутри transformed ancestor не
считается автоматически viewport-fixed.

Nested scroll containers имеют отдельные offsets, epochs и input latching.
Один global inverse `async_scroll_delta` для всей сцены запрещён.

Sticky/fixed constraints являются layout output. Если async offset выходит за
`valid_scroll_range` snapshot либо constraint зависит от ещё не подготовленной
virtual geometry, compositor MUST пометить affected region как slow/
reconciliation-required, использовать last-known-valid positioning и запросить
urgent producer commit; угадывать новый clamp запрещено.

Sticky content MUST иметь independent retained paint/hit-test fragment и stable
item identity. Его нельзя оставить запечённым только в scroll tile, который
может быть evicted после прилипания. Пока sticky активен, fragment/resources и
constraint sentinel следующего sticky item pin-ятся bounded policy-ей.
Promotion в independent fragment не может hoist-ить sticky из ancestor
effect/clip scope.

Неподдерживаемая комбинация MUST завершаться deterministic capability fallback
или validation error в development build; молчаливый flatten с неверным
backdrop запрещён.

## 9.2. `GlassSurface` как render boundary

`GlassSurface` — first-party typed component с host paint hook, а не CSS-класс,
который adapter пытается угадать по строке.

Dioxus component MUST lowering-иться в host-recognizable node через versioned
extension contract:

```rust
pub enum HostPaintNodeKind {
    Glass(GlassSpec),
    Media(MediaSurfaceId),
    Plugin(PluginSurfaceId),
    External(ExternalSurfaceId),
}
```

Registration хранится в NeoBlitz-side table по stable document `NodeId` и
generation и обновляется тем же atomic mutation batch. Произвольный plugin,
Markdown или stylesheet не может создать trusted host node строковым tag/class/
attribute. Удаление/recycling node удаляет registration до следующего paint.

Его paint sequence:

```text
ordinary content behind
→ flush PaintChunk
→ BackdropBarrier: read accumulated backdrop ROI
→ blur/material composite
→ GlassSurface foreground/children PaintChunk(s)
→ following siblings
```

`BackdropBarrier` MUST находиться в том же paint-order position, где upstream
рисовал бы box `GlassSurface`. Его descendants образуют bounded isolation scope
и не могут через `z-index`, portal либо fixed positioning выйти «за» backdrop
read. Такие descendants MUST быть вынесены в явный overlay scope.

Nested `GlassSurface` создаёт новую barrier после результата внешнего glass.
Cycle в dependency graph является scene validation error.

## 9.3. Effect tree и неделимые stacking contexts

`effect_node` — не набор чисел, который можно независимо умножить на каждый
chunk. `EffectTreeSnapshot` MUST описывать вложенные compositing groups:

```rust
pub struct EffectNode {
    pub id: EffectNodeId,
    pub parent: Option<EffectNodeId>,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub bounds: Rect,
    pub kind: EffectKind,
    pub backdrop_root: BackdropRootId,
}

pub enum EffectKind {
    Opacity(f32),
    Filter(FilterChain),
    Mask(MaskRef),
    Blend(BlendMode),
    Isolation,
}
```

`opacity`, filter, mask, non-trivial blend и isolation MAY требовать offscreen
group. Если barrier находится внутри такого ancestor, RenderGraph делает:

```text
BeginEffectScope(parent effects)
→ render group prefix
→ resolve BackdropBarrier source at its exact paint position/backdrop root
→ render glass result into group target
→ render group suffix
→ EndEffectScope
→ apply ancestor opacity/filter/mask/blend exactly once
```

Для `<Card opacity=0.5><GlassSurface/></Card>` backdrop source не получает
случайно `0.5` до blur, а результат glass не выходит из group с opacity `1.0`.
Вся карточка, включая glass, композится с group opacity один раз на
`EndEffectScope`.

`BackdropBarrier` содержит полный `effect_path`, `spatial_node`, `clip_chain` и
`backdrop_root`. RenderGraph MAY импортировать parent accumulation в bounded ROI
group target либо построить эквивалентный ping-pong pass, но MUST учитывать уже
нарисованный group prefix и не sample-ить group suffix.

`BackdropRootId` публикуется paint bridge-ом по утверждённой first-party/CSS
semantics. RenderGraph не может объявить новый backdrop root только потому, что
для optimization выделил offscreen texture; allocation boundary и semantic
backdrop boundary — разные понятия.

Geometric transform/clip ancestors участвуют и в вычислении source ROI, и в
финальном composite. Mask/filter expansion рассчитываются до allocation/damage.
Нельзя «протащить opacity», потеряв group blend/isolation semantics.

Effect flattening разрешён только при доказанной алгебраической эквивалентности.
Запрещено распределять group opacity/filter/mask по chunks, пересекать
`BackdropBarrier` либо сливать scope с другим backdrop root ради уменьшения
числа passes.

Поддерживаемый first-party mobile subset MUST включать affine transforms,
rect/rounded clips, group opacity и nested glass. Ancestor mask, arbitrary filter
и destination-dependent blend вокруг glass являются conditional capabilities:
каждая комбинация либо проходит golden/GPU tests, либо получает explicit
development validation error и documented product fallback. Молчаливое
визуально неверное упрощение запрещено.

Effect visibility не подменяет input semantics: `opacity: 0` само по себе не
удаляет hit-test item. Input culling следует explicit pointer/visibility policy,
а не факту, что group target прозрачен.

---

# 10. RasterLayer

Обычный UI не обязан рисоваться NeoCompositor-ом primitive-by-primitive.

Стандартный UI MAY быть представлен как один или несколько chunks:

```text
NeoBlitz ordered paint traversal
      ↓
PaintChunk → upstream/backend recording
      ↓
render-to-sampleable target при необходимости
      ↓
RasterLayer/texture slice → NeoCompositor
```

Одна плоская texture для всего Dioxus tree допустима только если внутри неё нет
interleaved glass/media/plugin boundary и texture укладывается в damage,
dimension и memory budgets. Она не является canonical output.

`RasterLayer` содержит:

```rust
pub struct RasterLayer {
    pub id: LayerId,
    pub generation: u64,
    pub device_epoch: u64,
    pub bounds: Rect,
    pub valid_rect: Rect,
    pub scale_factor: f32,
    pub format: TextureFormatId,
    pub color_space: ColorSpaceId,
    pub alpha_mode: AlphaMode,
    pub texture: RasterResourceHandle,
    pub damage: Option<RectSet>,
    pub opacity: f32,
    pub ready: ResourceReadyToken,
}
```

`RasterLayer.opacity` относится только к доказанно distributive leaf composite.
Ancestor group opacity/filter/mask хранится в effect tree и не bake-ится в
каждый RasterLayer, иначе barrier split применит effect дважды либо потеряет его.

Renderer MAY raster-cache стабильные subtrees.

Изменение scroll transform MUST NOT автоматически вызывать повторную rasterization content layer, если pixels не изменились.

`RasterResourceHandle` MUST быть sampleable тем же logical GPU device/queue,
которым владеет NeoCompositor. Для normal path запрещены:

- второй скрытый `wgpu::Device` для upstream renderer-а;
- GPU → CPU readback;
- cross-device texture copy;
- ожидание map/readback либо worker completion на render thread.

NeoCompositor создаёт либо передаёт shared device/queue upstream backend-у.
Texture usage, format, synchronization и lifetime согласуются до
rasterization. Queue-order либо explicit ready token MUST гарантировать, что
texture завершена до sampling. После смены `device_epoch` старый handle
отклоняется.

Высокий/длинный scroll content MUST разбиваться на bounded tiles/chunks; нельзя
создавать texture высотой со всю 10k-message history или превышать
`max_texture_dimension_2d`. Tile size выбирается по device limits, damage и
cache budget.

Tile является единицей allocation/cache/damage, но не обязан быть неделимой
единицей paint order. Selectable/editable text, caret, selection, hover/focus и
другие dynamic underlay/overlay effects MUST иметь interaction-aware
decomposition. Нельзя bake-ить selectable glyphs вместе с box background, если
после этого невозможно вставить selection background в правильную позицию без
повторного shaping.

Один logical text fragment MAY пересекать несколько raster tiles; clipping по
tile boundaries не меняет logical selection range, glyph positions либо
highlight geometry. Adjacent tiles используют одинаковые pixel snapping и
apron rules, чтобы selection не имела seams.

## 10.1. Raster-boundary feasibility gate

На реальном production backend M0-D1a/b и M0-D2 MUST доказать staged scene
раздела 48:

```text
Image/PaintChunk wallpaper
→ GlassSurface barrier
→ text/icon PaintChunk
→ sampleable media
→ second GlassSurface barrier
→ overlay PaintChunk
```

Acceptance:

- pixel/golden order совпадает с reference;
- нет CPU readback и cross-device copy;
- ordinary chunks до и после glass остаются независимыми;
- изменение foreground text не инвалидирует неизменный backdrop chunk;
- изменение backdrop повреждает зависимый glass ROI;
- nested barrier строит acyclic pass graph;
- GPU capture показывает bounded targets, passes и submissions;
- backend обновляется на заранее выбранный upstream commit в пределах rebase
  target.

Если это невозможно через публичный/малый upstreamable seam, запускается
`ADR-PAINT-SUBSTRATE`; ограничение «не больше 2 000 строк» не может использоваться
для объявления заведомо неверной single-texture архитектуры приемлемой.

---

# 11. NeoCompositor

NeoCompositor является специализированным retained GPU compositor.

Он отвечает за:

- NeoScene retention;
- spatial transforms;
- clips;
- opacity;
- layer composition;
- ordered display-list compilation;
- render-pass/dependency graph validation;
- damage tracking;
- occlusion;
- glass render dependencies;
- render-target pooling;
- GPU upload coordination;
- sampleable media;
- sampleable plugin surfaces;
- surface presentation;
- device/surface recovery;
- adaptive rendering policy;
- GPU instrumentation.

NeoCompositor является владельцем production GPU device/queue, surface config и
`device_epoch`. Upstream raster backend работает на переданном compatible
context; самостоятельное создание production device разрешено только в
isolated test tool.

Перед выполнением frame NeoCompositor компилирует ordered ops в acyclic pass
graph. Любое чтение backdrop/surface объявляется dependency edge; resource
aliasing разрешён только при непересекающихся lifetime. Ошибка graph/resource
validation не должна приводить к чтению uninitialized texture: frame использует
last-known-good scene либо documented fallback и пишет structured diagnostic.

Pass graph compiler MUST сохранять nesting `BeginEffectScope`/
`EndEffectScope`, backdrop roots и group lifetimes. Temporary target bounds
берутся из transformed/expanded damage, а не автоматически из full screen.
Scope target нельзя освободить/alias-ить до завершения всех descendant backdrop
reads и final group composite.

Spatial, clip, effect и hit-test trees sample-ятся одним
`CompositorPropertySnapshot` на frame. Нельзя нарисовать sticky node с новым
async clamp, а hit-test выполнить по предыдущему property sample.

Shader modules и обязательные render/compute pipelines создаются либо
асинхронно прогреваются до входа в interactive route. Неожиданная compilation на
первом scroll/glass frame измеряется как application jank. Persistent pipeline
cache MAY использоваться только с backend/driver/device/app-version key и safe
invalidation. После device loss current-viewport/final-composite pipelines
восстанавливаются раньше speculative variants.

Ошибки upstream paint/raster adapter должны пересекать boundary как `Result` и
не приводить к process abort/panic на malformed content или resource pressure.
Если pinned backend не предоставляет recoverable contract, это known gap с
обязательным patch/containment test до production GO.

NeoCompositor MUST NOT отвечать за:

- Dioxus diffing;
- CSS;
- general layout;
- Unicode shaping;
- text editing semantics;
- plugin business logic;
- network;
- product persistence.

`wgpu` является graphics abstraction NeoCompositor, а не UI architecture. Такое разделение прямо следует из вывода NeoUI v2 о том, что GPU API закрывает лишь resources/pipelines/textures/command encoding/presentation, но не text, IME, layout, gestures и platform lifecycle.

---

# 12. UI/render synchronization

Mutable UI state и render scene разделяются.

Render thread MUST NOT читать arbitrary mutable Dioxus/NeoBlitz state.

UI/render synchronization публикует immutable transaction.

```rust
pub struct FrameTransaction {
    pub frame_generation: u64,

    pub window_id: WindowId,
    pub window_generation: u64,
    pub window_geometry_generation: u64,

    pub ui_generation: u64,
    pub layout_generation: u64,
    pub spatial_tree_generation: u64,
    pub clip_tree_generation: u64,
    pub effect_tree_generation: u64,
    pub raster_generation: u64,
    pub display_list_generation: u64,
    pub scene_generation: u64,
    pub hit_test_generation: u64,
    pub semantics_generation: u64,
    pub selection_generation: u64,

    pub scroll_generation: u64,
    pub virtual_range_generation: u64,
    pub geometry_epoch: u64,
    pub device_epoch: u64,
}
```

Это продолжает модель `FrameTransaction` NeoUI v2, где UI, layout, spatial, scene, hit-test, semantics и device epoch публикуются как совместимые поколения.

Запрещено собирать frame из несовместимых поколений.

UI→render mailbox MUST быть bounded.

При renderer lag действует:

```text
latest complete transaction wins
```

Промежуточные snapshots разрешено схлопывать, но части разных поколений не смешиваются.

Transaction содержит либо immutable references на полный совместимый snapshot,
либо delta с explicit base generation. Delta с неизвестной base generation MUST
быть rejected с запросом full snapshot. Resource handles удерживаются до GPU
completion соответствующего submission; удаление scene node не означает
немедленное освобождение in-flight texture.

UI thread MUST NOT ждать render thread. Render thread MUST NOT ждать UI/layout,
raster, asset decode или plugin producer. Единственное допустимое ожидание на
render path — bounded platform/GPU synchronization, неизбежное для acquire,
submit/present и подтверждённое trace.

---

# 13. Dirty model

NeoUI различает минимум:

```text
UI_DIRTY
STYLE_DIRTY
LAYOUT_DIRTY
TEXT_DIRTY
DISPLAY_LIST_DIRTY
EFFECT_TREE_DIRTY
RASTER_DIRTY
RASTER_CHUNK_DIRTY
SCENE_DIRTY
SEMANTICS_DIRTY
HIT_TEST_DIRTY
IME_GEOMETRY_DIRTY
GLASS_DIRTY
MEDIA_DIRTY
VIRTUAL_RANGE_DIRTY
SELECTION_ONLY
GEOMETRY_REMAP
ANIMATION_ONLY
SCROLL_ONLY
SPATIAL_ONLY
```

`ANIMATION_ONLY`, `SCROLL_ONLY` и `SPATIAL_ONLY` MUST NOT запускать полный
Dioxus/layout pipeline. `VIRTUAL_RANGE_DIRTY` планирует bounded preparation и не
превращается автоматически в rebuild всего chat list. `DISPLAY_LIST_DIRTY` MAY
перезаписать только затронутые paint chunks при неизменных layout/spatial
generations. `SELECTION_ONLY` использует опубликованные text fragments и MUST NOT
запускать shaping/layout. `GEOMETRY_REMAP` атомарно меняет height-index/spatial/
anchor mapping и не считается input delta либо новой fling velocity.

Retained-mode архитектура и запрет полного rebuild на animation-only update сохраняются из NeoUI v2.

---

# 14. 120-Hz performance contract

Численные thresholds этого раздела являются initial v4 budgets. Они становятся release budgets после первого reference prototype и могут изменяться только ADR с benchmark evidence. Такой measured-budget подход сохраняет принцип NeoUI v3.

## 14.1. Refresh deadlines

```text
60 Hz  → 16.67 ms
90 Hz  → 11.11 ms
120 Hz → 8.33 ms
```

На `120HZ_REFERENCE` device штатный chat-scroll fixture MUST выполнять
renderer-controlled visual work внутри одного 8.33-ms refresh interval согласно
pass/fail метрикам раздела 14.2.

Deadline измеряется от platform frame callback/input sample до требуемого
present deadline. CPU и GPU могут перекрываться; простое сложение stage durations
не является frame time. Frame pacing MUST следовать фактическому display mode и
адаптироваться к runtime change 60/90/120/variable refresh без ускорения
logical animations.

## 14.2. Blocking 120-Hz gate

Этот gate является release gate Milestone C, а не Exit узкого Milestone 0.

После warm-up в 60-second continuous scroll fixture, когда platform telemetry
подтверждает фактически активный 120-Hz display mode:

- не менее 99% renderer-controlled frame opportunities MUST укладываться в
  one-refresh deadline после утверждения release budget;
- application-caused missed presentation deadlines MUST быть <1%;
- не допускается более двух последовательных application-caused misses;
- sustained UI/product thread backlog запрещён;
- Product Wire queue MUST оставаться bounded;
- display-list/raster/virtualization queues MUST оставаться bounded;
- image decode MUST отсутствовать на render/UI critical path;
- Dioxus reconciliation MUST отсутствовать на compositor-only scroll frames.

`renderer-controlled opportunity` — frame, для которого приложение получило
callback/acquire с достаточным временем и не имеет доказанного OS/driver/external
stall. Исключение frame из denominator требует trace reason; «неизвестно»
считается application-caused. Отдельно публикуются all-frame и
renderer-controlled метрики, количество исключений и longest miss streak.

Отчёт MUST раздельно фиксировать:

```text
supported_modes       — что сообщает устройство
requested_frame_rate  — что запросил host через platform API
observed_display_mode — какой mode фактически активен
frame_callback_rate   — какие opportunities получил процесс
present_rate          — какие presents реально показаны
system_limit_reason   — power/thermal/policy/unknown, если доступно
```

Запрос 120 Hz не равен получению 120 Hz. Если reference device поддерживает
120 Hz, приложение корректно запросило mode, но ОС ограничила session до 60 Hz,
результат помечается `ENVIRONMENT_BLOCKED`, а не искусственно как renderer PASS
или FAIL. Fixture повторяется в контролируемых battery/thermal/settings
условиях. Неизвестный пропуск внутри уже предоставленного 120-Hz opportunity
остаётся application-caused.

До калибровки Milestone B эти thresholds являются hypothesis gate. Milestone B
MUST завершиться утверждённым device-specific budget ADR; релиз нельзя принять
со словом `SHOULD` вместо численного pass/fail.

Метрики фиксируются как минимум для:

```text
median
p90
p95
p99
worst bounded window
longest miss streak
input-to-present p50/p95/p99
prepared-range misses and fallback duration
```

## 14.3. CPU/GPU instrumentation

Каждый frame trace MUST разделять:

```text
input
Dioxus update
style
layout
text
raster
display-list build
scene synchronization
virtual-range plan/prepare/commit
property-tree sample/hit-test
geometry remap
selection/caret update
glass preparation
GPU standard layers
GPU effect groups
GPU glass
GPU final composite
queue submit
present
```

Instrumentation MUST отдельно фиксировать queue wait, cache hit/miss, bytes
uploaded, rasterized pixels, glass ROI pixels, prepared/estimated scroll coverage
и причину каждого degraded/fallback frame. Включение production-level tracing не
должно само нарушать deadline; full GPU capture используется отдельным fixture.

CPU и GPU нельзя объединять в один непрозрачный `frame_time`.

## 14.4. Thermal soak

Отдельно выполняется:

```text
10-minute high-refresh scroll/glass soak
30-minute mixed chat/media session
```

Фиксируются:

- thermal state;
- device refresh-rate changes;
- CPU/GPU clocks, где доступны;
- app frame deadlines;
- memory steady state;
- battery/power indicators, где доступны.

Изменение refresh rate самой ОС не считается renderer bug, но renderer MUST адаптироваться без изменения animation duration либо logical state.

High-refresh policy MUST предоставлять пользователю режимы минимум
`system/balanced/high`, если platform позволяет их различать. Renderer не должен
удерживать 120-Hz request на статичном экране без продуктового основания.

---

# 15. Compositor scroll fast path

Обычный scroll MUST иметь путь:

```text
touch/input
   ↓
scroll delta
   ↓
compositor scroll state
   ↓
scene transform
   ↓
glass damage
   ↓
GPU composite
   ↓
present
```

без обязательного:

```text
Dioxus
→ Product Wire
→ full style
→ full layout
→ full raster
```

Сохраняется модель v2:

```text
input
→ scroll transform
→ scene spatial update
→ compositor
```

с последующей bounded reconciliation.

Каждый активный `ScrollNode` содержит независимое состояние:

```rust
pub struct CompositorScrollState {
    pub scroll_id: ScrollId,
    pub epoch: ScrollEpoch,
    pub committed_offset: LogicalVec2, // f64 logical coordinates
    pub unacked_delta: LogicalVec2,
    pub applied_input_seq: u64,
    pub acknowledged_input_seq: u64,
    pub screen_velocity: LogicalVec2,
    pub physics_generation: u64,
    pub generation: u64,
}
```

Stale UI transaction MUST NOT откатывать более новый compositor scroll offset.

UI commit содержит `scroll_id`, `epoch`, `acknowledged_input_seq` и новый
`committed_offset`. Compositor удаляет только delta с sequence `<= ack`,
сохраняет более новые input deltas и вычисляет:

```text
visual_offset = committed_offset + sum(unacknowledged deltas)
```

Commit из другого/старого epoch либо с убывающим ack MUST быть rejected.
Semantic reset route/list создаёт новый epoch и не смешивается с предыдущим
fling.

Gesture input block latch-ится к одному `ScrollId` на начало gesture. Nested
scroll/horizontal code block используют scroll handoff chain при достижении
границы; они не складывают delta в root chat автоматически. Sticky/fixed nodes
не являются scroll states, но вычисляют transform из связанных ancestor
`ScrollId`.

## 15.1. Граница fast path

Compositor fast path не создаёт новые message layouts или pixels. Он может
двигаться только по coverage, опубликованному `NeoChatViewport`:

```rust
pub struct ScrollCoverage {
    pub epoch: ScrollEpoch,
    pub generation: u64,
    pub fully_prepared: LogicalRangeSet,
    pub fallback_ready: LogicalRangeSet,
    pub estimated_extent: LogicalRange,
    pub tile_set: Arc<[TileRef]>,
}
```

- `fully_prepared` — layout, shaping и raster/display chunks готовы;
- `fallback_ready` — geometry-correct lightweight representation готово, но
  full fidelity может быть отложена;
- `estimated_extent` — scroll geometry известна по height index, pixels не
  обещаны.

Публикация coverage atomic с соответствующими spatial tree, tiles и anchor
metadata. Диапазон без resource refs не считается `fully_prepared`.

## 15.2. Height index и stable geometry

`NeoChatViewport` MUST поддерживать bounded random-access height index по stable
`MessageId`, а не вычислять offset проходом от начала списка. Допустимы Fenwick/
segment tree либо эквивалент со следующими операциями не хуже `O(log n)`:

```text
item → logical offset
logical offset → candidate item
height update → suffix extent correction
prepend/remove → anchor-preserving update
```

Для каждого item хранится measured либо estimated height с ключом минимум:

```text
message/content generation
viewport width class
font/fallback generation
text scale/locale
Markdown/style generation
media aspect metadata generation
```

Cache с несовместимым ключом не используется как measured. Изменение estimate
не может напрямую сдвинуть видимый anchor; оно проходит через anchoring
transaction.

Dioxus/NeoBlitz materialize-ит только bounded item window со stable keys.
Положение окна задаётся leading/trailing virtual extents либо host-controlled
absolute item origins из height index; Taffy не должен layout-ить placeholder
node на каждое из 10k сообщений. Spacer extent update и item-window replace
публикуются одной anchor-aware transaction.

## 15.3. Deadline-aware range predictor

Virtualization coordinator получает текущие offset, velocity, acceleration,
direction, viewport, measured pipeline latency и memory pressure. Он поддерживает
асимметричный ahead/behind overscan с hysteresis.

Минимальный look-ahead horizon:

```text
H >= p95(plan + materialize + layout + shape + raster + publish)
     + 2 × refresh_interval
```

Минимальная дистанция подготовки:

```text
D_prepare >= |velocity| × H + braking/correction margin
```

Значения ограничиваются hard memory/item/byte caps. Если predictor не может
одновременно соблюсти latency и memory, он заранее включает fallback policy, а
не ждёт фактического пустого viewport.

Trigger срабатывает при time-to-edge подготовленного диапазона `< H`, а не
только после пересечения overscan. Direction reversal сохраняет bounded trailing
coverage, чтобы не вызвать немедленный miss.

## 15.4. Preparation pipeline

Подготовка нового диапазона выполняется как cancellable generation-aware jobs:

```text
range prediction
→ presentation slice / cached Markdown IR
→ bounded Dioxus materialization
→ incremental style/layout
→ text shaping and asset metadata resolution
→ paint-chunk build
→ raster/upload for required tiles
→ atomic coverage transaction
```

Требования:

- visible/emergency range имеет приоритет над speculative work;
- Markdown parse, syntax highlight, image decode и допустимое text preparation
  выносятся на worker pools;
- mutable Dioxus/NeoBlitz document не читается одновременно с другого thread;
- UI-owned stages выполняются bounded slices и yield-ят между slices;
- queue bounded; устаревшие speculative jobs отменяются/coalesce-ятся;
- render thread никогда не ждёт completion;
- один slow message не блокирует публикацию независимых готовых tiles;
- streaming visible item и IME work имеют отдельный budget, чтобы prefetch не
  создавал priority inversion.

Off-thread shaping/layout разрешены только через thread-safe immutable upstream
API, доказанный test-ами. Иначе stage остаётся UI-owned, но дробится и
планируется до deadline; запрещено просто объявить весь NeoBlitz thread-safe.

## 15.5. Overscan miss policy

Если visual viewport покидает `fully_prepared`, compositor MUST продолжить
present без ожидания Dioxus/layout/raster:

1. использовать `fallback_ready` tiles с точной/оценочной geometry и
   deterministic neutral message placeholders;
2. пометить emergency range и повысить его priority;
3. заменить fallback на full-fidelity chunks atomic transaction-ом с anchor
   correction;
4. если отсутствует даже safe fallback geometry/resource, применить controlled
   deceleration/clamp к последней валидной coverage boundary.

Запрещено:

- показывать transparent/uninitialized gap;
- растягивать последний raster tile;
- блокировать render thread;
- синхронно materialize-ить весь missing range;
- silently teleport-ить scroll offset;
- принимать input по placeholder как по ещё не materialized semantic child.

Fallback сохраняет фон/общую форму/estimated height, но не показывает fake text
или stale message content. Placeholder accessibility node не выдаёт себя за
реальное сообщение.

Для штатного PERF-01 на `120HZ_REFERENCE` visible fallback count MUST быть 0
после warm-up. В adversarial fling fixture: blank frames MUST быть 0;
fallback/clamp events, duration и distance MUST измеряться, а provisional p99
fallback residence — не более 50 ms. Итоговый threshold утверждается фактическим
ADR по topic T06 на
реальных устройствах и не может быть удалён без replacement metric.

## 15.6. Tile/cache policy

Message history rasterизуется в bounded screen-relative tiles или chunk groups.
Один item MAY пересекать несколько tiles; один tile MAY содержать несколько
items. Cache key включает content/layout/scale/color/device generations.

Cache MUST иметь:

- hard byte и tile-count budgets per device profile;
- pinning текущего viewport и минимального safety band;
- direction-aware eviction;
- pinning active sticky/fixed/selection fragments и следующего sticky
  constraint sentinel;
- in-flight resource lifetime protection;
- no allocation beyond device texture limits;
- telemetry hit/miss/eviction/raster/upload bytes.

При memory pressure сначала сокращается speculative дальний overscan, затем
fallback fidelity; текущий viewport не evict-ится до готовности replacement.

## 15.7. Long-coordinate precision

Logical list offsets и height index используют `f64` либо fixed-point с
доказанной эквивалентной точностью. GPU получает локальные `f32` coordinates
относительно periodically rebased scroll origin. Rebase MUST быть atomic для
scene, hit-test, glass ROI, IME и accessibility geometry и не создавать visual
jump.

## 15.8. Geometry epochs и непрерывность fling

Estimated и exact heights не могут молча жить в одном coordinate epoch.
Producer публикует явный remap:

```rust
pub struct GeometryCommit {
    pub old_epoch: u64,
    pub new_epoch: u64,
    pub based_on_scroll_generation: u64,
    pub anchor: ScrollAnchorToken,
    pub prefix_delta_map: PrefixDeltaMap,
    pub exact_ranges: LogicalRangeSet,
    pub new_extent: LogicalRange,
}
```

`PrefixDeltaMap` кодирует только изменённые intervals/prefix sums и имеет hard
item/byte cap; commit не переносит массив из 10k per-item deltas каждый frame.
Lookup/remap выполняется bounded (`O(log k)` либо доказанный эквивалент), а
overlapping/non-monotonic entries отклоняются.

`ScrollAnchorToken` содержит stable item/text-fragment ID и intra-fragment
position, а не только абсолютный pixel offset. При commit compositor remap-ит
текущую позицию так, чтобы anchor сохранил ту же screen coordinate:

```text
new_scroll_offset = map(old_scroll_offset, anchor, prefix_delta_map)
screen_velocity_after(t_commit) = screen_velocity_before(t_commit)
```

Geometry delta не проходит через input velocity estimator, не записывается как
fling impulse и не обнуляет physics state. Integrator хранит screen-space
velocity отдельно от content-coordinate remap. Это обеспечивает как минимум
`C0` position continuity и `C1` velocity continuity на frame boundary.

Во время active touch anchor дополнительно фиксирует content point под пальцем.
Во время fling prefix change выше viewport компенсируется новым scroll offset;
change ниже viewport меняет extent/predictor, но не текущую position/velocity.

Exact geometry, которая радикально отличается от fallback и пересекает
`protected motion band` (viewport + configurable ahead/behind margin), SHOULD
оставаться в shadow height index до выхода из band либо снижения velocity.
Накопленная `geometry_debt` bounded по pixels/items/time и наблюдаема. Если debt
достигает cap, coordinator заранее расширяет exact preparation, снижает скорость
через documented controlled deceleration либо clamp-ит coverage; внезапный
350-px teleport запрещён.

Active compositor mapping и shadow producer mapping имеют разные epochs.
Prepared tile/hit-test/selection resource маркируется тем epoch, в котором его
bounds рассчитаны; resource из shadow epoch нельзя частично вставить в active
scene до atomic remap.

Если меняется geometry самого anchor item, используется ближайший сохранившийся
text/line anchor; при его отсутствии — deterministic item edge rule. Large
in-viewport replacement MAY crossfade pixels, но crossfade не заменяет
coordinate remap и не может скрывать неправильный hit-test.

При shrink extent, который оставляет position за новым hard bound, применяется
отдельный `bounds_retarget`: spring/controlled settle сохраняет максимально
возможную velocity continuity и логирует неизбежный clamp. Нельзя мгновенно
перенести viewport в конец списка одним layout commit.

Geometry commit публикуется атомарно с tiles, spatial/clip/effect trees,
hit-test, selection и semantics bounds. Stale commit либо commit без полного
`prefix_delta_map` rejected.

---

# 16. Scroll anchoring

`NeoChatViewport` MUST обеспечивать:

- bottom anchor;
- prepend history без visual jump;
- variable-height correction;
- image-load height correction;
- streaming message growth;
- explicit disengagement после user scroll;
- stable item identity;
- unread anchor.

10k+ logical messages не должны материализовываться одновременно; это требование уже является частью v3 `NeoChatViewport`.

Anchor transaction содержит stable `MessageId`/text-fragment ID, intra-item
logical position, old/new geometry epochs, prefix delta map и scroll input ack.
Correction рассчитывается из положения anchor до/после commit, а не из индекса
recycled Dioxus node или разности двух absolute offsets.

Во время active touch large in-band geometry commit SHOULD откладываться по
правилам 15.8; если commit необходим, content point под пальцем сохраняется
coordinate remap-ом. Correction не добавляется к velocity. При bottom-anchor
streaming growth correction MAY применяться сразу, если пользователь остаётся
engaged. После disengagement streaming MUST NOT принудительно возвращать
viewport вниз.

Любая отложенная correction имеет hard bound и telemetry. Если exact anchor item
удалён, используется документированный successor/predecessor rule; молчаливый
переход к bottom anchor запрещён.

---

# 17. Animation fast path

Frame-by-frame animation state принадлежит presentation/compositor layer.

Запрещено:

```text
Product state write
× 120/second
```

ради interpolation.

Animation создаётся один раз:

```text
semantic transition
→ AnimationSpec
→ compositor animation
```

После этого presentation clock только sample-ит animation.

Предыдущая спецификация уже запрещала менять domain/presentation state 120 раз в секунду ради interpolation и требовала timestamp-based animation sampling.

---

# 18. NeoGlass

Этот раздел является conditional design. Настоящий live glass становится
обязательной capability только после `GateP:P1/P2` и `D1=Track D GO`. При
`GateP:P0` раздел не создаёт требований к production backend; при `GateP:P1` он
применяется только к capability-qualified profile, при `GateP:P2` — к
утверждённому полному Android matrix.

```rust
pub struct GlassSpec {
    pub material: GlassRole,
    pub blur_intent: BlurIntent,
    pub tint: ColorRole,
    pub saturation: f32,
    pub noise: NoiseRole,
    pub border: BorderRole,
}
```

```rust
pub struct GlassLayer {
    pub id: GlassId,
    pub bounds: Rect,
    pub source: BackdropSource,
    pub effect: GlassSpec,
    pub paint_order: PaintOrderKey,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
}
```

## 18.1. Backdrop semantics

Backdrop означает:

> уже скомпозированный результат позади конкретной GlassLayer в её composition scope.

В backdrop входят только ops, стоящие до `BackdropBarrier` и видимые через её
clip/isolation scope. Собственный material, border, foreground children и более
поздние siblings туда не входят. Реализация через screenshot всей final scene с
последующим blur семантически неверна.

Ancestor group opacity/filter/mask не входят в `GlassSpec`: они остаются в
effect path и применяются на соответствующих scope boundaries. Source resolve и
финальный glass composite обязаны использовать один и тот же spatial/clip/effect
snapshot.

Backdrop source и destination не могут одновременно читать/писать один и тот же
texture subresource с несовместимыми GPU usages. Pass graph использует
ping-pong/intermediate target либо другой backend-valid mechanism; результат
подтверждается validation layer/GPU capture.

Occlusion culling MUST учитывать backdrop reads: content, визуально закрытый
полупрозрачным/glass foreground, всё ещё нужен внутри expanded ROI и не может
быть отброшен как обычный opaque-covered layer.

Nested glass MUST учитывать composition order.

Запрещены cyclic backdrop dependencies.

## 18.2. Glass grouping

Glass operations MAY объединяться только при совпадении:

```text
backdrop source
+
effect
+
compatible overlap semantics
```

Одинаковый blur radius сам по себе недостаточен.

## 18.3. Downsample

Разрешён pipeline:

```text
source ROI
→ 1/2
→ 1/4
→ blur
→ effect
→ composite
```

Конкретный scale выбирается adaptive policy.

NeoUI v2 уже разрешал менять effect-buffer resolution, passes, kernel approximation и sample count при сохранении live-backdrop semantics.

## 18.4. ROI

Glass MUST обрабатывать минимально необходимый region:

```text
glass bounds
+ blur expansion
+ dependency damage
```

Full-screen blur texture не является default implementation для небольшого header/composer glass.

ROI вычисляется в target pixel space после transform/clip и расширяется на
фактический kernel support. Tile edges MUST иметь достаточный apron либо
neighbor sampling, иначе seams являются correctness bug.

## 18.5. Damage

Изменение pixels за glass инвалидирует:

```text
backdrop source
→ glass processing
→ downstream composite
```

даже если geometry GlassLayer не изменилась.

Renderer MUST учитывать bounded damage и reuse unchanged cached content.

Damage распространяется по pass dependency graph, а не только по совпадению
screen rectangles. Изменение paint chunk до barrier инвалидирует пересечение с
expanded glass ROI; изменение foreground после barrier не должно инвалидировать
сам blur, если не является источником другого downstream glass.

Damage зависит от **relative** sampled transform. Если sticky/fixed glass
остаётся на месте, а связанный scroll backdrop движется под ним, его ROI
пересчитывается каждый async sample даже при неизменных source textures. Если
glass и source разделяют один и тот же rigid scroll transform и relative mapping
не изменился, само общее перемещение не обязано повторно запускать blur.

## 18.6. Adaptive quality

При GPU pressure разрешено снижать:

- intermediate resolution;
- number of passes;
- kernel quality;
- noise quality;
- shadow resolution.

Запрещено в штатном supported profile незаметно заменять live backdrop статической полупрозрачностью.

`G0` fallback допускается только:

- safe mode;
- unsupported device;
- device recovery;
- explicit reduced visual capability profile.

---

# 19. Render-target pool

Temporary targets MUST переиспользоваться.

Pool key минимум:

```text
width class
height class
format
usage
sample count
device_epoch
```

Pool имеет bounded byte budget.

Per-frame создание полного набора blur textures запрещено.

Pass graph рассчитывает lifetime каждого target. Aliasing/reuse разрешён только
после последнего GPU read/write предыдущего logical resource. Target перед
частичным render должен быть cleared либо иметь доказанную valid-region history;
sampling pixels вне valid region запрещён. Resize/format/device epoch создают
новый compatibility class и не переиспользуют старый allocation вслепую.

---

# 20. Rasterization policy

NeoTavern MUST NOT писать generic glyph/vector rasterizer без отдельного ADR.

Normal UI rendering использует upstream raster backend через:

```rust
trait NeoRasterBackend {
    fn render_chunk(
        &mut self,
        chunk: &RecordedPaint,
        target: &RasterTarget,
        damage: &RectSet,
    ) -> Result<RasterResult, RasterError>;
}
```

Допустимы два режима.

### R0 — Direct retained output

```text
PaintChunk recording
→ replay directly into current compositor accumulation target
```

`Direct` не означает обязательный render прямо в swapchain. Если downstream
glass должен sample-ить результат, accumulation target MUST быть sampleable и
оставаться живым до backdrop pass.

### R1 — Cached raster layer

```text
NeoBlitz subtree
→ upstream rasterizer
→ bounded sampleable tile/texture
→ cached RasterLayer
```

Production MAY использовать hybrid R0/R1.

Mode выбирается per chunk/tile по stability, damage, backend capability и memory
cost. Выбор не может менять paint order/color/alpha semantics. Backend error не
приводит к panic render thread; применяется last-known-good chunk/fallback и
structured recovery policy.

---

# 21. Text

Text ownership:

```text
text semantics/layout → upstream text stack
editing session       → platform host
composition/IME       → platform
final composition     → NeoCompositor
```

NeoTavern MUST NOT:

- shape arbitrary Unicode на render thread;
- самостоятельно сканировать и загружать все system fonts;
- писать собственный font rasterizer;
- блокировать compositor ожиданием font work.

Text/Markdown preparation MUST быть incremental и cancellable. Cache key минимум
включает content, width class, style/font/fallback/locale/text-scale generations.
Font load/fallback change инвалидирует measured message heights и проходит через
height-index/anchor transaction. Нельзя менять glyph metrics внутри уже
опубликованного tile без соответствующего layout generation.

Visible/emergency text jobs имеют приоритет над speculative overscan; один
сложный Markdown/code block имеет per-job time/size budget и не удерживает UI
loop монопольно. Cold shaping и syntax highlighting входят в adversarial scroll
fixtures.

## 21.1. Interaction-ready text snapshot

Selectable/editable visible text MUST публиковать immutable interaction snapshot
из upstream text stack:

```rust
pub struct TextInteractionSnapshot {
    pub generation: u64,
    pub fragment_id: TextFragmentId,
    pub logical_range: TextRange,
    pub shaped_runs: Arc<[ShapedRunRef]>,
    pub cluster_map: Arc<[ClusterBoundary]>,
    pub line_metrics: Arc<[LineMetric]>,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub effect_node: EffectNodeId,
    pub backdrop_root: BackdropRootId,
}
```

`ShapedRunRef` — opaque replayable output upstream shaper/renderer с glyph IDs,
positions и font resources; NeoTavern не становится shaper либо glyph
rasterizer. Snapshot позволяет менять highlight/caret paint без повторного
Unicode shaping/layout.

Logical selection anchors хранят stable item/text-fragment ID, cluster boundary,
bidi affinity и generation. Tile ID/pixel coordinate не является authority.
Mutation текста remap-ит либо collapse-ит selection deterministic rule-ом;
stale cluster map не используется.

## 21.2. Selection paint decomposition

Для interaction-ready fragment канонический порядок:

```text
box/background PaintChunk
→ text shadows/under-decorations according to upstream paint plan
→ SelectionPaintOp backgrounds
→ unselected and selected glyph runs
→ text decorations/IME composition marks
→ caret/selection handles
```

`SelectionPaintOp` содержит logical range, resolved rect/shape fragments,
selected-text brushes, spatial/clip/effect references и source generation.
Upstream text plan определяет корректное подавление/перерисовку selected glyphs
и decorations; color emoji сохраняют собственную palette semantics.

Selection update при неизменной geometry MUST быть `SELECTION_ONLY`: меняются
только small display ops/damage. Повторный Dioxus reconciliation, shaping,
layout либо rasterization background tiles на каждый pointer move запрещены.

Selection/text ops сохраняют ancestor effect scope и обычные backdrop
dependencies. Если highlight расположен до glass barrier, его bounded damage
инвалидирует пересекающийся glass ROI; selection нельзя дорисовать отдельным
topmost HUD поверх всей сцены.

Selectable glyphs нельзя permanently bake-ить с background tile. Допустимы:

1. постоянно разделённые background/text recordings для visible selectable
   items;
2. bounded interaction promotion из сохранённого shaped snapshot без reshaping;
3. upstream vector/glyph recording, replayable после selection underlay.

Рисовать translucent selection поверх уже запечённых glyphs через
`multiply`/`difference`, а затем считать результат корректным, запрещено.

## 21.3. Cross-tile selection и autoscroll

Selection geometry строится для logical text range целиком, затем клипуется
каждым intersecting tile/clip chain. Tile A/B не создают две независимые
selection authorities; pixel snapping на общей границе детерминирован и не
оставляет gap/double edge.

Пока selection активна, необходимые shaped snapshots, foreground recordings и
минимальный range pins-ятся bounded interaction budget-ом. Drag к краю viewport
может запустить compositor autoscroll и emergency preparation, но selection end
не перескакивает в fallback placeholder. До materialization handle остаётся на
последней валидной cluster boundary.

Обязательный v1 scope — весь один logical message/code block независимо от
числа tiles. Cross-message selection MAY быть отдельной capability; если она не
поддерживается, handle явно clamp-ится к message boundary, а не молча выбирает
соседний recycled node.

Selection handles и caret являются отдельными frontmost hit-test items со своим
spatial node/pointer capture. Их bounds sample-ятся тем же compositor property
snapshot, что glyphs и sticky/fixed content.

---

# 22. Android IME

Активная text-composition session принадлежит platform text host.

Canonical state содержит:

```text
text
selection
composition
IME action
cursor geometry
```

Rust Kernel получает durable/debounced draft snapshots, но не подтверждает каждую code-unit mutation до ответа Gboard.

IME geometry MUST учитывать:

- scroll;
- edge-to-edge;
- keyboard insets;
- display scale;
- rotation;
- split screen;
- floating/freeform window;
- surface/window generation.

Тяжёлый synchronous relayout из IME query запрещён; geometry должна быть доступна заранее через cache/snapshot. Эта модель уже зафиксирована в v2.

Caret/composition bounds преобразуются через конкретный `SpatialNodeId` и
current property snapshot. Sticky/fixed composer, transformed ancestor и nested
scroll нельзя обслуживать добавлением одного root scroll offset.

---

# 23. Input и gestures

NeoUI v4 не реализует собственную универсальную Gesture Arena.

Host/upstream layer владеет:

- touch slop;
- tap;
- double tap;
- long press;
- drag;
- nested scrolling;
- fling;
- pointer capture;
- platform back gesture.

Обязательные conflict fixtures:

```text
vertical chat scroll
vs
horizontal message action
vs
horizontal code block
```

а также:

```text
text selection vs scroll
plugin surface vs system back
media controls vs parent scroll
```

NeoCompositor получает resolved transform/scroll result, а не пытается повторно распознавать semantic gesture.

## 23.1. Hit-test при async scroll

Hit-test items публикуются в том же paint order и с теми же property-tree
references, что visual ops:

```rust
pub struct HitTestItem {
    pub id: HitTestId,
    pub target: StableSemanticId,
    pub local_bounds: Rect,
    pub spatial_node: SpatialNodeId,
    pub clip_chain: ClipChainId,
    pub paint_order: PaintOrderKey,
    pub pointer_flags: PointerFlags,
    pub scroll_target: Option<ScrollId>,
    pub generation: u64,
}
```

Для pointer event compositor создаёт один `CompositorPropertySnapshot` с
актуальными async offsets всех `ScrollNode`, sticky clamps, fixed/reference-frame
transforms, clips, viewport/inset и origin rebase. Затем он идёт по кандидатам
front-to-back и для **каждого** item:

1. строит его current world transform из ancestor spatial chain;
2. применяет inverse именно этого transform к screen point;
3. проверяет local bounds и весь current clip chain;
4. учитывает `pointer-events`, overlay/occlusion и paint order.

Глобально прибавлять/вычитать root `async_scroll_delta` до hit-test запрещено.
Sticky header получает clamped transform, viewport-fixed node не получает root
scroll, а fixed node в transformed ancestor следует своему containing block.
Frontmost blocking sticky/selection/media control не может пропустить tap к
сообщению под ним.

`HitTestResult` содержит property-sample generation, spatial/effect/scroll
epochs и stable target. Event MUST быть discarded/re-resolved, если к dispatch
моменту target recycled/удалён либо property sample стал несовместим. После
успешного pointer down активный pointer capture сохраняет stable target до
release/cancel, если target generation остаётся валидной. Нельзя dispatch-ить
click по визуально перемещённому item, используя старые screen bounds.

В UI dispatch передаются stable target, original screen point, resolved local
point и property-sample/scroll generations. Dioxus/NeoBlitz handler не должен
повторно вычислять target одним committed root offset. Если API события требует
viewport/client coordinates, host поставляет visual coordinates текущего async
sample и сохраняет original hardware coordinates отдельно.

На pointer down gesture block latch-ится к найденному `ScrollId`/target;
subsequent events используют pointer capture и nested scroll-handoff rules.
Non-invertible transform, stale sticky constraints, unsupported async effect или
неактивный nested scroll region помечаются как `dispatch-to-UI/slow path` до
обновления snapshot, а не hit-test-ятся приблизительно.

Fallback placeholder из overscan-miss policy участвует только в scrolling и не
принимает semantic tap/selection. При pointer down на boundary coordinator MAY
запросить emergency materialization, но не блокирует event loop. IME caret,
selection handles, scrollbars и accessibility bounds используют тот же property
snapshot/rebase protocol.

---

# 24. Assets

Asset pipeline:

```text
reference
→ fetch
→ metadata probe
→ decode worker
→ decoded resource
→ upload queue
→ resident GPU resource
```

CPU decode MUST NOT происходить на UI/render thread.

Upload:

- bounded;
- prioritized;
- generation-aware;
- byte-budgeted;
- cancellable.

Scene/layout не блокируются на full decode.

Known metadata dimensions SHOULD резервировать layout до готовности image.

---

# 25. NeoMedia

Media decoder отделён от visual composition.

Preferred inline video path:

```text
platform decoder
→ sampleable frame
→ MediaLayer
→ NeoCompositor
```

Sampleable video:

- наследует transform;
- наследует clip;
- участвует в opacity;
- движется вместе со scroll;
- участвует в damage;
- может являться backdrop source для glass.

Эта модель соответствует требованию v2, согласно которому sampleable video должно участвовать в transform/clip/scroll/backdrop glass, а secure content использовать отдельный fallback.

Secure/DRM content MAY использовать ExternalSurface.

---

# 26. ExternalSurface

ExternalSurface применяется только когда pixels нельзя безопасно sample/composite.

Примеры:

- WebView;
- secure video;
- platform view;
- compatibility surface.

ExternalSurface MUST объявлять:

```text
sampleable
transformable
clip support
glass participation
snapshot capability
secure content
input ownership
IME ownership
accessibility ownership
```

Если content non-sampleable, NeoUI MUST NOT обещать arbitrary:

```text
NeoUI
→ native surface
→ NeoUI
→ live glass
```

Используется documented panel/poster/fullscreen/opaque fallback.

Non-sampleable ExternalSurface MUST NOT попадать внутрь offscreen group, который
требует group opacity, mask, filter, destination blend либо backdrop read через
surface pixels. Parent effect нельзя «протащить» только на NeoUI siblings,
оставив native surface с другой opacity/clip.

Scene compiler валидирует всю ancestor effect chain. При несовместимости он до
показа route выбирает один из explicit вариантов:

- hoist в отдельный platform panel с ограниченным interleaving;
- opaque/poster snapshot, если security/capability это допускает;
- fullscreen transition;
- отказ materialize-ить комбинацию с diagnostic.

Hit-test native surface и surrounding NeoUI использует общий front-to-back
placement contract; region surface не может одновременно принимать platform
input и пропускать его в скрытый NeoUI target.

---

# 27. Plugin architecture

NeoPlugin IR является отдельным stable portability/security contract.

First-party Dioxus mutation protocol **не является plugin ABI**.

Существующий DOM/React frontend plugin contract также **не становится**
NeoPlugin IR автоматически. До D3 GO считаются разными ABI:

```text
Web Presentation ABI      — React/DOM/CSS/JS contracts
Android Presentation ABI  — выбранный native producer + bounded plugin tiers
Product Capability ABI    — Kernel/Product Wire permissions and commands
```

Canonical plugin path:

```text
NeoTSX / plugin SDK
        ↓
NeoPluginCompiler
        ↓
validated NeoPlugin IR
        ↓
NeoPluginRuntime
        ↓
host materialization
        ↓
Dioxus/NeoBlitz/NeoScene
```

Runtime mutations применяются atomic batches. Предыдущий v3 уже требовал atomic `MutationBatch` с base/next revision и host generation.

## 27.1. Theme SDK v2 gate

Произвольные CSS cascade layers, DOM selectors, `data-*` hooks, React shell
replacement и DOM islands не переносятся в Dioxus/NeoScene 1:1. До Android
cutover MUST быть выбран один честный контракт:

1. `FixedShell` — Android v1 поддерживает только product-owned shell и bounded
   palette/spacing/typography/material tokens;
2. `ThemeSDKv2` — versioned semantic tokens + typed component variants +
   разрешённые layout slots;
3. `WebThemeContainment` — полная legacy theme работает только в WebSurface/
   legacy route с заявленными visual/performance ограничениями.

Нельзя обещать поддержку shell themes, если реализованы только цвета. Для
каждой существующей capability заполняется `PresentationCompatibilityMatrix`.
Theme package MUST объявлять поддерживаемые presentation ABI/version и
fallback. Неизвестная либо несовместимая theme не должна частично менять shell.

`GlassSurface` является host capability, а не CSS escape hatch. Theme MAY
выбирать только валидированные material tokens и разрешённые placement slots;
она не получает RenderGraph mutation authority.

## 27.2. Plugin SDK migration gate

До D3 GO inventory существующих frontend plugins классифицируется по tiers
`Plugin:P0…P5`.
Для каждого популярного journey фиксируются:

- требуемые DOM/React/JS globals и slots;
- native replacement либо WebSurface containment;
- live-glass/interleaving ограничения;
- input, clipboard, file, network и storage permissions;
- состояние при background/device loss;
- migration owner, version и срок deprecation;
- пользовательский diagnostic при несовместимости.

Legacy `window` globals, DOM islands или React component injection MUST NOT
эмулироваться внутри first-party native tree. Если journey требует их, он
остаётся в изолированном WebSurface/legacy route либо получает новый typed API.

Android release notes MUST явно называть неподдерживаемые extension classes.
Фраза «plugins supported» без tier/capability matrix запрещена.

---

# 28. Plugin tiers

Сохраняются уровни:

| Tier | API | Назначение |
|---|---|---|
| Plugin:P0 | Kernel capabilities | headless agents/tools |
| Plugin:P1 | StandardUI | panels/forms/chat widgets |
| Plugin:P2 | Canvas2D | charts/diagrams/simple custom visuals |
| Plugin:P3 | VisualSurface | Live2D/3D/high-frequency visuals |
| Plugin:P4 | WebSurface | arbitrary legacy HTML/JS |
| Plugin:P5 | NativeExtension | reviewed trusted integration |

Plugins получают capabilities, а не ambient Kernel authority.

---

# 29. PluginVisualSurface

VisualSurface предназначен для high-frequency producer.

```rust
pub struct SurfaceFrame {
    pub surface: SurfaceId,
    pub generation: u64,
    pub sequence: u64,
    pub timestamp: TimePoint,
    pub content: SurfaceContent,
    pub damage: Option<RectSet>,
    pub fence: Option<FenceDescriptor>,
}
```

Queue MUST быть:

```text
bounded
latest-frame-wins
non-blocking
generation-aware
```

Fence/imported resource, который не ready к frame deadline, MUST NOT блокировать
main compositor. Используется последняя готовая frame либо transparent/documented
surface fallback; late frame дропается с reason. Imported texture проверяется по
format, dimensions, usage, ownership, quota и device epoch. Lifetime сохраняется
до GPU completion.

Эти свойства уже являлись требованиями VisualSurface v3.

Untrusted plugin MUST NOT получать:

- raw `wgpu::Device`;
- Vulkan device;
- Metal device;
- main compositor command encoder;
- arbitrary compositor shader;
- RenderGraph mutation authority.

Sampleable PluginVisualSurface MAY участвовать в live glass.

---

# 30. WebSurface

WebSurface является compatibility boundary.

Default placement:

- dedicated panel;
- modal;
- fullscreen;
- isolated route.

Inline WebSurface не является обязательной capability.

Не гарантируются:

- live glass поверх WebView pixels;
- arbitrary layer interleaving;
- zero-cost scrolling;
- native text semantics.

WebSurface имеет origin policy, storage isolation, bridge allowlist и crash recovery.

Для legacy SillyTavern-class UI/extension route WebSurface является
compatibility product, а не невидимым implementation detail. Product decision
MUST определить:

- какие journeys доступны на телефоне;
- открываются ли они panel/modal/fullscreen;
- какие auth/storage/session данные разделяются;
- что происходит без сети и после process death;
- какие visual ограничения видит пользователь;
- является ли отсутствие inline/live-glass interleaving приемлемым.

WebSurface не может использоваться как доказательство parity native Android UI,
если существенная часть продукта фактически возвращается в WebView.

---

# 31. Web profile

Web migration не является условием Android delivery.

Production Web MAY продолжать использовать:

```text
React
→ DOM
→ browser layout
→ browser compositor
```

через тот же Product Wire.

Это сохраняет принцип v3 о независимом Web backend и общий принцип, что browser владеет DOM/CSS/text/accessibility/media на Web.

Dioxus Web MAY исследоваться отдельно.

Web cutover требует собственного ADR и benchmark corpus.

## 31.1. Dual-UI ownership

При `D3=dual UI` React Web и native Android являются двумя presentation
реализациями одного продукта. Для каждого critical feature PR MUST определять:

```text
shared Product Wire/model change
Web presentation owner and tests
Android presentation owner and tests
capability divergence, если согласован
localization/a11y/theme/plugin impact
rollout order and compatibility window
```

Одинаковые команды и модели не гарантируют одинаковые empty/error/loading,
focus, keyboard, gesture, a11y и plugin states. Общий fixture corpus MUST
проверять semantics, но pixel identity между Web и Android не требуется.

Roadmap/capacity plan MUST считать реализацию и сопровождение двух UI, а не
оценивать задачу как «renderer уже существующего UI».

---

# 32. Desktop profile

После Android GO Desktop MAY использовать:

```text
Dioxus
→ NeoBlitz
→ NeoScene
→ NeoCompositor
```

либо upstream raster path там, где custom compositor не создаёт продуктовой выгоды.

Windows/Linux/macOS capability tables ведутся отдельно.

Android delivery не блокируется Desktop.

---

# 33. iOS profile

iOS не является blocking target первой production версии.

Future iOS profile SHOULD сохранять:

```text
Dioxus presentation semantics
NeoScene
NeoCompositor
NeoGlass
NeoMedia
NeoPlugin IR
```

с platform adapters для:

- text input;
- accessibility;
- lifecycle;
- window/surface;
- media.

Graphics backend MAY использовать Metal через выбранный `wgpu` backend.

iOS GO требует отдельного 120-Hz ProMotion acceptance corpus.

---

# 34. Scheduler

NeoUI различает:

```text
LogicalClock
PresentationClock
MediaClock
```

PresentationClock поступает от platform vsync/display callback.

Он не используется как:

- network timeout clock;
- retry clock;
- durable timer;
- storage maintenance clock.

При resume missed presentation frames не replay-ятся.

UI строит latest state.

## 34.1. Thread/queue ownership

Минимальная логическая модель:

| Executor | Владеет | MUST NOT |
|---|---|---|
| Platform/UI | window/input/IME/accessibility callbacks, Dioxus/NeoBlitz mutable document | ждать GPU/worker, делать decode, выполнять unbounded virtualization batch |
| Render | NeoScene snapshot, compositor state, pass graph, device/queue/surface | читать mutable UI state, ждать layout/shape/decode/plugin producer |
| Preparation workers | Markdown parse, asset decode, safe immutable preparation jobs | менять Dioxus DOM, публиковать частичный transaction |
| Product runtime | Kernel/Product Wire | синхронно участвовать в каждом scroll/present frame |

Физическое совмещение executors на платформе MAY отличаться, но запреты и queue
boundaries сохраняются. Для каждой queue фиксируются item cap, byte cap,
coalescing/drop policy, priority classes и shutdown/device-loss behavior.

Priority order на interactive route:

```text
input/IME/current-frame critical
→ active selection/caret and sticky constraint repair
→ visible emergency range
→ geometry remap inside protected motion band
→ current viewport updates
→ near-range prefetch
→ speculative assets/raster
→ maintenance
```

Priority inversion и starvation проверяются trace-ами. Product/telemetry work не
может вытеснить current-frame critical work.

## 34.2. Frame scheduling

Frame запрашивается только при damage, active animation/fling, media cadence,
surface update либо platform requirement. Idle UI MUST NOT непрерывно submit-ить
120 frames/s.

Scheduler выбирает один complete scene snapshot до encode cutoff. Поздний UI
transaction переносится на следующий frame; запрещено удерживать present в
надежде «успеть ещё один layout». При predicted miss scheduler MAY reuse
last-known-good standard layers и обновить только compositor transform/glass,
если generations совместимы и это не показывает stale semantic state после
security-sensitive transition.

Внутри frame scheduler sample-ит все active scroll physics один раз и строит
единый `CompositorPropertySnapshot`; visual encode, glass ROI, hit-test exposure,
selection handles и exported IME/accessibility bounds не смешивают property
samples разных поколений.

---

# 35. Lifecycle

Минимальная state machine:

```text
Created
→ Starting
→ Active
↔ Suspended
→ Stopping
→ Stopped
```

Orthogonal resource states:

```text
Window:
Absent / Present

Surface:
Absent / Ready / Lost

Renderer:
Initializing / Ready / Recovering / Failed

ProductWire:
Connecting / Ready / Degraded / Closed
```

Product state не зависит от lifetime Window/Surface/Renderer. Этот инвариант уже присутствовал в v3.

## 35.1. Startup, staged rollout и rollback

До Milestone C утверждаются численные budgets для APK/install-size delta,
native library load, renderer initialization, first safe frame и first
interactive chat frame. Добавление Rust runtime, upstream layout/text, wgpu,
shaders и platform recovery UI не считается бесплатным только потому, что
scroll benchmark проходит.

Backend выбирается до materialization product UI. Hot switch между WebView и
native renderer внутри активного route запрещён: он создаёт два input/IME/a11y
authority. Staged rollout MAY использовать signed bounded configuration, но она
выбирает только собранный и проверенный backend/profile, не доставляет код,
shader или plugin capability.

Rollout contract включает:

```text
internal/device-lab → opt-in/beta → bounded cohort → gradual production
crash/ANR/startup/jank/memory guardrails
automatic cohort halt, not silent semantic degradation
manual kill switch with audited owner
safe-mode entry before first custom frame
durable state backward/forward compatibility
rollback to previous presentation backend without storage migration
```

Remote kill switch не заменяет offline recovery: последний known-good local
choice и platform safe mode должны работать без сети.

---

# 36. GPU device recovery

GPU resources считаются disposable.

Canonical state:

```text
Uninitialized
→ Ready(epoch=N)
→ LossDetected
→ Quiescing
→ Recreating
→ Rehydrating(epoch=N+1)
→ Ready(epoch=N+1)
```

Каждый GPU-facing handle содержит `device_epoch`.

Completion старого epoch MUST быть rejected.

Device loss atomically закрывает admission новых jobs старого epoch, отменяет
speculative raster/upload, дожидается/отбрасывает callbacks по generation rules и
очищает coverage `fully_prepared`, чьи resources принадлежали старому device.
Height index, recorded paint descriptors и fallback descriptors MAY пережить
loss, GPU handles — нет.

После device loss сохраняются:

- Kernel state;
- presentation state;
- asset descriptors;
- media session descriptors;
- source/raster descriptions, достаточные для rebuild.

Rehydration приоритетно восстанавливает current viewport, glass dependencies и
safe interaction surface, затем near overscan. Восстановление всего cache до
первого frame запрещено.

Не сохраняются как authority:

- GPU textures;
- render targets;
- fences;
- command buffers.

---

# 37. Safe mode

Safe mode MUST работать даже при отказе NeoCompositor.

Safe mode является намеренно третьей, минимальной platform UI implementation
(Android View/Compose либо эквивалент). Этот факт учитывается в ownership,
binary size, localization и test plan; он не маскируется как часть Dioxus UI.

Android safe mode:

- минимальный platform-owned recovery screen;
- plugins disabled;
- VisualSurface disabled;
- custom glass disabled;
- diagnostics export;
- restart UI host;
- Kernel/storage remain intact.

Safe mode не считается нормальным visual profile.

Граница safe mode жёсткая:

- только recovery/diagnostics/restart/export;
- без chat, themes, plugins, media и provider workflows;
- без зависимости от NeoCompositor/Dioxus/Blitz initialization;
- без чтения provider secrets в UI;
- с фиксированным bounded набором локализуемых строк;
- с отдельным instrumentation test, который ломает custom renderer до старта.

Расширение safe mode до альтернативного product shell требует отдельного ADR.

---

# 38. Memory budgets

Отдельно budget-ятся:

```text
decoded CPU images
GPU image textures
raster layer cache
font/text upstream caches
media decoder frames
PluginVisualSurface resources
render-target pool
glass intermediate textures
NeoScene
Dioxus/NeoBlitz tree
GPU staging/upload buffers
```

Один global memory limit недостаточен.

Каждый pool/cache MUST иметь hard byte cap, item/count cap, admission policy и
observable current/high-water values. «Ограничивается memory pressure callback»
без собственного cap не принимается.

До выхода Milestone B утверждается production `MemoryBudgetProfile` для
low/mid/reference. Milestone 0 фиксирует только фактический peak/steady-state
своей bounded сцены и проверяет отсутствие leak/unbounded growth:

```text
process steady-state cap/target
decoded-image cap
GPU resident-image cap
raster/scroll-tile cap
interaction-ready text/glyph-recording cap
active selection pinned-range cap
effect-scope/offscreen-group peak cap
fallback-tile cap
render-target + glass peak cap
staging/upload cap and bytes/frame
font/text cache cap
plugin/media per-surface and aggregate caps
maximum simultaneously materialized message items
maximum ahead/behind overscan items and pixels
maximum geometry debt pixels/items/time
```

Значения получают из device memory class, GPU limits и measured peak. Они
являются численными release artifacts в фактических ADR по topics T06/T22 и
benchmark profile; раздел без
утверждённой таблицы не считается реализованным.

Memory pressure reaction:

1. remove speculative assets;
2. trim raster caches;
3. trim GPU image residency;
4. purge reusable targets;
5. reduce glass intermediate resolution;
6. suspend offscreen plugin surfaces;
7. preserve durable product state.

Reaction имеет hysteresis, чтобы не вызывать trim/reallocate oscillation каждый
frame. Allocation failure обрабатывается как recoverable degraded frame; panic/
OOM из-за необязательного glass target или speculative tile запрещён.

---

# 39. Color pipeline

NeoCompositor MUST иметь explicit canonical policy для:

- linear vs nonlinear operations;
- premultiplied alpha;
- texture formats;
- output color space;
- HDR/SDR capability;
- video conversion;
- glass sampling.

Glass golden tests MUST выявлять:

- dark halos;
- double premultiplication;
- incorrect gamma blur;
- video color mismatch;
- transparent-edge artifacts;
- group-opacity double application вокруг glass;
- selection background/glyph recolor, включая color emoji.

---

# 40. Accessibility

Accessibility tree отделён от visual scene.

Glass, blur, shadows и compositor layers не создают semantic nodes автоматически.

Semantic identity должна переживать virtualization только пока соответствует тому же logical item.

Screen reader action на recycled/deleted node MUST возвращать unavailable.

Visual overscan и accessibility window не обязаны совпадать. Host MUST иметь
virtual semantics provider, который по stable item ID может объявить bounded
semantic range, запросить materialization следующего/предыдущего range и
сохранить focus anchor. Нельзя materialize-ить 10k visual nodes только ради
TalkBack tree.

Bounds materialized semantic nodes вычисляются из того же latest sampled
per-node spatial/scroll/sticky/fixed tree, что visual/hit-test frame; global root
scroll delta недостаточен. Fallback placeholders не публикуются как реальный
message text. Accessibility request MAY инициировать high-priority preparation,
но platform callback получает bounded ответ/progress state, а не блокируется на
full layout.

Обязательны реальные:

- TalkBack;
- desktop screen-reader acceptance;
- keyboard navigation;
- streaming live-region tests;
- virtualized chat traversal.

## 40.1. Localization, bidi и RTL

Android rewrite MUST NOT создавать независимый неуправляемый набор строк.
React Web и native Android используют общий versioned message catalog либо
автоматически проверяемое отображение namespace/key между каталогами.

Обязательный contract:

- locale negotiation, persistence и runtime switch определены явно;
- plural/select/number/date/time formatting имеют одинаковые CLDR-compatible
  semantics на двух presentation backends;
- fallback locale и missing-key telemetry не показывают пустые controls;
- user-generated message direction определяется отдельно от chrome locale;
- layout использует logical start/end properties, если направление влияет на
  geometry;
- bidi isolation не позволяет message content переупорядочивать surrounding UI;
- icons/gestures зеркалятся только по semantic policy, а не автоматически все;
- font fallback и shaping проверяются на Arabic, Hebrew, mixed bidi, CJK,
  combining marks и emoji;
- TalkBack labels, hints, plurals и safe-mode strings локализуются;
- plugins объявляют localized resources и fallback независимо от host strings.

CI MUST включать минимум:

```text
pseudolocale with 30–50% expansion
mirrored RTL pseudolocale
Arabic/Hebrew mixed-direction chat
locale switch without process restart
missing/obsolete key check across Web and Android
screenshots/semantics for clipped critical controls
```

Наличие upstream text shaping не закрывает layout mirroring, copy ownership,
plural rules либо accessibility localization.

---

# 41. Security

Threat model включает:

- hostile plugin;
- malformed NeoPlugin IR;
- hostile Markdown;
- hostile image/font/media;
- stale callback;
- GPU resource exhaustion;
- malicious WebSurface navigation.

Required controls:

- bounded parsers;
- capability isolation;
- generation IDs;
- signed/integrity-checked packages;
- plugin quotas;
- URL/origin policy;
- safe mode;
- fuzzing;
- bounded GPU allocations.

NeoDisplayList/RecordedPaint также считаются недоверенным по отношению к GPU
boundary input: проверяются counts, rectangles, finite transforms, clip depth,
effect recursion, resource dimensions/formats, byte arithmetic и acyclic graph.
Invalid transaction не заменяет last-known-good scene.

Дополнительно валидируются balanced effect scopes, finite/invertible hit-test
transforms, sticky constraint bounds, monotonic scroll/geometry epochs,
`prefix_delta_map` coverage и selection ranges против text snapshot generation.
Malformed property tree не должен отправить input другому semantic target.

При route/account/privacy transition запрещено показывать stale cached tile от
предыдущего presentation generation даже как overscan fallback. Sensitive
generation change purge-ит соответствующие raster/fallback resources до
принятия нового input.

---

# 42. Privacy и telemetry

Performance telemetry MUST использовать:

```text
IDs
sizes
durations
frame generations
device epoch
queue depths
damage sizes
glass pass timings
GPU timings
memory budgets
plugin surface frame drops
prepared/fallback range sizes
overscan miss/fallback/clamp counts and durations
paint chunk/cache counts
display-list/pass-graph build durations
property-snapshot generation and slow-path reasons
sticky/fixed constraint misses
selection-only update duration and pinned bytes
geometry remap delta and velocity discontinuity
geometry debt and bounds-retarget events
effect-scope target bytes/pass count
```

По умолчанию telemetry MUST NOT содержать:

- message text;
- prompts;
- model responses;
- composition text;
- clipboard;
- attachment bytes;
- provider secrets;
- raw accessibility text.

---

# 43. Performance benchmark corpus

Минимальный mobile corpus:

Это corpus Milestone B/C и production acceptance. Milestone 0 выполняет только
узкий paint/shared-device subset PERF-11, описанный в разделе 48; наличие
PERF-01…22 в документе не расширяет scope prototype.

## PERF-01 — 120-Hz chat scroll

```text
10k mixed-height messages
+ Markdown
+ images
+ live glass header
+ live glass composer
```

Continuous bidirectional scroll.

Fixture выполняется отдельно с warm cache и cold-near-range cache; отчёт обязан
разделять результаты.

## PERF-02 — streaming

То же + активный streaming Markdown response.

Logical updates coalesce.

## PERF-03 — multiple glass

```text
header glass
composer glass
floating overlay glass
```

одновременно.

## PERF-04 — nested glass

Dialog glass появляется над header/sidebar backdrop chain.

## PERF-05 — image pressure

Fast scroll через image-heavy history с ongoing decode/upload.

## PERF-06 — inline video

Sampleable video движется под live glass.

## PERF-07 — VisualSurface

Live2D-class surface работает вместе с chat scroll и glass.

## PERF-08 — text editing

Gboard composition + keyboard inset animation + scrolling chat.

## PERF-09 — lifecycle

Background → resume → rotate → split-screen → surface recreation.

## PERF-10 — thermal

10-minute continuous high-refresh scene.

## PERF-11 — paint-boundary order

```text
wallpaper PaintChunk
→ glass
→ ordinary text
→ sampleable video/plugin surface
→ nested/overlapping glass
→ overlay/caret
```

Golden pixels + GPU capture проверяют barrier order, ROI, color/alpha и
отсутствие readback/cross-device copy.

## PERF-12 — adversarial virtualization fling

Cold fling через 10k mixed-height messages со сложным Markdown/code, font
fallback и image metadata; скорость и reversal превышают штатный gesture corpus.

Проверяются:

- predictive trigger до edge;
- queue/cancellation bounds;
- zero blank/uninitialized frames;
- fallback/clamp count и residence;
- no render-thread wait;
- anchor correction после full-fidelity commit.

## PERF-13 — scroll reversal/teleport

Быстрый reversal, scrollbar/accessibility jump и prepend history. Проверяются
height-index lookup, emergency range, epoch/ack protocol, origin rebase и
отсутствие stale hit targets.

## PERF-14 — async hit-test

Tap/selection/long-press во время unacknowledged compositor scroll, tile replace
и Dioxus recycling. Event никогда не приходит другому logical message.

## PERF-15 — pressure/degraded path

Memory pressure во время fling + glass + image upload + VisualSurface. Проверяет
hard caps, eviction order, last-known-good/fallback, allocation failure и
отсутствие OOM/panic.

## PERF-16 — cold pipeline/first interaction

Cold process start и первый вход в chat с первым glass/scroll frame. Проверяет
shader/pipeline compilation, font/cache cold path, first tile admission и
input-to-present. Отдельно выполняется после invalidation pipeline cache и после
device recreation.

Отчёт дополнительно разделяет APK/download/install-size delta, native library
load, Product Wire connect, renderer init, first safe frame и first interactive
chat frame. Injection failure до первого custom frame обязан открыть safe mode;
startup crash loop считается release blocker независимо от steady-state FPS.

## PERF-17 — sticky/fixed async hit-test

Root chat scroll имеет 500+ px unacknowledged delta. Sticky glass date header с
кнопкой, viewport-fixed composer, fixed node внутри transformed ancestor и
обычное message action перекрываются в screen space.

Проверяются per-node world transforms, sticky clamp boundaries, relative glass
backdrop damage, frontmost hit, clip, pointer capture и отсутствие click-through в сообщение. Fixture
повторяется с nested horizontal code-block scroll и direction reversal.

## PERF-18 — effect scope split

```text
opacity group
→ transformed/rounded clip Card
→ ordinary prefix
→ GlassSurface
→ foreground text/media
→ EndEffectScope
```

Golden/GPU capture проверяют, что group opacity/filter/mask применяется один
раз, backdrop source выбран в правильном paint position, ROI transformed
корректно, а effect target bounded. Отдельные cases: nested opacity, isolation,
conditional mask/blend и nested glass.

## PERF-19 — cross-tile selection

Long selectable message пересекает минимум три tiles и содержит bidi text,
ligatures, underline/strike, syntax colors и color emoji. Long press + drag +
selection autoscroll не запускают shaping/layout и не создают seams либо
blend-color artifacts. Selection handles остаются правильными при async scroll
и tile replacement.

## PERF-20 — geometry remap during fling

На 10 000 px/s fallback item перед/внутри/после viewport меняет height минимум
на 350 px после Markdown/image metadata resolution. Проверяются:

- zero visual teleport/blank frame;
- `C0` anchor position continuity;
- `screen_velocity_after(t_commit) == screen_velocity_before(t_commit)` в
  пределах измерительной погрешности, если hard bound не достигнут;
- bounded geometry debt/protected-band deferral;
- deterministic bounds retarget при grow/shrink extent;
- atomic tiles/hit-test/semantics generation.

## PERF-21 — nested scroll latch/handoff

Vertical chat, horizontal message action/code block и inner scroll surface
получают отдельные `ScrollId`. Gesture block не меняет target до разрешённого
handoff; fling handoff не удваивает delta и не применяет root inverse к inner
content.

## PERF-22 — non-sampleable surface/effect rejection

WebView/secure video помещаются под glass и внутрь opacity/mask group.
Scene compiler обязан до present выбрать заявленный panel/poster/fullscreen/
error fallback; partial parent effect, неверное interleaving и input
click-through считаются failure.

Это расширяет уже существовавший product acceptance corpus v3, где обязательными были 10k messages, streaming Markdown, Gboard, image decode, inline video, glass header, VisualSurface, TalkBack и recovery.

---

# 44. Mobile device matrix

Минимум:

### Android low tier

Цель:

```text
stable 60 Hz
live glass semantics
adaptive effect quality
```

### Android mid tier

Цель:

```text
90/120 Hz according to device capability
```

### Android high-refresh reference

Цель:

```text
supported 120-Hz mode
host requests high frame rate
observed 120-Hz mode in controlled run
120-Hz renderer budget is blocking only for observed opportunities
```

### Pixel/Gboard reference

IME acceptance.

### OEM aggressive-lifecycle device

Background/process/surface acceptance.

### Tablet/foldable

Insets, resize, multi-window.

Emulator не заменяет real-device GPU/IME/accessibility acceptance.

Для каждого устройства фиксируются `wgpu` adapter/backend, driver/OS, texture
limits, timestamp-query support, memory profile, supported refresh modes и
thermal policy. Результат без этих данных не переносится автоматически на весь
tier.

`CapabilityQualified` означает одновременно: поддерживаемый display mode,
совместимый graphics backend, достаточные texture/format limits, отсутствие
известного blocking driver defect и успешный capability probe. Модель телефона
сама по себе не гарантирует профиль. При `GateP:P1` неподходящий device получает
заранее утверждённый Track A/C либо static/non-live material fallback; при
`GateP:P2` такой fallback считается product-level NO-GO, а не задачей shader
tuning.

---

# 45. Dependency policy

Foundation dependencies pin-ятся.

Для каждой фиксируются:

```text
version
license
upstream commit/range
known gaps
patches
replacement boundary
security-update path
upgrade cost
owner
```

Особенно:

- Dioxus;
- NeoBlitz/upstream stack;
- AnyRender/paint abstraction и конкретный renderer backend;
- wgpu;
- shader tooling;
- raster backend;
- text stack;
- image codecs;
- media adapters;
- plugin sandbox.

Upgrade foundation dependency выполняется compatibility PR.

Build MUST быть reproducible по lockfile/pinned revisions. CI формирует SBOM,
license inventory и shader/toolchain provenance; dependency license и notice
obligations проверяются на совместимость с распространением NeoTavern под
AGPL-3.0. Git dependency без immutable revision запрещена в release build.

Compatibility PR MUST прогонять paint-boundary conformance, shared-device/
sampleable-target probe, display-list golden corpus, device-loss tests и
PERF-01/11/12 subset. Наличие API в документации не заменяет проверку конкретного
Android backend/driver.

Upstream baseline на дату этой редакции: официальный Blitz repository описывает
`blitz-paint` как перевод DOM tree в AnyRender draw commands и Dioxus Native как
wrapper над модульными crates, сам характеризует Blitz как beta/bleeding edge и
предлагает Android builds/examples. Crate documentation также объявляет запись
в `anyrender::PaintScene`. Это обосновывает исследование recording sink, но
**не** доказывает production maturity, готовый backdrop/readable-surface либо
shared-device path. Поэтому последние остаются blocking probe Milestone 0, а не
бумажным предположением.

Android platform documentation отдельно подтверждает: приложение может
запросить высокий frame rate и проверить supported modes, но система вправе
ограничить фактическую частоту из-за power/thermal policy. Поэтому request,
observed mode и renderer deadlines являются разными метриками.

Ссылки baseline:

- [DioxusLabs/Blitz — Architecture](https://github.com/DioxusLabs/blitz/tree/main#architecture)
- [`blitz_paint` crate documentation](https://docs.rs/blitz-paint/latest/blitz_paint/)
- [CSS Positioned Layout — sticky/fixed positioning](https://www.w3.org/TR/css-position-3/)
- [CSS Color — group opacity](https://www.w3.org/TR/css-color-4/#transparency)
- [CSS Pseudo-Elements — highlight painting](https://www.w3.org/TR/css-pseudo-4/#highlight-painting)
- [Firefox APZ — scroll trees, hit testing and async transforms](https://firefox-source-docs.mozilla.org/gfx/AsyncPanZoom.html)
- [Chromium compositor-thread architecture](https://www.chromium.org/developers/design-documents/compositor-thread-architecture/)
- [Android Developers — Optimize refresh rates](https://developer.android.com/games/optimize/display-refresh-rate-change)
- [Android Developers — Load in-app content with WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)

---

# 46. Рекомендуемая структура repository

```text
crates/
├── kernel/
├── product-wire/
├── presentation/
│
├── neo-dioxus-host/
├── neo-blitz-adapter/
├── neo-paint-bridge/
│
├── neo-scene/
│   ├── property-trees/
│   ├── effects/
│   └── validation/
├── neo-compositor/
│   ├── frame/
│   ├── damage/
│   ├── layers/
│   ├── graph/
│   ├── targets/
│   ├── device/
│   ├── telemetry/
│   ├── validation/
│   ├── interop/
│   ├── hit-test/
│   └── text-interaction/
│
├── neo-glass/
│   ├── graph/
│   ├── downsample/
│   ├── blur/
│   ├── material/
│   └── adaptive/
│
├── neo-assets/
├── neo-media/
├── neo-chat-viewport/
│   ├── height-index/
│   ├── predictor/
│   ├── preparation/
│   ├── tiles/
│   ├── anchoring/
│   ├── physics/
│   └── geometry-remap/
│
├── neo-plugin-schema/
├── neo-plugin-ir/
├── neo-plugin-runtime/
├── neo-plugin-compiler/
│
├── neo-platform/
├── neo-platform-android/
├── neo-platform-desktop/
└── neo-platform-ios/

apps/
├── android/
├── desktop/
└── web-react/

tests/
├── conformance/
├── product-scenes/
├── performance/
├── paint-order/
├── property-trees/
├── text-selection/
├── scroll-physics/
├── virtualization/
├── gpu/
├── lifecycle/
├── fuzz/
├── plugins/
└── accessibility/
```

---

# 47. Decision backlog и реальная нумерация ADR

`P00…P04` ниже — **логические decision IDs внутри RFC**, не имена и не номера
repository ADR:

```text
P00 Live-glass product requirement and degraded semantics (Gate P)
P01 Android frame/composition owner (D1)
P02 First-party Android UI runtime (D2)
P03 Single vs dual presentation UI strategy (D3)
P04 Theme/Plugin presentation ABI and current-canon supersession
```

До Gate P decisions имеют статус `Proposed`. Gate P принимает либо отклоняет
P00. P01/P02 остаются `Proposed` до evidence M0; P03/P04 должны быть решены до
соответствующего product migration milestone. Нельзя пометить P01…P04
`Accepted` только ссылкой на этот документ.

По baseline ревью действующая repository sequence занята до `ADR-0048`.
Настоящий ADR MUST:

1. перед созданием просканировать `docs/adr/` на target branch;
2. атомарно взять следующий свободный sequence number (на указанном baseline
   ожидается `ADR-0049`, но это проверяется в PR);
3. следовать repository filename/template/status policy;
4. ссылаться на logical decision ID `P00…P04` в metadata/body;
5. перечислять superseded ADR точными repository номерами.

Файлы `ADR-P00.md`, `ADR-001.md` либо новый параллельный ряд из этого RFC
создавать запрещено.

Следующий список — условные design topics, а не заранее зарезервированные ADR:

```text
T01 Product Wire ownership
T02 Dioxus first-party runtime
T03 NeoBlitz integration boundary
T04 NeoCompositor scope
T05 Standard UI raster backend
T06 120-Hz performance budgets
T07 NeoGlass algorithm and quality tiers
T08 Android IME ownership
T09 NeoPlugin IR and package format
T10 VisualSurface GPU isolation
T11 Media sampleable-frame path
T12 ExternalSurface policy
T13 Device/surface recovery
T14 Dependency/fork policy
T15 Web strategy
T16 iOS strategy
T17 Ordered paint bridge and GlassSurface boundary
T18 Shared GPU device and raster interop
T19 Virtual range prediction, tiles and overscan-miss fallback
T20 Async scroll ack, anchoring and hit-test consistency
T21 Threading, queues and frame scheduling
T22 Memory budget profiles and degraded paths
T23 Spatial/scroll property tree, sticky/fixed and async hit testing
T24 Effect tree, group compositing and backdrop roots
T25 Interaction-ready text and highlight painting
T26 Geometry epochs and fling-continuous remapping
```

Topics MAY быть объединены в меньшее число repository ADR, если decisions
принимаются и откатываются вместе. Нельзя заранее создать 26 пустых ADR ради
совпадения со списком.

Каждый фактический ADR содержит:

- context;
- decision;
- alternatives;
- evidence;
- benchmarks;
- owner;
- rollback;
- revisit trigger.

Фактический ADR для P04 дополнительно MUST перечислять конкретные действующие
repository ADR и public contracts, которые он supersede-ит, а также migration
window. Номера из этого proposal не подменяют фактическую нумерацию репозитория.

## 47.1. Program ownership, capacity и sequencing

Presentation-engine migration является отдельной программой, а не подзадачей
обычной оптимизации APK либо побочным deliverable другой архитектурной миграции.
До D1/D2/D3 GO утверждаются:

```text
single accountable program owner
owners for compositor, Android host and upstream integration
owners for Web parity, Theme SDK, Plugin SDK, i18n and accessibility
device-lab/benchmark capacity
upstream/rebase maintenance budget
product/design/QA acceptance capacity
rollback and support ownership
```

Roadmap MUST содержать dependency/capacity map с другими крупными инициативами
(включая M7/Fastify/`legacyRaw()` removal либо иные Kernel/server/
legacy-removal программы, если они всё ещё активны). Если одни и те же
специалисты критичны двум программам, они либо выполняются
последовательно, либо получают явно утверждённую дополнительную capacity.
Одновременное планирование без named owners считается blocker.

До Milestone 0 разрешены только measurement changes из bounded M-1
раздела 0.3.1 за feature flag в неproduction target. Уже существующий
incidental technical artifact может быть только остановлен и учтён по
разделу 0.3.2; новый compositor prototype до Gate P не начинается.
Массовая миграция UI, Theme SDK v2 и Plugin SDK rewrite до GO запрещены:
они не улучшают ответ на kill-вопрос и увеличивают sunk cost.

---

# 48. Milestone 0 — paint seam и shared-device kill probe

Normative Milestone 0 начинается только после `GateP:P1` либо
`GateP:P2`. Это timeboxed feasibility probe, а не NeoCompositor v1 и не
миграция chat route. Pre-gate run обрабатывается только по разделу
0.3.2 и не считается входом в milestone.

Он состоит из трёх последовательных work packages:

```text
M0-D1a: static host-authored scene → shared wgpu device → two glass barriers
M0-D1b: add moving sampleable texture → dynamic backdrop correctness
M0-D2:  real Dioxus → pinned Blitz path → тот же staged scene contract
```

`M0-D1b` запрещено начинать до `GateP:P1/P2` и PASS M0-D1a.
`M0-D2` проверяет только
Dioxus/Blitz как UI producer и также сначала воспроизводит static scene. Провал
M0-D2 не может автоматически объявлять M0-D1a/b проваленными.

### Verdict vocabulary

- `NOT_ENTERED` — entry gate milestone не пройден;
- `NOT_STARTED` — entry gate пройден, но work package не начат;
- `BLOCKED` — прогон дал partial evidence, но отсутствует mandatory
  artifact, environment или reproducibility record; это не `FAIL`;
- `ENVIRONMENT_BLOCKED` — только environment-dependent часть не может
  быть оценена; остальные verdict сохраняются отдельно;
- `PASS` — все exit criteria подтверждены полным evidence bundle;
- `FAIL` — хотя бы один exit criterion воспроизводимо нарушен.

Runner verdict и program verdict хранятся раздельно. Например, pre-gate
runner MAY вернуть `BLOCKED`, пока канонический M0 имеет
`NOT_ENTERED`. Один не переписывает другой.

### Stage 1 — M0-D1a static scene

На одном физическом Android reference воспроизводится минимальная статическая
детерминированная сцена:

```text
static wallpaper/image chunk
→ live GlassSurface A
→ ordinary shaped text and vector UI
→ overlapping live GlassSurface B
→ foreground overlay
```

Цель D1a — доказать device/queue ownership, ordered barriers, sampleable
intermediate и ROI без отдельной media/animation pipeline. Первый PASS не
требует moving texture, scroll, input либо 120-Hz percentile gate.

### Stage 2 — M0-D1b dynamic sampling

Только после D1a PASS в сцену между text и GlassSurface B добавляется один
synthetic moving sampleable texture:

```text
static wallpaper/image chunk
→ live GlassSurface A
→ ordinary shaped text and vector UI
→ synthetic moving checker/gradient texture
→ overlapping live GlassSurface B
→ foreground overlay
```

Texture не требует decoder, media framework, plugin runtime или user input. Она
движется по детерминированной compositor transform, чтобы проверить damage,
fence/lifetime и то, что второй glass sample-ит текущий, а не stale frame.

### Stage 3 — M0-D2 producer seam

Для M0-D2 geometry/text static stage обязаны прийти из реального Dioxus
VirtualDom и pinned Blitz layout/paint traversal. После static seam PASS
добавляется тот же synthetic moving texture. Разрешён один bounded opacity/clip
scope для проверки, что barrier не уничтожает ancestor effect. Запрещено
подменять путь mock display list после layout.

В Milestone 0 **не входят** 10k chat, streaming Markdown, virtualization,
sticky/fixed/nested scroll, cross-tile selection, full IME/TalkBack, device-loss
recovery и production plugin system. Их тесты остаются в PERF corpus и переходят
в Milestone B/C.

### Required evidence

```text
pinned source revisions and exact patch set
APK SHA-256 and build/runner configuration
real Android production graphics backend
GPU capture with pass/resource order
single wgpu device/queue ownership trace
CPU readback and cross-device copy counters
display-list/effect-boundary golden output
per-pass CPU/GPU duration and allocated bytes
requested and observed refresh-mode telemetry
100-frame static resource/lifetime run for D1a
1000-frame dynamic resource/lifetime run for D1b
one upstream upgrade/rebase experiment or measured patch isolation
```

Git commit не обязан создаваться до verdict, но source state MUST быть
неизменяемо воспроизводим. Для dirty tree evidence bundle включает
base commit, полный binary diff/patch, lockfile/submodule revisions, diff hash и
APK SHA-256. Отсутствие и commit, и такого bundle даёт `BLOCKED`.

120 Hz записывается как evidence, но full 99%/thermal/10k release gate здесь не
требуется. Если ОС не активировала 120-Hz mode, результат refresh-rate части
`ENVIRONMENT_BLOCKED`; paint/shared-device результат всё равно валиден.

### Exit M0-D1a

- прогон воспроизведён на физическом Android reference; AVD даёт
  partial evidence, но не заменяет телефон;
- два glass pass читают backdrop в правильной paint position;
- обычный static UI сохраняет требуемое interleaving;
- raster и compositor работают на одном production device/queue;
- отсутствуют CPU readback, cross-device texture copy и предварительный flatten
  всей сцены в единственную final texture;
- маленький glass ROI не требует постоянного full-screen multipass;
- GPU capture показывает pass/resource timeline, accumulator reads в обеих
  barrier positions и bounded static resource lifetime/fences;
- результат воспроизводим из зафиксированного prototype target.

### Exit M0-D1b

- synthetic texture движется без UI/layout rebuild;
- GlassSurface B sample-ит content текущего допустимого frame generation, а не
  замороженный pre-motion snapshot;
- damage/ROI следует за движением и остаётся bounded;
- texture ready token/fence не блокирует render thread и не используется после
  lifetime completion;
- 1000-frame run не показывает leak, unbounded target growth или stale sampling;
- M0-D1 считается PASS только после PASS D1a и D1b.

### Exit M0-D2

- static scene, а затем staged dynamic scene построены реальным Dioxus → Blitz
  path;
- paint boundary реализована публичным recording sink, маленьким upstreamable
  hook либо другим заранее описанным bounded extension point;
- canonical paint order и bounded ancestor opacity/clip scope сохраняются;
- patch set проходит rebase experiment и не является foundational private fork;
- missing upstream capabilities и estimated replacement surface перечислены, а
  не скрыты за будущими ADR.

### Evidence snapshot 2026-08-17 (non-normative)

Snapshot фиксирует факты, но не повышает program verdict:

| Object | Status | Reason |
|---|---|---|
| `Gate P` | `UNDECIDED` | нет валидного M-1; lab shortage ≠ `GateP:P0`; owner не подписал |
| normative M0 | `NOT_ENTERED` | Gate P не пройден |
| morning AVD M-1 A/A0/B | `MEASURED` emulator-only | 60 Hz; не RFC device set |
| evening AVD M-1 A/A0/B | `INVALID_FOR_COMPARISON` | другой APK и другие экраны |
| physical M-1 device set | `BLOCKED` | none attached |
| runner D1a desktop Vulkan | `PRE-GATE / BLOCKED` | API timeline; нет Android production backend / GPU capture |
| evening AVD D1a (installed APK) | `BLOCKED / NON-ADMISSIBLE` | `.so` ≠ current source bundle |
| unsigned Gate P draft | `docs/rfc/gate-p-decision-draft.md` | `decision`/`owner`/`date` empty; not a signature |
| `M0-D1b` | `NOT_STARTED` | D1a не PASS; Gate P не пройден |
| `M0-D2` | `NOT_STARTED` | normative M0 не начат |
| `D1=Track D GO` | `NOT_GRANTED` | Gate P и mandatory M0 outcomes отсутствуют |

Снятое partial evidence:

```text
environment=AVD API 36.1; -gpu host; GLES 3.1 via NVIDIA translator
gpu_ran=true
backend=Gl
software=false
devices=1
readbacks=0
xdev=0
roi_copies=200
raster=400
glass=200
frames=100
ran_on_android=true
capture=false
probe_changes_commit=absent
immutable_source_bundle=helper_v3;_unrelated_tz_excluded;_apk_linkage=UNBOUND;_explicit_bind_apk
api_timeline=desktop_vulkan_2026-08-17_evening;_not_agi_renderdoc
runner_verdict=BLOCKED
evening_avd_d1a=BLOCKED_NON_ADMISSIBLE
```

Evening desktop Vulkan re-run (same host RTX 3060, rustc 1.97.1) recorded the
golden API timeline
`clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,roi:2,glass:2,raster,blit`
with `acc_bytes=774144`. That is a host-recorded wgpu command log. It is
**not** an AGI/RenderDoc GPU capture and does **not** raise `android_gpu_capture`.
Verdict stayed `BLOCKED` (`ran_on_android=false`).

Счётчики согласуются с expected 100-frame workload: 2 ROI copy, 4 raster
operation и 2 glass pass на frame. Они подтверждают Android GL execution
на одном logical device без зарегистрированного readback/cross-device
copy, но не доказывают pass/resource order, accumulator identity или скрытую
копию.

Emulator-specific policy:

- `ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER` MAY использоваться только
  в instrumented probe build для явно зафиксированного AVD;
- Goldfish/GFXStream Vulkan configurations, падающие в
  `vulkan.ranchu.so` на первом Vello `vkQueueSubmit`, MAY пропускаться
  в emulator matrix только с adapter identity и logged skip reason;
- `-gpu swiftshader_indirect` с GLES 3.0 без required compute не считается
  viable Vello environment; для этого AVD допустим `-gpu host` с GLES 3.1;
- эти exceptions MUST NOT попадать в production build и MUST NOT
  распространяться на physical Vulkan adapters; на телефоне Vulkan
  остаётся preferred backend.

Чтобы довести этот artifact до admissible D1a evidence после
`GateP:P1/P2`, нужны: immutable source bundle, GPU capture с двумя
accumulator reads в barrier positions и воспроизводимый прогон на физическом
Android reference. До этого D1b не начинается.

### Scoped outcomes

| Результат | Решение |
|---|---|
| `GateP=UNDECIDED`, есть pre-gate run | сохранить artifacts, остановить scope; M0 `NOT_ENTERED`, D1b не начинать |
| M0-D1a FAIL | остановить D1b; Track D compositor — NO-GO |
| M0-D1a PASS, M0-D1b FAIL | static barrier доказан, dynamic live glass — NO-GO; вернуться к A/B/C либо пересмотреть Gate P |
| M0-D1a/b PASS, M0-D2 FAIL | D1 остаётся кандидатом; Dioxus/Blitz — NO-GO, проверить другой producer/substrate |
| M0-D1a/b PASS, M0-D2 PASS | финализировать TrackComparison; только затем можно принять D1/D2, D3 всё ещё отдельно |
| Evidence ambiguous | продлить только конкретный probe с новым deadline; implementation milestones не начинать |

### NO-GO triggers

- корректный backdrop возможен только после flatten final scene;
- требуются readback, cross-device synchronization/copy либо private GPU handle
  без устойчивого ownership contract;
- GlassSurface требует foundational fork paint/layout/text internals;
- upstream renderer не принимает shared device/targets на production Android;
- effect boundary теряет paint order либо применяет group effect к частям
  семантически неверно;
- bounded ROI невозможно получить без постоянного full-resolution full-screen
  pipeline;
- prototype работает только на desktop/mock backend;
- результат нельзя воспроизвести на pinned revision.

NO-GO не отменяет Product Wire либо Rust Kernel. Он отменяет только указанный
track/producer и обязан привести к ADR outcome, а не к бесконечному prototype.

---

# 49. Milestone A — Product boundary

Entry: Gate P пройден, scoped M0 outcomes опубликованы, D1/D2 имеют явный
статус. Dioxus deliverables ниже активны только при `D2=Dioxus`.

Deliverables:

- Product Wire;
- canonical view models;
- typed commands;
- Dioxus presentation shell;
- React Web adapter;
- fixture recorder;
- generation/backpressure tests;
- `PresentationCompatibilityMatrix` baseline;
- inventory Theme SDK/Plugin SDK/i18n/legacy extension contracts;
- accepted D3 ownership/capacity plan либо явно ограниченный single-route spike.

Exit:

- Rust Kernel является единственным durable product authority;
- React Web продолжает работать;
- Dioxus shell получает тот же Product Wire;
- streaming measured;
- ни один действующий presentation contract не считается молча superseded;
- Android/Web feature ownership и capability gaps утверждены.

---

# 50. Milestone B — NeoCompositor

Entry: M0-D1a/b PASS, финальный TrackComparison и D1 GO. Dioxus-specific work
требует также M0-D2 PASS/D2 GO.

Deliverables:

- ordered NeoDisplayList/paint bridge;
- GlassSurface render boundary;
- NeoScene;
- FrameTransaction;
- layer cache;
- scroll fast path;
- animation fast path;
- damage;
- target pool;
- NeoGlass;
- device/surface recovery;
- GPU telemetry;
- shared-device raster interop;
- height index/range predictor/tile cache;
- overscan-miss fallback;
- async scroll ack and spatial hit-test transform;
- spatial/scroll/clip/effect property trees;
- sticky/fixed compositor sampling and nested scroll handoff;
- balanced effect scopes/backdrop roots;
- interaction-ready text/selection ops;
- geometry epochs and fling-continuous remap.

Exit:

- PERF-01…PERF-05 и PERF-11…PERF-22 проходят;
- device-loss injection проходит;
- no unbounded GPU queues;
- no product-state loss;
- full 120-Hz release budgets откалиброваны, но product cutover ещё не объявлен;
- update/rebase cost выбранного upstream stack повторно измерен;
- все PERF failures имеют owner и не переносятся молча в Milestone C.

---

# 51. Milestone C — Android product slice

Entry: D3, Theme/Plugin ABI policy, localization contract, staffing и rollback
приняты отдельными решениями. Один успешный renderer benchmark недостаточен.

Deliverables:

- full chat route;
- Gboard composer;
- 10k virtualization;
- Markdown;
- images;
- NeoGlass;
- media;
- accessibility;
- lifecycle;
- safe mode;
- localization catalog integration, RTL и pseudolocales;
- выбранный Theme SDK v2/FixedShell contract;
- plugin/legacy WebSurface capability matrix;
- parity fixtures для критических Android/Web journeys;
- migration, staged rollout и rollback telemetry.

Exit:

- critical journeys migrated;
- no WebView main renderer;
- high-refresh performance gate проходит;
- TalkBack/Gboard corpus проходит;
- lifecycle recovery проходит;
- i18n/RTL corpus проходит;
- product owner принял все `DEFERRED/REMOVED/CONTAINED` capability gaps;
- themes/plugins/legacy behavior описаны пользователю без ложного обещания
  parity;
- rollback возвращает действующий backend без миграции durable Kernel state.

---

# 52. Milestone D — Plugin platform

Deliverables:

- NeoPluginCompiler;
- NeoPlugin IR;
- Plugin:P0/P1;
- Canvas2D;
- VisualSurface;
- WebSurface;
- quotas;
- permissions;
- crash isolation;
- update/revoke;

Exit:

- form plugin;
- headless agent;
- Live2D-like plugin;
- legacy Web plugin

работают через различные bounded paths.

Дополнительно проходит migration corpus репрезентативных существующих plugins;
отдельно публикуется доля `PARITY/ADAPTED/CONTAINED/DEFERRED/REMOVED`. Один
демонстрационный form plugin не доказывает совместимость ecosystem.

---

# 53. Milestone E — Platform expansion

После Android GO:

1. Desktop;
2. iOS proof;
3. optional Web renderer reconsideration.

Platform expansion не меняет Product Wire либо durable state format.

---

# 54. Definition of Done — NeoCompositor v1

- [ ] retained NeoScene;
- [ ] ordered NeoDisplayList сохраняет upstream paint order;
- [ ] typed GlassSurface/Media/Plugin/External boundaries;
- [ ] обычные UI chunks существуют до и после glass barrier;
- [ ] shared-device render-to-sampleable-target без CPU readback/cross-device copy;
- [ ] pass graph validation и last-known-good fallback;
- [ ] balanced effect scopes и explicit backdrop roots;
- [ ] group opacity/filter/mask не теряются на glass barrier;
- [ ] per-node spatial/scroll/clip/effect property trees;
- [ ] sticky/fixed/nested-scroll transforms sample-ятся на compositor;
- [ ] front-to-back hit-test использует current per-item world transform;
- [ ] immutable FrameTransaction;
- [ ] bounded UI→render mailbox;
- [ ] compositor-only scroll;
- [ ] compositor animation;
- [ ] damage tracking;
- [ ] occlusion;
- [ ] render-target pool;
- [ ] live header glass;
- [ ] live composer glass;
- [ ] three-glass scene;
- [ ] nested glass supported corpus;
- [ ] adaptive downsample;
- [ ] sampleable image;
- [ ] sampleable video;
- [ ] sampleable VisualSurface;
- [ ] bounded uploads;
- [ ] device epoch;
- [ ] device loss recovery;
- [ ] surface resize/loss recovery;
- [ ] color/alpha golden tests;
- [ ] GPU timing telemetry;
- [ ] memory-pressure handling;
- [ ] bounded scroll tiles и device-limit validation;
- [ ] height index/range predictor/preparation pipeline;
- [ ] overscan miss не создаёт blank frame/render-thread wait;
- [ ] async scroll ack и latest-transform hit-test;
- [ ] interaction-ready text и cross-tile selection без drag-time shaping;
- [ ] selection/caret/handles используют общий property snapshot;
- [ ] geometry epochs/prefix remap сохраняют fling position/velocity;
- [ ] bounded geometry debt и deterministic bounds retarget;
- [ ] non-sampleable surface/effect incompatibility валидируется;
- [ ] origin rebase для long-coordinate list;
- [ ] safe-mode escape.

---

# 55. Definition of Done — Mobile 120 Hz

На утверждённом `120HZ_REFERENCE`:

- [ ] 10k-message chat работает;
- [ ] continuous scrolling работает;
- [ ] header glass остаётся live;
- [ ] composer glass остаётся live;
- [ ] streaming не создаёт Product Wire backlog;
- [ ] image decoding не создаёт scroll jank;
- [ ] compositor-only frames не запускают Dioxus reconciliation;
- [ ] compositor-only frames не запускают full layout;
- [ ] prepared-range predictor срабатывает до overscan edge;
- [ ] штатный fixture не показывает visible placeholders после warm-up;
- [ ] adversarial fling имеет zero blank frames и проходит fallback budget;
- [ ] direction reversal/teleport не попадает в stale item;
- [ ] sticky/fixed overlap не создаёт click-through;
- [ ] nested scroll latch/handoff не удваивает delta;
- [ ] GlassSurface внутри opacity/clip/transform проходит golden corpus;
- [ ] selection через несколько tiles не имеет seams/color artifacts;
- [ ] exact-height commit во время fling сохраняет C0/C1 continuity;
- [ ] queue/item/byte caps и high-water marks проверены;
- [ ] frame/deadline metrics проходят утверждённые budgets;
- [ ] input-to-present измеряется;
- [ ] 10-minute thermal fixture проходит;
- [ ] Gboard остаётся корректным при scrolling/inset animation;
- [ ] TalkBack остаётся работоспособным;
- [ ] background/resume не создаёт frame catch-up;
- [ ] device/surface loss не теряет draft/chat state.

---

# 56. Definition of Done — Track D production adoption

Track D не получает статус production-ready, пока D1/D2/D3 и superseding ADR
не приняты. После этого одновременно выполняется:

```text
Rust Kernel remains product authority
+
approved D2 producer owns first-party reconciliation
+
approved bounded substrate owns generic UI mechanics
+
NeoPaintBridge preserves ordered effect boundaries
+
property trees preserve async spatial/effect semantics
+
NeoCompositor owns high-performance composition
+
NeoGlass provides real live backdrop
+
NeoPlugin IR remains isolated portable plugin ABI
+
Web remains independently deployable
+
Android passes real-device 120-Hz acceptance
+
Theme/Plugin presentation ABI has an accepted migration policy
+
i18n/RTL/a11y parity corpus passes
+
staffing, upstream maintenance and rollback have named owners
```

И при этом в NeoTavern отсутствуют собственные:

```text
Unicode shaper
generic glyph raster engine
browser DOM/CSS runtime
general Gesture Arena
accessibility framework
React-to-native compiler
```

Дополнительно:

- `PresentationCompatibilityMatrix` не содержит неутверждённых critical gaps;
- legacy WebSurface journeys имеют product acceptance и честные ограничения;
- safe mode остаётся bounded recovery UI, а не скрытым третьим product shell;
- фактическая стоимость двух presentation UI включена в roadmap;
- сравнительный отчёт показывает, почему Track A/B/C не выполняют Gate P
  дешевле;
- proposal переведён в канон только после merge утверждающих ADR, не наоборот.

---

# 57. Главный принцип разработки

> **NeoTavern владеет только тем уровнем renderer stack, который непосредственно необходим для visual identity и 120-Hz performance.**

Если задача может быть решена выбранным upstream UI producer, paint substrate
либо platform service без нарушения performance contract — она не
переписывается.

Если generic renderer препятствует 120-Hz live-glass path — заменяется или обходится **только соответствующий слой**.

Не допускается превращать локальный performance gap в оправдание для переписывания text, layout, IME, accessibility и browser semantics.

---

# 58. Итоговая формула proposal

```text
Track D candidate
=
Rust Runtime Kernel
+
versioned Product Wire
+
approved first-party presentation runtime (D2; Dioxus is candidate)
+
bounded paint/layout substrate (NeoBlitz is candidate)
+
ordered paint bridge with explicit effect boundaries
+
spatial/scroll/clip/effect property trees
+
retained NeoScene
+
specialized NeoCompositor/wgpu
+
NeoGlass
+
NeoMedia
+
NeoPlugin IR/runtime
+
independent React Web profile
```

Но решение программы имеет вид:

```text
Gate P
→ cheapest passing Track A/B/C/D
→ independent D1 frame-owner decision
→ independent D2 UI-producer decision
→ independent D3 single/dual-UI decision
→ product parity + staffing + migration gates
→ production implementation
```

Для длинного chat hot path фактически состоит из двух параллельных контуров:

```text
present loop:
input → per-node property-tree sample → prepared/fallback/interactive text ops
→ effect scopes/glass → present

producer loop:
velocity/deadline prediction → bounded materialize/layout/shape/raster
→ atomic coverage/property-tree/geometry-epoch commit
```

Present loop никогда не ждёт producer loop.

Целевой mobile hot path:

```text
input
→ compositor scroll/animation state
→ per-node sticky/fixed/scroll transforms
→ ordered retained chunks, selection ops and prepared tiles
→ damaged backdrop ROI
→ adaptive live glass
→ final GPU composite
→ present
```

а не:

```text
input
→ product state
→ Dioxus rebuild
→ complete layout
→ complete raster
→ full-screen blur
→ present
```

**Proposal считается успешным, если он дешёво даёт честный GO/NO-GO. Track D
считается успешным только тогда, когда продукт контролирует необходимые mobile
frames и live-glass semantics при принятой цене второго presentation ABI,
сохранив минимально возможную площадь собственного engine infrastructure.**
