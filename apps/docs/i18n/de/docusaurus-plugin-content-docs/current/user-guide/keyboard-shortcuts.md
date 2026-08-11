---
title: Tastenkürzel
description: Die Standard-Tastenkürzel in NeoTavern auf einen Blick.
sidebar_position: 11
---

Diese Seite listet die Standard-Tastenkürzel in NeoTavern. Die gesamte App
ist über die Tastatur bedienbar, und jedes Modal hält den Fokus in sich, bis
Sie es schließen.

## Eingabefeld

| Aktion                          | Tastenkürzel                                            |
| ------------------------------- | ------------------------------------------------------- |
| Nachricht senden                | `Enter`                                                 |
| Neue Zeile einfügen             | `Shift+Enter`                                           |
| Chat-Suche öffnen               | Suchfeld im Chat-Kopfbereich fokussieren                |
| Zur neuesten Nachricht scrollen | Aktion „neue Nachricht" nach dem Hochscrollen verwenden |

Der Hinweis im Eingabefeld zeigt immer den aktuellen Modus, sodass Sie auf
einen Blick sehen, ob `Enter` sendet oder eine Zeile einfügt.

## Nachrichten bearbeiten

| Aktion                | Tastenkürzel                                          |
| --------------------- | ----------------------------------------------------- |
| Bearbeitung speichern | `Ctrl+Enter` (Windows/Linux) oder `Cmd+Enter` (macOS) |
| Bearbeitung abbrechen | `Escape`                                              |

Bearbeiten ist nicht destruktiv: Der vorherige Inhalt wird im
Bearbeitungsverlauf der Nachricht archiviert, und ein Konflikt behält Ihren
Entwurf, statt ihn zu überschreiben. Siehe [Chatten](chat).

## Navigation und Panels

| Aktion                                     | Tastenkürzel                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Oberstes Panel, Dialog oder Menü schließen | `Escape`                                                                    |
| Fokus vorwärts / rückwärts bewegen         | `Tab` / `Shift+Tab`                                                         |
| Routenbezogene Oberfläche schließen        | Zurück im Browser                                                           |
| Größenveränderbares Panel anpassen         | `ArrowLeft` / `ArrowRight`, während der Größenänderungsgriff fokussiert ist |
| Navigationsmenü öffnen und schließen       | Der Umschaltknopf der Leiste                                                |

`Escape` schließt zuerst die oberste Oberfläche: Ein verschachtelter Dialog
schließt vor dem Panel dahinter, und der Fokus kehrt zum Steuerelement
zurück, das ihn geöffnet hat.

## Chat-Aktionen

| Aktion                                               | Tastenkürzel                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Zwischen Swipe-Varianten wechseln                    | Zurück- / Weiter-Pfeile in der `N/M`-Anzeige                                 |
| Checkpoint-Snapshot öffnen                           | Klick auf die Checkpoint-Markierung (oder `Shift+Click` für einen neuen)     |
| Nachricht manuell ausschließen oder wiederherstellen | Die Ausschließen-Aktion in der Nachrichtenleiste (manuelle Kontextstrategie) |

Nachrichtenaktionen sind auf dem Desktop immer sichtbar und auf Mobilgeräten
in der kompakten Nachrichtenkarte gruppiert; jede Aktion ist ein
fokussierbares Steuerelement, sodass keine Aktion Hover oder einen Zeiger
erfordert.

## Plugin-Tastenkürzel

Plugins registrieren ihre Tastenkürzel über das Plugin SDK, das Konflikte
auflöst: Die neueste aktive Registrierung gewinnt und gibt die Bindung
frei, wenn das Plugin deaktiviert wird. Plugin-Kürzel fangen nie die
System-Browser-Kombinationen ab, und die Befehlspalette listet das
Tastenkürzel jedes Befehls im Kontext. Siehe
[Erweiterungen & Plugins](extensions).
