---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/audits/rust-app/PRESENTATION.md
---

# Аудит общего Rust presentation

Дата: 2026-10-04. Проверяемая цепочка: Product Wire → ChatSession → Dioxus/Blueprint → Blitz; потребители — Windows desktop-host и Android canary. Это отчёт об исходном коде и ограниченных наблюдениях, а не заявление о готовности нативного приложения. Продуктовые файлы в рамках этого среза не изменялись.

`STATIC_CONFIRMED` — дефект доказан исходным кодом; это не runtime PASS. `RUNTIME_CONFIRMED` — указанный дефект воспроизведён recorded witness, а не вся область получила PASS. `RUNTIME_UNVERIFIED` — предполагаемое проявление ещё требует исполнения. `NOT_RUN` — нужного прогона не было. Пути и номера строк ниже относятся к исходникам проверяемой рабочей копии; фактическую ревизию и исходные пользовательские изменения фиксирует общий протокол аудита.

## Краткий результат

Основная проблема presentation — видимая полнота интерфейса превышает полноту его цепочек до канонического состояния. Реальные Wire CRUD существуют, но отправка не использует выбранный provider, редактор карточки подменяет важные поля синтетическим текстом, пагинация библиотек обрывается, drafts не восстанавливаются, часть настроек остаётся только в памяти. В CSS преобразовании найден конкретный неверный расчёт размеров. Эти дефекты нельзя исправлять обновлением screenshot goldens или обходом Kernel в платформенном хосте.

### Каталог

| ID    | Приоритет | Область                                                    | Статус                                                                                          |
| ----- | --------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| UI-01 | P1        | Выбор provider/model и отправка                            | RUNTIME_CONFIRMED для отсутствующих request metadata; invalid settings request STATIC_CONFIRMED |
| UI-02 | P1        | Реальные поля character card и сохранение                  | STATIC_CONFIRMED                                                                                |
| UI-03 | P1        | Пагинация персонажей/чатов                                 | RUNTIME_CONFIRMED                                                                               |
| UI-04 | P1        | Восстановление drafts                                      | RUNTIME_CONFIRMED                                                                               |
| UI-05 | P1        | Вычитание в CSS baking                                     | RUNTIME_CONFIRMED                                                                               |
| UI-06 | P2        | Startup hydration настроек                                 | RUNTIME_CONFIRMED                                                                               |
| UI-07 | P2        | Сохранение appearance/startup prefs                        | STATIC_CONFIRMED                                                                                |
| UI-08 | P2        | Default/Chat persona bindings                              | STATIC_CONFIRMED                                                                                |
| UI-09 | P2        | Context meter                                              | STATIC_CONFIRMED                                                                                |
| UI-10 | P2        | Поиск по истории                                           | STATIC_CONFIRMED                                                                                |
| UI-11 | P2        | Гидрация более 32 изображений                              | STATIC_CONFIRMED                                                                                |
| UI-12 | P1        | Ограничение файла до импорта                               | STATIC_CONFIRMED                                                                                |
| UI-13 | P2        | Resident history и журнал команд                           | STATIC_CONFIRMED                                                                                |
| UI-14 | P1        | Эффективность presentation safe mode                       | STATIC_CONFIRMED; защита в host/Kernel требует проверки                                         |
| UI-15 | P1        | Параллельная геометрия hit testing открывает другую панель | RUNTIME_CONFIRMED                                                                               |

## Системные причины: почему локальные фиксы накапливаются

Это не перечень косметических ошибок. Ниже причины по уровню влияния; решение каждой должно закрывать класс дефектов и получать поведенческий gate.

