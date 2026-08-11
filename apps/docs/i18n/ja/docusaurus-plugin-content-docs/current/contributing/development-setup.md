---
title: 開発環境のセットアップ
description: NeoTavern の開発環境をセットアップし、プロジェクトをローカルで実行する
sidebar_position: 2
---

このページでは、NeoTavern の開発環境をセットアップし、プロジェクトをローカルで実行する方法を説明します。

## 前提条件

- Node.js 24 LTS 以降 — プロジェクトは Node `>= 24` を要求します。
- pnpm 9 — ワークスペースは pnpm `>= 9` かつ `< 10` を要求し、`packageManager: pnpm@9.15.0` を宣言しています。corepack で有効にするか、直接インストールしてください。
- Windows、macOS、または Linux。デスクトップアプリはエンドユーザー向けに独自の Node.js ランタイムをバンドルしますが、開発では常にインストール済みの Node.js を使用します。

## 依存関係のインストール

```bash
pnpm install
```

これですべてのワークスペースパッケージがインストールされます。リポジトリは pnpm モノレポです: アプリケーションは `apps/`（サーバーと Web）に、共有ライブラリは `packages/` にあります。

## 開発で実行する

```bash
pnpm dev
```

は、Fastify バックエンドと Vite Web アプリをホットリロード付きで並行して起動します。個別に実行するには:

```bash
pnpm dev:server
pnpm dev:web
```

Vite 開発サーバーが表示する URL を開き、設定でプロバイダーを接続し、最初のメッセージを送信してパイプライン全体を検証してください: チャット、サーバー、プロバイダー、ストリーミング、保存です。

## 品質ゲート

プッシュする前にこれらを実行してください:

```bash
pnpm typecheck    # モノレポ全体の TypeScript
pnpm lint         # ESLint、警告ゼロ
pnpm test         # Vitest ユニット・統合テスト、Web テスト付き
pnpm test:e2e     # Playwright エンドツーエンドスイート（最初にワークスペースをビルド）
pnpm build        # 完全なワークスペースビルド（tsc -b と Vite）
pnpm format:check # Prettier チェック
```

`pnpm test:e2e` は最初にワークスペース全体をコンパイルするため、他のチェックより時間がかかります。`docs:check` と `docs:build` スクリプトは内部開発者ドキュメントを検証します。公開サイトには独自のコマンドがあり、[ドキュメントサイト](./docs-site) ページに文書化されています。

## デスクトップ開発

デスクトップシェル（Tauri）とその Node サイドカーは別々のアプリケーションです:

```bash
pnpm desktop:dev       # 開発でデスクトップアプリを実行
pnpm desktop:portable  # ポータブル Windows パッケージをビルド
pnpm desktop:release   # インストーラーパッケージをビルド
```

デスクトップのパッケージングは OS 固有のツールチェーンを含みます。詳細は開発者ドキュメントの[デスクトップ](../developers/desktop/) セクションを参照してください。

## よくある問題

- `pnpm install` または `pnpm dev` が失敗する: `node -v` が 24 以降で、`pnpm -v` が 9 であることを確認してください。
- 開発サーバーが起動しない: サーバーと Vite が使用するポートを他のプロセスが占有していないか確認し、`pnpm dev` を再起動してください。
