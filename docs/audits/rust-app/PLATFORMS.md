# Платформы, ввод и нативный рендер

Дата: 2026-10-04. Срез аудита: presentation adapters, Android canary, desktop native host, vendor seam и граница упакованного Tauri. Это отчёт об актуальной реализации, а не выполненные исправления. Продуктовый код, API, схемы данных и утверждённый стек не изменены.

## Статусы и границы доказательств

- `RUNTIME_CONFIRMED` — эффект наблюдался на свежей сборке с сохранённым артефактом.
- `STATIC_CONFIRMED` — разрыв подтверждён обработчиком и его вызывающим путём; физическое воспроизведение не засчитывается.
- `DOCUMENTED_LIMITATION` — явно отложенная возможность или ограничение; это не обещание готовой функции.
- `RISK_NOT_REPRODUCED` — участок требует целевой проверки; авария или утечка не доказана.
- `NOT_RUN` — необходимого окружения либо физического прогона нет.

Свежая Windows native release-сборка прошла; Vulkan captures доступны в артефактах аудита (локальный каталог build/rust-audit/2026-10-04-1b407fc/). Существующие native host feature tests прошли. Captures подтверждают рендер проверенных кадров, но не frame pacing, физическую клавиатуру или Android. Неудачный scripted tap не считается подтверждением ошибки действия без проверки координаты и обоих hit paths.

Android: `adb` не показал устройства. Gboard, TalkBack, SurfaceView, rotation, insets и GPU recovery на устройстве — `NOT_RUN`. macOS/Linux runtime — `NOT_RUN`. Упакованный Tauri runtime — `NOT_RUN` в этом срезе; сборка пакета и kernel smoke не равны ручной проверке пользовательских сценариев. Общие итоговые команды и их результаты находятся в [протоколе проверок](VERIFICATION.md).

### Разделение режимов

| Режим                   | Провод и оболочка                                                  | Что он доказывает                                                                              |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `neocompositor-desktop` | `FakeWire`, winit, Dioxus/Blitz/Vello                              | Нативный presentation на тестовых данных; сохранность пользовательской библиотеки не проверяет |
| `neocompositor-kernel`  | `KernelProductWire`, тот же desktop host                           | Настоящие wire operations и SQLite, плюс desktop presentation                                  |
| Android canary          | `JniProductWire`, Kotlin host, отдельный `GpuHost`                 | Требует физического runtime; desktop captures не заменяют эту проверку                         |
| Упакованный Tauri       | React/WebView; Kernel Preview или legacy sidecar по матрице режима | Самостоятельный продуктовый путь; это не Dioxus/Blitz/Vello                                    |

Источники: `presentation-chat/src/bin/neocompositor-desktop.rs` задаёт `wire: None`; `presentation-kernel-wire/src/bin/neocompositor-kernel.rs` инжектирует настоящий kernel; `apps/desktop/src-tauri/tauri.conf.json` использует `../../web/dist`; `apps/desktop/src-tauri/src/lib.rs` создаёт `WebviewWindowBuilder`. Release по умолчанию использует sidecar, nightly/debug — Kernel; явные overrides разрешаются согласно ADR-0038. Успешные kernel/JNI transport tests не означают, что Android compositor, IME или TalkBack работоспособны.

## Системные причины накопления обходных решений

Проблема не сводится к clipping. В текущей реализации несколько подсистем имеют общий формат данных, но различаются владельцем жизненного цикла и способом исполнения. Локальные визуальные исправления не закрывают эти границы.

