---
title: 组件皮肤
description: 主题皮肤的样式栈，从级联层到稳定钩子。
sidebar_position: 4
---

组件皮肤层级重新样式化内置组件。它构建在一个特定的样式栈和一个稳定的
钩子契约之上。

## 样式栈

内置 UI 一起使用四种技术：

- **CSS Modules** 用于组件作用域的样式，使用被明确视为非公共契约的哈希
  类名。
- **CSS 自定义属性** 用于语义令牌（`--st-*`）。
- **级联层** 用于排列事实来源的顺序。
- **容器查询** 用于适应组件自身容器的布局，尺寸以 `rem` 表示。

主题针对钩子属性，绝不针对生成的类名。

## 级联层顺序

所有样式都生活在一个固定的级联层顺序中：

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

后面的层胜过前面的层，因此优先级是：

1. `reset` —— 基础重置。
2. `tokens` —— 令牌定义。
3. `base` —— 元素级默认值。
4. `components` —— 内置组件样式。
5. `plugin-base` —— 面向插件提供的基础样式的层。
6. `theme` —— 活动主题的皮肤。
7. `user` —— 用户自己的覆盖，最后加载。

用户覆盖样式表总是最后加载，因此损坏的或有主见的主题永远无法阻止用户
覆盖它。就 `!important` 而言：除属于面向用户的无障碍模式的无障碍偏好层
外，主题 CSS 中禁止该构造。

## 钩子契约

主题通过四个属性样式化组件，这些属性由宿主发布，并像 SDK 的其他部分一样
版本化：

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` —— 组件类型。
- `data-part` —— 组件内部的结构部分。
- `data-role` —— 语义角色，例如消息角色。
- `data-state` —— 状态，例如 `open`、`closed` 或 `streaming`。

主题的皮肤 CSS 随后看起来像这样：

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

`@neotavern/theme-sdk` 包导出 `dataHook` 辅助函数来构建这些属性对象，
因此组件作者和主题作者使用相同的名称。

## 什么不是契约

- **生成的 CSS-module 类名** —— 哈希、不稳定，不是 SDK 的一部分。
  针对它们的主题会在下一次构建时失效。
- **内部 React 层级** —— 主题不得依赖文档记录钩子之外的组件内部或 DOM
  顺序。
- **数字布局值** —— 坐标、网格方案和断点不能通过令牌契约样式化；
  视口断点位于注册表中，容器查询必须用 `rem` 编写。

## 禁止的 CSS

主题样式表在加载前被扫描。禁止的构造在安装和校验时被拒绝：

- `@import`
- `javascript:` URL 和 `expression()`。
- `-moz-binding` 和 `behavior:`。
- 远程或协议相对 URL（`url(http:`、`url(https:`、`url(//`）。
- `data:text/html`。
- `!important`（无障碍偏好层除外）。

这让主题 CSS 保持纯净、本地和安全。皮肤应该引用的令牌请参阅
[设计令牌](design-tokens.md)；皮肤可以重新样式化的命名区域请参阅
[外壳契约](shell-contract.md)。
