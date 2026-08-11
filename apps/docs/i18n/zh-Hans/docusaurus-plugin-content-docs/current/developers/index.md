---
title: 开发者
description: >-
  NeoTavern 开发者文档概述：架构、提示词管线、数据层，以及用于扩展应用的 SDK。
sidebar_position: 1
---

本部分说明 NeoTavern 是如何构建的，以及你如何通过插件、主题和提供商适配器
扩展它。

## 本部分涵盖的内容

开发者文档分为四组：

- **架构** —— monorepo 布局、已批准的技术栈，以及每个工作区包的职责。
- **提示词管线** —— 把聊天变成提供商请求的固定阶段集合，包括 instruct 格式、
  分词和上下文移位。
- **数据与存储** —— NeoTavern 如何在 SQLite 中存储结构化数据、文件和图像
  如何在磁盘上处理，以及备份如何工作。
- **扩展 NeoTavern** —— 插件 SDK、主题 SDK、提供商适配器、生成的 API 参考
  和桌面外壳。

## 从哪里开始

如果你想理解代码库的形态，请从[架构概述](developers/architecture/)开始；如果你在做
生成相关的工作，可以直接跳到[提示词管线](developers/prompt-pipeline/)。

## 数据层

[数据与存储](developers/data/)部分涵盖 SQLite 数据库、文件系统布局和备份模型。
它是任何持久化数据的参考。

## 扩展 NeoTavern

NeoTavern 可以通过四种方式扩展：

- [插件 SDK](developers/plugin-sdk/) —— 带清单、权限、前端和后端 API、生命周期钩子
  和沙箱化的插件。
- [主题 SDK](developers/theme-sdk/) —— 由设计令牌、组件皮肤和外壳布局构建的主题。
- [提供商](developers/providers/) —— 实现统一适配器契约的提供商适配器。
- [旧版兼容](developers/legacy-compat) —— 面向 SillyTavern 时代插件和脚本的兼容层。

[API 参考](api/) 在每次站点构建时由 TypeDoc 从 SDK 源码生成，
因此其成员页面始终与已发布的包一致。

## 桌面端

[桌面端](developers/desktop/)部分记录了 Tauri 2 外壳、Node.js sidecar，
以及安装程序和便携版如何打包。
