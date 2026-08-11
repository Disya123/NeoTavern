---
title: Lorebooks
description: Qué son los lorebooks, cómo se activan sus entradas y cómo vincularlos a personajes.
sidebar_position: 5
---

Esta página explica los lorebooks: colecciones de conocimiento del mundo que
NeoTavern inyecta en el prompt exactamente cuando se vuelven relevantes.

## Qué Es un Lorebook

Un lorebook es un conjunto de entradas sobre un mundo, un entorno o un
personaje: lugares, facciones, historia, gente, reglas de la magia —
cualquier cosa que el modelo debería saber pero que desperdiciaría tokens si
se incluyera en cada mensaje. En lugar de cargar todo el libro en el prompt,
la app activa solo las entradas cuyas palabras clave coinciden con la
conversación actual.

Un libro tiene un ámbito **global** (disponible en todos los chats) o está
vinculado a un **personaje** (se usa solo en las conversaciones de ese
personaje). Puedes vincular y desvincular libros por personaje desde la
sección Lore del editor de personajes.

## Entradas

Cada entrada tiene:

- **Claves principales** — una o más palabras clave de activación. Se
  requiere al menos una clave principal.
- **Claves secundarias** — palabras clave opcionales adicionales.
- **Contenido** — el texto que se inyecta en el prompt cuando la entrada se
  activa.
- **Posición** — dónde se inserta la entrada en relación con otras.
- **Conmutadores** — `enabled` (participa en la activación), `constant`
  (siempre incluida) y `selective` (se inserta solo en la posición
  configurada).

La coincidencia es una búsqueda de subcadena que no distingue mayúsculas
contra el contexto de la conversación. Cuando una entrada se activa, su
contenido se inserta en el prompt en la posición de la entrada, y el diálogo
de la entrada muestra una estimación de su tamaño en tokens para que puedas
mantener el presupuesto predecible.

## Orden de Inserción

El pipeline ensambla los bloques del prompt en un orden fijo: prompt
principal, lorebook antes del personaje, persona, personaje, lorebook
después del personaje, ejemplos de diálogo, memoria, historial de chat,
instrucciones posteriores al historial y la entrada del usuario actual. Las
entradas del lorebook se clasifican por relevancia junto con los bloques de
memoria, y las entradas constantes siempre están presentes. El orden efectivo
de las entradas activadas sigue su posición dentro del libro, por lo que un
libro bien estructurado produce un prompt estable.

## Gestionar Libros

El panel de Lorebooks en la barra de navegación tiene tres pestañas: la
lista de libros, el editor de libros y la lista de entradas. La lista
muestra el nombre de cada libro, su descripción, el conteo de cargas y una
insignia de ámbito (Global o Personaje), con filtros para libros globales,
los libros de un personaje específico o todos los libros. Los libros se
eliminan a un estado de papelera y pueden restaurarse, y la búsqueda de
libros está estabilizada (debounced) para bibliotecas grandes.

Los libros nuevos creados desde el editor de personajes se vinculan
inmediatamente a ese personaje. Consulta [Personajes](characters) para el
editor, y [Memoria y recuperación](memory) para saber cómo interactúan los
bloques de memoria con las entradas del lorebook.
