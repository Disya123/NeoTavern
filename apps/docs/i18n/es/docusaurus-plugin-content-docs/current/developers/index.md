---
title: Desarrolladores
description: >-
  Información general de la documentación para desarrolladores de NeoTavern:
  arquitectura, pipeline de prompt, capa de datos y los SDK para ampliar la
  app.
sidebar_position: 1
---

Esta sección explica cómo está construido NeoTavern y cómo puedes ampliarlo
con plugins, temas y adaptadores de proveedor.

## Qué Cubre Esta Sección

La documentación para desarrolladores se divide en cuatro grupos:

- **Arquitectura** — la estructura del monorepo, la pila tecnológica
  aprobada y la responsabilidad de cada paquete del workspace.
- **Pipeline de prompt** — el conjunto fijo de etapas que convierte un chat
  en una solicitud de proveedor, incluidos los formatos de instrucciones, la
  tokenización y el ajuste de contexto.
- **Datos y almacenamiento** — cómo guarda NeoTavern los datos estructurados
  en SQLite, cómo se manejan los archivos e imágenes en el disco y cómo
  funcionan los respaldos.
- **Ampliar NeoTavern** — el Plugin SDK, el Theme SDK, los adaptadores de
  proveedor, la referencia de API generada y el shell de escritorio.

## Por Dónde Empezar

Comienza con la [Información general de arquitectura](developers/architecture/) si
quieres entender la forma del código, o salta directamente al
[Pipeline de prompt](developers/prompt-pipeline/) si trabajas en el comportamiento de
generación.

## Capa de Datos

La sección [Datos y almacenamiento](developers/data/) cubre la base de datos SQLite, la
estructura del sistema de archivos y el modelo de respaldo. Es la referencia
para todo lo que persiste datos.

## Ampliar NeoTavern

NeoTavern se amplía de cuatro maneras:

- [Plugin SDK](developers/plugin-sdk/) — plugins con un manifiesto, permisos, APIs de
  frontend y backend, hooks de ciclo de vida y sandbox.
- [Theme SDK](developers/theme-sdk/) — temas construidos con tokens de diseño, skins de
  componentes y diseños de shell.
- [Proveedores](developers/providers/) — adaptadores de proveedor que implementan el
  contrato de adaptador unificado.
- [Compatibilidad heredada](developers/legacy-compat) — la capa de compatibilidad para
  plugins y scripts de la era de SillyTavern.

La [Referencia de API](api/) se genera a partir de las fuentes de los SDK
con TypeDoc durante cada compilación del sitio, por lo que sus páginas de
miembros siempre coinciden con los paquetes publicados.

## Escritorio

La sección [Escritorio](developers/desktop/) documenta el shell de Tauri 2, el sidecar
de Node.js y cómo se empaquetan los instaladores y las versiones portátiles.
