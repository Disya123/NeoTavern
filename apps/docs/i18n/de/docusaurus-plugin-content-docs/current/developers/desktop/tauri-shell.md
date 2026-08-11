---
title: Tauri-Shell
description: Die native Tauri-2-Shell und wie das Schließen des Fensters das Backend stoppt.
sidebar_position: 2
---

Die Desktop-Shell basiert auf Tauri 2. Sie besitzt das native Fenster,
startet das Backend und garantiert, dass beide zusammen herunterfahren.

## Die Aufgabe der Shell

Die Shell tut drei Dinge:

1. **Sidecar starten** — sie startet den eigenständigen
   Node.js-Backend-Prozess und wartet, bis die lokale API bereit ist,
   bevor sie die WebView öffnet. Sie sehen nie ein halb geladenes Fenster,
   das auf einen toten Server zeigt.
2. **Die WebView hosten** — die Produktions-Web-App läuft in der
   Tauri-WebView und spricht über `127.0.0.1` auf einem zufälligen freien
   Port mit dem Backend.
3. **Den Lebenszyklus besitzen** — Fensterereignisse und Prozessereignisse
   sind so verdrahtet, dass Backend und Shell immer als eine Einheit
   enden.

## Fenster-Lebenszyklus

- **Schließen** — das Schließen des Fensters löst ein geordnetes
  Herunterfahren des Sidecars aus. Das Backend wird gebeten, sauber zu
  stoppen, und die App wartet darauf, bevor sie endet. Es bleibt kein
  verwaister Node.js-Prozess zurück.
- **Backend-Absturz** — wenn der Sidecar unerwartet endet, beendet sich die
  Shell mit einem Fehler, statt ein Fenster zu zeigen, das nichts kann.
  Normale Austritte werden separat markiert, sodass ein sauberes
  Herunterfahren nie mit einem Absturz verwechselt wird.
- **Neustart** — das erneute Starten der App startet den Sidecar von Grund
  auf neu. Der Zustand liegt im Datenverzeichnis, nicht im Prozess, sodass
  Neustarts verlustfrei sind.

## Das Fenster ist die API

Da die Shell wartet, bis die API bereit ist, bevor sie Inhalt zeigt, fühlt
sich der erste Start unmittelbar an: Das Fenster öffnet sich zu einer
einsatzbereiten Anwendung. Das Backend lauscht nur auf `127.0.0.1` auf
einem ephemären Port, sodass nichts dem Netzwerk ausgesetzt ist.

## Updater-Integration

Release-Builds integrieren den Tauri-Updater. Die Shell kann nach
Kern-Updates suchen, Manifest und Minisign-Signatur verifizieren, das
Plattform-Artefakt installieren und neu starten. Der Updater ersetzt den
Kern getrennt vom Benutzerdatenverzeichnis, und unsignierte Downgrades
werden abgelehnt. Builds ohne Update-Endpunkt und öffentlichen Schlüssel
sind voll funktionsfähig, melden aber, dass Updates nicht konfiguriert
sind.

## Entwicklungs-Builds

Für die Entwicklung kann dieselbe Shell gegen einen Dev-Server und ein
lokal gestartetes Backend laufen. Die Produktionsgarantie — der Sidecar
endet mit dem Fenster — gilt für paketierte Builds; `pnpm desktop:dev`
verbindet die Shell stattdessen mit Ihren laufenden Dev-Prozessen.

Wie der Sidecar gebündelt und verwaltet wird, finden Sie unter
[Node-Sidecar](node-sidecar.md).
