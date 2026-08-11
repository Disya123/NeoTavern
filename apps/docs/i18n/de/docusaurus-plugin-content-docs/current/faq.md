---
title: FAQ
description: Häufige Fragen zu Daten, Offline-Nutzung, Plugins, Updates und Migration
sidebar_position: 2
---

Diese Seite beantwortet die Fragen, die Anwender am häufigsten zu NeoTavern
stellen.

## Wo werden meine Daten gespeichert?

Alle Ihre Daten — Chats, Charaktere, Personas, Gruppen, Lorebooks, Gedächtnis
und Einstellungen — liegen in einem Datenverzeichnis auf Ihrem Rechner. Das
Verzeichnis enthält die SQLite-Datenbank und den Dateispeicher mit
Charakterkarten, Bildern und anderen Assets. Die genaue Struktur und der
Umzug finden Sie unter [Daten & Speicherung](./developers/data/) und
[Daten & Backups](./user-guide/data-and-backups).

## Funktioniert NeoTavern offline?

Ja. NeoTavern ist local-first und offline-fähig: Richten Sie es auf einen
lokalen Modell-Endpunkt aus, und Sie können ganz ohne Internetverbindung
chatten. Cloud-Anbieter benötigen natürlich das Netzwerk, und die App teilt
Ihnen mit, wenn eine Verbindung fehlt.

## Werden meine Daten in die Cloud gesendet?

Nein. Ihre Chats und Dateien bleiben auf Ihrem Rechner. Der einzige
Netzwerkverkehr sind die Anfragen, die Sie explizit konfigurieren — die
Anbieter, die Sie für Generierung, Sprache und Bilder verbinden — und die App
sendet standardmäßig keine Telemetrie.

## Brauche ich einen API-Schlüssel?

Nur für die Cloud-Anbieter, die Sie selbst verbinden möchten. Lokale Modelle
benötigen überhaupt keinen Schlüssel; Sie konfigurieren jeden Anbieter in den
Einstellungen, und der Schlüssel bleibt in Ihrem Verbindungsprofil.

## Sind Plugins sicher?

Plugins laufen unter einem Berechtigungsmodell und sind sandboxed:
Backend-Plugins werden in einem eingeschränkten Prozess ausgeführt, und
Plugin-Oberflächen sind von der Haupt-App isoliert. Sie erteilen
Berechtigungen bei der Installation, und der Sichere Modus startet die App
ohne Plugins und Themes, wenn etwas schiefgeht. Siehe
[Erweiterungen](./user-guide/extensions) und das
[Plugin SDK](./developers/plugin-sdk/).

## Kann ich meine vorhandenen Charaktere verwenden?

Ja. NeoTavern importiert Standard-Charakterkarten, einschließlich PNG-Karten
mit eingebettetem JSON, sodass Charaktere aus anderen Chat-Apps und aus der
Community-Charaktergalerie ohne Umwege funktionieren. Siehe
[Charaktere](./user-guide/characters).

## Kann ich meine SillyTavern-Ära-Plugins migrieren?

Plugins, die für die ältere SillyTavern-Umgebung geschrieben wurden, können
über die Legacy-Kompatibilitätsebene laufen, die die vertrauten
`window.SillyTavern`-, `window.eventSource`- und `window.$`-Globals sowie
einen Express-kompatiblen HTTP-Host bereitstellt. Es ist ein
Kompatibilitätspfad, kein Ziel für Neuentwicklungen: Neue Plugins sollten das
[Plugin SDK](./developers/plugin-sdk/) verwenden. Siehe
[Legacy-Kompatibilität](./developers/legacy-compat).

## Wie funktionieren Updates?

Updates ersetzen die Installation direkt und erhalten Ihr Datenverzeichnis.
Das Changelog listet auf, was sich in jeder Version geändert hat; lesen Sie es
vor dem Update, um Breaking Changes zu erkennen.

## Was sind die Systemanforderungen?

NeoTavern läuft unter Windows (Installer oder Portable-Build), macOS (Paket)
und Linux (AppImage oder Archiv). Die Desktop-App bündelt ihre eigene
Node.js-Laufzeit, sodass Sie nichts anderes installieren müssen. Ein aktuelles
64-Bit-Betriebssystem und einige hundert Megabyte freier Arbeitsspeicher für
das Backend genügen für die typische Nutzung.

## Gibt es eine Web- oder Mobile-Version?

Die Desktop-App basiert auf Tauri und wird mit einem PWA-Begleiter
ausgeliefert: Die Web-Oberfläche kann als progressive Web-App mit einer
Offline-App-Shell installiert werden. Siehe
[Desktop](./developers/desktop/).

## Wie sichere ich meine Daten?

Exportieren Sie Chats in Dateien, exportieren Sie Ihre gesamte Bibliothek
oder kopieren Sie das Datenverzeichnis, während die App gestoppt ist.
Backups sind einfache, portable Dateien; Stellen Sie sie wieder her, indem
Sie sie importieren oder zurück an ihren Platz legen. Siehe
[Daten & Backups](./user-guide/data-and-backups) und
[Backups](./developers/data/backups).

## Was ist der Sichere Modus?

Der Sichere Modus startet NeoTavern ohne Plugins und Themes, damit Sie
Probleme diagnostizieren können, die durch Drittanbieter-Code verursacht
werden. Verwenden Sie ihn, wenn die App nach der Installation eines Plugins
oder Themes nicht mehr startet. Siehe
[Fehlerbehebung](./getting-started/troubleshooting).

## Wie melde ich einen Fehler oder wünsche mir eine Funktion?

Öffnen Sie ein Issue im [GitHub-Repository](https://github.com/Disya123/NeoTavern)
mit der Version, Ihrem Betriebssystem und Schritten zur Reproduktion.
Funktionswünsche sind dort ebenfalls willkommen.

## Wo finde ich das Changelog?

Das Changelog liegt im Repository unter
[CHANGELOG.md](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).
