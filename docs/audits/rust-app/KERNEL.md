# Аудит Rust Kernel, данных, providers и transport boundaries

Дата: 4 октября 2026 года. Это каталог дефектов текущего исходного кода и отдельных проверок настоящего Kernel на Windows. Продуктовый код не исправлялся. Отчёт не засчитывает FakeWire, успешную сборку или host-тест JNI как проверку физического Android.

## Доказательства и границы

`RUNTIME_CONFIRMED` означает, что основной агент воспроизвёл наблюдаемое нарушение в изолированном data root. `STATIC_CONFIRMED` означает прослеженную цепочку исходного кода; соответствующий runtime-сценарий не запускался. Эти статусы не являются общим PASS подсистемы.

Доказательства: audit-witnesses-fixed.log (локальный каталог build/rust-audit/2026-10-04-1b407fc/) и security-witnesses.log (локальный каталог build/rust-audit/2026-10-04-1b407fc/). Оба итоговых процесса завершились с exit code 0 через containment runner; harness подтверждает наличие дефекта, поэтому это не означает исправность продукта. Первая попытка компиляции audit harness потребовала исправления преобразования диагностической ошибки в самом harness. В security log присутствует ошибка предварительного назначения PowerShell-переменной; последующий cargo run и поведенческие свидетельства завершились успешно. Полные команды, лимиты и результаты сохраняются в логах.

P1 — риск данных, безопасности или основного сценария; P2 — существенная функциональная ошибка. Доказанных P0 в этой части аудита не установлено. «Все hosts» ниже означает общий Kernel-код, используемый local desktop, native Android/JNI и headless/remote; фактическое runtime-воспроизведение выполнено на Windows, а не на всех этих устройствах.

| ID    | Приоритет | Статус                               | Кратко                                                             |
| ----- | --------- | ------------------------------------ | ------------------------------------------------------------------ |
| KR-01 | P1        | RUNTIME_CONFIRMED                    | Restore marker одного root заменяет соседний root                  |
| KR-02 | P1        | RUNTIME_CONFIRMED                    | Endpoint одного config получает API key другого                    |
| KR-03 | P1        | STATIC_CONFIRMED                     | Sparse tool-call index вызывает пропорциональную allocation        |
| KR-04 | P1        | RUNTIME_CONFIRMED                    | JNI response-buffer retry повторяет committed mutation             |
| KR-05 | P1        | RUNTIME_CONFIRMED                    | V2 import сохраняет невалидного персонажа и ломает list            |
| KR-06 | P1        | RUNTIME_CONFIRMED                    | Быстрый restart оставляет прежний run в streaming                  |
| KR-07 | P1        | STATIC_CONFIRMED                     | HTTP/NDJSON limits проверяются после unbounded чтения              |
| KR-08 | P2        | STATIC_CONFIRMED                     | Personality импортированной карточки не попадает в prompt          |
| KR-09 | P2        | RUNTIME_CONFIRMED                    | Card export игнорирует последующие правки персонажа                |
| KR-10 | P2        | STATIC_CONFIRMED                     | Failed SecretStore write уже изменяет memory state                 |
| KR-11 | P1        | RUNTIME_CONFIRMED                    | Provider I/O блокирует writer и абсолютный deadline                |
| KR-12 | P2        | STATIC_CONFIRMED                     | Restore оставляет старый runtime provider registry                 |
| KR-13 | P1        | RUNTIME_CONFIRMED / STATIC_CONFIRMED | Final context budget не блокирует запрос; tools не пересчитываются |
| KR-14 | P1        | RUNTIME_CONFIRMED                    | Стандартный SSE heartbeat завершает ответ пустым сообщением        |

## Каталог дефектов

### KR-01 — Restore не изолирован по data root

**Hosts:** все hosts со storage restore. **Статус:** RUNTIME_CONFIRMED, `KR-RESTORE-SIBLING` в audit-witnesses-fixed.log.

