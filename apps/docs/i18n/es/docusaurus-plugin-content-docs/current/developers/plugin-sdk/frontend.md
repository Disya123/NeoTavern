---
title: API de frontend del plugin
description: Cómo registra un plugin de frontend páginas, paneles, acciones, comandos y eventos.
sidebar_position: 4
---

La API de frontend es lo que recibe un plugin del lado del navegador en su
llamada `activate()`: un conjunto de registradores para cada superficie de
interfaz, el bus de eventos e i18n.

## Punto de Entrada

Un plugin de frontend exporta una definición con una función `activate(api)`.
El host la llama con el objeto `FrontendPluginApi` una vez que el plugin
está consentido y activo:

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

Cada registrador devuelve una función de limpieza. El runtime las recopila
automáticamente, por lo que tu plugin no necesita rastrearlas a mano —
aunque `deactivate()` todavía puede desmontar cualquier cosa que gestiones
tú mismo.

## Superficies de Registro

El espacio de nombres `api.ui` agrupa los registradores de interfaz:

- **Páginas** — `api.ui.pages.register({ id, path, title, mount })` agrega
  una ruta bajo el espacio de nombres del plugin. `mount` recibe un
  contenedor proporcionado por el host y puede devolver un desmontaje.
- **Paneles de ajustes** — `api.ui.settingsPanels.register(...)` agrega un
  panel a la pantalla de Ajustes.
- **Acciones de barra de herramientas** — `api.ui.toolbarActions.register({ id,
title, icon, run })`. El host renderiza la acción como un botón estándar;
  tú solo proporcionas la semántica, nunca el diseño ni los puntos de
  interrupción.
- **Acciones de mensaje** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. La devolución de llamada `run` recibe una
  instantánea de mensaje inmutable más un `AbortSignal` que se dispara en el
  desmontaje, la re-invocación o el tiempo de espera.
- **Elementos de menú contextual** — `api.ui.contextMenuItems.register({ id,
title, context, run })` para `context: 'message' | 'character'`.
- **Renderizadores de mensaje** — `api.ui.messageRenderers.register({ id,
title, render })`. `render` devuelve texto sin formato con un `placement`
  de `'replace'` o `'after'` — nunca HTML.
- **Pestañas de personaje** — `api.ui.characterTabs.register({ id, title,
mount })`. `mount` recibe `{ characterId }` como contexto.
- **Paneles laterales** — `api.ui.sidebarPanels.register({ id, title, slot,
mount })` con `slot: 'left' | 'right'`.
- **Diálogos** — `api.ui.dialogs.register({ id, title, description, mount })`.
- **Acciones de paleta de comandos** — `api.ui.commands.register({ id, title,
run })`.
- **Atajos de teclado** — `api.ui.hotkeys.register({ id, combo, run })`, por
  ejemplo `combo: 'mod+shift+k'`.

Los comandos de barra se registran por separado a través de
`api.slash.register({ name, description, run })`, y los interceptores de
prompt a través de `api.interceptors`.

## Interceptores de Prompt

Un interceptor se ejecuta sobre el prompt ensamblado antes de que se envíe:

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

Una `priority` más baja se ejecuta antes; un plugin que supera `timeoutMs` se
omite sin romper la cadena. Los interceptores que solo inspeccionan el
prompt necesitan `prompt.inspect`; los que lo cambian necesitan
`prompt.modify`.

## Eventos

El bus de eventos está tipado y se comparte con el host.
`api.events.on(event, handler)` devuelve una función de cancelación de
suscripción:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

Los eventos integrados incluyen `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed` y
`language.changed`. Los plugins también pueden emitir y escuchar eventos
personalizados, con nombres con espacio de nombres por convención, por
ejemplo `myplugin.foo`.

## Instantáneas de Mensaje y Control de Contenido

Las acciones de mensaje reciben una `MessageActionSnapshot` inmutable con
`messageId`, `chatId`, `branchId`, `role`, `content`, `name`, `meta` y
`revision`. El campo `content` es `null` a menos que el plugin también tenga
`chat.read`, por lo que una acción puede renderizar metadatos sin ver nunca
el texto del mensaje.

## Notificaciones e i18n

`api.notify({ title, description, variant, timeoutMs })` muestra una
notificación y devuelve una función de descarte. `variant` es `info`,
`success`, `warning` o `error`.

`api.i18n` gestiona los recursos de traducción en un espacio de nombres de
plugin aislado:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` devuelve una función de limpieza como cualquier otro
registro.

## Garantías de Limpieza

Como cada registro devuelve una función de limpieza y el runtime las
rastrea, deshabilitar un plugin elimina todos sus manejadores,
temporizadores, nodos DOM, suscripciones y solicitudes en segundo plano.
Consulta [Ciclo de vida](lifecycle.md) para el contrato completo de
desmontaje, y la [referencia del Plugin SDK](../../api/plugin-sdk/) generada
para los tipos precisos.
