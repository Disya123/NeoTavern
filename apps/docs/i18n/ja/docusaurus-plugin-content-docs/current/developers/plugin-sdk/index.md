---
title: プラグイン SDK 概要
description: プラグイン SDK とは何か、フロントエンドとバックエンド API の分割がどう機能するか
sidebar_position: 1
---

プラグイン SDK は、プラグインが NeoTavern を拡張するために使用するバージョン管理された公開 API で、ブラウザ側の UI とサーバー側のバックエンドの両方をカバーします。

## プラグイン SDK とは

プラグインは、マニフェスト、オプションのフロントエンド・バックエンドエントリポイント、アセットを同梱する ZIP パッケージ（`.stplugin`）です。プラグインは `@neotavern/plugin-sdk` パッケージを通じてのみアプリケーションを拡張します — Fastify、React、Zustand、TanStack Query、SQLite 接続、内部コンポーネントを直接インポートすることは決してありません。それらはホストの実装の詳細であり、予告なく変更されます。

SDK はバージョン管理され（マニフェストの `apiVersion`）、プラグインがアプリケーションのアップデートをまたいで動作し続けられるようにします。ホストがコントラクトを強制します: SDK を通じて登録したものはすべて、プラグインが無効化されたときにクリーンアップされ、内部モジュールから必要になりそうなものは意図的に公開されません。

## フロントエンドとバックエンドの分割

プラグインには 2 つのオプションの半分があります:

- **フロントエンド** — その `activate()` 呼び出しで `FrontendPluginApi` を受け取るブラウザ ESM エントリ。ツールバーアクション、メッセージアクション、スラッシュコマンド、設定パネルなどの UI サーフェスを登録し、アプリケーションイベントをリッスンします。
- **バックエンド** — `ServerPluginApi` を受け取る Node.js ESM エントリ。`/api/plugins/{pluginId}/` の下にルートをマウントし、分離されたストレージを読み書きし、権限チェック付きのネットワーク呼び出しを行い、プロバイダーとコンテキストシフティング戦略を登録します。

どちらの半分もオプションです。ツールバーボタンだけを追加するプラグインにはバックエンドは不要で、API だけを提供するプラグインにはフロントエンドは不要です。各登録はクリーンアップ関数を返し、ランタイムがそれらを収集するため、非アクティブ化で何も残りません。

## プラグインの作成

`@neotavern/plugin-sdk` から `definePlugin` をインポートし、`activate(api)` 関数を持つ定義をエクスポートします:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

生成された[プラグイン SDK リファレンス](../api/plugin-sdk/) は、エクスポートされたすべての型と関数を正確なシグネチャ付きで文書化しています。

## 次のステップ

- [マニフェスト](manifest.md) — パッケージ構造と `plugin.json` スキーマ。
- [権限](permissions.md) — 権限モデルと同意フロー。
- [フロントエンド API](frontend.md) — UI サーフェスとイベントの登録。
- [バックエンド API](backend.md) — ルート、ストレージ、サーバー抽象化。
- [ライフサイクル](lifecycle.md) — インストール、有効化、無効化、クリーンアップの保証。
- [サンドボックス化](sandboxing.md) — 信頼できないコードのセキュリティモデル。
