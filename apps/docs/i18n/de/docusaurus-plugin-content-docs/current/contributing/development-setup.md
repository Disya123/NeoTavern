---
title: Entwicklungseinrichtung
description: Eine NeoTavern-Entwicklungsumgebung einrichten und das Projekt lokal ausführen
sidebar_position: 2
---

Diese Seite erklärt, wie Sie eine Entwicklungsumgebung für NeoTavern
einrichten und das Projekt lokal ausführen.

## Voraussetzungen

- Node.js 24 LTS oder neuer — das Projekt erfordert Node `>= 24`.
- pnpm 9 — der Workspace erfordert pnpm `>= 9` und `< 10` und deklariert
  `packageManager: pnpm@9.15.0`; aktivieren Sie es mit corepack oder
  installieren Sie es direkt.
- Windows, macOS oder Linux. Die Desktop-App bündelt für Endbenutzer ihre
  eigene Node.js-Laufzeit, aber die Entwicklung verwendet immer Ihr
  installiertes Node.js.

## Abhängigkeiten installieren

```bash
pnpm install
```

Das installiert jedes Workspace-Paket. Das Repository ist ein
pnpm-Monorepo: Anwendungen liegen in `apps/` (Server und Web) und geteilte
Bibliotheken in `packages/`.

## In der Entwicklung ausführen

```bash
pnpm dev
```

startet das Fastify-Backend und die Vite-Web-App parallel mit Hot Reload.
Um sie getrennt auszuführen:

```bash
pnpm dev:server
pnpm dev:web
```

Öffnen Sie die vom Vite-Dev-Server ausgegebene URL, verbinden Sie in den
Einstellungen einen Anbieter und senden Sie Ihre erste Nachricht, um die
gesamte Pipeline zu verifizieren: Chat, Server, Anbieter, Streaming und
Speichern.

## Qualitätsgates

Führen Sie diese vor dem Pushen aus:

```bash
pnpm typecheck    # TypeScript across the monorepo
pnpm lint         # ESLint, zero warnings allowed
pnpm test         # Vitest unit and integration tests, plus web tests
pnpm test:e2e     # Playwright end-to-end suite (builds the workspace first)
pnpm build        # full workspace build (tsc -b and Vite)
pnpm format:check # Prettier check
```

`pnpm test:e2e` kompiliert zuerst den gesamten Workspace, erwarten Sie
also, dass es länger dauert als die anderen Prüfungen. Die Skripte
`docs:check` und `docs:build` validieren die interne
Entwicklerdokumentation; die öffentliche Site hat eigene Befehle,
dokumentiert auf der Seite [Dokumentations-Site](./docs-site).

## Desktop-Entwicklung

Die Desktop-Shell (Tauri) und ihr Node-Sidecar sind separate Anwendungen:

```bash
pnpm desktop:dev       # run the desktop app in development
pnpm desktop:portable  # build the portable Windows package
pnpm desktop:release   # build installer packages
```

Die Desktop-Paketierung umfasst OS-spezifische Toolchains; Details finden
Sie im Abschnitt [Desktop](../developers/desktop/) der
Entwicklerdokumentation.

## Häufige Probleme

- `pnpm install` oder `pnpm dev` schlägt fehl: Prüfen Sie, dass `node -v`
  24 oder neuer meldet und `pnpm -v` 9 meldet.
- Die Dev-Server starten nicht: Prüfen Sie, dass kein anderer Prozess die
  Ports belegt, die Server und Vite verwenden, und starten Sie dann
  `pnpm dev` neu.
