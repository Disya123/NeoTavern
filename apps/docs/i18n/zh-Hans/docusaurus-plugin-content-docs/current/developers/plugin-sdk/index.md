---
title: 插件 SDK 概述
description: 插件 SDK 是什么，以及前端和后端 API 的划分如何工作。
sidebar_position: 1
---

插件 SDK 是插件用来扩展 NeoTavern 的版本化公共 API，涵盖浏览器端界面和
服务器端后端。

## 插件 SDK 是什么

插件是 ZIP 软件包（`.stplugin`），包含清单、可选的前端和后端入口点以及
资源。它们只能通过 `@neotavern/plugin-sdk` 包扩展应用 —— 绝不能直接导入 Fastify、
React、Zustand、TanStack Query、SQLite 连接或内部组件。那些是宿主的实现
细节，会随时变化。

SDK 是版本化的（清单中的 `apiVersion`），因此插件可以在应用更新后继续
工作。宿主强制这个契约：你通过 SDK 注册的一切都会在插件被禁用时被清理，
你需要从内部模块获得的东西则被刻意不暴露。

## 前端和后端划分

一个插件有两个可选的一半：

- **前端** —— 一个浏览器 ESM 入口，在其 `activate()` 调用中接收
  `FrontendPluginApi`。它注册工具栏操作、消息操作、斜杠命令和设置面板等
  UI 界面，并监听应用事件。
- **后端** —— 一个 Node.js ESM 入口，接收 `ServerPluginApi`。它在
  `/api/plugins/{pluginId}/` 下挂载路由，读写隔离的存储，执行带权限检查的
  网络调用，并注册提供商和上下文移位策略。

两半都是可选的。只添加一个工具栏按钮的插件不需要后端；只提供一个 API 的
插件不需要前端。每个注册都返回一个清理函数，运行时收集这些函数，
因此停用后不会留下任何东西。

## 编写插件

从 `@neotavern/plugin-sdk` 导入 `definePlugin` 并导出一个带 `activate(api)`
函数的定义：

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

生成的[插件 SDK 参考](../api/plugin-sdk/)以精确签名记录了每个导出的类型
和函数。

## 下一步

- [清单](manifest.md) —— 软件包结构和 `plugin.json` schema。
- [权限](permissions.md) —— 权限模型和同意流程。
- [前端 API](frontend.md) —— 注册 UI 界面和事件。
- [后端 API](backend.md) —— 路由、存储和服务器抽象。
- [生命周期](lifecycle.md) —— 安装、启用、禁用和清理保证。
- [沙箱化](sandboxing.md) —— 面向不受信任代码的安全模型。
