---
title: Empaquetado
description: >-
  Formatos de distribución para Windows, macOS y Linux, y la experiencia del
  primer inicio.
sidebar_position: 4
---

NeoTavern se distribuye como paquetes nativos por plataforma, cada uno con
el sidecar de Node.js, SQLite, los módulos nativos y los recursos web de
producción.

## Formatos de Distribución

La compilación de escritorio produce:

- **Instalador de Windows** — instaladores NSIS y MSI con modo de instalación
  por usuario. El instalador registra la app y coloca los datos de usuario
  en el directorio de datos locales de la aplicación de la plataforma.
- **Versión portátil de Windows** — un ZIP que contiene el ejecutable, el
  sidecar, un marcador `portable.flag` y `resources/`, más un archivo de
  suma de verificación `.sha256`. Con el marcador presente, los datos viven
  en una carpeta `data/` local junto a la aplicación en lugar de en los
  datos locales de la aplicación.
- **Paquete de macOS** — un paquete `.app`, empaquetado en un DMG en el
  runner de macOS.
- **Linux** — una AppImage y un archivo.

Cada formato se compila y se somete a pruebas de humo en su propio runner de
plataforma nativa, porque la distribución incluye módulos nativos. Copiar
artefactos preparados entre plataformas no está soportado.

## Qué Viaja Dentro

Cada paquete contiene todo lo que la app necesita en el runtime:

- El shell de Tauri 2.
- El ejecutable del sidecar de Node.js 24 autónomo.
- SQLite vía `better-sqlite3`.
- Sharp para el procesamiento de imágenes.
- Los recursos web de producción.

Como Node.js, SQLite y los recursos están dentro del paquete, el usuario no
necesita nada instalado de antemano — ni Node.js, ni npm, ni configuración
de base de datos.

## Primer Inicio

El primer inicio es la promesa central del producto: abre la app y funciona.

1. El shell inicia el sidecar.
2. El backend crea el directorio de datos, inicializa la base de datos
   SQLite, ejecuta las migraciones pendientes (con un respaldo antes de los
   cambios de esquema pendientes) e inicializa los temas incluidos y el
   personaje inicial.
3. La vista web se abre sobre la aplicación lista.

No hay terminal, ni asistente de instalación más allá del de la plataforma,
ni `npm install`, ni configuración manual. Si el usuario eligió un fondo de
chat o instaló plugins, nada de eso vive en el ejecutable — los datos de
usuario están separados del paquete, por lo que las actualizaciones
reemplazan el núcleo sin tocar los archivos del usuario.

## Actualizaciones

Las compilaciones de lanzamiento firman sus artefactos e integran el
actualizador de Tauri. El actualizador verifica el manifiesto y una firma
minisign antes de instalar un artefacto de la plataforma, y luego reinicia
el shell. La reversión significa publicar el código revisado anterior como
una nueva versión firmada — no se permiten degradaciones sin firmar. Los
plugins y temas se actualizan de forma independiente a través de los
gestores de Plugins y Temas; los archivos de usuario nunca entran en un
artefacto de actualización ejecutable.

## Compilación

Desde el repositorio, los comandos de empaquetado son:

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` compila el servidor y la web, copia los módulos nativos
específicos del destino y crea el sidecar con el sufijo de triplete de
destino de Tauri. `desktop:portable` además compila los instaladores
NSIS/MSI y el ZIP portátil con suma de verificación, y luego ejecuta una
prueba de humo del shell sin interfaz. `desktop:release` produce artefactos
de actualización firmados y requiere los secretos de lanzamiento. Compilar
los instaladores requiere Rust stable MSVC, Windows C++ Build Tools y
WebView2 en la máquina de compilación — nada de lo que los usuarios finales
necesiten.