**Симптом / ожидание:** открытие root B применяет pending restore root A; B должен сохранять собственные данные и не потреблять чужой marker. В свидетельстве B содержит `A RESTORED`, а `B original` отсутствует в активном каталоге. Предыдущий root может сохраняться отдельно; это не уменьшает серьёзность ошибочной подмены активных данных.

**Воспроизведение:** создать sibling roots A/B с разными персонажами, подготовить ready candidate A, записать pending marker с `root:A`, открыть B.

**Источники и причина:** [restore.rs](../../../crates/storage/src/restore.rs):32,106,148–155,174–192; [open.rs](../../../crates/storage/src/open.rs):330. Marker общий для parent; resolver читает `candidate`, игнорируя recorded `root`. Проверка candidate ограничена basename-prefix, несмотря на комментарий о проверке parent. Удаление previous roots также parent-global.

**Исправление / зависимости:** root-scoped marker и retention; сверять recorded root и canonical containment candidate; координировать swap через lock вне переименовываемого root. Зависимость — протокол activation/kill recovery, не изменение продуктовой схемы.

**Приёмка:** open(B) не меняет A/B/candidate A и не удаляет marker A; внешние/symlink candidates отвергаются; kill на каждом шаге оставляет правильный root восстанавливаемым. Текущие restore tests проверяют один root и не покрывают sibling identity.

### KR-02 — Конфигурация endpoint и secret имеют разные источники

**Hosts:** все hosts с configured OpenAI adapter. **Статус:** RUNTIME_CONFIRMED, `KR-MIXED-CONFIG` в security-witnesses.log.

**Симптом / ожидание:** endpoint Z получает ключ A вместо Z. Endpoint, model и key должны происходить из одной выбранной config identity. Это создаёт реальный путь отправки credential другому настроенному endpoint; свидетельство использовало только локально созданные mock keys и не выводило Authorization.

**Воспроизведение:** сохранить `openai/a` с endpoint A/key A и `openai/z` с endpoint Z/key Z; restart с тем же тестовым MemorySecretStore; start provider `openai`. Endpoint A не вызван; endpoint Z вызван, `authIsA:true`, `authIsZ:false`.

**Источники и причина:** [providers_config.rs](../../../crates/runtime-kernel/src/providers_config.rs):204,220,243; [providers.rs](../../../crates/runtime-kernel/src/providers.rs):219; [generation.rs](../../../crates/runtime-kernel/src/generation.rs):2265. Hydration заменяет один provider adapter последним config в name ASC, а secret resolver выбирает первый config. Save произвольного config тоже заменяет adapter того же provider.

**Исправление / зависимости:** закрепить единую config identity в adapter selection, secret resolution и run snapshot. Любое расширение публичного выбора согласовать с Wire-контрактом; безопасный промежуточный вариант — отказ при неоднозначности. Согласовать lifecycle с KR-12.

**Приёмка:** двухendpoint mock всегда получает key из соответствующей config; startup/save/delete не меняют selection скрытно. CRUD secret tests одного config недостаточны.

### KR-03 — Provider-controlled tool index обходится без allocation cap

**Hosts:** все hosts с OpenAI SSE/tools. **Статус:** STATIC_CONFIRMED; опасный payload не запускался.

**Симптом / ожидание:** маленький JSON с большим `tool_calls[].index` заставляет растить Vec до этого индекса; число slots должно ограничиваться до allocation.

**Воспроизведение:** mock SSE с одним tool delta и `index:1000000000`. Такой размер запрещено запускать вне containment; безопасное исследование использует небольшой sparse index и измеряет зависимость allocation.

**Источники и причина:** [provider lib.rs](../../../crates/provider-openai-compat/src/lib.rs):384–390. `as_u64` → unchecked `as usize` → `while len <= index { push(None) }`; response byte budget ограничивает JSON bytes, а не индекс.

**Исправление / зависимости:** checked conversion и явный bounded index/count до growth либо bounded map присутствующих индексов; typed error. Зависимость — согласованный tool resource budget.

