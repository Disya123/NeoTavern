---
title: 外壳契约
description: 主题样式化和插件填充的命名外壳区域。
sidebar_position: 5
---

外壳契约定义了应用的命名区域。主题样式化这些区域；插件通过稳定槽位向其中
添加内容。

## 命名外壳区域

宿主用稳定的槽位属性发布每个主要区域：

| 槽位                 | 区域                           |
| -------------------- | ------------------------------ |
| `app.shell`          | 应用外壳根                     |
| `navigation.primary` | 导航栏                         |
| `chat.header`        | 聊天头部                       |
| `chat.viewport`      | 聊天滚动视口                   |
| `chat.composer`      | 消息输入框                     |
| `character.browser`  | 角色浏览器根                   |
| `panel.left`         | 左侧上下文面板                 |
| `status.area`        | 连接状态区域                   |
| `modal.layer`        | 模态层（插件位于系统表面之下） |
| `notification.layer` | 通知层                         |

两个槽位被保留但不在 v1 中：`navigation.secondary` 和 `panel.right`。

## 契约允许的内容

主题可以：

- 通过其 `data-slot` 属性及其内部的组件钩子**样式化任何命名区域**。
- 通过清单中的声明式 `shellLayout` **排列主要区域** —— 目前是导航栏顺序
  （`main` 和 `bottom` 组）和管理选项卡的放置（`pinned`）。
- 通过 `chat-wallpaper-*` 令牌**替换聊天画布背景**。

区域的自由形式重排 —— 例如把导航栏移到右侧 —— 不是 v1 的一部分。
槽位可以被样式化和填充，但不能被移动。

## 插件如何添加内容

插件接收 SDK 注册 API，宿主把其内容放入稳定槽位。例如，用
`slot: 'left'` 注册的侧边栏面板在 `panel.left` 内部渲染，
插件对话框在系统表面之下的 `modal.layer` 内堆叠。

这种划分产生的契约：

- 主题绝不依赖插件的内部 DOM。
- 插件绝不依赖内部 React 层级或特定的生成类名。
- 双方只在命名槽位和钩子属性处相遇。

## 区域内的稳定钩子

在区域内，组件发布标准的钩子属性。值得注意的例子：

- 输入框根发布 `data-slot="chat.composer"`，带一个工具栏部分、一个字段
  部分和一个 `data-component="textarea"` 输入。
- 按钮发布 `data-component="button"`，带 `data-part="icon"` 和
  `data-part="label"`；相关操作位于操作栏（`data-component="action-bar"`）
  中，带主要和次要组。
- 选项卡发布 `data-component="tabs"`，带 `list`、`trigger` 和 `content`
  部分；管理面板使用分段变体。
- 消息发布 `data-component="chat-message"`，带
  `data-role="user|assistant|system|tool"` 和 `streaming` 等状态。
- 导航栏发布 `data-component="navigation-rail"`，带
  `data-part="main-items"`、`data-part="bottom-items"` 和每个条目的
  `data-item="<id>"`，加上 `data-state="expanded|collapsed"`。
- 所有导航栏面板共享一个头部装饰
  （`data-component="sidebar-panel-header"`），因此主题只需样式化一次。

## 布局职责

宿主拥有对行为至关重要的布局：焦点陷阱、逻辑 RTL 方向、安全区域内边距和
最小交互目标尺寸。外壳主题可以改变区域的外观和排列，但必须保留文档记录
的 DOM 顺序、操作列表的水平滚动和键盘行为。断点在 SDK 中注册
（`VIEWPORT_BREAKPOINTS` 用于以 px 为单位的视口宽度，
`CONTAINER_BREAKPOINTS` 用于以 rem 为单位的容器大小），
`prefers-reduced-motion` 等功能查询不是布局断点。

样式化这些区域的样式层请参阅[组件皮肤](component-skin.md)；
外壳损坏时的恢复请参阅[安全模式](safe-mode.md)。
