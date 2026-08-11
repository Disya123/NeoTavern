---
title: Actualización
description: >-
  Cómo funcionan las actualizaciones de NeoTavern y por qué tus datos
  permanecen a salvo durante una actualización.
sidebar_position: 4
---

Esta página explica cómo se entregan las actualizaciones de NeoTavern, qué
ocurre con tus datos durante una actualización y dónde leer qué cambió.

## Cómo Funcionan las Actualizaciones

NeoTavern trata la app principal, los plugins y los temas como unidades
separadas, y cada una se actualiza de forma independiente:

- Las **actualizaciones del núcleo** reemplazan la aplicación en sí y dejan
  intacto tu directorio de datos.
- Las **actualizaciones de plugins y temas** se realizan a través de sus
  respectivos gestores en la app y nunca se activan automáticamente sin tu
  revisión.
- Cada instalación es atómica: la versión nueva reemplaza a la anterior en
  un solo paso, y la versión previa se conserva para que una actualización
  fallida pueda revertirse.
- La integridad del paquete se verifica con una suma de verificación, y el
  catálogo oficial puede agregar firmas además de eso.

Nunca necesitas Git, npm ni una terminal para actualizar. Si instalaste la
app normalmente, la actualizas de la misma manera en que la instalaste.

## Seguridad de los Datos Durante las Actualizaciones

- Las actualizaciones nunca modifican tus archivos de usuario directamente:
  el instalador no toca personajes, chats, lorebooks, personas ni ajustes.
- Cuando una actualización incluye una migración de esquema de base de
  datos, se crea un respaldo antes de ejecutar la migración, y las
  migraciones son transaccionales e idempotentes.
- Tu base de datos SQLite se ejecuta en modo WAL, por lo que la app sigue
  siendo usable y tus escrituras permanecen durables durante una migración o
  actualización.
- Si falla una actualización de plugin o tema, la app mantiene funcionando
  la versión anterior en lugar de dejar un paquete a medio instalar.

## Revisar Qué Cambió

El [registro de cambios](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md)
enumera cada cambio con su impacto. Antes de actualizar, repasa las entradas
más recientes: los cambios incompatibles vienen con una guía de migración, y
las funciones que aún son experimentales o están planificadas se marcan
explícitamente.

## Actualizar Plugins y Temas

Abre la sección Plugins y Temas. Cada elemento instalado muestra su versión,
su estado y si hay una actualización disponible. Si una actualización
solicita permisos nuevos, la app vuelve a pedir tu consentimiento explícito
antes de aplicarlos: una actualización nunca amplía los permisos en silencio.

## Revertir

Como la versión anterior se conserva durante las actualizaciones del núcleo,
puedes reinstalarla si una versión nueva se comporta mal. Tu directorio de
datos es legible hacia atrás, y un respaldo creado antes de cualquier
migración riesgosa te permite restaurar un estado conocido y bueno desde la
interfaz. Consulta [Datos y respaldos](../user-guide/data-and-backups).
