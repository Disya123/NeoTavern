---
title: Legacy-Kompatibilität
description: Die dokumentierten SillyTavern-Ära-Verträge, die weiterhin funktionieren.
sidebar_position: 8
---

NeoTavern bewahrt eine Reihe dokumentierter Verträge für bestehende
Erweiterungen aus der SillyTavern-Ära, damit Plugins, die gegen diese APIs
geschrieben wurden, weiter funktionieren können, während das native Plugin
SDK der Weg nach vorn ist.

## Window-Globals

Das Paket `@neotavern/legacy-compat` installiert die dokumentierten
Window-Globals, die ältere Erweiterungen erwarten:

- `window.SillyTavern` — mit `getContext()`, `eventSource` und
  `event_types`.
- `window.eventSource` — die Legacy-Ereignisquelle.
- `window.event_types` — die Konstanten der Ereignisnamen.
- `window.extension_settings` — das gemeinsame
  Erweiterungseinstellungs-Objekt.
- `window.$` und `window.jQuery` — die gebündelte jQuery-Instanz.

Diese Globals werden idempotent installiert und über eine Brücke mit dem
Host verbunden, sodass Legacy-Code denselben Kontext und dieselben
Ereignisse lesen kann wie nativer Code.

## Nicht verwaltete DOM-Inseln

Legacy-Frontend-Erweiterungen erwarten, ein Stück der Seite zu besitzen.
Der Host stellt dafür nicht verwaltete DOM-Inseln bereit: einen stabilen
Container, an den sich Legacy-Code direkt anbinden und den er direkt
manipulieren kann, außerhalb des React-Baums. Erweiterungen erhalten den
Container, und der Host verwaltet den Rest der Anwendung darum herum.

## Legacy-Server-Plugins

Legacy-Server-Plugins laufen über einen Express-kompatiblen Host. Ihre
Routen werden unter `/api/plugins/{pluginId}/...` geproxt, also im selben
Namensraum, den native Backend-Plugins verwenden. Die
`@fastify/express`-Integration wird nur innerhalb dieser
Kompatibilitätsebene verwendet — der neue Kern ist Fastify-nativ und
leitet nicht über Express.

## Die Vertrauensgrenze

Legacy-Einstiegspunkte sind ein vertrauter Modus, keine Sandbox-Umgehung.
Ein Paket, das sie verwendet, muss `legacy.frontend` oder `legacy.backend`
in seinem Manifest deklarieren und die Berechtigung `legacy.trusted`
anfordern, die die Einwilligungsoberfläche mit einer verstärkten Warnung
anzeigt. Legacy-Frontend-Code wird im Hauptfenster ausgeführt, und
Legacy-Backend-Code erhält einen Express-Router, der auf seinen eigenen
Plugin-Namensraum beschränkt ist. Der Sichere Modus lädt Legacy-Einstiegs-
punkte überhaupt nicht. Details finden Sie unter
[Plugin-Sandboxing](plugin-sdk/sandboxing.md) und
[Plugin-Manifest](plugin-sdk/manifest.md).

## Was nicht unterstützt wird

Kompatibilität ist ein dokumentierter Vertrag, kein Versprechen universellen
Verhaltens. Plugins, die von einem der folgenden Punkte abhängen, werden
nicht unterstützt:

- Beliebige interne CSS-Klassennamen.
- Monkey-Patching von Anwendungs-Interna.
- Private Importe aus Paketen, die sie nicht besitzen.

Das sind Implementierungsdetails, die sich zwischen Versionen ändern. Wenn
sich eine Legacy-API ändert, wird die Änderung mit einem Migrationsleitfaden
und einem Kompatibilitätstest ausgeliefert.

## Migration nach vorn

Für neue Funktionen ist das native [Plugin SDK](plugin-sdk/index.md) der
unterstützte Weg: versioniert, berechtigungsgeprüft, sandboxed und vom Host
bereinigt. Legacy-Kompatibilität existiert, um bestehende Erweiterungen am
Leben zu halten, nicht um zu wachsen. Portieren Sie Erweiterungen auf das
SDK, um die vollen Sicherheits- und Lebenszyklusgarantien zu erhalten.
