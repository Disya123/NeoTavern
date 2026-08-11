---
title: Temas
description: Instalar, cambiar y crear temas en NeoTavern, además del modo seguro.
sidebar_position: 8
---

Esta página explica cómo funcionan los temas en NeoTavern: qué pueden
cambiar, cómo instalarlos y cambiarlos, y cómo te protege el modo seguro.

## Qué Cambia un Tema

Un tema tiene tres niveles:

- **Tokens de diseño** — colores, fuentes, espaciado, radios, sombras y
  duraciones de movimiento.
- **Skin de componentes** — el aspecto de botones, paneles y otros
  controles.
- **Diseño del shell** — la disposición de las regiones con nombre:
  navegación, navegador de personajes, área de visualización del chat,
  paneles laterales y capa de modales.

Esto significa que los temas son revisiones visuales completas, no solo
cambios de color. Un tema puede rediseñar la app como una consola de
videojuegos, una novela visual o un cliente móvil sin cambiar ninguna
lógica de chat. Cambiar el tema, el skin de componentes o el diseño del
shell nunca requiere reiniciar.

## Temas Incluidos

El primer inicio carga un conjunto de temas integrados, incluidos AMOLED,
GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night y Catppuccin Mocha.
El gestor de Temas siempre se abre con estos disponibles, por lo que puedes
cambiar de estilo de inmediato.

## Instalar Temas

Un paquete de tema es un archivo `.sttheme` — un ZIP con un manifiesto
`theme.json` y CSS, de hasta 25 MB. Instálalo a través del gestor de Temas:

1. Abre Temas desde la barra de navegación o la pestaña Ajustes → Temas.
2. Instala el paquete. El servidor valida rutas, tipos de archivo, tamaños y
   el manifiesto antes de escribir nada, y rechaza rutas de traversal,
   enlaces simbólicos y CSS prohibido.
3. Previsualiza el tema antes de aplicarlo. Desde la vista previa puedes
   aceptar el tema, volver atrás o abrir sus ajustes.
4. Actívalo. La instalación nunca activa un tema por sí sola.

Las actualizaciones de un tema instalado lo reemplazan atómicamente y
conservan su estado de activación. Si un tema falla al cargar, el shell
restaura automáticamente el último diseño que funcionaba.

## Temas Personalizados

Los temas son paquetes, no trucos: un tema no recibe acceso a tus chats,
claves de API ni sistema de archivos. El Theme SDK documenta los hooks
estables — `data-component`, `data-part`, `data-role` y `data-state` — que
los temas estilizan, y el contrato del shell que define las regiones con
nombre. Las anulaciones de CSS personalizado se cargan al final en la
cascada. Consulta la referencia del [Theme SDK](../developers/theme-sdk/)
para crear el tuyo.

## Modo Seguro y Recuperación

El modo seguro deshabilita todos los temas y plugins de terceros y es
accesible antes de que se carguen, por lo que un tema roto nunca puede
dejarte fuera. Después de un bucle de fallos, la app ofrece un inicio
seguro automáticamente. La acción integrada **Restablecer interfaz**
restaura el tema predeterminado sin editar archivos a mano, y ningún tema
puede ocultar esa acción.

Consulta [Ajustes](settings) para la pestaña General, donde viven el tema
activo y las opciones de estilo de mensaje.
