---
title: Información general del Theme SDK
description: 'Qué es el Theme SDK: un reemplazo visual completo del shell, nivel por nivel.'
sidebar_position: 1
---

El Theme SDK es el contrato versionado para reemplazar por completo el shell
visual de NeoTavern — no solo recolorarlo.

## Qué Es el Theme SDK

Un tema es un paquete (`.sttheme`) que controla cómo se ve la aplicación y
cómo se componen sus áreas principales. A diferencia de un plugin, un tema
no tiene JavaScript: es CSS, tokens semánticos y un diseño de shell
declarativo en un manifiesto. Como el SDK es declarativo, un tema no puede
romper el comportamiento de la aplicación ni alcanzar sus datos.

El paquete `@neotavern/theme-sdk` proporciona el contrato en sí: los nombres
canónicos de tokens, la validación del manifiesto, la resolución de
herencia y la generación de variables CSS. La implementación de referencia
del host aplica un tema escribiendo las propiedades personalizadas `--st-*`
en la raíz del documento y cargando las hojas de estilo del tema en un orden
definido.

## Los Tres Niveles

El tematizado está estructurado en tres niveles, y un tema puede usar
cualquiera de ellos:

1. **Tokens de diseño** — variables semánticas para colores, fuentes,
   espaciado, radios, sombras, capas de z-index, movimiento y tamaños de
   control. Los componentes referencian estos tokens exclusivamente, por lo
   que anular un token rediseña toda la interfaz de forma consistente.
2. **Skin de componentes** — CSS que rediseña los componentes a través de
   los hooks estables `data-component`, `data-part`, `data-role` y
   `data-state`.
3. **Diseño del shell** — la composición declarativa de las áreas
   principales: la barra de navegación, los paneles de gestión y el espacio
   de trabajo de chat.

Como la lógica de chat, el modelo de datos y el comportamiento no se tocan,
un tema puede imitar un sistema operativo, una consola de videojuegos, una
interfaz de novela visual o un diseño de app móvil sin romper ninguna
función. Consulta [Niveles](levels.md) para los detalles.

## Crear Sin Paso de Compilación

Un tema es un ZIP con `theme.json`, `components.css` y `shell.css`. Puedes
crear uno a mano:

1. Abre el gestor de Temas y descarga el kit de inicio de temas.
2. Descomprímelo y edita `theme.json`, `components.css` y `shell.css`.
3. Vuelve a comprimir los archivos en la raíz del archivo e instala el
   paquete.
4. Verifica los modos claro y oscuro, móvil, foco del teclado, RTL y modo
   seguro, y luego aplica el tema.

No se requiere Node.js, npm, JavaScript ni una CLI del Theme SDK para un
primer tema.

## Instalación y Activación

Instalar un paquete no lo activa. La activación valida toda la cadena
`extends` en busca de padres faltantes y ciclos, y luego actualiza el tema
habilitado y la selección de tema guardada en una sola transacción.
Actualizar un paquete con el mismo id reemplaza atómicamente su directorio y
conserva el estado de activación actual; ante un error del registro, se
restaura el directorio anterior.

La distribución incluye un conjunto de temas integrados, como AMOLED, GitHub
Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha,
Solarized Dark y One Dark, por lo que el gestor de Temas nunca se abre
vacío.

## Seguridad

Los temas no pueden leer chats, claves de API ni el sistema de archivos, y
no contienen código ejecutable. Cada hoja de estilo se escanea en busca de
construcciones prohibidas, y el modo seguro deshabilita los temas de
terceros por completo. Consulta [Modo seguro](safe-mode.md) para las
garantías, y la [referencia del Theme SDK](../api/theme-sdk/) generada para
la API completa.

## Siguientes Pasos

- [Niveles](levels.md) — tokens, skins y diseños de shell.
- [Tokens de diseño](design-tokens.md) — el contrato semántico de tokens.
- [Skin de componentes](component-skin.md) — la pila de estilos y los hooks.
- [Contrato del shell](shell-contract.md) — áreas con nombre y ranuras
  estables.
- [Modo seguro](safe-mode.md) — recuperación de temas rotos.
