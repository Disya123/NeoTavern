---
title: 数据与存储
description: >-
  数据层概述：SQLite 数据库、原始文件和缓存的文件系统布局，以及备份模型。
sidebar_position: 1
---

本部分说明 NeoTavern 如何存储数据：SQLite 数据库、原始文件和缓存的文件
系统布局，以及备份模型。

## 数据目录

所有用户数据都存放在一个本地数据目录中：

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## 本部分的页面

- [SQLite 存储](data/sqlite) —— pragma、STRICT 表、FTS5 搜索、稳定的 UUIDv7 ID
  和迁移。
- [文件和图像](data/files-and-images) —— 原始文件和可重新生成的缩略图如何
  存储并以原子方式写入。
- [备份](data/backups) —— 备份模型、恢复，以及备份覆盖的内容。

## 相关部分

- [架构](architecture/)部分说明了数据层在 monorepo 中的位置。
- 面向用户的视图请参阅[用户指南](../user-guide/data-and-backups)中的
  数据与备份。
