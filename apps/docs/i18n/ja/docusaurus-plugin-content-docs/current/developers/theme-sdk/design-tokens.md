---
title: デザイントークン
description: セマンティックデザイントークンのコントラクトと、コンポーネントがハードコードしてはならないもの
sidebar_position: 3
---

デザイントークンは、アプリケーションのすべてのビジュアル値を運ぶセマンティック変数です。コンポーネントはそれらを参照し、テーマはそれらをオーバーライドし、何もハードコードされません。

## トークンのコントラクト

すべてのトークンは `--st-` プレフィックス付きの CSS カスタムプロパティで、すべてのトークン名は `@neotavern/theme-sdk` のバージョン管理されたコントラクトの一部です。ホストはライトモードとダークモードのデフォルト値を同梱するため、テーマが何も定義しなくてもすべてのトークンは常に解決されます。

正規のトークングループは次のとおりです:

- **テキスト色** — `color-text-primary`、`color-text-secondary`、`color-text-muted`、`color-text-inverse`、`color-text-link`。
- **サーフェス** — `color-surface-primary`、`color-surface-secondary`、`color-surface-tertiary`、`color-surface-overlay`、`color-surface-canvas`、`color-surface-elevated`。
- **アクセントとステータス** — `color-accent`、`color-accent-hover`、`color-accent-text`、`color-accent-soft`、`color-accent-soft-text`、`color-border`、`color-border-strong`、`color-success`、`color-warning`、`color-danger`、`color-info`。
- **チャットメッセージのマークダウン** — `color-message-quote`、`color-message-emphasis`、`color-message-code`、`color-message-code-bg`。
- **タイポグラフィ** — `font-ui`、`font-mono`、`font-size-2xs` から `font-size-2xl` まで、`line-height-body`、`font-weight-normal` から `font-weight-bold` まで。
- **間隔** — `space-2xs` から `space-3xl` まで。
- **角丸と境界線** — `radius-control`、`radius-card`、`radius-overlay`、`radius-panel`、`radius-round`、`radius-inset`、`border-width`。
- **浮揚（エレベーション）** — `shadow-card`、`shadow-soft`、`shadow-focus`、`shadow-overlay`。
- **レイヤー（z-index）** — `layer-base`、`layer-raised`、`layer-panel`、`layer-plugin-overlay`、`layer-plugin-chrome`、`layer-dropdown`、`layer-modal`、`layer-notification`。
- **モーション** — `motion-duration-fast`、`motion-duration-normal`、`motion-duration-slow`、`motion-easing-standard`、`effect-glass-blur`。
- **コントロールサイズ** — `control-height`、`control-height-large`、`control-height-sm`、`control-height-xs`、`control-height-2xs`、`control-hit-min`、`switch-width`、`switch-height`、`switch-thumb-size`、`menu-min-width`、`dialog-max-width`、`dialog-max-height`、`textarea-min-height`、`spinner-size`。
- **パネルとコンテンツのサイズ** — `size-panel-max-height`、`size-content-max-height`、`size-chat-column-max`。
- **ビューポートの制限** — `overlay-width-limit`、`overlay-height-limit`、`dialog-sheet-height`。
- **スクロールバー** — `scrollbar-width`、`scrollbar-radius`、`scrollbar-track-bg`、`scrollbar-thumb-bg`、`scrollbar-thumb-hover-bg`、`scrollbar-fade-duration`、`scrollbar-fade-easing`、`scrollbar-hide-delay`。
- **アプリシェルのサイズ** — `shell-rail-width`、`shell-panel-width`、`shell-panel-min-width`、`shell-panel-max-width`。
- **チャットキャンバス** — `chat-wallpaper-image`、`chat-wallpaper-position`、`chat-wallpaper-size`、`chat-wallpaper-overlay`、`chat-wallpaper-blur`、`custom-wallpaper-overlay-alpha`。
- **チャットのタイポグラフィ指標** — `chat-markdown-column-width`、`chat-message-block`、`chat-message-inline`。
- **ユーザー調整可能なノブ** — `custom-glass-blur`、`custom-ui-opacity`。

## トークンのオーバーライド

テーマは名前の任意のサブセットをオーバーライドします。値は検証されます: 安全な非空の CSS 値でなければならず、`{`、`}`、`;` などの構造は拒否されます。

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

ユーザーがチャット背景を選ぶと、アプリケーションはワークスペースルートに壁紙画像用のスコープ付きカスタムプロパティを設定します。位置、サイズ、オーバーレイ、ぼかしはテーマのトークンのままです。

## 解決ルール

トークンはこの順序で解決され、後者が勝ちます:

1. アクティブモードの組み込みデフォルト。
2. 親テーマチェーン。ルートが先。
3. テーマ自体。

ダークモードは、ダークのオーバーライドがない場合、テーマのライトトークンにフォールバックするため、ライトのみのテーマでもダークモードで動作します。`@neotavern/theme-sdk` の `resolveTokens` と `buildThemeVariables` 関数がこれを実装し、ホストは結果を `document.documentElement` の CSS 変数として書き込みます。

## コンポーネントがハードコードしてはならないもの

スタイルコントラクトは組み込み UI のどこでもハードコード値を禁止し、テーマが依存してはならないものにも同じルールが適用されます:

- 数値の `font-weight`、px 単位の `font-size`、生の px 単位の `border-radius`。
- 数値の `z-index` — `layer-*` トークンを使用してください。
- `40px`、`44px`、`52px`、`32px`、`36px` などのコントロールサイズ。
- アクセシビリティ設定レイヤーを除くテーマ CSS の `!important`。
- レイアウトルール: 座標、グリッドとフレックススキーム、ブレークポイント、領域の順序はトークンコントラクトの一部ではありません。ブレークポイントはレジストリ（`VIEWPORT_BREAKPOINTS` と `CONTAINER_BREAKPOINTS`）から来て、シェル領域の移動は v1 の範囲外です。

カードリストのグリッドスキームなどのコンテンツジオメトリは明示的な例外です: トークンコントラクトでカバーされません。テーマが再スタイリングに必要なものはすべて、トークン、フック、宣言型シェルレイアウトを通じて利用できます。生成された[テーマ SDK リファレンス](../../api/theme-sdk/) は正確な `TokenName` 一覧を文書化しています。
