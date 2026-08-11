---
title: Adaptervertrag
description: Was jeder Anbieter-Adapter implementieren muss, von der Validierung bis zu Timeouts.
sidebar_position: 2
---

Der Adaptervertrag ist der Vertrag, den jeder LLM-, TTS-, STT- und
Bild-Anbieter implementiert. Wenn Sie einen Adapter schreiben, der ihn
erfüllt, funktioniert die gesamte Pipeline mit Ihrem Anbieter.

## Die Schnittstelle

Die `ProviderAdapter`-Schnittstelle hat eine stabile `kind`, optionale
Modalitätsdeklarationen und die erforderlichen Methoden. Textgenerierung
ist die Basisfähigkeit; Sprach-, Bild- und Transkriptionsmethoden sind
optional, sodass ein Nur-LLM-Adapter trotzdem ein gültiger Anbieter ist.

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## Erforderliches Verhalten

Der Vertrag erfordert acht Verhaltensweisen:

- **Konfigurationsvalidierung** — `validateConfig()` prüft die eigene
  Konfiguration des Adapters ohne Netzwerkaufrufe und gibt eine Liste von
  Problemen zurück.
- **Modellauflistung** — `listModels(signal)` gibt die verfügbaren Modelle
  zurück und muss das Abbruchsignal respektieren.
- **Abbruch** — jede langlebige Methode erhält ein `AbortSignal` und muss
  bei Auslösung umgehend abbrechen.
- **Einheitlicher Ereignisstream** — `generate()` liefert einen Stream
  typisierter `GenerationEvent`s und muss mit genau einem terminalen
  Ereignis enden, `done` oder `error`. Sprach- und Bildgenerierung
  verwenden dieselbe Streaming-Form.
- **Fehlernormalisierung** — Anbieterfehler werden auf stabile
  `AppError`-Codes mit maschinenlesbaren Codes und Parametern abgebildet.
  Upstream-HTTP-Status werden unterschieden (Auth, Rate-Limit, falsches
  Modell, Serverfehler), und rohe Upstream-Antwortkörper werden nie an
  Clients weitergeleitet.
- **Timeouts** — ein Adapter darf sich nicht allein auf das Signal des
  Aufrufers verlassen. Er braucht eigene Deadlines für Verbindung,
  Leerlauf-Stille beim Streaming und das Lesen ganzer Antworten. Das SDK
  liefert `ProviderTimeouts` (Standardwerte: 30 s Verbindung, 60 s
  Leerlauf, 30 s Lesen) und einen `DeadlineController`, der das
  Aufrufersignal mit erneut scharf schaltbaren Deadlines kombiniert und
  mit einem `TIMEOUT`-Fehler abbricht.
- **Sichere Protokollierung** — der API-Schlüssel wird aus sicherem
  Speicher bereitgestellt und darf nie protokolliert noch in Diagnosen oder
  Fehlerausgaben aufgenommen werden.
- **Registrierung** — Adapter werden nach Art registriert, entweder im
  Kern-Registry oder über die Backend-API des Plugin SDK.

## Anbieterneutralität

Der Kern ist an kein Anbieter-SDK gebunden. Neue Adapter sollen das globale
`fetch` und den SSE-Parser des SDKs (`parseSseStream`) für Streaming-Antworten
verwenden.

Es gibt genau eine dokumentierte Ausnahme: Der Anthropic-Adapter verwendet
`@anthropic-ai/sdk`, weil die Anthropic-API — erweitertes Denken und
Beta-Header-Unterstützung — vom offiziellen SDK genauer behandelt wird als
von einem handgeschriebenen fetch-Client. Es ist der einzige Adapter, der
mit einer Anbieterbibliothek verdrahtet ist; alles andere spricht direkt
HTTP.

## Host-Integration

Das `ProviderRegistry` bildet Anbieterarten auf Adapter-Fabriken ab.
`register` gibt eine Abmeldefunktion zurück, `create` instanziiert einen
Adapter und wirft für unbekannte Arten `PROVIDER_NOT_FOUND`, und das
Registry beherbergt auch das lokale Tokenizer-Registry. Deklarierte
Wire-Fähigkeiten wie `assistantPrefill` werden verwendet, um
Verbindungsprofile zu validieren — der Host verwirft nie stillschweigend
eine persistierte Profil-Überschreibung, die ein Adapter nicht unterstützt.

Für die echten mitgelieferten Adapter und was jeder anspricht, siehe
[Adapter](adapters.md). Zum Registrieren eines Adapters aus einem Plugin
siehe die [Backend-API des Plugin SDK](../plugin-sdk/backend.md).
