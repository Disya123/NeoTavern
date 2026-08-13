# Техническое задание: NeoTavern — финальная мультиплатформенная local-first архитектура

**Версия:** 7.2  
**Статус:** целевая архитектурная спецификация  
**Заменяет:** ТЗ 5.0 и промежуточную архитектурную концепцию 6.0  
**Горизонт проектирования:** 10–15 лет  
**Стратегия:** product-first / local-first / host-neutral  
**Главный критерий:** ни сервер, ни мобильная платформа, ни конкретный runtime, ни SDK не должны навязывать свои ограничения остальной системе  
**Изменение 7.2:** сквозной аудит всех разделов и фаз; уточнены ownership,
durability, security, migrations, backup/restore, mobile lifecycle, phase gates и
измеримые критерии приёмки

---

# 0. Итоговое решение

NeoTavern не является сервером с набором клиентов и не является мобильным приложением, под ограничения которого подстраиваются остальные платформы.

Целевая модель:

```text
                       NeoTavern Product
                              │
              ┌───────────────┼───────────────┐
              │               │               │
       Public Contracts   Runtime Kernel   UI/Application
              │               │               │
              └───────────────┼───────────────┘
                              │
                             Hosts
                 ┌────────────┼────────────┐
                 │            │            │
              Desktop       Mobile      Headless
```

Отдельно подключаются:

```text
Transports
- Local IPC
- HTTP/SSE
- CLI

Extension runtimes
- Theme Runtime
- Node Plugin Runtime
- future Portable Plugin Runtime

Platform services
- secure storage
- files
- notifications
- background execution
- OS integration
```

Главный принцип:

```text
NeoTavern — один продукт с несколькими hosts.

Server включается, когда нужен server.
Mobile lifecycle включается, когда нужен mobile lifecycle.
SDK развивается независимо от внутреннего runtime.
DB меняется только когда реально меняется persistent model.
```

---

# 1. Что отменяется

Отменяются следующие архитектурные предположения:

1. HTTP server не является обязательным внутренним API NeoTavern.
2. Fastify не является центром application architecture.
3. Desktop не обязан общаться со своей локальной логикой через HTTP.
4. Android Standalone не обязан запускать Node или localhost server.
5. Headless/VPS не определяет ограничения остальных платформ.
6. Android lifecycle не определяет execution model Desktop/VPS.
7. Public SDK не зависит от языка реализации Runtime Kernel.
8. Версия приложения не равна версии базы данных.
9. Обновление приложения не означает обязательную migration.
10. Plugin SDK не равен Node runtime.
11. Theme SDK не зависит от private React tree или конкретного host.
12. Provider SDK не зависит от UI/HTTP transport.
13. Один host не обязан поддерживать все extension runtimes.
14. Отсутствие runtime на конкретной platform не означает отдельную реализацию product logic.
15. Cross-platform не означает lowest-common-denominator architecture.

---

# 2. Цели

NeoTavern должен:

- быть полноценным local-first приложением;
- работать на Windows, Linux и macOS;
- иметь полноценный Android target;
- сохранять архитектурную готовность к iOS target без объявления iOS частью
  первой обязательной поставки;
- работать как Headless/VPS application;
- иметь Web/Remote Client;
- поддерживать локальный и удалённый режимы одним UI contract;
- исключать ручное дублирование DTO между TypeScript и Rust;
- гарантировать единственного владельца writable data root;
- иметь одну authoritative реализацию persistent state transitions;
- использовать одну кроссплатформенную SQLite schema;
- использовать один migration engine;
- не мигрировать БД при каждом обновлении приложения;
- поддерживать безопасный process death;
- позволять Desktop включать remote access без server-first архитектуры;
- позволять Headless/VPS быть полноценным server host;
- не ограничивать Headless/VPS mobile lifecycle правилами;
- не требовать от Mobile server-only capabilities;
- считать mobile background execution прерываемым и не гарантированным по времени;
- сохранять быстрый цикл разработки SDK;
- сохранять Theme SDK на всех UI hosts;
- сохранять Plugin SDK как стабильный contract независимо от runtime;
- сохранять Provider SDK как стабильный contract;
- развивать SDK независимо друг от друга;
- поддерживать upgrade/recovery на горизонте 10–15 лет;
- оставаться сопровождаемым небольшой командой.

---

# 3. Не-цели

NeoTavern не должен:

- создавать собственный deployment orchestrator;
- создавать generic Durable Jobs Engine без реальной необходимости;
- создавать собственную СУБД;
- использовать Node Android как product foundation;
- использовать Termux как часть продукта;
- использовать Bun/Deno как обход Android lifecycle;
- запускать постоянный localhost server на Mobile;
- запускать постоянный backend daemon на Mobile;
- превращать Runtime Kernel в giant framework;
- переносить Theme SDK в Rust;
- переносить Plugin SDK в Rust;
- заставлять extension developers знать JNI/FFI/Tauri internals;
- создавать отдельный Android backend;
- создавать отдельные Android migrations;
- создавать отдельные server migrations;
- создавать отдельную mobile DB schema;
- связывать app version и schema revision;
- связывать версии всех SDK одной major version;
- менять DB schema только потому, что вышел release;
- вводить capability abstraction для каждой функции;
- строить внутренний глобальный `Map<String, bool>` capabilities;
- обеспечивать одинаковый runtime feature set на всех hosts;
- поддерживать любой legacy plugin бесконечно;
- выполнять big-bang rewrite;
- использовать SQLite data root на network filesystem или как shared writable
  volume между несколькими hosts;
- строить active-active/multi-writer deployment поверх одного SQLite-файла;
- считать arbitrary third-party JavaScript в основном WebView безопасным plugin
  sandbox;
- молча сохранять secrets в plaintext при недоступности secure storage;
- обещать точное время выполнения mobile maintenance.

Первая обязательная поставка включает Desktop, Android, Headless/VPS и Web
Remote. iOS остаётся design/build target до появления отдельного release gate и
полного набора device/lifecycle tests.

---

# 4. Приоритеты

При конфликте решений:

1. Целостность пользовательских данных.
2. Возможность восстановления.
3. Предсказуемость после kill/process death.
4. Стабильность публичных контрактов.
5. Простота обновления.
6. Простота разработки feature и SDK.
7. Ограниченный blast radius.
8. Понятность кода.
9. Кроссплатформенность.
10. Производительность.
11. Расширяемость.
12. Архитектурная чистота.

Архитектурная чистота не является основанием создавать слой без измеримой пользы.

---

# 5. Архитектурные зоны

## 5.1. Public Contracts

Стабильные внешние контракты:

```text
@neotavern/contracts
@neotavern/client-sdk
@neotavern/plugin-sdk
@neotavern/theme-sdk
@neotavern/provider-sdk
Remote API
Backup Format
Portable Export Format
```

Public Contracts не зависят от:

- Rust internal types;
- JNI;
- Node-API;
- Tauri commands;
- SQLite row layout;
- Fastify request objects;
- Android/iOS classes.

Основной публичный SDK-язык остаётся TypeScript/JSON/TypeBox там, где это естественно.

`@neotavern/contracts` содержит отдельный набор **Product Wire Contracts** —
DTO и операции, реально пересекающие TypeScript ↔ Rust boundary.

Для Product Wire Contracts:

- TypeBox schema является единственным hand-authored source of truth;
- TypeScript type выводится через `Static<typeof Schema>`;
- JSON Schema bundle и contract manifest генерируются детерминированно;
- Rust boundary DTO и decoder/validator генерируются из того же bundle;
- Local IPC и текущий Remote API projection используют canonical product DTO;
- предыдущие Remote API majors описываются versioned schemas в том же registry
  и переводятся explicit compatibility adapter-ом;
- OpenAPI/transport documentation, если публикуется, выводится из operation registry, а не ведётся вручную параллельно.

Запрещено вручную поддерживать пару:

```text
TypeScript interface X
Rust struct X
```

для одной и той же wire-сущности.

Это правило не запрещает отдельные internal Rust domain-типы. Они не являются
wire-контрактом и связываются с generated DTO через явный `TryFrom`/`From` mapping.

## 5.2. UI/Application

Содержит:

- React UI;
- navigation;
- screen composition;
- UI state;
- query/cache integration;
- feature availability presentation;
- Theme Runtime;
- UI Plugin contributions;
- `NeoBackend` facade;
- product-facing TypeScript utilities.

Presentation layer не является владельцем durable correctness.

## 5.3. Runtime Kernel

Небольшой переносимый native execution core.

Базовая реализация:

```text
Rust
```

Runtime Kernel отвечает за то, что действительно требует одной authoritative реализации:

- SQLite ownership;
- schema/migrations;
- transactions;
- durable operation state;
- recovery;
- backup primitives;
- import/export primitives;
- process-death-safe state transitions;
- generation durable state;
- built-in provider execution, если оно нужно на всех native hosts;
- product errors на persistent/execution boundary.

Runtime Kernel не является местом для всего кода NeoTavern.

## 5.4. Hosts

Основные hosts:

```text
Desktop Host
Mobile Host
Headless Host
Web Remote Host
Test Host
```

Host отвечает за:

- OS lifecycle;
- process model;
- platform services;
- transport activation;
- native integration;
- optional extension runtimes;
- scheduling;
- notifications;
- secure storage integration.

---

# 6. Dependency rule

Runtime Kernel не импортирует:

```text
Android
iOS
Desktop
Fastify
HTTP
React
Node Plugin Runtime
Theme SDK implementation
```

Public SDK не импортирует:

```text
Rust internal crates
JNI
Node-API
SQLite internals
```

На boundary допускается явная адаптация public DTO ↔ internal runtime DTO.

## 6.1. Canonical Product Wire Contract

Единственный hand-authored источник cross-language контрактов:

```text
packages/contracts/src/wire/
```

Для каждой операции в одном registry определяются:

- стабильный `operationId`;
- стабильный `schemaId` для каждого exported DTO;
- request schema;
- response schema;
- event schema для streaming operation;
- допустимые product error codes;
- feature/version metadata;
- execution class;
- idempotency/retry policy;
- required authorization scope;
- request/response/event size limits;
- политика unknown fields и backwards compatibility.

Пример принципа:

```ts
export const CharacterDtoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});

export type CharacterDto = Static<typeof CharacterDtoSchema>;
```

Отдельный hand-written `interface CharacterDto` рядом не создаётся.
Collision или отсутствие обязательного `operationId`/`schemaId` является
ошибкой contract compilation.

Выход contract compiler:

```text
packages/contracts/generated/
  contract.bundle.json
  contract-manifest.json
  fixtures/

crates/contracts-generated/
  src/
    generated/
```

`contract-manifest.json` минимум содержит:

```json
{
  "wireProtocol": {
    "major": 1,
    "minor": 0
  },
  "schemaDialect": "JSON Schema 2020-12",
  "schemaHash": "sha256:...",
  "ffiAbiVersion": 1,
  "generatorVersion": "...",
  "operations": {}
}
```

Точный JSON Schema dialect фиксируется. Его смена считается отдельной migration
contract toolchain, а не побочным эффектом обновления dependency.

Generated artifacts коммитятся в repository, чтобы:

- Rust build не требовал Node toolchain;
- diff контракта был виден в code review;
- release можно было воспроизвести;
- старые contract fixtures оставались доступными.

Редактировать generated artifacts вручную запрещено.

Выбор конкретного JSON Schema → Rust generator является implementation detail.
Generator обязан поддерживать утверждённый schema subset, быть version-pinned и
падать на unsupported construct. Silent fallback к `serde_json::Value` запрещён.

## 6.2. Boundary DTO ≠ Domain Model

Generated Rust DTO живёт только на transport boundary.

```text
untrusted transport value
          ↓
schema validation + generated DTO
          ↓
explicit TryFrom
          ↓
Runtime domain command/model
```

Runtime Kernel не сериализует наружу:

- SQLite row structs;
- repository models;
- provider-native payloads;
- internal enums;
- error chains;
- Rust-specific numeric или path types.

Изменение internal domain model не меняет wire contract автоматически.
Изменение wire contract требует явного schema diff и compatibility decision.

## 6.3. Logical operation registry

Local IPC, HTTP/SSE, CLI adapter и test host используют один logical operation
registry. Transport может отображать `operationId` на Tauri command, HTTP route
или CLI command, но не определяет собственные request/response DTO.

Registry может хранить несколько поддерживаемых Remote API projections.
Compatibility adapter выполняет:

```text
versioned remote DTO ↔ canonical current product DTO
```

Такой adapter не содержит product rules, генерируется/проверяется fixtures и
явно отказывает, если старую semantics невозможно представить без потери.

Минимальная logical envelope semantics:

