---
title: Etapas del pipeline
description: >-
  Las 14 etapas fijas del pipeline de prompt y las reglas que sigue todo
  hook de plugin: prioridad, tiempo de espera, cancelación, permisos y
  aislamiento.
sidebar_position: 2
---

La generación pasa por 14 etapas fijas, desde la entrada del usuario hasta
guardar el mensaje, y todo hook de plugin sigue las mismas reglas de
prioridad, tiempo de espera, cancelación, permisos y aislamiento de errores.

## El Orden de las Etapas

El orden es fijo e idéntico para cada generación:

```text
User input
→ Macros
→ Character/persona data
→ Lorebook
→ Memory/RAG
→ Token counting
→ Context shifting
→ Plugin interceptors
→ Instruct format rendering
→ Provider serialization
→ Request
→ Streaming response
→ Post-processing hooks
→ Save message
```

## Etapa por Etapa

1. **Entrada del usuario** — se capturan el mensaje borrador y las opciones
   de generación de esta solicitud.
2. **Macros** — `{{user}}`, `{{char}}` y las variables personalizadas se
   resuelven con `replaceMacros`. Los macros desconocidos se dejan tal cual.
3. **Datos del personaje/persona** — los campos de la ficha de personaje y
   la persona activa se ensamblan en la matriz de mensajes.
4. **Lorebook** — las entradas del lorebook que coinciden se insertan según
   sus reglas de activación. Las entradas marcadas como requeridas están
   protegidas contra la eliminación.
5. **Memoria/RAG** — se recuperan y clasifican los bloques de memoria y de
   recuperación vectorial.
6. **Conteo de tokens** — el perfil de tokenizador local cuenta el contexto
   ensamblado.
7. **Ajuste de contexto** — el contexto se ajusta al presupuesto de tokens.
   Consulta [Ajuste de contexto](context-shifting).
8. **Interceptores de plugins** — los plugins pueden inspeccionar y
   modificar la matriz de mensajes. Después del último interceptor, el
   pipeline vuelve a contar los tokens y reaplica el presupuesto, por lo que
   ningún plugin puede omitirlo.
9. **Renderizado del formato de instrucciones** — la matriz de mensajes
   limpia se renderiza en el formato de instrucciones seleccionado, o se
   mantiene estructurada. Consulta
   [Formatos de instrucciones](instruct-formats).
10. **Serialización del proveedor** — el adaptador construye la solicitud
    del proveedor: los adaptadores de chat reciben la matriz de mensajes
    estructurada, y los de texto, la cadena de prompt renderizada.
11. **Solicitud** — la solicitud se envía con un `AbortSignal`, tiempos de
    espera y manejo de desconexión del cliente.
12. **Respuesta en streaming** — la respuesta se transmite por SSE. Un
    `assistantPrefill` opcional se antepone exactamente una vez al primer
    delta.
13. **Hooks de post-procesamiento** — los plugins pueden procesar la
    respuesta transmitida antes de que se guarde.
14. **Guardar mensaje** — el mensaje final, sus variantes y los metadatos de
    generación se guardan en una sola transacción.

## Reglas de los Hooks

Cada hook de plugin se define con el mismo contrato:

- **Orden y prioridad** — los hooks se ejecutan en orden de prioridad; las
  prioridades iguales se ordenan de forma determinista.
- **Tiempo de espera** — cada hook tiene un tiempo de espera. Un hook que lo
  supera se aborta.
- **Cancelación** — los hooks reciben el `AbortSignal` de la generación y
  deben detener el trabajo cuando se dispara.
- **Permisos** — un hook solo se ejecuta si el plugin tiene los permisos que
  requieren sus capacidades declaradas.
- **Aislamiento de excepciones** — un error en el hook de un plugin se
  captura, se registra y se omite. El pipeline continúa; un interceptor roto
  nunca debe romper en silencio toda la generación.
- **Registro de diagnóstico** — cada cambio del prompt queda registrado. El
  registro de cambios se devuelve en el diagnóstico de la generación y se
  guarda en el `meta` del mensaje de respuesta, por lo que siempre puedes
  ver qué se envió realmente.

## Post-Procesamiento del Prompt

En modo chat, la matriz de mensajes puede pasar por una etapa opcional de
reconstrucción antes de la serialización — el port del algoritmo clásico
`mergeMessages`. Los modos incluyen `merge`, `semi`, `strict` y `single`,
más las variantes `_tools` que conservan los mensajes de herramienta. En
modo texto esta etapa se omite, porque el renderizado de instrucciones ya
colapsó los roles en una sola cadena.

## Ver También

- [Ajuste de contexto](context-shifting) para saber cómo se aplica el
  presupuesto.
- [Tokenización](tokenization) para saber cómo funciona el conteo de tokens.
- El [Plugin SDK](../plugin-sdk/) para las APIs de registro de
  interceptores y post-procesamiento.
