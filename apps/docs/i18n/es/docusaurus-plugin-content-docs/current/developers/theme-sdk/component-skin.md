---
title: Skin de componentes
description: >-
  La pila de estilos para los skins de tema, desde las capas en cascada hasta
  los hooks estables.
sidebar_position: 4
---

El nivel de skin de componentes rediseña los componentes integrados. Se
construye sobre una pila de estilos específica y un contrato de hooks
estable.

## La Pila de Estilos

La interfaz integrada usa cuatro tecnologías juntas:

- **CSS Modules** para estilos con ámbito de componente, con nombres de
  clase con hash que explícitamente no son un contrato público.
- **Propiedades personalizadas de CSS** para los tokens semánticos
  (`--st-*`).
- **Capas en cascada** para ordenar las fuentes de verdad.
- **Consultas de contenedor** para diseños que se adaptan al propio
  contenedor del componente, con tamaños expresados en `rem`.

Los temas apuntan a los atributos de hooks, nunca a los nombres de clase
generados.

## Orden de las Capas en Cascada

Todos los estilos viven en un orden fijo de capas en cascada:

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Las capas posteriores ganan sobre las anteriores, por lo que la precedencia
es:

1. `reset` — el reset base.
2. `tokens` — las definiciones de tokens.
3. `base` — los valores predeterminados a nivel de elemento.
4. `components` — los estilos de componentes integrados.
5. `plugin-base` — una capa para los estilos base proporcionados por los
   plugins.
6. `theme` — el skin del tema activo.
7. `user` — las anulaciones del propio usuario, que se cargan al final.

La hoja de estilos de anulación del usuario siempre se carga al final, por
lo que un tema roto u opinado nunca puede impedir que el usuario lo anule.
En términos de `!important`: la construcción está prohibida en el CSS del
tema, excepto en la capa de preferencias de accesibilidad, que pertenece a
los modos de accesibilidad orientados al usuario.

## El Contrato de Hooks

Los temas estilizan los componentes a través de cuatro atributos, publicados
por el host y versionados como el resto del SDK:

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — el tipo de componente.
- `data-part` — la parte estructural dentro de un componente.
- `data-role` — un rol semántico, como un rol de mensaje.
- `data-state` — un estado, como `open`, `closed` o `streaming`.

El CSS del skin de un tema se ve así:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

El paquete `@neotavern/theme-sdk` exporta el helper `dataHook` para construir
estos objetos de atributos, por lo que los autores de componentes y los
autores de temas coinciden en los mismos nombres.

## Lo Que No Es un Contrato

- **Los nombres de clase generados por CSS Modules** — con hash, inestables
  y fuera del SDK. Un tema que los apunta se rompe en la próxima
  compilación.
- **La jerarquía interna de React** — los temas no deben depender de los
  internos de los componentes ni del orden del DOM más allá de los hooks
  documentados.
- **Los valores de diseño numéricos** — las coordenadas, los esquemas de
  grid y los puntos de interrupción no se pueden estilizar a través del
  contrato de tokens; los puntos de interrupción de viewport viven en el
  registro y las consultas de contenedor deben escribirse en `rem`.

## CSS Prohibido

Las hojas de estilo de los temas se escanean antes de cargarse. Las
construcciones prohibidas se rechazan en la instalación y la validación:

- `@import`
- URL `javascript:` y `expression()`.
- `-moz-binding` y `behavior:`.
- URL remotas o relativas al protocolo (`url(http:`, `url(https:`,
  `url(//`).
- `data:text/html`.
- `!important` (excepto la capa de preferencias de accesibilidad).

Esto mantiene el CSS del tema puro, local y seguro. Para los tokens que el
skin debe referenciar, consulta [Tokens de diseño](design-tokens.md); para
las áreas con nombre que un skin puede rediseñar, consulta
[Contrato del shell](shell-contract.md).
