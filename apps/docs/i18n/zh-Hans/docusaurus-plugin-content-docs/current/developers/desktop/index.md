---
title: 桌面端概述
description: 桌面应用如何交付 —— 一个带内嵌 Node.js sidecar 的 Tauri 2 外壳。
sidebar_position: 1
---

桌面应用是 NeoTavern 的原生发行版：一个 Tauri 2 外壳，把 Fastify 后端作为
内嵌的 Node.js sidecar 运行。

## 一个应用，零设置

桌面发行版是自包含的。Node.js、SQLite 和生产 Web 资源都打包在软件包内，
因此首次运行不需要终端、Git、npm 或手动数据库设置。你安装应用、启动它，
本地 API 就绪后 webview 就会打开。

运行时组件是：

- **Tauri 2 外壳** —— 原生窗口和应用生命周期。
- **Node.js sidecar** —— 一个自包含的 Node.js 24 二进制，
  在 `127.0.0.1` 上本地运行 Fastify 后端。
- **SQLite** —— 本地数据库，首次运行时在数据目录中自动创建。

## 支持的格式

桌面构建针对大多数用户期望的格式：

- Windows 安装程序（NSIS 和 MSI）。
- Windows 便携版（一个带便携标志的 ZIP）。
- macOS 软件包（`.app`，加上 DMG）。
- Linux AppImage 和压缩包。

每种格式都在其原生平台运行器上构建，因为发行版捆绑了 `better-sqlite3`
和 Sharp 等原生插件。格式细节和首次运行行为请参阅[打包](packaging.md)。

## 生命周期保证

外壳和 sidecar 是一个整体。关闭窗口会关闭后端 —— 应用绝不会留下孤立的
Node.js 进程。意外的后端退出会以错误结束外壳，而不是留下一个静默损坏的
窗口。机制请参阅[Tauri 外壳](tauri-shell.md)和
[Node Sidecar](node-sidecar.md)。

## 数据位置

已安装的构建把用户数据存储在平台的应用本地数据目录中，绝不会放在软件包
内。便携版是例外：存在便携标志时，数据位于应用旁边的本地 `data/` 文件夹
中。数据处理本身在[数据与存储](../data/index.md)部分中介绍。

## 下一步

- [Tauri 外壳](tauri-shell.md) —— 原生窗口及其生命周期。
- [Node Sidecar](node-sidecar.md) —— 内嵌的后端进程。
- [打包](packaging.md) —— 发行格式和首次运行。