**Приёмка:** over-cap index отвергается до пропорциональной allocation; RSS ограничен; обычные fragmented calls продолжают работать. Existing tool fixtures используют индекс 0.

### KR-04 — JNI повторяет mutation при недостаточном output buffer

**Hosts:** Android JNI и потребители mobile C ABI с аналогичным retry. **Статус:** RUNTIME_CONFIRMED на Windows JVM-independent JNI core, не физический Android.

**Симптом / ожидание:** один create с ответом длиннее 4096 bytes создаёт два distinct records. Изменение ёмкости output buffer не должно повторно исполнять command.

**Воспроизведение:** JNI `characters.create` с description около 5000 ASCII bytes; увеличить buffer после `NT_ERR_BUFFER`; перечитать каталог. Audit witness подтверждает два разных IDs после одного create.

**Источники и причина:** [android-jni lib.rs](../../../crates/adapters/android-jni/src/lib.rs):269–291; [mobile-ffi lib.rs](../../../crates/adapters/mobile-ffi/src/lib.rs):253–254. Kernel dispatch коммитит до copy_out; JNI повторяет весь nt_call после resize.

**Исправление / зависимости:** разделить execute и read уже полученного response, например opaque response handle/copy/free. Стабильный C ABI нельзя менять без явного согласования и совместимого перехода.

**Приёмка:** большой response, shortage и повторное чтение дают один durable side effect и один ID; concurrent calls не смешивают results. Existing buffer-shortage test проверяет только `meta.get`.

### KR-05 — Стандартный V2 import нарушает persisted DTO invariants

**Hosts:** все hosts с character-card import. **Статус:** RUNTIME_CONFIRMED в audit-witnesses-fixed.log.

**Симптом / ожидание:** nested V2 `data.name` не читается; import возвращает ошибку после commit, следующий characters.list также падает с StringMinLength. Валидный V2 должен импортироваться; invalid import не должен менять DB.

**Воспроизведение:** assets.put карточки `{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Ada","description":"test"}}`; imports.character.card; затем characters.list.

**Источники и причина:** [imports.rs](../../../crates/runtime-kernel/src/imports.rs):122,155,247,266,325; [dto.ts](../../../packages/contracts/src/wire/dto.ts):45; [schema.rs](../../../crates/storage/src/schema.rs):56; [product.rs](../../../crates/runtime-kernel/src/product.rs):628. Parser берёт top-level name или пустую строку; SQL запрещает NULL, но допускает пустое имя; response validation выполняется после insert transaction.

**Исправление / зависимости:** отдельные корректные V1/V2 projections, валидация проекции до insert, сохранение полного original/unknown fields. Согласовать с KR-08/09; очистка уже повреждённых записей требует отдельного недеструктивного repair решения.

**Приёмка:** nested V2 JSON/PNG и собственный export повторно импортируются; malformed/blank-name card не оставляет строк; list остаётся рабочим. Existing fixtures объявляют V2, но используют V1 top-level fields и маскируют проблему.

### KR-06 — Immediate crash recovery не восстанавливает исполнение

**Hosts:** все durable Kernel hosts. **Статус:** RUNTIME_CONFIRMED, `KR-FAST-RESTART` в security-witnesses.log.

**Симптом / ожидание:** после abrupt exit и быстрого reopening run остаётся streaming сразу и через 32 секунды на том же Kernel. Прежний executor должен быть признан завершившимся/прерванным, а durable output — доступным для recovery.

**Воспроизведение:** fake `steps=64;delay-ms=200;tokens-per-step=48`; после первого committed notice child делает exit(73) без Drop; parent немедленно открывает тот же root и проверяет run сразу и через 32 секунды.

**Источники и причина:** [kernel lib.rs](../../../crates/runtime-kernel/src/lib.rs):832; [generation.rs](../../../crates/runtime-kernel/src/generation.rs):52,181,2309–2317. Recovery выполняется только при startup и пропускает fresh 30-second leases. Периодического повторного recovery нет. [generation test](../../../crates/runtime-kernel/tests/generation.rs):594 специально ждёт 31 секунду до reopening.

