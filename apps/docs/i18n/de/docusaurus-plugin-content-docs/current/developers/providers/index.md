---
title: Anbieter-Übersicht
description: Wie NeoTavern über einen Adaptervertrag mit LLM-, TTS-, STT- und Bild-Diensten spricht.
sidebar_position: 1
---

Anbieter sind das, womit NeoTavern mit externen KI-Diensten spricht:
Sprachmodelle, Text-to-Speech, Speech-to-Text und Bildgenerierung.

## Ein Adaptervertrag

Jeder Anbieter — ob ein OpenAI-kompatibler Chat-Endpunkt, eine native
Anthropic-Verbindung, ein Community-Backend wie NovelAI oder KoboldAI oder
ein Plugin-registrierter Dienst — implementiert denselben
`ProviderAdapter`-Vertrag aus `@neotavern/provider-sdk`. Die Kern-Pipeline kennt
nur diesen Vertrag, sodass die Anwendung an keinen einzelnen Anbieter
gebunden ist.

Ein Adapter muss unterstützen:

- Konfigurationsvalidierung.
- Auflistung verfügbarer Modelle.
- Abbruch über `AbortSignal`.
- Einen einheitlichen Generierungs-Ereignisstream.
- Normalisierte Fehler.
- Timeouts.
- Geheimnisfreie Protokollierung.
- Registrierung über das Plugin SDK.

Da die Pipeline unabhängig vom Anbieter dieselbe Form sieht, funktionieren
Funktionen wie Streaming, Kontext-Shifting und Fehlerbehandlung über alle
Anbieter hinweg identisch. Die genauen Anforderungen finden Sie unter
[Adaptervertrag](adapter-contract.md).

## Mitgelieferte Adapter

Die Distribution wird mit Adaptern für OpenAI-kompatible Endpunkte,
Anthropic, Text-Completion-Endpunkte, NovelAI, KoboldAI, die AI Horde und
einen lokalen Echo-Adapter ausgeliefert. Jeder ist unter
[Adapter](adapters.md) dokumentiert.

## Lokale Token-Schätzung

Die Tokenzählung ist lokal und offline. Exakte Tokenizer (tiktoken,
SentencePiece oder Hugging-Face-Tokenizer-JSON) können pro Modell
registriert werden, auch von Anbieter-Plugins; bis ein exakter Tokenizer
registriert ist, verwendet der Host eine skriptbewusste Heuristik und
markiert die Zählung als Näherung.

## Anbieter erweitern

Der Kern ist bewusst frei von Anbieter-SDK-Abhängigkeiten. Neue Anbieter
werden hinzugefügt, indem ein Adapter geschrieben und registriert wird:

- Kern-Anbieter registrieren sich über das `ProviderRegistry` in
  `@neotavern/provider-sdk`.
- Plugin-Anbieter registrieren sich über die Backend-API des Plugin SDK
  (`api.providers.register(kind, factory)`), die die Berechtigung
  `providers.register` erfordert. Die Registrierung gibt eine
  Bereinigungsfunktion zurück und wird beim Deaktivieren des Plugins
  automatisch entfernt.

Das ist der dokumentierte Weg für einen privaten Endpunkt, ein
selbst gehostetes Modell oder einen Dienst ohne integrierten Adapter. Die
generierte [Provider-SDK-Referenz](../api/provider-sdk/) dokumentiert den
vollständigen Vertrag.
