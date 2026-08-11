---
title: Tokenisierung
description: >-
  Lokale Tokenzählung über das Tokenizer-Registry: tiktoken-kompatibel,
  SentencePiece, Hugging-Face-JSON, modellspezifische Plugins und der
  Näherungs-Fallback.
sidebar_position: 4
---

Die Tokenzählung läuft lokal über ein Tokenizer-Registry, das
tiktoken-kompatible, SentencePiece-, Hugging-Face-JSON- und
modellspezifische Plugin-Tokenizer unterstützt, mit einem expliziten
Näherungs-Fallback.

## Lokale Zählung

Die Tokenzählung verlässt nie den Rechner. Das Registry wählt ein
Tokenizer-Profil für das aktive Modell, und die Pipeline zählt den
zusammengesetzten Kontext im Prozess, vor jeder Netzwerkanfrage.

## Das Tokenizer-Registry

Das Registry akzeptiert vier Arten von Tokenizern:

- **Tiktoken-kompatibel** — BPE-Tokenizer, kompatibel mit OpenAIs tiktoken,
  für OpenAI-Modellfamilien.
- **SentencePiece** — Modelle, die SentencePiece-Vokabulare mitbringen.
- **Hugging-Face-Tokenizer-JSON** — `tokenizer.json`-Dateien aus
  Hugging-Face-Repositories, konvertiert in ein kompaktes Rangformat.
- **Modellspezifische Plugins** — Anbieter-Plugins können ein präzises
  Tokenizer-Profil für ein Modell registrieren.

Ein **Näherungs-Fallback** existiert für Modelle ohne registrierten
Tokenizer und ist immer explizit gekennzeichnet, sodass die Oberfläche eine
Schätzung nie als exakte Zählung präsentiert.

## Integrierte Profile

Der Kern registriert Offline-Profile für die gängigen Familien:

- `openai:o200k_base` — GPT-4o-, GPT-4.1-, GPT-5-, o1-, o3- und
  o4-Familien.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo und text-embedding-3.
- `deepseek:bytelevel-bpe-v1` — DeepSeek-Familien. Die Zählung läuft über
  eine kompakte Zählungs-Engine (ein BPE-Merge-Port ohne Vokabular und ohne
  Decoder) über die Ränge der offiziellen `tokenizer.json`. Die Datei wird
  einmalig in eine kleine Rangdatei konvertiert, die in
  `data/cache/tokenizers/deepseek-v4-flash/` über atomare
  Temp-plus-Rename-Schreibvorgänge gecacht wird; die vollständige JSON und
  die Laufzeit-Tokenizer-Bibliothek werden weder gespeichert noch geladen.

Wenn das Netzwerk nicht verfügbar ist, fällt das DeepSeek-Profil ehrlich
auf das Näherungsprofil zurück und versucht es höchstens einmal pro
15 Minuten erneut — ein fehlender Tokenizer blockiert die Generierung nie.

## Näherungs-Fallback

Unbekannte lokale Modelle verwenden `approximate-character-v1`, eine
skriptbewusste Heuristik: etwa 4,6 Zeichen pro Token für Lateinisch, 4,0
für Kyrillisch, 1,7 für CJK und 2,0 für Ziffern. Die Näherung wird überall
gekennzeichnet, wo sie erscheint, und ein Anbieter-Plugin kann sie jederzeit
durch die Registrierung eines präzisen Profils ersetzen.

## Plugin-Profile

Plugins registrieren Tokenizer-Profile mit einer Priorität. Ein
Plugin-Profil mit einer Priorität über `-10` überschreibt das
Familienprofil für die Modelle, die es abdeckt. Das ausgewählte Profil wird
als `countTokens`, `tokenizerProfile` und `tokenizerApproximate` in die
Pipeline übergeben.

## Das Token-Budget-Ergebnis

Nach der Zählung stellt die Pipeline `PipelineResult.tokenBudget` bereit,
das enthält:

- das verwendete Tokenizer-Profil;
- das `approximate`-Flag;
- das Kontextlimit des Modells;
- den reservierten Antwortbereich;
- die endgültige Prompt-Token-Zahl.

Siehe [Kontext-Shifting](context-shifting), wie das Budget durchgesetzt
wird.