```text
request  = contract metadata + requestId + operationId + payload
response = requestId + ok(result) | error(productError)
event    = requestId/streamId + sequence + tagged event payload
```

Transport не обязан физически посылать один generic envelope, если native
механизм имеет typed commands. Но наблюдаемая семантика, correlation,
cancellation, ordering и error model должны соответствовать registry.

Product Wire Contract задаёт logical JSON-compatible value. Конкретный transport
encoding может быть JSON или отдельно утверждённым binary encoding, но обязан
давать тот же decoded value и проходить общий conformance corpus. Transport
encoding не создаёт новую DTO-модель.

Все unions на wire используют явный string discriminator:

```json
{
  "type": "generation.delta",
  "text": "..."
}
```

Untagged unions и зависимость от порядка вариантов запрещены.

## 6.4. Validation и failure behavior

Transport boundary считается untrusted независимо от того, локальный он или
удалённый.

Обязательная последовательность:

```text
bytes/value
  ↓
parse
  ↓
schema/constraint validation
  ↓
generated DTO
  ↓
domain mapping
  ↓
Runtime operation
```

Требования:

- Runtime всегда валидирует request до domain operation;
- Runtime создаёт response/event только через generated DTO с эквивалентной
  проверкой constraints до отправки;
- TypeScript backend всегда валидирует response и event до передачи feature-коду;
- Remote Adapter валидирует HTTP payload до вызова Kernel;
- LocalBackend в development/tests валидирует outbound request той же schema;
- schema constraints (`format`, `pattern`, ranges, lengths) не теряются при Rust generation;
- default применяется только явным общим normalization rule; JSON Schema `default` сам по себе не меняет payload;
- parse/validation error не должен частично выполнять operation.

Raw `serde_json::Value` допустим только как короткоживущее значение до validation
и typed decoding. Он не передаётся в domain layer и не заменяет generated DTO.

Contract error имеет стабильную форму:

```ts
type ContractViolation = {
  code: 'contract_violation';
  operationId?: string;
  direction: 'request' | 'response' | 'event';
  contractMajor: number;
  correlationId: string;
  issues: Array<{
    path: string;
    rule: string;
  }>;
};
```

Raw payload, secrets и message content не включаются в telemetry по умолчанию.

На external payload запрещены:

- `unwrap`/`expect`;
- panic как error handling;
- unchecked cast;
- частичная десериализация с продолжением write operation;
- подмена неизвестного enum variant первым/default variant.

Ошибка контракта возвращается как controlled product/transport error. Kernel
panic считается bug и не является допустимой реакцией на несовместимый payload.

## 6.5. Local handshake и mismatch policy

До product calls backend получает contract metadata.

Для компонентов одного local application build:

```text
wireProtocol.major/minor + schemaHash должны совпасть точно
```

Если host использует direct FFI/JNI, его `ffiAbiVersion` также должен совпасть
точно до создания runtime handle.

При mismatch:

- обычные product operations, включая все writes, не запускаются;
- разрешены только `meta`, diagnostics и безопасный recovery flow;
- UI показывает incompatibility state с версиями компонентов;
- событие записывается в structured diagnostics;
- fallback к «примерно совместимой» структуре запрещён.

Это ловит stale WebView bundle, несовпавший sidecar/native library и ошибку
packaging до доступа к пользовательским данным.

Remote clients не требуют равенства `schemaHash`. Они используют Remote API
major/minor, feature negotiation и minimum client policy.

## 6.6. Wire-safe type rules

Product Wire Contracts используют переносимое JSON-compatible подмножество:

- только object, array, string, boolean, null и конечные JSON numbers;
- допускаются только TypeBox constructs, имеющие однозначное стандартное
  JSON Schema representation;
- `Type.Unsafe`, TypeScript-only conditional types и runtime transform,
  меняющий wire value, запрещены;
- `Date`, `Map`, `Set`, class instance, function, `BigInt`, `undefined`, `NaN` и infinity запрещены;
- отсутствие поля и `null` имеют разные явные значения;
- field naming задаётся schema и не зависит от Rust/TypeScript naming defaults;
- 64-bit identifiers/counters вне safe integer range передаются decimal string;
- JSON integer ограничен диапазоном безопасного точного представления в JavaScript;
- timestamp передаётся RFC 3339 string, duration — integer с указанной единицей;
- binary data передаётся bounded base64 только для малых payload, иначе через file/stream handle;
- enum и union используют string discriminator;
- ambiguous `anyOf`/`oneOf` без discriminator запрещён;
- custom `format` допускается только после регистрации одинаковой semantics
  в TypeScript и Rust validators;
- добавление enum variant считается breaking, если receiver не имеет явного `unknown` behavior;
- политика `additionalProperties` задаётся для каждого contract family;
- security-sensitive request/manifest по умолчанию strict;
- remote response может быть additive-tolerant только если это закреплено в schema и tests.

Размеры request, response и event ограничиваются на adapter boundary.

## 6.7. Contract versioning

Contract tooling строит semantic schema diff.

Breaking change:

- удаление field/operation;
- optional → required;
- изменение типа или смысла существующего field;
- narrowing range/enum;
- изменение discriminator;
- изменение error semantics;
- новый required response field для ранее поддерживаемого producer.

Обычно additive change:

- новая optional request capability;
- новое response field при tolerant receiver policy;
- новая operation;
- новый tagged event, если receiver имеет defined unknown-event behavior.

Правила:

- breaking public/remote change требует major version;
- minor change не может молча переиспользовать field с новым смыслом;
- contract и generated Rust DTO меняются одним PR;
- обновление generator выполняется отдельным PR с полным regenerated diff;
- schema hash считается от детерминированно canonicalized bundle;
- release хранит manifest и fixtures соответствующего contract.

## 6.8. Cross-language contract tests

Для каждой operation обязательны:

- positive golden request/response/event fixtures;
- negative fixtures: missing field, wrong type, unknown discriminator, range violation;
- одинаковый verdict TypeScript validator и Rust decoder/validator;
- TypeScript → JSON → Rust → JSON → TypeScript round-trip;
- Rust → JSON → TypeScript round-trip;
- stable product error mapping;
- LocalBackend/RemoteBackend semantic parity для общей feature surface;
- streaming ordering, cancellation и terminal-event tests.

PR CI:

```text
generate contracts
        ↓
working tree must remain clean
        ↓
schema compatibility diff
        ↓
TS/Rust golden + negative corpus
        ↓
Local/Remote parity
```

Nightly дополнительно выполняет schema-derived property tests и fuzzing
deserialization. Любой panic на произвольном input является test failure.

## 6.9. FFI/JNI ABI policy

Product Rust structs/enums не пересекают C ABI или JNI напрямую, даже с
`#[repr(C)]`. Layout Rust-типа не является Product Wire Contract.

Native ABI остаётся минимальным и состоит только из:

- ABI-safe primitives;
- opaque runtime/request/stream handles;
- UTF-8 operation identifier;
- length-delimited input/output buffers;
- стабильного status code;
- явных create/free/cancel functions.

Логическая модель:

```text
TypeScript/host value
       ↓ schema encode
bounded wire buffer
       ↓ thin FFI/JNI transport
Rust schema validation
       ↓ generated DTO
Runtime domain operation
```

Требования:

- payload следует тому же Product Wire Contract, что Local IPC и Remote Adapter;
- FFI bindings/wrappers генерируются из operation registry либо остаются generic transport wrappers;
- отдельные hand-written DTO для Swift/Kotlin/C не создаются;
- buffer allocator и сторона, обязанная освободить память, определены для каждого вызова;
- Rust allocation освобождается только экспортированной Rust free function;
- callback/thread affinity, lifetime и cancellation задаются явно;
- buffer size проверяется до allocation/parse;
- Rust panic и foreign exception не пересекают ABI boundary;
- outer FFI wrapper преобразует recoverable failure в status/error envelope;
- при `panic=unwind` outer Rust wrapper использует catch policy; при
  `panic=abort` process termination считается crash scenario и не выдаётся за
  controlled response;
- large binary/file data передаётся handle/stream mechanism, а не копируется в JSON.

`ffiAbiVersion` и `schemaHash` входят в local handshake. Несовместимый host не
получает runtime handle и не выполняет product operation.

---

# 7. Правило размещения логики

Логика переносится в Runtime Kernel, если она:

- владеет persistent state transition;
- должна одинаково работать на нескольких native/headless hosts;
- должна быть безопасна при process death;
- должна выполняться без WebView;
- нужна background execution;
- должна иметь единую SQLite transaction semantics;
- начала расходиться в нескольких реализациях;
- существенно упрощается общей native реализацией.

Логика остаётся в TypeScript/UI/Application, если:

- она presentation-only;
- относится к navigation/layout;
- не является source of truth;
- её потеря при UI recreation не ломает correctness;
- перенос в native не уменьшает стоимость сопровождения.

Для каждой мигрируемой feature фиксируется ownership record:

```text
source of truth
single writer
read path
rollback boundary
data migration status
```

Shadow reads и сравнение результатов допустимы. Shadow writes в legacy и Kernel
одновременно запрещены. В каждый момент у сущности существует ровно один
authoritative writer.

Принцип:

```text
Rust используется не потому, что он «правильнее»,
а потому, что конкретная логика выигрывает
от portable native runtime.
```

---

# 8. Целевая архитектура

```text
┌──────────────────────────────────────────────────────────────┐
│                    Public Contracts                          │
│ Theme SDK | Plugin SDK | Provider SDK | Client SDK | API     │
└────────────────────────────┬─────────────────────────────────┘
                             │
                    Product-facing API
                             │
              ┌──────────────┴──────────────┐
              │                             │
       UI/Application                Runtime Kernel
         TypeScript                       Rust
              │                             │
              └──────────────┬──────────────┘
                             │
                            Hosts
          ┌──────────────────┼──────────────────┐
          │                  │                  │
       Desktop             Mobile           Headless
          │                  │                  │
       Tauri              Tauri/native       HTTP/CLI
          │                  │                  │
      Local IPC          Local IPC       Remote Adapter
```

Remote clients:

```text
Web / Android Remote / Desktop Remote
                │
           Client SDK
                │
             HTTP/SSE
                │
        Remote Access Adapter
                │
          Runtime Kernel
```

---

# 9. Server — adapter, а не режим Kernel

Запрещено:

```text
Core::start(serverMode=true)
```

и platform branching внутри Kernel:

```text
if is_server
if is_android
```

Remote/server functionality является внешним adapter.

```text
Runtime Kernel
     ▲     ▲
     │     │
Local IPC  Remote Access Adapter
```

Kernel не знает, был ли operation вызван Desktop UI, Android UI, HTTP request, CLI или test.

Все adapters одного host обращаются к одному Kernel instance. Они не открывают
SQLite самостоятельно и не создают параллельный product service layer.

---

# 10. Remote Access Adapter

Содержит:

- HTTP listener;
- routing;
- SSE/WebSocket where needed;
- authentication;
- pairing;
- session/token handling;
- TLS integration;
- rate limiting;
- request size limits;
- compatibility handshake;
- Remote API versioning.

Он не владеет SQLite semantics и migration logic.

Security defaults:

- Remote Access выключен по умолчанию;
- без явной настройки listener bind-ится только на loopback;
- non-loopback требует TLS либо явно настроенного trusted reverse proxy boundary;
- forwarded client/proto headers принимаются только от configured proxy addresses;
- pairing выдаёт revocable scoped credential, а не бессрочный master token;
- tokens не передаются в URL и хранятся только в виде verifier/hash там, где это возможно;
- CORS/Origin policy deny-by-default; browser auth защищён от CSRF;
- auth проверяется до чтения body сверх минимального лимита;
- request, connection и stream limits задаются конфигурацией с безопасными defaults;
- SSE/WebSocket повторно проверяет срок действия/revocation credential;
- write retry разрешён только для operation с idempotency key/policy;
- audit events не содержат token, secret или raw user content.

Публичное включение listener без настроенных auth и transport security является
startup error.

---

# 11. Desktop Host

## 11.1. Обычный local mode

```text
React
  │
LocalBackend
  │
Tauri IPC
  │
Runtime Kernel
  │
SQLite
```

При выключенном Remote Access не требуются:

- listening port;
- HTTP server;
- network auth;
- server lifecycle.

Tauri IPC commands/scopes deny-by-default. WebView получает только product
operations и Host Services, нужные конкретному window/profile; generic shell,
arbitrary filesystem и unrestricted command surface запрещены. Production CSP
не допускает arbitrary remote scripts.

## 11.2. Remote Access включён

```text
                     Runtime Kernel
                      ▲          ▲
                      │          │
                 Local IPC    HTTP/SSE
                      │          │
                 Desktop UI   Remote Client
```

