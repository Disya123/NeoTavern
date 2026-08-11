---
title: 开发环境
description: 搭建 NeoTavern 开发环境并在本地运行项目
sidebar_position: 2
---

本页说明如何为 NeoTavern 搭建开发环境并在本地运行项目。

## 前置条件

- Node.js 24 LTS 或更新版本 —— 项目要求 Node `>= 24`。
- pnpm 9 —— 工作区要求 pnpm `>= 9` 且 `< 10`，并声明
  `packageManager: pnpm@9.15.0`；用 corepack 启用它或直接安装。
- Windows、macOS 或 Linux。桌面应用为最终用户内置了自己的 Node.js 运行时，
  但开发总是使用你安装的 Node.js。

## 安装依赖

```bash
pnpm install
```

这会安装每个工作区包。仓库是一个 pnpm monorepo：应用位于 `apps/`
（服务器和 Web），共享库位于 `packages/`。

## 在开发模式下运行

```bash
pnpm dev
```

并行启动带热重载的 Fastify 后端和 Vite Web 应用。要分别运行它们：

```bash
pnpm dev:server
pnpm dev:web
```

打开 Vite 开发服务器打印的 URL，在设置中连接一个提供商，
并发送你的第一条消息来验证完整管线：聊天、服务器、提供商、流式输出和保存。

## 质量门禁

推送前运行这些：

```bash
pnpm typecheck    # 整个 monorepo 的 TypeScript 检查
pnpm lint         # ESLint，不允许有警告
pnpm test         # Vitest 单元和集成测试，加上 Web 测试
pnpm test:e2e     # Playwright 端到端套件（先构建工作区）
pnpm build        # 完整工作区构建（tsc -b 和 Vite）
pnpm format:check # Prettier 检查
```

`pnpm test:e2e` 会先编译整个工作区，因此预计它比其他检查耗时更长。
`docs:check` 和 `docs:build` 脚本校验内部开发者文档；公开站点有自己的
命令，记录在[文档站点](./docs-site)页面。

## 桌面端开发

桌面外壳（Tauri）及其 Node sidecar 是独立的应用：

```bash
pnpm desktop:dev       # 在开发模式下运行桌面应用
pnpm desktop:portable  # 构建 Windows 便携包
pnpm desktop:release   # 构建安装程序包
```

桌面打包涉及特定于操作系统的工具链；详情请参阅开发者文档的
[桌面端](../developers/desktop/)部分。

## 常见问题

- `pnpm install` 或 `pnpm dev` 失败：检查 `node -v` 是否报告 24 或更新版本，
  以及 `pnpm -v` 是否报告 9。
- 开发服务器无法启动：检查没有其他进程占用服务器和 Vite 使用的端口，
  然后重新启动 `pnpm dev`。
