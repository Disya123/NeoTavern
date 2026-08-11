---
title: Contrato del shell
description: Las áreas con nombre del shell que los temas estilizan y los plugins llenan.
sidebar_position: 5
---

El contrato del shell define las áreas con nombre de la aplicación. Los
temas estilizan estas áreas; los plugins agregan contenido a través de
ranuras estables.

## Áreas del Shell con Nombre

El host publica cada área principal con un atributo de ranura estable:

| Ranura               | Área                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `app.shell`          | La raíz del shell de la aplicación                                       |
| `navigation.primary` | La barra de navegación                                                   |
| `chat.header`        | El encabezado del chat                                                   |
| `chat.viewport`      | El área de desplazamiento del chat                                       |
| `chat.composer`      | El redactor de mensajes                                                  |
| `character.browser`  | La raíz del navegador de personajes                                      |
| `panel.left`         | El panel de contexto izquierdo                                           |
| `status.area`        | El área de estado de la conexión                                         |
| `modal.layer`        | La capa de modales (los plugins por debajo de la superficie del sistema) |
| `notification.layer` | La capa de notificaciones                                                |

Dos ranuras están reservadas pero no forman parte de v1: `navigation.secondary`
y `panel.right`.

## Lo Que Permite el Contrato

Un tema puede:

- **Estilizar cualquier área con nombre** a través de su atributo `data-slot`
  y los hooks de componentes dentro de ella.
- **Organizar las áreas principales** a través del `shellLayout` declarativo
  en el manifiesto — actualmente el orden de la barra de navegación (grupos
  `main` y `bottom`) y la colocación de las pestañas de gestión (`pinned`).
- **Reemplazar el fondo del lienzo de chat** a través de los tokens
  `chat-wallpaper-*`.

La reordenación libre de áreas — mover la barra al lado derecho, por ejemplo
— no forma parte de v1. Las ranuras se estilizan y se llenan, no se
reubican.

## Cómo Agregan Contenido los Plugins

Los plugins reciben las APIs de registro del SDK y el host coloca su
contenido en las ranuras estables. Por ejemplo, un panel lateral registrado
con `slot: 'left'` se renderiza dentro de `panel.left`, y los diálogos de
los plugins se apilan dentro de `modal.layer` por debajo de la superficie
del sistema.

El contrato que se deriva de esta división:

- Los temas nunca dependen del DOM interno de un plugin.
- Los plugins nunca dependen de la jerarquía interna de React ni de nombres
  de clase generados específicos.
- Ambas partes se encuentran solo en las ranuras con nombre y los atributos
  de hooks.

## Hooks Estables Dentro de las Áreas

Dentro de las áreas, los componentes publican los atributos de hooks
estándar. Ejemplos notables:

- La raíz del redactor publica `data-slot="chat.composer"`, con una parte de
  barra de herramientas, una parte de campo y una entrada
  `data-component="textarea"`.
- Los botones publican `data-component="button"` con `data-part="icon"` y
  `data-part="label"`; las acciones relacionadas viven en una barra de
  acciones (`data-component="action-bar"`) con grupos primario y secundario.
- Las pestañas publican `data-component="tabs"` con partes `list`, `trigger`
  y `content`; los paneles de gestión usan la variante de segmentos.
- Los mensajes publican `data-component="chat-message"` con
  `data-role="user|assistant|system|tool"` y estados como `streaming`.
- La barra de navegación publica `data-component="navigation-rail"` con
  `data-part="main-items"`, `data-part="bottom-items"` y
  `data-item="<id>"` por entrada, más `data-state="expanded|collapsed"`.
- Todos los paneles de la barra comparten un encabezado común
  (`data-component="sidebar-panel-header"`) para que un tema los estilice
  una sola vez.

## Responsabilidades del Diseño

El host es dueño del diseño crítico para el comportamiento: la captura de
foco, la dirección lógica RTL, los márgenes de área segura y los tamaños
mínimos de los objetivos interactivos. Un tema del shell puede cambiar el
aspecto y la disposición de las áreas, pero debe conservar el orden del DOM
donde está documentado, el desplazamiento horizontal de las listas de
acciones y el comportamiento del teclado. Los puntos de interrupción se
registran en el SDK (`VIEWPORT_BREAKPOINTS` para los anchos de viewport en
px, `CONTAINER_BREAKPOINTS` para los tamaños de contenedor en rem), y las
consultas de características como `prefers-reduced-motion` no son puntos de
interrupción de diseño.

Para la capa de estilos que da skin a estas áreas, consulta
[Skin de componentes](component-skin.md); para la recuperación cuando un
shell está roto, consulta [Modo seguro](safe-mode.md).