Remote Access Adapter является дополнительным service Desktop Host.

Его сбой не должен повреждать local state.

Local IPC и Remote Access используют один Kernel instance и один writer
coordinator. Remote Adapter не запускает второй writable process для того же
data root.

## 11.3. Optional plugin runtime

Desktop может запускать Node Plugin Runtime отдельно от основного Runtime Kernel.

Его crash допускается и не должен повреждать core data.

Node Plugin Runtime не наследует произвольно все environment variables и file
descriptors основного процесса. Доступ выдаётся через capability broker.

---

# 12. Headless/VPS Host

```text
neotavern-headless
├── Runtime Kernel
├── Remote Access Adapter
├── auth/TLS integration
├── scheduler
├── filesystem services
├── secure secrets
├── diagnostics
├── optional Node Plugin Runtime
└── CLI/admin integration
```

Headless может:

- работать 24/7;
- принимать много remote connections;
- выполнять долгие operations без mobile foreground restrictions;
- запускать server-only extension runtimes;
- выполнять scheduled maintenance;
- интегрироваться с systemd/container supervisor.

Mobile lifecycle ограничения к нему не применяются.

Один writable data root принадлежит ровно одному headless instance. Horizontal
scaling через общий SQLite volume, NFS/SMB или несколько writable replicas
запрещён. Для scaling требуется отдельная архитектура хранения и ADR.

Shutdown protocol:

```text
stop accepting new work
→ cancel/drain bounded operations
→ checkpoint durable workflow state
→ close adapters
→ close Kernel/SQLite
```

Hard kill всё равно должен восстанавливаться по общим durability rules.

---

# 13. Mobile Host

```text
Android/iOS Host
├── Runtime Kernel
├── LocalBackend
├── RemoteBackend
├── secure storage
├── files
├── background execution adapter
├── notifications
├── mobile lifecycle
└── UI
```

Mobile не обязан поддерживать:

- HTTP listener;
- server auth;
- Node plugin workers;
- desktop updater;
- system service model.

Отсутствие этих возможностей не изменяет Runtime Kernel.

Native bridge не выполняет blocking Rust/SQLite/provider work на UI/main thread.
Background worker может пересоздать Kernel после process death, но обязан
получить тот же data-root lease; одновременно два writable Kernel instance не
запускаются.

Android является обязательным mobile release target. iOS в этой версии ТЗ —
архитектурный target: общие contracts и Kernel должны собираться без
iOS-host acceptance до отдельного решения о поставке.

---

# 14. Web Host

```text
Web UI
  │
RemoteBackend
  │
Client SDK
  │
HTTP/SSE
```

Web не является владельцем основной NeoTavern DB.

Browser storage допускается для:

- cache;
- drafts;
- session-local state.

Cache namespace включает profile/server identity и authenticated user identity.
При переключении profile данные не переиспользуются между principals.
Credential не хранится в обычном browser storage, если доступно более безопасное
host-managed средство. Потеря browser storage не должна терять authoritative data.

---

# 15. NeoBackend

UI использует один product-facing facade.

```ts
interface NeoBackend {
  meta(): Promise<Meta>;

  characters: CharactersApi;
  chats: ChatsApi;
  lorebooks: LorebooksApi;
  presets: PresetsApi;
  generation: GenerationApi;
  backups: BackupApi;
}
```

Все типы методов `NeoBackend` импортируются из `@neotavern/contracts` или
выводятся из его operation registry. Параллельные feature-local DTO запрещены.

Реализации:

```text
LocalBackend
RemoteBackend
```

## 15.1. LocalBackend

```text
UI
 ↓
LocalBackend
 ↓
Tauri/native IPC
 ↓
Runtime Kernel
```

LocalBackend:

- не использует localhost;
- не открывает port;
- не реализует product rules;
- адаптирует local call/event stream;
- выполняет contract handshake до создания product session;
- преобразует transport failure в typed backend error;
- поддерживает cancellation и reattach для recoverable operation.

## 15.2. RemoteBackend

```text
UI
 ↓
RemoteBackend
 ↓
Client SDK
 ↓
HTTP/SSE
 ↓
Remote Access Adapter
```

Remote и Local должны иметь одинаковую product semantics там, где feature доступна.

Обе реализации проходят один generated contract suite. `RemoteBackend` может
добавлять auth/timeout/network errors, но не менять product result DTO.

Для previous Remote API major Client SDK нормализует versioned projection в
canonical DTO текущего UI только через проверенный compatibility adapter.

RemoteBackend автоматически повторяет только операции, помеченные registry как
идемпотентные. Для остальных timeout означает `outcome_unknown` до reconciliation
по request/idempotency key.

---

# 16. Profiles

Один Android/Desktop client может иметь:

```text
This Device
  → LocalBackend

Home PC
  → RemoteBackend

VPS
  → RemoteBackend
```

Remote cache и Local DB не смешиваются.

Каждый profile имеет отдельные:

- cache namespace;
- credentials;
- feature metadata;
- pending requests/streams;
- diagnostics scope.

Переключение profile отменяет UI subscriptions старого profile, но не
автоматически отменяет уже committed или recoverable operation.

---

# 17. Host Services

Не создаётся внутренний глобальный Capability Registry.

Используются конкретные typed services:

```text
SecretStore
FileServices
AppPaths
Notifications
BackgroundExecution
ShareService
OpenExternal
```

Kernel не должен содержать `isAndroid`, `isDesktop`, `isServer`.

Каждый Host Service имеет typed error model, availability probe и documented
thread/lifecycle contract. Недоступность secure storage, files или notification
permission не подменяется фиктивным success.

---

# 18. Классы операций

Класс задаётся для каждого `operationId` в registry и определяет transaction,
cancellation, retry, progress, concurrency и recovery semantics.

## 18.1. Transactional

Операция завершается в рамках одного request lifecycle.

Примеры:

- CRUD;
- settings;
- reads;
- bounded transaction.

```text
validate → authorize → transaction → commit → result
```

После commit cancellation не превращает operation в cancelled. Если transport
потерял response после commit, reconciliation выполняется по idempotency/request
key, а не повторным blind write.

## 18.2. Recoverable Workflow

Примеры:

- generation;
- import;
- restore;
- large backup;
- large conversion.

Каждый workflow имеет durable `workflowId`, отдельно от registry `operationId`,
revision, owner lease/heartbeat, progress и terminal result/error. Минимальные
состояния:

```text
queued → preparing → running → completed
                    ├────────→ failed
                    ├────────→ cancelling → cancelled
                    └────────→ interrupted
```

Разрешённые transitions задаются явно и выполняются compare-and-set transaction.
Terminal state неизменяем. Повторный запуск создаёт новый attempt либо
возобновляет старый только по documented resume policy.

Persistent workflow state принадлежит Runtime Kernel. Host может исчезнуть в
любой точке; lease expiry не означает автоматический retry side-effecting work.

## 18.3. Maintenance

Примеры:

- scheduled backup;
- cleanup;
- log rotation;
- optional sync.

Runtime предоставляет идемпотентную operation, host определяет best-effort
расписание. Scheduler delivery считается at-least-once: duplicate и delayed run
обязаны быть безопасны. Для каждого task определяются lease, deduplication key,
minimum interval и resource constraints.

## 18.4. Host Service

Примеры:

- HTTP listener;
- Remote Access;
- Node Plugin Runtime;
- OS listeners.

Host Service не является Runtime Kernel operation. Его lifecycle не хранится в
product workflow table, но startup/shutdown/failure behavior тестируется.

---

# 19. Mobile background execution

Correctness не строится на вечном процессе или точном времени запуска.

```text
Process может исчезнуть.
Committed data должно выжить.
Незавершённая operation должна быть объяснима после restart.
Scheduler может отложить, повторить или отменить работу.
```

Для активной user-visible долгой операции Mobile Host выбирает разрешённый OS
mechanism с видимой пользователю индикацией. Foreground execution не используется
для скрытой бессрочной работы и не считается гарантией завершения.

Host документирует mapping operation → разрешённый platform API/service type.
Если подходящего API/type/entitlement нет, capability возвращает unavailable, а
не запускает generic foreground service под неверной категорией.

Для deferred maintenance используется системный scheduler. Задачи проектируются
interruptible, idempotent и constraint-aware; exact schedule не обещается.

Runtime Kernel не знает названия конкретного Android/iOS API. Host обязан
обработать OS expiration callback: прекратить external work, зафиксировать
последний безопасный checkpoint и завершить execution lease.

---

# 20. Headless execution

Headless не обязан превращать все operations в mobile jobs.

Он может выполнять operation непрерывно, но supervisor restart, deploy, OOM и
hard kill считаются штатными failure scenarios.

Durable state transitions остаются kill-safe, а graceful shutdown имеет
ограниченный timeout и не является условием correctness.

```text
mobile lifecycle restrictions ≠ durability requirements
```

---

# 21. SQLite как единая кроссплатформенная БД

Одна SQLite database model используется на:

- Windows;
- Linux;
- macOS;
- Android;
- iOS;
- Headless/VPS.

```text
                     Runtime Kernel
                           │
                       SQLite
                           │
       ┌───────────┬───────┼───────┬───────────┐
       │           │       │       │           │
    Windows      macOS   Linux   Android      VPS
```

Не существует отдельных Android/Desktop/Server DB schemas.

Одинаковая schema не означает одновременный доступ разных machines к одному
файлу. Data root находится на локальном filesystem поддерживаемого host.

---

# 22. SQLite ownership

Runtime Kernel является authoritative владельцем:

- schema;
- queries/repositories;
- transactions;
- migrations;
- recovery;
- integrity checks;
- DB compatibility rules.

Для одной feature не должны бессрочно существовать две authoritative storage implementations.

До любого writable open Host получает exclusive application-level lease на data
root. Если lease уже принадлежит другому live process, второй process не
открывает DB writable и возвращает controlled `data_root_in_use`.

Lease использует OS locking primitive с автоматическим освобождением при crash;
PID/marker file служит только diagnostics и не считается доказательством
ownership. Lock acquisition проверяется integration tests на каждом filesystem
из support matrix.

Все SQLite connections создаются одним Kernel instance. Допускается bounded read
pool, но writes проходят через один writer coordinator; long-lived read
transactions ограничиваются, чтобы не блокировать checkpoint.

Запрещены:

- direct DB access из UI, plugin, provider, updater или backup utility;
- shared writable data root между containers/hosts;
- размещение active DB на NFS/SMB/cloud-synced folder;
- ручное копирование/замена DB при открытых connections.

---

# 23. SQLite runtime baseline

Используется контролируемый SQLite feature baseline.

SQLite library version, compile options и required extensions pin-ятся в release
manifest. Native/headless targets предпочтительно используют один tested bundled
baseline; исключение требует совместимого feature/bug-fix matrix.

Baseline release обязан содержать все upstream corruption fixes, применимые к
используемому journal/concurrency mode. Для WAL baseline, выпускаемого после
обнаружения WAL-reset race 2026 года, допустим SQLite ≥ 3.51.3 либо документированный
upstream backport этого исправления.

При каждом connection setup Runtime явно устанавливает и проверяет:

- `foreign_keys = ON`;
- bounded `busy_timeout`;
- выбранный journal mode;
- synchronous/durability policy;
- trusted schema/extension loading policy.

Write, подтверждённый пользователю как durable, по умолчанию использует policy,
сохраняющую commit при power loss (`synchronous=FULL` для WAL). Ослабление
допускается только отдельным ADR, benchmark и fault-injection доказательством
при явно более слабой product semantics.

WAL используется только после проверки поддержки VFS и успешного результата
pragma. Настраиваются checkpoint threshold, WAL size observability и recovery
при `SQLITE_BUSY`; бесконечный retry запрещён.

Запрещено без проверки зависеть от:

- platform-specific SQLite extensions;
- platform-specific collations;
- OS-specific DB behavior;
- loadable extensions в production;
- network filesystem locking;
- compile options, различающиеся между targets без compatibility test.

---

# 24. Cross-platform data rules

В DB запрещено без специальной причины хранить как canonical identity:

- абсолютные Windows paths;
- абсолютные Unix paths;
- Android content URI;
- temporary paths;
- platform file separators;
- process IDs;
- OS handles.

Используются:

- logical asset IDs;
- relative managed paths;
- stable IDs;
- normalized product metadata.

Дополнительно:

- timestamp хранится в UTC с явно заданной точностью;
- duration не выводится из wall-clock difference, если требуется monotonic time;
- identifiers не зависят от register locale или filesystem case sensitivity;
- text normalization/collation policy фиксируется для полей, где она влияет на identity;
- integer за пределами JavaScript safe range не выходит наружу как JSON number.

---

# 25. Assets

Пример storage:

