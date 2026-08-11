---
title: Extensiones y plugins
description: Instalar, habilitar, deshabilitar y desinstalar plugins en NeoTavern.
sidebar_position: 9
---

Esta página explica cómo funcionan los plugins en NeoTavern: dónde
conseguirlos, cómo funcionan los permisos y el consentimiento, y cómo la app
mantiene a raya el código no confiable.

## Qué Es un Plugin

Un plugin agrega comportamiento a NeoTavern — acciones de barra de
herramientas, acciones de mensaje, comandos de barra, interceptores de
prompt, paneles personalizados, atajos de teclado, rutas de backend o
integraciones con servicios externos. Los plugins se ejecutan contra el
Plugin SDK estable, no contra los internos de la app, y cada función que
registran se elimina de nuevo cuando el plugin se deshabilita.

El catálogo oficial incluye algunos plugins; los paquetes de terceros se
instalan desde un ZIP `.stplugin` o un enlace a un repositorio Git público
(GitHub o GitLab, solo HTTPS). El servidor nunca ejecuta Git ni npm: un
enlace de Git se descarga como archivo y se valida exactamente como un ZIP.

## Instalar un Plugin

Abre la sección Plugins e instala un paquete:

1. Antes de la instalación, la app muestra el autor, la versión, la fuente,
   la compatibilidad, la firma (cuando está firmado) y la lista completa de
   permisos.
2. Revisas y aceptas explícitamente los permisos. El paquete permanece en un
   estado de "requiere consentimiento" hasta que confirmas cada permiso
   solicitado.
3. La instalación es atómica: ante cualquier error, la versión anterior
   permanece instalada y funcionando.

Si el paquete declara dependencias de npm, se resuelven desde el registro
por HTTPS, se verifican con una suma de verificación y nunca se ejecutan:
los scripts de instalación y los binarios nativos se rechazan de plano.

## Permisos

Un permiso en el manifiesto es una solicitud de una capacidad, no un acceso
automático. Antes de que un plugin pueda leer chats, modificar prompts,
tocar tus archivos o alcanzar la red, debes otorgarle el permiso
correspondiente, y la pantalla de consentimiento describe qué hace cada uno.
Dos reglas importan:

- **Los permisos nuevos después de una actualización requieren un
  consentimiento nuevo.** Una actualización nunca puede ampliar los derechos
  de un plugin en silencio.
- Los permisos pueden revocarse. La revocación surte efecto en la siguiente
  llamada de capacidad del plugin.

## Gestionar Plugins

El gestor muestra el estado de cada plugin: habilitado, deshabilitado,
necesita permisos, incompatible o error. Desde allí puedes:

- **Habilitar o deshabilitar** un plugin. Deshabilitarlo elimina su interfaz,
  hooks, temporizadores, rutas y suscripciones sin reiniciar, y el host
  impone la limpieza.
- **Desinstalarlo**, lo que también borra sus registros.
- **Revisar la compatibilidad** de las extensiones heredadas de la era de
  SillyTavern, que muestran su nivel de compatibilidad y sus limitaciones
  conocidas.

Un error en un plugin está aislado: la app ofrece deshabilitar solo ese
plugin en lugar de romper toda la interfaz.

## Seguridad de los Plugins

Los plugins de backend no confiables se ejecutan en un proceso restringido
separado, y la interfaz de plugin en sandbox se ejecuta en un iframe con un
canal RPC controlado. Los paquetes de tema no reciben acceso a chats, claves
ni archivos. El modo seguro deshabilita todos los plugins y temas de
terceros y es accesible antes de que se carguen, por lo que cualquier
comportamiento incorrecto de un plugin siempre se puede escapar. Consulta
[Modo seguro y recuperación](themes) y la documentación del
[Plugin SDK](../developers/plugin-sdk/).