1. **Общий producer не означает общий presentation host.** Desktop сохраняет VDOM, делает `open_or_refresh`, `paint_split` и overscan; Android cold-opens документ и растеризует одну полную сцену. У них разные input, clipboard/export и stream loops. Утверждение о byte-identical поведении скрывает необходимость отдельной проверки платформы. См. PL-L02.
2. **Нарисованное поле не является редактором.** Desktop вручную дописывает строку, Android сохранил невидимый `EditText` без связи с видимым полем. Нет общего события field focus, caret/selection/composition и подтверждения его исполнения платформой. Добавление ещё одного setter на конкретный экран увеличивает этот разрыв. См. PL-01, PL-03, PL-06.
3. **У стрима несколько независимых драйверов.** Rust Send выполняется внутри compositor callback, Kotlin IME Send запускает bounded polling отдельно, а старт JNI может ждать первое событие синхронно. Один путь создаёт run без polling, другой заканчивает polling по счётчику. См. PL-04, PL-05.
4. **Запись возможности расходится с её исполнением.** Glass markers и pass graph существуют, но product VelloSink игнорирует filters/backdrop filters. Число markers не подтверждает визуальную возможность. См. PL-L01.
5. **Некоторые fallback меняют инварианты.** Возврат к image overlay спасает raster на проблемном драйвере, но теряет общий paint order и modal/clip semantics. Это допустимый документированный degraded mode, если интерфейс и диагностика сообщают ограничение и он проверяется отдельно. Его нельзя считать полной parity. См. PL-L04.

Рекомендуемый порядок исправления: определить общие input/semantics и stream lifecycle инварианты; связать платформенные capabilities с ними; обеспечить одинаковые contract tests адаптеров; затем исправлять геометрию и оптимизировать кадры. Это не требует смены утверждённого стека. Не каждый fallback вреден: sidecar release default, явный canary kill-switch и last-known-good recovery являются принятыми границами, пока они честно обозначены.

## Каталог дефектов

### PL-01 — P1 — Неполная модель ввода desktop

- **Статус / хосты:** `STATIC_CONFIRMED`; native desktop с FakeWire и Kernel. Физическая OS-клавиатура и IME — `NOT_RUN`.
- **Симптом:** append-only ввод; Enter, Tab, Escape, arrows, Home/End, Delete, selection, clipboard shortcuts и IME composition не обслуживаются.
- **Ожидается:** редактирование в позиции caret, выделение, перенос строки и клавиатурная навигация по полям/действиям.
- **Координаты / доказательство:** `crates/presentation-chat/src/desktop_host/frame.rs:612–624` обрабатывает только `Key::Character` и Backspace, остальные keys игнорирует. `desktop_host/text.rs:20–29` делает `format!("{current}{ch}")`; `text.rs:294` удаляет последний scalar. Нет маршрутизации `WindowEvent::Ime` и modifiers в editor.
- **Воспроизведение:** focus composer, ввести `abc`, Left, `X`; путь обработчика даёт `abcX`. Проверить Enter и Ctrl+V отдельно: modifiers не учитываются, вставка clipboard отсутствует. CLI `--type` проверяет setter, а не OS keyboard integration.
- **Причина:** ручные draft setters используются вместо editor input model.
- **Исправление / зависимости:** общий field input bridge с stable IDs, caret/selection, grapheme deletion и composition; clipboard — capability хоста. Согласовать с PL-03/06 до расширения списка отдельных setters.
- **Приёмка:** реальные middle insertion/selection replacement, Ctrl+A/C/X/V, multiline, emoji deletion, Tab/Shift+Tab/Escape и IME commit/preedit; результат совпадает на FakeWire/Kernel и сохраняется корректно.

### PL-02 — P1 — Содержимое черновиков попадает в stderr

