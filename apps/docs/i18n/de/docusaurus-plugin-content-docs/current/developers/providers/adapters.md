---
title: Mitgelieferte Adapter
description: Die mit NeoTavern ausgelieferten Anbieter-Adapter und was jeder anspricht.
sidebar_position: 3
---

NeoTavern wird mit einem Satz Anbieter-Adapter ausgeliefert. Sie liegen in
`packages/provider-sdk/src/adapters/`, eine Datei pro Adapter, und sind im
Kern-`ProviderRegistry` nach ihrer Anbieterart registriert.

## OpenAI-kompatibel

Datei: `openaiCompatible.ts` — Art `openai-compatible`.

Spricht jeden Server an, der die OpenAI-`/v1/chat/completions`- und
`/v1/models`-API exponiert: OpenAI selbst, OpenRouter, LM Studio,
llama.cpp-Server, Ollama mit dem `/v1`-Endpunkt, vLLM und Ähnliches. Er
verwendet nur das globale `fetch` und den SSE-Parser des SDKs; der
API-Schlüssel wird gesendet, aber nie protokolliert.

## Anthropic

Datei: `anthropic.ts` — Art `anthropic`.

Spricht die native Anthropic-Messages-API an. Das ist die eine
dokumentierte Ausnahme von der Regel „keine Anbieter-SDKs": Er verwendet
`@anthropic-ai/sdk`, weil die API — erweitertes Denken und
Beta-Header-Unterstützung — vom offiziellen SDK genauer behandelt wird. Er
unterstützt Prompt-Caching und adaptives Denken und deklariert die
Wire-Fähigkeit `assistantPrefill`.

## Text Completion

Datei: `textCompletion.ts` — Art `text-completion`.

Spricht lokale oder selbst gehostete Backends an, die den
Legacy-OpenAI-`/v1/completions`-Endpunkt exponiert haben:
text-generation-webui („ooba"), koboldcpp, vLLM, Ollama, llama.cpp-Server
und Ähnliches. Anders als Chat-Adapter konsumiert er einen serialisierten
Prompt: Die Prompt-Pipeline rendert das Instruct-Format und übergibt dem
Adapter eine einzelne Benutzernachricht, deren Inhalt der fertige Prompt
ist, und der Adapter postet ihn an `/completions`. Der API-Schlüssel ist
für lokale Server optional und wird nie protokolliert.

## NovelAI

Datei: `novelai.ts` — Art `novelai`.

Spricht die NovelAI-Textgenerierungs-API an (`POST {baseUrl}/ai/generate`
mit einem Bearer-Schlüssel). Die Generierung ist nicht gestreamt — ein
einzelnes `delta` plus das terminale `done`-Ereignis, passend zum
einheitlichen Stream-Vertrag. Die Modellerkennung wird von der API nicht
angeboten, daher gibt `listModels` das konfigurierte Modell zurück. Der
Adapter ist als experimentell markiert, weil sich die Parameteroberfläche
von NovelAI weiterentwickelt; nur die etablierten Sampler sind abgebildet.

## KoboldAI

Datei: `koboldai.ts` — Art `koboldai`.

Spricht die native KoboldAI/Kobold-Server-API an (`POST {baseUrl}/api/v1/generate`).
Die Generierung ist nicht gestreamt; das geladene Modell wird von
`/api/v1/model` für die Erkennung gelesen. Typische lokale Installationen
benötigen keinen API-Schlüssel.

## AI Horde

Datei: `aiHorde.ts` — Art `ai-horde`.

Spricht die AI Horde (`stablehorde.net`) an, einen asynchronen
Crowdsourcing-Cluster. Ein Auftrag wird mit
`/api/v2/generate/text/async` eingereicht und dann über den
Status-Endpunkt abgefragt, bis er fertig ist; die Abfrageschleife prüft
das Aufrufersignal und eine Leerlauf-Deadline erneut, sodass ein
festhängender Auftrag abbricht, statt endlos abzufragen. Anonyme Nutzung
ist mit niedrigerer Priorität erlaubt; ein API-Schlüssel wird als
`apikey`-Header gesendet, wenn einer konfiguriert ist.

## Echo

Datei: `echo.ts` — Art `echo`.

Ein vollständig offline arbeitender Anbieter für Tests, Demos und die
Verifizierung der Streaming-Pipeline ohne Netzwerk oder API-Schlüssel. Er
streamt die letzte Benutzernachricht Wort für Wort zurück. Er implementiert
auch die optionalen Sprach-, Bild- und Transkriptionsmethoden, was ihn zu
einer nützlichen Referenz für das Schreiben eines Adapters macht, der jede
Modalität abdeckt.

## Prompt-Helfer

Datei: `prompt.ts` — exportiert `promptFromMessages`, einen gemeinsamen
Helfer, der Nachrichtenarrays in die Prompt-Formen serialisiert, die die
Adapter senden. Er ist selbst kein Adapter.

Für die exakte `ProviderAdapter`-Schnittstelle, die alle diese
implementieren, siehe [Adaptervertrag](adapter-contract.md) und die
generierte [Provider-SDK-Referenz](../../api/provider-sdk/).