**Исправление / зависимости:** различать lease предыдущего executing owner и durable waiting-for-tool; acquisition exclusive root lease доказывает отсутствие прежнего executor. Зависимость — lifecycle generation/tool wait.

**Приёмка:** быстрый restart делает старый executing run interrupted; partial output и events сохранены; retry через dispatch_stream, keep/discard работают; waiting tool не теряется. Harness ошибочно вызвал retry через unary dispatch: его operation-not-found не является доказательством runtime retry failure. State-conflict path известен только статически.

### KR-07 — Объявленные limits проверяются после полного чтения metadata

**Hosts:** configured OpenAI HTTP и storage export/import. **Статус:** STATIC_CONFIRMED.

**Симптом / ожидание:** длинный header/chunk-size/NDJSON line уже размещён в памяти к моменту rejection. Лимит должен ограничивать allocation и чтение до parse.

**Воспроизведение:** mock отдаёт длинную header line без newline или длинную chunk-size line; import container содержит NDJSON line существенно больше 1 MiB. Для проверки достаточно нескольких MiB, не host-threatening payload.

**Источники и причина:** [http.rs](../../../crates/provider-openai-compat/src/http.rs):181,189,262,266; [storage export.rs](../../../crates/storage/src/export.rs):2376,2395,2419. read_until/read_line не ограничены; проверка 8 KiB/64 bytes/1 MiB выполняется после growth. Второй NDJSON parsing pass снова читает без cap.

**Исправление / зависимости:** bounded delimiter scan/take(cap+1), ограничения во всех passes, общий import budget; устранить возможность изменения checked input между verify и parse. Зависимость — resource containment и profile import.

**Приёмка:** oversized line отвергается при cap+1 с ограниченной памятью; valid boundaries/truncation работают; target остаётся прежним при ошибке. Нельзя считать grep наличия limit доказательством containment.

### KR-08 — Импортированная personality не используется prompt pipeline

**Hosts:** все generation hosts. **Статус:** STATIC_CONFIRMED.

**Симптом / ожидание:** импорт сохраняет personality, но systemBlocks/provider request её не содержат. Поддерживаемые card поля должны влиять на prompt согласованно с импортом.

**Воспроизведение:** импортировать принимаемый текущим parser top-level fixture с personality; создать chat, generation и прочитать prompt plan/mock request.

**Источники и причина:** [imports.rs](../../../crates/runtime-kernel/src/imports.rs):283; [prompt.rs](../../../crates/runtime-kernel/src/prompt.rs):397–405. Import сохраняет `ext_json._card`, prompt ищет `ext_json.personality`/`persona` вне `_card`.

**Исправление / зависимости:** единая card projection для V1/V2 prompt fields; не уничтожать preserved object. Зависимость — KR-05.

**Приёмка:** personality появляется в systemBlocks и реальном request; unknown metadata сохраняется. Prompt fixtures с вручную вставленным top-level ext_json не проверяют реальный import путь.

### KR-09 — Export отдаёт original вместо актуального персонажа

**Hosts:** все card export hosts. **Статус:** RUNTIME_CONFIRMED в audit-witnesses-fixed.log.

**Симптом / ожидание:** canonical name после edits — `Audit EDITED`, exported name — исходное `Audit`; неизвестные extensions сохраняются. Export должен содержать текущие правки вместе с unknown fields.

**Воспроизведение:** импортировать принимаемую parser карточку; characters.update name/description/tags; characters.export.card; decode JSON.

**Источники и причина:** [product.rs](../../../crates/runtime-kernel/src/product.rs):730–782; [exports.rs](../../../crates/runtime-kernel/src/exports.rs):371–377. Update меняет canonical columns, preserved `_card` не синхронизируется; export отдаёт `_card` verbatim.

**Исправление / зависимости:** merge актуальных editable columns в корректный subtree V1/V2; original сохранять отдельно. Зависимость — KR-05/08 и экспортная совместимость.

