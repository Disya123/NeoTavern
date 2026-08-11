---
title: Información general de escritorio
description: >-
  Cómo se entrega la app de escritorio: un shell de Tauri 2 con un sidecar de
  Node.js integrado.
sidebar_position: 1
---

La app de escritorio es una distribución nativa de NeoTavern: un shell de
Tauri 2 que ejecuta el backend Fastify como un sidecar de Node.js integrado.

## Una App, Sin Configuración

La distribución de escritorio es autónoma. Node.js, SQLite y los recursos
web de producción viajan dentro del paquete, por lo que el primer inicio no
necesita terminal, ni Git, ni npm, ni configuración manual de la base de
datos. Instalas la app, la inicias, y la vista web se abre una vez que la
API local está lista.

Las piezas del runtime son:

- **Shell de Tauri 2** — la ventana nativa y el ciclo de vida de la
  aplicación.
- **Sidecar de Node.js** — un binario de Node.js 24 autónomo que ejecuta el
  backend Fastify localmente en `127.0.0.1`.
- **SQLite** — la base de datos local, creada automáticamente en el
  directorio de datos en el primer inicio.

## Formatos Soportados

La compilación de escritorio apunta a los formatos que la mayoría de los
usuarios esperan:

- Instalador de Windows (NSIS y MSI).
- Versión portátil de Windows (un ZIP con un marcador portátil).
- Paquete de macOS (`.app`, además de DMG).
- AppImage de Linux y un archivo.

Cada formato se produce en su runner de plataforma nativa, porque la
distribución incluye módulos nativos como `better-sqlite3` y Sharp. Consulta
[Empaquetado](packaging.md) para los detalles de los formatos y el
comportamiento del primer inicio.

## Garantías del Ciclo de Vida

El shell y el sidecar son una sola unidad. Cerrar la ventana apaga el
backend — la app nunca deja un proceso de Node.js huérfano. Una salida
inesperada del backend termina el shell con un error en lugar de una ventana
rota en silencio. Consulta [Shell de Tauri](tauri-shell.md) y
[Sidecar de Node](node-sidecar.md) para la mecánica.

## Ubicación de los Datos

Las compilaciones instaladas guardan los datos de usuario en el directorio
de datos locales de la aplicación de la plataforma, nunca dentro del
paquete. La versión portátil es la excepción: con el marcador portátil
presente, los datos viven en una carpeta `data/` local junto a la
aplicación. El manejo de datos en sí está cubierto en la sección
[Datos y almacenamiento](../data/index.md).

## Siguientes Pasos

- [Shell de Tauri](tauri-shell.md) — la ventana nativa y su ciclo de vida.
- [Sidecar de Node](node-sidecar.md) — el proceso de backend integrado.
- [Empaquetado](packaging.md) — formatos de distribución y primer inicio.
