---
title: 适配器契约
description: 每个提供商适配器必须实现的内容，从校验到超时。
sidebar_position: 2
---

适配器契约是每个 LLM、TTS、STT 和图像提供商实现的契约。如果你编写一个
满足它的适配器，整个管线就可以与你的提供商一起工作。

## 接口

`ProviderAdapter` 接口有一个稳定的 `kind`、可选的功能声明和必需的方法。
文本生成是基础能力；语音、图像和转录方法是可选的，
因此仅 LLM 的适配器仍然是有效的提供商。

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

## 必需行为

契约要求八种行为：

- **配置校验** —— `validateConfig()` 在不进行网络调用的情况下检查适配器
  自身的配置并返回问题列表。
- **模型列表** —— `listModels(signal)` 返回可用模型，并且必须尊重中止信号。
- **取消** —— 每个长时间运行的方法都接收一个 `AbortSignal`，
  并且必须在它触发时及时中止。
- **统一事件流** —— `generate()` 产生一个类型化 `GenerationEvent` 的流，
  并且必须以恰好一个终止事件结束，`done` 或 `error`。语音和图像生成使用
  相同的流式形状。
- **错误规范化** —— 提供商失败被映射到稳定的 `AppError` 码，
  带机器可读的码和参数。上游 HTTP 状态被区分（认证、速率限制、模型错误、
  服务器错误），原始上游响应体绝不会转发给客户端。
- **超时** —— 适配器不能只依赖调用方的信号。它需要自己的连接、空闲流式
  静默和整个响应读取的截止时间。SDK 附带 `ProviderTimeouts`
  （默认：连接 30 秒、空闲 60 秒、读取 30 秒）和一个 `DeadlineController`，
  它把调用方信号与可重新武装的截止时间组合，并以 `TIMEOUT` 错误中止。
- **安全日志** —— API 密钥从安全存储提供，绝不能记录，
  也不能包含在诊断或错误输出中。
- **注册** —— 适配器按类型注册，无论是在核心注册表中还是通过插件 SDK
  后端 API。

## 供应商中立

核心不绑定到任何供应商 SDK。新适配器应使用全局 `fetch` 和 SDK 的 SSE
解析器（`parseSseStream`）进行流式响应。

恰好有一个文档记录的例外：Anthropic 适配器使用 `@anthropic-ai/sdk`，
因为 Anthropic API —— 扩展思考和 beta 头支持 —— 由官方 SDK 处理比手写
fetch 客户端更准确。它是唯一接入供应商库的适配器；其他一切都直接说 HTTP。

## 宿主集成

`ProviderRegistry` 把提供商类型映射到适配器工厂。`register` 返回一个
注销函数，`create` 实例化一个适配器并对未知类型抛出 `PROVIDER_NOT_FOUND`，
注册表还托管本地分词器注册表。声明的线缆能力（如 `assistantPrefill`）
用于校验连接配置文件 —— 宿主绝不会静默丢弃适配器不支持的已持久化配置文件
覆盖。

实际内置的适配器以及每个适配器的目标，请参阅[适配器](adapters.md)。
从插件注册适配器，请参阅[插件 SDK 后端 API](../plugin-sdk/backend.md)。
