---
title: Gruppen
description: Wie NeoTavern Gespräche mit mehreren Charakteren und Gruppenchats behandelt.
sidebar_position: 4
---

Diese Seite erklärt, was Gruppen sind und wie NeoTavern heute Gespräche mit
mehreren Charakteren behandelt.

## Was eine Gruppe ist

Eine Gruppe ist ein einzelnes Gespräch, an dem mehrere Charaktere
teilnehmen. Während ein normaler Chat einen Charakter plus Ihre Persona hat,
wechselt ein Gruppenchat zwischen Charakteren, sodass jede Antwort von einem
anderen Teilnehmer stammen kann.

## Gruppen in NeoTavern heute

Das Kern-Chatmodell von NeoTavern ist ein Charakter pro Gespräch, mit Ihrer
Persona darüber. Eine dedizierte Gruppenchat-Funktion, mit der Sie ein
Gespräch erstellen und seine Mitglieder in der App wechseln können, ist
**geplant**; sie ist in der aktuellen Version nicht verfügbar, daher
beschreibt diese Seite, was heute funktioniert.

## Importierte Gruppenchats

Wenn Sie ein SillyTavern-Backup über Einstellungen → Daten migrieren, werden
Gruppenchats sicher behandelt:

- Gruppendefinitionen und ihre Transkripte werden als normale Chats
  importiert, wobei der ursprüngliche Gruppen-Datensatz in den
  Chat-Metadaten erhalten bleibt.
- Das Transkript behält jeden Teilnehmernamen, jede Nachricht und jede
  Swipe-Variante, sodass die mehrstimmige Historie lesbar bleibt und Sie das
  Gespräch fortsetzen können.
- Nicht unterstützte Kategorien werden im Importbericht explizit aufgelistet,
  statt stillschweigend verworfen zu werden.

## Mit mehreren Charakteren arbeiten

Während native Gruppen geplant sind, decken diese Funktionen die gängigen
Mehr-Charakter-Abläufe ab:

- **Getrennte Chats pro Charakter.** Jeder Charakter behält seinen eigenen
  Chatverlauf, und das Chats-Panel begrenzt die Liste auf den aktuellen
  Charakter.
- **Eine gemeinsame Welt über Lorebooks.** Binden Sie ein Lorebook an
  mehrere Charaktere, damit konsistentes Weltwissen jedes Gespräch erreicht.
  Siehe [Lorebooks](lorebook).
- **Storyline-Branches.** Nutzen Sie Checkpoints und Branches, um mit jedem
  Charakter abweichende Pfade zu erkunden, ohne die Hauptkonversation zu
  verlieren. Siehe [Chatten](chat).
- **Personas.** Wechseln Sie Ihre eigene Persona pro Chat, um zu ändern, wie
  Sie sich in jedem Gespräch präsentieren.

Wenn Sie ein echtes Mehr-Charakter-Gespräch benötigen, denken Sie an den
importierten Gruppenchat-Ansatz: Er erhält Ihre vorhandene Gruppenhistorie,
und die geplante native Funktion wird auf denselben Daten aufbauen.
