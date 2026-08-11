---
title: 分词
description: >-
  通过分词器注册表进行本地令牌计数：tiktoken 兼容、SentencePiece、
  Hugging Face JSON、模型特定插件和近似回退。
sidebar_position: 4
---

令牌计数通过一个支持 tiktoken 兼容、SentencePiece、Hugging Face JSON 和
模型特定插件分词器的注册表在本地运行，并带有明确的近似回退。

## 本地计数

令牌计数永远不会离开机器。注册表为活动模型选择一个分词器配置文件，
管线在任何网络请求之前于进程内统计组装好的上下文。

## 分词器注册表

注册表接受四类分词器：

- **Tiktoken 兼容** —— 与 OpenAI 的 tiktoken 兼容的 BPE 分词器，
  用于 OpenAI 模型家族。
- **SentencePiece** —— 附带 SentencePiece 词表的模型。
- **Hugging Face 分词器 JSON** —— 来自 Hugging Face 仓库的
  `tokenizer.json` 文件，转换为紧凑的秩格式。
- **模型特定插件** —— 提供商插件可以为某个模型注册精确的分词器配置文件。

对于没有注册分词器的模型存在一个**近似回退**，它总是被明确标注，
因此界面绝不会把估算当作精确计数呈现。

## 内置配置文件

核心为常见家族注册离线配置文件：

- `openai:o200k_base` —— GPT-4o、GPT-4.1、GPT-5、o1、o3 和 o4 家族。
- `openai:cl100k_base` —— GPT-4、GPT-3.5 Turbo 和 text-embedding-3。
- `deepseek:bytelevel-bpe-v1` —— DeepSeek 家族。计数通过一个紧凑的仅计数
  引擎（一个无词表、无解码器的 BPE 合并移植）在官方 `tokenizer.json` 的
  秩上运行。该文件被转换一次，成为一个存储在
  `data/cache/tokenizers/deepseek-v4-flash/` 中的小秩文件，通过原子的
  临时文件加重命名写入；完整的 JSON 和运行时分词器库既不存储也不加载。

如果网络不可用，DeepSeek 配置文件会诚实地回退到近似配置文件，
并且最多每 15 分钟重试一次 —— 缺少分词器绝不会阻塞生成。

## 近似回退

未知的本地模型使用 `approximate-character-v1`，一种感知脚本的启发式方法：
拉丁文约每令牌 4.6 个字符、西里尔文 4.0、CJK 1.7、数字 2.0。
近似在它出现的每个地方都被标记，提供商插件可以随时通过注册精确配置文件
替换它。

## 插件配置文件

插件以优先级注册分词器配置文件。优先级高于 `-10` 的插件配置文件会为它
覆盖的模型覆盖家族配置文件。选定的配置文件以 `countTokens`、
`tokenizerProfile` 和 `tokenizerApproximate` 传入管线。

## 令牌预算结果

计数之后，管线暴露 `PipelineResult.tokenBudget`，其中包含：

- 使用的分词器配置文件；
- `approximate` 标志；
- 模型的上下文限制；
- 预留的响应空间；
- 最终的提示词令牌计数。

预算如何执行请参阅[上下文移位](context-shifting)。
