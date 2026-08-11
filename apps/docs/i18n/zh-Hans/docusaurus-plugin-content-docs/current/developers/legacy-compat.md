---
title: 旧版兼容
description: 仍然可用的、有文档记录的 SillyTavern 时代契约。
sidebar_position: 8
---

NeoTavern 为现有的 SillyTavern 时代扩展保留了一组有文档记录的契约，
因此针对这些 API 编写的插件可以继续工作，而原生插件 SDK 是前进的方向。

## 窗口全局对象

`@neotavern/legacy-compat` 包会安装旧扩展所期望的、有文档记录的窗口全局对象：

- `window.SillyTavern` —— 带有 `getContext()`、`eventSource` 和
  `event_types`。
- `window.eventSource` —— 旧版事件源。
- `window.event_types` —— 事件名常量。
- `window.extension_settings` —— 共享的扩展设置对象。
- `window.$` 和 `window.jQuery` —— 内置的 jQuery 实例。

这些全局对象幂等地安装，并通过桥接器连接到宿主，因此旧代码可以读取与
原生代码相同的上下文和事件。

## 非托管 DOM 孤岛

旧版前端扩展期望拥有页面的一部分。宿主为此提供非托管 DOM 孤岛：
一个稳定的容器，旧代码可以在 React 树之外直接附加和操作它。扩展获得
容器，宿主处理其周围应用的其余部分。

## 旧版服务器插件

旧版服务器插件通过一个兼容 Express 的主机运行。它们的路由在
`/api/plugins/{pluginId}/...` 下代理，与原生后端插件使用的命名空间相同。
`@fastify/express` 集成只在这个兼容层内使用 —— 新的核心是 Fastify 原生的，
不经过 Express 路由。

## 受信任边界

旧版入口是一种受信任模式，而不是沙箱绕过。使用它们的软件包必须在清单中
声明 `legacy.frontend` 或 `legacy.backend`，并请求 `legacy.trusted` 权限，
同意界面会对此显示增强警告。旧版前端代码在主窗口中执行，
旧版后端代码获得一个限定在自身插件命名空间内的 Express 路由器。
安全模式完全不加载旧版入口。详情请参阅[插件沙箱化](plugin-sdk/sandboxing.md)
和[插件清单](plugin-sdk/manifest.md)。

## 不支持的内容

兼容性是一份有文档记录的契约，而不是对普遍行为的承诺。依赖以下任何一项
的插件都不受支持：

- 随意的内部 CSS 类名。
- 对应用内部的猴子补丁。
- 从它们不拥有的包中进行的私有导入。

这些都是实现细节，会随版本变化。当旧版 API 发生变化时，
变更会附带迁移指南和兼容性测试。

## 向前迁移

对于新功能，原生[插件 SDK](plugin-sdk/index.md) 是受支持的路径：
版本化、权限校验、沙箱化，并由宿主清理。旧版兼容的存在是为了让现有扩展
继续存活，而不是为了增长。把扩展移植到 SDK，以获得完整的安全和生命周期
保证。
