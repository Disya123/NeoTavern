---
title: Manifiesto del plugin
description: El esquema plugin.json que debe contener todo paquete .stplugin.
sidebar_position: 2
---

El manifiesto del plugin (`plugin.json`) es la única fuente de verdad de un
plugin: identidad, puntos de entrada, permisos solicitados y capacidades
declaradas.

## Estructura del Paquete

Un paquete `.stplugin` es un archivo ZIP que contiene `plugin.json` en la
raíz, los archivos de entrada a los que hace referencia y cualquier recurso.
El host valida el archivo antes de instalar nada: se rechazan la traversal
de rutas, los enlaces simbólicos, las cargas ejecutables y los límites de
tamaño.

## Campos del Manifiesto

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

Los campos principales son:

- **`id`** — identificador de DNS inverso, por ejemplo `author.plugin-name`.
  Es único entre todos los plugins instalados y estable entre
  actualizaciones.
- **`name`** — nombre legible que se muestra en el gestor de plugins.
- **`version`** — versión semántica (`major.minor.patch`). Alimenta las
  comparaciones de versiones y la invalidación de caché.
- **`apiVersion`** — la versión de la API del SDK a la que apunta el plugin.
  La versión actual es 3; la versión 2 sigue siendo la predeterminada hasta
  que el nuevo runtime llegue a producción.
- **`engines`** — restricciones de compatibilidad como `neotavern: "^0.1.0"`.
- **`frontend`** — ruta relativa a la entrada ESM del navegador.
- **`backend`** — ruta relativa a la entrada ESM de Node.js.
- **`styles`** — hoja de estilos opcional del plugin.
- **`i18n`** — código de locale a ruta relativa de los archivos JSON de
  traducción.

## Permisos

La matriz `permissions` es la lista plana heredada del SDK v2. Los
manifiestos nuevos deberían declarar capacidades con ámbito en su lugar, a
través de `requiredCapabilities` y `optionalCapabilities`:

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` son capacidades sin las cuales el plugin no puede
funcionar; `optionalCapabilities` son aquellas sin las que puede degradarse.
El usuario confirma cada capacidad solicitada en el momento de la
instalación. Agregar permisos nuevos en una actualización requiere un nuevo
consentimiento — consulta [Permisos](permissions.md).

## Puntos de Entrada Heredados

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

El bloque `legacy` apunta a entradas de compatibilidad de confianza para
extensiones existentes de SillyTavern. Los paquetes que usan cualquiera de
las dos entradas deben solicitar el permiso `legacy.trusted`, y la interfaz
muestra una advertencia más fuerte durante el consentimiento. El modo seguro
nunca carga puntos de entrada heredados. Consulta [Sandbox](sandboxing.md)
para saber en qué se diferencia de los plugins nativos.

## Clientes OAuth

Los plugins que se conectan a un servicio externo pueden declarar clientes
públicos OAuth 2.0 con flujo de código de autorización y PKCE:

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

Solo se permiten clientes públicos: `clientSecret` está prohibido porque el
código del plugin se ejecuta en un sandbox. Los endpoints deben ser HTTPS,
con una excepción de loopback HTTP plano para proveedores de identidad
locales durante el desarrollo. Cambiar un descriptor requiere reinstalar el
paquete.

## Campos de Workers y Firma

Los manifiestos avanzados pueden declarar módulos adicionales:

- **`workers`** — módulos de entrada relativos al paquete que el plugin
  puede lanzar como workers de cómputo aislados. Lanzar una entrada no
  declarada se rechaza.
- **`publisher`** y **`signature`** — firma del paquete. `keyId` es la
  huella `ed25519:<hex>` de la clave pública de firma, y `signature` es la
  firma Ed25519 en base64 sobre el manifiesto canónico. Los define la
  herramienta de compilación de plugins, nunca se escriben a mano.

La función `validateManifest` del SDK verifica cada campo, y la
[referencia del Plugin SDK](../../api/plugin-sdk/) generada documenta el tipo
exacto `PluginManifest`.
