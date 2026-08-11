---
title: Plugin-Manifest
description: Das plugin.json-Schema, das jedes .stplugin-Paket enthalten muss.
sidebar_position: 2
---

Das Plugin-Manifest (`plugin.json`) ist die einzige Quelle der Wahrheit für
ein Plugin: Identität, Einstiegspunkte, angeforderte Berechtigungen und
deklarierte Fähigkeiten.

## Paketstruktur

Ein `.stplugin`-Paket ist ein ZIP-Archiv, das `plugin.json` an der Wurzel,
die referenzierten Einstiegsdateien und etwaige Assets enthält. Der Host
validiert das Archiv, bevor etwas installiert wird: Pfad-Traversal,
Symlinks, ausführbare Nutzlasten und Größenbegrenzungen werden alle
abgelehnt.

## Manifest-Felder

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

Die Kernfelder sind:

- **`id`** — Reverse-DNS-Identifier, zum Beispiel `author.plugin-name`. Er
  ist über alle installierten Plugins eindeutig und über Updates stabil.
- **`name`** — der menschenlesbare Name, der im Plugin-Manager angezeigt
  wird.
- **`version`** — semantische Version (`major.minor.patch`). Sie speist
  Versionsvergleiche und Cache-Busting.
- **`apiVersion`** — die SDK-API-Version, gegen die das Plugin zielt. Die
  aktuelle Version ist 3; Version 2 bleibt der Standard, bis die neue
  Laufzeit in Produktion geht.
- **`engines`** — Kompatibilitätseinschränkungen wie `neotavern: "^0.1.0"`.
- **`frontend`** — relativer Pfad zum Browser-ESM-Einstiegspunkt.
- **`backend`** — relativer Pfad zum Node.js-ESM-Einstiegspunkt.
- **`styles`** — optionales Plugin-Stylesheet.
- **`i18n`** — Sprachcode zu relativem Pfad der Übersetzungs-JSON-Dateien.

## Berechtigungen

Das `permissions`-Array ist die Legacy-Flachliste aus SDK v2. Neue
Manifeste sollten stattdessen bereichsgebundene Fähigkeiten über
`requiredCapabilities` und `optionalCapabilities` deklarieren:

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` sind Fähigkeiten, ohne die das Plugin nicht arbeiten
kann; `optionalCapabilities` sind solche, auf die es verzichten kann. Der
Benutzer bestätigt bei der Installation jede angeforderte Fähigkeit. Das
Hinzufügen neuer Berechtigungen in einem Update erfordert eine erneute
Einwilligung — siehe [Berechtigungen](permissions.md).

## Legacy-Einstiegspunkte

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

Der `legacy`-Block zeigt auf vertraute Kompatibilitätseinstiegspunkte für
bestehende SillyTavern-Erweiterungen. Pakete, die einen der Einstiegspunkte
verwenden, müssen die Berechtigung `legacy.trusted` anfordern, und die
Oberfläche zeigt während der Einwilligung eine stärkere Warnung. Der
Sichere Modus lädt Legacy-Einstiegspunkte nie. Wie sich das von nativen
Plugins unterscheidet, finden Sie unter [Sandboxing](sandboxing.md).

## OAuth-Clients

Plugins, die sich mit einem externen Dienst verbinden, können öffentliche
OAuth-2.0-Clients mit Authorization-Code-Flow und PKCE deklarieren:

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

Nur öffentliche Clients sind erlaubt: `clientSecret` ist verboten, weil
Plugin-Code in einer Sandbox läuft. Endpunkte müssen HTTPS sein, mit einer
Loopback-Ausnahme für Klartext-HTTP bei lokalen Identity-Providern während
der Entwicklung. Das Ändern eines Deskriptors erfordert die Neuinstallation
des Pakets.

## Worker- und Signaturfelder

Fortgeschrittene Manifeste können zusätzliche Module deklarieren:

- **`workers`** — paketrelative Einstiegsmodule, die das Plugin als
  isolierte Compute-Worker starten darf. Das Starten eines nicht
  deklarierten Einstiegspunkts wird abgelehnt.
- **`publisher`** und **`signature`** — Paketsignierung. `keyId` ist der
  `ed25519:<hex>`-Fingerabdruck des signierenden öffentlichen Schlüssels,
  und `signature` ist die base64-Ed25519-Signatur über das kanonische
  Manifest. Diese werden vom Plugin-Build-Tool gesetzt, nie von Hand
  geschrieben.

Die Funktion `validateManifest` im SDK prüft jedes Feld, und die generierte
[Plugin-SDK-Referenz](../../api/plugin-sdk/) dokumentiert den exakten Typ
`PluginManifest`.