- **Статус / хосты:** `RUNTIME_CONFIRMED`; native desktop. Реальный ввод выполнен CLI injection, физическая клавиатура не проверена.
- **Симптом:** полный composer и другие поля журналируются на каждый символ без opt-in.
- **Ожидается:** диагностические метаданные без пользовательского текста.
- **Координаты:** `desktop_host/text.rs:29`, `:35`, `:41`, `:95`, `:161`, `:179`, `:219` и соседние ветки.
- **Доказательство:** native-live-send.native.log (локальный каталог build/rust-audit/2026-10-04-1b407fc/) содержит возрастающие префиксы и `composer="AUDIT_INPUT_MARKER"` на строке 37; логирование не требует отдельного opt-in.
- **Воспроизведение:** свежий native host, redirected stderr, focus composer, `--type AUDIT_INPUT_MARKER`; искать marker и префиксы в логе. Аналогичные ветки существуют для search/edit/character drafts.
- **Причина:** отладочные payload logs встроены в обычный input path. Повторение префиксов дополнительно даёт квадратичный объём логов длинной строки.
- **Исправление / зависимости:** убрать payload logs; оставлять field ID, длину и код операции. Независимое исправление до расширения native input.
- **Приёмка:** уникальные маркеры из composer/edit/search отсутствуют в stderr и diagnostic export; отдельные typed символы также не собираются в текст.

### PL-03 — P1 — Android IME не связан с видимыми полями

- **Статус / хосты:** `STATIC_CONFIRMED`; Android canary. Показ Gboard и composition — `NOT_RUN`.
- **Симптом:** visible compositor composer/search/edit поля не имеют платформенного focus/InputConnection handoff.
- **Ожидается:** tap поля выбирает его stable ID, открывает IME и отображает актуальные caret/selection/composition.
- **Координаты / доказательство:** `PresentationChatActivity.kt:143–178` создаёт единственный bridge с `alpha=0f`, `visibility=View.INVISIBLE`, размером 1×1. В Activity нет `requestFocus()`. `:202–204` оставляет только этот bridge. `android_surface.rs:1192–1223` захватывает actions или scroll; обратной команды Kotlin focus нет. `syncChatOverlay` не прикрепляет поля.
- **Воспроизведение:** физический canary, tap composer/search/message edit/character editor; наблюдать focus, IME, caret и соответствующий draft snapshot. До устройства вывод ограничен отсутствием wiring в коде.
- **Причина:** удаление native overlay без замены на field-aware platform bridge.
- **Исправление / зависимости:** общий input model PL-01; focusable Android bridge, управляемый frame field ID, а не фиктивным composer для всех полей.
- **Приёмка:** Gboard commit, composition, selection и deletion изменяют выбранное поле; IME/caret относятся к одному snapshot; смена panel/chat не записывает ввод в прежнее поле.

### PL-04 — P1 — Разные Send paths не имеют общего stream lifecycle

- **Статус / хосты:** `STATIC_CONFIRMED`; Android canary. Устройство — `NOT_RUN`.
- **Симптом:** visible Rust Send стартует run без stream polling; Kotlin poll burst заканчивается по счётчику даже при продолжающемся run.
- **Ожидается:** все Send entrypoints подписаны до terminal/cancel/unsubscribe; окончание burst не означает окончание run.
- **Координаты / доказательство:** `android_jni.rs:607–610` вызывает `session.send(None)` без poll/pump. `PresentationChatActivity.kt:603–608`, `:628–636` только вызывают `presentFrame`. Отдельный `pollStream` (`android_jni.rs:448–462`) используется Kotlin `pollStreamingBounded`; `Activity:703`, `:711` ограничивают его 40 polls. Completion `:754–770` объявляет stream_end, даже если snapshot ещё streaming.
- **Воспроизведение:** mock provider с задержками token events; Send из видимого Rust UI; сравнить durable event log и visible snapshot. Отдельно через IME Send получить больше 40 timeout/event polls и проверить отсутствие terminal при объявленном окончании.
- **Причина:** UI action dispatch и Kotlin polling владеют разными частями lifecycle без общего владельца.
- **Исправление / зависимости:** единый subscription driver; bounded work за burst с re-arm до terminal, lifecycle token и explicit unsubscribe. Связано с PL-05 и PL-R02.
- **Приёмка:** visible Send и IME Send одинаково доставляют события; медленная генерация доходит до terminal без refresh; cancel немедленен; route change отписывается без отмены durable run.

### PL-05 — P1 — Stream start блокирует Android compositor

