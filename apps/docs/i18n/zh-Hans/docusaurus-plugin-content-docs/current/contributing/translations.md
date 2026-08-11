---
title: 翻译
description: 为 NeoTavern 文档站点贡献翻译，或改进现有翻译
sidebar_position: 5
---

文档站点以英语加八个语言环境发布，每个翻译都是社区贡献。本页说明如何
贡献一个翻译或修复现有翻译。

## 当前语言环境

基础语言是英语。翻译的语言环境是俄语（`ru`）、简体中文（`zh-Hans`）、
日语（`ja`）、韩语（`ko`）、西班牙语（`es`）、法语（`fr`）、德语（`de`）
和巴西葡萄牙语（`pt-BR`）。

## 翻译存放在哪里

每个语言环境在 `apps/docs/i18n/` 下镜像英文树：

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<path>.md
```

界面字符串 —— 导航栏、页脚、标语和侧边栏标签 —— 位于
`apps/docs/i18n/<locale>/docusaurus-theme-classic/` 下的 JSON 文件中，
由 write-translations 命令生成。

## 完整性

每个英文页面都应在相同的相对路径下有一个翻译副本。未翻译的页面会自动
回退到英语，因此部分进度立即可见 —— 但目标是完整覆盖，
绝不要提交翻译了一半的文件。

## 要翻译的内容

- 标题、正文、说明文字和替代文本。
- 前置元数据的 `title` 和 `description`；保持 `sidebar_position` 不变。
- `_category_.json` 标签。

## 要保留的内容

- 链接、代码围栏、行内代码和提示框语法（`:::note` ... `:::`），逐字节保留。
- 产品名：NeoTavern 从不翻译。
- API 标识符、文件名、命令和标志保持英文形式。

## 术语

在应用自身的界面措辞存在时使用它；否则使用你语言中的标准社区术语。
当标准社区术语已经存在时，优先使用它 —— 绝不要发明新词。

## 修复翻译

在相同相对路径下编辑你的语言环境的文件并打开一个拉取请求。
当页面的英文源发生变化时，在同一个变更中更新该页面的翻译。

## 添加新语言环境

1. 把语言环境代码及其显示标签添加到 `apps/docs/docusaurus.config.ts` 的
   `i18n.locales` 和 `localeConfigs` 中。
2. 搭建语言环境文件夹：

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. 翻译 `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`
   下的每个页面以及生成的 JSON 文件。
4. 打开一个同时包含配置变更和新文件的拉取请求。

语言环境代码遵循标准约定，例如简体中文用 `zh-Hans`，
巴西葡萄牙语用 `pt-BR`。
