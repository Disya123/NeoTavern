---
title: Component Skin
description: The styling stack for theme skins, from cascade layers to stable hooks.
sidebar_position: 4
---

The component skin level restyles the built-in components. It builds on a
specific styling stack and a stable hook contract.

## The Styling Stack

The built-in UI uses four technologies together:

- **CSS Modules** for component-scoped styles, with hashed class names that
  are explicitly not a public contract.
- **CSS Custom Properties** for the semantic tokens (`--st-*`).
- **Cascade Layers** to order the sources of truth.
- **Container Queries** for layout that adapts to the component's own
  container, with sizes expressed in `rem`.

Themes target the hook attributes, never the generated class names.

## Cascade Layer Order

All styles live in a fixed cascade layer order:

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Later layers win over earlier ones, so the precedence is:

1. `reset` — the base reset.
2. `tokens` — the token definitions.
3. `base` — element-level defaults.
4. `components` — the built-in component styles.
5. `plugin-base` — a layer for plugin-provided base styles.
6. `theme` — the active theme's skin.
7. `user` — the user's own overrides, which load last.

The user override stylesheet always loads last, so a broken or opinionated
theme can never prevent the user from overriding it. In `!important`
terms: the construct is forbidden in theme CSS except in the accessibility
preferences layer, which belongs to the user-facing a11y modes.

## The Hook Contract

Themes style components through four attributes, published by the host and
versioned like the rest of the SDK:

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — the component kind.
- `data-part` — the structural part inside a component.
- `data-role` — a semantic role, such as a message role.
- `data-state` — a state, such as `open`, `closed`, or `streaming`.

A theme's skin CSS then looks like this:

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

The `@neotavern/theme-sdk` package exports the `dataHook` helper for building these
attribute objects, so component authors and theme authors agree on the same
names.

## What Is Not a Contract

- **Generated CSS-module class names** — hashed, unstable, and not part of
  the SDK. A theme that targets them breaks on the next build.
- **The internal React hierarchy** — themes must not depend on component
  internals or DOM order beyond the documented hooks.
- **Numeric layout values** — coordinates, grid schemes, and breakpoints are
  not styleable through the token contract; viewport breakpoints live in the
  registry and container queries must be written in `rem`.

## Forbidden CSS

Theme stylesheets are scanned before they load. The forbidden constructs are
rejected at install and validation time:

- `@import`
- `javascript:` URLs and `expression()`.
- `-moz-binding` and `behavior:`.
- Remote or protocol-relative URLs (`url(http:`, `url(https:`, `url(//`).
- `data:text/html`.
- `!important` (except the a11y preferences layer).

This keeps theme CSS pure, local, and safe. For the tokens the skin should
reference, see [Design Tokens](design-tokens.md); for the named areas a skin
can restyle, see [Shell Contract](shell-contract.md).