1. **Presentation выдаёт собственное состояние за каноническое.** UI-02 synthesizes greeting/notes вместо hydration; UI-06 defaults перезаписывают hydrated settings; UI-07/08 показывают local prefs/bindings как действующие. Причина — view model объединяет durable DTO, редакторский draft, fixture values и unsupported capabilities без явной границы. Нужна одна схема проекции Kernel state и явные editable/readonly/unavailable состояния, а не исправление каждой строки по отдельности. Gate: импортированные уникальные поля и settings остаются теми же после open/edit/restart/export; ни один enabled save не выдаёт success без durable postcondition.
2. **Wire граница формально типизирована, но не проверяется реальным поведением.** UI-01 отправляет camelCase setting key и scalar value вопреки canonical schema, а generation request теряет provider/model; UI-03 отбрасывает cursor; UI-04 сохраняет draft без discovery/recovery. Generated DTO/успешный FakeWire call не гарантируют valid contract или полноту жизненного цикла. Gate: вся цепочка каждого enabled action проходит настоящий Kernel с canonical validation и проверяет durable state, pagination и recovery; fixture transport соблюдает те же ограничения.
3. **Paint и input имеют разные источники геометрии.** UI-15 — фактический клик по Settings открывает Plugins, потому что DOM/Blitz layout и `shell_hit` независимо описывают rail. Ручные offsets/strides дают временные поправки на одну тему/размер, после чего дрейф возвращается. Gate: все visible controls получают stable action и фактические layout-derived rects; центр каждого control разрешается именно в его action при resize/DPI/длинном переводе/теме. Это устранение параллельной authority, не очередная поправка y.
4. **Визуальная совместимость восстанавливается ручной трансформацией и дополнительными сценами.** UI-05 доказывает неверную арифметику stylesheet baking; Blueprint/legacy guard перестраивает VDOM для обычных действий; inline colors/layout конкурируют с Theme SDK, а CSS root selectors не совпадают с app-shell attributes. Компенсации в compositor/host не исправляют ложные размеры/семантику upstream. Gate: arithmetic/parser cases, computed layout, theme slots, paint/hit identity и continuity проверяются на общем документе; React parity — отдельный эталон, не internal native golden.
5. **Окно отображения принято за весь продуктовый набор.** UI-09/10 называют window estimate/search whole-chat; UI-11 ограничивает prefix IDs вместо unresolved work; UI-13 виртуализирует render, но не resident DTO/logs. Gate: 10k history/101-item library/33 assets дают корректные результаты без whole-library memory loading; scroll не меняет actual prompt budget; память достигает plateau.

Product Wire, JNI/clipboard/IME адаптеры, generated DTO, legacy compatibility host и явно документированный Preview fallback — необходимые совместимые швы. Вредная дубликация возникает там, где шов заново определяет продуктовые settings/данные, geometry или capability truth. Удалять такие причины следует внутри утверждённого Rust Kernel/contract/presentation stack; переписывание стека этот аудит не предлагает.

## Находки с воспроизведением и приёмкой

### UI-01 — выбор провайдера не определяет нативную отправку

- **Платформы/статус:** desktop-host, Android ChatSession; P1. Metadata omission RUNTIME_CONFIRMED в Kernel harness; invalid settings mutation STATIC_CONFIRMED. Physical Android NOT_RUN.
- **Симптом/ожидание:** пользователь выбирает реальный профиль, но native `generation.start` не указывает adapter/model. Ожидается генерация выбранным профилем и моделью либо явная ошибка отсутствующей конфигурации.
- **Источники/причина:** `crates/presentation-chat/src/session/presets.rs:10` меняет local selection и пытается сохранять `activeProviderConfigId`; ключ `:14` camelCase и scalar `json!(id)` `:15` нарушают `packages/contracts/src/wire/dto.ts:1952–1953` (lowercase key pattern, Object value). Следовательно, само сохранение не является valid canonical mutation. `session/composer.rs:154` передаёт `provider: None`, `model: None`. `crates/runtime-kernel/src/generation.rs:729` сохраняет параметры request, `:1753` подставляет `fake`, `:1754` — пустую модель. Читатель `activeProviderConfigId` в Kernel не найден. Native profile create передаёт `config: None`, `api_key: None` (`session/presets.rs:627`); поля model/endpoint/key отсутствуют. Аналогичные camelCase/scalar generation-setting writes в `select_preset` требуют отдельного valid-contract gate.
- **Минимальный сценарий:** на отдельном data root выбрать профиль детерминированного mock adapter, отправить сообщение и зафиксировать request/adapter invocation. FakeWire demo этот сценарий не доказывает.
- **Исправление/зависимости:** valid settings mutation в едином canonical формате и проекция только после его успеха; связать effective provider config/model с канонической generation authority; изменения Wire — только в согласованном контракте. Не добавлять самостоятельное разрешение продуктовых настроек в JNI/desktop host. Согласовать с Kernel/provider-аудитом.
- **Приёмка:** mock adapter получает выбранные provider/model; выбор переживает restart; неизвестный/удалённый профиль даёт stable error; fake используется только при явно выбранном fake.

### UI-02 — редактор карточки подменяет важные поля и не сохраняет ввод

