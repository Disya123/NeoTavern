---
title: Chat
description: 'Cómo funciona el chat en NeoTavern: streaming, swipes, regenerar, editar y detener.'
sidebar_position: 2
---

Esta página cubre la vista de chat: redactar y enviar mensajes, ver cómo se
transmiten las respuestas y trabajar con las acciones de mensaje que
proporciona NeoTavern.

## Enviar Mensajes

El redactor se encuentra en la parte inferior del lienzo de chat. Escribe un
mensaje y pulsa `Enter` para enviarlo; pulsa `Shift+Enter` para una línea
nueva. Tu mensaje aparece al instante y la respuesta se transmite a la vista
en lotes de como máximo 30 actualizaciones de interfaz por segundo. Puedes
desplazarte por el historial mientras se transmite una respuesta — el
desplazamiento automático solo te sigue mientras permaneces al final, y
aparece una acción de "mensaje nuevo" después de que te desplazas hacia
arriba manualmente.

Mientras se genera una respuesta, el botón principal del redactor se
convierte en **Detener**. Detener conserva el texto recibido hasta ese
momento como una respuesta incompleta marcada explícitamente. Una conexión
caída ofrece reconectar y nunca crea un mensaje duplicado.

Tu borrador se guarda por chat, por lo que cambiar de vista y volver nunca
pierde lo que estabas escribiendo.

## Swipes (Mensajes Alternativos)

Cada mensaje de asistente puede contener varias respuestas alternativas,
llamadas swipes. Un paginador debajo del mensaje muestra el conteo como
`N/M` con flechas de anterior y siguiente; al hacer clic en las flechas se
recorren las variantes sin perder ninguna. El historial de swipes se
conserva y no es destructivo.

## Regenerar

La acción de regenerar reescribe el mensaje de asistente **más reciente**
en su lugar: una respuesta nueva se transmite a la burbuja existente y el
texto anterior se convierte en otra variante del paginador de swipes. Si la
generación falla o se detiene, el texto anterior permanece intacto en el
disco.

## Editar Mensajes

Abre la acción de edición de un mensaje para cambiar su texto. El editor
integrado guarda con `Ctrl+Enter` (o `Cmd+Enter` en macOS) y cancela con
`Escape`. Las ediciones no son destructivas: el contenido anterior se
archiva en el historial de ediciones del mensaje, desde donde puedes
restaurarlo en cualquier momento. Si el mensaje cambió en otro lugar mientras
editabas, el editor conserva tu borrador y muestra un aviso de conflicto en
lugar de sobrescribir en silencio.

## Acciones de Mensaje

La barra de acciones de cada mensaje siempre está visible, no solo al pasar
el cursor:

- Copiar el texto sin formato del mensaje.
- Editar el mensaje.
- Regenerar la última respuesta de asistente.
- Recorrer las variantes con swipes.
- Crear un **checkpoint** o una **rama**: una instantánea del chat
  congelada en ese mensaje, copiada en un chat secundario. Usa los
  checkpoints para explorar tramas sin tocar la conversación principal.
- Eliminar el mensaje. La eliminación mueve los chats a un estado de
  papelera en lugar de destruirlos al instante.

Los plugins pueden agregar sus propias acciones a la misma barra, sujetas a
los permisos que les hayas concedido. Consulta [Extensiones](extensions).

## Control con el Teclado

Todo el flujo de chat funciona desde el teclado: `Tab` y `Shift+Tab` mueven
el foco, `Escape` cierra el panel o diálogo superior, y el paginador de
swipes, los enlaces de checkpoint y las acciones de mensaje son todos
controles enfocables. Consulta [Atajos de teclado](keyboard-shortcuts) para
la lista completa.
