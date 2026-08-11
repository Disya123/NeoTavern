---
title: Komponenten-Skin
description: Der Styling-Stack für Theme-Skins, von Kaskadenebenen bis zu stabilen Hooks.
sidebar_position: 4
---

Die Komponenten-Skin-Ebene gestaltet die integrierten Komponenten um. Sie
baut auf einem spezifischen Styling-Stack und einem stabilen
Hook-Vertrag auf.

## Der Styling-Stack

Die integrierte Oberfläche verwendet vier Technologien gemeinsam:

- **CSS-Module** für komponentenbezogene Stile, mit gehashten
  Klassennamen, die explizit kein öffentlicher Vertrag sind.
- **CSS-Custom-Properties** für die semantischen Tokens (`--st-*`).
- **Kaskadenebenen** zur Ordnung der Wahrheitsquellen.
- **Container-Queries** für Layouts, die sich an den eigenen Container der
  Komponente anpassen, mit Größen in `rem`.

Themes zielen auf die Hook-Attribute, nie auf die generierten Klassennamen.

## Kaskadenebenen-Reihenfolge

Alle Stile leben in einer festen Kaskadenebenen-Reihenfolge:

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Spätere Ebenen gewinnen über frühere, sodass die Präzedenz ist:

1. `reset` — der Basis-Reset.
2. `tokens` — die Token-Definitionen.
3. `base` — Standardwerte auf Elementebene.
4. `components` — die integrierten Komponentenstile.
5. `plugin-base` — eine Ebene für vom Plugin bereitgestellte Basisstile.
6. `theme` — der Skin des aktiven Themes.
7. `user` — die eigenen Überschreibungen des Benutzers, die zuletzt laden.

Das Benutzer-Überschreibungs-Stylesheet lädt immer zuletzt, sodass ein
defektes oder eigenwilliges Theme den Benutzer nie daran hindern kann, es
zu überschreiben. In `!important`-Begriffen: Das Konstrukt ist in
Theme-CSS verboten, außer in der Ebene für
Barrierefreiheitspräferenzen, die zu den benutzerorientierten
A11y-Modi gehört.

## Der Hook-Vertrag

Themes gestalten Komponenten über vier Attribute, die der Host
veröffentlicht und die wie der Rest des SDKs versioniert sind:

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — die Komponentenart.
- `data-part` — der strukturelle Teil innerhalb einer Komponente.
- `data-role` — eine semantische Rolle, wie eine Nachrichtenrolle.
- `data-state` — ein Zustand wie `open`, `closed` oder `streaming`.

Das Skin-CSS eines Themes sieht dann so aus:

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

Das Paket `@neotavern/theme-sdk` exportiert den Helfer `dataHook` zum Bauen
dieser Attributobjekte, sodass Komponentenautoren und Theme-Autoren
dieselben Namen verwenden.

## Was kein Vertrag ist

- **Generierte CSS-Modul-Klassennamen** — gehasht, instabil und nicht Teil
  des SDKs. Ein Theme, das sie anspricht, bricht beim nächsten Build.
- **Die interne React-Hierarchie** — Themes dürfen nicht von
  Komponenten-Interna oder der DOM-Reihenfolge über die dokumentierten
  Hooks hinaus abhängen.
- **Numerische Layout-Werte** — Koordinaten, Grid-Schemata und Breakpoints
  sind nicht über den Token-Vertrag gestaltbar;
  Ansichtsfenster-Breakpoints leben im Registry, und Container-Queries
  müssen in `rem` geschrieben werden.

## Verbotenes CSS

Theme-Stylesheets werden gescannt, bevor sie laden. Die verbotenen
Konstrukte werden bei Installation und Validierung abgelehnt:

- `@import`
- `javascript:`-URLs und `expression()`.
- `-moz-binding` und `behavior:`.
- Remote- oder protokollrelative URLs (`url(http:`, `url(https:`,
  `url(//`).
- `data:text/html`.
- `!important` (außer der A11y-Präferenzen-Ebene).

Das hält Theme-CSS rein, lokal und sicher. Für die Tokens, die der Skin
referenzieren sollte, siehe [Design-Tokens](design-tokens.md); für die
benannten Bereiche, die ein Skin umgestalten kann, siehe
[Shell-Vertrag](shell-contract.md).
