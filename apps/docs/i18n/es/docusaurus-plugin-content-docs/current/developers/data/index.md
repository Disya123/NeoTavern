---
title: Datos y almacenamiento
description: >-
  Información general de la capa de datos: la base de datos SQLite, la
  estructura del sistema de archivos para originales y caché, y el modelo de
  respaldo.
sidebar_position: 1
---

Esta sección explica cómo guarda NeoTavern los datos: la base de datos
SQLite, la estructura del sistema de archivos para originales y caché, y el
modelo de respaldo.

## Directorio de Datos

Todos los datos de usuario viven en un único directorio de datos local:

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## Páginas de Esta Sección

- [Almacenamiento SQLite](data/sqlite) — pragmas, tablas STRICT, búsqueda FTS5,
  IDs UUIDv7 estables y migraciones.
- [Archivos e imágenes](data/files-and-images) — cómo se guardan los originales y
  las miniaturas regenerables, y cómo se escriben atómicamente.
- [Respaldos](data/backups) — el modelo de respaldo, la restauración y qué cubren
  los respaldos.

## Secciones Relacionadas

- La sección [Arquitectura](architecture/) explica dónde se ubica la capa
  de datos en el monorepo.
- Para la vista orientada al usuario, consulta Datos y respaldos en la
  [Guía de usuario](../user-guide/data-and-backups).
