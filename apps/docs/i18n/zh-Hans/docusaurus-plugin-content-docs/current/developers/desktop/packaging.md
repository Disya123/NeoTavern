---
title: 打包
description: Windows、macOS 和 Linux 的发行格式，以及首次运行体验。
sidebar_position: 4
---

NeoTavern 按平台以原生软件包形式分发，每个都携带 Node.js sidecar、SQLite、
原生插件和生产 Web 资源。

## 发行格式

桌面构建产生：

- **Windows 安装程序** —— 带按用户安装模式的 NSIS 和 MSI 安装程序。
  安装程序注册应用，并把用户数据放在平台的应用本地数据目录中。
- **Windows 便携版** —— 一个包含可执行文件、sidecar、`portable.flag`
  标记和 `resources/` 的 ZIP，外加一个 `.sha256` 校验和文件。
  存在标志时，数据位于应用旁边的本地 `data/` 文件夹中，
  而不是应用本地数据目录。
- **macOS 软件包** —— 一个 `.app` 应用包，在 macOS 运行器上打包成 DMG。
- **Linux** —— 一个 AppImage 和一个压缩包。

每种格式都在其自己的原生平台运行器上构建并冒烟测试，
因为发行版捆绑了原生插件。不支持跨平台复制准备好的工件。

## 内部包含什么

每个软件包都包含应用运行时所需的一切：

- Tauri 2 外壳。
- 自包含的 Node.js 24 sidecar 可执行文件。
- 通过 `better-sqlite3` 的 SQLite。
- 用于图像处理的 Sharp。
- 生产 Web 资源。

由于 Node.js、SQLite 和资源都在软件包内，用户不需要预先安装任何东西 ——
不需要 Node.js、npm 或数据库设置。

## 首次运行

首次启动是产品的核心承诺：打开应用，它就工作。

1. 外壳启动 sidecar。
2. 后端创建数据目录、初始化 SQLite 数据库、运行待处理的迁移
   （在待处理的 schema 变更前创建备份）、预置内置主题和起始角色。
3. webview 在应用就绪时打开。

没有终端、没有平台之外的安装向导、没有 `npm install`、没有手动配置。
如果用户选择了聊天背景或安装了插件，这些都存在于可执行文件之外 ——
用户数据与软件包分离，因此更新替换核心时不会触碰用户文件。

## 更新

发布构建签名其工件并集成 Tauri 更新器。更新器在安装平台工件之前验证
清单和 minisign 签名，然后重启外壳。回滚意味着把之前审查过的代码作为
新的签名发布重新发布 —— 不允许未签名的降级。插件和主题通过插件和主题
管理器独立更新；用户文件永远不会进入可执行更新工件。

## 构建

从仓库中，打包命令是：

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` 构建服务器和 Web、复制目标特定的原生插件，
并创建带 Tauri 目标三元组后缀的 sidecar。`desktop:portable` 额外构建
NSIS/MSI 安装程序和带校验和的便携 ZIP，然后运行无头外壳冒烟测试。
`desktop:release` 产生签名的更新器工件，需要发布密钥。构建安装程序需要
构建机器上有 Rust stable MSVC、Windows C++ 构建工具和 WebView2 ——
最终用户都不需要这些。
