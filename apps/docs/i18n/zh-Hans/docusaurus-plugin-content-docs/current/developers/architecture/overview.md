---
title: Monorepo 概述
description: >-
  NeoTavern monorepo 布局、服务器与 Web 之间的数据流，以及塑造架构的本地优先原则。
sidebar_position: 2
---

NeoTavern 是一个本地优先的应用：一个 Fastify 进程同时服务 API 和可选的内置
前端，不需要外部数据库、队列或容器。

## Monorepo 布局

工作区是一个 pnpm monorepo，包含两个顶层组 `apps/` 和 `packages/`：

```text
apps/
  server/          # Fastify 后端：API、提示词管线、SSE、旧版主机
  web/             # React SPA
  plugin-runtime/  # 面向后端插件的受限 Node.js 进程
  desktop/         # Tauri 2 外壳；把服务器作为 sidecar 进程运行
packages/
  shared/        # UUIDv7 ID、Result、错误、日志、异步工具
  contracts/     # TypeBox API schema —— 唯一事实来源
  db/            # SQLite：schema、迁移、仓库、FTS5
  ui/            # 基于 Radix 原语的无头组件
  i18n/          # i18next 设置和语言资源
  plugin-sdk/    # 插件清单、权限和 API 契约
  theme-sdk/     # 主题令牌、层级和继承
  provider-sdk/  # 提供商适配器契约和适配器
  legacy-compat/ # 窗口全局对象和 DOM 兼容孤岛
  gestures/      # 框架无关的行手势
  plugin-build/  # 插件构建和发布管线
```

## 应用

- `apps/server` —— Fastify 后端。它暴露 `/api/v2/*` API，运行提示词管线，
  通过 SSE 流式输出生成结果，并托管兼容 Express 的旧版界面。
  每个模块都是一个隔离的 Fastify 插件。
- `apps/web` —— React SPA。它通过 HTTP 与服务器通信，渲染聊天工作区，
  以及角色、设置、提供商、主题和插件的界面。
- `apps/plugin-runtime` —— 一个权限受限的 Node.js 进程，不受信任的后端插件
  在其中执行，与主服务器进程隔离。
- `apps/desktop` —— Tauri 2 外壳。它把编译后的服务器作为自包含的 Node.js
  sidecar 启动，并且只在本地 API 就绪后才打开 webview。

## 包

共享代码位于 `packages/` 下职责狭窄的包中。每个包只有一个职责，
依赖只向下指：`server` 和 `web` 依赖包，包最多依赖 `shared` 和 `contracts`。
完整细分请参阅[包](packages)。

## 数据流

一个典型的请求经过以下层次：

1. 前端通过 TanStack Query 调用 `/api/v2/*` 端点。
2. Fastify 根据 TypeBox schema 校验输入，并以 `{ code, params, traceId }`
   信封返回错误。
3. `@neotavern/db` 中的仓库读写 SQLite，带游标分页和 FTS5 搜索。
4. 生成运行 `POST /api/v2/chats/:id/generate`：提示词管线组装上下文，
   提供商适配器序列化请求，响应通过 SSE 流式返回，消息被保存。

Web 应用是单页：路由改变聊天工作区，而角色、设置、提供商、主题和插件在
保留的聊天位置之上的对话框界面中渲染。

## 本地优先原则

一切都在你的机器上运行：

- 后端默认绑定 `127.0.0.1`。远程访问需要显式选择加入，并带有有界会话和
  HTTPS 要求。
- 所有数据都存放在一个本地数据目录中：一个 SQLite 数据库加上一个内容寻址
  文件存储。没有 PostgreSQL、Redis 或 Docker。
- 应用支持离线工作。提供商调用是唯一的网络流量，内置的 `echo` 适配器让
  你在没有任何提供商的情况下测试整个管线。
- 备份、导出和 SillyTavern 导入都通过相同的 SQLite 和文件 API 在本地完成。

存储层请参阅[数据与存储](../data/)，生成路径请参阅
[提示词管线](../prompt-pipeline/)。
