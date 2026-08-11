---
title: Pipeline de prompt
description: >-
  Información general del pipeline de prompt: el orden fijo de las etapas,
  los formatos de instrucciones, el conteo local de tokens y el ajuste de
  contexto.
sidebar_position: 1
---

El pipeline de prompt es el conjunto fijo y ordenado de etapas que convierte
un chat en una solicitud de proveedor, desde la entrada del usuario hasta el
mensaje guardado.

## Qué Hace el Pipeline

Cada generación — un mensaje nuevo, un swipe, una regeneración o una
imitación (impersonation) — pasa por las mismas etapas en el mismo orden. El
pipeline ensambla el contexto a partir del personaje, la persona, el
lorebook y la memoria, cuenta los tokens, ajusta el contexto al presupuesto
del modelo, permite que los plugins intercepten, renderiza la solicitud en
el formato de instrucciones seleccionado y, finalmente, transmite y guarda
la respuesta.

## Páginas de Esta Sección

- [Etapas del pipeline](prompt-pipeline/stages) — las 14 etapas en orden y las reglas que
  debe seguir cada hook de plugin.
- [Formatos de instrucciones](prompt-pipeline/instruct-formats) — cómo se renderiza la
  matriz de mensajes limpia con plantillas de Handlebars en sandbox.
- [Tokenización](prompt-pipeline/tokenization) — el registro local de tokenizadores y su
  respaldo aproximado.
- [Ajuste de contexto](prompt-pipeline/context-shifting) — cómo ajusta el pipeline el
  contexto al presupuesto de tokens y qué estrategias existen.

## Implementación

El pipeline vive en `apps/server/src/pipeline/`. Se ejecuta por completo en
el servidor, antes de cualquier llamada de red, por lo que la solicitud que
llega a un proveedor es siempre el resultado de las mismas etapas
deterministas.

## Secciones Relacionadas

- Los interceptores de plugins y sus APIs de registro se documentan en el
  [Plugin SDK](plugin-sdk/).
- El endpoint de generación y la auditoría de contexto son parte de la
  [Referencia de API](../api/).
- Los adaptadores de proveedor que consumen la solicitud serializada se
  documentan en [Proveedores](providers/).
