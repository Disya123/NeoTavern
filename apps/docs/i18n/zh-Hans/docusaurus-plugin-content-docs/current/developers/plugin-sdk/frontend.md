---
title: 前端插件 API
description: 前端插件如何注册页面、面板、操作、命令和事件。
sidebar_position: 4
---

前端 API 是浏览器端插件在其 `activate()` 调用中收到的内容：面向每个 UI
界面的注册器集合、事件总线和 i18n。

## 入口点

前端插件导出一个带 `activate(api)` 函数的定义。一旦插件被同意并激活，
宿主就会用 `FrontendPluginApi` 对象调用它：

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // 在这里注册界面。
  },
  deactivate() {
    // 可选的显式拆除。
  },
});
```

每个注册器都返回一个清理函数。运行时自动收集这些函数，
因此你的插件不需要手工跟踪它们 —— 尽管 `deactivate()` 仍然可以拆除你
自己管理的任何内容。

## 注册界面

`api.ui` 命名空间把 UI 注册器分组在一起：

- **页面** —— `api.ui.pages.register({ id, path, title, mount })` 在插件
  命名空间下添加一个路由。`mount` 接收宿主提供的容器，并可以返回一个拆除
  函数。
- **设置面板** —— `api.ui.settingsPanels.register(...)` 向设置屏幕添加
  一个面板。
- **工具栏操作** —— `api.ui.toolbarActions.register({ id, title, icon,
run })`。宿主把操作渲染为标准按钮；你只提供语义，绝不提供布局或断点。
- **消息操作** —— `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`。`run` 回调接收一个不可变的消息快照，
  加上一个在拆除、重新调用或超时时触发的 `AbortSignal`。
- **上下文菜单项** —— `api.ui.contextMenuItems.register({ id, title,
context, run })`，用于 `context: 'message' | 'character'`。
- **消息渲染器** —— `api.ui.messageRenderers.register({ id, title,
render })`。`render` 返回纯文本，`placement` 为 `'replace'` 或 `'after'`
  —— 绝不是 HTML。
- **角色选项卡** —— `api.ui.characterTabs.register({ id, title, mount })`。
  `mount` 接收 `{ characterId }` 作为上下文。
- **侧边栏面板** —— `api.ui.sidebarPanels.register({ id, title, slot,
mount })`，`slot: 'left' | 'right'`。
- **对话框** —— `api.ui.dialogs.register({ id, title, description, mount })`。
- **命令面板操作** —— `api.ui.commands.register({ id, title, run })`。
- **快捷键** —— `api.ui.hotkeys.register({ id, combo, run })`，例如
  `combo: 'mod+shift+k'`。

斜杠命令通过 `api.slash.register({ name, description, run })` 单独注册，
提示词拦截器通过 `api.interceptors` 注册。

## 提示词拦截器

拦截器在组装好的提示词被发送之前对其运行：

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages 是 { id, role, content, name } 的数组。
    return context;
  },
});
```

较低的 `priority` 先运行；超过 `timeoutMs` 的插件会被跳过，而不会破坏链。
只检查提示词的拦截器需要 `prompt.inspect`；修改提示词的拦截器需要
`prompt.modify`。

## 事件

事件总线是类型化的，并与宿主共享。`api.events.on(event, handler)` 返回
一个退订函数：

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

内置事件包括 `chat.created`、`chat.opened`、`chat.message.created`、
`chat.message.updated`、`chat.message.deleted`、`character.selected`、
`generation.started`、`generation.delta`、`generation.finished`、
`generation.error`、`theme.changed` 和 `language.changed`。插件也可以
发出并监听自定义事件，名称按约定加命名空间前缀，例如 `myplugin.foo`。

## 消息快照和内容门控

消息操作接收一个不可变的 `MessageActionSnapshot`，包含 `messageId`、
`chatId`、`branchId`、`role`、`content`、`name`、`meta` 和 `revision`。
除非插件还持有 `chat.read`，否则 `content` 字段为 `null`，
因此操作可以在从不看到消息文本的情况下渲染元数据。

## 通知和 i18n

`api.notify({ title, description, variant, timeoutMs })` 显示一个通知并
返回一个关闭函数。`variant` 是 `info`、`success`、`warning` 或 `error`。

`api.i18n` 在隔离的插件命名空间中管理翻译资源：

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` 与所有其他注册一样返回一个清理函数。

## 清理保证

由于每个注册都返回一个清理函数，并且运行时跟踪它们，禁用插件会移除它的
所有处理器、定时器、DOM 节点、订阅和后台请求。完整的拆除契约请参阅
[生命周期](lifecycle.md)，精确类型请参阅生成的
[插件 SDK 参考](../../api/plugin-sdk/)。
