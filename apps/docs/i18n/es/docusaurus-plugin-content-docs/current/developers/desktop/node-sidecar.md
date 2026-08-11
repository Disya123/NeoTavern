---
title: Sidecar de Node
description: >-
  El backend Fastify como sidecar de Node.js integrado, desde el inicio hasta
  el apagado correcto.
sidebar_position: 3
---

El backend de NeoTavern es un servidor Fastify, y en la app de escritorio se
ejecuta como un sidecar de Node.js integrado: un binario de Node.js 24
autónomo empaquetado junto al shell.

## Por Qué un Sidecar

Agrupar el backend como un proceso separado mantiene el shell liviano y el
backend real:

- El backend es la misma aplicación Fastify 5 que ejecuta una instalación
  autoalojada, por lo que el comportamiento de escritorio y servidor
  permanece idéntico.
- Node.js y SQLite están compilados en la distribución, que es la razón por
  la que el primer inicio no necesita npm install ni una terminal.
- Un límite de proceso significa que un fallo o un cuelgue en el backend no
  puede derribar el bucle de eventos del shell, y el shell puede imponer las
  garantías del ciclo de vida.

## Inicio

Al iniciar, el shell lanza el ejecutable del sidecar y espera a que esté
listo antes de abrir la vista web. El backend:

- escucha en un puerto libre aleatorio solo en `127.0.0.1`;
- crea la base de datos SQLite y ejecuta las migraciones de esquema
  pendientes en el directorio de datos, tomando un respaldo antes de las
  migraciones pendientes;
- sirve los recursos web de producción y la API.

El primer inicio es totalmente automático: el directorio de datos, la base
de datos, los temas incluidos y el personaje inicial se configuran sin
ninguna interacción del usuario.

## Apagado Correcto

El apagado es cooperativo y ordenado:

1. El shell recibe el evento de cierre y le dice al backend que se detenga.
2. El backend deja de aceptar conexiones nuevas, termina el trabajo en curso
   dentro de su plazo y cierra la base de datos limpiamente.
3. El sidecar sale y el shell sale.

El shell detecta una terminación inesperada del backend y la informa como
una salida con error, nunca la deja huérfana en silencio. Por lo tanto, la
app nunca deja un proceso `neotavern-server` suelto después de cerrar la
ventana.

## Agrupación y Verificación

El sidecar se compila por plataforma de destino. Los módulos nativos
(`better-sqlite3`, Sharp) y los recursos web de producción se preparan en el
mismo runner de destino y se empaquetan con el ejecutable; mover recursos
preparados entre sistemas operativos no está soportado. Una puerta de humo
ejecuta el sidecar empaquetado sin interfaz en cada plataforma en CI,
verificando el ejecutable real de Node, SQLite, Sharp, la SPA empaquetada,
el diagnóstico y la ausencia de procesos sobrantes.

## Variante Portátil

La versión portátil de Windows ejecuta el mismo diseño de sidecar: el
ejecutable principal, el ejecutable del sidecar, un marcador `portable.flag`
y una carpeta `resources/`. El marcador cambia la raíz de datos a una
carpeta `data/` local junto a la aplicación. El shell normaliza las rutas de
recursos de Windows antes de entregarlas al binario de Node empaquetado.

Para los formatos y la experiencia del primer inicio, consulta
[Empaquetado](packaging.md); para el shell que gestiona este proceso,
consulta [Shell de Tauri](tauri-shell.md).
