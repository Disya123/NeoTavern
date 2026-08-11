---
title: Grupos
description: Cómo maneja NeoTavern las conversaciones con varios personajes y los chats de grupo.
sidebar_position: 4
---

Esta página explica qué son los grupos y cómo maneja NeoTavern las
conversaciones con varios personajes hoy.

## Qué Es un Grupo

Un grupo es una conversación única en la que participan varios personajes.
Mientras que un chat normal tiene un personaje más tu persona, un chat de
grupo alterna entre personajes para que cada respuesta pueda venir de un
participante distinto.

## Grupos en NeoTavern Hoy

El modelo de chat principal de NeoTavern es un personaje por conversación,
con tu persona superpuesta. Una función dedicada de chat de grupo que te
permita crear una conversación y cambiar sus miembros en la app está
**planificada**; no está disponible en la versión actual, por lo que esta
página describe lo que funciona hoy.

## Chats de Grupo Importados

Cuando migras un respaldo de SillyTavern mediante Configuración → Datos,
los chats de grupo se manejan de forma segura:

- Las definiciones de grupo y sus transcripciones se importan como chats
  normales, llevando el registro de grupo original en los metadatos del
  chat.
- La transcripción conserva el nombre de cada participante, el mensaje y las
  variantes de swipe, por lo que el historial con varios personajes sigue
  siendo legible y puedes continuar la conversación.
- Las categorías no compatibles se enumeran explícitamente en el informe de
  importación en lugar de descartarse en silencio.

## Trabajar con Varios Personajes Ahora

Mientras los grupos nativos están planificados, estas funciones cubren los
flujos comunes con varios personajes:

- **Chats separados por personaje.** Cada personaje conserva su propio
  historial de chat, y el panel de Chats limita la lista al personaje
  actual.
- **Un mundo compartido mediante lorebooks.** Vincula un lorebook a varios
  personajes para que el conocimiento consistente del mundo llegue a cada
  conversación. Consulta [Lorebooks](lorebook).
- **Ramas de historia.** Usa checkpoints y ramas para explorar caminos
  divergentes con cualquier personaje sin perder la conversación principal.
  Consulta [Chat](chat).
- **Personas.** Cambia tu propia persona por chat para modificar cómo te
  presentas en cada conversación.

Si necesitas una conversación verdaderamente con varios personajes, ten en
cuenta el enfoque de chat de grupo importado: conserva tu historial de grupo
existente, y la función nativa planificada se basará en los mismos datos.
