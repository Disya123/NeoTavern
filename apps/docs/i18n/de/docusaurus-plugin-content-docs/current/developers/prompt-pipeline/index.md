---
title: Prompt-Pipeline
description: >-
  Überblick über die Prompt-Pipeline: die feste Stufenreihenfolge,
  Instruct-Formate, lokale Tokenzählung und Kontext-Shifting.
sidebar_position: 1
---

Die Prompt-Pipeline ist die feste, geordnete Menge von Stufen, die aus
einem Chat eine Anbieteranfrage macht — von der Benutzereingabe bis zur
gespeicherten Nachricht.

## Was die Pipeline tut

Jede Generierung — eine neue Nachricht, ein Swipe, eine Regeneration oder
eine Imitation — läuft in derselben Reihenfolge durch dieselben Stufen. Die
Pipeline setzt den Kontext aus Charakter, Persona, Lorebook und Gedächtnis
zusammen, zählt Token, passt den Kontext in das Budget des Modells ein,
lässt Plugins abfangen, rendert die Anfrage im ausgewählten
Instruct-Format und streamt und speichert schließlich die Antwort.

## Seiten in diesem Abschnitt

- [Pipeline-Stufen](prompt-pipeline/stages) — die 14 Stufen in Reihenfolge und die Regeln,
  die jeder Plugin-Hook befolgen muss.
- [Instruct-Formate](prompt-pipeline/instruct-formats) — wie das saubere Nachrichtenarray
  mit sandboxed Handlebars-Vorlagen gerendert wird.
- [Tokenisierung](prompt-pipeline/tokenization) — das lokale Tokenizer-Registry und sein
  Näherungs-Fallback.
- [Kontext-Shifting](prompt-pipeline/context-shifting) — wie die Pipeline den Kontext in
  das Token-Budget einpasst und welche Strategien es gibt.

## Implementierung

Die Pipeline lebt in `apps/server/src/pipeline/`. Sie läuft vollständig auf
dem Server, vor jedem Netzwerkaufruf, sodass die Anfrage, die einen
Anbieter erreicht, immer das Ergebnis derselben deterministischen Stufen
ist.

## Verwandte Abschnitte

- Plugin-Interceptor und ihre Registrierungs-APIs sind im
  [Plugin SDK](plugin-sdk/) dokumentiert.
- Der Generierungsendpunkt und das Kontext-Audit sind Teil der
  [API-Referenz](../api/).
- Anbieter-Adapter, die die serialisierte Anfrage konsumieren, sind unter
  [Anbieter](providers/) dokumentiert.
