---
title: Schnellstart
description: Anbieter verbinden, Charakter auswählen und die erste Nachricht in NeoTavern senden.
sidebar_position: 3
---

Diese Seite führt Sie in etwa fünf Minuten von einer frischen Installation zu
Ihrer ersten generierten Nachricht. Sie benötigen einen aktiven Anbieter;
alles andere ist optional.

## 1. App starten

Öffnen Sie NeoTavern. Der Startbildschirm öffnet sich direkt, und beim
Erststart wird eine nicht blockierende Checkliste angezeigt, in der Sie Ihre
Sprache und Textgröße wählen. Sie können die Checkliste ignorieren und später
wieder aufrufen — nichts davon blockiert die Charaktergalerie, Importe oder
lokale Einstellungen.

## 2. Anbieter verbinden

Für die Generierung benötigen Sie einen Anbieter: einen lokalen
Modell-Server auf Ihrem Rechner oder eine Remote-API. Öffnen Sie das Panel
KI-Einstellungen oder den Bereich Anbieter:

1. Wählen Sie einen API-Typ (zum Beispiel Chat Completions) und eine Quelle,
   die den Anbieter definiert.
2. Geben Sie Ihren API-Schlüssel ein. Schlüssel werden lokal gespeichert,
   nach dem Speichern nie vollständig angezeigt und sind standardmäßig nie
   in Exporten enthalten.
3. Laden Sie optional die Modellliste für diesen Anbieter und wählen Sie ein
   Modell.
4. Verwenden Sie **Verbindung testen**, um Verfügbarkeit und Latenz zu
   prüfen, und dann **Verbinden**, um das Profil zu aktivieren.

Noch kein Anbieter? Wählen Sie den integrierten **Echo**-Anbieter, um die
gesamte Pipeline offline zu testen. Echo antwortet mit einer vorgefertigten
Echo-Nachricht und benötigt weder Schlüssel noch Netzwerkzugriff.

Solange kein Anbieter aktiv ist, ist die Senden-Schaltfläche deaktiviert und
die App zeigt daneben den Grund. Anbieterfehler sperren Sie nie aus Ihrer
lokalen Bibliothek aus.

## 3. Charakter auswählen oder erstellen

Öffnen Sie den Bereich Charaktere über die Navigationsleiste:

- Durchsuchen Sie die Galerie und öffnen Sie eine Karte, um mit dem Chatten
  zu beginnen.
- Importieren Sie eine Charakterkarte (PNG oder JSON) von der Festplatte.
- Erstellen Sie einen neuen Charakter von Grund auf — nur ein Name ist
  erforderlich.

Die vollständigen Details finden Sie unter [Charaktere](../user-guide/characters).

## 4. Erste Nachricht senden

Wenn ein Charakter ausgewählt ist, öffnet sich die Chat-Fläche mit der
Begrüßung des Charakters als erster Assistenznachricht. Tippen Sie unten und
drücken Sie `Enter` zum Senden. Der Chat wird erst auf dem Backend erstellt,
nachdem Sie eine erste nicht leere Nachricht gesendet haben — beim Stöbern
bleiben also keine leeren Chats zurück.

Die Antwort wird gestreamt, während sie generiert wird. Sie können sie
jederzeit stoppen oder während des Streamens im Verlauf zurückblättern. Was
die Chat-Ansicht alles kann, erfahren Sie unter [Chatten](../user-guide/chat).

## Nächste Schritte

- [Fehlerbehebung](troubleshooting), wenn das Backend nicht startet oder ein
  Port bereits belegt ist.
- [Einstellungen](../user-guide/settings), um Generierungsparameter und
  Verbindungsprofile anzupassen.
- [Daten & Backups](../user-guide/data-and-backups), um ein vorhandenes
  SillyTavern-Backup zu importieren oder eigene Backups zu erstellen.
