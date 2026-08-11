---
title: Дизайн-токены
description: Контракт семантических дизайн-токенов и что компоненты не могут захардкодить.
sidebar_position: 3
---

Дизайн-токены — это семантические переменные, несущие все визуальные значения
в приложении. Компоненты ссылаются на них; темы их переопределяют; ничего не
захардкожено.

## Контракт токенов

Каждый токен — это CSS-кастомное свойство с префиксом `--st-`, и каждое имя
токена входит в версионируемый контракт в `@neotavern/theme-sdk`. Хост поставляет
значения по умолчанию для светлого и тёмного режимов, поэтому каждый токен
всегда разрешается, даже когда тема не определяет ни одного.

Канонические группы токенов:

- **Цвета текста** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Поверхности** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Акцент и статусы** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Markdown сообщений чата** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Типографика** — `font-ui`, `font-mono`, `font-size-2xs` вплоть до
  `font-size-2xl`, `line-height-body`, `font-weight-normal` вплоть до
  `font-weight-bold`.
- **Отступы** — `space-2xs` вплоть до `space-3xl`.
- **Радиусы и границы** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **Возвышение** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Слои (z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Анимации** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Размеры элементов управления** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Размеры панелей и контента** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Ограничения области просмотра** — `overlay-width-limit`,
  `overlay-height-limit`, `dialog-sheet-height`.
- **Скроллбары** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **Размеры оболочки приложения** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **Холст чата** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Метрики типографики чата** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **Регулируемые пользователем ручки** — `custom-glass-blur`,
  `custom-ui-opacity`.

## Переопределение токенов

Тема переопределяет любое подмножество имён. Значения проверяются: они должны
быть безопасными непустыми CSS-значениями, а конструкции вроде `{`, `}` и `;`
отклоняются.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

Если пользователь выбирает фон чата, приложение задаёт ограниченное кастомное
свойство для изображения обоев на корне рабочего пространства; позиция,
размер, оверлей и размытие остаются токенами темы.

## Правила разрешения

Токены разрешаются в этом порядке, побеждает более поздний:

1. Встроенные значения по умолчанию для активного режима.
2. Цепочка родительских тем, начиная с корня.
3. Сама тема.

Тёмный режим переключается на светлые токены темы, когда тёмного оверрайда
нет, поэтому тема только для светлого режима всё равно работает в тёмном.
Функции `resolveTokens` и `buildThemeVariables` в `@neotavern/theme-sdk`
реализуют это, а хост записывает результат как CSS-переменные на
`document.documentElement`.

## Что компоненты не могут захардкодить

Контракт стилизации запрещает хардкод значений где-либо во встроенном UI, и
те же правила применимы к тому, на что тема не должна опираться:

- Числовые `font-weight`, `font-size` в px и сырые `border-radius` в px.
- Числовые значения `z-index` — используйте токены `layer-*`.
- Размеры элементов управления вроде `40px`, `44px`, `52px`, `32px` и `36px`.
- `!important` в CSS темы, кроме слоя предпочтений доступности.
- Правила макета: координаты, схемы grid и flex, контрольные точки и порядок
  областей не входят в контракт токенов. Контрольные точки берутся из реестра
  (`VIEWPORT_BREAKPOINTS` и `CONTAINER_BREAKPOINTS`), а перемещение областей
  оболочки вне области действия v1.

Геометрия контента, такая как схема grid карточных списков, — явное
исключение: она не покрывается контрактом токенов. Всё, что нужно теме для
перестилизации, доступно через токены, хуки и декларативный макет оболочки.
Генерируемый [справочник Theme SDK](../../api/theme-sdk/) документирует точный
список `TokenName`.
