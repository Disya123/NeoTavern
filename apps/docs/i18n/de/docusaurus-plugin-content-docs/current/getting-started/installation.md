---
title: Installation
description: So installieren Sie NeoTavern unter Windows, macOS und Linux.
sidebar_position: 2
---

Diese Seite erklärt, wie Sie NeoTavern unter Windows, macOS und Linux
installieren. Laden Sie den Build für Ihre Plattform von der
[GitHub-Releases-Seite](https://github.com/Disya123/NeoTavern/releases)
herunter.

## Installationsvarianten

- **Windows-Installer.** Eine Setup-Datei, die die App installiert und
  Verknüpfungen anlegt. Für die meisten Windows-Anwender empfohlen.
- **Portable Windows-Build.** Ein in sich geschlossener Ordner, der ohne
  Installation läuft. Er hält alle Daten in seinem eigenen Verzeichnis,
  sodass Sie ihn auf einem USB-Stick mitnehmen können.
- **macOS-Paket.** Ein standardmäßiges `.app`-Bundle. Ziehen Sie es in den
  Programme-Ordner und starten Sie es von dort.
- **Linux-AppImage und -Archiv.** Das AppImage läuft auf den meisten
  Desktop-Distributionen. Die Archiv-Variante ist ein einfacher Ordner, den
  Sie überall ablegen und per Doppelklick starten können.

Alle vier Varianten sind funktional identisch. Wählen Sie, was am besten zu
Ihrem Umgang mit Software auf Ihrem Rechner passt.

## Systemanforderungen

- Ein 64-Bit-Desktop-Betriebssystem: Windows 10 oder neuer, macOS oder eine
  gängige Linux-Distribution.
- Genügend Arbeitsspeicher und Festplattenplatz für Ihre Bibliothek. Das
  Backend im Leerlauf benötigt auf einem Referenzrechner etwa 180 MB RAM,
  und die App erreicht auf demselben Rechner in etwa vier Sekunden eine
  einsatzbereite Oberfläche.
- Keine separate Node.js-, Python-, SQLite- oder Browser-Installation. Alles,
  was die App benötigt, ist gebündelt.

## Was gebündelt ist

Die Distribution enthält Node.js 24 LTS und SQLite, und die Desktop-Shell
führt das lokale Backend als eingebetteten Sidecar-Prozess aus. Das bedeutet:

- Der Erststart führt nie `npm install` aus und erfordert nie ein Terminal.
- Das Backend bindet ausschließlich an `127.0.0.1`. LAN- oder Remote-Zugriff
  wird nie stillschweigend aktiviert; er erfordert ein explizites Opt-in.
- Das Schließen des App-Fensters fährt den Sidecar sauber herunter, sodass
  kein Backend-Prozess zurückbleibt.

## Nach der Installation

Der erste Start erstellt Ihr Datenverzeichnis, legt eine kleine
Startbibliothek an und öffnet den Startbildschirm. Die nächsten Schritte
finden Sie unter [Schnellstart](quick-start).

Wenn während der Installation oder des Erststarts etwas schiefgeht, siehe
[Fehlerbehebung](troubleshooting).
