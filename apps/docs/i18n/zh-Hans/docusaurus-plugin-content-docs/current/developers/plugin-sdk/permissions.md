---
title: 插件权限
description: 权限如何声明和授予，以及更新何时需要重新同意。
sidebar_position: 3
---

权限是一种机制，让用户决定插件可以做什么 —— 从读取聊天历史到发出网络
请求。

## 权限模型

权限是一个命名能力的字符串。在清单中声明权限是一个请求，而不是自动访问：
用户必须在插件变为活动之前确认每个请求的权限，宿主会在每个使用点强制
授予。

内置集合是一个稳定、版本化的契约：

| 权限                 | 授予的内容                                            |
| -------------------- | ----------------------------------------------------- |
| `chat.read`          | 读取聊天消息及其元数据                                |
| `chat.write`         | 创建或修改聊天消息                                    |
| `characters.read`    | 读取角色和角色卡                                      |
| `characters.write`   | 创建或修改角色                                        |
| `lorebook.read`      | 读取设定集条目                                        |
| `lorebook.write`     | 创建或修改设定集条目                                  |
| `prompt.inspect`     | 检查组装好的提示词                                    |
| `prompt.modify`      | 修改提示词或后处理生成输出                            |
| `providers.register` | 注册提供商适配器和分词器                              |
| `ui.toolbar`         | 添加工具栏操作                                        |
| `ui.sidebar`         | 添加侧边栏面板                                        |
| `ui.messageActions`  | 添加消息操作                                          |
| `ui.shell`           | 向外壳槽位添加内容                                    |
| `clipboard.read`     | 读取剪贴板                                            |
| `clipboard.write`    | 写入剪贴板                                            |
| `notifications`      | 显示通知                                              |
| `server.routes`      | 挂载后端路由                                          |
| `legacy.trusted`     | 在受信任上下文中运行有文档记录的 SillyTavern 旧版代码 |

## 作用域权限

有些权限带有作用域，写成 `kind:scope`：

- **`network:<hostname>`** —— 从特定主机获取的权限，例如
  `network:api.example.com`。对未授予主机的请求会被拒绝。
- **`network:*`** —— 允许从任何主机获取的通配符。宿主把它视为完整的网络
  访问权，同意界面会以增强警告显示它。优先列出具体主机；不鼓励发布请求
  通配符的插件。
- **`files:plugin`** —— 在插件自己的数据目录内读写。
- **`files:user-selected`** —— 访问用户显式选择的文件。

`hasPermission` 检查一个已授予集合是否满足所需权限，`parsePermission`
把 `kind:scope` 字符串拆分为其组成部分。`validatePermissions` 函数会拒绝
空、重复或未知等格式错误的字符串。

## 授予如何被强制执行

声明权限是不够的；宿主在强制执行点应用授予：

- UI 注册在挂载前检查 `ui.*` 权限。
- 路由检查 `server.routes`。
- 带权限检查的 `fetch` 检查 `network:<host>`。
- 虚拟文件系统检查 `files:*`。
- 提供商和上下文 API 检查 `providers.register` 和 `prompt.modify`。

能力内核（`@neotavern/plugin-sdk` 的 `kernel` 命名空间）是在 Web 宿主和服务器中
都检查授予的共享层，因此浏览器和后端总是看到相同的有效权利。授予以单调
递增的修订号存储，在引导握手期间交付给沙箱，并且可以在运行时撤销。
进行中的操作以 `CAPABILITY_REVOKED` 错误完成，打开的手柄由宿主关闭。

## 同意与更新时的重新同意

安装会显示请求权限的完整列表。插件保持在 `needs-consent` 状态，
直到你确认每个权限；当软件包附带 npm 依赖时，界面会显示依赖列表。

更新插件对权限检查来说是一次新的安装：宿主用 `diffPermissions` 计算旧
清单和新清单之间的差异。如果更新添加了权限：

- 插件的运行时立即被禁用；
- 用户被要求同意新权限；
- 插件保持禁用，直到给予同意。

移除权限永远不需要同意。一般规则是：没有用户的明确决定，已授予权限的集合
绝不会增长。权限常量和辅助函数的完整列表，请参阅生成的
[插件 SDK 参考](../../api/plugin-sdk/)。