```text
data/
├── database.sqlite
└── assets/
```

В DB хранится logical identity:

```text
assets
├── id
├── type
├── relative_key
├── checksum
├── size
└── metadata
```

Host передаёт root data directory.

Runtime не угадывает platform paths.

Asset content после публикации immutable. Рекомендуемый write protocol:

```text
write temp in same filesystem
→ flush/sync as supported
→ verify size/checksum
→ atomic rename to content key
→ commit DB reference
```

Crash до DB commit оставляет только orphan, который удаляет maintenance после
grace period. Удаление сначала убирает DB reference, а физический blob удаляется
отложенным GC. Это предотвращает DB reference на отсутствующий файл.

Symlink/hardlink traversal вне managed data root запрещён. Case collision,
reserved names, path length и disk-full входят в cross-platform tests.

---

# 26. Независимые версии данных

Запрещено:

```text
appVersion == databaseVersion
```

Используются:

```text
appVersion
storageFormat
schemaRevision
```

Пример:

```text
NeoTavern app:   5.8.1
storageFormat:   1
schemaRevision:  43
```

---

# 27. App Version

`appVersion` меняется при release приложения.

Он не вызывает migration автоматически.

`appVersion` относится к конкретному distributed artifact/host build; Desktop,
Android и Headless releases могут выходить не одновременно. Совместимость не
выводится из appVersion — для неё используются отдельные protocol/storage axes.

```text
5.8.0 → schema 43
5.8.1 → schema 43
5.9.0 → schema 43
5.10.0 → schema 44
```

Migration выполняется только если persistent model реально изменилась.

---

# 28. Storage Format

`storageFormat` меняется редко и только при фундаментальном изменении:

- новая storage technology;
- новая encryption model;
- несовместимая asset layout model;
- радикально новый DB/container format.

Обычная schema migration не меняет `storageFormat`.

---

# 29. Schema Revision

`schemaRevision` отражает SQLite schema/data revision.

```text
37 → 38 → 39 → 40
```

Новый app release может не менять её.

---

# 30. DB metadata

Используются:

```sql
PRAGMA application_id;
PRAGMA user_version;
```

и metadata tables:

```sql
CREATE TABLE __neotavern_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE __neotavern_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
```

`application_id` имеет фиксированное project значение.
`user_version` обязан равняться committed `schemaRevision`.
`storageFormat` хранится в metadata table. При расхождении дублированных
metadata Runtime не выбирает значение эвристически, а переходит в Recovery Mode.

Migration ledger обновляется в той же transaction, что schema/data change.
`id` уникален и монотонен внутри storage format; checksum считается от
canonical migration bytes вместе с declared metadata.

---

# 31. Открытие DB

```text
1. Resolve canonical local data root
2. Acquire exclusive data-root lease
3. Open in inspection/read-only mode without mutation
4. Verify application_id and metadata consistency
5. Read storageFormat/schemaRevision
6. Compare supported range and migration history
7. Reopen/enable writable mode only after compatibility decision
8. Open / migrate / convert / reject
```

Runtime знает:

```text
supportedStorageFormat
minDirectSchema
currentSchema
```

До compatibility decision запрещены journal-mode change, checkpoint, migration,
plugin startup и любые implicit writes.

---

# 32. DB compatibility

```text
DB < minDirectSchema
      ↓
legacy converter

minDirectSchema <= DB < currentSchema
      ↓
normal migrations

DB == currentSchema
      ↓
open

DB > currentSchema
      ↓
read-only diagnostics/recovery only
```

Старая версия NeoTavern не должна молча писать в более новую DB. Даже
«безопасная» настройка, checkpoint или plugin write считается записью.

---

# 33. Fresh install

Fresh install не проигрывает всю историю migrations.

```text
schema/current.sql
       ↓
currentSchema
```

`current.sql` генерируется/проверяется детерминированно. CI сравнивает schema
fingerprint fresh install с DB, полученной миграцией из каждой поддерживаемой
baseline revision; intentional data-only differences описываются отдельно.

---

# 34. Migration support window

Пример:

```text
currentSchema = 100
minDirectSchema = 75
```

75–100 обновляется штатно.

Schema < 75 обслуживается legacy converter.

Основной runtime не обязан хранить migration chain навечно.

Legacy converter:

- читает старый data root без in-place mutation;
- пишет новый candidate data root текущего storage format;
- сохраняет исходник до успешной validation/activation;
- имеет fixtures для minimum supported legacy releases;
- отказывает controlled error для неподдерживаемой версии.

Нижняя граница поддержки, срок deprecation и последний release с converter
публикуются заранее. «10–15 лет recovery» означает документированный путь через
archived converter, а не вечное хранение всей migration chain в основном binary.

---

# 35. Migration checksums

После публикации migration не меняется тихо.

Хранятся:

```text
id
name
checksum
applied_at
```

Hash mismatch вызывает diagnostic/recovery failure, а не silent continuation.

Checksum не пересчитывается из platform line endings или локального SQL tooling.
Изменение уже опубликованной migration создаёт новую migration/repair procedure,
но не переписывает history.

---

# 36. Migration risk classes

Каждая migration содержит machine-readable manifest:

```text
id
risk
estimated temporary disk multiplier
transactional/non-transactional
minimum source revision
preconditions/postconditions
backup requirement
resume/rollback strategy
```

Слова «small», «large» и «significant» получают числовые thresholds из
benchmark policy конкретного release.

## LOW

- new table;
- nullable column;
- safe index;
- small additive metadata.

Требования:

- полностью transactional apply/rollback;
- postcondition;
- tests.

Backup не обязателен, если rollback полностью защищает данные.

## MEDIUM

- significant backfill;
- substantial transform;
- several related tables;
- large index.

Требования:

- verified pre-migration recovery snapshot;
- transaction;
- progress reporting, если benchmark превышает interactive blocking budget;
- postconditions.

## HIGH

- table rebuild;
- destructive removal;
- asset layout migration;
- large BLOB conversion;
- non-transactional change.

Требования:

- verified pre-migration recovery snapshot;
- disk-space preflight;
- recovery plan;
- integrity checks;
- large-fixture tests;
- isolated candidate либо documented per-step recovery journal.

---

# 37. Expand → Migrate → Contract

Сложные schema changes по возможности разбиваются на releases.

```text
Release A: добавить новую структуру
Release B: backfill
Release C: переключить основное чтение/запись
Release D: удалить legacy representation
```

Не выполнять `ADD + full backfill + DROP + rebuild` в одном release без необходимости.

---

# 38. Migration flow

```text
1. Hold exclusive data-root/migration lease
2. Stop new product writes and extension runtimes
3. Read metadata; validate history/checksums/preconditions
4. Estimate work and verify free space
5. Create and verify recovery snapshot if policy requires
6. Record recoverable migration intent when non-transactional
7. Begin transaction or build isolated candidate
8. Apply migration with bounded progress reporting
9. Validate postconditions
10. Update ledger + schema revision in the same commit
11. Commit or atomically activate candidate
12. Run quick integrity check and product invariants
13. Resume normal services
```

Migration cancellation разрешена только до declared point-of-no-return.
После него UI предлагает ждать/recover, но не обещает мгновенную отмену.

---

# 39. Kill во время migration

До commit:

```text
SQLite rollback/recovery
```

Новая schema revision не считается применённой.

Для non-transactional migration используется только локальный специализированный recovery state.

Automatic blind replay запрещён при неоднозначном состоянии.

Предпочтительный HIGH/non-transactional путь — построить candidate data root и
атомарно переключить указатель/директорию после полной проверки. In-place step
обязан иметь идемпотентный resume marker для каждого необратимого шага.

Startup сначала завершает SQLite hot-journal/WAL recovery штатным API, затем
анализирует migration intent. Удалять или отделять `-wal`/`-journal` вручную
запрещено.

---

# 40. Backup

Backup является full recovery format.

Public backup container строится поверх internal recovery snapshot primitive
Phase 2. Internal snapshot может не иметь public archive packaging, но обязан
иметь ту же DB/assets consistency и verification guarantees.

```text
.neotavern-backup
├── manifest.json
├── checksums.json
├── database.sqlite
└── assets/
```

Пример manifest:

```json
{
  "format": "neotavern-backup",
  "formatVersion": 1,
  "createdAt": "...",
  "createdBy": {
    "appVersion": "5.8.1",
    "platform": "android"
  },
  "storage": {
    "storageFormat": 1,
    "schemaRevision": 43
  }
}
```

`platform` informational.

Backup должен восстанавливаться на другой поддерживаемой platform.

Backup container дополнительно содержит file inventory с logical path, type,
size и cryptographic checksum. Формат явно задаёт:

- archive/container encoding;
- filename normalization;
- maximum entry/total sizes и compression-ratio limits;
- duplicate/path-collision policy;
- required/optional sections;
- включение namespaced plugin state;
- отсутствие cache, logs, access tokens и provider secrets.

Unknown required section приводит к controlled incompatibility error. Unknown
optional section может быть сохранён/пропущен только по правилам format version.

---

# 41. Consistent backup

Обычный copy активного `database.sqlite` не считается пользовательским backup contract.

Backup создаёт consistent SQLite snapshot безопасным штатным mechanism.

Assets попадают в согласованный manifest/checksum state.

Raw copy открытого `database.sqlite` запрещён. Используется SQLite Online Backup
API или другой доказанно consistent snapshot mechanism.

Согласование DB и assets:

```text
1. Start backup lease; block asset GC
2. Commit all pending asset references
3. Create SQLite snapshot
4. Read referenced immutable asset set from snapshot
5. Copy exactly that set
6. Verify every size/checksum
7. Finalize manifest atomically
8. Release backup lease
```

Новые assets после DB snapshot не обязаны входить в backup. Удаляемые blobs
удерживаются backup lease до завершения. Незавершённый backup остаётся
невалидным temp artifact и не показывается как готовый.

---

# 42. Restore

```text
1. Acquire exclusive data-root/restore lease
2. Parse bounded manifest before extraction
3. Reject traversal, links, duplicates, collisions and quota violations
4. Validate format/support window and checksums
5. Verify required free space
6. Create and verify safety snapshot of current state where readable
7. Extract into a new candidate directory on the same filesystem
8. Open candidate через normal Runtime Kernel
9. Apply supported migrations/converter only inside candidate
10. Run SQLite integrity + product + asset-reference checks
11. Close candidate and atomically activate it
12. Retain previous state until next successful startup/explicit cleanup
```

Нет отдельных Android/server restore migrations.

Если current state слишком повреждён для safety snapshot, исходный data root всё
равно сохраняется неизменным/переименованным, а продолжение требует explicit
user confirmation. Restore не уничтожает единственную копию даже в Recovery Mode.

Restore никогда не распаковывает поверх active data root. Ошибка или kill до
activation оставляет текущий state активным. Kill во время activation
разрешается startup marker-ом, который однозначно выбирает полностью проверенный
candidate либо previous state.

---

# 43. Portable Export

Backup не является вечным public interchange format.

Для долгоживущих пользовательских данных:

```text
.neotavern-export
├── manifest.json
├── characters.ndjson
├── chats.ndjson
├── messages.ndjson
├── lorebooks.ndjson
├── presets.ndjson
└── assets/
```

Portable Export не содержит внутреннее runtime state без необходимости.

`manifest.json` содержит `exportFormat`, schema version каждой record family,
createdAt, producer metadata и inventory/checksums. NDJSON records используют
stable IDs и explicit reference semantics; порядок records не несёт скрытого
смысла.

Import:

- валидирует лимиты и все records до authoritative activation;
- определяет duplicate-ID policy (`reject`, `replace` или `remap`) явно;
- поддерживает referential integrity report;
- выполняется как recoverable workflow в staging/candidate state;
- не импортирует credentials, device paths, transient operation state или logs.

Export compatibility fixtures считаются долгоживущими public data contract и
не удаляются вместе с обычным DB migration window.

---

# 44. Public SDK architecture

Основные packages:

```text
@neotavern/contracts
@neotavern/client-sdk
@neotavern/plugin-sdk
@neotavern/theme-sdk
@neotavern/provider-sdk
```

SDK developer не должен знать о:

```text
Rust traits
JNI
Node-API
SQLite tables
Tauri internals
Android lifecycle
```

---

# 45. Независимые version axes

Пример:

```text
NeoTavern App     5.8.1
DB Format         1
DB Schema         43
Product Wire      1.0 (local schemaHash)
Local FFI ABI     1 (если используется)
HTTP API          5.3
Plugin API        4.2
Theme API         3.1
Provider API      2.4
Backup Format     1
Export Format     1
```

Обновление одной оси не обязано менять остальные.

Для каждого axis публикуются:

