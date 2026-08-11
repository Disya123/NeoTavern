---
title: Plugin-Sandboxing
description: 'Das Sicherheitsmodell für nicht vertrauenswürdigen Plugin-Code: Prozessisolierung und Sicherer Modus.'
sidebar_position: 7
---

Nicht vertrauenswürdiger Plugin-Code wird auf jeder Ebene isoliert: Das
Backend läuft in einem separaten eingeschränkten Prozess, das Frontend in
einem sandboxed iframe, und Themes erhalten nie sensiblen Zugriff.

## Keine JavaScript-Sandbox

`node:vm` wird bewusst nicht als Sicherheits-Sandbox verwendet. Eine
JavaScript-Interpreter-Sandbox kann einen entschlossenen Angreifer nicht
davon abhalten, den Host-Prozess zu erreichen. Stattdessen wird die
Isolierung vom Betriebssystem erzwungen: getrennte Prozesse mit begrenzten
Fähigkeiten und getrennte Browsing-Kontexte.

## Backend-Isolierung

Ein nicht vertrauenswürdiges Backend-Plugin läuft in seinem eigenen
Node.js-24-Prozess mit Einschränkungen:

- Ein begrenzter Loader löst nur paketlokales ESM und die SDK-API auf.
- Der Prozess kann keine `node:*`-Builtins über das hinaus importieren, was
  der Loader erlaubt, keine Module außerhalb der Paketwurzel auflösen und
  die Host-Datenbank nicht erreichen.
- Alle Fähigkeiten kommen über einen IPC-Kanal; der Host erzwingt
  Berechtigungen bei jedem Aufruf.
- Der Prozess lauscht auf Kernanwendungsereignisse nur über den
  SDK-Ereignisbus und kann nur unter seinem eigenen Namensraum ausgeben.
- Wenn der Prozess abstürzt, entfernt der Host jede Registrierung, die er
  besaß.

Der Plugin-Prozess erhält nie die Fastify-Root, die SQLite-Verbindung,
absolute Pfade, die vollständige Umgebung oder die API-Schlüssel anderer
Anbieter. Der Netzwerkzugriff ist über das berechtigungsgeprüfte `fetch`
auf gewährte Hosts begrenzt.

## Frontend-Isolierung

Ein natives Frontend-Plugin läuft in einem sandboxed iframe mit
`sandbox="allow-scripts"` und ohne `allow-same-origin`:

- Der iframe hat keinen Same-Origin-Zugriff auf das Anwendungsdokument.
- Die Kommunikation mit dem Host läuft über einen einzigen übertragenen
  `MessagePort` mit einem Bootstrap-Nonce, strukturierten Envelopes,
  Deadlines und Abbruch.
- Der Host mountet die UI jeder Registrierung in eine isolierte Wurzel im
  iframe und kommuniziert über RPC, sodass das Plugin nie den
  React-Komponentenbaum oder das interne DOM berührt.
- Ein Absturz einer Plugin-Oberfläche reißt nur die Wurzeln und
  Clip-Bereiche dieses Plugins mit.

Jedes Plugin besitzt einen sandboxed Vollbild-iframe; der Host bündelt die
Rechtecke aktiver Mounts und beschneidet den sichtbaren und interaktiven
iframe-Bereich auf ihre Vereinigung, sodass Zeigerereignisse außerhalb
einer Plugin-Oberfläche bei der Anwendung bleiben.

## Vertrauter Legacy-Modus

Die Einträge `legacy.frontend` und `legacy.backend` sind ein separater,
vertrauter Kompatibilitätsmodus für bestehende SillyTavern-Erweiterungen —
keine Umgehung der nativen Sandbox. Die Verwendung eines der Einträge
erfordert die Berechtigung `legacy.trusted`, die die Oberfläche mit einer
verstärkten Warnung anzeigt, und der Benutzer muss sie explizit bestätigen.
Legacy-Frontend-Code wird im Hauptfenster ausgeführt, und
Legacy-Backend-Code erhält einen Express-Router, der auf seinen eigenen
`/api/plugins/{pluginId}`-Namensraum beschränkt ist. Der Sichere Modus lädt
Legacy-Einstiegspunkte überhaupt nicht.

## Themes

Theme-Pakete sind noch stärker eingeschränkt: Ein Theme erhält keinen
Zugriff auf Chats, API-Schlüssel oder das Dateisystem. Themes sind nur CSS
und deklaratives Layout — es gibt keinen JavaScript-Einstiegspunkt im
Theme SDK. Die Theme-Seite finden Sie unter
[Sicherer Modus des Theme SDK](../theme-sdk/safe-mode.md).

## Sicherer Modus

Der Sichere Modus (`?safe=1` in der URL) deaktiviert Drittanbieter-Plugins
und -Themes vollständig. Er wird behandelt, bevor Plugin- oder Theme-Code
geladen wird: Paket-CSS und Token-Überschreibungen werden dem Dokument
nicht hinzugefügt, und Einstiegspunkte von Drittanbietern laufen nie. Das
integrierte Theme und die integrierte Plugin-Laufzeit bleiben erhalten,
sodass sich die Oberfläche immer erholt. Das Verlassen des Sicheren Modus
stellt den zuvor gespeicherten aktiven Plugin- und Theme-Zustand wieder
her.

## Paketvalidierung

Jedes Paket wird validiert, bevor Code laufen kann: Pfad-Traversal,
Symlinks, native Binärdateien und ausführbare Nutzlasten werden abgelehnt;
Manifest-Felder, Einstiegspunkte und Berechtigungen werden geprüft;
npm-Abhängigkeiten werden mit Integritätsprüfungen geholt, und
Installationsskripte werden nie ausgeführt. Die vollständige
Installations-zu-Abbau-Geschichte finden Sie unter
[Lebenszyklus](lifecycle.md).
