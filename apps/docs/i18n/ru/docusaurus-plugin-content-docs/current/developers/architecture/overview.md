---
title: Обзор монорепозитория
description: Структура монорепозитория NeoTavern, поток данных между сервером и веб-клиентом и принцип локально-ориентированного хранения.
sidebar_position: 2
---

NeoTavern — локально-ориентированное приложение: единый процесс Fastify
обслуживает API и необязательный собранный фронтенд, без внешних баз данных,
очередей или контейнеров.

## Структура монорепозитория

Рабочая область — это pnpm-монорепозиторий с двумя группами верхнего
уровня, `apps/` и `packages/`:

```text
apps/
  server/          # Fastify backend: API, prompt pipeline, SSE, legacy host
  web/             # React SPA
  plugin-runtime/  # Restricted Node.js process for backend plugins
  desktop/         # Tauri 2 shell; runs the server as a sidecar process
packages/
  shared/        # UUIDv7 IDs, Result, errors, logger, async utilities
  contracts/     # TypeBox API schemas — single source of truth
  db/            # SQLite: schema, migrations, repositories, FTS5
  ui/            # Headless components on Radix primitives
  i18n/          # i18next setup and language resources
  plugin-sdk/    # Plugin manifest, permissions, and API contracts
  theme-sdk/     # Theme tokens, levels, and inheritance
  provider-sdk/  # Provider adapter contract and adapters
  legacy-compat/ # window globals and DOM compatibility islands
  gestures/      # Framework-agnostic row gestures
  plugin-build/  # Plugin build and publish pipeline
```

## Приложения

- `apps/server` — backend на Fastify. Он предоставляет API `/api/v2/*`,
  выполняет конвейер промптов, стримит генерацию по SSE и размещает
  совместимую с Express устаревшую поверхность. Каждый модуль — изолированный
  плагин Fastify.
- `apps/web` — React SPA. Он общается с сервером по HTTP и отображает
  рабочее пространство чата, а также поверхности для персонажей, настроек,
  провайдеров, тем и плагинов.
- `apps/plugin-runtime` — ограниченный по разрешениям процесс Node.js, в
  котором выполняются недоверенные backend-плагины, изолированные от
  основного серверного процесса.
- `apps/desktop` — оболочка Tauri 2. Она запускает скомпилированный сервер
  как самодостаточный sidecar на Node.js и открывает webview только после
  готовности локального API.

## Пакеты

Общий код живёт в узкоспециализированных пакетах в `packages/`. У каждого
пакета одна обязанность, и зависимости направлены только вниз: `server` и
`web` зависят от пакетов, а пакеты зависят максимум от `shared` и
`contracts`. Полную разбивку см. в разделе [Пакеты](packages).

## Поток данных

Типичный запрос проходит через следующие слои:

1. Фронтенд вызывает конечную точку `/api/v2/*` через TanStack Query.
2. Fastify проверяет входные данные по схеме TypeBox и возвращает ошибки в
   конверте `{ code, params, traceId }`.
3. Репозитории в `@neotavern/db` читают и записывают SQLite с курсорной
   пагинацией и поиском FTS5.
4. Генерация выполняется через `POST /api/v2/chats/:id/generate`: конвейер
   промптов собирает контекст, адаптер провайдера сериализует запрос, ответ
   стримится обратно по SSE, а сообщение сохраняется.

Веб-приложение — это одна страница: маршруты меняют рабочее пространство
чата, а персонажи, настройки, провайдеры, темы и плагины отображаются в
диалоговой поверхности поверх сохранённого расположения чата.

## Принцип локально-ориентированности

Всё работает на вашей машине:

- Backend по умолчанию привязывается к `127.0.0.1`. Удалённый доступ —
  явное согласие с ограниченными сессиями и требованиями HTTPS.
- Все данные живут в одном локальном каталоге данных: одна база SQLite плюс
  файловое хранилище с адресацией по содержимому. Никаких PostgreSQL, Redis
  или Docker.
- Приложение работает офлайн. Вызовы провайдеров — единственный сетевой
  трафик, а встроенный адаптер `echo` позволяет протестировать весь конвейер
  без какого-либо провайдера.
- Резервные копии, экспорт и импорт из SillyTavern выполняются локально
  через те же API SQLite и файлов.

О слое хранения см. [Данные и хранилище](../data/), а о пути генерации —
[Конвейер промптов](../prompt-pipeline/).
