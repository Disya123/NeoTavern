---
title: Tokenización
description: >-
  Conteo local de tokens a través del registro de tokenizadores: compatible
  con tiktoken, SentencePiece, Hugging Face JSON, plugins específicos de
  modelo y el respaldo aproximado.
sidebar_position: 4
---

El conteo de tokens se ejecuta localmente a través de un registro de
tokenizadores que admite tokenizadores compatibles con tiktoken,
SentencePiece, Hugging Face JSON y plugins específicos de modelo, con un
respaldo aproximado explícito.

## Conteo Local

El conteo de tokens nunca sale de la máquina. El registro selecciona un
perfil de tokenizador para el modelo activo, y el pipeline cuenta el
contexto ensamblado en proceso antes de cualquier solicitud de red.

## El Registro de Tokenizadores

El registro acepta cuatro tipos de tokenizadores:

- **Compatible con tiktoken** — tokenizadores BPE compatibles con el
  tiktoken de OpenAI, para las familias de modelos de OpenAI.
- **SentencePiece** — modelos que incluyen vocabularios de SentencePiece.
- **JSON de tokenizador de Hugging Face** — archivos `tokenizer.json` de
  repositorios de Hugging Face, convertidos a un formato de rangos compacto.
- **Plugins específicos de modelo** — los plugins de proveedor pueden
  registrar un perfil de tokenizador preciso para un modelo.

Existe un **respaldo aproximado** para los modelos sin tokenizador
registrado, y siempre se etiqueta explícitamente, por lo que la interfaz
nunca presenta una estimación como un conteo exacto.

## Perfiles Integrados

El núcleo registra perfiles sin conexión para las familias comunes:

- `openai:o200k_base` — familias GPT-4o, GPT-4.1, GPT-5, o1, o3 y o4.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo y text-embedding-3.
- `deepseek:bytelevel-bpe-v1` — familias DeepSeek. El conteo se ejecuta a
  través de un motor compacto de solo conteo (un port de fusión BPE sin
  vocabulario ni decodificador) sobre los rangos del `tokenizer.json`
  oficial. El archivo se convierte una vez en un pequeño archivo de rangos
  guardado en caché en `data/cache/tokenizers/deepseek-v4-flash/` mediante
  escrituras atómicas de temporal más renombrado; el JSON completo y la
  biblioteca de tokenizador de runtime no se almacenan ni se cargan.

Si la red no está disponible, el perfil de DeepSeek cae honestamente al
perfil aproximado y reintenta como máximo una vez cada 15 minutos — un
tokenizador faltante nunca bloquea la generación.

## Respaldo Aproximado

Los modelos locales desconocidos usan `approximate-character-v1`, una
heurística consciente de la escritura: aproximadamente 4.6 caracteres por
token para latín, 4.0 para cirílico, 1.7 para CJK y 2.0 para dígitos. La
aproximación se marca en todos los lugares donde aparece, y un plugin de
proveedor puede reemplazarla en cualquier momento registrando un perfil
preciso.

## Perfiles de Plugins

Los plugins registran perfiles de tokenizador con una prioridad. Un perfil
de plugin con prioridad superior a `-10` anula el perfil de familia para los
modelos que cubre. El perfil seleccionado se pasa al pipeline como
`countTokens`, `tokenizerProfile` y `tokenizerApproximate`.

## El Resultado del Presupuesto de Tokens

Después del conteo, el pipeline expone `PipelineResult.tokenBudget`, que
contiene:

- el perfil de tokenizador usado;
- el indicador `approximate`;
- el límite de contexto del modelo;
- el espacio reservado para la respuesta;
- el conteo final de tokens del prompt.

Consulta [Ajuste de contexto](context-shifting) para saber cómo se aplica el
presupuesto.
