---
title: Erweiterungen & Plugins
description: Plugins in NeoTavern installieren, aktivieren, deaktivieren und deinstallieren.
sidebar_position: 9
---

Diese Seite erklärt, wie Plugins in NeoTavern funktionieren: woher Sie sie
bekommen, wie Berechtigungen und Einwilligung funktionieren und wie die App
nicht vertrauenswürdigen Code im Zaum hält.

## Was ein Plugin ist

Ein Plugin fügt NeoTavern Verhalten hinzu — Toolbar-Aktionen,
Nachrichtenaktionen, Slash-Befehle, Prompt-Interceptor, eigene Panels,
Tastenkürzel, Backend-Routen oder Integrationen mit externen Diensten.
Plugins laufen gegen das stabile Plugin SDK, nicht gegen App-Interna, und
jede Funktion, die sie registrieren, wird beim Deaktivieren des Plugins
wieder entfernt.

Der offizielle Katalog enthält einige Plugins; Pakete von Drittanbietern
werden aus einem `.stplugin`-ZIP oder einem Link auf ein öffentliches
Git-Repository (GitHub oder GitLab, nur HTTPS) installiert. Der Server führt
nie Git oder npm aus: Ein Git-Link wird als Archiv heruntergeladen und genau
wie ein ZIP validiert.

## Ein Plugin installieren

Öffnen Sie den Bereich Plugins und installieren Sie ein Paket:

1. Vor der Installation zeigt die App Autor, Version, Quelle, Kompatibilität,
   Signatur (falls signiert) und die vollständige Berechtigungsliste.
2. Sie prüfen die Berechtigungen und willigen explizit ein. Das Paket bleibt
   im Zustand „Einwilligung erforderlich", bis Sie jede angeforderte
   Berechtigung bestätigen.
3. Die Installation ist atomar: Bei jedem Fehler bleibt die vorherige
   Version installiert und funktionsfähig.

Wenn das Paket npm-Abhängigkeiten deklariert, werden sie per HTTPS aus dem
Registry aufgelöst, per Prüfsumme verifiziert und nie ausgeführt —
Installationsskripte und native Binärdateien werden rundweg abgelehnt.

## Berechtigungen

Eine Berechtigung im Manifest ist eine Anfrage nach einer Fähigkeit, kein
automatischer Zugriff. Bevor ein Plugin Chats lesen, Prompts ändern, Ihre
Dateien berühren oder das Netzwerk erreichen kann, müssen Sie die passende
Berechtigung erteilen, und der Einwilligungsbildschirm beschreibt, was jede
einzelne bewirkt. Zwei Regeln sind wichtig:

- **Neue Berechtigungen nach einem Update erfordern eine frische
  Einwilligung.** Ein Update kann die Rechte eines Plugins nie
  stillschweigend erweitern.
- Berechtigungen können widerrufen werden. Der Widerruf wird beim nächsten
  Fähigkeitsaufruf des Plugins wirksam.

## Plugins verwalten

Der Manager zeigt den Zustand jedes Plugins: aktiviert, deaktiviert,
Berechtigungen erforderlich, inkompatibel oder Fehler. Von dort aus können
Sie:

- Ein Plugin **aktivieren oder deaktivieren**. Das Deaktivieren entfernt
  Oberflächen, Hooks, Timer, Routen und Abonnements ohne Neustart, und die
  Bereinigung wird vom Host erzwungen.
- Es **deinstallieren**, was auch seine Registrierungen löscht.
- Die **Kompatibilität** für Legacy-Erweiterungen aus der
  SillyTavern-Ära prüfen, die ihren Kompatibilitätsgrad und bekannte
  Einschränkungen anzeigen.

Ein Fehler in einem Plugin ist isoliert: Die App bietet an, nur dieses
Plugin zu deaktivieren, statt die gesamte Oberfläche zu beschädigen.

## Plugin-Sicherheit

Nicht vertrauenswürdige Backend-Plugins laufen in einem separaten
eingeschränkten Prozess, und sandboxed Plugin-Oberflächen laufen in einem
iframe mit einem kontrollierten RPC-Kanal. Theme-Pakete erhalten keinen
Zugriff auf Chats, Schlüssel oder Dateien. Der Sichere Modus deaktiviert
alle Drittanbieter-Plugins und -Themes und ist erreichbar, bevor sie geladen
werden, sodass man sich aus jedem Plugin-Fehlverhalten befreien kann. Siehe
[Sicherer Modus und Wiederherstellung](themes) und die
[Plugin-SDK-Dokumentation](../developers/plugin-sdk/).
