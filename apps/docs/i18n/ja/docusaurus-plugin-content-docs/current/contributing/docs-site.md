---
title: ドキュメントサイト
description: NeoTavern ドキュメントサイトの仕組みと、ページの追加・修正方法
sidebar_position: 4
---

公開ドキュメントサイトは `apps/docs` の Docusaurus プロジェクトです。このページでは、その構成とページの追加・更新方法を説明します。

## 構成

- 英語のソースページは `apps/docs/docs/` にあり、ページごとに 1 つのマークダウンファイルで、サイドバーが表示するのと同じディレクトリに整理されています。
- 翻訳は `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` にあり、英語ツリーをページごとに 1 ファイルでミラーします。[翻訳](./translations) を参照してください。
- `apps/docs/docs/api/` の下の SDK リファレンスは生成され gitignore されています。手で編集しないでください。

## ページの追加

1. ページを表示したい場所に一致するディレクトリにマークダウンファイルを作成します。
2. `title`、`description`、`sidebar_position` を持つフロントマターを追加します:

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. ページがカバーする内容の 1 文の要約で始めます。
4. セクションには `##` と `###` を使用します。フロントマターの `title` が単一の H1 を提供します。
5. 新しいディレクトリを追加する場合は、その中に `_category_.json` を作成します:

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position` はディレクトリ内のページを順序付けます。Overview ページは 1 です。コンテンツサイドバーのセクションはディレクトリ構造から自動生成されます。

## MDX の制限

ページはプレーンマークダウンと Docusaurus アドモニションのみです:

```md
:::note
Text inside the admonition.
:::
```

`import` ステートメント、カスタム JSX コンポーネント、タブ、生の HTML はありません。すべてのページは 8 つの翻訳ロケールのいずれにもそのままコピーできる状態を保たなければなりません。コードサンプルは言語タグ付きのフェンスブロックを使用します。

## SDK リファレンス

SDK リファレンスは各パッケージのエントリポイントから TypeDoc によって生成されます:

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

リファレンスはサイトビルドのたびに再生成されるため、生成されたページへの編集は失われます。リファレンスページを修正するには、代わりにパッケージソースの TSDoc を修正してください。`apps/docs/docs/api/index.md` の概要は手書きで、コミットされたままです。

## サイトの実行

```bash
pnpm docs:site        # ホットリロード付きローカル開発サーバー
pnpm docs:site:build  # 本番ビルド: 全ロケールと SDK リファレンス
```

本番ビルドがゲートです — 壊れたリンクと壊れたマークダウンリンクは失敗させます — コンテンツの変更をプッシュする前に実行してください。

## リンクのルール

内部リンクはサイトに存在するページを指さなければなりません。ホームページからは絶対サイトパス（`/getting-started/`）を、より深いページからは相対パス（`contributing/` の下のページから `../developers/`）を優先してください。外部リンクは Docusaurus ドキュメントと NeoTavern リポジトリに制限されます。

## 内部開発者ドキュメント

リポジトリはまた、リポジトリルートの `docs/` に内部開発者ドキュメントを保持し、`pnpm docs:check` と `pnpm docs:build` で検証されます。これはこの公開サイトとは別のドキュメントセットです。2 つのツリーを混同しないでください。