- compatibility rule;
- minimum/maximum supported version;
- deprecation date или release window;
- negotiation source;
- fixtures последней поддерживаемой версии.

SemVer package version и protocol version не считаются взаимозаменяемыми без
явного mapping.

---

# 46. SDK update policy

Additive capability обычно minor change.

```text
Plugin API 4.2 → 4.3
```

не требует автоматически:

- DB migration;
- Theme API bump;
- Provider API bump;
- Runtime Kernel rewrite;
- изменения всех hosts.

Breaking semantic change требует major.

Текущий и предыдущий поддерживаемый major проверяются CI, пока support policy не
объявила его end-of-life. Deprecation сначала становится diagnostic warning;
silent removal surface запрещён.

---

# 47. Theme SDK

Theme SDK является UI-level public contract.

Целевая поверхность UI hosts:

- Web;
- Desktop;
- Android;
- iOS (planned, не release gate текущего scope).

Headless не имеет Theme Runtime, потому что не имеет UI renderer.

Публичны:

- semantic tokens;
- component roles;
- slots;
- states;
- shell regions;
- density;
- motion preferences;
- responsive semantic environment.

Не публичны:

- exact React tree;
- private CSS class names;
- случайный DOM order;
- platform-specific internal component names.

---

# 48. Theme portability

Theme не должна делать:

```text
if Android
if Windows
```

Предпочтительные environment signals:

```text
viewport class
pointer precision
hover support
orientation
safe area
density
reduced motion
```

UI Host адаптирует layout.

Новые tokens/roles по возможности получают fallback.

Theme package не исполняет JavaScript, не загружает remote code/font/import и не
может ослаблять CSP. URL/asset references проходят host allowlist и size limits.
Theme с неизвестным required role отклоняется до activation; предыдущая
работающая theme остаётся доступной.

---

# 49. Plugin SDK

Plugin SDK является public contract, а не runtime.

Он включает:

- manifest;
- API version;
- permissions;
- capability/security contract;
- lifecycle contract;
- cleanup semantics;
- UI contribution contract;
- runtime entrypoint metadata.

```text
Plugin Contract ≠ Plugin Runtime
```

---

# 50. Node Plugin Runtime

Поддерживается там, где оправдано:

- Desktop;
- Headless/VPS.

Является optional Host Service.

Он не владеет:

- core SQLite DB;
- migrations;
- единственной копией данных;
- core recovery.

Его crash не должен ломать Runtime Kernel.

Минимальная isolation model:

- отдельный child process от Kernel/UI;
- host-mediated IPC с schema validation;
- permissions проверяются broker-ом на каждом privileged call;
- scoped filesystem/network access, deadlines, output/queue/CPU/memory limits;
- no inherited master secrets;
- crash/timeout приводит к отключению конкретного plugin;
- один plugin не блокирует event loop/queue другого без bounded isolation policy.

OS sandbox используется где доступен. Если platform не может обеспечить
заявленную isolation, UI показывает reduced-isolation warning и запрещает
permissions, требующие отсутствующего boundary.

---

# 51. Mobile plugins

Mobile не обязан запускать Node backend plugins.

Он может поддерживать:

- Theme SDK;
- mobile-compatible UI plugin contributions;
- remote backend plugins через server;
- future portable plugin runtime.

Node runtime availability отражается явно.

Arbitrary third-party JavaScript не загружается в основной Mobile WebView.
Mobile UI contribution должна быть:

- declarative schema, которую рендерит Host; либо
- isolated execution surface с capability broker и отдельным security review.

До реализации одного из этих вариантов mobile поддерживает только trusted
built-in contributions и data-only manifests.

---

# 52. Future Portable Plugin Runtime

Portable runtime рассматривается только при реальном спросе.

Он создаёт:

- новый runtime;
- sandbox boundary;
- permission model;
- resource limits;
- compatibility surface.

Поэтому требует отдельного ADR и не блокирует Mobile release.

---

# 53. Plugin UI contributions

Используются semantic slots:

```text
chat.header.actions
chat.message.actions
character.editor.actions
settings.section
generation.controls
```

Один slot может визуализироваться по-разному:

```text
Desktop → inline toolbar
Mobile  → overflow / bottom sheet
```

Plugin contract не меняется.

Slot contribution описывает:

- stable slot ID;
- declarative content/action schema;
- required permission;
- priority/order constraints;
- bounded state and event model;
- fallback when slot/feature is unavailable.

Host контролирует rendering, focus/accessibility, navigation и escaping. Plugin
не получает React component instance, DOM reference или private application
store.

---

# 54. Plugin permissions

Permissions — security contract и не смешиваются с internal Host Services.

Примеры:

```text
chat.read
chat.write
assets.read
network.request
settings.register
ui.slot.contribute
```

Plugin не получает неконтролируемый direct SQL access к core tables.

Permissions:

- deny-by-default;
- подтверждаются пользователем для sensitive scope;
- привязаны к plugin identity и approved permission set; update не расширяет
  grant без нового подтверждения;
- могут быть отозваны без удаления plugin;
- проверяются server-side/broker-side, а не только скрытием UI;
- имеют negative tests для denied/revoked state.

Plugin persistent state хранится в namespaced storage с quota и собственной
version metadata. Plugin migration не выполняет SQL над core tables. Backup,
restore, export и deletion policy для namespace объявляются manifest-ом.
Plugin secrets хранятся только через scoped SecretStore API и никогда не
попадают в namespaced backup/export state.

---

# 55. Provider SDK

Provider SDK определяет:

- config;
- models;
- generate;
- stream;
- cancellation;
- usage;
- normalized errors.

Vendor types не выходят за adapter boundary.

Built-in providers, необходимые local mode, имеют portable implementation.

Public Provider SDK при этом не становится Rust SDK.

Provider получает credential через scoped host flow. Secret не попадает в
request snapshot, logs, diagnostics, plugin state или backup. Config schema
отделяет secret references от non-secret settings.

Timeout, cancellation, retry и usage accounting нормализуются на adapter
boundary. Retry policy учитывает idempotency provider call и никогда не создаёт
скрытый двойной billable request без documented reconciliation.

---

# 56. Third-party providers

Первый supported third-party runtime может оставаться Node-based на Desktop/Headless.

Mobile может иметь:

```text
third-party provider runtime: remote-only
```

до появления portable runtime.

Public Provider SDK contract остаётся единым.

---

# 57. Client SDK

Client SDK является SDK удалённого доступа.

Содержит:

- typed requests;
- typed responses;
- auth hook;
- timeout;
- cancellation;
- streaming/SSE;
- product errors;
- `/meta` compatibility handshake.

LocalBackend не обязан использовать Client SDK внутри приложения.

Client SDK:

- не retry-ит non-idempotent write автоматически;
- поддерживает idempotency/request key там, где это объявлено contract;
- различает timeout до send, outcome unknown и confirmed product error;
- ограничивает response/event sizes;
- при reconnect восстанавливает stream по sequence/cursor либо запрашивает snapshot;
- не логирует auth headers и payload по умолчанию.

---

# 58. Remote API

HTTP API является Remote Access Protocol, а не application architecture.

```text
HTTP Request
   ↓
Remote Adapter
   ↓
Product/Runtime operation
   ↓
Product Result
   ↓
HTTP Response
```

---

# 59. Compatibility metadata

Пример Remote `/meta`:

```json
{
  "appVersion": "5.8.1",
  "api": {
    "major": 5,
    "minor": 3
  },
  "productWire": {
    "major": 1,
    "minor": 0
  },
  "minimumClientVersion": "5.6.0",
  "features": {
    "generation": 3,
    "backups": 2,
    "plugins": 4,
    "themes": 3
  }
}
```

LocalBackend получает эквивалентную product metadata напрямую.

`minimumClientVersion` является дополнительной distribution policy, а не заменой
protocol negotiation. Решение о совместимости сначала принимает API
major/minor + feature versions, затем product policy.

---

# 60. Feature availability

Каждая feature определяет собственную availability.

```ts
type Availability =
  | { status: 'available' }
  | { status: 'degraded'; code: AvailabilityCode; detail?: string }
  | { status: 'unavailable'; code: AvailabilityCode; detail?: string };
```

Availability может учитывать:

- host capability;
- runtime availability;
- remote feature version;
- permissions;
- network state.

`AvailabilityCode` — versioned closed set с explicit unknown fallback в UI.
`detail` предназначен для safe user-facing diagnostic и не используется для
programmatic branching.

---

# 61. Host capability matrix

| Capability | Desktop | Android | iOS | Headless/VPS | Web |
|---|---:|---:|---:|---:|---:|
| Runtime Kernel | required | required | planned | required | N/A |
| Local SQLite | required | required | planned | required | N/A |
| LocalBackend | required | required | planned | N/A | N/A |
| RemoteBackend | required | required | planned | N/A | required |
| HTTP server | optional | forbidden | forbidden | required | N/A |
| Remote Access Host | optional | forbidden | forbidden | required | N/A |
| Theme SDK | required | required | planned | N/A | required |
| Node Plugin Runtime | optional | forbidden | forbidden | optional | N/A |
| Mobile background adapter | N/A | required | planned | N/A | N/A |
| Scheduled maintenance | while-running | best-effort | planned/best-effort | required | N/A |
| Portable Plugin Runtime | future | future | future | future | future |

Матрица описывает Host capabilities, а не branching внутри Runtime Kernel.

`required` означает release gate текущего scope; `planned` — compile/design
constraint без обещания поставки; `best-effort` — OS может отложить или отменить
запуск. Значение capability сообщает runtime metadata, а не определяется по
названию platform.

---

# 62. Generation durable state

Generation является recoverable operation.

Пример logical state:

```text
generation_runs
├── workflow_id
├── chat_id
├── status
├── request_snapshot_without_secrets
├── provider
├── model
├── checkpoint
├── attempt
├── revision
├── lease_expires_at
├── last_event_sequence
├── started_at
├── updated_at
└── error_code
```

Минимальные статусы:

```text
queued
preparing
streaming
completed
failed
cancelling
cancelled
interrupted
```

Checkpoint хранится bounded chunks/segments, а не переписывает неограниченный
`partial_text` на каждый token. Частота checkpoint имеет durability/performance
budget. Secret/credential и transient provider handle не сохраняются.

---

# 63. Generation lifecycle

Перед provider call critical input/state фиксируется transaction.

После успешного completion final message/state фиксируется transaction.

Если process исчез во время `preparing`/`streaming`, startup recovery переводит stale run в:

```text
interrupted
```

UI может предложить:

```text
Retry
Keep partial
Discard
```

`Keep partial`/`Discard` являются отдельными idempotent commands над partial
artifact. Они не переписывают terminal history run и не удаляют данные,
необходимые для reconciliation/audit, до retention policy.

Automatic blind retry запрещён, если request не доказанно idempotent.

Дополнительные invariants:

- только executor с актуальным lease может публиковать checkpoint/terminal state;
- state transition выполняется compare-and-set по `revision`;
- terminal state и final message фиксируются атомарно либо связаны durable
  reconciliation marker;
- cancellation является request, пока executor не подтвердил `cancelled`;
- late provider output после cancellation/lease loss не попадает в chat;
- Retry создаёт новый attempt с ссылкой на исходный run и не повторяет
  billable request скрыто;
- startup recovery не помечает active run interrupted только по wall-clock без
  lease/process identity check.

---

# 64. Streaming

Product event model один.

Remote:

```text
Runtime → HTTP/SSE → RemoteBackend → UI
```

Local:

```text
Runtime → native channel → LocalBackend → UI
```

UI не имеет две разные generation semantics.

Delivery semantics — at-least-once. Каждое событие имеет `streamId`,
монотонный `sequence` и typed terminal event. UI дедуплицирует sequence.

После disconnect/recreation backend:

- продолжает с последнего retained sequence; либо
- возвращает durable snapshot/checkpoint и новый cursor;
- никогда не выдаёт потерю stream как `completed`.

Slow consumer получает bounded buffer policy: backpressure, coalescing
checkpoint events или controlled `consumer_lagged`, но не unbounded memory.

---

# 65. Mobile foreground operation

Если user-visible generation должна продолжаться после ухода UI в фон:

```text
Mobile foreground execution adapter
        │
        ▼
same Runtime Kernel
```

Platform Service реализует lifecycle/notification, но не prompt/provider/DB logic.

Если OS не разрешает продолжение, run остаётся recoverable/interrupted. UI не
обещает completion в фоне до фактического подтверждения Host capability.

---

# 66. Maintenance scheduling

Mobile:

```text
OS Scheduler → Host Worker → Runtime maintenance
```

Desktop:

```text
startup/timer/idle → Runtime maintenance
```

Headless:

```text
process/system scheduler → Runtime maintenance
```

Нет универсального собственного scheduler framework.