**Приёмка:** export/reimport сохраняет edits и неизвестные extensions одновременно; исходные файлы не перезаписываются. Verbatim round-trip tests без intervening edits недостаточны.

### KR-10 — SecretStore error не откатывает memory mutation

**Hosts:** portable FileEncryptedSecretStore. **Статус:** STATIC_CONFIRMED.

**Симптом / ожидание:** failed put/delete меняет get/has в текущем процессе, хотя disk остаётся прежним. Отказ сохранения не должен менять активное состояние.

**Воспроизведение:** в disposable root сохранить old key; препятствовать записи temp sibling, например создать директорию на ожидаемом temp path; put(new) возвращает ошибку, get видит new, reopen исходного файла — old. Аналогично delete. Не применять к пользовательскому secrets.enc.

**Источники и причина:** [file.rs](../../../crates/secret-store/src/file.rs):405–425,440–448. Records меняются до persist_locked, ошибка propagates без rollback.

**Исправление / зависимости:** persist candidate state, публиковать memory state только после успешного atomic write. Зависимость — SecretStore failure atomicity; внешний API менять не требуется.

**Приёмка:** failed put/delete не меняет memory/disk; subsequent unrelated write не сохраняет failed mutation; crypto/lock/re-encryption сохраняют свойства. Existing crypto/tamper tests не проверяют I/O rollback.

### KR-11 — Provider I/O задерживает весь Kernel за deadline

**Hosts:** все hosts с blocking provider на единственном writer. **Статус:** RUNTIME_CONFIRMED, `KR-WRITER-STARVATION` в security-witnesses.log.

**Симптом / ожидание:** при run deadline 200 ms unary остаётся pending после 450 ms и завершается примерно за 1009 ms. Deadline, отмена и обычные команды должны обслуживаться независимо от первого content event.

**Воспроизведение:** mock после HTTP head выдаёт 20 строк `: ping\n` без пустого разделителя в течение 1 секунды; параллельно dispatch unary. Без blank delimiter это тест незавершённого SSE event; обычный complete heartbeat относится к KR-14.

**Источники и причина:** [http.rs](../../../crates/provider-openai-compat/src/http.rs):92,102–103,115; [provider lib.rs](../../../crates/provider-openai-compat/src/lib.rs):304–342,650; [generation.rs](../../../crates/runtime-kernel/src/generation.rs):1831,1970; [kernel lib.rs](../../../crates/runtime-kernel/src/lib.rs):728,1148. I/O выполняется inline на writer; drain только при emitted events; absolute deadline/cancel проверяются вне внутреннего next_event loop. DNS blocking, отсутствующий write timeout — дополнительно STATIC_CONFIRMED, отдельно не измерены.

**Исправление / зависимости:** вынести provider I/O за coordinator, bounded event channel и самостоятельное обслуживание команд; проверять absolute deadline/cancel на read/write boundaries. Зависимость — SDK execution seam и shutdown semantics.

**Приёмка:** unary/cancel до первого delta отвечают в установленный короткий срок; incomplete/heartbeat-only stream завершается по deadline; shutdown не ждёт неограниченного network I/O. Existing cancel-after-delta test не покрывает этот путь.

### KR-12 — Restore меняет DB, но не provider registry

**Hosts:** Kernel hosts с backups.restore/configured adapters. **Статус:** STATIC_CONFIRMED.

**Симптом / ожидание:** после restore config A runtime продолжает использовать endpoint/model B до restart. DB и runtime registry должны соответствовать восстановленному состоянию немедленно.

**Воспроизведение:** сохранить A; backup; изменить config на B; restore A; providers.list и mock generation без restart.

**Источники и причина:** [kernel lib.rs](../../../crates/runtime-kernel/src/lib.rs):845,966–984; [backup.rs](../../../crates/runtime-kernel/src/backup.rs):157. Restore заменяет db_next, state.registry не сбрасывается/не гидратируется; resolver уже читает новую DB.

**Исправление / зависимости:** восстановить hydrated state после успешной DB замены с явными правилами сохранения host-registered adapters. Зависимость — KR-02 и restore lifecycle.

