---
title: 插件清单
description: 每个 .stplugin 软件包必须包含的 plugin.json schema。
sidebar_position: 2
---

插件清单（`plugin.json`）是插件的唯一事实来源：身份、入口点、请求的权限
和声明的能力。

## 软件包布局

一个 `.stplugin` 软件包是一个 ZIP 归档，根目录包含 `plugin.json`、
它所引用的入口文件以及任何资源。宿主在安装任何东西之前会校验归档：
路径遍历、符号链接、可执行载荷和大小限制都会被拒绝。

## 清单字段

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

核心字段是：

- **`id`** —— 反向 DNS 标识符，例如 `author.plugin-name`。它在所有已安装的
  插件中唯一，并在更新中保持稳定。
- **`name`** —— 插件管理器中显示的人类可读名称。
- **`version`** —— 语义化版本（`major.minor.patch`）。它用于版本比较和
  缓存失效。
- **`apiVersion`** —— 插件所针对的 SDK API 版本。当前版本是 3；
  在新运行时投入生产之前，版本 2 仍是默认值。
- **`engines`** —— 兼容性约束，例如 `neotavern: "^0.1.0"`。
- **`frontend`** —— 浏览器 ESM 入口的相对路径。
- **`backend`** —— Node.js ESM 入口的相对路径。
- **`styles`** —— 可选的插件样式表。
- **`i18n`** —— 语言环境代码到翻译 JSON 文件相对路径的映射。

## 权限

`permissions` 数组是来自 SDK v2 的旧版扁平列表。新清单应改为通过
`requiredCapabilities` 和 `optionalCapabilities` 声明作用域能力：

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` 是插件离不开的能力；`optionalCapabilities` 是没有
也能降级运行的能力。用户在安装时确认每个请求的能力。在更新中添加新权限
需要重新同意 —— 请参阅[权限](permissions.md)。

## 旧版入口点

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

`legacy` 块指向现有 SillyTavern 扩展的受信任兼容入口。使用任一入口的
软件包必须请求 `legacy.trusted` 权限，界面会在同意期间显示更强的警告。
安全模式绝不加载旧版入口点。这与原生插件有何不同，请参阅
[沙箱化](sandboxing.md)。

## OAuth 客户端

连接到外部服务的插件可以声明使用带 PKCE 的授权码流程的公共 OAuth 2.0
客户端：

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

只允许公共客户端：`clientSecret` 被禁止，因为插件代码在沙箱中运行。
端点必须是 HTTPS，开发期间本地身份提供商可以有纯 HTTP 回环例外。
更改描述符需要重新安装软件包。

## Worker 和签名字段

高级清单可以声明额外的模块：

- **`workers`** —— 插件可以派生为隔离计算 worker 的包内入口模块。
  派生未声明的入口会被拒绝。
- **`publisher`** 和 **`signature`** —— 软件包签名。`keyId` 是签名公钥的
  `ed25519:<hex>` 指纹，`signature` 是对规范清单的 base64 Ed25519 签名。
  这些由插件构建工具设置，绝不由手写。

SDK 中的 `validateManifest` 函数检查每个字段，生成的
[插件 SDK 参考](../../api/plugin-sdk/)记录了精确的 `PluginManifest` 类型。
