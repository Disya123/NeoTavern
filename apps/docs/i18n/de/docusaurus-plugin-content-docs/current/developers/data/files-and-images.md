---
title: Dateien und Bilder
description: >-
  Wie Benutzerdateien auf der Festplatte gespeichert werden: Originale
  getrennt vom Cache, die Bildimport-Pipeline, Thumbnails und atomare
  Schreibvorgänge.
sidebar_position: 3
---

Benutzerdateien werden auf der Festplatte gespeichert, nie als BLOBs:
Originale liegen in `data/files/`, regenerierbare Thumbnails in
`data/cache/thumbnails/`, und jeder Schreibvorgang ist atomar.

## Originale vs. Cache

Die Trennung ist strikt:

- **Originale** — `data/files/{avatars,backgrounds,attachments,audio,generated}/`.
  Originale werden nie geändert und nie durch die Cache-Wartung gelöscht.
- **Cache** — `data/cache/thumbnails/`. Thumbnails sind regenerierbar und
  inhaltsadressiert.

Das Leeren des Caches entfernt nie Originale. Ein fehlendes Thumbnail wird
automatisch aus dem Original regeneriert.

## Die Bildimport-Pipeline

Das Importieren eines Bildes folgt einer festen Pipeline:

1. Größe, MIME-Typ und Erweiterung validieren.
2. Einen Inhalts-Hash (SHA-256) berechnen.
3. Das Original verlustfrei und inhaltsadressiert speichern
   (`{sha256}{ext}`), was nach Inhalt dedupliziert.
4. Thumbnails in niedriger Auflösung für Galerien, Listen und Vorschauen
   erzeugen.
5. Thumbnails in `data/cache/thumbnails/` speichern.
6. Jedes Thumbnail nach dem Hash des Originals, der Zielgröße und der
   Algorithmusversion schlüsseln: `{hash}-{size}-v{algorithmVersion}`.
7. Kein Thumbnail regenerieren, dessen Schlüssel unverändert ist.
8. Das Original nie laden, wo ein Thumbnail genügt.
9. Den Cache automatisch neu aufbauen, wenn ein Thumbnail fehlt.
10. Cache-Leerung berührt nie Originale.

## Atomare Schreibvorgänge

Jeder Dateischreibvorgang läuft über eine temporäre Datei, gefolgt von
einer Umbenennung. Ein Absturz in der Mitte hinterlässt nie eine teilweise
geschriebene Datei. Das gilt gleichermaßen für Originale, Thumbnails und
heruntergeladene Tokenizer-Dateien.

## Charaktergalerie

Galeriebilder verwenden die `attachments`-Tabelle mit
`owner_type = character.gallery` wieder. Metadatenzeilen halten die URLs
des Originals und seines Thumbnails; die Bytes bleiben im
inhaltsadressierten `files/avatars/`. Das Entfernen eines Bildes aus der
Galerie löscht den Attachment-Datensatz, nicht die Originaldatei — die
Aktion bleibt umkehrbar, und die Deduplizierung bleibt erhalten.

## Chat-Hintergründe

`files/backgrounds/` ist die Quelle der Wahrheit: Die Liste wird durch
Scannen des Verzeichnisses erstellt, sodass aus SillyTavern importierte
Hintergründe ohne Übertragungsschritt erscheinen. Hochgeladene Dateien
werden inhaltsadressiert gespeichert und nie geändert.

Hintergrund-Thumbnails liegen in `cache/thumbnails/`, geschlüsselt nach dem
SHA-256 des Dateinamens statt nach dem Inhalt, wodurch auch aus
SillyTavern importierte Dateien mit beliebigen Namen Thumbnails erhalten
und Upload, Liste und Löschung auf einem Schlüssel bleiben. Eine Datei, die
nicht dekodiert werden kann oder 64 MiB überschreitet, wird ohne Thumbnail
aufgelistet; das Original bleibt verfügbar. Das Löschen eines Hintergrunds
entfernt sowohl das Original als auch sein gecachtes Thumbnail.

## Charakterkarten-Importe

`POST /api/v2/characters/import` akzeptiert JSON-Character-Cards V1/V2 und
PNGs mit `chara`-Metadaten. Die Eingabe ist auf 25 MiB begrenzt und wird
nach Inhalt erkannt. Der SHA-256 der gesamten Quelldatei wird in
`ext._st2.importHash` gespeichert, und der erneute Import derselben Datei
gibt den vorhandenen Datensatz zurück. PNGs werden durch einen
Bilddecoder validiert. Das Original wird atomar nach `files/avatars/`
geschrieben und ein WebP-Thumbnail erzeugt; ein fehlendes Thumbnail wird
beim nächsten Lesen aus dem Original neu aufgebaut.

## Cache-Wartung

Der Diagnosebildschirm ruft `DELETE /api/v2/diagnostics/cache` auf, das nur
die Dateien in `cache/thumbnails/` und ihre `cache_metadata`-Zeilen
entfernt. Die Wurzel `cache/` bleibt erhalten, sodass aktive
Migrations-Staging-Verzeichnisse nie unterbrochen werden. Das Ergebnis
meldet Anzahl und Größe der entfernten Dateien; die erneute Ausführung ist
sicher und gibt Nullen zurück.
