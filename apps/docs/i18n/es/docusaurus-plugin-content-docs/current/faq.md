---
title: Preguntas frecuentes
description: >-
  Preguntas frecuentes sobre datos, uso sin conexión, plugins,
  actualizaciones y migración
sidebar_position: 2
---

Esta página responde a las preguntas que los usuarios hacen con más
frecuencia sobre NeoTavern.

## ¿Dónde Se Guardan Mis Datos?

Todos tus datos — chats, personajes, personas, grupos, lorebooks, memoria y
ajustes — viven en un directorio de datos en tu máquina. El directorio
contiene la base de datos SQLite y el almacén de archivos con fichas de
personaje, imágenes y otros recursos. Consulta
[Datos y almacenamiento](./developers/data/) y
[Datos y respaldos](./user-guide/data-and-backups) para conocer la
estructura exacta y cómo moverla.

## ¿NeoTavern Funciona Sin Conexión?

Sí. NeoTavern es local-first y funciona sin conexión: apúntalo a un endpoint
de modelo local y podrás chatear sin ninguna conexión a internet. Los
proveedores en la nube obviamente necesitan la red, y la app te avisa cuando
falta una conexión.

## ¿Se Envían Mis Datos a la Nube?

No. Tus chats y archivos permanecen en tu máquina. El único tráfico de red
son las solicitudes que configuras explícitamente — los proveedores que
conectas para generación, voz e imágenes — y la app no envía telemetría por
defecto.

## ¿Necesito una Clave de API?

Solo para los proveedores en la nube que elijas conectar. Los modelos
locales no necesitan ninguna clave; configuras cada proveedor en
Configuración y la clave permanece en tu perfil de conexión.

## ¿Son Seguros los Plugins?

Los plugins funcionan bajo un modelo de permisos y están aislados en un
sandbox: los plugins de backend se ejecutan en un proceso restringido y la
interfaz del plugin está aislada de la app principal. Concedes los permisos
al instalarlos, y el modo seguro inicia la app sin plugins ni temas si algo
sale mal. Consulta [Extensiones](./user-guide/extensions) y el
[Plugin SDK](./developers/plugin-sdk/).

## ¿Puedo Usar Mis Personajes Existentes?

Sí. NeoTavern importa fichas de personaje estándar, incluidas las tarjetas
PNG con JSON incrustado, por lo que los personajes de otras apps de chat y
de la galería comunitaria de personajes funcionan directamente. Consulta
[Personajes](./user-guide/characters).

## ¿Puedo Migrar Mis Plugins de la Era de SillyTavern?

Los plugins escritos para el entorno antiguo de SillyTavern pueden ejecutarse
a través de la capa de compatibilidad heredada, que proporciona las
conocidas variables globales `window.SillyTavern`, `window.eventSource` y
`window.$`, además de un host HTTP compatible con Express. Es una vía de
compatibilidad, no un objetivo de reescritura: los plugins nuevos deben usar
el [Plugin SDK](./developers/plugin-sdk/). Consulta
[Compatibilidad heredada](./developers/legacy-compat).

## ¿Cómo Funcionan las Actualizaciones?

Las actualizaciones se instalan en el mismo lugar y conservan tu directorio
de datos. El registro de cambios enumera lo que cambió en cada versión;
léelo antes de actualizar para detectar cambios incompatibles.

## ¿Cuáles Son los Requisitos del Sistema?

NeoTavern funciona en Windows (instalador o versión portátil), macOS
(paquete) y Linux (AppImage o archivo). La app de escritorio incluye su
propio runtime de Node.js, así que no necesitas instalar nada más. Un
sistema operativo actual de 64 bits y unos cientos de megabytes de RAM libre
para el backend son suficientes para un uso típico.

## ¿Hay una Versión Web o Móvil?

La app de escritorio está construida con Tauri e incluye una PWA
complementaria: la interfaz web puede instalarse como una aplicación web
progresiva con un shell de app sin conexión. Consulta
[Escritorio](./developers/desktop/).

## ¿Cómo Hago Respaldos de Mis Datos?

Exporta los chats a archivos, exporta toda tu biblioteca o copia el
directorio de datos con la app detenida. Los respaldos son archivos simples
y portátiles; para restaurarlos, impórtalos o vuelve a colocarlos en su
lugar. Consulta [Datos y respaldos](./user-guide/data-and-backups) y
[Respaldos](./developers/data/backups).

## ¿Qué Es el Modo Seguro?

El modo seguro inicia NeoTavern sin plugins ni temas para que puedas
diagnosticar problemas causados por código de terceros. Úsalo cuando la app
no arranque después de instalar un plugin o un tema. Consulta
[Solución de problemas](./getting-started/troubleshooting).

## ¿Cómo Informo de un Error o Solicito una Función?

Abre un issue en el
[repositorio de GitHub](https://github.com/Disya123/NeoTavern) con la
versión, tu sistema operativo y los pasos para reproducirlo. Las solicitudes
de funciones también son bienvenidas allí.

## ¿Dónde Puedo Encontrar el Registro de Cambios?

El registro de cambios vive en el repositorio en
[CHANGELOG.md](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).
