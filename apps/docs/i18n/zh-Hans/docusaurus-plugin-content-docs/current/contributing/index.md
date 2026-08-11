---
title: 参与 NeoTavern 贡献
description: 如何为 NeoTavern 做贡献 —— issue、代码、文档和翻译
sidebar_position: 1
---

NeoTavern 是一个开放项目，欢迎各种形式的贡献：错误报告、功能请求、代码、
文档和翻译。

## 贡献方式

- **报告错误和请求功能。** 在 GitHub 上提交 issue，附上版本、操作系统和
  复现步骤：
  [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **编写代码。** 选择一个 issue，在上面评论，然后打开一个拉取请求。
  保持变更小而聚焦，并遵循[代码指南](contributing/code-guidelines)。
- **改进文档。** 公开站点位于 `apps/docs`；请参阅
  [文档站点](contributing/docs-site)。
- **翻译。** 帮助维护八个语言环境之一，或提议一个新的语言环境；请参阅
  [翻译](contributing/translations)。

## 行为准则

尊重其他贡献者。在审查和 issue 中保持建设性，假定善意，
让讨论聚焦于工作本身。仓库中的
[AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md)
是项目如何构建以及任务如何完成的权威描述；在第一次变更之前请阅读它。

## 开始之前

- 首先阅读[开发环境](contributing/development-setup)和[代码指南](contributing/code-guidelines)，
  以及上面链接的 AGENTS.md 文件。
- 查找是否已有覆盖你想做内容的 issue，并在开始大型工作之前评论，
  让维护者可以尽早反馈。
- 保持拉取请求聚焦：每个 PR 一个逻辑变更，包含测试和文档。

## 提交之后会发生什么

维护者审查变更，CI 运行质量门禁 —— lint、类型检查和测试。一切变绿后，
拉取请求被合并，用户可见的变更进入更新日志。
