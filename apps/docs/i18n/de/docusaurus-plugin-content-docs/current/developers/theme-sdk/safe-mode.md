---
title: Sicherer Modus
description: Wie der Sichere Modus Drittanbieter-Themes und -Plugins deaktiviert und warum Reset immer funktioniert.
sidebar_position: 6
---

Der Sichere Modus ist der Wiederherstellungsmechanismus für die visuelle
Ebene: Er deaktiviert Drittanbieter-Themes und -Plugins, sodass die
Oberfläche immer in einen funktionierenden Zustand zurückkehrt.

## Was der Sichere Modus tut

Der Sichere Modus wird mit `?safe=1` in der URL aktiviert. Er wird
behandelt, bevor Paketcode geladen wird:

- CSS und Token-Überschreibungen von Drittanbieter-Themes werden dem
  Dokument nicht hinzugefügt.
- Einstiegspunkte von Drittanbieter-Plugins laufen nie, einschließlich
  Legacy-Einstiegspunkten.
- Das integrierte Theme und die integrierte Plugin-Laufzeit bleiben aktiv.

Die Oberfläche fällt auf die integrierten Hell- und Dunkel-Tokens zurück,
die immer vorhanden sind. Das Verlassen des Sicheren Modus stellt den
zuvor gespeicherten aktiven Theme- und Plugin-Zustand wieder her — das
Verlassen ändert Ihre Auswahl nicht.

## Warum ein defektes Theme die Wiederherstellung nicht blockieren kann

Mehrere Garantien schützen den Benutzer vor einem defekten Theme:

- **Vorschau vor dem Anwenden** — Themes werden vor der Aktivierung
  vorgeschaut, und die Installation eines Pakets aktiviert es nie
  automatisch.
- **Der Sichere Modus ist vor den Paketen** — `?safe=1` wird verarbeitet,
  bevor das Theme-Registry konsultiert wird, sodass selbst ein Theme, dessen
  CSS den Renderer zum Absturz bringt, nie geladen wird.
- **Die Reset-Schaltfläche** — die Reset-Aktion gibt das integrierte Theme
  zurück, entfernt Laufzeit-CSS-Links und löscht Inline-`--st-*`-Überschrei-
  bungen. Das Löschen des aktiven Themes setzt auch die gespeicherte
  Theme-Auswahl zurück.
- **Themes können Einstellungen nicht ausblenden** — die Navigationsleiste
  hält den Eintrag Einstellungen immer erreichbar, weil weggelassene
  Systemeinträge in der Standardreihenfolge wiederhergestellt werden. Im
  Sicheren Modus wird die integrierte Leistenreihenfolge verwendet, und der
  Menü-Umschalter bleibt verfügbar.
- **Keine Codeausführung** — Themes enthalten überhaupt kein JavaScript.
  Sie sind CSS, Tokens und deklaratives Layout, sodass es keinen Theme-Code
  gibt, der vor dem Wirksamwerden des Sicheren Modus laufen könnte.

## Theme-Paket-Einschränkungen

Ein Theme-Paket erhält nie Zugriff auf Chats, API-Schlüssel oder das
Dateisystem. Seine Stylesheets werden gegen verbotene Konstrukte
(`@import`, Remote-URLs, `javascript:`-URLs, `expression()`,
`!important` und andere) validiert, bevor sie akzeptiert werden, und seine
Tokens müssen sichere CSS-Werte sein. Es gibt keinen ausführbaren
Einstiegspunkt im Theme SDK.

## Sicherer Modus für Plugins

Derselbe Schalter deaktiviert Drittanbieter-Plugins. Plugin-Sandboxen,
Prozessisolierung und Host-erzwungene Bereinigung sind die
Laufzeitebene; der Sichere Modus ist der Doppelsicherungs-Schalter, der
verhindert, dass nicht vertrauenswürdiger Code überhaupt geladen wird. Die
Plugin-Seite finden Sie unter
[Plugin-Sandboxing](../plugin-sdk/sandboxing.md).

## Den Sicheren Modus programmatisch prüfen

Das Paket `@neotavern/theme-sdk` exportiert `getSafeModeFromSearch(search)`, das
die URL-Suchzeichenkette parst und zurückgibt, ob `?safe=1` vorhanden ist.
Der Host verwendet es als das einzige Tor vor dem Laden von Paket-CSS und
Token-Überschreibungen, und dieselbe Funktion steht alternativen Hosts zur
Verfügung.

Die Shell-Bereiche, die im Sicheren Modus verfügbar bleiben, finden Sie
unter [Shell-Vertrag](shell-contract.md).
