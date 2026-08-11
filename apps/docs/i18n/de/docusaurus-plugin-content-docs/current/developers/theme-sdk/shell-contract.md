---
title: Shell-Vertrag
description: Die benannten Shell-Bereiche, die Themes gestalten und Plugins befüllen.
sidebar_position: 5
---

Der Shell-Vertrag definiert die benannten Bereiche der Anwendung. Themes
gestalten diese Bereiche; Plugins fügen ihnen über stabile Slots Inhalt
hinzu.

## Benannte Shell-Bereiche

Der Host veröffentlicht jeden Hauptbereich mit einem stabilen
Slot-Attribut:

| Slot                 | Bereich                                              |
| -------------------- | ---------------------------------------------------- |
| `app.shell`          | Die Wurzel der Anwendungs-Shell                      |
| `navigation.primary` | Die Navigationsleiste                                |
| `chat.header`        | Der Chat-Kopfbereich                                 |
| `chat.viewport`      | Das scrollbare Chat-Ansichtsfenster                  |
| `chat.composer`      | Das Nachrichten-Eingabefeld                          |
| `character.browser`  | Die Wurzel des Charakterbrowsers                     |
| `panel.left`         | Das linke Kontextpanel                               |
| `status.area`        | Der Verbindungsstatus-Bereich                        |
| `modal.layer`        | Die Modal-Ebene (Plugins unter der Systemoberfläche) |
| `notification.layer` | Die Benachrichtigungsebene                           |

Zwei Slots sind reserviert, aber nicht Teil von v1:
`navigation.secondary` und `panel.right`.

## Was der Vertrag erlaubt

Ein Theme kann:

- **Jeden benannten Bereich** über sein `data-slot`-Attribut und die
  Komponenten-Hooks darin gestalten.
- **Die Hauptbereiche anordnen** über das deklarative `shellLayout` im
  Manifest — derzeit die Navigationsleisten-Reihenfolge (Gruppen `main`
  und `bottom`) und die Platzierung von Verwaltungstabs (`pinned`).
- **Den Chat-Flächen-Hintergrund ersetzen** über die
  `chat-wallpaper-*`-Tokens.

Die freie Neuanordnung von Bereichen — zum Beispiel das Verschieben der
Leiste auf die rechte Seite — ist nicht Teil von v1. Slots werden gestaltet
und befüllt, nicht verlegt.

## Wie Plugins Inhalt hinzufügen

Plugins erhalten die SDK-Registrierungs-APIs, und der Host platziert ihren
Inhalt in den stabilen Slots. Ein Seitenleisten-Panel, das mit
`slot: 'left'` registriert ist, rendert zum Beispiel innerhalb von
`panel.left`, und Plugin-Dialoge stapeln sich innerhalb von `modal.layer`
unter der Systemoberfläche.

Der Vertrag, der aus dieser Aufteilung folgt:

- Themes hängen nie vom internen DOM eines Plugins ab.
- Plugins hängen nie von der internen React-Hierarchie oder von
  spezifischen generierten Klassennamen ab.
- Beide Seiten treffen sich nur an den benannten Slots und den
  Hook-Attributen.

## Stabile Hooks innerhalb der Bereiche

Innerhalb der Bereiche veröffentlichen Komponenten die Standard-Hook-
Attribute. Bemerkenswerte Beispiele:

- Die Wurzel des Eingabefelds veröffentlicht
  `data-slot="chat.composer"`, mit einem Toolbar-Teil, einem Feldteil und
  einer `data-component="textarea"`-Eingabe.
- Schaltflächen veröffentlichen `data-component="button"` mit
  `data-part="icon"` und `data-part="label"`; verwandte Aktionen leben in
  einer Aktionsleiste (`data-component="action-bar"`) mit primären und
  sekundären Gruppen.
- Tabs veröffentlichen `data-component="tabs"` mit `list`-, `trigger`- und
  `content`-Teilen; die Verwaltungspanels verwenden die
  Segment-Variante.
- Nachrichten veröffentlichen `data-component="chat-message"` mit
  `data-role="user|assistant|system|tool"` und Zuständen wie `streaming`.
- Die Navigationsleiste veröffentlicht `data-component="navigation-rail"`
  mit `data-part="main-items"`, `data-part="bottom-items"` und
  `data-item="<id>"` pro Eintrag, plus
  `data-state="expanded|collapsed"`.
- Alle Leisten-Panels teilen einen Kopf-Chrome
  (`data-component="sidebar-panel-header"`), sodass ein Theme sie einmal
  gestaltet.

## Layout-Verantwortlichkeiten

Der Host besitzt verhaltenskritisches Layout: Fokus-Fangen, logische
RTL-Richtung, Safe-Area-Insets und minimale interaktive Zielgrößen. Ein
Shell-Theme darf das Aussehen und die Anordnung von Bereichen ändern, muss
aber die DOM-Reihenfolge erhalten, wo dokumentiert, das horizontale Scrollen
von Aktionslisten und das Tastaturverhalten. Breakpoints sind im SDK
registriert (`VIEWPORT_BREAKPOINTS` für Ansichtsfensterbreiten in px,
`CONTAINER_BREAKPOINTS` für Containergrößen in rem), und Feature-Queries
wie `prefers-reduced-motion` sind keine Layout-Breakpoints.

Die Stilebene, die diese Bereiche bekleidet, finden Sie unter
[Komponenten-Skin](component-skin.md); für die Wiederherstellung bei einer
defekten Shell siehe [Sicherer Modus](safe-mode.md).
