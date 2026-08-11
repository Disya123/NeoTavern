---
title: Configuración de desarrollo
description: Configura un entorno de desarrollo de NeoTavern y ejecuta el proyecto localmente
sidebar_position: 2
---

Esta página explica cómo configurar un entorno de desarrollo para NeoTavern
y ejecutar el proyecto localmente.

## Prerrequisitos

- Node.js 24 LTS o más reciente — el proyecto requiere Node `>= 24`.
- pnpm 9 — el workspace requiere pnpm `>= 9` y `< 10` y declara
  `packageManager: pnpm@9.15.0`; habilítalo con corepack o instálalo
  directamente.
- Windows, macOS o Linux. La app de escritorio incluye su propio runtime de
  Node.js para los usuarios finales, pero el desarrollo siempre usa tu
  Node.js instalado.

## Instalar Dependencias

```bash
pnpm install
```

Esto instala cada paquete del workspace. El repositorio es un monorepo de
pnpm: las aplicaciones viven en `apps/` (servidor y web) y las bibliotecas
compartidas en `packages/`.

## Ejecutar en Desarrollo

```bash
pnpm dev
```

inicia el backend Fastify y la app web de Vite en paralelo con recarga en
caliente. Para ejecutarlos por separado:

```bash
pnpm dev:server
pnpm dev:web
```

Abre la URL que imprime el servidor de desarrollo de Vite, conecta un
proveedor en Ajustes y envía tu primer mensaje para verificar todo el
pipeline: chat, servidor, proveedor, streaming y guardado.

## Puertas de Calidad

Ejecuta estas antes de hacer push:

```bash
pnpm typecheck    # TypeScript en todo el monorepo
pnpm lint         # ESLint, cero advertencias permitidas
pnpm test         # Pruebas unitarias e de integración de Vitest, más las pruebas web
pnpm test:e2e     # Suite de extremo a extremo de Playwright (compila el workspace primero)
pnpm build        # Compilación completa del workspace (tsc -b y Vite)
pnpm format:check # Verificación de Prettier
```

`pnpm test:e2e` compila todo el workspace primero, así que espera que tarde
más que las otras verificaciones. Los scripts `docs:check` y `docs:build`
validan la documentación interna de desarrollo; el sitio público tiene sus
propios comandos, documentados en la página
[Sitio de documentación](./docs-site).

## Desarrollo de Escritorio

El shell de escritorio (Tauri) y su sidecar de Node son aplicaciones
separadas:

```bash
pnpm desktop:dev       # ejecuta la app de escritorio en desarrollo
pnpm desktop:portable  # compila el paquete portátil de Windows
pnpm desktop:release   # compila los paquetes de instalador
```

El empaquetado de escritorio involucra toolchains específicas del sistema
operativo; consulta la sección [Escritorio](../developers/desktop/) de la
documentación de desarrolladores para los detalles.

## Problemas Comunes

- `pnpm install` o `pnpm dev` fallan: verifica que `node -v` informe 24 o
  más reciente y que `pnpm -v` informe 9.
- Los servidores de desarrollo no inician: verifica que ningún otro proceso
  ocupe los puertos que usan el servidor y Vite, y luego reinicia `pnpm dev`.
