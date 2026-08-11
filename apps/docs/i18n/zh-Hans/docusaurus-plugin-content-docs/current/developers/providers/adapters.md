---
title: 内置适配器
description: NeoTavern 随附的提供商适配器以及每个适配器的目标。
sidebar_position: 3
---

NeoTavern 开箱即用附带一组提供商适配器。它们位于
`packages/provider-sdk/src/adapters/`，每个适配器一个文件，
并按提供商类型注册在核心 `ProviderRegistry` 中。

## OpenAI 兼容

文件：`openaiCompatible.ts` —— 类型 `openai-compatible`。

针对任何暴露 OpenAI `/v1/chat/completions` 和 `/v1/models` API 的服务器：
OpenAI 本身、OpenRouter、LM Studio、llama.cpp server、带 `/v1` 端点的
Ollama、vLLM 等。它只使用全局 `fetch` 和 SDK 的 SSE 解析器；
API 密钥会被发送但绝不记录。

## Anthropic

文件：`anthropic.ts` —— 类型 `anthropic`。

针对原生 Anthropic Messages API。这是无供应商 SDK 规则的唯一文档记录
例外：它使用 `@anthropic-ai/sdk`，因为该 API —— 扩展思考和 beta 头支持
—— 由官方 SDK 处理更准确。它支持提示词缓存和自适应思考，
并声明 `assistantPrefill` 线缆能力。

## 文本补全

文件：`textCompletion.ts` —— 类型 `text-completion`。

针对暴露旧版 OpenAI `/v1/completions` 端点的本地或自托管后端：
text-generation-webui（"ooba"）、koboldcpp、vLLM、Ollama、
llama.cpp server 等。与聊天适配器不同，它消费序列化的提示词：提示词管线
渲染 instruct 格式并把一个内容为完成提示词的单一 user 消息交给适配器，
适配器把它发布到 `/completions`。对于本地服务器，API 密钥是可选的，
并且绝不记录。

## NovelAI

文件：`novelai.ts` —— 类型 `novelai`。

针对 NovelAI 文本生成 API（`POST {baseUrl}/ai/generate`，带 Bearer 密钥）。
生成是非流式的 —— 单个 `delta` 加上终止的 `done` 事件，
符合统一流契约。该 API 不提供模型发现，因此 `listModels` 返回配置的
模型。适配器被标记为实验性的，因为 NovelAI 的参数表面在演变；
只映射了成熟的采样器。

## KoboldAI

文件：`koboldai.ts` —— 类型 `koboldai`。

针对 KoboldAI/Kobold 服务器原生 API（`POST {baseUrl}/api/v1/generate`）。
生成是非流式的；已加载的模型从 `/api/v1/model` 读取用于发现。
典型的本地安装不需要 API 密钥。

## AI Horde

文件：`aiHorde.ts` —— 类型 `ai-horde`。

针对 AI Horde（`stablehorde.net`），一个异步的众包集群。作业通过
`/api/v2/generate/text/async` 提交，然后通过状态端点轮询直到完成；
轮询循环重新检查调用方信号和一个空闲截止时间，因此卡住的作业会中止，
而不是永远轮询。匿名使用允许但优先级较低；配置时 API 密钥作为 `apikey`
头发送。

## Echo

文件：`echo.ts` —— 类型 `echo`。

一个完全离线的提供商，用于测试、演示以及在没有网络或 API 密钥的情况下
验证流式管线。它逐词把最后一条 user 消息流式返回。它还实现可选的语音、
图像和转录方法，因此它是编写覆盖每个功能模式的适配器的有用参考。

## 提示词辅助

文件：`prompt.ts` —— 导出 `promptFromMessages`，
一个把消息数组序列化为适配器发送的提示词形状的共享辅助函数。
它本身不是适配器。

所有这些实现的精确 `ProviderAdapter` 接口，请参阅
[适配器契约](adapter-contract.md)和生成的
[提供商 SDK 参考](../../api/provider-sdk/)。
