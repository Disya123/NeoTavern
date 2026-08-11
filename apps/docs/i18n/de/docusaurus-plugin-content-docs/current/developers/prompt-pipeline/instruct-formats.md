---
title: Instruct-Formate
description: >-
  Wie Instruct-Formate das saubere Nachrichtenarray mit sandboxed
  Handlebars-Vorlagen rendern, die integrierten Formate und versionierte
  JSON-Presets.
sidebar_position: 3
---

Instruct-Formate definieren, wie das saubere Nachrichtenarray in eine
Prompt-Zeichenkette gerendert wird, unter Verwendung sandboxed
Handlebars-Vorlagen ohne Zugriff auf das Dateisystem oder auf
Codeausführung.

## Der Format-Manager

Ein integrierter Format-Manager verwaltet Instruct-Formate. Formate sind
Handlebars-Vorlagen, die in einer isolierten Umgebung gerendert werden:
Vorlagen erhalten nur `content`, `role` und `name`, und nur dokumentierte
Helfer sind verfügbar. Vorlagen erhalten keinen Node.js-Zugriff, keinen
Dateisystemzugriff und keine Möglichkeit, beliebigen Code auszuführen.

Ein Format beschreibt:

- System-, Benutzer-, Assistenten- und Tool-Vorlagen;
- BOS- und EOS-Tokens;
- Nachrichtentrenner;
- spezielle Tokens.

## Integrierte Formate

NeoTavern wird mit diesen Formaten ausgeliefert:

- **ChatML** — `<|im_start|>` / `<|im_end|>`-Rollenblöcke.
- **Llama 3** — `<|begin_of_text|>` mit Rollen-Tags.
- **Alpaca** — Anweisungs- und Antwortblöcke.
- **Mistral** — `[INST]` / `[/INST]`-Blöcke.
- **Command-R** — `<|START_OF_TURN_TOKEN|>`-Blöcke.
- **Eigene Formate** — benutzerdefinierte Vorlagen, wählbar als aktives
  Format.

## Sauberes Nachrichtenarray bis zum Rendern

Bis zur Rendering-Stufe arbeitet die Pipeline ausschließlich mit einem
strukturierten Array von Nachrichten mit Rollen (`system`, `user`,
`assistant`, `tool`). Makros werden aufgelöst, Lorebook und Gedächtnis
werden eingefügt, Kontext-Shifting entfernt Überschuss, und
Plugin-Interceptor ändern dieses Array. Das Rendern erfolgt genau einmal,
in der Rendering-Stufe, sodass kein Adapter den Prompt ein zweites Mal
umformatiert.

## Endergebnis

Die Rendering-Stufe erzeugt eine von zwei Formen:

- **Eine Zeichenkette** — der gerenderte Prompt, gesendet an
  Text-Completion-Anbieter und für Diagnosen verwendet.
- **Strukturiertes JSON** — das `GenerationMessage[]`-Array, gesendet an
  Chat-Anbieter, die Rollen-getaggte Nachrichten akzeptieren.

Der Modus wird durch `serializeAsText` gewählt: Text-Adapter
(`text-completion`, `novelai`, `ai-horde`, `koboldai`) erhalten immer den
gerenderten Instruct-Prompt als einzelne `user`-Nachricht; Chat-Adapter
(`openai-compatible`, `anthropic`) erhalten das strukturierte Array.

## Makros

`{{user}}`, `{{char}}` und eigene Variablen werden vor dem finalen Rendern
aufgelöst. Makros werden nie innerhalb der Template-Engine selbst expandiert,
sodass Vorlagendateien reine Auszeichnung bleiben.

## Eigene Formate und Presets

Das aktive eigene Format wird in `AppSettings.instructFormat` gespeichert.
Ist es gesetzt, wird das saubere Nachrichtenarray in eine einzelne
Zeichenkette gerendert und die Stopp-Zeichenketten des Formats werden zu
den Stopp-Sequenzen der Anfrage. Bei `null` wird die native strukturierte
Serialisierung verwendet.

Formate werden als **versionierte JSON-Presets** importiert und exportiert:

- `importInstructFormat()` validiert das Preset, bevor es aktiv wird;
- `exportInstructFormat()` erzeugt JSON-sichere, getrennte Werte;
- Presets tragen eine Version, sodass ältere Exporte beim Import migriert
  werden können.

## Siehe auch

- [Pipeline-Stufen](stages), wo das Rendern in der Stufenreihenfolge sitzt.
- [Tokenisierung](tokenization), wie der gerenderte Kontext gezählt wird.
- [Anbieter](../providers/), wie Adapter die serialisierte Ausgabe
  konsumieren.
