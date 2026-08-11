---
title: アダプターコントラクト
description: すべてのプロバイダーアダプターが検証からタイムアウトまで実装しなければならないもの
sidebar_position: 2
---

アダプターコントラクトは、すべての LLM、TTS、STT、画像プロバイダーが実装するコントラクトです。これを満たすアダプターを書けば、パイプライン全体があなたのプロバイダーで動作します。

## インターフェース

`ProviderAdapter` インターフェースは安定した `kind`、オプションのモダリティ宣言、必須メソッドを持ちます。テキスト生成が基本ケイパビリティで、音声、画像、文字起こしメソッドはオプションです。そのため LLM のみのアダプターも有効なプロバイダーです。

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## 必須の動作

コントラクトは 8 つの動作を要求します:

- **構成の検証** — `validateConfig()` はネットワーク呼び出しなしでアダプター自身の構成をチェックし、問題の一覧を返します。
- **モデル一覧** — `listModels(signal)` は利用可能なモデルを返し、中止シグナルを尊重しなければなりません。
- **キャンセル** — すべての長時間実行メソッドは `AbortSignal` を受け取り、発火したら速やかに中止しなければなりません。
- **統一イベントストリーム** — `generate()` は型付き `GenerationEvent` のストリームを生成し、`done` または `error` の正確に 1 つの終端イベントで終了しなければなりません。音声と画像の生成も同じストリーミングシェイプを使用します。
- **エラーの正規化** — プロバイダー障害は、マシン可読なコードとパラメータを持つ安定した `AppError` コードにマッピングされます。上流の HTTP ステータスは区別され（認証、レート制限、モデル不正、サーバーエラー）、生の上流ボディがクライアントに転送されることはありません。
- **タイムアウト** — アダプターは呼び出し側のシグナルだけに頼ってはなりません。接続、アイドルストリーミング沈黙、応答全体の読み取りに独自のデッドラインが必要です。SDK は `ProviderTimeouts`（デフォルト: 接続 30 秒、アイドル 60 秒、読み取り 30 秒）と、呼び出し側シグナルと再アーム可能なデッドラインを組み合わせて `TIMEOUT` エラーで中止する `DeadlineController` を同梱しています。
- **安全なロギング** — API キーは安全なストレージから提供され、ログに記録されることも、診断やエラー出力に含まれることも決してありません。
- **登録** — アダプターは種類ごとに登録され、コアレジストリまたはプラグイン SDK のバックエンド API を通じて行われます。

## ベンダー中立性

コアはベンダー SDK に縛られません。新しいアダプターはグローバルな `fetch` と SDK の SSE パーサー（`parseSseStream`）をストリーミング応答に使用することが期待されます。

文書化された例外は正確に 1 つあります: Anthropic アダプターは `@anthropic-ai/sdk` を使用します。Anthropic API — 拡張思考とベータヘッダーサポート — は、手書きの fetch クライアントより公式 SDK の方が正確に処理されるためです。ベンダーライブラリに接続された唯一のアダプターで、他のすべては直接 HTTP を話します。

## ホスト統合

`ProviderRegistry` はプロバイダー種類をアダプターファクトリにマッピングします。`register` は登録解除関数を返し、`create` はアダプターをインスタンス化して未知の種類には `PROVIDER_NOT_FOUND` を投げ、レジストリはローカルのトークナイザーレジストリもホストします。`assistantPrefill` などの宣言されたワイヤーケイパビリティは接続プロファイルの検証に使用されます — ホストはアダプターがサポートしない永続化されたプロファイルオーバーライドを黙って落とすことはありません。

実際に同梱されるアダプターとそれぞれの対象は[アダプター](adapters.md) を、プラグインからのアダプター登録は[プラグイン SDK バックエンド API](../plugin-sdk/backend.md) を参照してください。