- **Платформы/статус:** общий native UI; P1, STATIC_CONFIRMED.
- **Симптом/ожидание:** импортированный `first_mes`, notes и alternate greetings заменяются выдуманными строками; редактирование теряется. Ожидается отображение реальных данных и честная доступность сохранения.
- **Источники/причина:** `session/characters.rs:841` генерирует `*NAME looks up.* Hey.`, `Character card for NAME.` и synthetic greeting. Setters `:680–737` изменяют лишь local draft. Save `:602–664` проверяет/сохраняет только name/description и сообщает `No changes.` при изменении только greetings/notes. Create `:36` не передаёт введённый first message, а `:45` очищает его. Видимые поля — `crates/presentation-dioxus-shell/src/product_shell.rs:1720`, `:1737`; Save — `:1638`.
- **Минимальный сценарий:** импортировать карточку с уникальными first message/notes/greetings; открыть editor; изменить first message → Save → reselect/restart → export. Проверить реальные поля и unknown extensions отдельно.
- **Исправление/зависимости:** добавить согласованное каноническое чтение/изменение полей карточки с сохранением extension metadata. До доступности такой возможности помечать поля readonly/unsupported и не показывать синтетический текст как пользовательский. Зависимость — character-card Wire/Kernel capability, без ручного дублирования DTO.
- **Приёмка:** import/edit/restart/export сохраняют изменённые реальные поля и неизвестные metadata; неподдержанные изменения не принимаются с ложным success.

### UI-03 — библиотека обрывается после первой страницы

- **Платформы/статус:** общий desktop-host/Android ChatSession; P1, RUNTIME_CONFIRMED в Kernel harness. Physical Android NOT_RUN.
- **Симптом/ожидание:** персонажи/чаты за первыми 50 недостижимы; Load more не обращается к Kernel. Ожидается cursor pagination и поиск всей библиотеки.
- **Источники/причина:** `session/chat_nav.rs:31`, `:214` запрашивают limit=50 и отбрасывают `next_cursor`. `load_more_characters` `:247` увеличивает только `character_browser_limit`. Фильтры работают по resident first page. `fake_wire.rs:779`, `:792` тоже truncate и возвращают cursor=None, поэтому demo не выявляет дефект.
- **Минимальный сценарий:** seed 101 characters/chats с уникальными записями 51/101; открыть каталог, Load more, поиск уникального имени/названия.
- **Исправление/зависимости:** хранить cursors и подгружать страницы; full-library search реализовать canonical capability. Сохранить виртуализацию, stable IDs и ограниченный resident набор.
- **Приёмка:** 51/101 достижимы; повторная загрузка не дублирует; ошибки/отмена не теряют cursor; DOM и память ограничены.

### UI-04 — durable draft не возвращается при открытии чата

- **Платформы/статус:** общий desktop-host/Android ChatSession; P1, RUNTIME_CONFIRMED в Kernel harness. Physical Android NOT_RUN.
- **Симптом/ожидание:** после A → B → A либо restart composer пуст, хотя draft сохранялся в Kernel. Ожидается восстановление draft текущей беседы.
- **Источники/причина:** `session/chat_nav.rs:85` после открытия сбрасывает stream/draft; `session/composer.rs:313` очищает draft/composer. Дальше загружаются только messages. Startup не обнаруживает drafts. `reload_draft` `composer.rs:355` требует уже известный draft ID и не решает discovery после open.
- **Минимальный сценарий:** сохранить разные drafts в A/B, переключить обе беседы, перезапустить с тем же isolated root.
- **Исправление/зависимости:** Kernel-owned discovery/restoration текущего draft в open/navigation. Проверить семантику нескольких drafts; не кэшировать durable authority в host.
- **Приёмка:** правильные drafts переживают switch/restart; committed/discarded draft не воскресает; transport failure не выдаёт ложное сохранение.

### UI-05 — CSS вычитание превращается в сложение

- **Платформы/статус:** любой Blitz consumer; P1, RUNTIME_CONFIRMED через public baking API harness. Pixel consequences требуют отдельной сверки.
- **Симптом/ожидание:** размеры/радиусы контролов отличаются от исходного CSS. `calc(44px - 24px)` должен давать 20px, а код суммирует 44 и 24.
- **Источники/причина:** `crates/presentation-design-system/src/lib.rs:115–145` flush предыдущего term теряет бинарный `-`, затем суммирует terms. Реальные выражения: `generated/product.css:1241`, `:1498`, `:4034`, `:4184`, `:8743`. Это конкретный дефект текущего baking, а не гипотеза о будущих сложных CSS.
- **Минимальный сценарий:** public `bake_insets` для `calc(10px - 4px)`, `calc(44px - 24px)`, `calc(40px - 18px - 2px)` и unary negative; зафиксировать outputs.
- **Исправление/зависимости:** сохранить знак оператора или применять корректный CSS parser; не править сгенерированную stylesheet вручную.
- **Приёмка:** outputs 6/20/20px; unary signs/comments/nested/unresolved expressions корректны; геометрия реальных контролов сверена без перезаписи goldens.

