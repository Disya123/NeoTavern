---
title: Modo seguro
description: >-
  Cómo deshabilita el modo seguro los temas y plugins de terceros, y por qué
  el restablecimiento siempre funciona.
sidebar_position: 6
---

El modo seguro es el mecanismo de recuperación de la capa visual:
deshabilita los temas y plugins de terceros para que la interfaz siempre
vuelva a un estado funcional.

## Qué Hace el Modo Seguro

El modo seguro se activa con `?safe=1` en la URL. Se maneja antes de que se
cargue cualquier código de paquete:

- El CSS de los temas de terceros y las anulaciones de tokens no se agregan
  al documento.
- Los puntos de entrada de los plugins de terceros nunca se ejecutan,
  incluidos los puntos de entrada heredados.
- El tema integrado y el runtime de plugins integrado permanecen activos.

La interfaz recurre a los tokens claro y oscuro integrados, que siempre
están presentes. Salir del modo seguro restaura el estado de tema y plugin
activo guardado previamente — salir no cambia tu selección.

## Por Qué un Tema Roto No Puede Bloquear la Recuperación

Varias garantías protegen al usuario de un tema roto:

- **Vista previa antes de aplicar** — los temas se previsualizan antes de la
  activación, e instalar un paquete nunca lo activa automáticamente.
- **El modo seguro es previo a los paquetes** — `?safe=1` se procesa antes
  de consultar el registro de temas, por lo que ni siquiera un tema cuyo CSS
  bloquea el renderizador se carga.
- **El botón de restablecimiento** — la acción de restablecer devuelve el
  tema integrado, elimina los enlaces de CSS del runtime y borra las
  anulaciones en línea de `--st-*`. Eliminar el tema activo también
  restablece la selección de tema guardada.
- **Los temas no pueden ocultar Ajustes** — la barra de navegación siempre
  mantiene accesible el elemento Ajustes, porque los elementos de sistema
  omitidos se restauran en el orden estándar. En el modo seguro se usa el
  orden integrado de la barra y el conmutador de menú permanece disponible.
- **Sin ejecución de código** — los temas no contienen JavaScript en
  absoluto. Son CSS, tokens y diseño declarativo, por lo que no hay código
  de tema que pueda ejecutarse antes de que el modo seguro surta efecto.

## Restricciones del Paquete de Tema

Un paquete de tema nunca recibe acceso a chats, claves de API ni al sistema
de archivos. Sus hojas de estilo se validan contra construcciones prohibidas
(`@import`, URL remotas, URL `javascript:`, `expression()`, `!important` y
otras) antes de aceptarse, y sus tokens deben ser valores CSS seguros. No
hay punto de entrada ejecutable en el Theme SDK.

## Modo Seguro para Plugins

El mismo interruptor deshabilita los plugins de terceros. Los sandboxes de
plugins, el aislamiento de procesos y la limpieza impuesta por el host son
la capa de runtime; el modo seguro es el interruptor de cinturón y
tirantes que evita que el código no confiable se cargue en primer lugar.
Consulta [Sandbox de plugins](../plugin-sdk/sandboxing.md) para los
detalles del lado de los plugins.

## Verificar el Modo Seguro Programáticamente

El paquete `@neotavern/theme-sdk` exporta `getSafeModeFromSearch(search)`, que
analiza la cadena de búsqueda de la URL y devuelve si `?safe=1` está
presente. El host lo usa como la única puerta antes de cargar el CSS de los
paquetes y las anulaciones de tokens, y la misma función está disponible
para hosts alternativos.

Para las áreas del shell que permanecen disponibles en el modo seguro,
consulta [Contrato del shell](shell-contract.md).
