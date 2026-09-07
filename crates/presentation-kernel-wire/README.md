# neotavern-presentation-kernel-wire

`ProductWire`-адаптер поверх канонического Rust Kernel (`runtime-kernel`).

## Назначение

Presentation-слой (`presentation-chat`) потребляет только payload-контракт
[`ProductWire`](../presentation-chat/src/wire.rs) и не может зависеть от
`runtime-kernel` (guard-тест `presentation-chat/tests/live_wire.rs`). Этот
крейт — единственное место на стороне presentation, где зависимость от
ядра легальна: он реализует `ProductWire` поверх `Kernel::dispatch` /
`Kernel::dispatch_stream` и отдаёт presentation ровно тот же контракт, что
in-memory `FakeWire`.

## Публичный вход

- `KernelProductWire::open(data_root: &Path) -> Result<Self, ChatRouteError>` —
  открывает durable-ядро (SQLite в `data_root`; генерация требует storage,
  stateless-ядро стримы отклоняет).
- `impl ProductWire for KernelProductWire` — `call` / `start_stream` /
  `poll_stream` / `cancel_stream` (см. `wire.rs` в `presentation-chat`).
- `seed_parity_workspace<W: ProductWire>(wire, title, messages) -> Result<String, _>`
  — сид демо-чата через Product Wire (персонаж + чат + N сообщений),
  возвращает `chat_id`. Используется parity-тестами и бином.
- Бин `neocompositor-kernel` (feature `desktop-host`) — тот же winit/present
  хост `desktop_host::run`, но провод — настоящий Kernel:
  `--seed N` (сообщений, по умолчанию 12), `--data-root <dir>` (по умолчанию
  temp-каталог на процесс), остальные флаги — как у `neocompositor-desktop`.

## Маппинг стрима

- `start_stream` — `Kernel::dispatch_stream` (`generation.start` /
  `generation.retry`); handle = `stream_id` (run id).
- `poll_stream` — один кадр за вызов: replay durable-лога `generation.events`
  после последней применённой sequence; после терминального события
  (`completed`/`failed`/`cancelled`) следующий poll отдаёт `Terminal`, затем
  exhausted-deque `Timeout` (семантика FakeWire). `EventStream::next_notice` —
  только примитив ожидания; лог каноничен, поэтому таймаут тоже реплеит лог.
- `cancel_stream` — `generation.cancel` через unary `dispatch` (идемпотентен
  для `cancelling`); терминальный `generation.cancelled` реплеится
  последующими poll'ами.
- Ошибки: `KernelError.product → ChatRouteError::Product`, иначе
  `ChatRouteError::Transport`.

## Зависимости

`contracts-generated`, `neotavern-presentation-chat`,
`neotavern-presentation-dioxus-shell`, `runtime-kernel`, `serde`,
`serde_json`, `tempfile` (dev). Обратной зависимости
`presentation-chat → kernel-wire` нет (guard-тест в `tests/parity.rs`).

## Команды

```bash
cargo test -p neotavern-presentation-kernel-wire          # parity-тесты
cargo run -p neotavern-presentation-kernel-wire --features desktop-host \
  --bin neocompositor-kernel -- --seed 12 --dom-dump out.json
```

## Ограничения

- Генерация durable-only: `data_root` обязателен для стримов.
- `send` сессии хардкодит `model: None` (мгновенное завершение fake-провайдера);
  медленные/отменяемые раны — через model-config `steps`/`delay-ms` на уровне
  адаптера.
- Retry после `completed` — `GENERATION_RUN_STATE_CONFLICT` (не recoverable);
  после `cancelled`/`failed`/`interrupted` — разрешён.
