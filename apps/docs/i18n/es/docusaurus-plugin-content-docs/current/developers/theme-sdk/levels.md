---
title: Niveles de tema
description: 'Los tres niveles del tematizado: tokens, skin de componentes y diseño del shell.'
sidebar_position: 2
---

Un tema se construye a partir de tres niveles independientes. Entender la
división es lo que permite que un tema cambie el aspecto de toda la
aplicación sin tocar su comportamiento.

## Nivel 1: Tokens de Diseño

Los tokens son propiedades personalizadas de CSS semánticas con el prefijo
`--st-`. Cubren colores, tipografía, espaciado, radios, bordes, sombras,
capas de z-index, movimiento, tamaños de control, barras de desplazamiento
y el lienzo de chat.

Los componentes referencian solo tokens — nunca codifican un valor de color,
fuente o espaciado. Anular un token en el manifiesto del tema rediseña cada
componente que lo usa:

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

Los tokens se resuelven a través de una cadena de herencia: valores
predeterminados integrados para el modo, luego los temas padres, y luego el
propio tema. El modo oscuro recurre a los tokens claros del tema cuando no
existe una anulación oscura. Consulta [Tokens de diseño](design-tokens.md)
para el contrato completo.

## Nivel 2: Skin de Componentes

El skin de componentes es CSS que rediseña los componentes integrados a
través de hooks estables. El host publica los atributos `data-component`,
`data-part`, `data-role` y `data-state`; un tema estiliza estos atributos,
nunca los nombres de clase generados por CSS Modules:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

El skin se aplica a través de capas en cascada en un orden fijo, con la capa
de anulación del usuario al final. `!important` está prohibido en el CSS del
tema, excepto en la capa de preferencias de accesibilidad. Consulta
[Skin de componentes](component-skin.md) para el orden de las capas y la
referencia de hooks.

## Nivel 3: Diseño del Shell

El diseño del shell es la composición de las áreas principales: la barra de
navegación, los paneles de gestión y el espacio de trabajo de chat. Es
declarativo, expresado en `theme.json` — nunca en JavaScript:

```json
{
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

Los elementos válidos de la barra son `chats`, `characters`, `personas`,
`lorebooks`, `backgrounds`, `ai-settings`, `plugins`, `settings` y el
opcional `menu-toggle`. El grupo `main` fluye desde arriba; `bottom` se fija
al borde inferior. Los elementos que omites se vuelven a agregar en el
orden estándar, por lo que un tema no puede ocultar accidentalmente
Ajustes y bloquear al usuario fuera de la recuperación.

## Imitar Otras Interfaces

Como los niveles son disjuntos, un tema puede imitar un paradigma de
interfaz completamente distinto:

- Un tema estilo consola cambia tokens y skins, haciendo que la barra, los
  paneles y los botones parezcan una interfaz de videojuego.
- Un tema de novela visual rediseña el área de visualización del chat, los
  mensajes y el encabezado del personaje mientras la lógica de chat
  permanece intacta.
- Un tema de app móvil usa el diseño declarativo del shell para reordenar la
  barra y los paneles.

Ninguno de estos requiere tocar la lógica de chat, los datos ni el
comportamiento de los plugins — que es exactamente la razón por la que la
superficie del tema puede reemplazarse por completo. Lo único que v1 no
proporciona es la reordenación libre de las áreas del shell; las ranuras se
estilizan y se llenan, no se mueven. Consulta [Contrato del shell](shell-contract.md)
para saber qué está en el alcance.
