---
title: Tokens de diseño
description: >-
  El contrato semántico de los tokens de diseño y lo que los componentes no
  pueden codificar.
sidebar_position: 3
---

Los tokens de diseño son las variables semánticas que transportan todos los
valores visuales de la aplicación. Los componentes los referencian; los
temas los anulan; nada está codificado.

## El Contrato de Tokens

Cada token es una propiedad personalizada de CSS con el prefijo `--st-`, y
cada nombre de token es parte del contrato versionado en `@neotavern/theme-sdk`.
El host incluye valores predeterminados para los modos claro y oscuro, por
lo que cada token siempre se resuelve incluso cuando un tema no define
ninguno.

Los grupos canónicos de tokens son:

- **Colores de texto** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Superficies** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Acento y estado** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Markdown de mensajes de chat** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Tipografía** — `font-ui`, `font-mono`, `font-size-2xs` hasta
  `font-size-2xl`, `line-height-body`, `font-weight-normal` hasta
  `font-weight-bold`.
- **Espaciado** — `space-2xs` hasta `space-3xl`.
- **Radios y bordes** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **Elevación** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Capas (z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Movimiento** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Tamaños de control** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Tamaños de panel y contenido** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Límites de viewport** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **Barras de desplazamiento** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **Tamaños del shell de la app** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **Lienzo de chat** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Métricas tipográficas del chat** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **Perillas ajustables por el usuario** — `custom-glass-blur`,
  `custom-ui-opacity`.

## Anular Tokens

Un tema anula cualquier subconjunto de los nombres. Los valores se validan:
deben ser valores CSS seguros y no vacíos, y construcciones como `{`, `}` y
`;` se rechazan.

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

Si el usuario elige un fondo de chat, la aplicación define una propiedad
personalizada con ámbito para la imagen de fondo en la raíz del espacio de
trabajo; la posición, el tamaño, la superposición y el desenfoque siguen
siendo tokens del tema.

## Reglas de Resolución

Los tokens se resuelven en este orden, ganando el último:

1. Valores predeterminados integrados para el modo activo.
2. La cadena de temas padres, primero la raíz.
3. El propio tema.

El modo oscuro recurre a los tokens claros del tema cuando no existe una
anulación oscura, por lo que un tema solo claro sigue funcionando en modo
oscuro. Las funciones `resolveTokens` y `buildThemeVariables` de
`@neotavern/theme-sdk` implementan esto, y el host escribe el resultado como
variables CSS en `document.documentElement`.

## Lo Que los Componentes No Pueden Codificar

El contrato de estilos prohíbe valores codificados en cualquier lugar de la
interfaz integrada, y las mismas reglas se aplican a lo que un tema no debe
asumir:

- `font-weight` numérico, `font-size` en px y `border-radius` en px sin
  procesar.
- Valores numéricos de `z-index` — usa los tokens `layer-*`.
- Tamaños de control como `40px`, `44px`, `52px`, `32px` y `36px`.
- `!important` en el CSS del tema, excepto en la capa de preferencias de
  accesibilidad.
- Reglas de diseño: coordenadas, esquemas de grid y flex, puntos de
  interrupción y orden de áreas no forman parte del contrato de tokens. Los
  puntos de interrupción vienen del registro (`VIEWPORT_BREAKPOINTS` y
  `CONTAINER_BREAKPOINTS`), y mover áreas del shell está fuera del alcance
  de v1.

La geometría del contenido, como el esquema de grid de las listas de
tarjetas, es una excepción explícita: no está cubierta por el contrato de
tokens. Todo lo que un tema necesita para rediseñar está disponible a través
de tokens, hooks y el diseño declarativo del shell. La
[referencia del Theme SDK](../../api/theme-sdk/) generada documenta la lista
exacta de `TokenName`.
