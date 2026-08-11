---
title: Adaptadores incluidos
description: Los adaptadores de proveedor que incluye NeoTavern y a qué apunta cada uno.
sidebar_position: 3
---

NeoTavern incluye un conjunto de adaptadores de proveedor listos para usar.
Viven en `packages/provider-sdk/src/adapters/`, un archivo por adaptador, y
se registran en el `ProviderRegistry` del núcleo por su tipo de proveedor.

## Compatible con OpenAI

Archivo: `openaiCompatible.ts` — tipo `openai-compatible`.

Apunta a cualquier servidor que exponga la API de OpenAI
`/v1/chat/completions` y `/v1/models`: OpenAI en sí, OpenRouter, LM Studio,
servidor llama.cpp, Ollama con el endpoint `/v1`, vLLM y similares. Usa solo
el `fetch` global y el analizador SSE del SDK; la clave de API se envía pero
nunca se registra.

## Anthropic

Archivo: `anthropic.ts` — tipo `anthropic`.

Apunta a la API nativa de Messages de Anthropic. Esta es la única excepción
documentada a la regla de no usar SDK de proveedores: usa
`@anthropic-ai/sdk` porque la API — pensamiento extendido y soporte de
encabezados beta — se maneja con más precisión con el SDK oficial. Soporta
el caché de prompts y el pensamiento adaptativo, y declara la capacidad de
cable `assistantPrefill`.

## Finalización de Texto

Archivo: `textCompletion.ts` — tipo `text-completion`.

Apunta a backends locales o autoalojados que exponen el endpoint heredado
`/v1/completions` de OpenAI: text-generation-webui ("ooba"), koboldcpp,
vLLM, Ollama, servidor llama.cpp y similares. A diferencia de los
adaptadores de chat, consume un prompt serializado: el pipeline de prompt
renderiza el formato de instrucciones y le entrega al adaptador un único
mensaje de usuario cuyo contenido es el prompt terminado, y el adaptador lo
publica en `/completions`. La clave de API es opcional para servidores
locales y nunca se registra.

## NovelAI

Archivo: `novelai.ts` — tipo `novelai`.

Apunta a la API de generación de texto de NovelAI
(`POST {baseUrl}/ai/generate` con una clave Bearer). La generación no es en
streaming — un único `delta` más el evento terminal `done`, que coincide con
el contrato de flujo unificado. El descubrimiento de modelos no lo ofrece la
API, por lo que `listModels` devuelve el modelo configurado. El adaptador
está marcado como experimental porque la superficie de parámetros de
NovelAI evoluciona; solo se mapean los samplers bien establecidos.

## KoboldAI

Archivo: `koboldai.ts` — tipo `koboldai`.

Apunta a la API nativa del servidor KoboldAI/Kobold
(`POST {baseUrl}/api/v1/generate`). La generación no es en streaming; el
modelo cargado se lee de `/api/v1/model` para el descubrimiento. Las
instalaciones locales típicas no necesitan clave de API.

## AI Horde

Archivo: `aiHorde.ts` — tipo `ai-horde`.

Apunta a AI Horde (`stablehorde.net`), un clúster asíncrono de crowdsourcing.
Un trabajo se envía con `/api/v2/generate/text/async` y luego se sondea a
través del endpoint de estado hasta que termina; el bucle de sondeo vuelve a
verificar la señal del llamador y un plazo de inactividad, por lo que un
trabajo atascado aborta en lugar de sondear para siempre. El uso anónimo
está permitido con menor prioridad; una clave de API se envía como
encabezado `apikey` cuando está configurada.

## Echo

Archivo: `echo.ts` — tipo `echo`.

Un proveedor totalmente sin conexión usado para pruebas, demostraciones y
verificación del pipeline de streaming sin red ni clave de API. Transmite el
último mensaje del usuario de vuelta palabra por palabra. También implementa
los métodos opcionales de voz, imagen y transcripción, lo que lo convierte
en una referencia útil para escribir un adaptador que cubra todas las
modalidades.

## Helper de Prompt

Archivo: `prompt.ts` — exporta `promptFromMessages`, un helper compartido
que serializa matrices de mensajes en las formas de prompt que envían los
adaptadores. No es un adaptador en sí.

Para la interfaz exacta `ProviderAdapter` que todos estos implementan,
consulta [Contrato de adaptador](adapter-contract.md) y la
[referencia del Provider SDK](../../api/provider-sdk/) generada.
