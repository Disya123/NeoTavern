---
title: Compatibilidad heredada
description: Los contratos documentados de la era de SillyTavern que siguen funcionando.
sidebar_position: 8
---

NeoTavern conserva un conjunto de contratos documentados para las
extensiones existentes de la era de SillyTavern, para que los plugins
escritos contra esas APIs puedan seguir funcionando mientras el Plugin SDK
nativo es el camino a seguir.

## Variables Globales de Window

El paquete `@neotavern/legacy-compat` instala las variables globales de window
documentadas que las extensiones antiguas esperan:

- `window.SillyTavern` — con `getContext()`, `eventSource` y
  `event_types`.
- `window.eventSource` — la fuente de eventos heredada.
- `window.event_types` — las constantes de nombres de eventos.
- `window.extension_settings` — el objeto compartido de ajustes de
  extensiones.
- `window.$` y `window.jQuery` — la instancia de jQuery incluida.

Estas variables globales se instalan de forma idempotente y se conectan al
host a través de un puente, por lo que el código heredado puede leer el
mismo contexto y los mismos eventos que el código nativo.

## Islas DOM No Gestionadas

Las extensiones de frontend heredadas esperan ser dueñas de una parte de la
página. El host proporciona islas DOM no gestionadas para este propósito:
un contenedor estable al que el código heredado puede adjuntarse y
manipular directamente, fuera del árbol de React. Las extensiones reciben el
contenedor, y el host se encarga del resto de la aplicación a su alrededor.

## Plugins de Servidor Heredados

Los plugins de servidor heredados se ejecutan a través de un host de
compatibilidad de Express. Sus rutas se proxean bajo
`/api/plugins/{pluginId}/...`, coincidiendo con el mismo espacio de nombres
que usan los plugins de backend nativos. La integración `@fastify/express`
se usa solo dentro de esta capa de compatibilidad — el nuevo núcleo es
nativo de Fastify y no enruta a través de Express.

## El Límite de Confianza

Los puntos de entrada heredados son un modo de confianza, no un bypass del
sandbox. Un paquete que los usa debe declarar `legacy.frontend` o
`legacy.backend` en su manifiesto y solicitar el permiso `legacy.trusted`,
que la interfaz de consentimiento muestra con una advertencia reforzada. El
código de frontend heredado se ejecuta en la ventana principal, y el código
de backend heredado recibe un enrutador Express con ámbito en su propio
espacio de nombres de plugin. El modo seguro no carga puntos de entrada
heredados en absoluto. Consulta [Sandbox de plugins](plugin-sdk/sandboxing.md)
y [Manifiesto del plugin](plugin-sdk/manifest.md) para los detalles.

## Lo Que No Está Soportado

La compatibilidad es un contrato documentado, no una promesa de
comportamiento universal. Los plugins que dependen de cualquiera de lo
siguiente no están soportados:

- Nombres de clase CSS internos aleatorios.
- Monkey patching de los internos de la aplicación.
- Importaciones privadas de paquetes que no les pertenecen.

Estos son detalles de implementación y cambian entre versiones. Cuando una
API heredada cambia, el cambio se publica con una guía de migración y una
prueba de compatibilidad.

## Migrar Hacia Adelante

Para funcionalidad nueva, el [Plugin SDK](plugin-sdk/index.md) nativo es el
camino soportado: versionado, verificado por permisos, en sandbox y limpiado
por el host. La compatibilidad heredada existe para mantener vivas las
extensiones existentes, no para crecer. Porta las extensiones al SDK para
obtener todas las garantías de seguridad y ciclo de vida.
