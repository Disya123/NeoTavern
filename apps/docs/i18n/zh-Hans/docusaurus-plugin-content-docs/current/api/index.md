---
title: SDK 参考
description: 面向四个公开 SDK 包的自动生成 TypeDoc 参考文档的概述。
sidebar_position: 1
---

SDK 参考是 NeoTavern 向插件、主题和提供商作者公开的四个 TypeScript 包的
自动生成 API 参考文档。

## 生成的内容

该参考文档在每次站点构建时由 TypeDoc 从每个包的 `src/index.ts` 入口点生成。
它记录了以下包的完整导出表面：

- **插件 SDK** —— `@neotavern/plugin-sdk`：清单校验、权限模型、类型化事件，
  以及前端和后端插件 API 契约。
- **主题 SDK** —— `@neotavern/theme-sdk`：设计令牌契约、主题清单校验、继承解析
  和 CSS 变量生成。
- **提供商 SDK** —— `@neotavern/provider-sdk`：提供商适配器契约、内置适配器、
  令牌估算和运行时注册表。
- **契约** —— `@neotavern/contracts`：后端路由和前端类型共同派生的共享请求、
  响应和实体 schema。

生成的页面不是手写的，也不会提交到仓库。它们会在每次构建时重新生成，
因此始终与包当前的 `src/` 保持一致。

## 重新生成参考文档

任何 Docusaurus 构建都会作为流程的一部分重新生成参考文档：

```bash
pnpm --filter @neotavern/docs build
```

在修改 SDK 源文件后，如果想获得一份新的参考文档，请在本地运行同样的命令。

## 浏览各包

- [插件 SDK 参考](api/plugin-sdk/)
- [主题 SDK 参考](api/theme-sdk/)
- [提供商 SDK 参考](api/provider-sdk/)
- [契约参考](api/contracts/)

如果需要的不是原始 API 列表而是使用指南，请参阅本文档的插件 SDK、主题 SDK
和提供商章节。它们以文字和示例解释契约，并链接回生成的页面以获取精确签名。
