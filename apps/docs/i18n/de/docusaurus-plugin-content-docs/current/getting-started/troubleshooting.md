---
title: Fehlerbehebung
description: Lösungen für häufige Probleme bei der NeoTavern-Installation und beim Start.
sidebar_position: 5
---

Diese Seite beantwortet häufige Installations- und Laufzeitprobleme als Q&A.
Wenn Ihr Problem nicht aufgeführt ist, sammeln Sie die relevanten
Logzeilen und öffnen Sie ein Issue im
[GitHub-Repository](https://github.com/Disya123/NeoTavern).

## Warum meldet die App, dass der Port bereits belegt ist?

Das lokale Backend lauscht standardmäßig auf `127.0.0.1:8000`. Wenn ein
anderes Programm diesen Port belegt, kann der Sidecar nicht starten.
Schließen Sie das störende Programm oder starten Sie den Server mit einem
anderen Port, indem Sie `NEOTA_PORT` in der Umgebung setzen. Die
Fehlermeldung in der App enthält die Portnummer und die Details, die Sie
zur Lösung des Konflikts benötigen.

## Der Backend-Sidecar startet nicht

Die Desktop-App führt ihr Backend als eingebetteten Node.js-Sidecar aus.
Wenn er nicht startet, zeigt das App-Fenster einen Verbindungsfehler.
Prüfen Sie Folgendes:

- Möglicherweise läuft bereits eine andere NeoTavern-Instanz, die den Port
  belegt.
- Das Datenverzeichnis ist an seinem aktuellen Speicherort möglicherweise
  nicht beschreibbar.
- Ein Antivirenprogramm oder eine Firewall blockiert möglicherweise die
  eingebettete Node-Laufzeit.

Starten Sie die App nach der Behebung der Ursache neu. Wenn die App in eine
Absturzschleife gerät, bietet sie einen Start im Sicheren Modus an, der
Drittanbieter-Plugins und -Themes deaktiviert, bevor sie geladen werden —
nutzen Sie ihn zur Wiederherstellung.

## Die Datenbank ist gesperrt

NeoTavern verwendet SQLite mit WAL-Modus und einem Busy-Timeout, sodass
kurze parallele Zugriffe erwartet und behandelt werden. Ein anhaltender
Fehler „database is locked" bedeutet in der Regel, dass eine zweite
App-Instanz dasselbe Datenverzeichnis geöffnet hat oder dass ein Backup-
oder Importvorgang noch läuft. Schließen Sie doppelte Instanzen und warten
Sie, bis lange Vorgänge beendet sind, bevor Sie es erneut versuchen.

## Wie leere ich Caches?

Caches liegen unter `data/cache/` und sind vollständig regenerierbar:
Thumbnails, Tokenizer-Daten und Plugin-Abhängigkeitsdownloads. Das Leeren
eines Caches löscht nie Ihre Originale, die separat unter `data/files/`
gespeichert sind. Verwenden Sie die Wartungsfunktionen unter Einstellungen →
Daten, um Caches zu leeren und den Volltextsuchindex neu aufzubauen. Beide
Aktionen zeigen vor dem Löschen die Anzahl und Größe dessen an, was entfernt
wird.

## Wo liegen die Logs?

Logs werden nach `data/logs/server.log` geschrieben und bei 10 MB rotiert.
Die Logdatei ist redigiert: Geheimnisse, API-Schlüssel und der Inhalt von
Benutzernachrichten werden nie protokolliert. Konsolenausgabe wird neben der
Datei geführt. Wenn Sie einen Fehler melden, fügen Sie die relevanten
Logzeilen und die Trace-ID aus den Fehlerdetails bei.

## Wie komme ich zurück zu einer funktionierenden Oberfläche?

Verwenden Sie den Sicheren Modus: Er ist erreichbar, bevor
Drittanbieter-Themes und -Plugins geladen werden, und deaktiviert sie. Nach
einem defekten Theme oder Plugin stellt der Sichere Modus die integrierte
Oberfläche wieder her, ohne Dateien von Hand zu bearbeiten. Details finden
Sie unter [Themes](../user-guide/themes) und
[Erweiterungen](../user-guide/extensions).

## Warum ist die Senden-Schaltfläche deaktiviert?

Die Schaltfläche ist nur deaktiviert, wenn es einen konkreten Grund gibt,
der daneben erklärt wird — meist kein aktiver Anbieter oder kein
ausgewählter Charakter. Verbinden Sie einen Anbieter in den KI-Einstellungen
oder wählen Sie einen Charakter, und die Schaltfläche wird verfügbar. Siehe
[Schnellstart](quick-start).
