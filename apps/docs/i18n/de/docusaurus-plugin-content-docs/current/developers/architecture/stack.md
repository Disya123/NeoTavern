---
title: Technologie-Stack
description: >-
  Der genehmigte NeoTavern-Stack: Node.js 24, Fastify 5, React 19, Vite 8,
  striktes TypeScript, SQLite mit Drizzle und Tauri 2.
sidebar_position: 3
---

NeoTavern läuft auf einem bewusst langweiligen Stack: Node.js 24 LTS,
Fastify 5, React 19, Vite 8, striktes TypeScript, SQLite mit Drizzle ORM
und einer Tauri-2-Desktop-Shell.

## Laufzeit und Sprache

- **Node.js 24 LTS** — die Laufzeit für das Backend und den gebündelten
  Desktop-Sidecar. Code bleibt wo praktikabel mit Node.js 22 kompatibel.
- **TypeScript strikt** — überall aktiviert. Ungerechtfertigtes `any`,
  `as unknown
as`, `@ts-ignore` und Non-Null-Assertions sind verboten. Systemgrenzen
  verwenden `unknown` und explizite Validierung.
- **Nur ESM** — alle Apps und Pakete verwenden ES-Module.

## Backend

- **Fastify 5** — das API-Framework. Jedes Backend-Modul ist ein isoliertes
  Fastify-Plugin.
- **TypeBox + Fastify Type Provider** — jede API-Eingabe und -Ausgabe hat
  ein JSON-Schema, generiert aus `@neotavern/contracts`.
- **SSE** — Streaming-Generierung läuft über Server-Sent Events. WebSocket
  ist für echte bidirektionale Kanäle reserviert.
- **AbortSignal** — jede langlebige Operation akzeptiert ein `AbortSignal`
  und beendet sich sauber bei Zeitüberschreitung, wenn der Client die
  Verbindung trennt.

## Frontend

- **React 19** — eine Single-Page-App, kein Server-Side-Rendering.
- **Vite 8** — der Bundler und Dev-Server. Vite ist reines Build-Tooling,
  keine Anwendungs-Plugin-API.
- **React Router** — Routing mit einem einzigen Chat-Arbeitsbereich und
  darüber gerenderten Systemoberflächen.
- **TanStack Query** — der einzige Store für Server-Zustand.
- **Zustand** — nur transitorischer UI-Zustand: das aktive Panel, Theme- und
  Sprachpräferenzen, der angeheftete Charakter und begrenzte
  sitzungsbezogene Entwürfe.
- **Radix Primitives** — zugängliche Headless-Komponenten, umhüllt von
  `@neotavern/ui`.

## Daten

- **SQLite über better-sqlite3** — die einzelne Datenbankdatei, geöffnet mit
  WAL, `foreign_keys = ON`, `busy_timeout` und vorbereiteten Anweisungen.
- **Drizzle ORM** — typisiertes Schema, Repositories und Migrationen.
- **FTS5** — Volltextsuche über Charaktere, Chats und Nachrichten.

## Styling

- **CSS-Module + Custom Properties + Kaskadenebenen + Container-Queries** —
  das Styling-Werkzeugset. Themes überschreiben Design-Tokens und
  Ebenenregeln, ohne gegen die Spezifität zu kämpfen.

## Templating und Lokalisierung

- **Handlebars** — Instruct-Format-Vorlagen, gerendert in einer sandboxed
  Umgebung ohne Dateisystem- oder Codeausführungszugriff.
- **i18next** — alle benutzersichtbaren Zeichenketten, mit Namespaces und
  Ressourcen pro Sprache.

## Desktop

- **Tauri 2** — die Desktop-Shell, mit dem Node.js-Server als eigenständige
  Sidecar-Binärdatei.
- **tauri-plugin-shell und tauri-plugin-updater** —
  Prozessverwaltung und signierte Updates.

## Tooling

- **pnpm-Workspaces** — der Paketmanager des Monorepos.
- **Vitest** — Unit- und Integrationstests.
- **Playwright** — End-to-End-Tests, einschließlich Smoke-Tests der
  Desktop-Shell.

## Was bewusst fehlt

- Kein PostgreSQL, Redis, Docker oder anderer Dienst, den Sie installieren
  oder ausführen müssen.
- Kein SSR oder Node-Server für das Frontend über den API-Prozess hinaus.
- Kein `node:vm` als Sicherheits-Sandbox für Plugins — nicht
  vertrauenswürdige Backend-Plugins laufen stattdessen in einem separaten
  eingeschränkten Prozess.

Siehe [Monorepo-Übersicht](overview), wie die Teile zusammenpassen, und
[Pakete](packages) für die Zuständigkeiten.
