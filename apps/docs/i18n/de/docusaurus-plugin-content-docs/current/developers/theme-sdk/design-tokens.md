---
title: Design-Tokens
description: Der semantische Design-Token-Vertrag und was Komponenten nicht festkodieren dürfen.
sidebar_position: 3
---

Design-Tokens sind die semantischen Variablen, die alle visuellen Werte in
der Anwendung tragen. Komponenten referenzieren sie; Themes überschreiben
sie; nichts ist festkodiert.

## Der Token-Vertrag

Jedes Token ist eine CSS-Custom-Property mit dem Präfix `--st-`, und jeder
Token-Name ist Teil des versionierten Vertrags in `@neotavern/theme-sdk`. Der
Host liefert Standardwerte für Hell- und Dunkelmodus, sodass jedes Token
immer aufgelöst wird, auch wenn ein Theme keines definiert.

Die kanonischen Token-Gruppen sind:

- **Textfarben** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Oberflächen** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Akzent und Status** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Chat-Nachrichten-Markdown** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Typografie** — `font-ui`, `font-mono`, `font-size-2xs` bis
  `font-size-2xl`, `line-height-body`, `font-weight-normal` bis
  `font-weight-bold`.
- **Abstände** — `space-2xs` bis `space-3xl`.
- **Radien und Rahmen** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **Elevation** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Ebenen (Z-Index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Bewegung** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Steuerelementgrößen** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Panel- und Inhaltsgrößen** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Ansichtsfenster-Limits** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **Scrollbalken** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **App-Shell-Größen** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **Chat-Fläche** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Chat-Typografie-Metriken** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **Benutzerverstellbare Regler** — `custom-glass-blur`, `custom-ui-opacity`.

## Tokens überschreiben

Ein Theme überschreibt eine beliebige Teilmenge der Namen. Werte werden
validiert: Sie müssen sichere, nicht leere CSS-Werte sein, und Konstrukte
wie `{`, `}` und `;` werden abgelehnt.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

Wenn der Benutzer einen Chat-Hintergrund wählt, setzt die Anwendung eine
bereichsgebundene Custom-Property für das Wallpaper-Bild auf der
Arbeitsbereich-Wurzel; Position, Größe, Overlay und Unschärfe bleiben die
Tokens des Themes.

## Auflösungsregeln

Tokens werden in dieser Reihenfolge aufgelöst, wobei spätere gewinnen:

1. Integrierte Standardwerte für den aktiven Modus.
2. Die Eltern-Theme-Kette, Wurzel zuerst.
3. Das Theme selbst.

Der Dunkelmodus fällt auf die Hell-Tokens des Themes zurück, wenn keine
Dunkel-Überschreibung existiert, sodass ein nur-helles Theme auch im
Dunkelmodus funktioniert. Die Funktionen `resolveTokens` und
`buildThemeVariables` in `@neotavern/theme-sdk` implementieren das, und der Host
schreibt das Ergebnis als CSS-Variablen auf `document.documentElement`.

## Was Komponenten nicht festkodieren dürfen

Der Stilvertrag verbietet festkodierte Werte überall in der integrierten
Oberfläche, und dieselben Regeln gelten für das, worauf ein Theme sich
nicht verlassen darf:

- Numerisches `font-weight`, `font-size` in px und rohes `border-radius` in
  px.
- Numerische `z-index`-Werte — verwenden Sie die `layer-*`-Tokens.
- Steuerelementgrößen wie `40px`, `44px`, `52px`, `32px` und `36px`.
- `!important` in Theme-CSS, außer in der Ebene für
  Barrierefreiheitspräferenzen.
- Layout-Regeln: Koordinaten, Grid- und Flex-Schemata, Breakpoints und
  Bereichsreihenfolge sind nicht Teil des Token-Vertrags. Breakpoints
  kommen aus dem Registry (`VIEWPORT_BREAKPOINTS` und
  `CONTAINER_BREAKPOINTS`), und das Verschieben von Shell-Bereichen liegt
  außerhalb des Rahmens von v1.

Inhaltsgeometrie wie das Grid-Schema von Kartenlisten ist eine explizite
Ausnahme: Sie wird nicht vom Token-Vertrag abgedeckt. Alles, was ein Theme
zum Umgestalten braucht, ist über Tokens, Hooks und das deklarative
Shell-Layout verfügbar. Die generierte
[Theme-SDK-Referenz](../../api/theme-sdk/) dokumentiert die exakte
`TokenName`-Liste.
