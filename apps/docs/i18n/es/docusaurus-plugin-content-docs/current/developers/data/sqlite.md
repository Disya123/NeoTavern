---
title: Almacenamiento SQLite
description: >-
  La configuración de la base de datos SQLite, las tablas STRICT, la
  búsqueda FTS5, los IDs UUIDv7 estables, las migraciones versionadas y el
  aislamiento de plugins.
sidebar_position: 2
---

NeoTavern guarda todos los datos estructurados en una única base de datos
SQLite con pragmas estrictos, tablas STRICT, búsqueda FTS5 y migraciones
versionadas.

## Configuración de la Base de Datos

La conexión se abre con la siguiente configuración:

- `foreign_keys = ON` — se aplica la integridad referencial.
- Modo de registro WAL — los lectores nunca son bloqueados por los
  escritores.
- `busy_timeout` — los escritores concurrentes esperan en lugar de fallar de
  inmediato.
- `synchronous = NORMAL` — durabilidad con rendimiento seguro para WAL.
- Sentencias preparadas — todas las consultas pasan por las sentencias
  preparadas de Drizzle; no hay interpolación de cadenas SQL sin procesar.
- Tablas STRICT siempre que sea posible — SQLite aplica los tipos de
  columna.
- FTS5 — búsqueda de texto completo sobre personajes, chats y mensajes.

## IDs Estables

Cada entidad tiene un ID de cadena estable, preferiblemente UUIDv7. Los IDs
nunca son índices de matriz. Donde se necesita una papelera, las filas se
eliminan lógicamente con `deleted_at` en lugar de eliminarse.

## Información General del Esquema

Las tablas principales cubren la biblioteca y el estado del runtime:
personajes, personas, chats, ramas, mensajes y variantes de mensaje,
etiquetas, lorebooks y entradas de lore, presets, configuraciones y secretos
de proveedores, el registro de plugins con ajustes y concesiones de
capacidades, el registro de temas, las auditorías de contexto de prompt, los
trabajos y artefactos de importación y los metadatos de caché.

Dos patrones importan para los autores de plugins:

- `plugin_state` guarda el estado propiedad del plugin por separado del
  registro de instalación, con un `schema_version` para el formato de datos
  y un `revision` para comparar-y-cambiar.
- `provider_secrets` guarda las claves de API como valores de solo
  escritura: solo una vista previa enmascarada sale alguna vez del
  repositorio.

## Búsqueda FTS5

Las tablas virtuales `characters_fts`, `chats_fts` y `messages_fts` impulsan
la búsqueda, construidas con `unicode61` y `remove_diacritics`. Los
disparadores (triggers) en `INSERT`/`UPDATE`/`DELETE` las mantienen
sincronizadas transaccionalmente. La búsqueda admite términos de prefijo
(`token*`), filtros de etiqueta y clasificación de relevancia bm25. Una
reconstrucción completa está disponible en `POST /api/v2/search/rebuild`.

## Migraciones

Cada cambio de esquema se publica como una migración:

- Las migraciones son **versionadas e idempotentes** — `IF NOT EXISTS` más
  una versión estricta hacen seguro volver a ejecutarlas.
- Las migraciones se ejecutan **transaccionalmente**; una migración fallida
  revierte por completo.
- No hay una migración automática `down`. La reversión significa restaurar
  el respaldo previo a la migración, que el ejecutor crea automáticamente
  para las bases de datos pobladas antes de las migraciones peligrosas.
- Leer datos nunca dispara cambios destructivos ocultos.

Consulta [Respaldos](backups) para saber cómo funcionan los respaldos de
seguridad del ejecutor de migraciones.

## Aislamiento de Plugins

Los plugins nunca reciben una conexión SQLite directa. Toda la persistencia
pasa por las APIs de almacenamiento del Plugin SDK, que son dueñas de las
tablas `plugin_storage` y `plugin_state` en nombre del plugin. Esto mantiene
los datos de los plugins versionados, revocables y a salvo de accidentes de
SQL sin procesar. Consulta el [Plugin SDK](../plugin-sdk/) para la API de
almacenamiento.

## Qué Nunca Va a la Base de Datos

- Las imágenes y el audio se guardan en el disco, nunca como BLOBs en la
  base de datos principal. Consulta [Archivos e imágenes](files-and-images).
- Los campos desconocidos de las fichas de personaje y los metadatos de
  extensiones se conservan en la columna `ext` y sobreviven a la exportación
  e importación.