Maintenance operation получает stable deduplication key и lease. Mobile
scheduler может повторить или пропустить окно; Desktop timer существует только
пока Host запущен; Headless scheduler обязан переживать restart через supervisor
или persistent next-run state.

---

# 67. Kill-safe storage

Обязательны:

- SQLite transactions;
- controlled journal mode; WAL только по policy раздела 23;
- foreign keys;
- busy timeout;
- verified synchronous policy раздела 23;
- commit before confirmed write response;
- temp file + atomic rename для file replacement;
- no critical state only in memory;
- recovery check after suspicious exit;
- durable operation state для long destructive workflows.

Для critical file replace используются temp file на том же filesystem,
flush/sync файла и parent directory там, где platform это поддерживает, затем
atomic rename. Если filesystem не предоставляет нужные guarantees, operation
использует versioned files + committed pointer/recovery marker.

`commit before confirmed write response` включает successful commit result и
configured durability barrier. Long external I/O не держит SQLite write
transaction открытой.

---

# 68. Secrets

Platform boundary implementations:

```text
Desktop → OS/Tauri secure storage
Android → Keystore-backed
iOS → Keychain-backed
Headless → env/restricted secret file/external secret provider
```

Provider SDK не зависит от конкретного secret backend.

Secure storage unavailable/locked возвращает typed availability error; fallback
в plaintext запрещён. Secrets namespaced по profile, поддерживают revoke/rotate
и не включаются в backup, Portable Export, logs или diagnostics.

Headless использует environment/external provider либо явно настроенный
permission-restricted secret file. Это injection channels: secret не
переписывается в обычный config/DB и не печатается при startup.

---

# 69. Files

Host отвечает за:

- file picker;
- platform permission;
- app data root;
- import/export destination;
- share/open dialogs.

Runtime отвечает за:

- validation;
- product semantics;
- safe writes;
- checksums;
- import/export format.

UI/remote/plugin передают scoped file handle или logical import token, а не
произвольный absolute path. Host canonicalizes path, проверяет scope, link
traversal, size, MIME/content и lifetime. Token одноразовый или time-bounded.

---

# 70. Security boundaries

Существенные boundaries:

```text
Remote Client ↔ Remote Access Adapter
Plugin ↔ Plugin Host
Runtime ↔ SecretStore
Runtime ↔ external provider
UI extension ↔ allowed UI SDK surface
```

Для security boundary требуются explicit contract, failure behavior и tests.

Обязательные общие меры:

- threat model/abuse cases для Remote, IPC, plugins, imports и provider calls;
- least privilege и deny-by-default capabilities;
- production CSP без arbitrary remote scripts;
- dependency/advisory review и release SBOM;
- signed application/update artifacts;
- bounded parsers, archives, queues и diagnostics;
- redaction tests и user-controlled diagnostics export;
- security-sensitive config не изменяется plugin/theme/provider package;
- recovery mode не загружает third-party extensions.

At-rest encryption основной DB не подразумевается словом `secure storage`.
Если требуется encrypted data root, это отдельный `storageFormat`/key-recovery
design и ADR. До этого security claim ограничивается OS sandbox/disk protection
и отдельным защищённым хранением secrets.

---

# 71. Update model

Обновления разделены.

## 71.1. Application/UI update

Например:

- экран;
- кнопка;
- navigation;
- Theme slot.

DB обычно не меняется.

## 71.2. SDK update

Например:

```text
Plugin API 4.2 → 4.3
```

DB migration не требуется автоматически.

## 71.3. Runtime update

Например:

- оптимизация provider adapter;
- logging;
- query optimization.

Если persistent model не изменилась, schema revision не меняется.

## 71.4. Storage update

Только реальное изменение persisted model:

```text
schemaRevision 43 → 44
```

---

# 72. Update invariant

Запрещено:

```text
new app release → mandatory migration
```

Правильно:

```text
new app release
      ↓
schema changed?
  ┌───┴───┐
 no      yes
  │        │
 open   migrate
```

Release manifest заранее объявляет supported storage/schema range и minimum
rollback-compatible app version. Если migration выводит DB за range предыдущей
версии, rollback application запускается только в read-only recovery mode.

---

# 73. Desktop updater

Updater обновляет application bundle.

Он не должен:

- hot-replace running executable;
- менять DB до запуска compatible Runtime;
- зависеть от Node Plugin Runtime для data integrity.

Optional plugin host можно принудительно завершить.

Update artifact и metadata подписаны; signature и target/platform проверяются до
activation. Download идёт в staging, activation атомарна/rollback-able на уровне
application bundle. DB migration выполняет только новый Runtime после обычного
compatibility open.

Перед update с HIGH migration создаётся проверенный recovery snapshot. Rollback
UI не обещает writable downgrade DB без явного reverse migration/converter.

---

# 74. Mobile update

После OS package update:

```text
new Runtime starts
 ↓
opens DB
 ↓
schema equal?
 yes → open
 no  → normal migration/recovery
```

Нет отдельной mobile migration system.

Package authenticity обеспечивает OS distribution/signing. Migration не
выполняется из installer callback или UI process до acquisition data-root lease.
Low battery/disk pressure и kill на первом startup входят в device tests.

---

# 75. Headless update

Headless binary/container использует ту же DB compatibility policy.

Deployment system не меняет internal schema напрямую.

Rolling update нескольких replicas неприменим к одному SQLite data root:
предыдущий instance сначала полностью освобождает lease. Container health
становится ready только после compatibility check/recovery; liveness не убивает
долгую migration без отдельного startup budget.

---

# 76. Plugin/Theme/Provider updates

Plugin update:

- не изменяет core DB напрямую;
- plugin persistent state идёт через controlled/namespaced storage;
- проверяется до activation, устанавливается staged/atomically;
- при incompatibility/crash автоматически отключается, previous version может
  быть восстановлена без изменения core state.

Theme update:

- не меняет Runtime Kernel или DB;
- проверяется Theme API version;
- проходит schema/security validation до activation;
- previous working theme сохраняется как fallback.

Provider update:

- не меняет DB без изменения product persistent model;
- vendor config evolution остаётся Provider contract concern;
- secret references мигрируются отдельно от non-secret config;
- failed config migration не удаляет предыдущую working configuration.

---

# 77. Рекомендуемая структура репозитория

```text
crates/
  contracts-generated/
  runtime-kernel/
  storage/
  built-in-providers/

  adapters/
    tauri-local/
    remote-http/
    cli/

  hosts/
    desktop/
    mobile/
    headless/

packages/
  contracts/
    src/wire/
    generated/
  frontend/
  client-sdk/
  theme-sdk/
  plugin-sdk/
  provider-sdk/
  ui-components/

runtimes/
  node-plugin-host/

apps/
  desktop/
  android/
  ios/
  web/
  headless/

tools/
  contract-codegen/
```

Структура ориентировочная.

Package создаётся только при реальной границе или втором потребителе.

---

# 78. План миграции существующего проекта

Big-bang rewrite запрещён.

Фазы — dependency gates, а не обещание календарных releases. Работа может
поставляться постепенно под feature flags, но capability не объявляется stable,
пока не пройден её exit gate.

Общие правила каждой фазы:

- до начала зафиксированы owner, scope, входные fixtures и rollback boundary;
- каждый PR оставляет build deployable и не создаёт два authoritative writer;
- migration routing table показывает, какая feature ещё legacy, а какая уже Kernel;
- shadow read допустим только без side effects; shadow write запрещён;
- exit gate подтверждается CI artifacts, runbook и воспроизводимым test report;
- blocker по data integrity/security/recovery не переносится как «известный долг»;
- rollback после storage cutover означает restore/forward-fix, а не запуск старого
  writer поверх новой schema;
- временный adapter/flag имеет owner и дату удаления.

## Фаза 0 — Baseline и Contracts

**Цель:** сделать существующее поведение измеримым и создать стабильную границу
для постепенного переноса.

**Вход:** текущие TypeScript contracts, Client SDK, server routes и production DB
fixtures доступны для characterization.

**Deliverables:**

- inventory product operations, routes, DTO, errors и streaming events;
- ownership/routing table по feature;
- TypeBox Product Wire Contracts и единый operation registry;
- deterministic JSON Schema bundle, manifest и generated Rust boundary DTO;
- wire-safe subset, version axes и compatibility policy;
- `NeoBackend`; `RemoteBackend` поверх существующего Client SDK;
- временный internal `LegacyBackend`/route только для ещё не перенесённых features;
- golden/negative/round-trip corpus;
- baseline behavior, DB и API fixtures;
- ADR по generator, encoding и supported platforms.

**Exit gate:**

- contract generation оставляет clean working tree;
- TypeScript и Rust дают одинаковый verdict на corpus;
- все текущие UI calls проходят через `NeoBackend`;
- каждая feature имеет ровно один declared writer;
- compatibility diff и exact local hash mismatch тестируются;
- существующее production behavior покрыто characterization tests для critical flows.

**Rollback:** только additive contracts/facade; UI может вернуться на
`LegacyBackend` без изменения persistent data.

## Фаза 1 — Runtime Kernel skeleton

**Цель:** доказать portable Kernel lifecycle и boundary без массового переноса
product logic.

**Вход:** Phase 0 gate.

**Deliverables:**

- Kernel start/open/close lifecycle;
- typed product/contract/storage errors;
- operation dispatcher, cancellation и correlation;
- local adapter, headless adapter и test host;
- structured observability;
- panic/exception ABI containment policy;
- in-memory/temp storage test harness;
- `meta`/health operation и exact local handshake.

**Exit gate:**

- один Kernel crate/source собирается в target-specific artifacts для Desktop,
  Android и Headless;
- iOS Kernel target имеет compile smoke на доступном macOS toolchain, но не
  считается release acceptance;
- local/headless adapters проходят общий contract suite;
- invalid/fuzzed input не вызывает panic/UB;
- Kernel не импортирует platform/server/UI modules;
- packaged smoke build выполняет `meta` без legacy server.

**Rollback:** product operations остаются на legacy routing; Kernel skeleton можно
отключить feature flag-ом без data migration.

## Фаза 2 — Storage foundation и Recovery primitives

**Цель:** создать единственного владельца persistent correctness до переноса
пользовательских features.

**Вход:** Phase 1 gate; утверждены SQLite baseline и data-root layout.

**Deliverables:**

- exclusive data-root lease и writer coordinator;
- pinned SQLite baseline/compile options/connection policy;
- current schema, metadata, migration ledger и support window;
- transaction/repository boundary;
- immutable asset protocol и orphan GC;
- integrity/product invariant checks;
- risk-classified migration engine;
- consistent internal recovery snapshot;
- candidate restore/atomic activation primitive;
- read-only Recovery Mode;
- current/previous/legacy DB fixtures.

**Exit gate:**

- fresh schema fingerprint совпадает с migrated supported baselines;
- kill/power-loss injection на commit, migration, asset write и activation не
  теряет committed data и не активирует непроверенный candidate;
- второй process не получает writable access;
- backup snapshot открывается и проходит integrity/product checks;
- newer DB никогда не открывается writable;
- WAL/checkpoint/busy/disk-full scenarios покрыты Desktop/Headless matrix;
  Android device gate повторяет их в Phase 5.

**Rollback:** до первого authoritative Kernel write routing остаётся legacy.
После cutover rollback только через проверенный snapshot/converter либо
forward-fix; старая app открывает новую DB read-only.

## Фаза 3 — Desktop Local vertical slices

**Цель:** перенести Desktop local mode feature-by-feature без localhost server.

**Вход:** Phase 2 gate.

**Deliverables:**

- `React → LocalBackend → Tauri IPC → Runtime Kernel`;
- сначала один полный vertical slice, затем остальные CRUD/settings slices;
- per-feature cutover и legacy code deletion после stabilization window;
- local streaming/cancellation primitives;
- packaging data-root/contract manifest correctly;
- Desktop recovery UI и diagnostics export.

**Exit gate:**

- clean install и upgrade проходят на Windows/macOS/Linux;
- local product flow работает при полностью выключенном HTTP server;
- exact packaged UI/Runtime hash совпадает;
- каждый migrated slice имеет только Kernel writer;
- crash Remote/Plugin services не влияет на local DB;
- rollback drill соответствует Phase 2 policy.

**Rollback:** feature flag возвращает только ещё не cutover slice. Для slice с
новыми writes используется snapshot/forward-fix, не dual write.

## Фаза 4 — Headless Remote Adapter

**Цель:** подключить server deployment к тому же Kernel.

**Вход:** stable Desktop vertical slice и Phase 2 storage gate.

**Deliverables:**

```text
Fastify/HTTP Adapter → Product Facade → Runtime Kernel
```

