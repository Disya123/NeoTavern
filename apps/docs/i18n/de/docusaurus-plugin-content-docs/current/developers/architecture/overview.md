---
title: Monorepo-Übersicht
description: >-
  Die NeoTavern-Monorepo-Struktur, der Datenfluss zwischen Server und Web
  und das local-first-Prinzip, das die Architektur prägt.
sidebar_position: 2
---

NeoTavern ist eine local-first-Anwendung: Ein einzelner Fastify-Prozess
bedient die API und das optionale gebaute Frontend, ohne externe
Datenbanken, Queues oder Container.

## Monorepo-Struktur

Der Workspace ist ein pnpm-Monorepo mit zwei Gruppen auf oberster Ebene,
`apps/` und `packages/`:

```text
apps/
  server/          # Fastify backend: API, prompt pipeline, SSE, legacy host
  web/             # React SPA
  plugin-runtime/  # Restricted Node.js process for backend plugins
  desktop/         # Tauri 2 shell; runs the server as a sidecar process
packages/
  shared/        # UUIDv7 IDs, Result, errors, logger, async utilities
  contracts/     # TypeBox API schemas — single source of truth
  db/            # SQLite: schema, migrations, repositories, FTS5
  ui/            # Headless components on Radix primitives
  i18n/          # i18next setup and language resources
  plugin-sdk/    # Plugin manifest, permissions, and API contracts
  theme-sdk/     # Theme tokens, levels, and inheritance
  provider-sdk/  # Provider adapter contract and adapters
  legacy-compat/ # window globals and DOM compatibility islands
  gestures/      # Framework-agnostic row gestures
  plugin-build/  # Plugin build and publish pipeline
```

## Apps

- `apps/server` — das Fastify-Backend. Es stellt die `/api/v2/*`-API bereit,
  führt die Prompt-Pipeline aus, streamt Generierung über SSE und hostet
  die Express-kompatible Legacy-Oberfläche. Jedes Modul ist ein isoliertes
  Fastify-Plugin.
- `apps/web` — die React-SPA. Sie kommuniziert über HTTP mit dem Server und
  rendert den Chat-Arbeitsbereich sowie die Oberflächen für Charaktere,
  Einstellungen, Anbieter, Themes und Plugins.
- `apps/plugin-runtime` — ein berechtigungsbegrenzter Node.js-Prozess, in
  dem nicht vertrauenswürdige Backend-Plugins ausgeführt werden, isoliert
  vom Haupt-Serverprozess.
- `apps/desktop` — die Tauri-2-Shell. Sie startet den kompilierten Server
  als eigenständigen Node.js-Sidecar und öffnet die WebView erst, wenn die
  lokale API bereit ist.

## Pakete

Gemeinsamer Code liegt in eng begrenzten Paketen unter `packages/`. Jedes
Paket hat genau eine Verantwortung, und Abhängigkeiten zeigen nur nach
unten: `server` und `web` hängen von Paketen ab, und Pakete hängen höchstens
von `shared` und `contracts` ab. Die vollständige Aufschlüsselung finden Sie
unter [Pakete](packages).

## Datenfluss

Eine typische Anfrage durchläuft diese Schichten:

1. Das Frontend ruft einen `/api/v2/*`-Endpunkt über TanStack Query auf.
2. Fastify validiert die Eingabe gegen ein TypeBox-Schema und gibt Fehler
   im `{ code, params, traceId }`-Envelope zurück.
3. Repositories in `@neotavern/db` lesen und schreiben SQLite, mit
   Cursor-Pagination und FTS5-Suche.
4. Die Generierung läuft über `POST /api/v2/chats/:id/generate`: Die
   Prompt-Pipeline setzt den Kontext zusammen, der Anbieter-Adapter
   serialisiert die Anfrage, die Antwort wird über SSE gestreamt, und die
   Nachricht wird gespeichert.

Die Web-App ist eine einzelne Seite: Routen wechseln den Chat-Arbeitsbereich,
während Charaktere, Einstellungen, Anbieter, Themes und Plugins in einer
Dialog-Oberfläche über dem erhaltenen Chat-Ort gerendert werden.

## Das local-first-Prinzip

Alles läuft auf Ihrem Rechner:

- Das Backend bindet standardmäßig an `127.0.0.1`. Remote-Zugriff ist ein
  explizites Opt-in mit begrenzten Sitzungen und HTTPS-Anforderungen.
- Alle Daten liegen in einem lokalen Datenverzeichnis: eine einzelne
  SQLite-Datenbank plus ein inhaltsadressierter Dateispeicher. Kein
  PostgreSQL, Redis oder Docker.
- Die App funktioniert offline. Anbieteraufrufe sind der einzige
  Netzwerkverkehr, und der integrierte `echo`-Adapter lässt Sie die gesamte
  Pipeline ohne Anbieter testen.
- Backups, Exporte und der SillyTavern-Import laufen alle lokal über
  dieselben SQLite- und Datei-APIs.

Siehe [Daten & Speicherung](../data/) für die Speicherschicht und
[Prompt-Pipeline](../prompt-pipeline/) für den Generierungspfad.
