---
title: Gedächtnis & Abruf
description: Gesprächsgedächtnis, Gedächtniseinträge, Vektorabruf und RAG in NeoTavern.
sidebar_position: 6
---

Diese Seite erklärt die Gedächtnisfunktionen, die dem Modell helfen, sich
über lange Gespräche hinweg zu erinnern: das rollierende
Gesprächsgedächtnis, schlüsselwortaktivierte Gedächtniseinträge und den
Vektorabruf.

## Gesprächsgedächtnis

Jeder Chat führt eine rollierende Zusammenfassung, die die Pipeline pflegt,
während das Gespräch wächst. Wenn die Kontext-Shifting-Strategie `summarize`
aktiv ist, wird die älteste ausgeschlossene Historie zu einer lokalen
extraktiven Zusammenfassung verdichtet, die vor die aktuelle Benutzereingabe
eingefügt wird — so behält das Modell den Kern früherer Ereignisse, auch
nachdem die rohen Nachrichten das Token-Budget verlassen haben. Die
Zusammenfassung wird mit dem Chat gespeichert und übersteht Neuladungen.

Sie können vor dem Senden exakt sehen, was der aktuelle Prompt enthält: Eine
Live-Kontextvorschau zeigt den ausgewählten Tokenizer, das Kontextlimit und
den reservierten Antwortbereich, ausgeschlossene Blöcke, zusammengefasste
Blöcke und die angewandte Strategie. Den Strategiewähler finden Sie unter
[Einstellungen](settings).

## Gedächtniseinträge

Gedächtniseinträge sind langlebige Wissensfragmente, die über Chats hinweg
bestehen bleiben, unabhängig von einer einzelnen Konversation. Jeder Eintrag
hat:

- **Gültigkeitsbereich** — `global` oder an einen Charakter gebunden.
- **Aktivierungsschlüsselwörter** — eine
  Groß-/Kleinschreibung-unabhängige Teilstring-Übereinstimmung mit dem
  Gesprächskontext.
- **Inhalt** — der Text, der eingefügt wird, wenn der Eintrag ausgelöst wird.

Das ist das klassische RAG-Muster: Der Abruf wird durch
Schlüsselwortübereinstimmung ausgelöst, und die eingefügten Fragmente decken
das Bedürfnis des Modells nach stabilen Fakten ab — Charakterdetails,
Weltregeln oder fortlaufende Handlungspunkte — ohne jeden Prompt aufzublähen.
Wie Lorebook-Einträge werden Gedächtnisblöcke in der Prompt-Pipeline nach
Relevanz eingestuft und zählen zum Token-Budget.

## Vektorabruf

Vektorabruf ist die Kontext-Shifting-Strategie `vector-recall`. Statt den
Kontext rein nach Alter zu kürzen, stuft sie Lorebook- und Gedächtnisblöcke
nach semantischer Relevanz für die aktuelle Eingabe ein und verwirft zuerst
die am wenigsten relevanten, dann kürzt sie ältere Historie. Das Ergebnis:
Das Modell behält das Material, das für die aktuelle Nachricht wichtig ist,
auch wenn es nicht das neueste ist.

Die Strategie wird pro Generierungseinstellung gewählt, und Plugins können
über das SDK weitere Strategien hinzufügen. Jede Strategie respektiert
weiterhin das endgültige, vom Host kontrollierte Token-Budget — Plugins
können es nicht umgehen.

## Eine Strategie wählen

Die verfügbaren Strategien sind `truncate` (älteste ungeschützte Gruppen
verwerfen), `summarize` (ausgeschlossene Historie verdichten),
`vector-recall` (Blöcke mit hoher Relevanz behalten, nach Relevanz und Alter
kürzen) und `manual` (bestimmte Nachrichten aus dem Prompt ausschließen,
ohne sie aus der Historie zu löschen). Der manuelle Modus bietet an jeder
Nachricht eine Aktion zum Ausschließen oder Wiederherstellen, und
Tool-Call/Tool-Result-Paare werden immer gemeinsam behandelt. Siehe
[Chatten](chat) für Steuerungselemente auf Nachrichtenebene und
[Lorebooks](lorebook) für das verwandte Schlüsselwort-Aktivierungsmodell.
