---
title: 文档站点
description: NeoTavern 文档站点如何工作，以及如何添加或修复页面
sidebar_position: 4
---

公开文档站点是 `apps/docs` 中的一个 Docusaurus 项目。本页说明其布局以及
如何添加或更新页面。

## 布局

- 英文源页面位于 `apps/docs/docs/`，每个页面一个 markdown 文件，
  按侧边栏显示的相同目录组织。
- 翻译位于
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`，
  每个页面一个文件地镜像英文树；请参阅[翻译](./translations)。
- `apps/docs/docs/api/` 下的 SDK 参考是生成的并被 gitignore；
  不要手工编辑它。

## 添加页面

1. 在页面应出现的目录中创建 markdown 文件。
2. 添加带 `title`、`description` 和 `sidebar_position` 的前置元数据：

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. 以一句话概述页面内容作为开头。
4. 使用 `##` 和 `###` 作为章节；前置元数据的 `title` 提供唯一的 H1。
5. 如果你添加了新目录，在其中创建一个 `_category_.json`：

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position` 对目录内的页面排序；概述页面是 1。内容侧边栏部分从
目录结构自动生成。

## MDX 限制

页面只能是纯 Markdown 加 Docusaurus 提示框：

```md
:::note
Text inside the admonition.
:::
```

没有 `import` 语句、没有自定义 JSX 组件、没有选项卡、没有原始 HTML。
每个页面都必须保持可以原样复制到八个翻译语言环境中的任何一个。
代码示例使用带语言标签的围栏块。

## SDK 参考

SDK 参考由 TypeDoc 从每个包的入口点生成：

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

参考在每次站点构建时重新生成，因此对生成页面的编辑会丢失。要修复参考
页面，改为修复包源码中的 TSDoc。`apps/docs/docs/api/index.md` 的概述是
手写的，并保持提交。

## 运行站点

```bash
pnpm docs:site        # 带热重载的本地开发服务器
pnpm docs:site:build  # 生产构建：所有语言环境加上 SDK 参考
```

生产构建是门禁 —— 损坏的链接和损坏的 markdown 链接会使它失败 ——
因此在推送内容变更之前运行它。

## 链接规则

内部链接必须指向站点中存在的页面。从首页偏好绝对站点路径
（`/getting-started/`），从较深的页面偏好相对路径（`contributing/` 下的
页面用 `../developers/`）。外部链接限于 Docusaurus 文档和 NeoTavern 仓库。

## 内部开发者文档

仓库在根目录的 `docs/` 中还保留内部开发者文档，由 `pnpm docs:check` 和
`pnpm docs:build` 校验。那是与本公开站点分开的一组文档；
不要把两个树混淆。
