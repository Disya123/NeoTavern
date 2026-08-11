---
title: 提示词管线
description: >-
  提示词管线概述：固定的阶段顺序、instruct 格式、本地令牌计数和上下文移位。
sidebar_position: 1
---

提示词管线是把聊天变成提供商请求的固定、有序的阶段集合，
从用户输入到保存的消息。

## 管线做什么

每一次生成 —— 新消息、滑动、重新生成或代写 —— 都以相同的顺序经过相同的
阶段。管线从角色、人设、设定集和记忆中组装上下文，统计令牌，
把上下文装进模型的预算，让插件拦截，以选定的 instruct 格式渲染请求，
最后流式输出并保存响应。

## 本部分的页面

- [管线阶段](prompt-pipeline/stages) —— 按顺序排列的 14 个阶段，以及每个插件钩子必须遵守
  的规则。
- [Instruct 格式](prompt-pipeline/instruct-formats) —— 干净的消息数组如何使用沙箱化的
  Handlebars 模板渲染。
- [分词](prompt-pipeline/tokenization) —— 本地分词器注册表及其近似回退。
- [上下文移位](prompt-pipeline/context-shifting) —— 管线如何把上下文装进令牌预算，
  以及有哪些策略。

## 实现

管线位于 `apps/server/src/pipeline/`。它完全在服务器上运行，
在任何网络调用之前，因此到达提供商的请求始终是相同确定性阶段的结果。

## 相关部分

- 插件拦截器及其注册 API 记录在[插件 SDK](plugin-sdk/)中。
- 生成端点和上下文审计是 [API 参考](../api/)的一部分。
- 消费序列化请求的提供商适配器记录在[提供商](providers/)下。
