---
title: Einstellungen
description: Globale und pro Chat geltende Einstellungen, Verbindungsprofile, Anbieter und API-Schlüssel in NeoTavern.
sidebar_position: 7
---

Diese Seite erklärt, wo Einstellungen in NeoTavern liegen und wie Sie
Anbieter, Verbindungsprofile und API-Schlüssel konfigurieren.

## Wo Einstellungen liegen

NeoTavern hat keine separate Einstellungsseite. Alles öffnet sich als Panel
oder Modal über dem Chat-Arbeitsbereich, und das Schließen bringt Sie exakt
zu demselben Chat und Entwurf zurück:

- **Einstellungen** (über die Navigationsleiste) bündeln appweite Optionen in
  Tabs: **Allgemein** (Sprache, Textgröße, Startbildschirm, Nachrichtenstil,
  Avatar-Form, Barrierefreiheit), **Themes** (Themes installieren und
  aktivieren) und **Daten** (Migration, Backups, Cache-Wartung,
  Diagnose).
- **KI-Einstellungen** ist das Kontextpanel für die Generierung. Sein
  Tab **Konfiguration** hält die Anfrageparameter für das aktive Modell:
  Kontextgröße, Antwortlänge, Streaming, Sampling, Penalties, Seed und
  Reasoning. Der Tab **API** verwaltet Verbindungsprofile und Schlüssel, und
  **Erweitert** baut eigene Chat- und Instruct-Vorlagen aus ChatML, Llama 3
  oder Alpaca.

Einstellungsänderungen werden dort sofort wirksam, wo sie leicht umkehrbar
sind. Optionen, die von ihren Standardwerten abweichen, sind markiert und
einzeln zurücksetzbar, und die Einstellungssuche deckt Namen,
Beschreibungen und Schlüsselwörter ab.

## Global vs. pro Chat

Globale Einstellungen in **Einstellungen** gelten für die ganze App:
Sprache, Theme, Datenverwaltung und Standardwerte. Das Verhalten pro Chat
lebt neben dem Chat: Generierungsparameter, aktiver Anbieter und Modell
sowie die Kontextstrategie werden im Panel KI-Einstellungen bearbeitet,
während der Chat geöffnet bleibt, und Entwürfe und Scrollposition bleiben
erhalten. Die Persona ist ebenfalls pro Chat — jedes Gespräch kann eine
andere Persona verwenden, während die appweite aktive Persona der
Standard bleibt.

## Anbieter und Verbindungsprofile

Ein Verbindungsprofil bündelt alles, was für die Kommunikation mit einem
Anbieter nötig ist: API-Typ und -Quelle, Basis-URL sofern zutreffend, den
ausgewählten API-Schlüssel und das Modell. Der Tab **API** in den
KI-Einstellungen (und der Bereich Anbieter) ermöglicht Ihnen Folgendes:

1. Wählen Sie die übergeordnete API (Chat Completions oder Text
   Completions).
2. Wählen Sie eine Quelle, die auf die Quellen dieser API filtert und zum
   Profilnamen wird.
3. Geben Sie für OpenAI-kompatible Server die Basis-URL ein, die in der
   Regel auf `/v1` endet.
4. Wählen oder tippen Sie eine Modell-ID und laden Sie optional zuerst die
   Modellliste.
5. **Verbindung testen**, um Verfügbarkeit und Latenz zu prüfen, dann
   **Verbinden**, um das Profil zu aktivieren.

## API-Schlüssel

Schlüssel werden lokal in einer Schlüsselverwaltung gespeichert, die pro
Anbieter mehrere benannte Schlüssel hält, wobei jeweils einer aktiv ist.
Geheimnisse werden vor dem Speichern verifiziert und danach nie mehr
vollständig angezeigt — nur noch ein maskierter Rest bleibt sichtbar.
Exporte und Diagnosen schließen Geheimnisse standardmäßig aus, und
Anbieterfehler werden als lokalisierte Meldungen mit technischen Details und
einer Trace-ID in einem einklappbaren Block angezeigt.

Die übrigen appweiten Einstellungen finden Sie unter [Themes](themes),
[Erweiterungen](extensions) und [Daten & Backups](data-and-backups).
