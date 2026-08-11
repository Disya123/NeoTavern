---
title: 提供商概述
description: NeoTavern 如何通过一个适配器契约与 LLM、TTS、STT 和图像服务通信。
sidebar_position: 1
---

提供商是 NeoTavern 与外部 AI 服务通信的方式：语言模型、文本转语音、
语音转文本和图像生成。

## 一个适配器契约

每个提供商 —— 无论是 OpenAI 兼容的聊天端点、原生 Anthropic 连接、
NovelAI 或 KoboldAI 等社区后端，还是插件注册的服务 —— 都实现来自
`@neotavern/provider-sdk` 的同一个 `ProviderAdapter` 契约。核心管线只知道这个
契约，因此应用不绑定到任何单一供应商。

一个适配器必须支持：

- 配置校验。
- 列出可用模型。
- 通过 `AbortSignal` 取消。
- 统一的生成事件流。
- 规范化错误。
- 超时。
- 无密钥日志。
- 通过插件 SDK 注册。

由于无论供应商是谁，管线都看到同一种形状，流式输出、上下文移位和错误
处理等功能在所有提供商上以相同方式工作。精确要求请参阅
[适配器契约](adapter-contract.md)。

## 内置适配器

发行版附带了针对 OpenAI 兼容端点、Anthropic、文本补全端点、NovelAI、
KoboldAI、AI Horde 的适配器，以及一个本地 echo 适配器。每一个都在
[适配器](adapters.md)中有文档记录。

## 本地令牌估算

令牌计数是本地且离线的。精确分词器（tiktoken、SentencePiece 或 Hugging
Face 分词器 JSON）可以按模型注册，包括由提供商插件注册；在注册精确分词器
之前，宿主使用感知脚本的启发式方法并把计数标记为近似。

## 扩展提供商

核心刻意不依赖任何供应商 SDK。新提供商通过编写适配器并注册来添加：

- 核心提供商通过 `@neotavern/provider-sdk` 中的 `ProviderRegistry` 注册。
- 插件提供商通过插件 SDK 的后端 API 注册
  （`api.providers.register(kind, factory)`），这需要 `providers.register`
  权限。注册返回一个清理函数，并在插件停用时自动移除。

这是私有端点、自托管模型或没有内置适配器的服务的文档化路径。生成的
[提供商 SDK 参考](../api/provider-sdk/)记录了完整契约。
