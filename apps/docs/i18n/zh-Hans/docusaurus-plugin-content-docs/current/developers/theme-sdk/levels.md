---
title: 主题层级
description: 主题化的三个层级 —— 令牌、组件皮肤和外壳布局。
sidebar_position: 2
---

一个主题由三个独立的层级构建。理解这种划分，才能让主题在不触碰行为的情况下
改变整个应用的外观。

## 第 1 层：设计令牌

令牌是以 `--st-` 为前缀的语义 CSS 自定义属性。它们涵盖颜色、排版、间距、
圆角、边框、阴影、z-index 层、动效、控件大小、滚动条和聊天画布。

组件只引用令牌 —— 它们绝不会硬编码颜色、字体或间距值。在主题清单中覆盖
一个令牌会重新样式化使用它的每个组件：

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

令牌通过一个继承链解析：该模式的内置默认值，然后是父主题，
然后是主题本身。当没有深色覆盖时，深色模式回退到主题的浅色令牌。
完整契约请参阅[设计令牌](design-tokens.md)。

## 第 2 层：组件皮肤

组件皮肤是通过稳定钩子重新样式化内置组件的 CSS。宿主发布
`data-component`、`data-part`、`data-role` 和 `data-state` 属性；
主题样式化这些属性，绝不样式化生成的 CSS-module 类名：

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

皮肤通过级联层以固定顺序应用，用户覆盖层最后。除无障碍偏好层外，
主题 CSS 中禁止使用 `!important`。层顺序和钩子参考请参阅
[组件皮肤](component-skin.md)。

## 第 3 层：外壳布局

外壳布局是主要区域的组合：导航栏、管理面板和聊天工作区。它是声明式的，
在 `theme.json` 中表达 —— 绝不在 JavaScript 中：

```json
{
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

有效的导航栏项目是 `chats`、`characters`、`personas`、`lorebooks`、
`backgrounds`、`ai-settings`、`plugins`、`settings` 和可选的
`menu-toggle`。`main` 组从顶部开始排列；`bottom` 固定在下边缘。你省略的
项目会按标准顺序被添加回来，因此主题无法意外隐藏"设置"并把用户锁在
恢复之外。

## 模仿其他界面

由于层级是不相交的，主题可以模仿一个完全不同的界面范式：

- 控制台风格的主题改变令牌和皮肤，让导航栏、面板和按钮看起来像游戏界面。
- 视觉小说主题重新样式化聊天视口、消息和角色头部，而聊天逻辑保持原样。
- 移动应用主题使用声明式外壳布局重新排列导航栏和面板。

这些都不需要触碰聊天逻辑、数据或插件行为 —— 这正是主题表面可以整体替换
的原因。v1 不提供的一件事是外壳区域的自由形式重排；槽位可以被样式化和
填充，但不能移动。范围内的内容请参阅[外壳契约](shell-contract.md)。
