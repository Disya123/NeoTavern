---
title: Información general del Plugin SDK
description: Qué es el Plugin SDK y cómo funciona la división entre las APIs de frontend y backend.
sidebar_position: 1
---

El Plugin SDK es la API pública versionada que los plugins usan para ampliar
NeoTavern, y cubre tanto la interfaz del lado del navegador como el backend
del lado del servidor.

## Qué Es el Plugin SDK

Los plugins son paquetes ZIP (`.stplugin`) que incluyen un manifiesto,
puntos de entrada de frontend y backend opcionales, y recursos. Amplían la
aplicación solo a través del paquete `@neotavern/plugin-sdk` — nunca importando
Fastify, React, Zustand, TanStack Query, la conexión SQLite ni los
componentes internos directamente. Esos son detalles de implementación del
host y cambian sin previo aviso.

El SDK está versionado (`apiVersion` en el manifiesto) para que los plugins
sigan funcionando entre actualizaciones de la aplicación. El host impone el
contrato: todo lo que registres a través del SDK se limpia cuando tu plugin
se deshabilita, y lo que necesitarías de los módulos internos está
deliberadamente no expuesto.

## División entre Frontend y Backend

Un plugin tiene dos mitades opcionales:

- **Frontend** — una entrada ESM de navegador que recibe `FrontendPluginApi`
  en su llamada `activate()`. Registra superficies de interfaz como acciones
  de barra de herramientas, acciones de mensaje, comandos de barra y paneles
  de ajustes, y escucha los eventos de la aplicación.
- **Backend** — una entrada ESM de Node.js que recibe `ServerPluginApi`.
  Monta rutas bajo `/api/plugins/{pluginId}/`, lee y escribe almacenamiento
  aislado, realiza llamadas de red verificadas por permisos y registra
  proveedores y estrategias de ajuste de contexto.

Ambas mitades son opcionales. Un plugin que solo agrega un botón de barra de
herramientas no necesita backend; un plugin que solo sirve una API no
necesita frontend. Cada registro devuelve una función de limpieza, y el
runtime las recopila para que la desactivación no deje nada atrás.

## Crear un Plugin

Importa `definePlugin` desde `@neotavern/plugin-sdk` y exporta una definición con
una función `activate(api)`:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

La [referencia del Plugin SDK](../api/plugin-sdk/) generada documenta cada
tipo y función exportados con su firma exacta.

## Siguientes Pasos

- [Manifiesto](manifest.md) — la estructura del paquete y el esquema de
  `plugin.json`.
- [Permisos](permissions.md) — el modelo de permisos y el flujo de
  consentimiento.
- [API de frontend](frontend.md) — registrar superficies de interfaz y
  eventos.
- [API de backend](backend.md) — rutas, almacenamiento y abstracciones del
  servidor.
- [Ciclo de vida](lifecycle.md) — instalar, habilitar, deshabilitar y
  garantías de limpieza.
- [Sandbox](sandboxing.md) — el modelo de seguridad para código no
  confiable.