- **Статус / хосты:** `STATIC_CONFIRMED`; Android canary. Физическое измерение stalls — `NOT_RUN`.
- **Симптом:** Send/Regenerate на compositor thread могут ждать первое событие до 1,6 секунды плюс dispatch.
- **Ожидается:** compositor не ждёт provider token и продолжает present/input/cancel.
- **Координаты / доказательство:** `JniProductWire::start_stream`, `android_jni.rs:190–216`, выполняет до `32 × wait_native(..., 50)`. Visible Send/Regenerate вызываются внутри `presentFrame:592–641`, запущенного с compositor handler (`Activity:603`).
- **Воспроизведение:** mock transport задерживает первое событие на 2 секунды; tap Send; записать present timestamps и cancellation latency. 1,6 секунды — статический предел wait loop, не измеренный frame result.
- **Причина:** поиск stream key/первого event выполняется синхронно в rendering callback.
- **Исправление / зависимости:** быстрый stream-start handshake, ожидание событий вне compositor, bounded delivery queue; единый lifecycle PL-04.
- **Приёмка:** задержка первого token не останавливает scroll/present/cancel; старт возвращает handle независимо от готовности token; slow-provider trace укладывается в согласованный frame budget.

### PL-06 — P1 — Android accessibility не получает дерево UI

- **Статус / хосты:** `STATIC_CONFIRMED`; Android canary. Реальный TalkBack — `NOT_RUN`.
- **Симптом:** сообщения, кнопки и поля нарисованы, но отсутствуют virtual accessibility descendants. Scroll forward отвечает success без движения.
- **Ожидается:** localized semantic tree с bounds/actions/stable IDs и сохранением фокуса при virtualized updates.
- **Координаты / доказательство:** `Activity:202–204`, `:891–931`: minimal SurfaceView delegate, без `AccessibilityNodeProvider`/`ExploreByTouchHelper` или export Rust semantics. `:917–924` вызывает prepend только backward; forward просто возвращает true.
- **Воспроизведение:** TalkBack исследует сообщения, action toolbar и панель; затем выполняет scroll forward/backward. Проверить node names/bounds/actions, offset и focus retention.
- **Причина:** внутренний semantic snapshot не подключён к Android accessibility API. Логирование событий не создаёт semantic tree.
- **Исправление / зависимости:** platform semantics adapter и общий focus contract PL-01/03; accessibility scroll должен менять viewport offset.
- **Приёмка:** TalkBack читает сообщения, находит кнопки/поля, выполняет действия; focus стабилен после prepend/rotation; обе scroll actions меняют положение.

### PL-07 — P2 — Android Copy и Export не имеют platform capability

- **Статус / хосты:** `STATIC_CONFIRMED`; Android canary. Clipboard/document/share runtime — `NOT_RUN`.
- **Симптом:** Copy — явный no-op; Export может показать ready, но отсутствует выдача файла/URI пользователю.
- **Ожидается:** clipboard после успешного copy; экспорт доступен через Android document/share flow либо UI честно сообщает отсутствие возможности.
- **Координаты / доказательство:** `android_jni.rs:653–659` логирует `clipboard_bridge_pending`; Android action dispatch `:599–600` не потребляет `LastExport`. `session/messages.rs:352–357`, `:371–372` паркуют bytes и ready status; в Activity/JNI нет `take_last_export` и ClipboardManager sink.
- **Воспроизведение:** Copy, проверить clipboard; Export, проверить полученный document URI и bytes. Устройство отсутствует, подтверждён разрыв вызовов.
- **Причина:** общий action присутствует, но host capability contract не завершён.
- **Исправление / зависимости:** clipboard/document handoff, typed completion/error; availability должна отражаться в UI. Использовать общий capability интерфейс вместо новых независимых action веток.
- **Приёмка:** clipboard payload совпадает с сообщением; export URI читается и содержит wire bytes; failures локализованы; успех только после платформенного подтверждения.

### PL-08 — P2 — Desktop export неатомарен и теряет payload при ошибке