- reuse existing Fastify допустим;
- auth/pairing/TLS/reverse-proxy boundary;
- idempotency, rate/body/stream limits;
- SSE reconnect/resume semantics;
- CLI/admin health, backup и recovery hooks;
- graceful drain и exclusive instance lease.

**Exit gate:**

- LocalBackend/RemoteBackend parity suite зелёный для migrated surface;
- non-loopback insecure startup отклоняется;
- outcome-unknown/idempotency tests исключают duplicate writes;
- adapter restart не меняет Kernel correctness;
- one-instance/shared-volume negative tests проходят.

**Rollback:** Remote Adapter можно откатить/выключить независимо; storage и
Kernel не откатываются. Переписывать HTTP host на Rust ради симметрии запрещено.

## Фаза 5 — Android Local foundation

**Цель:** дать Android локальные базовые сценарии без Node и localhost server.

**Вход:** Phase 2 gate и минимум один stable Phase 3 slice.

**Deliverables:**

- Android Host/LocalBackend/native bridge вне main thread;
- bundled Kernel + SQLite с текущими ABI/store requirements;
- local profile/data-root lease;
- secure storage, scoped files, lifecycle bridge;
- basic CRUD/settings и startup recovery;
- RemoteBackend/profile switching;
- device/emulator fixture matrix.

**Exit gate:**

- clean install/update/local/remote profile flows проходят;
- force-stop/process kill во время read/write/startup не повреждает committed state;
- secure storage locked/unavailable имеет controlled UX без plaintext fallback;
- no Node, no listening port, no hidden server process;
- package/NDK соответствует актуальным page-size/ABI requirements;
- Phase 2 recovery snapshot/DB fixture с Desktop открывается Android recovery tooling.

**Rollback:** local profile не объявляется stable до gate. Feature flag может
скрыть создание новых local profiles; существующие local data доступны через
Recovery/internal snapshot, а после Phase 11 — через Portable Export; данные не
удаляются.

## Фаза 6 — Generation durability

**Цель:** перенести generation как recoverable workflow до подключения всех
production providers.

**Вход:** Phase 2 workflow storage, Phase 3 Local boundary и Phase 4 Remote
streaming adapter.

**Deliverables:**

- formal state machine, revisions, leases и attempts;
- sanitized request snapshot;
- bounded partial checkpoints;
- cancellation/timeout/outcome-unknown semantics;
- at-least-once sequenced event model и reconnect;
- deterministic fake provider для fault injection;
- atomic final-message/terminal-state reconciliation.

**Exit gate:**

- kill injected на каждом state/commit/event boundary;
- no duplicate final message или hidden provider retry;
- Local/Remote produce equivalent snapshot/events;
- slow consumer не создаёт unbounded memory;
- Retry/Keep partial/Discard работают после restart.

**Rollback:** новые runs можно направить на прежний path только до их создания.
Существующие durable runs завершаются/recover-ятся одним owner; таблицы не
записываются двумя engines.

## Фаза 7 — Portable Built-in Providers

**Цель:** обеспечить providers, необходимые local Desktop/Android generation.

**Вход:** Phase 6 gate.

**Deliverables:**

- portable built-in adapters;
- scoped credential flow и config/secret separation;
- normalized models/errors/usage;
- timeout/cancellation/retry policies;
- provider conformance mocks и recorded non-secret fixtures;
- availability/fallback metadata.

**Exit gate:**

- provider contract suite одинаков на Desktop/Android/Headless targets;
- secrets отсутствуют в snapshot/log/backup/diagnostics;
- cancellation и network fault не создают silent double billing;
- vendor payload не выходит за adapter boundary.

**Rollback:** конкретный provider отключается capability metadata; durable run
получает typed failure/interrupted state, core data остаётся доступно.

## Фаза 8 — Android Background execution

**Цель:** подключить OS lifecycle к уже recoverable operations.

**Вход:** Phase 6/7 gates.

**Deliverables:**

- user-visible foreground execution adapter для допустимых scenarios;
- documented operation → platform API/service-type mapping;
- best-effort maintenance scheduler;
- notification/actions и user-stop handling;
- OS expiration/cancellation bridge;
- deduplication/lease semantics;
- battery/network/storage constraints.

**Exit gate:**

- background-start restrictions, force-stop, reboot, duplicate scheduling и
  expiration тестируются на поддерживаемых Android API levels;
- notification отражает реальный operation state;
- system retry безопасен;
- app не обещает exact schedule или guaranteed completion;
- Headless execution path не изменён.

**Rollback:** background capability выключается; foreground UI flow и durable
restart recovery продолжают работать.

## Фаза 9 — Desktop Remote Access

**Цель:** переиспользовать hardened Phase 4 adapter как optional Desktop service.

**Вход:** Phase 4 security/parity gate и stable Phase 3 Desktop.

**Deliverables:**

- explicit enable/pair/revoke UI;
- loopback default; TLS/trusted-proxy policy для non-loopback;
- один Kernel/writer для Local IPC и Remote Adapter;
- bounded connections/streams и audit events;
- firewall/bind diagnostics.

**Exit gate:**

- Remote Access off означает отсутствие listener;
- insecure public bind отклоняется;
- local и remote concurrent operations сохраняют transaction invariants;
- adapter crash/restart не повреждает local state;
- revoke прекращает новые calls/streams по policy.

**Rollback:** service выключается без изменения Core/DB/LocalBackend.

## Фаза 10 — Extension hardening

**Цель:** допустить extensions только после определения реальных security
boundaries.

**Вход:** Phase 3/4/5 Host boundaries и Phase 9 Desktop service gate.

**Deliverables:**

- Theme responsive semantics, validation и fallback;
- declarative semantic UI slots;
- no arbitrary third-party JS in main WebView;
- Node Plugin Runtime process isolation/capability broker;
- permissions/revocation/negative tests;
- namespaced state, quotas и migration policy;
- extension compatibility handshake и safe-mode startup;
- explicit runtime availability.

**Exit gate:**

- malicious/oversized/denied fixtures не обходят broker/CSP/path/network scopes;
- plugin crash/timeout не блокирует Kernel/UI и не повреждает core;
- revoked permission действует без reinstall;
- incompatible update откатывается/отключается;
- Recovery Mode стартует без third-party extensions;
- mobile принимает только declarative/trusted contribution до isolated runtime.

**Rollback:** extension или весь runtime отключается independently; core data и
namespaced state сохраняются для диагностики/удаления.

## Фаза 11 — Portable Data и Legacy lifecycle

**Цель:** превратить Phase 2 recovery primitives в публичные долгоживущие formats.

**Вход:** Phase 2 schema/assets guarantees и stable local-data hosts из Phase
3/4/5 (Desktop, Headless, Android).

**Deliverables:**

- versioned backup container/inventory/checksums;
- consistent DB+immutable-assets backup lease;
- staged cross-platform restore/atomic activation;
- versioned Portable Export и recoverable import;
- legacy converter outside main migration window;
- quotas/traversal/compression-bomb protection;
- large/corrupt/interrupted fixtures и user runbooks.

**Exit gate:**

- Desktop → Android/Headless и обратные backup round-trips;
- restore kill на каждом step сохраняет current либо validated candidate;
- corrupt/path traversal/oversized archive отклоняется до activation;
- Export fixtures читаются всеми заявленными supported versions;
- minimum legacy fixture конвертируется без in-place source mutation;
- recovery snapshot/restore drill документирован и воспроизводим.

**Rollback:** опубликованный format не отзывается. Writer можно остановить, но
reader/restore последней поддерживаемой версии и fixtures сохраняются по support
policy.

Первая полная architecture release готова только после relevant gates 0–11.
Отдельные Desktop/Headless capabilities могут поставляться раньше, если их
собственные gates пройдены и они не заявляют ещё не готовые guarantees.

---

# 79. CI — Pull Request

Merge-blocking проверки:

- formatting, TypeScript typecheck/lint/tests и Rust fmt/clippy/tests;
- dependency direction/forbidden-import rules;
- deterministic contract codegen (`git diff --exit-code`);
- semantic schema compatibility diff;
- TS/Rust cross-language golden/negative corpus;
- FFI/IPC invalid-input and local hash-handshake tests;
- current/fresh/previous-stable DB fixtures;
- migration checksums, pre/postconditions и schema fingerprints;
- single-writer/data-root lease tests;
- LocalBackend/RemoteBackend product DTO/semantic parity;
- Theme/Plugin/Provider/Client compatibility tests;
- permission-denied, revoked и size-limit negative tests;
- changed-platform builds; release branches собирают всю required matrix;
- dependency advisory/license policy для production graph;
- test report связывается с phase gate/acceptance requirement.

Generated diff, skipped required fixture или quarantined failing test не считается
зелёным gate.

---

# 80. Nightly

- full DB support window;
- legacy converter fixtures;
- cross-platform DB fixtures;
- backup round-trip;
- staged restore kill matrix;
- archive traversal/compression/size adversarial corpus;
- Android device/emulator lifecycle/background matrix;
- process kill fault injection;
- provider stream interruption;
- plugin process kill;
- schema-derived contract property tests;
- fuzzing Rust boundary deserialization; panic является failure;
- fuzzing import/backup/plugin manifests;
- concurrency, long-reader, busy, checkpoint and disk-full tests;
- performance/regression baseline;
- large migration/backup/restore fixtures;
- dependency/security scan и SBOM generation rehearsal.

Flaky failure имеет owner и deadline; бесконечный auto-rerun, скрывающий failure,
запрещён.

---

# 81. Release Candidate

- подписанные production-equivalent Desktop/Android/Headless artifacts;
- clean install, update и failed-update rollback по каждому required target;
- packaged UI/Runtime exact contract hash и controlled mismatch scenario;
- LocalBackend/RemoteBackend/profile switching;
- Remote off = no listener; insecure public bind rejected;
- current + oldest directly supported DB migration;
- HIGH migration recovery и application rollback/read-only behavior;
- cross-platform backup/restore и Portable Export/import;
- process kill во время generation/migration/backup/restore;
- disk-full и secure-storage-unavailable UX;
- Node Plugin Runtime kill/permission revoke/safe mode;
- current и previous supported SDK/API majors;
- performance budgets на reference hardware;
- release manifest с version axes, SQLite baseline, schema range, SBOM и
  backup/rollback instructions.

RC не проходит при необъяснённом data-loss/security blocker или отсутствии
воспроизводимого recovery drill.

---

# 82. Cross-platform DB tests

Обязательны:

```text
DB created by Windows → open Android/Linux
DB created by Android → open Windows/Linux
DB created by Headless → open Desktop/Mobile
```

Тестируется logical compatibility, а не копирование live WAL state.

Каждая fixture закрыта cleanly либо создана Online Backup API. `database.sqlite`
никогда не отделяется от hot `-wal`/`-journal`. Тесты включают:

- одинаковый logical result и product invariants;
- SQLite baseline/compile-option matrix;
- Unicode/case/path-sensitive assets;
- schema older/current/newer;
- read-only rejection newer schema;
- backup, а не live data directory, как supported transfer mechanism.

---

# 83. Contract tests

Product Wire Contracts:

- generated artifacts соответствуют source schemas;
- TypeScript и Rust одинаково принимают/reject golden corpus;
- negative payload никогда не вызывает panic;
- request/response/event round-trip не меняет contract value;
- local exact-hash mismatch блокирует product writes;
- Remote API compatibility следует major/minor и feature policy;
- previous supported Remote API major проверяется fixtures;
- operation idempotency/auth/size metadata полны;
- transport encodings дают один logical value;
- FFI allocator/free/cancel/lifetime contract проходит sanitizer tests.

Theme SDK:

- previous supported major;
- additive token behavior;
- slot fallback;
- remote import/script/CSP bypass отклоняется.

Plugin SDK:

- manifest validation;
- permissions;
- lifecycle;
- runtime availability;
- previous major compatibility;
- denied/revoked permission;
- manifest/path/message limits;
- declarative contribution escaping/accessibility;
- namespaced storage quota/migration.

Provider SDK:

- config;
- models;
- stream;
- cancellation;
- normalized errors;
- usage;
- secret redaction/config separation;
- timeout/outcome-unknown/no-silent-double-retry.

---

# 84. Performance

До exit соответствующей фазы создаётся versioned benchmark manifest с
reference hardware/OS, fixture size, measurement method и числовыми
thresholds. «Быстро» без числа не является requirement.

Минимальные метрики:

- Runtime cold start p50/p95;
- DB open/recovery p50/p95;
- read/write latency p50/p95;
- migration time + peak disk/memory;
- idle и peak generation memory;
- binary/install size;
- stream throughput/backpressure memory;
- Android battery/background wakeups;
- backup/restore/export throughput + peak disk;
- Remote concurrent connection/stream limits.

