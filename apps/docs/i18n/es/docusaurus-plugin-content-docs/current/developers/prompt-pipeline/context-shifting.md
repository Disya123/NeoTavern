---
title: Ajuste de contexto
description: >-
  Cómo ajusta el pipeline el contexto ensamblado al presupuesto de tokens,
  los pasos previos a la solicitud y las estrategias truncate, summarize,
  vector-recall y manual.
sidebar_position: 5
---

El ajuste de contexto encaja la conversación ensamblada en el presupuesto de
tokens del modelo eliminando o comprimiendo el contexto menos importante y
conservando todo lo que debe permanecer.

## Pasos Previos a la Solicitud

Antes de enviar una solicitud, el pipeline sigue estos pasos:

1. Determina el perfil de tokenizador y el límite de contexto del modelo.
2. Reserva espacio para la respuesta.
3. Conserva el prompt del sistema, el personaje, las entradas de lorebook
   requeridas y los mensajes fijados.
4. Elimina o comprime primero los bloques no fijados más antiguos.
5. Elimina los mensajes de llamada a herramienta y de resultado de
   herramienta solo como par.
6. Vuelve a contar los tokens después de cada cambio.
7. Muestra al usuario qué se excluyó o resumió.

Si el contexto protegido por sí solo supera el presupuesto, la generación
termina con el error estable `TOKEN_BUDGET_EXCEEDED` en lugar de enviar una
solicitud que excede el presupuesto al proveedor.

## Cómo Funciona el Ajuste

`shiftContext(messages, countTokens, budget)` ajusta el diálogo al
presupuesto de tokens. Devuelve tres listas:

- `kept` — los mensajes que caben;
- `excluded` — los mensajes eliminados, mostrados al usuario;
- `truncated` — los bloques que se comprimieron en lugar de descartarse.

Los mensajes de sistema y los fijados siempre están protegidos. Los bloques
no fijados más antiguos se eliminan primero. Las llamadas a herramienta y
sus resultados se vinculan a través de `toolCallId`, `tool_call_id` o
`callId` y se eliminan como un solo grupo, incluso cuando no son adyacentes.

## Estrategias Integradas

La estrategia se selecciona con el ajuste `contextStrategy` y se aplica a
través del `ContextStrategyRegistry`:

- **truncate** — elimina los grupos no fijados más antiguos.
- **summarize** — construye un resumen extractivo local del historial
  excluido y lo conserva antes de la entrada del usuario actual.
- **vector-recall** — descarta los bloques de lorebook y memoria de baja
  relevancia antes que los de alta relevancia, y luego acorta el historial
  antiguo.
- **manual** — primero excluye los mensajes marcados con
  `meta.manualExcluded: true` (incluidos sus pares de llamada a herramienta
  y resultado), y luego continúa con la reducción normal si se necesita más
  espacio.

## Plugins y el Presupuesto

Los plugins pueden registrar estrategias adicionales; el registro devuelve
una función de limpieza. Una estrategia de plugin no puede omitir el
presupuesto:

- el host restaura los mensajes requeridos y rechaza una estrategia que
  eliminó contexto protegido;
- el host vuelve a contar de forma independiente el presupuesto real;
- el conteo y el ajuste se ejecutan antes de los interceptores de plugins, y
  se ejecuta un reconteo obligatorio con un ajuste final después de ellos —
  un plugin no puede agregar mensajes tarde para colarse por encima del
  límite.

## La Auditoría de Contexto

Cada generación crea un `PromptContextAudit` antes de la llamada de red y lo
finaliza con un estado terminal: `completed`, `failed` o `cancelled`. La
auditoría registra:

- el ID de generación, el proveedor y el modelo;
- cada bloque del prompt en orden real, con conteos de tokens y el motivo
  estable de inclusión o exclusión;
- el límite de contexto, la reserva de respuesta y el conteo final de tokens
  del prompt;
- el perfil de tokenizador y si es aproximado;
- los mensajes finales del proveedor y el diagnóstico de los interceptores
  de plugins;
- un código de error de proveedor normalizado, sin los cuerpos de respuesta
  del proveedor.

Solo se conserva en la base de datos la última auditoría completa por chat;
una solicitud nueva reemplaza atómicamente a la anterior, y eliminar el chat
elimina la auditoría. La interfaz la lee a través de
`GET /api/v2/chats/:id/context-audit`.

Un endpoint de vista previa en vivo, `POST /api/v2/context-preview`, ejecuta
las mismas etapas de persona, lorebook, memoria, plantilla, tokenizador y
ajuste sin crear mensajes, ramas ni auditorías.

## Ver También

- [Etapas del pipeline](stages) para saber dónde se ubica el ajuste en el
  orden de etapas.
- [Tokenización](tokenization) para saber cómo se cuentan los tokens.
- [Datos y almacenamiento](../data/) para saber dónde se guardan las
  auditorías.
