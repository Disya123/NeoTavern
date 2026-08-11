---
title: Node-Sidecar
description: Das Fastify-Backend als eingebetteter Node.js-Sidecar, vom Start bis zum geordneten Herunterfahren.
sidebar_position: 3
---

Das Backend von NeoTavern ist ein Fastify-Server, und in der Desktop-App
läuft er als eingebetteter Node.js-Sidecar: eine eigenständige
Node.js-24-Binärdatei, die neben der Shell paketiert ist.

## Warum ein Sidecar

Das Backend als separaten Prozess zu bündeln hält die Shell schlank und
das Backend real:

- Das Backend ist dieselbe Fastify-5-Anwendung, die eine selbst gehostete
  Installation ausführt, sodass Desktop- und Serververhalten identisch
  bleiben.
- Node.js und SQLite sind in die Distribution kompiliert, weshalb der
  Erststart kein npm-Install und kein Terminal benötigt.
- Eine Prozessgrenze bedeutet, dass ein Absturz oder Hänger im Backend die
  Ereignisschleife der Shell nicht zu Fall bringen kann und die Shell
  Lebenszyklusgarantien durchsetzen kann.

## Start

Beim Start startet die Shell die Sidecar-Binärdatei und wartet auf
Bereitschaft, bevor sie die WebView öffnet. Das Backend:

- lauscht nur auf einem zufälligen freien Port auf `127.0.0.1`;
- erstellt die SQLite-Datenbank und führt ausstehende
  Schema-Migrationen im Datenverzeichnis aus, wobei es vor ausstehenden
  Migrationen ein Backup erstellt;
- bedient die Produktions-Web-Assets und die API.

Der erste Start ist vollständig automatisch: Datenverzeichnis, Datenbank,
gebündelte Themes und der Startcharakter werden ohne Benutzerinteraktion
eingerichtet.

## Geordnetes Herunterfahren

Das Herunterfahren ist kooperativ und geordnet:

1. Die Shell erhält das Schließen-Ereignis und teilt dem Backend mit, zu
   stoppen.
2. Das Backend nimmt keine neuen Verbindungen mehr an, schließt laufende
   Arbeit innerhalb seiner Frist ab und schließt die Datenbank sauber.
3. Der Sidecar endet, und die Shell endet.

Eine unerwartete Backend-Beendigung wird von der Shell erkannt und als
Fehleraustritt gemeldet, nie als stillschweigend verwaister
Backend-Prozess zurückgelassen. Die App hinterlässt daher nach dem
Schließen des Fensters nie einen herrenlosen `neotavern-server`-Prozess.

## Bündelung und Verifizierung

Der Sidecar wird pro Zielplattform gebaut. Native Addons
(`better-sqlite3`, Sharp) und die Produktions-Web-Assets werden auf
demselben Ziel-Runner vorbereitet und mit der Binärdatei paketiert; das
Verschieben vorbereiteter Ressourcen zwischen Betriebssystemen wird nicht
unterstützt. Ein Smoke-Gate führt den paketierten Sidecar in CI headless
auf jeder Plattform aus und verifiziert die echte Node-Binärdatei, SQLite,
Sharp, die paketierte SPA, Diagnosen und das Fehlen übrig gebliebener
Prozesse.

## Portable-Variante

Der portable Windows-Build führt dasselbe Sidecar-Layout aus: die
Hauptbinärdatei, die Sidecar-Binärdatei, eine `portable.flag`-Markierung
und einen `resources/`-Ordner. Das Flag schaltet die Datenwurzel auf einen
lokalen `data/`-Ordner neben der Anwendung um. Die Shell normalisiert
Windows-Ressourcenpfade, bevor sie sie an die paketierte Node-Binärdatei
übergibt.

Für die Formate und das Erststart-Erlebnis siehe [Paketierung](packaging.md);
für die Shell, die diesen Prozess verwaltet, siehe [Tauri-Shell](tauri-shell.md).
