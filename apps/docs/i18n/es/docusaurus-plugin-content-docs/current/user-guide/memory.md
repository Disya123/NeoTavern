---
title: Memoria y recuperación
description: >-
  Memoria de conversación, entradas de memoria, recuperación vectorial y RAG
  en NeoTavern.
sidebar_position: 6
---

Esta página explica las funciones de memoria que ayudan al modelo a recordar
a lo largo de conversaciones largas: la memoria de conversación continua,
las entradas de memoria activadas por palabras clave y la recuperación
vectorial.

## Memoria de Conversación

Cada chat conserva un resumen continuo que el pipeline mantiene a medida que
la conversación crece. Cuando la estrategia de ajuste de contexto
`summarize` está activa, el historial excluido más antiguo se condensa en un
resumen extractivo local que se inserta antes de la entrada del usuario
actual — así el modelo conserva la esencia de los primeros eventos incluso
después de que los mensajes sin procesar salen del presupuesto de tokens. El
resumen se guarda con el chat y sobrevive a las recargas.

Puedes ver exactamente lo que contiene el prompt actual antes de enviar: una
vista previa del contexto en vivo muestra el tokenizador seleccionado, el
límite de contexto y el espacio reservado para la respuesta, los bloques
excluidos, los bloques resumidos y la estrategia aplicada. Consulta
[Ajustes](settings) para el selector de estrategia.

## Entradas de Memoria

Las entradas de memoria son fragmentos de conocimiento de larga duración que
persisten entre chats, independientes de cualquier conversación individual.
Cada entrada tiene:

- **Ámbito** — `global` o vinculado a un personaje.
- **Palabras clave de activación** — una coincidencia de subcadena que no
  distingue mayúsculas contra el contexto de la conversación.
- **Contenido** — el texto que se inyecta cuando la entrada se activa.

Este es el patrón clásico de RAG: la recuperación se dispara por la
coincidencia de palabras clave, y los fragmentos inyectados responden a la
necesidad del modelo de hechos estables — detalles del personaje, reglas del
mundo o puntos de la trama en curso — sin inflar cada prompt. Al igual que
las entradas del lorebook, los bloques de memoria se clasifican por
relevancia en el pipeline de prompt y cuentan para el presupuesto de tokens.

## Recuperación Vectorial

La recuperación vectorial es la estrategia de ajuste de contexto
`vector-recall`. En lugar de recortar el contexto puramente por antigüedad,
clasifica los bloques de lorebook y memoria por relevancia semántica con la
entrada actual y descarta primero los menos relevantes, y luego recorta el
historial más antiguo. El resultado: el modelo conserva el material que
importa para el mensaje actual incluso cuando no es el más reciente.

La estrategia se selecciona en los ajustes de generación, y los plugins
pueden agregar más estrategias a través del SDK. Toda estrategia respeta el
presupuesto de tokens final controlado por el host: los plugins no pueden
omitirlo.

## Elegir una Estrategia

Las estrategias disponibles son `truncate` (descartar los grupos no
protegidos más antiguos), `summarize` (condensar el historial excluido),
`vector-recall` (conservar los bloques de alta relevancia, recortando por
relevancia y antigüedad) y `manual` (excluir mensajes específicos del prompt
sin borrarlos del historial). El modo manual expone una acción en cada
mensaje para excluirlo o restaurarlo, y los pares de llamada a herramienta y
resultado de herramienta siempre se manejan juntos. Consulta [Chat](chat)
para los controles a nivel de mensaje y [Lorebooks](lorebook) para el modelo
relacionado de activación por palabras clave.