- **Статус / хосты:** `STATIC_CONFIRMED`; native desktop. Fault injection runtime — `NOT_RUN`.
- **Симптом:** direct overwrite может оставить частичный файл; write failure оставляет ready status, но parked export уже снят.
- **Ожидается:** атомарная запись, явная политика existing file, возможность повторить сохранение и корректный UI error.
- **Координаты / доказательство:** `desktop_host/mod.rs:72–79` использует `std::fs::write` без temp/rename. `input.rs:719–727` вызывает `take_last_export` до записи; Err только журналируется. `session/messages.rs:371–372` делает `take()`.
- **Воспроизведение:** unwritable `NEOTA_EXPORT_DIR`, экспорт, проверить status и retry. Отдельно existing filename и crash/write fault injection проверить сохранность предыдущего файла.
- **Причина:** sink consumes payload до подтверждения, не имеет transaction/error handoff.
- **Исправление / зависимости:** atomic temp+rename, explicit existing-file policy; consume после success либо восстановить parked result; stable localized error. Общий completion contract пригоден Android PL-07.
- **Приёмка:** interrupted write сохраняет прежний полный файл; retry не вызывает новую wire export operation; ошибка не выглядит success.

## Ограничения, долг и риски

### PL-L01 — P2 — Product glass/filter не исполняется (`DOCUMENTED_LIMITATION`)

**Хосты:** native desktop и Android. `presentation-m0-d2/src/vello_sink.rs:263–282` игнорирует `_filter`/`_backdrop_filter`. Desktop `produce.rs:254` рендерит split scenes; Android `android_surface.rs:1651` — full scene. Эти product paths не исполняют NeoCompositor glass pass graph. Glass markers/tests не подтверждают live blur. Ожидаемое будущее поведение — динамический backdrop с clip/effect semantics; текущая приёмка остаётся отложенной. Следующий шаг: связать capability с реальным executor и отдельно проверить движущийся цветной backdrop, blur setting, nested scopes на product hosts. Зависимость: common presentation capability contract; не начинать с ручного размытия отдельных панелей.

### PL-L02 — P2 — Разошедшиеся host pipelines (`ARCHITECTURAL_DEBT`)

**Хосты:** desktop и Android. Desktop `produce.rs:148–172` сохраняет VDOM и делает `paint_split`/overscan; Android `android_surface.rs:1627–1631` cold-opens и делает full paint. Input/export/stream driving также различаются. Docstring `bin/neocompositor-desktop.rs:3–8` и [описание хоста](../../desktop/neocompositor-desktop-host.md) переоценивают идентичность. Ожидается точная карта общих invariants и отдельных adapters. Следующий шаг: общая orchestration abstraction для lifecycle и contract tests обоих adapters, затем обновление документации. Приёмка: desktop fix не получает Android PASS без выполнения соответствующего adapter теста/physical gate.

### PL-L03 — P2 — Arena GC workaround и patch-map долг (`ARCHITECTURAL_DEBT`)

**Хосты:** retained desktop producer; Android cold-opens каждый bind. `vendor/blitz-dom/NEOTAVERN_PATCH.md` документирует no-op GC для alpha ID recycling. `desktop_host/produce.rs:392–408` ограничивает retained arena 8192 nodes и cold-reopen следующего produce. Это bounded workaround, не доказанный unbounded leak. Следующий шаг: полный patch inventory, regression при переработке upstream GC, soak RSS/private bytes и long-frame metrics. Приёмка: рост памяти ограничен и cold-reopen стоимость измерена; устранение workaround только после behavioral id-recycling regression. Зависимость: совместимая исправленная producer seam, без смены стека.

### PL-L04 — P2 — Image kill-switch меняет paint-order invariant (`DOCUMENTED_LIMITATION`)

