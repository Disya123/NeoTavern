---
title: Lorebooks
description: Was Lorebooks sind, wie Einträge aktiviert werden und wie man sie an Charaktere bindet.
sidebar_position: 5
---

Diese Seite erklärt Lorebooks: Sammlungen von Weltwissen, die NeoTavern genau
dann in den Prompt einfügt, wenn es relevant wird.

## Was ein Lorebook ist

Ein Lorebook ist eine Sammlung von Einträgen über eine Welt, ein Setting
oder einen Charakter: Orte, Fraktionen, Geschichte, Personen, Regeln der
Magie — alles, was das Modell wissen sollte, das aber zu viele Token
verschwenden würde, um es in jede Nachricht aufzunehmen. Statt das ganze Buch
in den Prompt zu laden, aktiviert die App nur die Einträge, deren
Schlüsselwörter zum aktuellen Gespräch passen.

Ein Buch ist entweder **global** (in jedem Chat verfügbar) oder an einen
**Charakter** gebunden (nur in den Gesprächen dieses Charakters verwendet).
Sie können Bücher im Lore-Bereich des Charaktereditors pro Charakter
verknüpfen und trennen.

## Einträge

Jeder Eintrag hat:

- **Primäre Schlüsselwörter** — ein oder mehrere
  Aktivierungsschlüsselwörter. Mindestens ein primäres Schlüsselwort ist
  erforderlich.
- **Sekundäre Schlüsselwörter** — zusätzliche optionale Schlüsselwörter.
- **Inhalt** — der Text, der in den Prompt eingefügt wird, wenn der Eintrag
  ausgelöst wird.
- **Position** — wo der Eintrag relativ zu anderen Einträgen eingefügt wird.
- **Umschalter** — `enabled` (an der Aktivierung teilnehmen), `constant`
  (immer enthalten) und `selective` (nur an der konfigurierten Position
  einfügen).

Der Abgleich ist eine Groß-/Kleinschreibung-unabhängige
Teilstring-Übereinstimmung mit dem Gesprächskontext. Wenn ein Eintrag
ausgelöst wird, wird sein Inhalt an der Position des Eintrags in den Prompt
eingefügt, und der Eintragsdialog zeigt eine Schätzung seiner Größe in Token,
damit Sie das Budget planbar halten können.

## Einfügereihenfolge

Die Pipeline setzt die Prompt-Blöcke in einer festen Reihenfolge zusammen:
Haupt-Prompt, Lorebook vor dem Charakter, Persona, Charakter, Lorebook nach
dem Charakter, Dialogbeispiele, Gedächtnis, Chatverlauf, Anweisungen nach
der Historie und die aktuelle Benutzereingabe. Lorebook-Einträge werden
zusammen mit Gedächtnisblöcken nach Relevanz eingestuft, und konstante
Einträge sind immer vorhanden. Die tatsächliche Reihenfolge aktivierter
Einträge folgt ihrer Position im Buch, sodass ein gut strukturiertes Buch
einen stabilen Prompt erzeugt.

## Bücher verwalten

Das Lorebooks-Panel in der Navigationsleiste hat drei Tabs: die Liste der
Bücher, den Bueditor und die Eintragsliste. Die Liste zeigt für jedes Buch
Name, Beschreibung, Ladeanzahl und ein Gültigkeitsbereichs-Abzeichen (Global
oder Charakter), mit Filtern für globale Bücher, die Bücher eines bestimmten
Charakters oder alle Bücher. Bücher werden in einen Papierkorb-Zustand
gelöscht und können wiederhergestellt werden, und die Suche über Bücher ist
für große Bibliotheken entprellt.

Neue Bücher, die aus dem Charaktereditor erstellt werden, sind sofort an
diesen Charakter gebunden. Den Editor finden Sie unter
[Charaktere](characters), und wie Gedächtnisblöcke mit Lorebook-Einträgen
interagieren, erfahren Sie unter [Gedächtnis & Abruf](memory).