### UI-06 — startup перезаписывает hydration

- **Платформы/статус:** общий ChatSession; P2, RUNTIME_CONFIRMED в corrected Kernel harness; физические платформенные прогоны не выполнены.
- **Симптом/ожидание:** сохранённый ru/RTL и text prompt отображаются как en/ltr/chat до повторного входа в соответствующую настройку.
- **Источники/причина:** `session/core.rs:36` запускает `load_workspace → load_personas → load_settings` (`personas.rs:28`); затем `core.rs:57–58` перезаписывает language/dir и `:72–73` prompt_template/instruct selection defaults.
- **Минимальный сценарий:** сохранить ru и text prompt, открыть новую session; сравнить loaded settings с `state()`/view до открытия панели.
- **Исправление/зависимости:** применять defaults до hydration; не сбрасывать successfully hydrated values.
- **Приёмка:** startup отображает persisted language/dir/prompt/instruct; отсутствующие значения используют defaults; corrupt setting возвращает явную диагностику.

### UI-07 — appearance/startup prefs transient

- **Платформы/статус:** общий native UI; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** элементы настройки меняют value label, но после restart возвращаются defaults; startup preference не управляет открытием workspace.
- **Источники/причина:** `session/characters.rs:402–468` меняет ui scale/contrast/font/motion/chat style/avatar style/position/opacity/blur/startup только в памяти; `session/messages.rs:279–290` аналогично. `open_home_on_load` используется как label, без startup branch.
- **Минимальный сценарий:** изменить каждую supported preference; закрыть/reopen session; проверить effective styling и initial panel.
- **Исправление/зависимости:** использовать согласованное хранение prefs и consumption при startup; на стороне presentation не создавать вторую продуктовую БД. Визуальную работоспособность проверить отдельно от persistence.
- **Приёмка:** supported preferences сохраняются и действуют после restart; unavailable preference явно обозначена; error не подтверждается success.

### UI-08 — enabled persona Default/Chat кнопки инертны

- **Платформы/статус:** общий native UI; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** Default/Chat выглядят доступными, но не изменяют связи; ожидается durable binding либо disabled capability.
- **Источники/причина:** `crates/presentation-dioxus-shell/src/personas_tab.rs:330–336`, `:346–351` не имеют action/handler. `session/personas.rs:106` выбирает только editor; create/delete `:133`, `:163` меняют active persona локально без settings update. Соседняя Character binding правильно disabled.
- **Минимальный сценарий:** открыть другую persona, нажать Default/Chat, посмотреть issued commands/effective chat persona и restart.
- **Исправление/зависимости:** stable actions с canonical settings/chat mutation либо честное disabled состояние; уточнить app-wide vs per-chat binding по существующему контракту.
- **Приёмка:** supported binding durable; failed mutation не меняет effective badge; disabled action не выглядит успешно выполненной.

### UI-09 — context meter считает только окно

- **Платформы/статус:** общий native UI; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** показания зависят от scroll; applied preset и реальная история не отражаются. Ожидается честно помеченная оценка actual prompt с effective limits.
- **Источники/причина:** `session/view.rs:188` передаёт visible window в `context_estimate`; `:325–350` суммирует только эти rows/draft и фиксирует 16032/4000. Character/persona/lorebook и остальные messages не учитываются.
- **Минимальный сценарий:** 10k chat, поменять preset limit/maxTokens; сравнить meter до/после scroll с Kernel plan.
- **Исправление/зависимости:** получать каноническую prompt estimate/plan с effective budget; если estimate неполная, явно сообщать границы. Зависимость — Kernel pipeline contract.
- **Приёмка:** scroll не меняет бюджет без изменения prompt; preset отражается; mandatory prompt blocks учтены; over-budget объясняется честно.

### UI-10 — поиск ограничен resident history и устаревает

