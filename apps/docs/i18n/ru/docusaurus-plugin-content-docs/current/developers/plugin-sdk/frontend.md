---
title: Frontend API плагина
description: Как frontend-плагин регистрирует страницы, панели, действия, команды и события.
sidebar_position: 4
---

Frontend API — это то, что браузерный плагин получает в своём вызове
`activate()`: набор регистраторов для каждой поверхности UI, шина событий и
i18n.

## Точка входа

Frontend-плагин экспортирует определение с функцией `activate(api)`. Хост
вызывает его с объектом `FrontendPluginApi`, когда плагин получил согласие и
активен:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Register surfaces here.
  },
  deactivate() {
    // Optional explicit teardown.
  },
});
```

Каждый регистратор возвращает функцию очистки. Рантайм собирает их
автоматически, поэтому вашему плагину не нужно отслеживать их вручную — хотя
`deactivate()` всё же может разобрать всё, чем вы управляете сами.

## Поверхности регистрации

Пространство имён `api.ui` группирует регистраторы UI:

- **Страницы** — `api.ui.pages.register({ id, path, title, mount })` добавляет
  маршрут в пространство имён плагина. `mount` получает предоставленный
  хостом контейнер и может вернуть функцию разбора.
- **Панели настроек** — `api.ui.settingsPanels.register(...)` добавляет панель
  на экран настроек.
- **Действия панели инструментов** — `api.ui.toolbarActions.register({ id, title, icon,
run })`. Хост отображает действие как стандартную кнопку; вы
  предоставляете только семантику, никогда не макет и не контрольные точки.
- **Действия сообщений** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. Обратный вызов `run` получает неизменяемый
  снимок сообщения плюс `AbortSignal`, срабатывающий при разборе, повторном
  вызове или таймауте.
- **Элементы контекстного меню** — `api.ui.contextMenuItems.register({ id, title,
context, run })` для `context: 'message' | 'character'`.
- **Рендереры сообщений** — `api.ui.messageRenderers.register({ id, title,
render })`. `render` возвращает обычный текст с `placement` `'replace'` или
  `'after'` — никогда не HTML.
- **Вкладки персонажа** — `api.ui.characterTabs.register({ id, title, mount })`.
  `mount` получает `{ characterId }` как контекст.
- **Панели боковой панели** — `api.ui.sidebarPanels.register({ id, title, slot,
mount })` со `slot: 'left' | 'right'`.
- **Диалоги** — `api.ui.dialogs.register({ id, title, description, mount })`.
- **Действия палитры команд** — `api.ui.commands.register({ id, title, run })`.
- **Горячие клавиши** — `api.ui.hotkeys.register({ id, combo, run })`, например
  `combo: 'mod+shift+k'`.

Слэш-команды регистрируются отдельно через `api.slash.register({ name,
description, run })`, а перехватчики промптов — через `api.interceptors`.

## Перехватчики промптов

Перехватчик выполняется на собранном промпте перед отправкой:

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages is an array of { id, role, content, name }.
    return context;
  },
});
```

Меньший `priority` выполняется раньше; плагин, превысивший `timeoutMs`,
пропускается без разрыва цепочки. Перехватчикам, которые только просматривают
промпт, нужно `prompt.inspect`; тем, которые его изменяют, — `prompt.modify`.

## События

Шина событий типизирована и разделяется с хостом. `api.events.on(event,
handler)` возвращает функцию отписки:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

Встроенные события включают `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed` и
`language.changed`. Плагины также могут испускать и слушать пользовательские
события с именами, разделяемыми пространствами имён по соглашению, например
`myplugin.foo`.

## Снимки сообщений и ограничение контента

Действия сообщений получают неизменяемый `MessageActionSnapshot` с
`messageId`, `chatId`, `branchId`, `role`, `content`, `name`, `meta` и
`revision`. Поле `content` равно `null`, если плагин не обладает также
`chat.read`, поэтому действие может отображать метаданные, никогда не видя
текста сообщения.

## Уведомления и i18n

`api.notify({ title, description, variant, timeoutMs })` показывает
уведомление и возвращает функцию его закрытия. `variant` — это `info`,
`success`, `warning` или `error`.

`api.i18n` управляет ресурсами переводов в изолированном пространстве имён
плагина:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` возвращает функцию очистки, как и любая другая регистрация.

## Гарантии очистки

Поскольку каждая регистрация возвращает функцию очистки, а рантайм
отслеживает их, отключение плагина удаляет все его обработчики, таймеры,
узлы DOM, подписки и фоновые запросы. Полный контракт разбора см. в
[Жизненный цикл](lifecycle.md), а точные типы — в генерируемом
[справочнике Plugin SDK](../../api/plugin-sdk/).
