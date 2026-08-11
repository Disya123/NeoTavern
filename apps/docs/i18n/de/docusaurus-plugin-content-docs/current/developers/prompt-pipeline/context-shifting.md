---
title: Kontext-Shifting
description: >-
  Wie die Pipeline den zusammengesetzten Kontext in das Token-Budget
  einpasst, die Schritte vor der Anfrage und die Strategien truncate,
  summarize, vector-recall und manual.
sidebar_position: 5
---

Kontext-Shifting passt das zusammengesetzte Gespräch in das Token-Budget
des Modells ein, indem der am wenigsten wichtige Kontext entfernt oder
komprimiert wird, während alles erhalten bleibt, was bleiben muss.

## Schritte vor der Anfrage

Bevor eine Anfrage gesendet wird, folgt die Pipeline diesen Schritten:

1. Tokenizer-Profil und Kontextlimit des Modells bestimmen.
2. Platz für die Antwort reservieren.
3. System-Prompt, Charakter, erforderliche Lorebook-Einträge und
   angeheftete Nachrichten behalten.
4. Älteste nicht angeheftete Blöcke zuerst entfernen oder komprimieren.
5. Tool-Call- und Tool-Result-Nachrichten nur paarweise entfernen.
6. Token nach jeder Änderung neu zählen.
7. Dem Benutzer zeigen, was ausgeschlossen oder zusammengefasst wurde.

Wenn allein der geschützte Kontext das Budget überschreitet, endet die
Generierung mit dem stabilen `TOKEN_BUDGET_EXCEEDED`-Fehler, statt eine
überbudgetierte Anfrage an den Anbieter zu senden.

## Wie das Shifting funktioniert

`shiftContext(messages, countTokens, budget)` passt den Dialog an das
Token-Budget an. Es gibt drei Listen zurück:

- `kept` — die Nachrichten, die passen;
- `excluded` — die entfernten Nachrichten, dem Benutzer angezeigt;
- `truncated` — Blöcke, die komprimiert statt verworfen wurden.

Systemnachrichten und angeheftete Nachrichten sind immer geschützt. Die
ältesten nicht angehefteten Blöcke werden zuerst entfernt. Tool-Calls und
ihre Ergebnisse werden über `toolCallId`, `tool_call_id` oder `callId`
verknüpft und als eine Gruppe entfernt, auch wenn sie nicht benachbart
sind.

## Integrierte Strategien

Die Strategie wird durch die Einstellung `contextStrategy` gewählt und über
das `ContextStrategyRegistry` angewendet:

- **truncate** — entfernt die ältesten nicht angehefteten Gruppen.
- **summarize** — erstellt eine lokale extraktive Zusammenfassung der
  ausgeschlossenen Historie und hält sie vor der aktuellen Benutzereingabe.
- **vector-recall** — verwirft Lorebook- und Gedächtnisblöcke mit geringer
  Relevanz vor denen mit hoher Relevanz und kürzt dann alte Historie.
- **manual** — schließt zuerst Nachrichten aus, die mit
  `meta.manualExcluded: true` markiert sind (einschließlich ihrer
  gepaarten Tool-Calls und Tool-Results), und fährt dann mit normaler
  Reduktion fort, wenn mehr Platz benötigt wird.

## Plugins und das Budget

Plugins können zusätzliche Strategien registrieren; die Registrierung gibt
eine Bereinigungsfunktion zurück. Eine Plugin-Strategie kann das Budget
nicht umgehen:

- der Host stellt erforderliche Nachrichten wieder her und lehnt eine
  Strategie ab, die geschützten Kontext entfernt hat;
- der Host zählt das reale Budget unabhängig neu;
- Zählung und Shifting laufen vor den Plugin-Interceptors, und eine
  Pflicht-Neuzählung mit einem finalen Shifting läuft nach ihnen — ein
  Plugin kann nicht spät Nachrichten hinzufügen, um sich an der Grenze
  vorbeizuschummeln.

## Das Kontext-Audit

Jede Generierung erstellt ein `PromptContextAudit` vor dem Netzwerkaufruf
und schließt es mit einem terminalen Status ab: `completed`, `failed` oder
`cancelled`. Das Audit zeichnet auf:

- die Generierungs-ID, den Anbieter und das Modell;
- jeden Prompt-Block in tatsächlicher Reihenfolge, mit Tokenzahlen und dem
  stabilen Grund für Aufnahme oder Ausschluss;
- das Kontextlimit, die Antwortreserve und die endgültige
  Prompt-Token-Zahl;
- das Tokenizer-Profil und ob es Näherung ist;
- die endgültigen Anbieter-Nachrichten und die
  Plugin-Interceptor-Diagnosen;
- einen normalisierten Anbieter-Fehlercode, ohne Upstream-Antwortkörper.

Nur das letzte vollständige Audit pro Chat wird in der Datenbank
aufbewahrt; eine neue Anfrage ersetzt das alte atomar, und das Löschen des
Chats löscht das Audit. Die Oberfläche liest es über
`GET /api/v2/chats/:id/context-audit`.

Ein Live-Vorschau-Endpunkt, `POST /api/v2/context-preview`, führt dieselben
Persona-, Lorebook-, Gedächtnis-, Vorlagen-, Tokenizer- und
Shifting-Stufen aus, ohne Nachrichten, Branches oder Audits zu erstellen.

## Siehe auch

- [Pipeline-Stufen](stages), wo das Shifting in der Stufenreihenfolge
  sitzt.
- [Tokenisierung](tokenization), wie Token gezählt werden.
- [Daten & Speicherung](../data/), wo Audits gespeichert werden.