- **Платформы/статус:** общий native UI; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** совпадения за latest page не видны; count после prepend/edit/delete может оставаться прежним. Ожидается whole-chat search.
- **Источники/причина:** `session/profiles.rs:561–568` считает только `state.messages`; пересчёт запускается при query input, не при изменении history. `product_path.rs:184` документирует whole-chat count.
- **Минимальный сценарий:** строка только в раннем сообщении 10k chat; поиск до и после prepend; изменить/удалить совпадение без изменения query.
- **Исправление/зависимости:** Kernel search с bounded results/cursor; актуализировать results при mutation; не загружать весь чат ради поиска.
- **Приёмка:** ранний match найден/достижим, count актуален после изменений, cancellation/stale requests не заменяют новый query.

### UI-11 — 33-я asset image может никогда не гидратироваться

- **Платформы/статус:** общий native UI; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** часть image refs остаётся placeholder даже после повторного refresh.
- **Источники/причина:** `session/wire_ops.rs:109–147` ограничивает collected IDs 32 до `store.contains`; уже гидратированные ID заполняют prefix целиком и не дают выбрать следующий ID.
- **Минимальный сценарий:** одно видимое сообщение с 33 уникальными asset refs; выполнить несколько `refresh_visible_assets`, проверить store/render.
- **Исправление/зависимости:** лимит на unresolved fetch candidates, bounded retry/negative-cache policy; сохранить window-first order и asset-store budgets.
- **Приёмка:** все 33 eventually отображаются; settled refresh не делает лишние fetch; failed asset не блокирует остальные.

### UI-12 — импорт аллоцирует файл до size gate

- **Платформы/статус:** desktop-host и доступные Android file-path imports; P1, STATIC_CONFIRMED.
- **Симптом/ожидание:** oversized input может занять большой heap до Wire rejection; ожидание — cap до proportional allocation.
- **Источники/причина:** `session/messages.rs:419`, `session/presets.rs:168`, `session/settings.rs:987` используют целый `std::fs::read` без metadata/read cap. Character import потом создаёт base64 (`messages.rs:446`).
- **Минимальный сценарий:** oversized file в isolated root; импорт под containment, фиксировать bounded rejection. Не создавать неконтролируемый гигантский payload для проверки.
- **Исправление/зависимости:** preflight и bounded read на generated registry limit, с учётом encoded envelope; MIME/extension validation там, где предусмотрена. Платформенные document providers проверяются отдельно.
- **Приёмка:** rejection до proportional heap/base64 роста; допустимый input работает; re-import сохраняет dedup; неизвестные поля не теряются.

### UI-13 — session memory не ограничена длительностью работы

- **Платформы/статус:** общий ChatSession; P2, STATIC_CONFIRMED.
- **Симптом/ожидание:** журнал Wire commands и resident messages растут; render window сам по себе не ограничивает memory.
- **Источники/причина:** `session/mod.rs:625` хранит `issued: Vec<String>`; `wire_ops.rs:243`, `:269` append каждого вызова без cap. Каждый composer input вызывает draft save (`composer.rs:8`). `wire_ops.rs:52–57` append/prepend всех полученных DTO без resident eviction.
- **Минимальный сценарий:** bounded long typing/navigation/prepend witness; счётчики resident DTO/issued и память до/после. Сам performance budget пока не измерен.
- **Исправление/зависимости:** bounded diagnostics ring/counters и resident page window с cursor/anchor; вся durable history остаётся в Kernel.
- **Приёмка:** память/log объём выходит на plateau; повторный fetch восстанавливает строки; scroll anchor/редактирование выбранной строки не теряются.

### UI-14 — presentation safe_mode флаг не используется

- **Платформы/статус:** общий ChatSession; P1, STATIC_CONFIRMED для presentation. Защита host/Kernel — RUNTIME_UNVERIFIED.
- **Симптом/ожидание:** `set_safe_mode(true)` сам не отключает сторонние темы/plugins и не даёт правдивого UI marker; ожидается effective safe mode и доступный reset.
- **Источники/причина:** `session/core.rs:363–365` только пишет `state.safe_mode`; его читатели в session/render не найдены. General status берётся из `error_code == SAFE_MODE` (`settings_tab.rs:73–77`). Theme/plugin handlers флаг не учитывают.
- **Минимальный сценарий:** safe session → activate theme/enable plugin; проверить effective styling и canonical rejection. Не запускать недоверенный plugin ради этого witness.
- **Исправление/зависимости:** сверить authority с host/Kernel; fail-closed behavior и honest state projection; reset доступен независимо broken theme. Проверять реальные policy paths, не наличие поля.
- **Приёмка:** third-party execution/styling отключены в safe mode; persisted/restarted safe mode работает; reset UI достижим.

