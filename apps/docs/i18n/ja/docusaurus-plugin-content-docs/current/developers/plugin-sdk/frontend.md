---
title: フロントエンドプラグイン API
description: フロントエンドプラグインがページ、パネル、アクション、コマンド、イベントを登録する方法
sidebar_position: 4
---

フロントエンド API は、ブラウザ側のプラグインが `activate()` 呼び出しで受け取るものです: すべての UI サーフェス用のレジストラー群、イベントバス、i18n です。

## エントリポイント

フロントエンドプラグインは `activate(api)` 関数を持つ定義をエクスポートします。ホストは、プラグインが同意されアクティブになると `FrontendPluginApi` オブジェクトでそれを呼び出します:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Register surfaces here.
  },
  deactivate() {
    // Optional explicit teardown.
  },
});
```

すべてのレジストラーはクリーンアップ関数を返します。ランタイムがこれらを自動的に収集するため、プラグインが手で追跡する必要はありません — ただし `deactivate()` で自分で管理するものを破棄することはできます。

## 登録サーフェス

`api.ui` 名前空間は UI レジストラーをグループ化します:

- **ページ** — `api.ui.pages.register({ id, path, title, mount })` はプラグイン名前空間の下にルートを追加します。`mount` はホスト提供のコンテナを受け取り、ティアダウンを返せます。
- **設定パネル** — `api.ui.settingsPanels.register(...)` は設定画面にパネルを追加します。
- **ツールバーアクション** — `api.ui.toolbarActions.register({ id, title, icon, run })`。ホストがアクションを標準ボタンとしてレンダリングします。あなたはセマンティクスだけを提供し、レイアウトやブレークポイントは提供しません。
- **メッセージアクション** — `api.ui.messageActions.register({ id, title, icon, order, placement, run })`。`run` コールバックは不変のメッセージスナップショットと、ティアダウン、再呼び出し、またはタイムアウトで発火する `AbortSignal` を受け取ります。
- **コンテキストメニュー項目** — `context: 'message' | 'character'` 用の `api.ui.contextMenuItems.register({ id, title, context, run })`。
- **メッセージレンダラー** — `api.ui.messageRenderers.register({ id, title, render })`。`render` は `'replace'` または `'after'` の `placement` を持つプレーンテキストを返します — HTML は決してありません。
- **キャラクタータブ** — `api.ui.characterTabs.register({ id, title, mount })`。`mount` はコンテキストとして `{ characterId }` を受け取ります。
- **サイドバーパネル** — `slot: 'left' | 'right'` 付きの `api.ui.sidebarPanels.register({ id, title, slot, mount })`。
- **ダイアログ** — `api.ui.dialogs.register({ id, title, description, mount })`。
- **コマンドパレットアクション** — `api.ui.commands.register({ id, title, run })`。
- **ホットキー** — `api.ui.hotkeys.register({ id, combo, run })`。例: `combo: 'mod+shift+k'`。

スラッシュコマンドは `api.slash.register({ name, description, run })` で別途登録され、プロンプトインターセプターは `api.interceptors` で登録されます。

## プロンプトインターセプター

インターセプターは送信前に組み立てられたプロンプトに対して実行されます:

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages is an array of { id, role, content, name }.
    return context;
  },
});
```

`priority` が小さいほど先に実行されます。`timeoutMs` を超えたプラグインはチェーンを壊さずにスキップされます。プロンプトを検査するだけのインターセプターには `prompt.inspect` が、変更するものには `prompt.modify` が必要です。

## イベント

イベントバスは型付きで、ホストと共有されます。`api.events.on(event, handler)` は購読解除関数を返します:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

組み込みイベントには `chat.created`、`chat.opened`、`chat.message.created`、`chat.message.updated`、`chat.message.deleted`、`character.selected`、`generation.started`、`generation.delta`、`generation.finished`、`generation.error`、`theme.changed`、`language.changed` があります。プラグインはカスタムイベントの発行とリッスンもでき、名前は慣例により名前空間化されます。例: `myplugin.foo`。

## メッセージスナップショットとコンテンツゲーティング

メッセージアクションは、`messageId`、`chatId`、`branchId`、`role`、`content`、`name`、`meta`、`revision` を持つ不変の `MessageActionSnapshot` を受け取ります。`content` フィールドは、プラグインが `chat.read` も保持していない限り `null` です。そのため、アクションはメッセージテキストを見ずにメタデータをレンダリングできます。

## 通知と i18n

`api.notify({ title, description, variant, timeoutMs })` は通知を表示し、破棄関数を返します。`variant` は `info`、`success`、`warning`、`error` です。

`api.i18n` は分離されたプラグイン名前空間で翻訳リソースを管理します:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` は他のすべての登録と同様にクリーンアップ関数を返します。

## クリーンアップの保証

すべての登録がクリーンアップ関数を返し、ランタイムがそれらを追跡するため、プラグインを無効化すると、そのハンドラー、タイマー、DOM ノード、サブスクリプション、バックグラウンドリクエストがすべて削除されます。完全なティアダウンコントラクトは[ライフサイクル](lifecycle.md) を、正確な型は生成された[プラグイン SDK リファレンス](../../api/plugin-sdk/) を参照してください。
