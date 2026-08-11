---
title: Was ist NeoTavern
description: Eine Einführung in NeoTavern, eine local-first KI-Chat- und Rollenspiel-Plattform.
sidebar_position: 1
---

NeoTavern ist eine local-first KI-Chat- und Rollenspiel-Plattform, die auf
Ihrem eigenen Rechner läuft. Sie erstellen oder importieren Charaktere,
sprechen mit ihnen über jedes KI-Modell, das Sie anbinden, und behalten jede
Nachricht, jede Charakterkarte und jede Einstellung auf Ihrem Rechner.

## Das Local-First-Prinzip

- Ihre Daten liegen in einem lokalen Datenverzeichnis auf Ihrem Computer. Es
  gibt kein Konto, keine erzwungene Cloud-Synchronisierung und standardmäßig
  keine Telemetrie.
- Sie können Ihre Bibliothek durchsuchen, Charaktere bearbeiten und
  Einstellungen überprüfen, während Sie offline sind. Nur die Generierung
  benötigt einen erreichbaren Anbieter.
- Bevor etwas zum ersten Mal an einen externen KI-Dienst gesendet wird, zeigt
  Ihnen die App genau an, welcher Anbieter die Anfrage empfangen wird.

## Wie es läuft

- Die Desktop-App ist für Windows, macOS und Linux verfügbar. Sie bündelt
  Node.js und SQLite, sodass Sie selbst nie eine Laufzeit installieren.
- Die App startet ihr eigenes lokales Backend, einen eingebetteten
  Node.js-Sidecar, der standardmäßig auf `127.0.0.1:8000` lauscht und sich
  mit dem Fenster beendet.
- Eine reaktionsfähige PWA ermöglicht es Telefonen und Tablets, sich mit
  einem Backend zu verbinden, das auf Ihrem PC oder Heimserver läuft.

## Was Sie benötigen

- Ein unterstütztes 64-Bit-Desktop-Betriebssystem. Terminal, Git oder ein
  Paketmanager sind zu keinem Zeitpunkt erforderlich.
- Einen Anbieter für die Erzeugung von Antworten: einen lokalen
  Modell-Server oder eine Remote-API mit Ihrem Schlüssel. Der integrierte
  Echo-Anbieter lässt Sie den gesamten Ablauf offline verifizieren, ohne
  externen Dienst.
- Optional, aber nützlich: ein vorhandenes SillyTavern-Datenbackup, um Ihre
  Charaktere, Chats, Lorebooks und Personas zu migrieren.

## Wohin als Nächstes

- [Installation](getting-started/installation) — App herunterladen und auf Ihrem
  Betriebssystem einrichten.
- [Schnellstart](getting-started/quick-start) — Anbieter verbinden und Ihre erste Nachricht
  senden.
- [Updates](getting-started/upgrading) — wie Updates funktionieren und warum Ihre Daten
  sicher bleiben.
- [Fehlerbehebung](getting-started/troubleshooting) — Lösungen für häufige Installations-
  und Laufzeitprobleme.
- [Benutzerhandbuch](user-guide/) — ausführliche Seiten zu Chatten,
  Charakteren, Lorebooks, Gedächtnis, Themes und Plugins.
- [FAQ](faq) — kurze Antworten auf häufige Fragen.
