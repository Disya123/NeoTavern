---
title: Files and Images
description: >-
  How user files are stored on disk: originals separate from cache, the
  image import pipeline, thumbnails, and atomic writes.
sidebar_position: 3
---

User files are stored on disk, never as BLOBs: originals live in
`data/files/`, regenerable thumbnails in `data/cache/thumbnails/`, and every
write is atomic.

## Originals vs. Cache

The split is strict:

- **Originals** — `data/files/{avatars,backgrounds,attachments,audio,generated}/`.
  Originals are never modified and never deleted by cache maintenance.
- **Cache** — `data/cache/thumbnails/`. Thumbnails are regenerable and
  content-addressed.

Clearing the cache never removes originals. A missing thumbnail is
regenerated from the original automatically.

## The Image Import Pipeline

Importing an image follows a fixed pipeline:

1. Validate size, MIME type, and extension.
2. Compute a content hash (SHA-256).
3. Save the original losslessly, content-addressed (`{sha256}{ext}`), which
   deduplicates by content.
4. Generate low-resolution thumbnails for galleries, lists, and previews.
5. Store thumbnails in `data/cache/thumbnails/`.
6. Key each thumbnail by the original's hash, the target size, and the
   algorithm version: `{hash}-{size}-v{algorithmVersion}`.
7. Do not regenerate a thumbnail whose key is unchanged.
8. Never load the original where a thumbnail suffices.
9. Rebuild the cache automatically when a thumbnail is missing.
10. Cache clearing never touches originals.

## Atomic Writes

Every file write goes through a temporary file followed by a rename. A
crash in the middle never leaves a partially written file behind. This
applies to originals, thumbnails, and downloaded tokenizer files alike.

## Character Gallery

Gallery images reuse the `attachments` table with
`owner_type = character.gallery`. Metadata rows hold the URLs of the
original and its thumbnail; the bytes stay in content-addressed
`files/avatars/`. Removing an image from the gallery deletes the attachment
record, not the original file — the action stays reversible and
deduplication is preserved.

## Chat Backgrounds

`files/backgrounds/` is the source of truth: the list is built by scanning
the directory, so backgrounds imported from SillyTavern appear without any
transfer step. Uploaded files are stored content-addressed and never
modified.

Background thumbnails live in `cache/thumbnails/`, keyed by the SHA-256 of
the file name rather than the content, which lets SillyTavern-imported
files with arbitrary names get thumbnails too and keeps upload, list, and
delete on one key. A file that cannot be decoded or exceeds 64 MiB is
listed without a thumbnail; the original remains available. Deleting a
background removes both the original and its cached thumbnail.

## Character Card Imports

`POST /api/v2/characters/import` accepts JSON Character Card V1/V2 and PNGs
with `chara` metadata. Input is limited to 25 MiB and detected by content.
The SHA-256 of the whole source file is stored in `ext._st2.importHash`,
and re-importing the same file returns the existing record. PNGs are
validated by an image decoder. The original is written atomically to
`files/avatars/` and a WebP thumbnail is generated; a missing thumbnail is
rebuilt from the original on the next read.

## Cache Maintenance

The diagnostics screen calls `DELETE /api/v2/diagnostics/cache`, which
removes only the files in `cache/thumbnails/` and their `cache_metadata`
rows. The `cache/` root is kept, so active migration staging directories
are never interrupted. The result reports the number and size of removed
files; re-running it is safe and returns zeros.
