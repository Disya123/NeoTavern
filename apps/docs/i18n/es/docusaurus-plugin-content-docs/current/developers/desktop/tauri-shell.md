---
title: Shell de Tauri
description: El shell nativo de Tauri 2 y cómo cerrar la ventana detiene el backend.
sidebar_position: 2
---

El shell de escritorio está construido sobre Tauri 2. Es dueño de la ventana
nativa, inicia el backend y garantiza que los dos se apaguen juntos.

## El Trabajo del Shell

El shell hace tres cosas:

1. **Lanza el sidecar** — inicia el proceso de backend de Node.js autónomo y
   espera hasta que la API local esté lista antes de abrir la vista web.
   Nunca ves una ventana a medio cargar apuntando a un servidor muerto.
2. **Aloja la vista web** — la app web de producción se ejecuta dentro de la
   vista web de Tauri y se comunica con el backend por `127.0.0.1` en un
   puerto libre aleatorio.
3. **Es dueño del ciclo de vida** — los eventos de ventana y los eventos de
   proceso están conectados para que el backend y el shell siempre salgan
   como una sola unidad.

## Ciclo de Vida de la Ventana

- **Cerrar** — cerrar la ventana dispara un apagado correcto del sidecar. Se
  le pide al backend que se detenga limpiamente, y la app espera a que lo
  haga antes de salir. No queda ningún proceso de Node.js huérfano.
- **Fallo del backend** — si el sidecar sale de forma inesperada, el shell
  termina con un error en lugar de mostrar una ventana que no puede hacer
  nada. Las salidas normales se marcan por separado para que un apagado
  limpio nunca se confunda con un fallo.
- **Reiniciar** — volver a iniciar la app vuelve a lanzar el sidecar desde
  cero. El estado vive en el directorio de datos, no en el proceso, por lo
  que los reinicios no pierden nada.

## La Ventana Es la API

Como el shell espera a la API antes de mostrar contenido, el primer inicio
se siente inmediato: la ventana se abre sobre una aplicación lista. El
backend solo escucha en `127.0.0.1` en un puerto efímero, por lo que nada
queda expuesto a la red.

## Integración con el Actualizador

Las compilaciones de lanzamiento integran el actualizador de Tauri. El shell
puede buscar actualizaciones del núcleo, verificar el manifiesto y la firma
minisign, instalar el artefacto de la plataforma y reiniciar. El
actualizador reemplaza el núcleo por separado del directorio de datos del
usuario, y se rechazan las degradaciones sin firmar. Las compilaciones
hechas sin endpoint de actualización ni clave pública son totalmente
funcionales pero informan que las actualizaciones no están configuradas.

## Compilaciones de Desarrollo

Para el desarrollo, el mismo shell puede ejecutarse contra un servidor de
desarrollo y un backend iniciado localmente. La garantía de producción — el
sidecar sale con la ventana — se aplica a las compilaciones empaquetadas;
`pnpm desktop:dev` conecta el shell a tus procesos de desarrollo en
ejecución en su lugar.

Para saber cómo se agrupa y gestiona el sidecar, consulta
[Sidecar de Node](node-sidecar.md).
