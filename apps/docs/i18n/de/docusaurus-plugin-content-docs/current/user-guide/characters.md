---
title: Charaktere
description: Die Charaktergalerie, Charakterkarten und das Importieren oder Exportieren von Karten in NeoTavern.
sidebar_position: 3
---

Diese Seite erklärt, wie Sie Charaktere in NeoTavern finden, erstellen,
bearbeiten und teilen. Ein Charakter ist ein Teilnehmer an Ihren Chats,
gestützt durch eine Charakterkarte, die alles speichert, was die KI über ihn
weiß.

## Die Charaktergalerie

Der Bereich Charaktere ist Ihr Bibliotheksbrowser. Er unterstützt eine
Raster- und eine kompakte Listenansicht, beide virtualisiert, damit sie auch
mit Zehntausenden von Karten schnell bleiben. Für Vorschauen werden
Thumbnails verwendet; die Originalbilder werden erst beim Öffnen einer Karte
geladen.

Die Suche unterstützt eine einfache Abfragesprache: `tag:NSFW author:Name
"exact phrase" -tag:beta`. Tag- und Autor-Filter kombinieren sich mit den
Suchbegriffen, und die Ergebnisse werden nach Relevanz sortiert, sobald Sie
eine Abfrage tippen. Die Sortierung umfasst alphabetisch, neueste, älteste,
Favoriten, zuletzt verwendet, mehr oder weniger Chats, mehr oder weniger
Inhalt und zufällig.

## Charaktere erstellen und bearbeiten

Öffnen Sie eine beliebige Karte und wählen Sie Bearbeiten. Der Editor ist in
klare Gruppen unterteilt:

- **Identität** — Name, Avatar und Tags.
- **Beschreibung** — wer der Charakter ist.
- **Erste Nachricht** — die Begrüßung plus etwaige alternative Begrüßungen.
- **Szenario** — die Ausgangslage, von der das Rollenspiel ausgeht.
- **Beispiele** — Dialogbeispiele, die den Stil des Charakters prägen.
- **Lore** — an diesen Charakter gebundene Lorebooks.
- **Bilder** — eine Bildergalerie, aus der eines das Haupt-Avatar ist.
- **Erweitert** — Persönlichkeit, Notizen des Erstellers,
  Prompt-Überschreibungen, die Notiz des Charakters mit Tiefe und Rolle,
  Gesprächigkeit und Metadaten des Erstellers.

Zum Erstellen eines Charakters ist nur der Name erforderlich.
Validierungsmeldungen erscheinen neben dem Feld und in einer abschließenden
Fehlerliste, und Pflichtfelder sind mit Text gekennzeichnet, nicht nur mit
Farbe.

## Charakterkarten

Eine Charakterkarte ist die portable Darstellung eines Charakters. Ihre
Felder umfassen Name, Beschreibung, Persönlichkeit, Szenario, die erste
Nachricht (Begrüßung), alternative Begrüßungen, Tags und Avatar. Karten
tragen außerdem Notizen des Erstellers, und unbekannte Felder importierter
Karten bleiben erhalten statt verworfen zu werden, sodass beim Durchreichen
einer Karte durch ein anderes Werkzeug keine Metadaten verloren gehen.

## Karten importieren und exportieren

- **Import** akzeptiert PNG- und JSON-Charakterkarten (V1 und V2) und
  funktioniert aus der Galerie, aus einem Chat oder während des
  Erststart-Setups. Der Import ist gefahrlos wiederholbar — eine zweite
  Ausführung erzeugt nie Duplikate.
- **Export** schreibt die Karte genau wie gewünscht als PNG oder JSON, mit
  einem Versions-Snapshot des aktuellen Zustands.
- Avatare und Galeriebilder werden als Dateien hochgeladen; ein ersetztes
  Bild wird erst entfernt, wenn das neue erfolgreich gespeichert wurde.

Wenn eine Karte in Ihrer Bibliothek beschädigt ist, zeigt NeoTavern eine
sichere Vorschau mit dem Grund und ermöglicht Ihnen den Export des Originals,
damit Sie es anderweitig reparieren können.
