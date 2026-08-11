---
title: Respaldos
description: >-
  El modelo de respaldo: instantáneas SQLite en línea, restauración segura
  con un respaldo de seguridad y qué cubren los respaldos.
sidebar_position: 4
---

Los respaldos son instantáneas SQLite en línea creadas a través de la API de
Respaldo de SQLite, seguras de ejecutar con WAL y restaurables sin
herramientas externas.

## Modelo de Respaldo

Un respaldo es una instantánea consistente de la base de datos SQLite,
creada mientras el servidor está en ejecución:

- `POST /api/v2/backups` crea la instantánea a través de la API de Respaldo
  de SQLite, que es segura con WAL y no bloquea a los lectores.
- `GET /api/v2/backups` lista los respaldos existentes; los contenidos de la
  caché y los registros no se incluyen.

Cada registro de respaldo muestra su fecha, tamaño, versión de esquema,
fuente y estado. La interfaz muestra la misma información, y crear un
respaldo nunca interrumpe la lectura de los datos locales.

## Qué Cubren los Respaldos

Un respaldo cubre toda la base de datos estructurada: personajes, personas,
chats y mensajes, lorebooks, presets, configuraciones de proveedores, estado
de plugins y ajustes. No incluye:

- `cache/thumbnails/` — regenerable y excluida por diseño;
- los registros — excluidos por diseño;
- los directorios de preparación de importación — temporales por diseño.

Los originales de `files/` están direccionados por contenido y el
mantenimiento de caché nunca los toca, por lo que no forman parte de la
instantánea en sí.

## Restauración

`POST /api/v2/backups/:id/restore` sigue una secuencia segura:

1. Crea y rota un **respaldo de seguridad** del estado actual.
2. Valida la instantánea seleccionada con `PRAGMA quick_check`.
3. La copia en la base de datos en vivo a través de la API de Respaldo en
   Línea de SQLite.

La conexión y los repositorios permanecen abiertos: la respuesta lleva
`restartRequired: false`, y las lecturas y escrituras posteriores siguen
funcionando sin reiniciar. La restauración nunca requiere herramientas
SQLite externas. Una instantánea o copia fallida devuelve `RESTORE_FAILED`,
y el respaldo de seguridad se conserva, por lo que el estado actual nunca se
pierde en una restauración fallida.

En la interfaz, la restauración requiere confirmación explícita, nunca se
informa como exitosa antes de que pase la verificación de integridad, y
ofrece el retorno automático a la copia de seguridad si algo sale mal.
Eliminar un respaldo te avisa si es la última copia funcional.

## Respaldos como Red de Seguridad

Las mismas mecánicas de instantánea protegen las operaciones peligrosas:

- El ejecutor de migraciones crea un respaldo previo a la migración para las
  bases de datos pobladas antes de las migraciones que reconstruyen o
  remodelan tablas.
- La ejecución de importaciones crea un respaldo de seguridad antes de
  escribir cualquier dato seleccionado, por lo que una importación fallida o
  interrumpida siempre puede revertirse.
- La restauración siempre captura primero el estado actual, como se describió
  anteriormente.

## Ver También

- [Almacenamiento SQLite](sqlite) para la base de datos en sí.
- [Archivos e imágenes](files-and-images) para lo que vive fuera de la base
  de datos.
- El flujo orientado al usuario se documenta en la
  [Guía de usuario](../../user-guide/data-and-backups).
