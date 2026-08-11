---
title: Настройка окружения разработчика
description: Настройка среды разработки NeoTavern и локальный запуск проекта
sidebar_position: 2
---

На этой странице объясняется, как настроить среду разработки для NeoTavern и
запустить проект локально.

## Предварительные требования

- Node.js 24 LTS или новее — проекту требуется Node `>= 24`.
- pnpm 9 — рабочей области требуется pnpm `>= 9` и `< 10`, и она объявляет
  `packageManager: pnpm@9.15.0`; включите его через corepack или установите
  напрямую.
- Windows, macOS или Linux. Десктоп-приложение включает собственный рантайм
  Node.js для конечных пользователей, но разработка всегда использует ваш
  установленный Node.js.

## Установка зависимостей

```bash
pnpm install
```

Это устанавливает каждый пакет рабочей области. Репозиторий — это
pnpm-монорепозиторий: приложения живут в `apps/` (сервер и web), а общие
библиотеки — в `packages/`.

## Запуск в режиме разработки

```bash
pnpm dev
```

запускает backend на Fastify и веб-приложение на Vite параллельно с
горячей перезагрузкой. Чтобы запустить их по отдельности:

```bash
pnpm dev:server
pnpm dev:web
```

Откройте URL, выведенный dev-сервером Vite, подключите провайдера в
настройках и отправьте первое сообщение, чтобы проверить весь конвейер: чат,
сервер, провайдер, стриминг и сохранение.

## Гейты качества

Запускайте их перед пушем:

```bash
pnpm typecheck    # TypeScript across the monorepo
pnpm lint         # ESLint, zero warnings allowed
pnpm test         # Vitest unit and integration tests, plus web tests
pnpm test:e2e     # Playwright end-to-end suite (builds the workspace first)
pnpm build        # full workspace build (tsc -b and Vite)
pnpm format:check # Prettier check
```

`pnpm test:e2e` сначала компилирует всю рабочую область, поэтому ожидайте,
что он займёт больше времени, чем остальные проверки. Скрипты `docs:check` и
`docs:build` проверяют внутреннюю документацию разработчика; у публичного
сайта свои команды, описанные на странице [Сайт документации](./docs-site).

## Десктопная разработка

Десктопная оболочка (Tauri) и её sidecar на Node.js — отдельные приложения:

```bash
pnpm desktop:dev       # run the desktop app in development
pnpm desktop:portable  # build the portable Windows package
pnpm desktop:release   # build installer packages
```

Упаковка для десктопа связана со специфичными для ОС тулчейнами; подробности
см. в разделе [Десктоп](../developers/desktop/) документации для разработчиков.

## Частые проблемы

- `pnpm install` или `pnpm dev` падает: проверьте, что `node -v` сообщает 24
  или новее, а `pnpm -v` — 9.
- Dev-серверы не запускаются: проверьте, что порты, которые используют сервер
  и Vite, не заняты другим процессом, затем перезапустите `pnpm dev`.