**Приёмка:** providers.list/endpoint/model/key сразу соответствуют restored config; ошибки reopen оставляют явно описанное рабочее либо recovery состояние.

### KR-13 — Final budget не ограничивает фактический provider request

**Hosts:** все generation hosts. **Статус:** первая turn RUNTIME_CONFIRMED (`KR-PROMPT-BUDGET`), tool continuation STATIC_CONFIRMED.

**Симптом / ожидание:** contextLimit 64, responseReserved 16, inputTokens 253, overBudget true, но mock получает все 1000 input characters. Provider request не должен обходить final budget; превышение обязательного контекста требует явного отказа/согласованной стратегии.

**Воспроизведение:** configured model contextLimit 64, user message 1000 ASCII chars; сравнить plan и captured mock input. Для continuation: маленький initial plan, tool result около 5000 chars, маленький contextLimit; проверить второй request и пересчитанный plan.

**Источники и причина:** [prompt.rs](../../../crates/runtime-kernel/src/prompt.rs):574–583; [generation.rs](../../../crates/runtime-kernel/src/generation.rs):1385–1415,1435–1470,1769–1780,1970,2161. overBudget только вычисляется; исполнения gate нет. Extra tool messages добавляются к прежнему stored plan после budget без recount; schema tools также не учитывается в этом вычислении.

**Исправление / зависимости:** final request budget gate после формирования полного provider-visible контекста, с matched tool pairs и явными ошибками; response reserve согласовать с adapter output allowance. Зависимость — tokenizer/strategy rollout, Wire error metadata. Heuristic tokenizer сам по себе — документированное ограничение; отправка известного over-budget input — отдельный дефект.

**Приёмка:** mock не вызывается с известным превышением; обязательный excess даёт понятный stable error; tool continuation проходит recount и diagnostics фактического request; boundary tests включают schema/result overhead.

### KR-14 — Стандартный SSE heartbeat принимается за EOF

**Hosts:** все OpenAI-compatible streaming hosts. **Статус:** RUNTIME_CONFIRMED, `KR-SSE-HEARTBEAT` в security-witnesses.log.

**Симптом / ожидание:** `: ping\n\n` до data завершает run как completed и коммитит пустое assistant message. Comment/empty event должен пропускаться до data, DONE или настоящего EOF.

**Воспроизведение:** mock отправляет HTTP head, стандартный comment heartbeat, затем intended data позже. Witness: completed, partialTextLength 0, durable assistant content пустое до intended response.

**Источники и причина:** [provider lib.rs](../../../crates/provider-openai-compat/src/lib.rs):415,650–667. Blank separator возвращает take_buffered()==None; generate трактует любое None как end-of-stream. Это отличается от KR-11 с незавершёнными строками.

**Исправление / зависимости:** различать event-without-data и EOF; пропускать comments/empty events, сохраняя deadline/cancel checks. Зависимость — единый bounded SSE reader из KR-07/11.

**Приёмка:** heartbeat до/между deltas не обрывает generation, не создаёт пустой ранний message; DONE/EOF/malformed events корректно различаются; cancel/timeout не теряются.

## Ограничения, долг и адекватность тестов

