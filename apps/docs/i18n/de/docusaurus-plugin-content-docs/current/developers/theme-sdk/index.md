---
title: Theme-SDK-Übersicht
description: 'Was das Theme SDK ist: ein vollständiger visueller Shell-Ersatz, Ebene für Ebene.'
sidebar_position: 1
---

Das Theme SDK ist der versionierte Vertrag für den Ersatz der gesamten
visuellen Shell von NeoTavern — nicht nur für eine Neufärbung.

## Was das Theme SDK ist

Ein Theme ist ein Paket (`.sttheme`), das steuert, wie die Anwendung
aussieht und wie ihre Hauptbereiche zusammengesetzt sind. Anders als ein
Plugin hat ein Theme kein JavaScript: Es ist CSS, semantische Tokens und
ein deklaratives Shell-Layout in einem Manifest. Weil das SDK deklarativ
ist, kann ein Theme weder das Verhalten der Anwendung brechen noch ihre
Daten erreichen.

Das Paket `@neotavern/theme-sdk` liefert den Vertrag selbst: die kanonischen
Token-Namen, Manifest-Validierung, Vererbungsauflösung und
CSS-Variablen-Generierung. Die Referenzimplementierung des Hosts wendet
ein Theme an, indem sie `--st-*`-Custom-Properties auf die Dokumentwurzel
schreibt und die Stylesheets des Themes in einer definierten Reihenfolge
lädt.

## Die drei Ebenen

Theming ist in drei Ebenen strukturiert, und ein Theme kann jede von ihnen
nutzen:

1. **Design-Tokens** — semantische Variablen für Farben, Schriftarten,
   Abstände, Radien, Schatten, Z-Index-Ebenen, Bewegung und
   Steuerelementgrößen. Komponenten referenzieren ausschließlich diese
   Tokens, sodass das Überschreiben eines Tokens die gesamte Oberfläche
   konsistent umgestaltet.
2. **Komponenten-Skin** — CSS, das Komponenten über stabile
   `data-component`-, `data-part`-, `data-role`- und `data-state`-Hooks
   umgestaltet.
3. **Shell-Layout** — deklarative Komposition der Hauptbereiche: die
   Navigationsleiste, Verwaltungspanels und der Chat-Arbeitsbereich.

Da Chat-Logik, Datenmodell und Verhalten unberührt bleiben, kann ein Theme
ein Betriebssystem, eine Spielkonsole, eine Visual-Novel-Oberfläche oder
ein Mobile-App-Layout nachahmen, ohne eine Funktion zu brechen. Details
unter [Ebenen](levels.md).

## Erstellen ohne Build-Schritt

Ein Theme ist ein ZIP mit `theme.json`, `components.css` und `shell.css`.
Sie können eines von Hand bauen:

1. Öffnen Sie den Themes-Manager und laden Sie das Theme-Starterset
   herunter.
2. Entpacken Sie es und bearbeiten Sie `theme.json`, `components.css` und
   `shell.css`.
3. Zippen Sie die Dateien an der Archivwurzel neu und installieren Sie das
   Paket.
4. Prüfen Sie Hell- und Dunkelmodus, Mobilgeräte, Tastaturfokus, RTL und
   den Sicheren Modus, dann wenden Sie das Theme an.

Für ein erstes Theme sind kein Node.js, kein npm, kein JavaScript und keine
Theme-SDK-CLI erforderlich.

## Installation und Aktivierung

Die Installation eines Pakets aktiviert es nicht. Die Aktivierung validiert
die gesamte `extends`-Kette auf fehlende Eltern und Zyklen und aktualisiert
dann das aktivierte Theme und die gespeicherte Theme-Auswahl in einer
Transaktion. Das Aktualisieren eines Pakets mit derselben ID ersetzt sein
Verzeichnis atomar und behält den aktuellen Aktivierungszustand; bei einem
Registry-Fehler wird das vorherige Verzeichnis wiederhergestellt.

Die Distribution bringt eine Reihe integrierter Themes mit, wie AMOLED,
GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin
Mocha, Solarized Dark und One Dark, sodass der Themes-Manager nie leer
öffnet.

## Sicherheit

Themes können Chats, API-Schlüssel oder das Dateisystem nicht lesen und
enthalten keinen ausführbaren Code. Jedes Stylesheet wird auf verbotene
Konstrukte gescannt, und der Sichere Modus deaktiviert
Drittanbieter-Themes vollständig. Die Garantien finden Sie unter
[Sicherer Modus](safe-mode.md) und die vollständige API in der generierten
[Theme-SDK-Referenz](../api/theme-sdk/).

## Nächste Schritte

- [Ebenen](levels.md) — Tokens, Skins und Shell-Layouts.
- [Design-Tokens](design-tokens.md) — der semantische Token-Vertrag.
- [Komponenten-Skin](component-skin.md) — der Styling-Stack und die Hooks.
- [Shell-Vertrag](shell-contract.md) — benannte Bereiche und stabile Slots.
- [Sicherer Modus](safe-mode.md) — Wiederherstellung nach defekten Themes.
