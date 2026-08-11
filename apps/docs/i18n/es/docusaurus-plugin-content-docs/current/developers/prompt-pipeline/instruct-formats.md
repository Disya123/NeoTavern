---
title: Formatos de instrucciones
description: >-
  Cómo renderizan los formatos de instrucciones la matriz de mensajes limpia
  con plantillas de Handlebars en sandbox, los formatos integrados y los
  presets JSON versionados.
sidebar_position: 3
---

Los formatos de instrucciones definen cómo se renderiza la matriz de
mensajes limpia en una cadena de prompt, usando plantillas de Handlebars en
sandbox que no tienen acceso al sistema de archivos ni a la ejecución de
código.

## El Gestor de Formatos

Un gestor de formatos integrado es dueño de los formatos de instrucciones.
Los formatos son plantillas de Handlebars renderizadas en un entorno aislado:
las plantillas reciben solo `content`, `role` y `name`, y solo los helpers
documentados están disponibles. Las plantillas no tienen acceso a Node.js,
ni al sistema de archivos, ni forma de ejecutar código arbitrario.

Un formato describe:

- plantillas de sistema, usuario, asistente y herramienta;
- tokens BOS y EOS;
- separadores de mensajes;
- tokens especiales.

## Formatos Integrados

NeoTavern incluye estos formatos:

- **ChatML** — bloques de rol `<|im_start|>` / `<|im_end|>`.
- **Llama 3** — `<|begin_of_text|>` con etiquetas de rol.
- **Alpaca** — bloques de instrucción y respuesta.
- **Mistral** — bloques `[INST]` / `[/INST]`.
- **Command-R** — bloques `<|START_OF_TURN_TOKEN|>`.
- **Formatos personalizados** — plantillas definidas por el usuario,
  seleccionables como formato activo.

## Matriz de Mensajes Limpia Hasta el Renderizado

Hasta la etapa de renderizado, el pipeline trabaja exclusivamente con una
matriz estructurada de mensajes con roles (`system`, `user`, `assistant`,
`tool`). Los macros se resuelven, el lorebook y la memoria se insertan, el
ajuste de contexto elimina el exceso y los interceptores de plugins
modifican esta matriz. El renderizado ocurre exactamente una vez, en la
etapa de renderizado, por lo que ningún adaptador vuelve a formatear el
prompt una segunda vez.

## Salida Final

La etapa de renderizado produce una de dos formas:

- **Una cadena** — el prompt renderizado, enviado a los proveedores de
  finalización de texto y usado para el diagnóstico.
- **JSON estructurado** — la matriz `GenerationMessage[]`, enviada a los
  proveedores de chat que aceptan mensajes con etiquetas de rol.

El modo se selecciona con `serializeAsText`: los adaptadores de texto
(`text-completion`, `novelai`, `ai-horde`, `koboldai`) siempre reciben el
prompt de instrucciones renderizado como un único mensaje `user`; los
adaptadores de chat (`openai-compatible`, `anthropic`) reciben la matriz
estructurada.

## Macros

`{{user}}`, `{{char}}` y las variables personalizadas se resuelven antes del
renderizado final. Los macros nunca se expanden dentro del propio motor de
plantillas, por lo que los archivos de plantilla siguen siendo markup puro.

## Formatos Personalizados y Presets

El formato personalizado activo se guarda en `AppSettings.instructFormat`.
Cuando está definido, la matriz de mensajes limpia se renderiza en una sola
cadena y las cadenas de detención del formato se convierten en las
secuencias de detención de la solicitud. Cuando es `null`, se usa la
serialización estructurada nativa.

Los formatos se importan y exportan como **presets JSON versionados**:

- `importInstructFormat()` valida el preset antes de que se active;
- `exportInstructFormat()` produce valores separados compatibles con JSON;
- los presets llevan una versión, por lo que las exportaciones antiguas
  pueden migrarse al importar.

## Ver También

- [Etapas del pipeline](stages) para saber dónde se ubica el renderizado en
  el orden de etapas.
- [Tokenización](tokenization) para saber cómo se cuenta el contexto
  renderizado.
- [Proveedores](../providers/) para saber cómo consumen los adaptadores la
  salida serializada.