| Область             | Подтверждённые положительные механизмы                                                                    | Что нельзя засчитать как полный PASS                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Storage             | Root OS lease, transactional migrations, WAL policy, checksum/FK/integrity gates, staged activation       | Single-root kill tests не доказывают изоляцию restore нескольких roots; KR-01/07                              |
| Generation          | Durable events, CAS revisions, delta+run transaction, explicit retry model                                | Delayed-reopen crash test пропускает KR-06; cancel-after-delta не проверяет KR-11                             |
| Provider SDK/OpenAI | Нормализованные ошибки, configured byte budget, OS trust verifier, нет штатного plaintext key fallback    | Sparse indices, empty SSE events и абсолютный deadline не покрыты; KR-02/03/07/11/14                          |
| Secrets             | Argon2id/AES-GCM, authenticated header, fresh nonce, fail-closed unavailable store, allowlist diagnostics | Crypto tests не доказывают failure atomicity или Debug redaction; KR-10                                       |
| Wire                | Generated request DTO validation и per-op request byte gate до enqueue                                    | Response gate после handler не доказывает bounded intermediate allocation и no-mutation-on-error; KR-04/05/07 |
| Remote HTTP         | Public bind требует auth, deny-by-default Origin, bounded audit ring, credential revoke recheck           | Security posture transport не устраняет shared writer blocking                                                |
| JNI/C ABI           | JNI handle registry/stale-handle checks, request bounds, panic guards                                     | Buffer tests meta.get не доказывают mutation safety; KR-04; физический Android NOT_RUN                        |
| Plugins/themes      | Durable trust/permission/lifecycle registry                                                               | Kernel registry не является package verifier, sandbox executor или доказательством cleanup после disable      |

Документированные ограничения текущего prompt pipeline: heuristic-v1 tokenizer, plain-messages-v1 и keyword memory retrieval. Это не реализованный полный tokenizer registry, набор instruct templates или semantic/vector RAG. [ADR-0038](../../adr/0038-canonical-rust-kernel-core.md), [ADR-0040](../../adr/0040-secret-store-port-format.md), [ADR-0041](../../adr/0041-versioned-data-roots-activation.md), [ADR-0046](../../adr/0046-m3-limited-waivers.md) и [ADR-0047](../../adr/0047-m4-limited-waivers.md) остаются архитектурными источниками; audit не меняет стек или waiver.

Подтверждённый долг по памяти: [storage export.rs](../../../crates/storage/src/export.rs):496–511,885 материализует все entity sections в Vec/HashMap; [exports.rs](../../../crates/runtime-kernel/src/exports.rs):117 читает полный chat export; [generation.rs](../../../crates/runtime-kernel/src/generation.rs):374 читает и конкатенирует весь delta output ради preview до 4096 chars. Нарушение bounded-processing подхода видно статически, но превышение RAM/latency budget на заданном каталоге здесь не измерено. Не приписывать этим местам выдуманные benchmark результаты.

Отдельная диагностическая хрупкость: MemorySecretStore/EnvSecretStore/FileEncryptedSecretStore имеют derived Debug, включающий secret records. Production sink, печатающий эти значения, не установлен: фактическую утечку логов audit не заявляет. Нужен redacted Debug и regression sentinel test. Provider delete не пересобирает registry, malformed config save оставляет прежний adapter; это соседние lifecycle случаи для исправления KR-02/12.

## Пересмотр прежнего аудита и порядок исправлений

[Прежний security audit](../../../audit-neoui-v4/10-SECURITY-VULNERABILITIES.md) объявляет JNI transport PASS на основании handle/panic/buffer bounds. Этот общий вывод больше неприменим: KR-04 подтверждён поведением неидемпотентного create. Проверки stale handles и panic guards сохраняют своё узкое значение.

Прежний тезис «presentation не трогает secrets» не доказывает правильный credential routing в Kernel: KR-02 воспроизводит неправильное соответствие endpoint/key без участия presentation. Android single-thread executor HOL из [старого каталога](../../../audit-neoui-v4/11-BUGS-AND-HACKS-CATALOG.md) не тождественен KR-11: новый witness подтверждает блокировку общего Rust writer. Status старого Android lifecycle defect остаётся за платформенным аудитом. WebView, camera и LAN cleartext пункты здесь повторно не проверялись и не получают новый PASS.

Последовательность: сначала KR-01/02/04/05 и сохранность существующих данных; затем KR-06/11/14 и жизненный цикл основных сценариев; затем единый resource/input/final-budget слой KR-03/07/13; затем card semantics KR-08/09, SecretStore atomicity KR-10 и restore registry KR-12. Взаимозависимые исправления объединять по общему источнику истины, но не переписывать соседние модули без необходимости. Каждый fix требует targeted behavioral regression, соответствующей документации и повторного packaged/physical прогона там, где он применим.
