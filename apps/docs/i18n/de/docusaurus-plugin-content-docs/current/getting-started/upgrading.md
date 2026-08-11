---
title: Updates
description: Wie NeoTavern-Updates funktionieren und warum Ihre Daten bei einem Update sicher bleiben.
sidebar_position: 4
---

Diese Seite erklärt, wie NeoTavern-Updates ausgeliefert werden, was bei einem
Update mit Ihren Daten passiert und wo Sie nachlesen können, was sich
geändert hat.

## Wie Updates funktionieren

NeoTavern behandelt die Kern-App, Plugins und Themes als getrennte Einheiten,
und jede wird unabhängig aktualisiert:

- **Kern-Updates** ersetzen die Anwendung selbst und lassen Ihr
  Datenverzeichnis unberührt.
- **Plugin- und Theme-Updates** erfolgen über die jeweiligen Verwaltungen in
  der App und werden ohne Ihre Prüfung nie automatisch aktiviert.
- Jede Installation ist atomar: Die neue Version ersetzt die alte in einem
  einzigen Schritt, und die vorherige Version bleibt erhalten, sodass ein
  fehlgeschlagenes Update zurückgerollt werden kann.
- Die Integrität der Pakete wird per Prüfsumme verifiziert, und der offizielle
  Katalog kann darüber hinaus Signaturen hinzufügen.

Sie benötigen für Updates nie Git, npm oder ein Terminal. Wenn Sie die App
normal installiert haben, aktualisieren Sie sie auf dieselbe Weise, wie Sie
sie installiert haben.

## Datensicherheit bei Updates

- Updates ändern Ihre Benutzerdateien nie direkt: Charaktere, Chats,
  Lorebooks, Personas und Einstellungen werden vom Installer nicht berührt.
- Wenn ein Update eine Datenbank-Schema-Migration enthält, wird vor der
  Migration ein Backup erstellt, und Migrationen sind transaktional und
  idempotent.
- Ihre SQLite-Datenbank läuft im WAL-Modus, sodass die App nutzbar bleibt und
  Ihre Schreibvorgänge dauerhaft sind, während eine Migration oder ein Update
  abläuft.
- Wenn ein Plugin- oder Theme-Update fehlschlägt, behält die App die
  vorherige Version am Laufen, statt ein halb installiertes Paket
  zurückzulassen.

## Prüfen, was sich geändert hat

Das [Changelog](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md)
listet jede Änderung mit ihren Auswirkungen auf. Überfliegen Sie vor einem
Update die neuesten Einträge: Breaking Changes werden mit einem
Migrationsleitfaden geliefert, und Funktionen, die noch experimentell oder
geplant sind, sind explizit gekennzeichnet.

## Plugins und Themes aktualisieren

Öffnen Sie den Bereich Plugins und Themes. Jedes installierte Element zeigt
seine Version, seinen Status und ob ein Update verfügbar ist. Wenn ein Update
neue Berechtigungen anfordert, fragt die App erneut explizit um Ihre
Einwilligung, bevor sie angewendet werden — Berechtigungen werden durch ein
Update nie stillschweigend erweitert.

## Zurücksetzen

Da die vorherige Version bei Kern-Updates erhalten bleibt, können Sie sie neu
installieren, wenn sich eine neue Version fehlerhaft verhält. Ihr
Datenverzeichnis bleibt abwärtslesbar, und ein vor jeder riskanten Migration
erstelltes Backup ermöglicht es Ihnen, über die Oberfläche einen bekannten,
funktionierenden Zustand wiederherzustellen. Siehe
[Daten & Backups](../user-guide/data-and-backups).
