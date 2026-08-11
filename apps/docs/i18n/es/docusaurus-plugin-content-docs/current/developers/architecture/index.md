---
title: Arquitectura
description: >-
  Información general de la sección de arquitectura: la estructura del
  monorepo, la pila tecnológica aprobada y las responsabilidades de cada
  paquete.
sidebar_position: 1
---

Esta sección explica cómo está organizado el monorepo de NeoTavern, qué
tecnologías usa y cómo encajan el servidor, el cliente web y el shell de
escritorio.

## Páginas de Esta Sección

- [Información general del monorepo](architecture/overview) — la estructura de `apps/` y
  `packages/`, el flujo de datos entre servidor y web, y el principio
  local-first.
- [Pila tecnológica](architecture/stack) — la pila aprobada: Node.js 24, Fastify 5,
  React 19, Vite 8, SQLite, Drizzle, Tauri 2 y workspaces de pnpm.
- [Paquetes](architecture/packages) — la responsabilidad de cada paquete del workspace y
  la dirección de las dependencias entre ellos.

## Secciones Relacionadas

La sección [Pipeline de prompt](prompt-pipeline/) describe las etapas de
generación en detalle, y [Datos y almacenamiento](data/) documenta la
base de datos, el manejo de archivos y los respaldos.
