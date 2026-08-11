---
title: アーキテクチャ
description: >-
  アーキテクチャセクションの概要: モノレポの構成、承認済みのテクノロジースタック、
  各パッケージの責任。
sidebar_position: 1
---

このセクションでは、NeoTavern モノレポがどのように構成されているか、どのテクノロジーを使用するか、サーバー、Web クライアント、デスクトップシェルがどのように組み合わさるかを説明します。

## このセクションのページ

- [モノレポ概要](architecture/overview) — `apps/` と `packages/` の構成、サーバーと Web 間のデータフロー、ローカルファーストの原則。
- [テクノロジースタック](architecture/stack) — 承認済みスタック: Node.js 24、Fastify 5、React 19、Vite 8、SQLite、Drizzle、Tauri 2、pnpm ワークスペース。
- [パッケージ](architecture/packages) — 各ワークスペースパッケージの責任と、それらの間の依存関係の方向。

## 関連セクション

[プロンプトパイプライン](prompt-pipeline/) セクションは生成ステージを詳細に説明し、[データとストレージ](data/) はデータベース、ファイル処理、バックアップを文書化しています。