PR/Nightly сравнивает regression с approved baseline; превышение threshold
блокирует gate либо требует явного ADR с новым product budget.

Mobile performance budget не ограничивает Headless throughput.

Headless requirements не заставляют Mobile держать server processes.

---

# 85. Observability

Категории:

```text
runtime
storage
migration
generation
provider
remote
plugin
update
recovery
```

Требования:

- structured stable event/error codes;
- correlation/request/operation/stream IDs;
- rotation, retention и size limits;
- secrets/redaction automated tests;
- user content/raw payload not logged by default;
- metrics без high-cardinality user identifiers;
- diagnostics export preview и явное user consent;
- crash report opt-in по platform policy;
- clock/sequence metadata, достаточные для recovery analysis.

Observability failure не блокирует committed product write и не меняет
correctness. Logging queue bounded и имеет drop/coalesce policy.

---

# 86. Recovery mode

Recovery запускается при:

- unsupported/corrupt DB;
- failed migration;
- checksum mismatch;
- failed restore;
- critical startup integrity failure.

Минимально позволяет:

- показать versions;
- показать schema/storage info;
- выполнить integrity check;
- restore backup;
- export diagnostics;
- Portable Export where safe.

Recovery Mode:

- открывает data read-only по умолчанию;
- не запускает Remote Access, providers или third-party extensions;
- явно показывает active/previous/candidate paths без raw secrets;
- требует отдельного подтверждения для restore/activate/destructive cleanup;
- никогда не «чинит» checksum/history автоматически;
- пишет recovery audit marker в отдельное bounded diagnostics storage;
- предлагает только операции, безопасные для фактически прочитанной metadata.

---

# 87. Явно запрещено

```text
Server-first product model
Mobile-first product model
Core::start(serverMode=true)
isAndroid/isServer branching в Runtime Kernel
localhost server как обязательный local IPC
embedded Node на Android
Termux dependency
вечный ForegroundService
отдельный Android backend
отдельная Android DB schema
отдельные Android migrations
отдельные server migrations
appVersion == schemaRevision
migration на каждом release
полная migration chain на fresh install
тихая запись старой версии приложения в новую DB
absolute platform paths как canonical DB identity
Plugin SDK == Node runtime
Theme SDK через private React tree
SDK contracts, зависящие от Rust/JNI/Node-API
hand-written зеркальные TypeScript/Rust wire DTO
экспорт internal Rust/SQLite structs напрямую через IPC/API
repr(C) product structs как FFI ABI
serde_json::Value fallback вместо generated DTO
unwrap/expect/panic на transport payload
local product call до успешного contract handshake
два authoritative writer для одной entity/feature
два writable Kernel instance для одного data root
active SQLite DB на NFS/SMB/cloud-synced/shared container volume
raw copy открытого database.sqlite как backup
удаление/перенос hot -wal/-journal вручную
restore поверх active data root
unbounded parser/archive/event/log/plugin queue
blind retry non-idempotent write/provider call
точное обещание времени mobile scheduler
plaintext secret fallback
arbitrary third-party JavaScript в основном WebView
новая SDK capability, требующая rewrite всех hosts
Plugin с direct SQL access к core tables
generic internal string Capability Registry
generic Durable Jobs Engine без причины
собственный mobile scheduler
переписывание Fastify ради симметрии
big-bang TypeScript → Rust rewrite
portable plugin runtime без product demand
две authoritative реализации одной feature бессрочно
```

---

# 88. Критерии приёмки общей архитектуры

Архитектура считается принятой, когда:

- NeoTavern является product-first/local-first application;
- Desktop работает локально без обязательного HTTP server;
- Desktop может включить Remote Access отдельно;
- Headless использует тот же Runtime Kernel;
- Mobile использует те же persistent/runtime semantics;
- Mobile не требует Node;
- Headless не ограничен mobile lifecycle;
- Runtime Kernel не содержит platform branching;
- один data root имеет один writable Kernel/writer coordinator;
- adapters не открывают SQLite напрямую;
- UI использует `NeoBackend`;
- Local и Remote имеют согласованную semantics;
- Product Wire Contracts имеют один hand-authored source of truth;
- Rust boundary DTO генерируются и не редактируются вручную;
- FFI/JNI передаёт opaque handles/buffers, а не Rust product structs;
- local schema mismatch обнаруживается до product write;
- invalid IPC/HTTP payload возвращает controlled error и не вызывает panic;
- operation registry задаёт class/idempotency/auth/limits;
- public SDK не зависит от Runtime implementation language;
- Theme SDK работает на всех required UI hosts; iOS остаётся planned target;
- Plugin SDK отделён от Plugin Runtime;
- Provider SDK отделён от runtime implementation;
- DB schema едина;
- migrations едины;
- fresh/migrated schema fingerprints согласованы;
- newer DB остаётся read-only;
- migrations и restore имеют проверенный rollback/recovery path;
- app release не обязан менять DB schema;
- older runtime не пишет в newer schema;
- cross-platform backup/restore работает;
- backup использует consistent DB snapshot и pinned immutable assets;
- restore работает через validated candidate и atomic activation;
- Portable Export остаётся долгоживущим data format;
- Remote Access deny-by-default и не стартует публично без security config;
- mobile scheduler semantics best-effort и workflows допускают interruption;
- phase gates 0–11 имеют сохранённые CI evidence/runbooks.

---

# 89. Критерии приёмки Desktop

Desktop готов, если:

- local mode работает без обязательного server sidecar;
- SQLite открывается через Runtime Kernel;
- второй process не открывает тот же data root writable;
- packaged UI/Runtime contract hash совпадает;
- Theme SDK работает;
- declarative/trusted Plugin UI работает без arbitrary JS в main WebView;
- optional Node Plugin Runtime запускается/убивается отдельно;
- Remote Access включается/выключается без изменения Core;
- выключенный Remote Access не оставляет listener;
- insecure non-loopback bind отклоняется;
- Remote Access crash не повреждает local state;
- updater проверяет подпись и не зависит от Plugin Runtime correctness;
- clean install/update/recovery drill проходит на Windows/macOS/Linux.

---

# 90. Критерии приёмки Android

Android готов, если:

- LocalBackend работает без Node;
- RemoteBackend работает через Client SDK;
- один UI поддерживает local/remote profiles;
- Theme SDK работает;
- declarative/trusted mobile UI contributions работают; arbitrary third-party JS
  в main WebView не поддерживается;
- Node backend plugins явно unavailable локально;
- process death не повреждает committed state;
- native bridge не выполняет долгую работу на main thread;
- secure storage failure не приводит к plaintext fallback;
- interrupted generation восстанавливается;
- foreground execution используется только для допустимой user-visible operation;
- OS stop/expiration переводится в корректный recoverable state;
- maintenance использует best-effort системный scheduler и безопасна при retry;
- app update использует общую DB migration system;
- package соответствует актуальным ABI/page-size store requirements;
- Android local profile проходит backup/restore с Desktop/Headless.

---

# 91. Критерии приёмки Headless/VPS

Headless готов, если:

- работает без UI;
- использует тот же Runtime Kernel;
- предоставляет Remote Access Adapter;
- insecure public listener не запускается;
- один data root не используется несколькими writable instances;
- может работать 24/7;
- может использовать optional Node Plugin Runtime;
- не содержит mobile-specific scheduling assumptions;
- update использует общую DB compatibility policy;
- graceful drain и hard-kill recovery протестированы;
- backup переносится на Desktop/Mobile;
- container health не убивает migration по обычному liveness timeout.

---

# 92. Критерии приёмки SDK

SDK architecture готова, если:

- Theme SDK versioned независимо;
- Plugin SDK versioned независимо;
- Provider SDK versioned независимо;
- Client SDK versioned независимо;
- Product Wire Contract проходит TS/Rust golden и negative corpus;
- generated artifacts проверяются на drift в каждом PR;
- additive SDK update не требует DB migration;
- SDK package не импортирует internal Runtime implementation;
- previous supported major проверяется contract tests;
- support/deprecation window опубликован для каждого version axis;
- host может явно сообщить отсутствие конкретного runtime capability;
- extension не обязан знать platform name для обычного compatibility decision;
- permission denied/revoked и resource limits проверяются negative tests;
- Plugin Runtime изолирован process/broker boundary;
- Theme/Plugin UI не может ослабить CSP или получить private DOM/store.

---

# 93. Definition of Done

```text
NeoTavern — приложение, а не server с клиентами.

Server — подключаемый Remote Access Adapter.

Mobile lifecycle — responsibility Mobile Host.

Headless execution — responsibility Headless Host.

Ни server, ни mobile не определяют Runtime Kernel.

Runtime Kernel владеет durable correctness,
но не всеми публичными SDK и не всем UI-кодом.

Public SDK не зависит от Rust, JNI или Node-API.

Product Wire Contract описывается один раз.

TypeScript type выводится из TypeBox schema.

Rust boundary DTO генерируется из того же schema bundle.

Ни Local IPC, ни Remote Adapter не имеют отдельной копии product DTO.

Contract mismatch обнаруживается до product write.

Некорректный payload возвращает controlled error и не вызывает panic.

Каждая operation объявляет class, idempotency, authorization и limits.

У каждой feature и каждого data root существует один authoritative writer.

Theme SDK одинаков на required UI hosts и не создаёт отдельный contract для planned iOS.

Plugin SDK является contract, а Node — только один plugin runtime.

Provider SDK является contract,
а built-in implementation может быть native.

SQLite schema одна на всех native/headless platforms.

Active SQLite data root локален одному host и не разделяется между writable instances.

SQLite baseline pin-ится и содержит применимые corruption fixes.

App version и schema revision независимы.

Большинство releases не выполняют migration.

Fresh install создаёт актуальную schema напрямую.

Старый Runtime не пишет в более новую DB.

Migration ledger и schema revision коммитятся атомарно.

Сложные migrations используют expand/migrate/contract.

Backup является cross-platform recovery format.

Backup снимается consistent API и включает согласованный набор immutable assets.

Restore строит и проверяет candidate, а не перезаписывает active state.

Portable Export является долгоживущим user-data format.

Desktop local mode не требует localhost.

Android local mode не требует Node.

Mobile background execution считается interruptible и best-effort.

VPS не живёт по ограничениям Android.

Android не обязан поддерживать server-only runtimes.

Новая feature не должна автоматически требовать изменения всех hosts.

Новая SDK capability не должна автоматически требовать изменения Runtime Kernel.

Arbitrary third-party JavaScript не исполняется в основном WebView.

Remote Access выключен по умолчанию и fail-closed при небезопасной конфигурации.

Каждая фаза имеет вход, deliverables, exit gate и реальный rollback/recovery path.

Архитектура окупается уменьшением стоимости изменений,
а не числом abstractions.
```

---

# 94. Финальная схема

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         PUBLIC CONTRACTS                            │
│                                                                     │
│ Contracts | Client SDK | Theme SDK | Plugin SDK | Provider SDK      │
│ Product Wire Schema → inferred TS + generated Rust DTO              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                          Product Facade
                                │
                ┌───────────────┴───────────────┐
                │                               │
        UI / Application                 Runtime Kernel
        React / TypeScript                    Rust
                │                               │
                │                     ┌─────────┼─────────┐
                │                     │         │         │
                │                   SQLite   Recovery  Providers
                │                     │
                └───────────────┬─────┘
                                │
                               HOSTS
          ┌─────────────────────┼──────────────────────┐
          │                     │                      │
       DESKTOP                MOBILE               HEADLESS
          │                     │                      │
      Tauri Host            Tauri/native           Service/CLI
          │                     │                      │
     LocalBackend           LocalBackend          Remote Adapter
          │                     │                      │
 optional Remote           RemoteBackend          HTTP/SSE
 optional Node Runtime     OS lifecycle           optional Node Runtime
```

Web:

```text
Web UI
  │
RemoteBackend
  │
Client SDK
  │
HTTP/SSE
  │
Remote Access Adapter
  │
Runtime Kernel
```

---

# 95. Итоговый принцип

```text
Не строить NeoTavern вокруг сервера.

Не строить NeoTavern вокруг телефона.

Не строить NeoTavern вокруг Node.

Не строить NeoTavern вокруг Rust.

Не строить NeoTavern вокруг конкретного SDK.

Строить NeoTavern вокруг стабильных product contracts,
durable user data и небольшого переносимого runtime.

Server должен подключаться, когда нужен server.

Mobile lifecycle должен подключаться, когда нужен mobile lifecycle.

SDK должен развиваться независимо от внутреннего runtime.

DB должна изменяться только тогда, когда реально изменились данные.

Каждый host использует свои сильные стороны,
не навязывая свои ограничения остальным.
```