**Хосты:** desktop и Android при `NEOTA_INSCENE_IMAGES=0`. Default in-scene images исправлены; fallback `produce.rs:373–383`, `android_surface.rs:1338–1359` композитит avatars после кадра и не знает modal z-order/full clip chains. Ожидается честный degraded status. Воспроизведение: switch off, avatar под modal/scroll clip, capture; в этом аудите fallback runtime не засчитывается. Следующий шаг: явное capability ограничение и отдельные overlay regressions. Приёмка: fallback не объявляется parity; возврат к default scene path проверен. Не удалять защитный switch без физического driver evidence.

### PL-R01 — P2 — Неполный presentation JNI panic guard (`RISK_NOT_REPRODUCED`)

**Хосты:** Android presentation JNI. `openRoute:342` использует catch_unwind, а другие `extern "system"` entrypoints (`send`, `pollStream`, `presentFrame`) вызывают `with_route:296–306` без общего unwind guard. `bind_from_session` catch-ит bind отдельно. Возможный abort при панике mutation/mount не воспроизведён. Следующий шаг: panic injection на ABI boundary; typed stable error и last-known-good recovery для всех entrypoints. Приёмка: panics не пересекают JNI и не abort-ят процесс. Kernel JNI transport PASS не заменяет этот тест.

### PL-R02 — P2 — Teardown и stream callbacks требуют lifecycle guard (`RISK_NOT_REPRODUCED`)

**Хосты:** Android. `Activity:405–415` завершает handler и holder; `pollStreamingBounded:719` post-ит executor work без общего closed/lifecycle token. После shutdown возможен rejected enqueue; такой crash не воспроизведён. Rust UI calls на compositor callback идут напрямую в Kotlin KernelSession, несмотря на обещание Kotlin polling comment о holder executor. Следующий шаг: единая ownership/serialization политика, cancel callback token, stress rotation/background/finish во время stream. Приёмка: нет callbacks после закрытия, rejected enqueue/использования старой session и main-thread wait. Связано с PL-04/05.

### PL-R03 — P2 — Adapter qualification эвристична (`RISK_NOT_REPRODUCED`)

`vello_gpu.rs:193–201` исключает emulator Vulkan по подстрокам имени; `adapter_sort_key:204–216` ранжирует backend раньше CPU type. Новый emulator/software adapter может не совпасть с именем. Это не доказанная ошибка текущего Vulkan устройства. Следующий шаг: capability/driver evidence и tests на неизвестное имя/CPU renderer. Приёмка: software/emulator не получает physical GPU qualification только по удачному созданию surface.

## Покрытие адаптеров и незакрытые сценарии

| Область                    | Desktop native                                                        | Android canary                                                | Следующее доказательство                                             |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Pointer/hit-test           | Native feature tests PASS; layout и geometric paths отдельны          | Статически inspect; physical `NOT_RUN`                        | Один frame geometry для render, focus и actions; overlap/slop/cancel |
| Physical keyboard/editor   | `STATIC_CONFIRMED` PL-01; CLI setter не OS test                       | PL-03; physical `NOT_RUN`                                     | Caret/selection/IME/shortcuts на устройстве                          |
| Clipboard                  | OS sink реализован; runtime clipboard `NOT_RUN`                       | PL-07 no-op                                                   | Прочитать clipboard после UI действия, failure path                  |
| File import/export         | Path-input ручной; export PL-08                                       | Export sink отсутствует PL-07                                 | Dialog/path permission, cancellation, atomic write, retry            |
| Streaming                  | Свежий live-wire probe; не все user input paths                       | PL-04/05; physical `NOT_RUN`                                  | Slow first token, long run, cancel, route change                     |
| Accessibility              | Нарисованный UI; native OS semantics не подтверждены                  | PL-06; TalkBack `NOT_RUN`                                     | Semantic nodes, actions, keyboard focus и RTL bounds                 |
| Insets/DPI/resize          | Captures на проверенных размерах; не все DPI                          | Cached insets inspect; physical `NOT_RUN`                     | Late insets, IME animation, safe-area, rotation                      |
| Lifecycle/Surface recreate | Window lifecycle inspect; no cross-OS PASS                            | PL-R02; background/resume/rotation/Surface recreate `NOT_RUN` | Streaming during teardown/recreate, device loss recovery             |
| JNI/FFI                    | Core/transport tests PASS относятся к своим boundaries                | Presentation guard PL-R01; physical `NOT_RUN`                 | Panic/stale handles/cancellation на presentation boundary            |
| GPU images/clip/z-order    | Default fresh Vulkan captures; fallback PL-L04                        | Source implemented; physical `NOT_RUN`                        | Modal stacking, image atlas recovery, driver-specific switch         |
| Glass/filter               | PL-L01 deferred                                                       | PL-L01 deferred                                               | Реальные blur pixels, nested scopes и scrolling backdrop             |
| Safe mode                  | Legacy chrome escape имеется; third-party lifecycle не подтверждён им | Canary policy имеет safe-mode WebView fallback                | Theme/plugin disable cleanup и reset, отдельно от chrome switch      |
| Frame pacing/memory        | Capture не perf; отдельные measurements в VERIFICATION                | Physical `NOT_RUN`                                            | No-capture frame intervals/soak/device epoch pressure                |

