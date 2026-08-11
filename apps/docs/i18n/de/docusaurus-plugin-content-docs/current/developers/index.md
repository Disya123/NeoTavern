---
title: Entwickler
description: >-
  Überblick über die NeoTavern-Entwicklerdokumentation: Architektur, die
  Prompt-Pipeline, die Datenschicht und die SDKs zur Erweiterung der App.
sidebar_position: 1
---

Dieser Abschnitt erklärt, wie NeoTavern aufgebaut ist und wie Sie es mit
Plugins, Themes und Anbieter-Adaptern erweitern können.

## Was dieser Abschnitt abdeckt

Die Entwicklerdokumentation ist in vier Gruppen gegliedert:

- **Architektur** — die Monorepo-Struktur, der genehmigte Technologie-Stack
  und die Verantwortung jedes Workspace-Pakets.
- **Prompt-Pipeline** — die feste Menge von Stufen, die aus einem Chat eine
  Anbieteranfrage macht, einschließlich Instruct-Formaten, Tokenisierung
  und Kontext-Shifting.
- **Daten & Speicherung** — wie NeoTavern strukturierte Daten in SQLite
  speichert, wie Dateien und Bilder auf der Festplatte behandelt werden und
  wie Backups funktionieren.
- **NeoTavern erweitern** — das Plugin SDK, das Theme SDK,
  Anbieter-Adapter, die generierte API-Referenz und die Desktop-Shell.

## Wo Sie beginnen

Beginnen Sie mit der [Architektur-Übersicht](developers/architecture/), wenn Sie die
Form der Codebasis verstehen möchten, oder springen Sie direkt zur
[Prompt-Pipeline](developers/prompt-pipeline/), wenn Sie am Generierungsverhalten
arbeiten.

## Datenschicht

Der Abschnitt [Daten & Speicherung](developers/data/) behandelt die SQLite-Datenbank,
die Dateisystemstruktur und das Backup-Modell. Er ist die Referenz für
alles, was Daten persistiert.

## NeoTavern erweitern

NeoTavern lässt sich auf vier Arten erweitern:

- [Plugin SDK](developers/plugin-sdk/) — Plugins mit Manifest, Berechtigungen,
  Frontend- und Backend-APIs, Lebenszyklus-Hooks und Sandboxing.
- [Theme SDK](developers/theme-sdk/) — Themes aus Design-Tokens,
  Komponenten-Skins und Shell-Layouts.
- [Anbieter](developers/providers/) — Anbieter-Adapter, die den einheitlichen
  Adaptervertrag implementieren.
- [Legacy-Kompatibilität](developers/legacy-compat) — die Kompatibilitätsebene für
  Plugins und Skripte aus der SillyTavern-Ära.

Die [API-Referenz](api/) wird bei jedem Site-Build von TypeDoc aus den
SDK-Quellen generiert, sodass ihre Mitgliederseiten immer zu den
veröffentlichten Paketen passen.

## Desktop

Der Abschnitt [Desktop](developers/desktop/) dokumentiert die Tauri-2-Shell, den
Node.js-Sidecar und die Paketierung von Installern und Portable-Builds.
