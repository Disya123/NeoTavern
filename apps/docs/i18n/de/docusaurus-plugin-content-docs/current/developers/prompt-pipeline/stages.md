---
title: Pipeline-Stufen
description: >-
  Die 14 festen Stufen der Prompt-Pipeline und die Regeln, die jeder
  Plugin-Hook befolgt: Priorität, Timeout, Abbruch, Berechtigungen und
  Isolierung.
sidebar_position: 2
---

Die Generierung läuft durch 14 feste Stufen, von der Benutzereingabe bis
zum Speichern der Nachricht, und jeder Plugin-Hook folgt denselben Regeln
für Priorität, Timeout, Abbruch, Berechtigungen und Fehlerisolierung.

## Die Stufenreihenfolge

Die Reihenfolge ist fest und für jede Generierung identisch:

```text
User input
→ Macros
→ Character/persona data
→ Lorebook
→ Memory/RAG
→ Token counting
→ Context shifting
→ Plugin interceptors
→ Instruct format rendering
→ Provider serialization
→ Request
→ Streaming response
→ Post-processing hooks
→ Save message
```

## Stufe für Stufe

1. **Benutzereingabe** — die Entwurfsnachricht und die
   Generierungsoptionen für diese Anfrage werden erfasst.
2. **Makros** — `{{user}}`, `{{char}}` und eigene Variablen werden von
   `replaceMacros` aufgelöst. Unbekannte Makros bleiben unverändert.
3. **Charakter-/Persona-Daten** — die Felder der Charakterkarte und die
   aktive Persona werden zum Nachrichtenarray zusammengesetzt.
4. **Lorebook** — passende Lorebook-Einträge werden gemäß ihren
   Aktivierungsregeln eingefügt. Als erforderlich markierte Einträge sind
   vor Entfernung geschützt.
5. **Gedächtnis/RAG** — Gedächtnis- und Vektorabruf-Blöcke werden
   abgerufen und eingestuft.
6. **Tokenzählung** — das lokale Tokenizer-Profil zählt den
   zusammengesetzten Kontext.
7. **Kontext-Shifting** — der Kontext wird in das Token-Budget eingepasst.
   Siehe [Kontext-Shifting](context-shifting).
8. **Plugin-Interceptor** — Plugins können das Nachrichtenarray prüfen und
   ändern. Nach dem letzten Interceptor zählt die Pipeline die Token neu
   und wendet das Budget erneut an, sodass kein Plugin es umgehen kann.
9. **Instruct-Format-Rendering** — das saubere Nachrichtenarray wird in
   das ausgewählte Instruct-Format gerendert oder bleibt strukturiert.
   Siehe [Instruct-Formate](instruct-formats).
10. **Anbieter-Serialisierung** — der Adapter baut die Anbieteranfrage:
    Chat-Adapter erhalten das strukturierte Nachrichtenarray, Text-Adapter
    die gerenderte Prompt-Zeichenkette.
11. **Anfrage** — die Anfrage wird mit einem `AbortSignal`, Timeouts und
    Client-Trennungsbehandlung gesendet.
12. **Streaming-Antwort** — die Antwort wird über SSE gestreamt. Ein
    optionales `assistantPrefill` wird genau einmal vor dem ersten Delta
    vorangestellt.
13. **Nachbearbeitungs-Hooks** — Plugins können die gestreamte Antwort
    verarbeiten, bevor sie gespeichert wird.
14. **Nachricht speichern** — die endgültige Nachricht, ihre Varianten und
    die Generierungsmetadaten werden in einer Transaktion gespeichert.

## Hook-Regeln

Jeder Plugin-Hook wird durch denselben Vertrag definiert:

- **Reihenfolge und Priorität** — Hooks laufen in Prioritätsreihenfolge;
  gleiche Prioritäten werden deterministisch geordnet.
- **Timeout** — jeder Hook hat ein Timeout. Ein Hook, das es überschreitet,
  wird abgebrochen.
- **Abbruch** — Hooks erhalten das `AbortSignal` der Generierung und müssen
  die Arbeit stoppen, wenn es ausgelöst wird.
- **Berechtigungen** — ein Hook läuft nur, wenn das Plugin die
  Berechtigungen besitzt, die seine deklarierten Fähigkeiten erfordern.
- **Ausnahmeisolierung** — ein Fehler im Hook eines Plugins wird abgefangen,
  protokolliert und übersprungen. Die Pipeline läuft weiter; ein defekter
  Interceptor darf die gesamte Generierung nie stillschweigend brechen.
- **Diagnoseprotokoll** — jede Prompt-Änderung wird aufgezeichnet. Das
  Änderungsprotokoll wird in den Generierungsdiagnosen zurückgegeben und in
  den `meta`-Daten der Antwortnachricht gespeichert, sodass Sie immer sehen
  können, was tatsächlich gesendet wurde.

## Prompt-Nachbearbeitung

Im Chat-Modus kann das Nachrichtenarray vor der Serialisierung eine optionale
Neuaufbaustufe durchlaufen — der Port des klassischen
`mergeMessages`-Algorithmus. Die Modi umfassen `merge`, `semi`, `strict`
und `single` sowie `_tools`-Varianten, die Tool-Nachrichten erhalten. Im
Textmodus wird diese Stufe übersprungen, weil das Instruct-Rendering die
Rollen bereits in eine Zeichenkette zusammengeführt hat.

## Siehe auch

- [Kontext-Shifting](context-shifting), wie das Budget durchgesetzt wird.
- [Tokenisierung](tokenization), wie die Tokenzählung funktioniert.
- Das [Plugin SDK](../plugin-sdk/) für die Registrierungs-APIs von
  Interceptors und Nachbearbeitung.