Свежий FakeWire first produce измерен основным аудитом примерно в 1067 ms; working set 185,5 MiB, private bytes 653,4 MiB. Это весь native host, поэтому его нельзя автоматически сравнивать с backend-idle 180 MB. Отдельный headless sample: ready HTTP meta 153,9 ms, idle working set 11,2 MiB/private 5,3 MiB; он не описывает стоимость графического frontend. Эти samples не доказывают все target metrics и не заменяют frame-pacing trace.

## Зависимости alpha/beta и четыре актуальных vendor patches

`presentation-m0-d2/Cargo.toml` и `crates/Cargo.lock` фиксируют Dioxus/native-dom `0.8.0-alpha.1`, Blitz `0.3.0-beta.1`, anyrender `0.11.0`, Vello `0.9.0`; GPU host использует wgpu `29.0.3`. Сам prerelease статус не дефект. Важны последствия API/GC поведения и проверка seam на обновлении.

| Patch в `crates/Cargo.toml` | Реальная роль                                                                              | Ограничение / следующий шаг                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `anyrender`                 | Host node/text fragment markers, chrome route                                              | Сохранять paint order; проверять application/rebase и backwards no-op hooks               |
| `blitz-paint`               | Emit host markers из paint traversal, shaped text replay, chrome routing, expanded culling | Не считать marker исполнением glass; проверять split/clip/order behavioral regressions    |
| `blitz-dom`                 | No-op arena GC, node count, defensive dead-parent guard                                    | Bounded cold-reopen PL-L03; GC workaround уже шире первоначальной two-patch карты         |
| `vello`                     | Shader-bounds diagnostic hook; default upstream unchecked                                  | Диагностическое A/B не равно устранённому driver defect; сохранять отдельные GPU evidence |

Документы [upstream seam](../../../crates/presentation-m0-d2/upstream/README.md) и [vendor README](../../../crates/vendor/README.md) не дают полного единого описания четырёх patches. [blitz-dom patch](../../../crates/vendor/blitz-dom/NEOTAVERN_PATCH.md) честно описывает отключение GC и containment. Требуется единая карта версии, exact diff, owner, exit criteria и test для каждого patch, без обещания немедленно удалить рабочую защиту.

## Перепроверка прежних аудитов

Основания: [каталог v4](../../../audit-neoui-v4/11-BUGS-AND-HACKS-CATALOG.md), [security v4](../../../audit-neoui-v4/10-SECURITY-VULNERABILITIES.md), [visual v4](../../../audit-neoui-v4/04-VISUAL-PARITY-GLASS.md), [image pipeline audit](../../desktop/native-image-pipeline-audit.md). `Resolved` ниже означает наличие исправления в текущем коде, а не новое физическое PASS.

