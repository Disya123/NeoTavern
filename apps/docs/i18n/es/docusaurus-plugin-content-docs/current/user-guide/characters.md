---
title: Personajes
description: >-
  La galería de personajes, las fichas de personaje e importar o exportar
  fichas en NeoTavern.
sidebar_position: 3
---

Esta página explica cómo encontrar, crear, editar y compartir personajes en
NeoTavern. Un personaje es un participante de tus chats, respaldado por una
ficha de personaje que guarda todo lo que la IA sabe sobre él.

## La Galería de Personajes

La sección Personajes es tu navegador de biblioteca. Admite una vista de
cuadrícula y una vista de lista compacta, ambas virtualizadas para
mantenerse rápidas con decenas de miles de fichas. Se usan miniaturas para
las vistas previas; las imágenes originales se cargan solo cuando abres una
ficha.

La búsqueda admite un lenguaje de consulta simple: `tag:NSFW author:Nombre
"frase exacta" -tag:beta`. Los filtros de etiqueta y autor se combinan con
los términos de búsqueda, y los resultados se clasifican por relevancia cada
vez que escribes una consulta. La ordenación incluye alfabética, más
recientes, más antiguos, favoritos, usados recientemente, más o menos chats,
más o menos contenido y aleatoria.

## Crear y Editar Personajes

Abre cualquier ficha y elige Editar. El editor está dividido en grupos
claros:

- **Identidad** — nombre, avatar y etiquetas.
- **Descripción** — quién es el personaje.
- **Primer mensaje** — el saludo, además de los saludos alternativos.
- **Escenario** — el entorno desde el que comienza el rol.
- **Ejemplos** — ejemplos de diálogo que moldean el estilo del personaje.
- **Lore** — lorebooks vinculados a este personaje.
- **Imágenes** — una galería de imágenes, una de las cuales es el avatar
  principal.
- **Avanzado** — personalidad, notas del creador, anulaciones de prompt, la
  nota del personaje con profundidad y rol, locuacidad y metadatos del
  creador.

Solo se requiere el nombre para crear un personaje. Los mensajes de
validación aparecen junto al campo y en una lista final de errores, y los
campos obligatorios se etiquetan con texto, no solo con color.

## Fichas de Personaje

Una ficha de personaje es la representación portátil de un personaje. Sus
campos incluyen nombre, descripción, personalidad, escenario, el primer
mensaje (saludo), saludos alternativos, etiquetas y avatar. Las fichas
también llevan notas del creador, y los campos desconocidos de las fichas
importadas se conservan en lugar de descartarse, por lo que no se pierde
ningún metadato cuando haces pasar una ficha por otra herramienta.

## Importar y Exportar Fichas

- **Importar** acepta fichas de personaje PNG y JSON (V1 y V2), y funciona
  desde la galería, desde un chat o durante la configuración del primer
  inicio. Importar es seguro de repetir: hacerlo dos veces nunca crea
  duplicados.
- **Exportar** escribe la ficha como PNG o JSON, exactamente como elijas,
  con una instantánea de versión del estado actual.
- Los avatares y las imágenes de la galería se suben como archivos; una
  imagen reemplazada nunca se elimina hasta que la nueva se guarda
  correctamente.

Si una ficha de tu biblioteca está dañada, NeoTavern muestra una vista
previa segura con el motivo y te permite exportar el original para que
puedas repararlo en otro lugar.
