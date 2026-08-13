---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0006-declarative-theme-shell.md
---

# ADR-0006: Declarative CSS theme shell

## Context

The Theme SDK must allow completely changing the application's visual shell:
navigation, panels and chat layout. At the same time, the theme package must
not get access to chats, API keys, the file system or the internal React
hierarchy. An executable `shell.ts` would break this boundary and require a
separate permission/sandbox model at the plugin level.

## Decision

- The `shell` manifest field in API v1 points to a CSS file inside the
  package.
- Shell CSS works only through documented design tokens, named app slots and
  stable `data-component`, `data-part`, `data-role`, `data-state`.
- JavaScript/TypeScript and SVG assets are not served by the Theme API.
- The ZIP extractor rejects traversal, symlinks, encryption and limit
  overruns.
- The CSS validator rejects `@import`, remote URLs and script-capable legacy
  constructs; CSP additionally restricts resources to same-origin.
- Installation and activation are separated. Safe mode `?safe=1` does not
  load the manifest runtime and package CSS, so the manager and reset remain
  available.

## Alternatives

- Executable React/TypeScript shell in the main SPA: rejected due to access
  to the same origin and runtime as user data.
- iframe shell: isolatable, but cannot reliably rebuild host app slots and
  complicates accessibility/focus.
- Design tokens only: safe, but does not satisfy the requirement of a full
  visual shell replacement.
- Moving the shell to the Plugin SDK: acceptable for trusted functional
  extension, but that is already a plugin with permissions, not a theme.

## Consequences

- Theme API v1 stays declarative and local; `.sttheme` does not require
  executing third-party code.
- A full visual layout replacement is limited by the published slots/CSS
  hooks. The logic and DOM hierarchy remain with the host.
- Packages that used the proposal path `"shell": "shell.ts"` are now rejected
  as `THEME_INVALID`; no production runtime for such a proposal previously
  existed.
- Functional shell logic must be implemented as a plugin with its own
  lifecycle, cleanup and permissions.
