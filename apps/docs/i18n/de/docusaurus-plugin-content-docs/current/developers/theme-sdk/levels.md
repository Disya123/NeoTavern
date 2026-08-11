---
title: Theme-Ebenen
description: Die drei Ebenen des Theming — Tokens, Komponenten-Skin und Shell-Layout.
sidebar_position: 2
---

Ein Theme besteht aus drei unabhängigen Ebenen. Die Aufteilung zu
verstehen, ist das, was ein Theme befähigt, das Aussehen der gesamten
Anwendung zu ändern, ohne ihr Verhalten zu berühren.

## Ebene 1: Design-Tokens

Tokens sind semantische CSS-Custom-Properties mit dem Präfix `--st-`. Sie
decken Farben, Typografie, Abstände, Radien, Rahmen, Schatten,
Z-Index-Ebenen, Bewegung, Steuerelementgrößen, Scrollbalken und die
Chat-Fläche ab.

Komponenten referenzieren nur Tokens — sie kodieren nie einen Farb-,
Schrift- oder Abstandswert fest. Das Überschreiben eines Tokens im
Theme-Manifest gestaltet jede Komponente um, die es verwendet:

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

Tokens werden über eine Vererbungskette aufgelöst: integrierte
Standardwerte für den Modus, dann Eltern-Themes, dann das Theme selbst. Ein
Dunkelmodus fällt auf die Hell-Tokens des Themes zurück, wenn keine
Dunkel-Überschreibung existiert. Den vollständigen Vertrag finden Sie unter
[Design-Tokens](design-tokens.md).

## Ebene 2: Komponenten-Skin

Der Komponenten-Skin ist CSS, das die integrierten Komponenten über
stabile Hooks umgestaltet. Der Host veröffentlicht
`data-component`-, `data-part`-, `data-role`- und `data-state`-Attribute;
ein Theme gestaltet diese Attribute, nie generierte
CSS-Modul-Klassennamen:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

Der Skin wird über Kaskadenebenen in einer festen Reihenfolge angewendet,
wobei die Benutzer-Überschreibungsebene zuletzt kommt. `!important` ist in
Theme-CSS verboten, außer in der Ebene für
Barrierefreiheitspräferenzen. Die Ebenenreihenfolge und die
Hook-Referenz finden Sie unter [Komponenten-Skin](component-skin.md).

## Ebene 3: Shell-Layout

Das Shell-Layout ist die Komposition der Hauptbereiche: die
Navigationsleiste, die Verwaltungspanels und der Chat-Arbeitsbereich. Es
ist deklarativ, in `theme.json` ausgedrückt — nie in JavaScript:

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

Gültige Leisten-Einträge sind `chats`, `characters`, `personas`,
`lorebooks`, `backgrounds`, `ai-settings`, `plugins`, `settings` und das
optionale `menu-toggle`. Die Gruppe `main` fließt von oben; `bottom` ist an
die Unterkante geheftet. Einträge, die Sie weglassen, werden in der
Standardreihenfolge wieder hinzugefügt, sodass ein Theme Einstellungen
nicht versehentlich ausblenden und den Benutzer von der Wiederherstellung
aussperren kann.

## Andere Oberflächen nachahmen

Weil die Ebenen getrennt sind, kann ein Theme ein völlig anderes
Oberflächenparadigma nachahmen:

- Ein Konsolen-Theme ändert Tokens und Skins und lässt Leiste, Panels und
  Schaltflächen wie eine Spieloberfläche aussehen.
- Ein Visual-Novel-Theme gestaltet das Chat-Ansichtsfenster, Nachrichten
  und den Charakterkopf um, während die Chat-Logik intakt bleibt.
- Ein Mobile-App-Theme nutzt das deklarative Shell-Layout, um Leiste und
  Panels neu zu ordnen.

Keines davon erfordert, Chat-Logik, Daten oder Plugin-Verhalten zu
berühren — genau deshalb kann die Theme-Oberfläche vollständig ersetzt
werden. Das Einzige, was v1 nicht bietet, ist die freie Neuanordnung von
Shell-Bereichen; Slots werden gestaltet und befüllt, nicht verschoben.
Was im Rahmen liegt, finden Sie unter [Shell-Vertrag](shell-contract.md).
