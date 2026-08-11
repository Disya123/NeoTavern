---
title: Archivos e imágenes
description: >-
  Cómo se guardan los archivos de usuario en el disco: originales separados
  de la caché, el pipeline de importación de imágenes, las miniaturas y las
  escrituras atómicas.
sidebar_position: 3
---

Los archivos de usuario se guardan en el disco, nunca como BLOBs: los
originales viven en `data/files/`, las miniaturas regenerables en
`data/cache/thumbnails/`, y cada escritura es atómica.

## Originales vs. Caché

La división es estricta:

- **Originales** — `data/files/{avatars,backgrounds,attachments,audio,generated}/`.
  Los originales nunca se modifican y el mantenimiento de caché nunca los
  elimina.
- **Caché** — `data/cache/thumbnails/`. Las miniaturas son regenerables y
  están direccionadas por contenido.

Limpiar la caché nunca elimina originales. Una miniatura faltante se
regenera automáticamente a partir del original.

## El Pipeline de Importación de Imágenes

Importar una imagen sigue un pipeline fijo:

1. Valida el tamaño, el tipo MIME y la extensión.
2. Calcula un hash de contenido (SHA-256).
3. Guarda el original sin pérdida, direccionado por contenido
   (`{sha256}{ext}`), lo que deduplica por contenido.
4. Genera miniaturas de baja resolución para galerías, listas y vistas
   previas.
5. Guarda las miniaturas en `data/cache/thumbnails/`.
6. Clave cada miniatura por el hash del original, el tamaño objetivo y la
   versión del algoritmo: `{hash}-{size}-v{algorithmVersion}`.
7. No regenera una miniatura cuya clave no cambió.
8. Nunca carga el original cuando una miniatura es suficiente.
9. Reconstruye la caché automáticamente cuando falta una miniatura.
10. La limpieza de caché nunca toca los originales.

## Escrituras Atómicas

Cada escritura de archivo pasa por un archivo temporal seguido de un
renombrado. Un bloqueo a mitad de camino nunca deja un archivo
parcialmente escrito. Esto se aplica por igual a originales, miniaturas y
archivos de tokenizador descargados.

## Galería de Personajes

Las imágenes de la galería reutilizan la tabla `attachments` con
`owner_type = character.gallery`. Las filas de metadatos contienen las URL
del original y de su miniatura; los bytes permanecen en `files/avatars/`
direccionados por contenido. Quitar una imagen de la galería elimina el
registro de attachment, no el archivo original — la acción sigue siendo
reversible y se conserva la deduplicación.

## Fondos de Chat

`files/backgrounds/` es la fuente de verdad: la lista se construye
escaneando el directorio, por lo que los fondos importados de SillyTavern
aparecen sin ningún paso de transferencia. Los archivos subidos se guardan
direccionados por contenido y nunca se modifican.

Las miniaturas de fondo viven en `cache/thumbnails/`, con clave basada en el
SHA-256 del nombre del archivo en lugar del contenido, lo que permite que
los archivos importados de SillyTavern con nombres arbitrarios también
tengan miniaturas y mantiene la subida, la lista y la eliminación en una
sola clave. Un archivo que no puede decodificarse o supera los 64 MiB se
lista sin miniatura; el original permanece disponible. Eliminar un fondo
quita tanto el original como su miniatura en caché.

## Importaciones de Fichas de Personaje

`POST /api/v2/characters/import` acepta JSON de Character Card V1/V2 y PNG
con metadatos `chara`. La entrada está limitada a 25 MiB y se detecta por
contenido. El SHA-256 de todo el archivo fuente se guarda en
`ext._st2.importHash`, y reimportar el mismo archivo devuelve el registro
existente. Los PNG se validan con un decodificador de imágenes. El original
se escribe atómicamente en `files/avatars/` y se genera una miniatura WebP;
una miniatura faltante se reconstruye desde el original en la siguiente
lectura.

## Mantenimiento de Caché

La pantalla de diagnóstico llama a `DELETE /api/v2/diagnostics/cache`, que
elimina solo los archivos de `cache/thumbnails/` y sus filas de
`cache_metadata`. La raíz `cache/` se conserva, por lo que los directorios
activos de preparación de migración nunca se interrumpen. El resultado
informa del número y el tamaño de los archivos eliminados; volver a
ejecutarlo es seguro y devuelve ceros.
