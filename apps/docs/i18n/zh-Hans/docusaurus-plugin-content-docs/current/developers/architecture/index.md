---
title: 架构
description: >-
  架构部分概述：monorepo 布局、已批准的技术栈，以及每个包的职责。
sidebar_position: 1
---

本部分说明 NeoTavern monorepo 如何组织、使用哪些技术，以及服务器、Web
客户端和桌面外壳如何协同工作。

## 本部分的页面

- [Monorepo 概述](architecture/overview) —— `apps/` 和 `packages/` 的布局、服务器与
  Web 之间的数据流，以及本地优先原则。
- [技术栈](architecture/stack) —— 已批准的栈：Node.js 24、Fastify 5、React 19、
  Vite 8、SQLite、Drizzle、Tauri 2 和 pnpm workspaces。
- [包](architecture/packages) —— 每个工作区包的职责以及它们之间的依赖方向。

## 相关部分

[提示词管线](prompt-pipeline/)部分详细描述了生成阶段，
[数据与存储](data/)记录了数据库、文件处理和备份。
