---
title: バックエンドプラグイン API
description: バックエンドプラグインが受け取る制限されたサーバー側抽象化
sidebar_position: 5
---

バックエンド API は、サーバー側のプラグインが `activate()` 呼び出しで受け取るものです: ルート、ストレージ、イベント、ロギング、ネットワークアクセス、プロバイダー、ファイルのための制限された抽象化 — それ以外は何もありません。

## エントリポイント

バックエンドプラグインは、`ServerPluginApi` オブジェクトを受け取る `activate(api)` 関数を持つ定義をエクスポートします:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

バックエンドエントリは別の Node.js プロセスとして実行されます。プラグインが Fastify ルートインスタンス、SQLite 接続、内部テーブル、絶対パス、完全な環境、他のプロバイダーの API キーを受け取ることは決してありません。

## ルート

`api.routes` は `/api/plugins/{pluginId}/` の下にマウントされたスコープ付きルーターです。各メソッドはパスとハンドラーを受け取り、クリーンアップ関数を返します:

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

`PluginRequest` は `params`、`query`、`headers`、パース済みの JSON `body`、`AbortSignal` を運びます。`PluginResponse` は `{ status, body, headers }` です。ハンドラーは値を直接または promise で返せます。ホストはタイムアウトを強制し、シグナルを通じて作業をキャンセルします。

## ストレージ

`api.storage` はプラグインごとに分離された名前空間付きのキー/バリューストアです:

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

データはプラグイン ID にスコープされるため、2 つのプラグインが衝突することはありません。

## イベントとロギング

`api.events` はフロントエンドが使用するのと同じ型付きイベントバスです。購読は購読解除関数を返し、すべての購読は無効化、クラッシュ、シャットダウン時に自動的に削除されます。発行は自身の名前空間（`{pluginId}.event`）に制限され、ペイロードは JSON セーフでなければならず、ホストはペイロードサイズとランタイムごとのイベント名の数を上限で制限します。

`api.logger` は `debug`、`info`、`warn`、`error` メソッドを提供し、それぞれメッセージとオプションのメタデータを受け取ります。ログにシークレットが含まれることはありません。

## 権限チェック付きフェッチ

`api.fetch` はプラグインの `network:<host>` 権限でガードされた `fetch` です:

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

付与されていないホストへのリクエストは、ネットワークアクティビティの前に拒否されます。他のプロバイダーのシークレットがリクエストに注入されることはありません。応答オブジェクトは `ok`、`status`、`text()`、`json()` を公開します。

## プロバイダーとコンテキスト戦略

`api.providers` でプラグインは生成を拡張できます:

- `api.providers.register(kind, factory, options)` は新しいプロバイダーアダプター種別を登録します（`providers.register` が必要）。登録はクリーンアップ関数を返します。
- `api.providers.registerTokenizer(profile)` はローカルのモデル固有トークナイザーを登録します。プロファイルは `id`、`approximate`、`matches(model)`、`count(text)` を宣言します。正確なトークナイザーは tiktoken、SentencePiece、または Hugging Face トークナイザー JSON から構築できます。モデル用に登録されるまで、ホストはスクリプト認識のヒューリスティックにフォールバックし、カウントを近似としてマークします。登録は非アクティブ化時に自動的に削除されます。

`api.contextStrategies.register(strategy)` はコンテキストシフティング戦略を追加します。ホストはシステム、ピン留め、現在のユーザーブロックが生き残ることを検証し、最終的なトークン予算を自分で適用します — 戦略が返す `fitsBudget` 値は信頼されません。

`api.postProcessors.register(processor)` は生成後フックを追加します。ストリーム完了後、メッセージ保存前に実行され、新しい文字列を返すとアシスタント応答が置き換わります。`prompt.modify` が必要です。

## 仮想ファイルシステム

`api.files` はプラグイン自身のデータディレクトリをルートとするサンドボックス化された仮想ファイルシステムです:

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

パスはプラグインルートを抜けられないため、プラグインが触れるのは自身のデータだけです。

## バックエンドプラグインができないこと

API サーフェスは意図的に小さく保たれています。ホストデータベース、他のプラグインのストレージ、任意のファイルシステムパス、検証されていないネットワークホストに到達する方法はありません。SDK が公開していなければ、アクセスできません。生成された[プラグイン SDK リファレンス](../../api/plugin-sdk/) は完全な `ServerPluginApi` サーフェスを一覧し、[プロバイダー](../providers/index.md) はプロバイダープラグインがモデルにどう適合するかを説明します。
