---
title: Instruct 格式
description: >-
  Instruct 格式如何使用沙箱化的 Handlebars 模板渲染干净的消息数组、
  内置格式和版本化 JSON 预设。
sidebar_position: 3
---

Instruct 格式定义了干净的消息数组如何被渲染成提示词字符串，使用无法访问
文件系统或代码执行的沙箱化 Handlebars 模板。

## 格式管理器

一个内置的格式管理器持有 instruct 格式。格式是在隔离环境中渲染的
Handlebars 模板：模板只接收 `content`、`role` 和 `name`，
并且只有文档记录的辅助函数可用。模板没有 Node.js 访问权、没有文件系统
访问权，也没有执行任意代码的途径。

一个格式描述：

- system、user、assistant 和 tool 模板；
- BOS 和 EOS 令牌；
- 消息分隔符；
- 特殊令牌。

## 内置格式

NeoTavern 附带以下格式：

- **ChatML** —— `<|im_start|>` / `<|im_end|>` 角色块。
- **Llama 3** —— 带角色标签的 `<|begin_of_text|>`。
- **Alpaca** —— 指令和响应块。
- **Mistral** —— `[INST]` / `[/INST]` 块。
- **Command-R** —— `<|START_OF_TURN_TOKEN|>` 块。
- **自定义格式** —— 用户定义的模板，可以选择作为活动格式。

## 渲染前的干净消息数组

在渲染阶段之前，管线只处理带角色（`system`、`user`、`assistant`、`tool`）
的结构化消息数组。宏被解析，设定集和记忆被插入，上下文移位移除多余内容，
插件拦截器修改这个数组。渲染恰好发生一次，就在渲染阶段，
因此没有适配器会第二次重新格式化提示词。

## 最终输出

渲染阶段产生两种形状之一：

- **字符串** —— 渲染好的提示词，发送给文本补全提供商并用于诊断。
- **结构化 JSON** —— `GenerationMessage[]` 数组，发送给接受角色标记消息的
  聊天提供商。

模式由 `serializeAsText` 选择：文本适配器（`text-completion`、`novelai`、
`ai-horde`、`koboldai`）总是接收作为单个 `user` 消息的渲染 instruct 提示词；
聊天适配器（`openai-compatible`、`anthropic`）接收结构化数组。

## 宏

`{{user}}`、`{{char}}` 和自定义变量在最终渲染之前被解析。宏绝不会在模板
引擎内部展开，因此模板文件保持纯粹的标记。

## 自定义格式和预设

活动的自定义格式存储在 `AppSettings.instructFormat` 中。设置后，
干净的消息数组被渲染成单个字符串，该格式的停止字符串成为请求的停止序列。
为 `null` 时，使用原生结构化序列化。

格式作为**版本化 JSON 预设**导入和导出：

- `importInstructFormat()` 在预设变为活动状态之前校验它；
- `exportInstructFormat()` 产生 JSON 安全、分隔的值；
- 预设带有版本，因此较旧的导出可以在导入时迁移。

## 另请参阅

- 渲染在阶段顺序中的位置，请参阅[管线阶段](stages)。
- 渲染后的上下文如何被计数，请参阅[分词](tokenization)。
- 适配器如何消费序列化输出，请参阅[提供商](../providers/)。
