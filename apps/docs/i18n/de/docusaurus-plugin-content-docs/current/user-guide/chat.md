---
title: Chatten
description: Wie das Chatten in NeoTavern funktioniert — Streaming, Swipes, Regenerieren, Bearbeiten und Stoppen.
sidebar_position: 2
---

Diese Seite behandelt die Chat-Ansicht: Nachrichten verfassen und senden,
zusehen, wie Antworten gestreamt werden, und mit den
Nachrichtenaktionen arbeiten, die NeoTavern bereitstellt.

## Nachrichten senden

Das Eingabefeld sitzt unten in der Chat-Fläche. Tippen Sie eine Nachricht und
drücken Sie `Enter` zum Senden; `Shift+Enter` fügt eine neue Zeile ein. Ihre
Nachricht erscheint sofort, und die Antwort wird in Batches von höchstens 30
UI-Updates pro Sekunde in die Ansicht gestreamt. Sie können während eines
Streams im Verlauf blättern — Auto-Scroll folgt Ihnen nur, solange Sie unten
bleiben, und eine Aktion „neue Nachricht" erscheint, nachdem Sie manuell nach
oben gescrollt haben.

Während eine Antwort generiert wird, wird die Hauptschaltfläche des
Eingabefelds zu **Stoppen**. Das Stoppen behält den bisher empfangenen Text
als explizit als unvollständig markierte Antwort. Eine unterbrochene
Verbindung bietet eine erneute Verbindung an und erzeugt nie eine doppelte
Nachricht.

Ihr Entwurf wird pro Chat gespeichert, sodass ein Wechsel hin und zurück nie
das verliert, was Sie gerade getippt haben.

## Swipes (alternative Antworten)

Jede Assistenznachricht kann mehrere alternative Antworten enthalten, die
Swipes genannt werden. Ein Blättersteuerelement unter der Nachricht zeigt die
Anzahl als `N/M` mit Pfeilen für Zurück und Weiter; Klicken auf die Pfeile
wechselt durch die Varianten, ohne dass eine verloren geht. Die
Swipe-Historie wird erhalten und ist nicht destruktiv.

## Regenerieren

Die Regenerieren-Aktion schreibt die **letzte** Assistenznachricht in place
neu: Eine neue Antwort wird in die vorhandene Sprechblase gestreamt, und der
vorherige Text wird zu einer weiteren Variante im Swipe-Blättersteuerelement.
Wenn die Generierung fehlschlägt oder gestoppt wird, bleibt der alte Text
unverändert auf der Festplatte.

## Nachrichten bearbeiten

Öffnen Sie die Bearbeiten-Aktion an einer Nachricht, um ihren Text zu
ändern. Der Inline-Editor speichert mit `Ctrl+Enter` (bzw. `Cmd+Enter` unter
macOS) und bricht mit `Escape` ab. Bearbeitungen sind nicht destruktiv: Der
vorherige Inhalt wird im Bearbeitungsverlauf der Nachricht archiviert, von
wo aus Sie ihn jederzeit wiederherstellen können. Wenn die Nachricht während
Ihrer Bearbeitung an anderer Stelle geändert wurde, behält der Editor Ihren
Entwurf und zeigt einen Konflikthinweis, statt stillschweigend zu
überschreiben.

## Nachrichtenaktionen

Die Aktionsleiste an jeder Nachricht ist immer sichtbar, nicht erst bei
Hover:

- Kopieren Sie den rohen Nachrichtentext.
- Bearbeiten Sie die Nachricht.
- Regenerieren Sie die letzte Assistenzantwort.
- Blättern Sie durch Varianten (Swipe).
- Erstellen Sie einen **Checkpoint** oder **Branch**: einen Snapshot des
  Chats, eingefroren an dieser Nachricht und in einen untergeordneten Chat
  kopiert. Nutzen Sie Checkpoints, um Handlungsstränge zu erkunden, ohne die
  Hauptkonversation anzufassen.
- Löschen Sie die Nachricht. Das Löschen versetzt Chats in einen
  Papierkorb-Zustand, statt sie sofort zu vernichten.

Plugins können eigene Aktionen zur selben Leiste hinzufügen, vorbehaltlich
der Berechtigungen, die Sie ihnen erteilt haben. Siehe
[Erweiterungen](extensions).

## Tastatursteuerung

Der gesamte Chat-Ablauf funktioniert über die Tastatur: `Tab` und `Shift+Tab`
bewegen den Fokus, `Escape` schließt das oberste Panel oder den obersten
Dialog, und das Swipe-Blättersteuerelement, Checkpoint-Links und
Nachrichtenaktionen sind alle fokussierbare Steuerelemente. Die vollständige
Liste finden Sie unter [Tastenkürzel](keyboard-shortcuts).
