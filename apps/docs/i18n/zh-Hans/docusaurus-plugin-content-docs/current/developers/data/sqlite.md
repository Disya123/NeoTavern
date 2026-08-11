---
title: SQLite 存储
description: >-
  SQLite 数据库设置、STRICT 表、FTS5 搜索、稳定的 UUIDv7 ID、版本化迁移
  和插件隔离。
sidebar_position: 2
---

NeoTavern 把所有结构化数据存储在一个 SQLite 数据库中，带有严格的 pragma、
STRICT 表、FTS5 搜索和版本化迁移。

## 数据库设置

连接使用以下设置打开：

- `foreign_keys = ON` —— 强制引用完整性。
- WAL 日志模式 —— 读操作永远不会被写操作阻塞。
- `busy_timeout` —— 并发写入者等待而不是立即失败。
- `synchronous = NORMAL` —— 在 WAL 安全性能下保持持久性。
- 预编译语句 —— 所有查询都通过 Drizzle 的预编译语句；没有原始 SQL 字符串
  插值。
- 尽可能使用 STRICT 表 —— SQLite 强制列类型。
- FTS5 —— 对角色、聊天记录和消息的全文搜索。

## 稳定 ID

每个实体都有一个稳定的字符串 ID，最好是 UUIDv7。ID 绝不是数组索引。
在需要回收站的地方，行通过 `deleted_at` 软删除，而不是被移除。

## Schema 概述

主要表涵盖资料库和运行时状态：角色、人设、聊天、分支、消息和消息变体、
标签、设定集和设定条目、预设、提供商配置和密钥、带设置和能力授予的插件
注册表、主题注册表、提示词上下文审计、导入任务和工件，以及缓存元数据。

有两个模式对插件作者很重要：

- `plugin_state` 把插件拥有的状态与安装注册表分开存储，带 `schema_version`
  表示数据格式，带 `revision` 用于比较并交换。
- `provider_secrets` 把 API 密钥存储为只写值：只有掩码预览会离开仓库。

## FTS5 搜索

虚拟表 `characters_fts`、`chats_fts` 和 `messages_fts` 驱动搜索，
使用 `unicode61` 和 `remove_diacritics` 构建。`INSERT`/`UPDATE`/`DELETE`
上的触发器以事务方式保持它们同步。搜索支持前缀词（`token*`）、标签筛选和
bm25 相关性排序。完整重建可在 `POST /api/v2/search/rebuild` 使用。

## 迁移

每个 schema 变更都作为迁移交付：

- 迁移是**版本化且幂等的** —— `IF NOT EXISTS` 加上严格的版本让重新运行
  是安全的。
- 迁移以**事务**方式运行；失败的迁移整体回滚。
- 没有自动的 `down` 迁移。回滚意味着恢复迁移前的备份，
  运行器会在危险的迁移之前自动为有数据的数据库创建该备份。
- 读取数据绝不会触发隐藏的破坏性变更。

迁移运行器的安全备份如何工作，请参阅[备份](backups)。

## 插件隔离

插件永远不会收到直接的 SQLite 连接。所有持久化都通过插件 SDK 的存储 API
进行，该 API 代表插件拥有 `plugin_storage` 和 `plugin_state` 表。
这让插件数据保持版本化、可撤销，并免受原始 SQL 事故的影响。存储 API
请参阅[插件 SDK](../plugin-sdk/)。

## 绝不会进入数据库的内容

- 图像和音频存储在磁盘上，绝不会作为 BLOB 存在于主数据库中。
  请参阅[文件和图像](files-and-images)。
- 未知的角色卡字段和扩展元数据保留在 `ext` 列中，
  并在导出和导入中存活。
