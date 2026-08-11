---
title: Plugin-Lebenszyklus
description: Wie Plugins von der Installation über Einwilligung und Aktivierung bis zum Abbau wandern.
sidebar_position: 6
---

Ein Plugin durchläuft einen definierten Lebenszyklus: Installation,
Einwilligung, Aktivierung, aktiv und schließlich Abbau. Jeder Übergang wird
vom Host erzwungen.

## Installation

Die Installation erfolgt über den Plugin-Manager. Sie können ein begrenztes
`.stplugin`-ZIP-Archiv oder einen Link auf ein öffentliches Repository
(`github.com` oder `gitlab.com`, nur HTTPS) installieren. Der Host ruft nie
die git-Binärdatei auf; er lädt ein Repository-Archiv herunter und führt es
durch exakt dieselbe Validierung wie ein ZIP: Pfad-Traversal, Symlinks,
ausführbare Nutzlasten, Größen, Manifest-Felder, Einstiegspunkte und
Berechtigungen. Die Installation ist atomar und rollt bei jedem Fehler
zurück.

Wenn das Paket eine `package.json` mit Abhängigkeiten mitbringt, holt der
integrierte Resolver sie aus dem npm-Registry, ohne Installationsskripte
auszuführen. Bündeln Sie Ihre Abhängigkeiten, wann immer möglich; der
Resolver existiert für schwere WASM-Bibliotheken, die vernünftigerweise
nicht gebündelt werden können.

## Einwilligung

Nach der Validierung tritt das Plugin in einen `needs-consent`-Zustand
ein. Es bleibt dort, bis der Benutzer jede angeforderte Berechtigung
bestätigt (und die npm-Abhängigkeitsliste prüft, falls eine existiert).
In dieser Phase läuft kein Einstiegspunkt. Das vollständige Modell finden
Sie unter [Berechtigungen](permissions.md).

## Aktivierung

Die Aktivierung ist ein zweiphasiger Vorgang:

1. Backend- und Legacy-Registrierungen starten zuerst.
2. Der Frontend-Einstiegspunkt lädt und erhält seine API.

Wenn die Aktivierung auf halbem Weg fehlschlägt, rollt der Host die
Teilregistrierungen zurück und zeichnet einen Ladefehler auf. Eine
fehlgeschlagene Aktivierung hinterlässt nie halb registrierte Oberflächen.

## Aktive Laufzeit

Während der Aktivität wird jede Registrierung, die das Plugin vornimmt —
UI-Oberflächen, Routen, Ereignisabonnements, i18n-Ressourcen,
Benachrichtigungen, Anbieter, Tokenizer, Kontextstrategien und
Nachbearbeiter — von der Laufzeit gesammelt. Das Plugin kann in
`deactivate()` auch eigene Ressourcen verwalten.

## Abbau

Deaktivierung, Sicherer Modus, Löschung, ein Absturz oder das Herunterfahren
der Anwendung lösen alle den Host-erzwungenen Abbau aus. Die Laufzeit
entsorgt gesammelte Registrierungen in umgekehrter Reihenfolge, und die
Garantien sind strikt: Nach der Deaktivierung eines Plugins bleibt nichts
zurück.

- Keine Ereignis-Handler oder Abonnements.
- Keine Timer.
- Keine DOM-Knoten.
- Keine gemounteten Routen.
- Keine Hintergrundanfragen.
- Keine registrierten Anbieter, Tokenizer oder Strategien.

Ein Fehler, den die eigene `deactivate()` des Plugins auslöst, bricht den
erforderlichen Abbau nicht ab — der Host entsorgt trotzdem alles, was er
verfolgt. Der Abbau ist idempotent: Ein zweiter Aufruf hat keine Wirkung.

## Update

Das Aktualisieren ersetzt das Paket atomar und behält den aktuellen
Aktivierungszustand, mit einer Ausnahme: Wenn das neue Manifest
Berechtigungen hinzufügt, wird die Laufzeit sofort deaktiviert und bleibt
deaktiviert, bis der Benutzer den neuen Berechtigungen zustimmt. Das
Zurückrollen auf eine frühere Version erfolgt, indem diese Version erneut
installiert wird; Benutzerdaten im Plugin-Speicher überleben beide
Richtungen.

## Absturzbehandlung

Ein Backend-Plugin läuft in seinem eigenen Prozess. Wenn dieser Prozess
abstürzt, entfernt der Host alle Registrierungen des Plugins und meldet den
Fehler. Ein abgestürztes Plugin kann keine verwaisten Routen oder
Ereignisabonnements hinterlassen, weil diese dem Host gehören, nicht dem
Prozess.

Das Sicherheitsmodell, das diese Garantien möglich macht, finden Sie unter
[Sandboxing](sandboxing.md). Die Manifest-Felder, die den Lebenszyklus
steuern, finden Sie unter [Manifest](manifest.md).
