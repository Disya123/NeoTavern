---
title: Plugin-Berechtigungen
description: Wie Berechtigungen deklariert und erteilt werden und wann ein Update eine erneute Einwilligung erfordert.
sidebar_position: 3
---

Berechtigungen sind der Mechanismus, mit dem Benutzer entscheiden, was ein
Plugin tun darf — vom Lesen der Chat-Historie bis zu Netzwerkanfragen.

## Das Berechtigungsmodell

Eine Berechtigung ist eine Zeichenkette, die eine Fähigkeit benennt. Sie im
Manifest zu deklarieren ist eine Anfrage, kein automatischer Zugriff: Der
Benutzer muss jede angeforderte Berechtigung bestätigen, bevor das Plugin
aktiv wird, und der Host setzt die Gewährung an jedem Verwendungsort durch.

Der integrierte Satz ist ein stabiler, versionierter Vertrag:

| Berechtigung         | Was sie gewährt                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `chat.read`          | Chat-Nachrichten und ihre Metadaten lesen                              |
| `chat.write`         | Chat-Nachrichten erstellen oder ändern                                 |
| `characters.read`    | Charaktere und Charakterkarten lesen                                   |
| `characters.write`   | Charaktere erstellen oder ändern                                       |
| `lorebook.read`      | Lorebook-Einträge lesen                                                |
| `lorebook.write`     | Lorebook-Einträge erstellen oder ändern                                |
| `prompt.inspect`     | Den zusammengesetzten Prompt prüfen                                    |
| `prompt.modify`      | Den Prompt ändern oder Generierungsausgabe nachbearbeiten              |
| `providers.register` | Anbieter-Adapter und Tokenizer registrieren                            |
| `ui.toolbar`         | Toolbar-Aktionen hinzufügen                                            |
| `ui.sidebar`         | Seitenleisten-Panels hinzufügen                                        |
| `ui.messageActions`  | Nachrichtenaktionen hinzufügen                                         |
| `ui.shell`           | Inhalt zu Shell-Slots hinzufügen                                       |
| `clipboard.read`     | Die Zwischenablage lesen                                               |
| `clipboard.write`    | In die Zwischenablage schreiben                                        |
| `notifications`      | Benachrichtigungen anzeigen                                            |
| `server.routes`      | Backend-Routen mounten                                                 |
| `legacy.trusted`     | Dokumentierten SillyTavern-Legacy-Code im vertrauten Kontext ausführen |

## Bereichsgebundene Berechtigungen

Einige Berechtigungen tragen einen Gültigkeitsbereich, geschrieben als
`kind:scope`:

- **`network:<hostname>`** — Berechtigung, von einem bestimmten Host zu
  holen, zum Beispiel `network:api.example.com`. Anfragen an Hosts, die
  nicht gewährt sind, werden abgelehnt.
- **`network:*`** — ein Wildcard, der das Holen von jedem Host erlaubt. Der
  Host behandelt ihn als vollen Netzwerkzugriff, und die
  Einwilligungsoberfläche zeigt ihn mit einer verstärkten Warnung. Bevorzugen
  Sie konkrete Hosts; die Veröffentlichung von Plugins, die den Wildcard
  anfordern, ist nicht erwünscht.
- **`files:plugin`** — Lesen und Schreiben im eigenen Datenverzeichnis des
  Plugins.
- **`files:user-selected`** — Zugriff auf Dateien, die der Benutzer explizit
  ausgewählt hat.

`hasPermission` prüft einen gewährten Satz gegen eine angeforderte
Berechtigung, und `parsePermission` zerlegt eine `kind:scope`-Zeichenkette
in ihre Teile. Die Funktion `validatePermissions` lehnt fehlerhafte
Zeichenketten wie leere, doppelte oder unbekannte Berechtigungen ab.

## Wie Gewährungen durchgesetzt werden

Eine Berechtigung zu deklarieren reicht nicht; der Host wendet die
Gewährung am Durchsetzungspunkt an:

- UI-Registrierungen prüfen `ui.*`-Berechtigungen vor dem Mounten.
- Routen prüfen `server.routes`.
- Das berechtigungsgeprüfte `fetch` prüft `network:<host>`.
- Das virtuelle Dateisystem prüft `files:*`.
- Anbieter- und Kontext-APIs prüfen `providers.register` und
  `prompt.modify`.

Der Fähigkeitskernel (Namensraum `kernel` von `@neotavern/plugin-sdk`) ist die
gemeinsame Ebene, die Gewährungen sowohl im Web-Host als auch im Server
prüft, sodass Browser und Backend immer dieselben effektiven Rechte sehen.
Gewährungen werden mit einer monotonen Revision gespeichert, während des
Bootstrap-Handshakes an die Sandbox geliefert und zur Laufzeit widerrufbar.
Laufende Vorgänge schließen mit einem `CAPABILITY_REVOKED`-Fehler ab, und
offene Handles werden vom Host geschlossen.

## Einwilligung und erneute Einwilligung bei Updates

Die Installation zeigt die vollständige Liste der angeforderten
Berechtigungen. Das Plugin bleibt im Zustand `needs-consent`, bis Sie jede
Berechtigung bestätigen, und die Oberfläche zeigt die Abhängigkeitsliste,
wenn das Paket npm-Abhängigkeiten mitbringt.

Das Aktualisieren eines Plugins ist für die Berechtigungsprüfung eine neue
Installation: Der Host berechnet die Differenz zwischen dem vorherigen und
dem neuen Manifest mit `diffPermissions`. Wenn das Update Berechtigungen
hinzufügt:

- die Laufzeit des Plugins wird sofort deaktiviert;
- der Benutzer wird um Einwilligung für die neuen Berechtigungen gebeten;
- das Plugin bleibt deaktiviert, bis die Einwilligung erteilt ist.

Das Entfernen von Berechtigungen erfordert nie eine Einwilligung. Die
allgemeine Regel lautet: Die Menge der gewährten Berechtigungen wächst nie
ohne eine explizite Benutzerentscheidung. Die vollständige Liste der
Berechtigungskonstanten und -helfer finden Sie in der generierten
[Plugin-SDK-Referenz](../../api/plugin-sdk/).
