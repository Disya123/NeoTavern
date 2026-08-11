---
title: Atajos de teclado
description: Los atajos de teclado predeterminados de NeoTavern de un vistazo.
sidebar_position: 11
---

Esta página enumera los atajos de teclado predeterminados de NeoTavern.
Toda la app es operable desde el teclado, y cada modal mantiene el foco
dentro de sí mismo hasta que lo cierras.

## Redactor

| Acción                        | Atajo                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| Enviar mensaje                | `Enter`                                                      |
| Insertar una línea nueva      | `Shift+Enter`                                                |
| Abrir la búsqueda de chat     | Enfocar el campo de búsqueda en el encabezado del chat       |
| Desplazarse al último mensaje | Usar la acción "mensaje nuevo" tras desplazarse hacia arriba |

La pista del redactor siempre muestra el modo actual, por lo que puedes ver
de un vistazo si `Enter` envía o agrega una línea.

## Editar Mensajes

| Acción              | Atajo                                              |
| ------------------- | -------------------------------------------------- |
| Guardar la edición  | `Ctrl+Enter` (Windows/Linux) o `Cmd+Enter` (macOS) |
| Cancelar la edición | `Escape`                                           |

La edición no es destructiva: el contenido anterior se archiva en el
historial de ediciones del mensaje, y un conflicto conserva tu borrador en
lugar de sobrescribirlo. Consulta [Chat](chat).

## Navegación y Paneles

| Acción                                      | Atajo                                                                |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Cerrar el panel, diálogo o menú superior    | `Escape`                                                             |
| Mover el foco hacia adelante / atrás        | `Tab` / `Shift+Tab`                                                  |
| Cerrar una superficie consciente de la ruta | Atrás del navegador                                                  |
| Redimensionar un panel                      | `ArrowLeft` / `ArrowRight` con el control de redimensionado enfocado |
| Abrir y cerrar el menú de navegación        | El botón de conmutación de la barra                                  |

`Escape` cierra primero la superficie superior: un diálogo anidado se cierra
antes que el panel que está detrás, y el foco vuelve al control que lo abrió.

## Acciones de Chat

| Acción                              | Atajo                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| Cambiar entre variantes de swipe    | Flechas anterior / siguiente en el paginador `N/M`            |
| Abrir una instantánea de checkpoint | Haz clic en el marcador (`Shift+Clic` crea una nueva)         |
| Excluir o restaurar un mensaje      | La acción excluir en la barra del mensaje (estrategia manual) |

Las acciones de mensaje siempre están visibles en el escritorio y se agrupan
en la tarjeta de mensaje compacta en móvil; cada acción es un control
enfocable, por lo que ninguna requiere pasar el cursor o un puntero.

## Atajos de Teclado de los Plugins

Los plugins registran sus atajos a través del Plugin SDK, que resuelve las
colisiones para que gane el registro activo más reciente y libera el vínculo
cuando el plugin se deshabilita. Los atajos de los plugins nunca interceptan
las combinaciones del navegador del sistema, y la paleta de comandos enumera
el atajo de cada comando en contexto. Consulta
[Extensiones y plugins](extensions).
