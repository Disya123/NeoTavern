---
title: Información general de proveedores
description: >-
  Cómo se comunica NeoTavern con servicios LLM, TTS, STT e imágenes a través
  de un único contrato de adaptador.
sidebar_position: 1
---

Los proveedores son la forma en que NeoTavern se comunica con servicios de
IA externos: modelos de lenguaje, texto a voz, voz a texto y generación de
imágenes.

## Un Único Contrato de Adaptador

Cada proveedor — ya sea un endpoint de chat compatible con OpenAI, una
conexión nativa de Anthropic, un backend comunitario como NovelAI o
KoboldAI, o un servicio registrado por un plugin — implementa el mismo
contrato `ProviderAdapter` de `@neotavern/provider-sdk`. El pipeline principal
solo conoce este contrato, por lo que la aplicación no está atada a ningún
proveedor en particular.

Un adaptador debe soportar:

- Validación de configuración.
- Enumerar los modelos disponibles.
- Cancelación a través de `AbortSignal`.
- Un flujo de eventos de generación unificado.
- Errores normalizados.
- Tiempos de espera.
- Registro sin secretos.
- Registro a través del Plugin SDK.

Como el pipeline ve una sola forma independientemente del proveedor,
funciones como el streaming, el ajuste de contexto y el manejo de errores
funcionan de forma idéntica en todos los proveedores. Consulta
[Contrato de adaptador](adapter-contract.md) para los requisitos precisos.

## Adaptadores Incluidos

La distribución incluye adaptadores para endpoints compatibles con OpenAI,
Anthropic, endpoints de finalización de texto, NovelAI, KoboldAI, AI Horde
y un adaptador de eco local. Cada uno está documentado en
[Adaptadores](adapters.md).

## Estimación Local de Tokens

El conteo de tokens es local y sin conexión. Los tokenizadores exactos
(tiktoken, SentencePiece o JSON de tokenizador de Hugging Face) pueden
registrarse por modelo, incluso mediante plugins de proveedor; hasta que se
registra un tokenizador exacto, el host usa una heurística consciente de la
escritura y marca el conteo como aproximado.

## Ampliar los Proveedores

El núcleo está deliberadamente libre de dependencias de SDK de proveedores.
Los proveedores nuevos se agregan escribiendo un adaptador y registrándolo:

- Los proveedores del núcleo se registran a través del `ProviderRegistry` en
  `@neotavern/provider-sdk`.
- Los proveedores de plugins se registran a través de la API de backend del
  Plugin SDK (`api.providers.register(kind, factory)`), que requiere el
  permiso `providers.register`. El registro devuelve una función de limpieza
  y se elimina automáticamente cuando el plugin se desactiva.

Este es el camino documentado para un endpoint privado, un modelo
autoalojado o un servicio sin adaptador integrado. La
[referencia del Provider SDK](../api/provider-sdk/) generada documenta el
contrato completo.
