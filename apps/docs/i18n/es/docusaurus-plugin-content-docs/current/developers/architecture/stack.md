---
title: Pila tecnológica
description: >-
  La pila aprobada de NeoTavern: Node.js 24, Fastify 5, React 19, Vite 8,
  TypeScript estricto, SQLite con Drizzle y Tauri 2.
sidebar_position: 3
---

NeoTavern se ejecuta sobre una pila deliberadamente convencional: Node.js 24
LTS, Fastify 5, React 19, Vite 8, TypeScript estricto, SQLite con Drizzle
ORM y un shell de escritorio Tauri 2.

## Runtime y Lenguaje

- **Node.js 24 LTS** — el runtime del backend y del sidecar de escritorio
  incluido. El código sigue siendo compatible con Node.js 22 cuando es
  práctico.
- **TypeScript estricto** — habilitado en todas partes. Están prohibidos el
  `any` injustificado, `as unknown as`, `@ts-ignore` y las aserciones no
  nulas. Los límites del sistema usan `unknown` y validación explícita.
- **Solo ESM** — todas las apps y paquetes usan módulos ES.

## Backend

- **Fastify 5** — el framework de API. Cada módulo del backend es un plugin
  de Fastify aislado.
- **TypeBox + Fastify Type Provider** — cada entrada y salida de API tiene un
  JSON Schema, generado desde `@neotavern/contracts`.
- **SSE** — la generación en streaming se ejecuta sobre Server-Sent Events.
  WebSocket queda reservado para canales bidireccionales reales.
- **AbortSignal** — toda operación de larga duración acepta un `AbortSignal`
  y agota su tiempo de espera limpiamente cuando el cliente se desconecta.

## Frontend

- **React 19** — una aplicación de una sola página, sin renderizado en el
  servidor.
- **Vite 8** — el bundler y el servidor de desarrollo. Vite es solo
  herramienta de compilación, no una API de plugins de aplicación.
- **React Router** — el enrutado, con un único espacio de trabajo de chat y
  superficies de sistema renderizadas sobre él.
- **TanStack Query** — el único almacén del estado del servidor.
- **Zustand** — solo estado de interfaz transitorio: el panel activo, las
  preferencias de tema e idioma, el personaje fijado y borradores limitados
  de la sesión.
- **Radix Primitives** — componentes headless accesibles envueltos por
  `@neotavern/ui`.

## Datos

- **SQLite vía better-sqlite3** — el único archivo de base de datos, abierto
  con WAL, `foreign_keys = ON`, `busy_timeout` y sentencias preparadas.
- **Drizzle ORM** — esquema tipado, repositorios y migraciones.
- **FTS5** — búsqueda de texto completo sobre personajes, chats y mensajes.

## Estilos

- **CSS Modules + propiedades personalizadas + capas en cascada + consultas
  de contenedor** — el kit de herramientas de estilo. Los temas anulan los
  tokens de diseño y las reglas de las capas sin luchar contra la
  especificidad.

## Plantillas y Localización

- **Handlebars** — plantillas de formato de instrucciones, renderizadas en
  un entorno en sandbox sin acceso al sistema de archivos ni a la ejecución
  de código.
- **i18next** — todas las cadenas visibles al usuario, con espacios de
  nombres y recursos por locale.

## Escritorio

- **Tauri 2** — el shell de escritorio, con el servidor Node.js distribuido
  como binario sidecar autónomo.
- **tauri-plugin-shell y tauri-plugin-updater** — gestión de procesos y
  actualizaciones firmadas.

## Herramientas

- **pnpm workspaces** — el gestor de paquetes del monorepo.
- **Vitest** — pruebas unitarias e de integración.
- **Playwright** — pruebas de extremo a extremo, incluidas las pruebas de
  humo del shell de escritorio.

## Qué Está Deliberadamente Ausente

- Sin PostgreSQL, Redis, Docker ni ningún otro servicio que debas instalar o
  ejecutar.
- Sin SSR ni servidor Node para el frontend más allá del proceso de API.
- Sin `node:vm` como sandbox de seguridad para plugins — los plugins de
  backend no confiables se ejecutan en un proceso restringido separado.

Consulta la [Información general del monorepo](overview) para saber cómo
encajan las piezas y [Paquetes](packages) para saber quién es dueño de qué.
