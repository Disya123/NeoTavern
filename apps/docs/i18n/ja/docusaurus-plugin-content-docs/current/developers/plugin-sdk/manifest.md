---
title: プラグインマニフェスト
description: すべての .stplugin パッケージが含まなければならない plugin.json スキーマ
sidebar_position: 2
---

プラグインマニフェスト（`plugin.json`）はプラグインの唯一の情報源です: アイデンティティ、エントリポイント、要求された権限、宣言されたケイパビリティです。

## パッケージ構成

`.stplugin` パッケージは、ルートに `plugin.json`、参照されるエントリファイル、任意のアセットを含む ZIP アーカイブです。ホストは何かをインストールする前にアーカイブを検証します: パストラバーサル、シンボリックリンク、実行可能ペイロード、サイズ制限がすべて拒否されます。

## マニフェストフィールド

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

コアフィールドは次のとおりです:

- **`id`** — リバース DNS 識別子。例: `author.plugin-name`。インストール済みのすべてのプラグイン間で一意であり、アップデートをまたいで安定しています。
- **`name`** — プラグインマネージャーに表示される人間が読める名前。
- **`version`** — セマンティックバージョン（`major.minor.patch`）。バージョン比較とキャッシュバスティングに使われます。
- **`apiVersion`** — プラグインが対象とする SDK API バージョン。現在のバージョンは 3 で、バージョン 2 は新しいランタイムが本番に投入されるまでデフォルトのままです。
- **`engines`** — `neotavern: "^0.1.0"` などの互換性制約。
- **`frontend`** — ブラウザ ESM エントリへの相対パス。
- **`backend`** — Node.js ESM エントリへの相対パス。
- **`styles`** — オプションのプラグインスタイルシート。
- **`i18n`** — ロケールコードから翻訳 JSON ファイルの相対パスへのマップ。

## 権限

`permissions` 配列は SDK v2 のレガシーなフラットリストです。新しいマニフェストは、代わりに `requiredCapabilities` と `optionalCapabilities` を通じてスコープ付きケイパビリティを宣言するべきです:

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` はプラグインが動作するために必要なケイパビリティで、`optionalCapabilities` はなくても劣化できるものです。ユーザーはインストール時に要求されたすべてのケイパビリティを確認します。アップデートで新しい権限を追加するには再同意が必要です — [権限](permissions.md) を参照してください。

## レガシーエントリポイント

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

`legacy` ブロックは、既存の SillyTavern 拡張機能向けの信頼された互換エントリを指します。どちらかのエントリを使用するパッケージは `legacy.trusted` 権限を要求する必要があり、UI は同意時に強化された警告を表示します。セーフモードはレガシーエントリポイントを決して読み込みません。ネイティブプラグインとの違いは[サンドボックス化](sandboxing.md) を参照してください。

## OAuth クライアント

外部サービスに接続するプラグインは、PKCE 付き認可コードフローを使用する公開 OAuth 2.0 クライアントを宣言できます:

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

公開クライアントのみが許可されます: プラグインコードはサンドボックスで実行されるため、`clientSecret` は禁止されています。エンドポイントは HTTPS でなければならず、開発中のローカル ID プロバイダーには平文 HTTP のループバック例外があります。ディスクリプターを変更するにはパッケージの再インストールが必要です。

## ワーカーと署名フィールド

高度なマニフェストは追加モジュールを宣言できます:

- **`workers`** — プラグインが分離された計算ワーカーとしてスパウンできるパッケージ相対のエントリモジュール。宣言されていないエントリのスパウンは拒否されます。
- **`publisher`** と **`signature`** — パッケージ署名。`keyId` は署名公開鍵の `ed25519:<hex>` フィンガープリントで、`signature` は正規マニフェストに対する base64 Ed25519 署名です。これらはプラグインビルドツールが設定するもので、手書きされることはありません。

SDK の `validateManifest` 関数はすべてのフィールドをチェックし、生成された[プラグイン SDK リファレンス](../../api/plugin-sdk/) は正確な `PluginManifest` 型を文書化しています。
