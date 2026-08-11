---
title: 包
description: >-
  每个工作区包的职责，以及让 monorepo 保持无循环的依赖方向。
sidebar_position: 4
---

每个工作区包只有一个职责，依赖只向下指，这让 monorepo 保持无循环。

## 依赖方向

代码只能依赖它"下面"的包：

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (底线)
```

`server` 和 `web` 依赖包；包最多依赖 `shared` 和 `contracts`。
循环依赖被禁止。添加新代码时，把它放在能够承载它的最窄的包中：
共享辅助代码去 `@neotavern/shared`，API 形状去 `@neotavern/contracts`，
任何与数据库相关的内容去 `@neotavern/db`。

## 包职责

- `@neotavern/shared` —— 零运行时依赖的同构工具：UUIDv7 ID、`Result`、
  `AppError` 信封、带密钥脱敏的结构化日志器、超时和信号辅助函数，
  以及提示词宏。
- `@neotavern/contracts` —— 每个 API 输入和输出的 TypeBox schema。
  服务器和 Web 共享的唯一事实来源；绝不由手工重复。
- `@neotavern/db` —— SQLite：Drizzle schema、迁移、仓库和 FTS5 搜索。
  唯一与数据库对话的包。
- `@neotavern/ui` —— 基于 Radix 原语、设计令牌和主题所依赖的 `data-*` 钩子
  构建的无头基础组件。
- `@neotavern/i18n` —— i18next 设置、命名空间、`en` 和 `ru` 资源，
  以及把机器错误码映射到本地化文本的错误码本地化器。
- `@neotavern/plugin-sdk` —— 版本化的插件 SDK：清单 schema、权限和能力授予，
  以及插件编译所依赖的前端和后端 API 契约。
- `@neotavern/theme-sdk` —— 主题 SDK：清单 schema、令牌/组件/外壳层级和继承解析。
- `@neotavern/provider-sdk` —— 统一提供商适配器契约，加上面向 LLM、TTS、STT 和
  图像提供商的内置适配器，以及适配器注册表。
- `@neotavern/legacy-compat` —— 旧版兼容层：`window` 全局对象、事件总线，
  以及面向 SillyTavern 时代脚本的非托管 DOM 孤岛。
- `@neotavern/gestures` —— 框架无关的行手势：上下文菜单（右键和长按）和拖放
  重排识别。
- `@neotavern/plugin-build` —— 插件构建和发布管线：分析、签名和构建插件包。

## 什么放在哪里

- **API 形状**始终来自 `@neotavern/contracts`。后端和前端绝不会重复声明同一个类型。
- **数据库访问**只通过 `@neotavern/db` 仓库进行。插件代码永远不会收到 SQLite
  连接。
- **提供商行为**位于 `@neotavern/provider-sdk` 适配器中。服务器核心不与任何单个
  提供商的 SDK 耦合，有一个文档记录的例外：Anthropic 适配器为 beta 界面
  使用官方 SDK。
- **UI 构建块**来自 `@neotavern/ui`；应用界面组合它们。框架无关的手势保留在
  `@neotavern/gestures` 中，以便在 React 之外复用。

## 添加一个包

新包需要一个声明其用途、公共入口点、依赖和约束的 `README.md` ——
文档是实现的一部分。在创建之前，先检查代码是否适合现有包；
默认答案是不新建包。
