---
title: 技术栈
description: >-
  已批准的 NeoTavern 技术栈：Node.js 24、Fastify 5、React 19、Vite 8、
  严格 TypeScript、带 Drizzle 的 SQLite 和 Tauri 2。
sidebar_position: 3
---

NeoTavern 运行在一个刻意"无聊"的技术栈上：Node.js 24 LTS、Fastify 5、
React 19、Vite 8、严格 TypeScript、带 Drizzle ORM 的 SQLite，
以及 Tauri 2 桌面外壳。

## 运行时和语言

- **Node.js 24 LTS** —— 后端和内置桌面 sidecar 的运行时。代码在切实可行的
  情况下保持与 Node.js 22 兼容。
- **严格 TypeScript** —— 处处启用。无正当理由的 `any`、`as unknown as`、
  `@ts-ignore` 和非空断言被禁止。系统边界使用 `unknown` 和显式校验。
- **仅 ESM** —— 所有应用和包都使用 ES 模块。

## 后端

- **Fastify 5** —— API 框架。每个后端模块都是一个隔离的 Fastify 插件。
- **TypeBox + Fastify Type Provider** —— 每个 API 输入和输出都有一个 JSON
  Schema，由 `@neotavern/contracts` 生成。
- **SSE** —— 流式生成通过 Server-Sent Events 运行。WebSocket 保留给真正的
  双向通道。
- **AbortSignal** —— 每个长时间运行的操作都接受一个 `AbortSignal`，
  并在客户端断开时干净地超时。

## 前端

- **React 19** —— 单页应用，无服务端渲染。
- **Vite 8** —— 打包器和开发服务器。Vite 只是构建工具，不是应用插件 API。
- **React Router** —— 路由，带有单一聊天工作区，系统界面渲染在其上。
- **TanStack Query** —— 服务器状态的唯一存储。
- **Zustand** —— 只用于瞬时界面状态：活动面板、主题和语言偏好、置顶角色，
  以及有限的仅会话草稿。
- **Radix Primitives** —— 由 `@neotavern/ui` 包装的可访问无头组件。

## 数据

- **通过 better-sqlite3 使用 SQLite** —— 单一数据库文件，以 WAL、
  `foreign_keys = ON`、`busy_timeout` 和预编译语句打开。
- **Drizzle ORM** —— 类型化 schema、仓库和迁移。
- **FTS5** —— 对角色、聊天记录和消息的全文搜索。

## 样式

- **CSS Modules + 自定义属性 + 级联层 + 容器查询** —— 样式工具集。
  主题在不与特异性搏斗的情况下覆盖设计令牌和层级规则。

## 模板和本地化

- **Handlebars** —— instruct 格式模板，在无文件系统或代码执行权限的沙箱
  环境中渲染。
- **i18next** —— 所有面向用户的字符串，带命名空间和按语言环境的资源。

## 桌面端

- **Tauri 2** —— 桌面外壳，Node.js 服务器以自包含的 sidecar 二进制形式
  交付。
- **tauri-plugin-shell 和 tauri-plugin-updater** —— 进程管理和签名更新。

## 工具

- **pnpm workspaces** —— monorepo 包管理器。
- **Vitest** —— 单元和集成测试。
- **Playwright** —— 端到端测试，包括桌面外壳冒烟测试。

## 刻意不包含的内容

- 没有 PostgreSQL、Redis、Docker 或任何其他你必须安装或运行的服务。
- 除了 API 进程之外，前端没有 SSR 或 Node 服务器。
- 不用 `node:vm` 作为插件的安全沙箱 —— 不受信任的后端插件在单独的受限
  进程中运行。

各部分如何组合请参阅[Monorepo 概述](overview)，谁拥有什么请参阅[包](packages)。
