---
title: 后端插件 API
description: 后端插件接收的受限服务器端抽象。
sidebar_position: 5
---

后端 API 是服务器端插件在其 `activate()` 调用中收到的内容：面向路由、
存储、事件、日志、网络访问、提供商和文件的受限抽象 —— 仅此而已。

## 入口点

后端插件导出一个带 `activate(api)` 函数的定义，该函数接收
`ServerPluginApi` 对象：

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

后端入口作为一个独立的 Node.js 进程运行。插件永远不会收到 Fastify 根
实例、SQLite 连接、内部表、绝对路径、完整环境或其他提供商的 API 密钥。

## 路由

`api.routes` 是一个挂载在 `/api/plugins/{pluginId}/` 下的作用域路由器。
每个方法接受一个路径和一个处理器，并返回一个清理函数：

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

一个 `PluginRequest` 携带 `params`、`query`、`headers`、解析后的 JSON
`body` 和一个 `AbortSignal`。一个 `PluginResponse` 是
`{ status, body, headers }`。处理器可以直接返回值或返回一个 promise；
宿主强制执行超时，并通过信号取消工作。

## 存储

`api.storage` 是一个按插件隔离的命名空间键/值存储：

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

数据限定在你的插件 ID 内，因此两个插件永远不会冲突。

## 事件和日志

`api.events` 是前端使用的同一个类型化事件总线。订阅返回一个退订函数，
所有订阅在禁用、崩溃或关闭时自动移除。发出被限制在你自己的命名空间
（`{pluginId}.event`）内，载荷必须是 JSON 安全的，宿主会限制载荷大小和
每个运行时的事件名数量。

`api.logger` 提供 `debug`、`info`、`warn` 和 `error` 方法，
每个都接受一条消息和可选的元数据。日志绝不会包含密钥。

## 带权限检查的 Fetch

`api.fetch` 是由插件的 `network:<host>` 权限保护的 `fetch`：

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

对未授予主机的请求在任何网络活动之前就被拒绝。其他提供商的密钥绝不会被
注入到你的请求中。响应对象暴露 `ok`、`status`、`text()` 和 `json()`。

## 提供商和上下文策略

`api.providers` 让插件扩展生成：

- `api.providers.register(kind, factory, options)` 注册一个新的提供商适配器
  类型（需要 `providers.register`）。注册返回一个清理函数。
- `api.providers.registerTokenizer(profile)` 注册一个本地模型特定的分词器。
  配置文件声明 `id`、`approximate`、`matches(model)` 和 `count(text)`。
  精确分词器可以从 tiktoken、SentencePiece 或 Hugging Face 分词器 JSON
  构建；在为某个模型注册之前，宿主会回退到感知脚本的启发式方法，
  并把计数标记为近似。注册在停用时自动移除。

`api.contextStrategies.register(strategy)` 添加一个上下文移位策略。宿主
验证系统块、置顶块和当前用户块得以保留，并自己应用最终的令牌预算 ——
策略返回的 `fitsBudget` 值不被信任。

`api.postProcessors.register(processor)` 添加一个生成后钩子。它在流完成
之后、消息保存之前运行；返回一个新字符串会替换助手回复。它需要
`prompt.modify`。

## 虚拟文件系统

`api.files` 是一个沙箱化的虚拟文件系统，根目录是插件自己的数据目录：

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

路径无法逃出插件根目录，因此插件只能触碰自己的数据。

## 后端插件不能做什么

API 表面是刻意很小的。没有办法到达宿主数据库、其他插件的存储、任意的
文件系统路径或未经审查的网络主机。如果 SDK 没有暴露它，
它就是不可访问的。生成的[插件 SDK 参考](../../api/plugin-sdk/)列出了完整的
`ServerPluginApi` 表面，[提供商](../providers/index.md)说明了提供商插件
如何融入这个模型。
