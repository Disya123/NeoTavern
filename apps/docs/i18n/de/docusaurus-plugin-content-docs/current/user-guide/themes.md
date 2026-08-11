---
title: Themes
description: Themes in NeoTavern installieren, wechseln und erstellen, plus Sicherer Modus.
sidebar_position: 8
---

Diese Seite erklärt, wie Themes in NeoTavern funktionieren: was sie ändern
können, wie Sie sie installieren und wechseln und wie Sie der Sichere Modus
schützt.

## Was ein Theme ändert

Ein Theme hat drei Ebenen:

- **Design-Tokens** — Farben, Schriftarten, Abstände, Radien, Schatten und
  Bewegungsdauern.
- **Komponenten-Skin** — das Aussehen von Schaltflächen, Panels und anderen
  Steuerelementen.
- **Shell-Layout** — die Anordnung benannter Bereiche: Navigation,
  Charakterbrowser, Chat-Ansichtsfenster, Seitenpanels und Modal-Ebene.

Themes sind also vollständige visuelle Umgestaltungen, nicht nur
Farbwechsel. Ein Theme kann die App wie eine Spielkonsole, eine
Visual-Novel oder einen Mobile-Client umgestalten, ohne die Chat-Logik zu
ändern. Das Wechseln von Theme, Komponenten-Skin oder Shell-Layout erfordert
nie einen Neustart.

## Gebündelte Themes

Der Erststart legt eine Reihe integrierter Themes an, darunter AMOLED,
GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night und Catppuccin
Mocha. Der Themes-Manager öffnet immer mit diesen verfügbaren Optionen, sodass
Sie Stile sofort wechseln können.

## Themes installieren

Ein Theme-Paket ist eine `.sttheme`-Datei — ein ZIP mit einem
`theme.json`-Manifest und CSS, bis zu 25 MB. Installieren Sie es über den
Themes-Manager:

1. Öffnen Sie Themes über die Navigationsleiste oder den Tab Einstellungen →
   Themes.
2. Installieren Sie das Paket. Der Server validiert Pfade, Dateitypen,
   Größen und das Manifest, bevor etwas geschrieben wird, und lehnt
   Traversal-Pfade, Symlinks und verbotenes CSS ab.
3. Zeigen Sie das Theme vor dem Anwenden in der Vorschau an. Von der Vorschau
   aus können Sie das Theme akzeptieren, zurückgehen oder seine Einstellungen
   öffnen.
4. Aktivieren Sie es. Die Installation aktiviert ein Theme nie von selbst.

Updates eines installierten Themes ersetzen es atomar und behalten seinen
Aktivierungszustand. Wenn ein Theme nicht geladen werden kann, stellt die
Shell automatisch das letzte funktionierende Layout wieder her.

## Eigene Themes

Themes sind Pakete, keine Hacks: Ein Theme erhält keinen Zugriff auf Ihre
Chats, API-Schlüssel oder das Dateisystem. Das Theme SDK dokumentiert die
stabilen Hooks — `data-component`, `data-part`, `data-role` und
`data-state` — die Themes gestalten, sowie den Shell-Vertrag, der die
benannten Bereiche definiert. Eigene CSS-Überschreibungen werden in der
Kaskade zuletzt geladen. Informationen zum Erstellen eigener Themes finden
Sie in der [Theme-SDK-Referenz](../developers/theme-sdk/).

## Sicherer Modus und Wiederherstellung

Der Sichere Modus deaktiviert alle Drittanbieter-Themes und -Plugins und ist
erreichbar, bevor sie geladen werden, sodass ein defektes Theme Sie nie
aussperren kann. Nach einer Absturzschleife bietet die App automatisch einen
sicheren Start an. Die integrierte Aktion **Oberfläche zurücksetzen** stellt
das Standard-Theme wieder her, ohne Dateien von Hand zu bearbeiten, und kein
Theme darf diese Aktion ausblenden.

Den Tab Allgemein, in dem das aktive Theme und die
Nachrichtenstil-Optionen liegen, finden Sie unter [Einstellungen](settings).
