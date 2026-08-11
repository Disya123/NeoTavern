---
title: データとストレージ
description: >-
  データレイヤーの概要: SQLite データベース、オリジナルとキャッシュの
  ファイルシステム構成、バックアップモデル。
sidebar_position: 1
---

このセクションでは、NeoTavern がデータをどう保存するかを説明します: SQLite データベース、オリジナルとキャッシュのファイルシステム構成、バックアップモデルです。

## データディレクトリ

すべてのユーザーデータは 1 つのローカルデータディレクトリに存在します:

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## このセクションのページ

- [SQLite ストレージ](data/sqlite) — プラグマ、STRICT テーブル、FTS5 検索、安定した UUIDv7 ID、マイグレーション。
- [ファイルと画像](data/files-and-images) — オリジナルと再生成可能なサムネイルの保存方法とアトミック書き込み。
- [バックアップ](data/backups) — バックアップモデル、復元、バックアップの対象範囲。

## 関連セクション

- [アーキテクチャ](architecture/) セクションはデータレイヤーがモノレポのどこに位置するかを説明します。
- ユーザー向けの見方は、[ユーザーガイド](../user-guide/data-and-backups) のデータとバックアップを参照してください。
