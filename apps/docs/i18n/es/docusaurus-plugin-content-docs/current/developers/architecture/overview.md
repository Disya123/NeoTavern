---
title: Información general del monorepo
description: >-
  La estructura del monorepo de NeoTavern, el flujo de datos entre servidor
  y web, y el principio local-first que da forma a la arquitectura.
sidebar_position: 2
---

NeoTavern es una aplicación local-first: un único proceso Fastify sirve la
API y el frontend compilado opcional, sin bases de datos externas, colas ni
contenedores requeridos.

## Estructura del Monorepo

El workspace es un monorepo de pnpm con dos grupos de nivel superior,
`apps/` y `packages/`:

```text
apps/
  server/          # Backend Fastify: API, pipeline de prompt, SSE, host heredado
  web/             # SPA de React
  plugin-runtime/  # Proceso de Node.js restringido para plugins de backend
  desktop/         # Shell de Tauri 2; ejecuta el servidor como proceso sidecar
packages/
  shared/        # IDs UUIDv7, Result, errores, logger, utilidades asíncronas
  contracts/     # Esquemas de API TypeBox — única fuente de verdad
  db/            # SQLite: esquema, migraciones, repositorios, FTS5
  ui/            # Componentes headless sobre primitivas Radix
  i18n/          # Configuración de i18next y recursos de idioma
  plugin-sdk/    # Manifiesto de plugins, permisos y contratos de API
  theme-sdk/     # Tokens de tema, niveles y herencia
  provider-sdk/  # Contrato de adaptador de proveedor y adaptadores
  legacy-compat/ # Variables globales de window e islas DOM de compatibilidad
  gestures/      # Gestos de fila independientes del framework
  plugin-build/  # Pipeline de compilación y publicación de plugins
```

## Apps

- `apps/server` — el backend Fastify. Expone la API `/api/v2/*`, ejecuta el
  pipeline de prompt, transmite la generación por SSE y aloja la superficie
  heredada compatible con Express. Cada módulo es un plugin de Fastify
  aislado.
- `apps/web` — la SPA de React. Se comunica con el servidor por HTTP y
  renderiza el espacio de trabajo de chat, además de las superficies de
  personajes, ajustes, proveedores, temas y plugins.
- `apps/plugin-runtime` — un proceso de Node.js con permisos limitados en el
  que se ejecutan los plugins de backend no confiables, aislado del proceso
  principal del servidor.
- `apps/desktop` — el shell de Tauri 2. Inicia el servidor compilado como un
  sidecar de Node.js autónomo y abre la vista web solo después de que la API
  local esté lista.

## Paquetes

El código compartido vive en paquetes de alcance reducido bajo `packages/`.
Cada paquete tiene una responsabilidad, y las dependencias solo apuntan
hacia abajo: `server` y `web` dependen de los paquetes, y los paquetes
dependen como máximo de `shared` y `contracts`. Consulta
[Paquetes](packages) para el desglose completo.

## Flujo de Datos

Una solicitud típica fluye por estas capas:

1. El frontend llama a un endpoint `/api/v2/*` a través de TanStack Query.
2. Fastify valida la entrada contra un esquema de TypeBox y devuelve errores
   en la estructura `{ code, params, traceId }`.
3. Los repositorios de `@neotavern/db` leen y escriben en SQLite, con paginación
   por cursor y búsqueda FTS5.
4. La generación ejecuta `POST /api/v2/chats/:id/generate`: el pipeline de
   prompt ensambla el contexto, el adaptador de proveedor serializa la
   solicitud, la respuesta se transmite por SSE y el mensaje se guarda.

La app web es una sola página: las rutas cambian el espacio de trabajo de
chat, mientras que personajes, ajustes, proveedores, temas y plugins se
renderizan en una superficie de diálogo sobre la ubicación de chat
conservada.

## Principio Local-First

Todo se ejecuta en tu máquina:

- El backend se vincula a `127.0.0.1` por defecto. El acceso remoto es una
  aceptación explícita con sesiones limitadas y requisitos HTTPS.
- Todos los datos viven en un único directorio de datos local: una sola base
  de datos SQLite más un almacén de archivos direccionado por contenido. Sin
  PostgreSQL, Redis ni Docker.
- La app funciona sin conexión. Las llamadas al proveedor son el único
  tráfico de red, y el adaptador `echo` integrado te permite probar todo el
  pipeline sin ningún proveedor.
- Los respaldos, las exportaciones y la importación de SillyTavern ocurren
  localmente a través de las mismas APIs de SQLite y archivos.

Consulta [Datos y almacenamiento](../data/) para la capa de almacenamiento y
[Pipeline de prompt](../prompt-pipeline/) para la ruta de generación.
