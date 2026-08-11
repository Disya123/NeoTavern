---
title: Ciclo de vida del plugin
description: >-
  Cómo pasan los plugins de la instalación al consentimiento, la activación y
  el desmontaje.
sidebar_position: 6
---

Un plugin avanza por un ciclo de vida definido: instalación,
consentimiento, activación, activo y, finalmente, desmontaje. Cada
transición la impone el host.

## Instalación

La instalación ocurre a través del gestor de plugins. Puedes instalar un
archivo ZIP `.stplugin` limitado o un enlace a un repositorio público
(`github.com` o `gitlab.com`, solo HTTPS). El host nunca invoca el binario
de git; descarga un archivo del repositorio y lo pasa por exactamente la
misma validación que un ZIP: traversal de rutas, enlaces simbólicos, cargas
ejecutables, tamaños, campos del manifiesto, puntos de entrada y permisos.
La instalación es atómica y revierte ante cualquier error.

Si el paquete incluye un `package.json` con dependencias, el resolvedor
integrado las obtiene del registro de npm sin ejecutar scripts de
instalación. En su lugar, agrupa tus dependencias cuando sea posible; el
resolvedor existe para bibliotecas WASM pesadas que no pueden agruparse
razonablemente.

## Consentimiento

Después de la validación, el plugin entra en un estado `needs-consent`.
Permanece allí hasta que el usuario confirma cada permiso solicitado (y
revisa la lista de dependencias de npm cuando existe). Ningún punto de
entrada se ejecuta durante esta fase. Consulta [Permisos](permissions.md)
para el modelo completo.

## Activación

La activación es una operación de dos fases:

1. Los registros de backend y heredados se inician primero.
2. La entrada de frontend se carga y recibe su API.

Si la activación falla a mitad de camino, el host revierte los registros
parciales y registra un fallo de carga. Una activación fallida nunca deja
superficies a medio registrar.

## Runtime Activo

Mientras está activo, cada registro que hace el plugin — superficies de
interfaz, rutas, suscripciones de eventos, recursos i18n, notificaciones,
proveedores, tokenizadores, estrategias de contexto y post-procesadores — lo
recopila el runtime. El plugin también puede gestionar sus propios recursos
en `deactivate()`.

## Desmontaje

Deshabilitar, el modo seguro, la eliminación, un fallo o el apagado de la
aplicación disparan una limpieza impuesta por el host. El runtime desecha
los registros recopilados en orden inverso, y las garantías son estrictas:
después de deshabilitar un plugin, no queda nada.

- Sin manejadores de eventos ni suscripciones.
- Sin temporizadores.
- Sin nodos DOM.
- Sin rutas montadas.
- Sin solicitudes en segundo plano.
- Sin proveedores, tokenizadores ni estrategias registrados.

Un error lanzado por el propio `deactivate()` del plugin no cancela la
limpieza requerida — el host igualmente desecha todo lo que rastrea. El
desmontaje es idempotente: llamarlo dos veces no tiene efecto.

## Actualización

Actualizar reemplaza el paquete atómicamente y conserva el estado de
activación actual, con una excepción: si el manifiesto nuevo agrega
permisos, el runtime se deshabilita de inmediato y permanece deshabilitado
hasta que el usuario consiente los permisos nuevos. Volver a una versión
anterior se hace instalando esa versión de nuevo; los datos de usuario en el
almacenamiento del plugin sobreviven en ambas direcciones.

## Manejo de Fallos

Un plugin de backend se ejecuta en su propio proceso. Si ese proceso falla,
el host elimina todos los registros del plugin e informa del fallo. Un
plugin que falla no puede dejar rutas huérfanas ni suscripciones de eventos,
porque son propiedad del host, no del proceso.

Para el modelo de seguridad que hace posibles estas garantías, consulta
[Sandbox](sandboxing.md). Para los campos del manifiesto que impulsan el
ciclo de vida, consulta [Manifiesto](manifest.md).