| Прежняя находка                             | Текущая оценка                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| v4 P0-01 native views alpha=.01             | `RESOLVED_IN_CODE`: header/messages/send overlay удалён; замена имеет PL-03/06                                                                  |
| v4 P1-02 naive CSS flatten                  | `PARTIALLY_RESOLVED`: nested calc/max/min/clamp и strings/comments поддержаны; general CSS grammar limitation остаётся                          |
| v4 P1-03 unbounded avatar cache             | `RESOLVED_IN_CODE`: GPU 64 entries/8 MiB, pressure/epoch; AssetStore 64/32 MiB; physical budgets не измерены                                    |
| v4 P1-04 image decode без preflight         | `RESOLVED_IN_CODE`: input 16 MiB, axis 4096, 16M pixels, header dimensions до raster decode (`avatar.rs:24–65`)                                 |
| v4 P1-05 40×poll HOL                        | `PARTIALLY_RESOLVED`: Kotlin loop yielding; PL-04/05 остаются                                                                                   |
| v4 P2-06 emulator substring                 | `PERSISTS`, PL-R03; новый runtime failure не доказан                                                                                            |
| v4 P2-07 cssPx truncation                   | `RESOLVED_IN_CODE`: `MainActivity.kt:420–424`, roundToInt                                                                                       |
| v4 P2-08 ellipsize heuristic                | `PERSISTS`: `product_shell.rs:304–325`                                                                                                          |
| v4 P2-09 late insets                        | `MITIGATED_IN_CODE`: cache pushed перед present loop (`Activity:467–470`); no-jump physical `NOT_RUN`                                           |
| v4 P2-10 hasWebView recursion               | `PERSISTS`, низкий риск текущего плоского дерева                                                                                                |
| v4 P2-11 holder hot-restart                 | `NOT_VERIFIED`: требует lifecycle stress, PL-R02                                                                                                |
| v4 P3-12 missing README                     | Назначенные presentation crates имеют README; это не review актуальности всех примеров                                                          |
| Broad cleartext                             | `DOCUMENTED_LIMITATION`: произвольные LAN literal IPs; narrowing требует отдельной принятой политики, не объявлять новую critical vulnerability |
| Image Stage A fit/radius/snap/mips          | `RESOLVED_IN_CODE`                                                                                                                              |
| Image Stage B in-scene/avatar/message asset | `RESOLVED_IN_CODE` default; Android Vulkan physical `NOT_RUN`; kill-switch PL-L04                                                               |
| Image Stage C fixed wallpaper/kernel thumbs | Desktop `RESOLVED_IN_CODE`; Android wallpaper не подключён                                                                                      |
| 192px gallery upscale                       | `DOCUMENTED_LIMITATION_PERSISTS`, `AVATAR_DISPLAY_MAX_PX=192`                                                                                   |
| Remote markdown images/SVG                  | `DOCUMENTED_LIMITATION_PERSISTS`; local raster asset path реализован                                                                            |
| Per-produce decode                          | Desktop retained session изменил путь; Android cold-open сохранился; performance `NOT_RUN` для полной матрицы                                   |

## Очередность исправлений и граница завершения

1. Удалить logging текста PL-02; атомарность/error handoff экспортов PL-08.
2. Установить общую input/semantics модель, затем закрыть PL-01/03/06 и capability sinks PL-07.
3. Единый stream lifecycle и неблокирующий старт PL-04/05; lifecycle guards и presentation JNI panic tests PL-R01/02.
4. Закрепить общие host invariants и отдельные adapter contracts PL-L02; честное capability исполнение glass PL-L01 и degraded overlay PL-L04.
5. После behavioral correctness измерить no-capture frame pacing, cold-reopen soak и physical Android GPU/insets/rotation.

Не объявлять full-platform PASS до физических Android/macOS/Linux прогонов и packaged Tauri validation. Исправления перечислены как будущие задачи: аудит не менял реализацию, API, данные, миграции или совместимость.
