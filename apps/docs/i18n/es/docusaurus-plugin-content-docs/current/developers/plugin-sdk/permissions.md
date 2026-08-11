---
title: Permisos del plugin
description: >-
  Cómo se declaran y conceden los permisos, y cuándo una actualización
  requiere un nuevo consentimiento.
sidebar_position: 3
---

Los permisos son el mecanismo que permite a los usuarios decidir qué puede
hacer un plugin, desde leer el historial de chat hasta hacer solicitudes de
red.

## El Modelo de Permisos

Un permiso es una cadena que nombra una capacidad. Declararlo en el
manifiesto es una solicitud, no un acceso automático: el usuario debe
confirmar cada permiso solicitado antes de que el plugin se active, y el
host aplica la concesión en cada punto de uso.

El conjunto integrado es un contrato estable y versionado:

| Permiso              | Qué concede                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `chat.read`          | Leer los mensajes del chat y sus metadatos                                   |
| `chat.write`         | Crear o modificar mensajes del chat                                          |
| `characters.read`    | Leer personajes y fichas de personaje                                        |
| `characters.write`   | Crear o modificar personajes                                                 |
| `lorebook.read`      | Leer entradas de lorebook                                                    |
| `lorebook.write`     | Crear o modificar entradas de lorebook                                       |
| `prompt.inspect`     | Inspeccionar el prompt ensamblado                                            |
| `prompt.modify`      | Modificar el prompt o post-procesar la salida de generación                  |
| `providers.register` | Registrar adaptadores y tokenizadores de proveedor                           |
| `ui.toolbar`         | Agregar acciones de barra de herramientas                                    |
| `ui.sidebar`         | Agregar paneles laterales                                                    |
| `ui.messageActions`  | Agregar acciones de mensaje                                                  |
| `ui.shell`           | Agregar contenido a las ranuras del shell                                    |
| `clipboard.read`     | Leer el portapapeles                                                         |
| `clipboard.write`    | Escribir en el portapapeles                                                  |
| `notifications`      | Mostrar notificaciones                                                       |
| `server.routes`      | Montar rutas de backend                                                      |
| `legacy.trusted`     | Ejecutar código heredado documentado de SillyTavern en contexto de confianza |

## Permisos con Ámbito

Algunos permisos llevan un ámbito, escrito como `kind:scope`:

- **`network:<hostname>`** — permiso para hacer fetch desde un host
  específico, por ejemplo `network:api.example.com`. Las solicitudes a hosts
  no concedidos se rechazan.
- **`network:*`** — un comodín que permite hacer fetch desde cualquier host.
  El host lo trata como acceso completo a la red y la interfaz de
  consentimiento lo muestra con una advertencia reforzada. Prefiere
  enumerar hosts concretos; publicar plugins que solicitan el comodín está
  desaconsejado.
- **`files:plugin`** — leer y escribir dentro del propio directorio de datos
  del plugin.
- **`files:user-selected`** — acceso a los archivos que el usuario
  seleccionó explícitamente.

`hasPermission` verifica un conjunto concedido contra un permiso requerido,
y `parsePermission` divide una cadena `kind:scope` en sus partes. La función
`validatePermissions` rechaza cadenas malformadas como vacías, duplicadas o
desconocidas.

## Cómo Se Aplican las Concesiones

Declarar un permiso no es suficiente; el host aplica la concesión en el
punto de aplicación:

- Los registros de interfaz verifican los permisos `ui.*` antes de montarse.
- Las rutas verifican `server.routes`.
- El `fetch` verificado por permisos comprueba `network:<host>`.
- El sistema de archivos virtual verifica `files:*`.
- Las APIs de proveedor y contexto verifican `providers.register` y
  `prompt.modify`.

El kernel de capacidades (espacio de nombres `kernel` de `@neotavern/plugin-sdk`)
es la capa compartida que verifica las concesiones tanto en el host web como
en el servidor, por lo que el navegador y el backend siempre ven los mismos
derechos efectivos. Las concesiones se guardan con una revisión monótona, se
entregan al sandbox durante el protocolo de inicio (bootstrap handshake) y
son revocables en el runtime. Las operaciones en curso completan con un
error `CAPABILITY_REVOKED` y el host cierra los handles abiertos.

## Consentimiento y Nuevo Consentimiento en la Actualización

La instalación muestra la lista completa de permisos solicitados. El plugin
permanece en un estado `needs-consent` hasta que confirmas cada permiso, y
la interfaz muestra la lista de dependencias cuando el paquete incluye
dependencias de npm.

Actualizar un plugin es una instalación nueva para la verificación de
permisos: el host calcula la diferencia entre el manifiesto anterior y el
nuevo con `diffPermissions`. Si la actualización agrega permisos:

- el runtime del plugin se deshabilita de inmediato;
- se le pide al usuario que consienta los permisos nuevos;
- el plugin permanece deshabilitado hasta que se da el consentimiento.

Quitar permisos nunca requiere consentimiento. La regla general: el conjunto
de permisos concedidos nunca crece sin una decisión explícita del usuario.
Para la lista completa de constantes y helpers de permisos, consulta la
[referencia del Plugin SDK](../../api/plugin-sdk/) generada.
