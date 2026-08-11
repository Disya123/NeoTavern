---
title: 设计令牌
description: 语义设计令牌契约，以及组件不得硬编码的内容。
sidebar_position: 3
---

设计令牌是承载应用中所有视觉值的语义变量。组件引用它们；主题覆盖它们；
没有什么是硬编码的。

## 令牌契约

每个令牌都是一个以 `--st-` 为前缀的 CSS 自定义属性，每个令牌名都是
`@neotavern/theme-sdk` 中版本化契约的一部分。宿主为浅色和深色模式提供默认值，
因此即使主题没有定义任何令牌，每个令牌也总是可以解析。

规范的令牌组是：

- **文本颜色** —— `color-text-primary`、`color-text-secondary`、
  `color-text-muted`、`color-text-inverse`、`color-text-link`。
- **表面** —— `color-surface-primary`、`color-surface-secondary`、
  `color-surface-tertiary`、`color-surface-overlay`、`color-surface-canvas`、
  `color-surface-elevated`。
- **强调和状态** —— `color-accent`、`color-accent-hover`、
  `color-accent-text`、`color-accent-soft`、`color-accent-soft-text`、
  `color-border`、`color-border-strong`、`color-success`、`color-warning`、
  `color-danger`、`color-info`。
- **聊天消息 markdown** —— `color-message-quote`、
  `color-message-emphasis`、`color-message-code`、`color-message-code-bg`。
- **排版** —— `font-ui`、`font-mono`、从 `font-size-2xs` 到
  `font-size-2xl`、`line-height-body`、从 `font-weight-normal` 到
  `font-weight-bold`。
- **间距** —— 从 `space-2xs` 到 `space-3xl`。
- **圆角和边框** —— `radius-control`、`radius-card`、
  `radius-overlay`、`radius-panel`、`radius-round`、`radius-inset`、
  `border-width`。
- **高度（阴影）** —— `shadow-card`、`shadow-soft`、`shadow-focus`、
  `shadow-overlay`。
- **层（z-index）** —— `layer-base`、`layer-raised`、`layer-panel`、
  `layer-plugin-overlay`、`layer-plugin-chrome`、`layer-dropdown`、
  `layer-modal`、`layer-notification`。
- **动效** —— `motion-duration-fast`、`motion-duration-normal`、
  `motion-duration-slow`、`motion-easing-standard`、`effect-glass-blur`。
- **控件大小** —— `control-height`、`control-height-large`、
  `control-height-sm`、`control-height-xs`、`control-height-2xs`、
  `control-hit-min`、`switch-width`、`switch-height`、`switch-thumb-size`、
  `menu-min-width`、`dialog-max-width`、`dialog-max-height`、
  `textarea-min-height`、`spinner-size`。
- **面板和内容大小** —— `size-panel-max-height`、
  `size-content-max-height`、`size-chat-column-max`。
- **视口限制** —— `overlay-width-limit`、`overlay-height-limit`、
  `dialog-sheet-height`。
- **滚动条** —— `scrollbar-width`、`scrollbar-radius`、
  `scrollbar-track-bg`、`scrollbar-thumb-bg`、`scrollbar-thumb-hover-bg`、
  `scrollbar-fade-duration`、`scrollbar-fade-easing`、
  `scrollbar-hide-delay`。
- **应用外壳大小** —— `shell-rail-width`、`shell-panel-width`、
  `shell-panel-min-width`、`shell-panel-max-width`。
- **聊天画布** —— `chat-wallpaper-image`、`chat-wallpaper-position`、
  `chat-wallpaper-size`、`chat-wallpaper-overlay`、`chat-wallpaper-blur`、
  `custom-wallpaper-overlay-alpha`。
- **聊天排版度量** —— `chat-markdown-column-width`、
  `chat-message-block`、`chat-message-inline`。
- **用户可调旋钮** —— `custom-glass-blur`、`custom-ui-opacity`。

## 覆盖令牌

主题覆盖名称的任何子集。值会被校验：它们必须是安全的非空 CSS 值，
`{`、`}` 和 `;` 等构造会被拒绝。

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

如果用户选择了聊天背景，应用会在工作区根上设置一个用于壁纸图像的作用域
自定义属性；位置、大小、覆盖和模糊仍然是主题的令牌。

## 解析规则

令牌按以下顺序解析，后者胜出：

1. 活动模式的内置默认值。
2. 父主题链，根在前。
3. 主题本身。

当没有深色覆盖时，深色模式回退到主题的浅色令牌，因此仅浅色的主题在深色
模式下仍然有效。`@neotavern/theme-sdk` 中的 `resolveTokens` 和
`buildThemeVariables` 函数实现这一点，宿主把结果作为 CSS 变量写到
`document.documentElement` 上。

## 组件不得硬编码的内容

样式契约禁止在内置 UI 的任何地方使用硬编码值，同样的规则也适用于主题
不得依赖的内容：

- 数字 `font-weight`、以 px 为单位的 `font-size` 和原始 `border-radius`。
- 数字 `z-index` 值 —— 使用 `layer-*` 令牌。
- `40px`、`44px`、`52px`、`32px` 和 `36px` 等控件大小。
- 主题 CSS 中的 `!important`，除非在无障碍偏好层中。
- 布局规则：坐标、网格和 flex 方案、断点和区域顺序不是令牌契约的一部分。
  断点来自注册表（`VIEWPORT_BREAKPOINTS` 和 `CONTAINER_BREAKPOINTS`），
  移动外壳区域不在 v1 范围内。

卡片列表的网格方案等内容几何是一个明确的例外：它不受令牌契约的覆盖。
主题重新样式化所需的一切都可以通过令牌、钩子和声明式外壳布局获得。
生成的[主题 SDK 参考](../../api/theme-sdk/)记录了精确的 `TokenName` 列表。