### UI-15 — Settings hit zone независимо реконструирована и открывает Plugins

- **Платформы/статус:** Windows desktop-host — RUNTIME_CONFIRMED, P1; общий `shell_hit` также потребляется Android, но Android manifestation NOT_RUN.
- **Симптом/ожидание:** клик по видимому Settings control `(30,392)` открывает Plugins. Ожидается совпадение painted control, hit target и dispatched action.
- **Источники/причина:** DOM `native-default.json` показывает Settings item-control `x=10,y=372,w=40,h=40`. `crates/presentation-chat/src/shell_hit.rs:999–1040` вручную восстанавливает rail из menu height 52 + gaps 12 и stride 48; его Plugins zone — y352..396, Settings — y400..444. Paint располагает персонажей на y108, personas152, plugins328, settings372. `desktop_host/input.rs:67` вызывает geometric `hit_test`; layout action для этого rail control отсутствует. `native-hit-geometry` witness: point `(30,392)` → geometric `SetPanel(plugins)`, layout None; реальный `native-settings.native.log`/swapchain показывает Plugins.
- **Минимальный сценарий:** current desktop build, default 1100×760 fixture; кликнуть центр DOM Settings control, сопоставить probe intent и открывшуюся панель. Проверка должна идти от текущего DOM rect, не от hardcoded test coordinate.
- **Исправление/зависимости:** все rail/panel controls объявляют stable `data-ui-action`/action identity; dispatch использует actual layout snapshot. Оставшийся geometric fallback либо ограничивается реально неподдерживаемыми элементами с honest diagnostics, либо удаляется после полного покрытия. Не подгонять ещё один manual stride под текущий screenshot. Зависимость — общий layout/hit snapshot и Android consumer acceptance.
- **Приёмка:** каждый visible control center dispatches own action при resize/DPI/theme/long translation/RTL; disabled/occluded controls не активируются; нет параллельных geometry tables для тех же controls; actual Settings opens Settings.

### Поведенческие witnesses каталога

В `build/rust-audit/2026-10-04-1b407fc/audit-witnesses-fixed.log` main harness подтвердил: `UI-DRAFT` — persisted `AUDIT_UNSENT_DRAFT`, reopened composer empty/draft null (UI-04); `UI-PAGINATION` — Kernel 55, session 50 characters/50 chats, LoadMore остаётся 50 и новых Wire calls 0 (UI-03); `UI-CSS-MATH` — actual 68/14/68px вместо 20/6/52px (UI-05). `UI-PROVIDER` подтверждает только отсутствие provider/model в generation payload после local selection; реальный выбранный endpoint/credentials этим witness не проверены. `audit-settings-corrected.log` `UI-SETTINGS` подтвердил сохранённые ru/text, reopened en/chat (UI-06). Первый settings witness имел malformed request и не засчитывается. UI-15 использует native-hit-geometry и реальный pointer capture. Это точечные воспроизведения дефектов, не общий PASS UI.

## Карта поведения и полнота доказательств

