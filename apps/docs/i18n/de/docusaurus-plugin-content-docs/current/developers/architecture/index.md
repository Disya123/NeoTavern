---
title: Architektur
description: >-
  Überblick über den Architektur-Abschnitt: die Monorepo-Struktur, der
  genehmigte Technologie-Stack und die Verantwortung jedes Pakets.
sidebar_position: 1
---

Dieser Abschnitt erklärt, wie das NeoTavern-Monorepo organisiert ist, welche
Technologien es verwendet und wie Server, Web-Client und Desktop-Shell
zusammenpassen.

## Seiten in diesem Abschnitt

- [Monorepo-Übersicht](architecture/overview) — die Struktur von `apps/` und `packages/`,
  der Datenfluss zwischen Server und Web und das local-first-Prinzip.
- [Technologie-Stack](architecture/stack) — der genehmigte Stack: Node.js 24, Fastify 5,
  React 19, Vite 8, SQLite, Drizzle, Tauri 2 und pnpm-Workspaces.
- [Pakete](architecture/packages) — die Verantwortung jedes Workspace-Pakets und die
  Abhängigkeitsrichtung zwischen ihnen.

## Verwandte Abschnitte

Der Abschnitt [Prompt-Pipeline](prompt-pipeline/) beschreibt die
Generierungsstufen im Detail, und [Daten & Speicherung](data/)
dokumentiert Datenbank, Dateibehandlung und Backups.
