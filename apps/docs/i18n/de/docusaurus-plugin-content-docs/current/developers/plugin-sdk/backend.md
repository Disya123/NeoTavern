---
title: Backend-Plugin-API
description: Die eingeschränkten Server-seitigen Abstraktionen, die ein Backend-Plugin erhält.
sidebar_position: 5
---

Die Backend-API ist das, was ein Server-seitiges Plugin in seinem
`activate()`-Aufruf erhält: eingeschränkte Abstraktionen für Routen,
Speicher, Ereignisse, Protokollierung, Netzwerkzugriff, Anbieter und
Dateien — und sonst nichts.

## Einstiegspunkt

Ein Backend-Plugin exportiert eine Definition mit einer
`activate(api)`-Funktion, die das `ServerPluginApi`-Objekt erhält:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

Der Backend-Einstiegspunkt läuft als separater Node.js-Prozess. Das Plugin
erhält nie die Fastify-Root-Instanz, die SQLite-Verbindung, interne
Tabellen, absolute Pfade, die vollständige Umgebung oder die
API-Schlüssel anderer Anbieter.

## Routen

`api.routes` ist ein bereichsgebundener Router, der unter
`/api/plugins/{pluginId}/` gemountet ist. Jede Methode nimmt einen Pfad und
einen Handler und gibt eine Bereinigungsfunktion zurück:

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

Eine `PluginRequest` trägt `params`, `query`, `headers`, einen geparsten
JSON-`body` und ein `AbortSignal`. Eine `PluginResponse` ist
`{ status, body, headers }`. Handler können direkt einen Wert oder ein
Promise zurückgeben; der Host erzwingt Timeouts und bricht Arbeit über das
Signal ab.

## Speicher

`api.storage` ist ein benannter Schlüssel/Wert-Speicher, der pro Plugin
isoliert ist:

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

Daten sind auf Ihre Plugin-ID begrenzt, sodass zwei Plugins nie kollidieren
können.

## Ereignisse und Protokollierung

`api.events` ist derselbe typisierte Ereignisbus, den das Frontend nutzt.
Das Abonnieren gibt eine Abmeldefunktion zurück, und alle Abonnements
werden bei Deaktivierung, Absturz oder Herunterfahren automatisch entfernt.
Das Ausgeben ist auf Ihren eigenen Namensraum (`{pluginId}.event`)
beschränkt, Nutzlasten müssen JSON-sicher sein, und der Host begrenzt die
Nutzlastgröße und die Anzahl der Ereignisnamen pro Laufzeit.

`api.logger` stellt `debug`, `info`, `warn` und `error`-Methoden bereit,
die jeweils eine Nachricht und optionale Metadaten entgegennehmen. Logs
enthalten nie Geheimnisse.

## Berechtigungsgeprüftes Fetch

`api.fetch` ist ein `fetch`, das durch die `network:<host>`-Berechtigungen
des Plugins geschützt ist:

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

Anfragen an nicht gewährte Hosts werden vor jeglicher Netzwerkaktivität
abgelehnt. Geheimnisse anderer Anbieter werden nie in Ihre Anfragen
injiziert. Das Antwortobjekt stellt `ok`, `status`, `text()` und `json()`
bereit.

## Anbieter und Kontextstrategien

`api.providers` ermöglicht es einem Plugin, die Generierung zu erweitern:

- `api.providers.register(kind, factory, options)` registriert eine neue
  Anbieter-Adapter-Art (erfordert `providers.register`). Die Registrierung
  gibt eine Bereinigungsfunktion zurück.
- `api.providers.registerTokenizer(profile)` registriert einen lokalen
  modellspezifischen Tokenizer. Ein Profil deklariert `id`, `approximate`,
  `matches(model)` und `count(text)`. Exakte Tokenizer können aus tiktoken,
  SentencePiece oder Hugging-Face-Tokenizer-JSON gebaut werden; bis ein
  solcher für ein Modell registriert ist, fällt der Host auf eine
  skriptbewusste Heuristik zurück und markiert Zählungen als Näherung. Die
  Registrierung wird beim Deaktivieren automatisch entfernt.

`api.contextStrategies.register(strategy)` fügt eine
Kontext-Shifting-Strategie hinzu. Der Host verifiziert, dass System-,
angeheftete und aktuelle Benutzerblöcke überleben, und wendet das finale
Token-Budget selbst an — der Wert `fitsBudget`, den eine Strategie
zurückgibt, wird nicht vertraut.

`api.postProcessors.register(processor)` fügt einen
Nachbearbeitungs-Hook hinzu. Er läuft nach Abschluss des Streams und vor
dem Speichern der Nachricht; die Rückgabe einer neuen Zeichenkette ersetzt
die Assistenzantwort. Er erfordert `prompt.modify`.

## Virtuelles Dateisystem

`api.files` ist ein sandboxed virtuelles Dateisystem, dessen Wurzel das
eigene Datenverzeichnis des Plugins ist:

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

Pfade können die Plugin-Wurzel nicht verlassen, sodass ein Plugin nur seine
eigenen Daten berühren kann.

## Was ein Backend-Plugin nicht kann

Die API-Oberfläche ist bewusst klein. Es gibt keinen Weg zur Host-Datenbank,
zum Speicher anderer Plugins, zu beliebigen Dateisystempfaden oder zu
ungeprüften Netzwerk-Hosts. Wenn das SDK es nicht exponiert, ist es nicht
zugänglich. Die generierte [Plugin-SDK-Referenz](../../api/plugin-sdk/) listet
die vollständige `ServerPluginApi`-Oberfläche auf, und
[Anbieter](../providers/index.md) erklärt, wie Anbieter-Plugins in das
Modell passen.