| Область/действия                                          | Статически прослеженная цепочка                              | Статус и предел                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Send, streaming, retry, stop                              | composer → generation Wire → frame apply → durable message   | Связь есть; UI-01; успешная live generation этим срезом не подтверждена                                                                  |
| Draft save/commit/discard                                 | drafts Wire → DTO → composer state                           | Связь есть; open/restart discovery отсутствует UI-04                                                                                     |
| Chat open/switch/new/parent                               | chats get/create → latest messages → list refresh            | Связь есть; pinned character identity требует отдельного witness                                                                         |
| Message edit/delete/history/details                       | update/delete/revisions list → local projection/error toast  | Связь есть; a11y/focus/races/runtime durable результат не проверен                                                                       |
| Swipe/variants/regenerate                                 | variants list/activate и generation retry                    | Связь есть; counter `stored.len()+1` при совпадающем active content требует проверки                                                     |
| Branch/checkpoint/snapshots/rollback                      | snapshots create/list/rollback → chats get/messages list     | Связь есть; overlay cleanup/anchor/cancellation не подтверждены                                                                          |
| Copy/export                                               | session text/last_export → host OS operation → callback      | Host-specific; один native screenshot не доказывает запись clipboard/file                                                                |
| Header search/context                                     | local message iteration/estimate                             | UI-09/10; whole-chat/prompt accuracy отсутствуют                                                                                         |
| Characters                                                | CRUD, tags, import/export, draft projection                  | UI-02/03/12; unknown card fields требуют Kernel round-trip                                                                               |
| Personas                                                  | list/create/update/delete                                    | Basic Wire chain есть; UI-08; per-character binding явно disabled                                                                        |
| Lorebooks/entries                                         | list/create/update/delete, entries list/CRUD                 | Static mapped; full lists resident; large-library/runtime mutation pending                                                               |
| Generation presets                                        | list/CRUD, apply settings, import/export                     | Static mapped; UI-09/12; actual sampler execution требует Kernel witness                                                                 |
| Providers                                                 | list/config set/delete, active ID setting                    | UI-01; model/endpoint/key editing unavailable в native form                                                                              |
| Advanced prompt/instruct                                  | settings get/update, blocks, presets, import/export          | Static mapped; UI-06/12; final pipeline coupling не доказывается полями UI                                                               |
| Plugins                                                   | list/enable/disable/uninstall                                | Wire mapped; native plugin lifecycle/cleanup и UI-14 не подтверждены runtime                                                             |
| Themes                                                    | list/activate/deactivate/uninstall, token CSS                | Catalog загружается при открытии tab, не startup; custom CSS передаётся None (`profiles.rs:581`); complete shell replacement не доказана |
| Backgrounds/gallery                                       | enabled action → CAPABILITY_UNAVAILABLE                      | Документированное ограничение; не functional PASS                                                                                        |
| Search rebuild/diagnostic cache/ST analysis/theme install | action → CAPABILITY_UNAVAILABLE                              | Честные ошибки; функции отсутствуют в native capability                                                                                  |
| Diagnostics/data/backups                                  | export/activation status, list/create/restore → result state | Static mapped; restore сообщает restart hint; recovery runtime относится к общему протоколу                                              |
| Profiles/secrets/tools                                    | list/CRUD/export/import, secret status/lock, tools list      | Static mapped; privileged lifecycle/permission failure не проверены этим срезом                                                          |
| General prefs                                             | actions → state/view/data attrs                              | UI-06/07; computed styling требует probe                                                                                                 |
| Localization/pseudo/RTL                                   | literal English + language/dir attrs                         | Translation machinery не прослежена; pseudo/long translations/RTL runtime NOT_RUN                                                        |
| Keyboard/screen reader/modal semantics                    | отдельные roles/labels/data hooks                            | Наличие атрибутов не подтверждает bridge; Windows keyboard и Android TalkBack NOT_RUN                                                    |
| Resize/DPI/compact/safe area                              | chrome metrics + host viewport/insets + inline layout        | Compact screenshot наблюдён; comprehensive resize/DPI/input alignment не проверены                                                       |
| Blueprint ↔ legacy RSX                                    | shared view → guard → альтернативная VDOM ветка              | Continuity focus/theme/anchor NOT_RUN                                                                                                    |

### Проверенные ограничения и гипотезы

- **Appearance selectors:** атрибуты стоят на app-shell `div` (`product_shell.rs:2971–2995`), packed CSS ждёт `:root[data-ui-*]` и иногда descendant `body` (`generated/product.css:1985–2359`). `presentation-m0-d2/src/lib.rs:217–243` не переносит их на document root. Это конкретный selector mismatch по источникам; effective computed styling/Rust DOM root topology требует layout witness. Inline colors/layout также могут перебивать theme CSS.
- **Chat identity:** native `view.rs:37–72`, `:152–179` предпочитает pinned/selected character; startup pin — первый элемент списка (`chat_nav.rs:223`), open_chat не синхронизирует pin. React `apps/web/src/pages/ChatPage.tsx:72`, `:755` использует `chat.characterId`. Проверить две разные карточки/беседы: возможна подмена author/avatar/macros без изменения канонического chat character. До witness — RUNTIME_UNVERIFIED.
- **Localization:** literal English titles/copy (`product_shell.rs:112–134`, `settings_tab.rs:137–170`) и literal toasts не меняются через translator. `LANGUAGES` — en/ru/pseudo (`shell_hit.rs:377`). Выбор pseudo не расширяет строки; lang/dir не заменяют локализацию. Сохранённый RTL дополнительно затронут UI-06.
- **Markdown:** asset images рисуются; http(s) images остаются placeholders (`markdown.rs:683`). Ссылки — `span title=href` (`:648`), не интерактивные anchors. Это native limitations, а не доказательство общей неисправности image pipeline.
- **Blueprint guard:** edit/history/details/snapshots/variants/header search/parent chat переключают весь chrome на legacy RSX (`scene_chat.rs:298–320`). Compact сейчас документом покрыт. Shared state не доказывает сохранение focus, hit rects и scroll anchor при перестройке VDOM. Internal native golden не является React parity test.

