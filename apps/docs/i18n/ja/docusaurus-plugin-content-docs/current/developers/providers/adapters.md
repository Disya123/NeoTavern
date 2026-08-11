---
title: 同梱アダプター
description: NeoTavern に同梱されるプロバイダーアダプターと、それぞれの対象
sidebar_position: 3
---

NeoTavern には一連のプロバイダーアダプターが初期状態で同梱されています。それらは `packages/provider-sdk/src/adapters/` にあり、アダプターごとに 1 ファイルで、コアの `ProviderRegistry` にプロバイダー種類ごとに登録されています。

## OpenAI 互換

ファイル: `openaiCompatible.ts` — 種類 `openai-compatible`。

OpenAI の `/v1/chat/completions` と `/v1/models` API を公開する任意のサーバーを対象にします: OpenAI 自体、OpenRouter、LM Studio、llama.cpp サーバー、`/v1` エンドポイント付きの Ollama、vLLM などです。グローバルな `fetch` と SDK の SSE パーサーのみを使用し、API キーは送信されますがログに記録されることはありません。

## Anthropic

ファイル: `anthropic.ts` — 種類 `anthropic`。

ネイティブの Anthropic Messages API を対象にします。これはベンダー SDK なしルールの文書化された唯一の例外です: API — 拡張思考とベータヘッダーサポート — は公式 SDK の方が正確に処理されるため、`@anthropic-ai/sdk` を使用します。プロンプトキャッシュとアダプティブ思考をサポートし、`assistantPrefill` ワイヤーケイパビリティを宣言します。

## テキスト補完

ファイル: `textCompletion.ts` — 種類 `text-completion`。

レガシー OpenAI `/v1/completions` エンドポイントを公開するローカルまたはセルフホストのバックエンドを対象にします: text-generation-webui（"ooba"）、koboldcpp、vLLM、Ollama、llama.cpp サーバーなどです。チャットアダプターと異なり、シリアライズされたプロンプトを消費します: プロンプトパイプラインがインストラクトフォーマットをレンダリングし、アダプターにコンテンツが完成したプロンプトである単一の user メッセージを渡し、アダプターがそれを `/completions` に投稿します。API キーはローカルサーバーではオプションで、ログに記録されることはありません。

## NovelAI

ファイル: `novelai.ts` — 種類 `novelai`。

NovelAI テキスト生成 API（Bearer キー付きの `POST {baseUrl}/ai/generate`）を対象にします。生成は非ストリーミング — 単一の `delta` と終端の `done` イベントで、統一ストリームコントラクトに一致します。API はモデル発見を提供しないため、`listModels` は設定されたモデルを返します。NovelAI のパラメータサーフェスが進化するため、アダプターは実験的とマークされています。確立されたサンプラーのみがマッピングされます。

## KoboldAI

ファイル: `koboldai.ts` — 種類 `koboldai`。

KoboldAI/Kobold サーバーのネイティブ API（`POST {baseUrl}/api/v1/generate`）を対象にします。生成は非ストリーミングで、読み込まれたモデルは発見のために `/api/v1/model` から読み取られます。典型的なローカルインストールでは API キーは不要です。

## AI Horde

ファイル: `aiHorde.ts` — 種類 `ai-horde`。

AI Horde（`stablehorde.net`）を対象にします。これは非同期のクラウドソーシング型クラスターです。ジョブは `/api/v2/generate/text/async` で送信され、ステータスエンドポイントで完了までポーリングされます。ポーリングループは呼び出し側シグナルとアイドルデッドラインを再チェックするため、スタックしたジョブは永遠にポーリングする代わりに中止されます。匿名使用は低優先度で許可され、設定されている場合 API キーは `apikey` ヘッダーとして送信されます。

## Echo

ファイル: `echo.ts` — 種類 `echo`。

テスト、デモ、ネットワークや API キーなしでストリーミングパイプラインを検証するための完全オフラインプロバイダーです。最後のユーザーメッセージを単語ごとにストリーミングして返します。オプションの音声、画像、文字起こしメソッドも実装しているため、すべてのモダリティをカバーするアダプターを書くための参考として有用です。

## プロンプトヘルパー

ファイル: `prompt.ts` — メッセージ配列をアダプターが送信するプロンプトシェイプにシリアライズする共有ヘルパー `promptFromMessages` をエクスポートします。それ自体はアダプターではありません。

これらすべてが実装する正確な `ProviderAdapter` インターフェースは[アダプターコントラクト](adapter-contract.md) と生成された[プロバイダー SDK リファレンス](../../api/provider-sdk/) を参照してください。