## Визуальные артефакты и границы runtime

Артефакты: `build/rust-audit/2026-10-04-1b407fc/`. Там сохранены `.capture.json`, DOM `.json`, `.snapshot.png`, `.swapchain.png` и logs для native-default/900/620/compact/characters/settings/edit/search/scroll/live. Сам факт наличия файла не означает success действия; итог проверяется по state и durable result.

- `native-compact.swapchain.png` визуально просмотрен: размер 900×220; header у y=0, большая пустая область примерно до y=146, частично обрезанная строка сообщения и composer перекрывают нижнюю часть. DOM `native-compact.json` содержит navigation `main-items` высотой 412px при surface height=220. Это **VISUAL_OBSERVED** clipping/layout observation на FakeWire fixture, не доказанное сравнение с React и не установленная единственная причина. `product_path.rs::chrome_metrics` задаёт compact header/composer 36/40; нужно сопоставить реальные rects, chrome split и raster composition прежде чем выбирать исправление.
- Capture compact завершает собственный probe process после снимка (`hostExitCode: null`); capture time 2.86s не является измерением startup-to-ready.
- `native-settings` клик `(30,392)` фактически открыл Plugins; точка является центром видимого Settings по actual DOM, поэтому это UI-15, а не typo сценария. Артефакт **не доказывает** прохождение Settings и appearance scenarios. Naming файла нельзя использовать как semantic assertion.
- Исходный `native-live-send` использовал seed=0 и fabricated demo chat ID; `CHAT_NOT_FOUND` относится к некорректному route fixture. Нельзя приписывать его продуктовой отправке или считать успешным проверочным send. Исправленный прогон/его итог должен быть отдельно внесён в общий протокол.
- Исправленный live-send с seed=12 сохранил 14 messages и completed generation. Его durable request содержит chatId/message, provider/model null. Это подтверждает basic live durability на данном сценарии и UI-01 metadata omission; выбранный реальный endpoint всё ещё не проверен.
- Из остальных captures этим срезом не выполнена полная визуальная оценка и не проверен durable postcondition. macOS/Linux runtime, Android physical Gboard/InputConnection/TalkBack/SurfaceView/GPU/performance — NOT_RUN.

## Пересмотр прежних аудитов

| Старое утверждение                                     | Текущий вывод по источникам                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-neoui-v4` P1-02 naive CSS flatten               | Частично исправлено: balanced parentheses/comments/unresolved operands (`design-system/lib.rs:157–253`); конкретное вычитание UI-05 всё ещё неверно |
| P1-03 CPU avatar cache unbounded                       | Исправлено: 64 entries / 8 MiB (`session/mod.rs:103–107`) и LRU pressure eviction `:565`; GPU часть проверяет renderer slice                        |
| P2-08 fixed `fontSize*0.52` ellipsize                  | Исправлено: Parley measurement + binary search (`design-system/lib.rs:364–429`); старую координату нельзя переносить                                |
| Image audit: markdown image отсутствует                | Для `asset:` исправлено (`markdown.rs:662–681`); внешние URL всё ещё placeholder                                                                    |
| Image audit: original assets.content ради avatar       | Исправлено в hydration: `assets.thumb` (`characters.rs:880–895`)                                                                                    |
| Image audit: overlay/z-order/Android black SurfaceView | Нельзя подтвердить по старому тексту; нужны текущие GPU/physical captures и renderer audit                                                          |

Приоритет исправлений: UI-12 и UI-14 совместно с канонической защитой; затем UI-01/02/03/04 (работающие основные сценарии и сохранность ввода), UI-15/05 (общие причины input/visual drift), UI-06/07/08/09/10 (честность интерфейса), UI-11/13 (длительная работа и ресурсы). Приоритетные gates направлены на перечисленные системные причины, не на накопление локальных offsets/fallback fixes. Исправления публичных контрактов требуют отдельного явного задания; данный аудит их не меняет.
