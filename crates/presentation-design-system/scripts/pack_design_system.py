#!/usr/bin/env python3
"""Pack React golden design assets for Blitz: fonts, tokens CSS, Phosphor paths."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote

from fontTools.ttLib.woff2 import decompress

ROOT = Path(__file__).resolve().parents[3]
WEB_NM = ROOT / "apps" / "web" / "node_modules"
UI = ROOT / "packages" / "ui" / "src" / "styles"
WEB_COMP = ROOT / "apps" / "web" / "src" / "components"
OUT = Path(__file__).resolve().parents[1] / "generated"
PHOSPHOR = WEB_NM / "@phosphor-icons" / "react" / "dist" / "defs"

ICONS = [
    "Plus",
    "UploadSimple",
    "MagnifyingGlass",
    "List",
    "SquaresFour",
    "Eye",
    "X",
    "UsersThree",
    "ChatsCircle",
    "Smiley",
    "BookOpenText",
    "ImageSquare",
    "Globe",
    "Cube",
    "SlidersHorizontal",
    "SidebarSimple",
    "CaretDown",
    "Pencil",
    "PushPin",
    "Check",
    "ArrowLeft",
    "Star",
    "Trash",
    "DownloadSimple",
    "Image",
    "Copy",
]

MODULES = (
    "AppShell.module.css",
    "Sidebar.module.css",
    "SidebarPanelHeader.module.css",
    "FloatingTabPanel.module.css",
    "CharacterManagementPanel.module.css",
)

BLITZ_NEUTRALIZE = """
/* Beat Blitz DEFAULT_CSS (body margin, grey buttons, white inputs, hidden options). */
html, body, #main, #root {
  margin: 0;
  padding: 0;
  height: 100%;
  background: #151311;
  color: #f3eee8;
  font-family: 'Outfit Variable', sans-serif;
  font-size: 16px;
  line-height: 1.45;
}
style, script, template {
  display: none;
}
button,
input,
textarea,
select {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  border-radius: 0;
  box-shadow: none;
  appearance: none;
  -webkit-appearance: none;
}
input:focus,
textarea:focus,
button:focus,
select:focus {
  outline: none;
}
option {
  display: none;
}
option:checked,
option[selected] {
  display: block;
}
a {
  color: inherit;
  text-decoration: none;
}
h1, h2, h3, h4, h5, h6, p, ul, ol, li, figure, blockquote {
  margin: 0;
  padding: 0;
  font-size: inherit;
  font-weight: inherit;
}
.nt-icon {
  display: block;
  flex: none;
  width: 21px;
  height: 21px;
  background-color: transparent;
  -webkit-mask-image: none;
  mask-image: none;
}

/* Blitz does not yet implement position:fixed / 100dvh / inset-block / CSS animations. */
.AppShell_shell {
  position: relative;
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.Sidebar_sidebar {
  position: relative;
  inset: auto;
  top: auto;
  left: auto;
  display: flex;
  flex-direction: row;
  flex: 0 0 auto;
  height: 100%;
  pointer-events: auto;
  z-index: 40;
}
.Sidebar_rail,
.Sidebar_rail[data-state='collapsed'],
.Sidebar_rail[data-state='expanded'] {
  position: relative;
  flex: 0 0 60px;
  width: 60px;
  height: 100%;
  background: #151311;
  border-right: 1px solid #39342f;
  pointer-events: auto;
  padding-top: var(--nt-inset-top);
  padding-bottom: var(--nt-inset-bottom);
  padding-left: 4px;
  padding-right: 4px;
}
.Sidebar_rail[data-state='expanded'] [data-part='item']:not([data-item='menu-toggle']) {
  animation: none;
  opacity: 1;
  transform: none;
}
.Sidebar_panelOpen,
.Sidebar_panelOpen[data-state='closing'] {
  position: relative;
  inset: auto;
  top: auto;
  left: auto;
  right: auto;
  bottom: auto;
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  max-width: 380px;
  height: 100%;
  animation: none;
  transform: none;
  opacity: 1;
  background: #24211e;
  color: #f3eee8;
  border-right: 1px solid #39342f;
  padding-bottom: 0;
}
.AppShell_main,
.AppShell_mainShifted {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 0;
  margin-inline-start: 0;
  height: 100%;
}
.AppShell_shell[data-sidebar='open'] .AppShell_main,
.AppShell_shell[data-sidebar='open'] .AppShell_mainShifted {
  display: none;
  width: 0;
  flex: none;
  overflow: hidden;
}
.AppShell_shell[data-sidebar='open'] .Sidebar_sidebar {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}
.AppShell_shell[data-sidebar='open'] .Sidebar_panelOpen,
.AppShell_shell[data-sidebar='open'] .Sidebar_panelOpen[data-state='closing'] {
  max-width: none;
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}
.AppShell_skipLink,
.Sidebar_railLabel,
.CharacterManagementPanel_srOnly {
  display: none;
  width: 0;
  height: 0;
  overflow: hidden;
  position: absolute;
}
.SidebarPanelHeader_identity {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}
.SidebarPanelHeader_avatar {
  display: flex;
  flex: none;
  width: 44px;
  height: 44px;
  max-width: 44px;
  max-height: 44px;
  align-items: center;
  justify-content: center;
  align-self: center;
}
.SidebarPanelHeader_copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}
.SidebarPanelHeader_title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.SidebarPanelHeader_headerDivider {
  display: block;
  flex: none;
  align-self: stretch;
  width: 100%;
  height: 1px;
  min-height: 1px;
  background: #39342f;
  pointer-events: none;
}
.SidebarPanelHeader_close,
.SidebarPanelHeader_actions [data-component='button'] {
  min-width: 40px;
  min-height: 40px;
  width: 40px;
  height: 40px;
  padding: 0;
  flex: none;
  background: transparent;
  border: 1px solid transparent;
}
.CharacterManagementPanel_headerAvatar,
.CharacterManagementPanel_cardAvatar,
.CharacterManagementPanel_editorAvatar {
  display: flex;
  flex: none;
  overflow: hidden;
  align-items: center;
  justify-content: center;
  border: 1px solid #625a53;
  border-radius: 10px;
  color: #f3eee8;
  background: #302c28;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1;
  text-align: center;
  object-fit: cover;
}
.CharacterManagementPanel_headerAvatar {
  width: 44px;
  height: 44px;
  max-width: 44px;
  max-height: 44px;
  align-self: center;
}
.CharacterManagementPanel_cardAvatar {
  width: 52px;
  height: 52px;
  max-width: 52px;
  max-height: 52px;
  aspect-ratio: auto;
  grid-column: auto;
  align-self: start;
}
.CharacterManagementPanel_editorAvatar {
  width: 64px;
  height: 64px;
  max-width: 64px;
  max-height: 64px;
  align-self: start;
}

.nt-icon,
[class*="nt-icon-"] {
  background-color: transparent;
  -webkit-mask-image: none;
  mask-image: none;
}
.nt-icon svg {
  display: block;
  width: 100%;
  height: 100%;
}

.CharacterManagementPanel_sortControl button {
  display: flex;
  width: 6.5rem;
  height: 44px;
  padding: 0 8px;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #39342f;
  border-radius: 10px;
  color: #f3eee8;
  background: #302c28;
  font-size: 0.8125rem;
}
.CharacterManagementPanel_searchPlaceholder {
  color: #998f87;
  pointer-events: none;
}
.CharacterManagementPanel_cardCopy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.CharacterManagementPanel_cardCopy strong {
  overflow: hidden;
  color: #f3eee8;
  font-size: 0.875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.CharacterManagementPanel_cardCopy > span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  max-height: 2.9em;
  overflow: hidden;
  color: #c5bbb2;
  font-size: 0.75rem;
  line-height: 1.45;
  text-overflow: ellipsis;
}
.CharacterManagementPanel_cardCopy > span[data-part='card-description'] {
  display: block;
  max-height: 2.9em;
  overflow: hidden;
  color: #c5bbb2;
  font-size: 0.75rem;
  line-height: 1.45;
}
.CharacterManagementPanel_pinnedIcon {
  display: flex;
  flex: none;
  width: 18px;
  height: 18px;
  align-self: start;
  color: #e38a62;
}

.Sidebar_railMain {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.Sidebar_railItem {
  display: flex;
  width: 100%;
  justify-content: center;
}
.Sidebar_railSeparator {
  display: block;
  flex: none;
  align-self: stretch;
  height: 1px;
  margin: 4px 0 8px;
  background: #39342f;
}
.Sidebar_railButton,
.Sidebar_railButtonActive {
  display: flex;
  width: 40px;
  height: 40px;
  padding: 0;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: transparent;
  color: #998f87;
}
.Sidebar_railButton .nt-icon,
.Sidebar_railButtonActive .nt-icon {
  margin: auto;
}
.Sidebar_railButtonActive {
  background: #492a20;
  color: #ffc4a8;
}
.Sidebar_railLabel {
  display: none;
}
.SidebarPanelHeader_header {
  display: flex;
  min-height: calc(52px + var(--nt-inset-top));
  padding-top: var(--nt-inset-top);
  padding-right: 16px;
  padding-bottom: 8px;
  padding-left: 16px;
  align-items: center;
  background: #24211e;
  color: #f3eee8;
}
.SidebarPanelHeader_title {
  overflow: hidden;
  font-size: 1.25rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.FloatingTabPanel_root,
.CharacterManagementPanel_tabs {
  display: flex;
  min-height: 0;
  height: 100%;
  flex: 1;
  flex-direction: column;
  background: transparent;
}
[data-component='tabs-scroll-content'] {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
[data-component='tabs-list'][data-variant='segment'] {
  display: flex;
  flex-direction: row;
  flex: none;
  order: 0;
  position: relative;
  top: auto;
  bottom: auto;
  left: auto;
  right: auto;
  inset: auto;
  z-index: 2;
  width: auto;
  margin: 8px 16px max(32px, var(--nt-inset-bottom));
  padding: 4px;
  align-items: center;
  border: 1px solid #39342f;
  border-radius: 10px;
  background: #24211e;
}
[data-component='tabs-indicator'] {
  display: none;
}
[data-component='tabs-trigger'] {
  display: flex;
  min-width: 0;
  min-height: 44px;
  flex: 1;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: #c5bbb2;
  background: transparent;
  font-size: 1rem;
}
[data-component='tabs-trigger'][data-state='active'] {
  color: #ffc4a8;
  background: #492a20;
  font-weight: 600;
}
[data-component='tabs-content'],
.CharacterManagementPanel_tabPanel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  order: 1;
  overflow: hidden;
  align-items: stretch;
  justify-content: flex-start;
}
[data-part='floating-tab-content'] {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  height: auto;
}
.CharacterManagementPanel_cardsTab {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  height: auto;
  padding: 8px 16px 16px;
  gap: 12px;
}
.CharacterManagementPanel_cardToolbar [data-part='inner'] {
  display: flex;
  width: 100%;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
}
.CharacterManagementPanel_listMeta {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #998f87;
  font-size: 0.75rem;
}
.CharacterManagementPanel_listMeta > span[data-part='loaded-count'] {
  margin-left: auto;
}
.CharacterManagementPanel_viewToggle {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 1px solid #39342f;
  border-radius: 10px;
  background: #24211e;
}
.CharacterManagementPanel_viewToggle .CharacterManagementPanel_iconButton[data-state='active'] {
  border-color: #39342f;
  color: #f3eee8;
  background: #302c28;
}
.CharacterManagementPanel_characterList {
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 4px;
  height: auto;
  max-height: none;
  align-self: stretch;
  align-items: flex-start;
  justify-content: flex-start;
  align-content: flex-start;
  grid-auto-rows: min-content;
}
.CharacterManagementPanel_characterCard {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 0;
  height: auto;
  max-height: 140px;
  padding: 8px;
  flex: none;
  align-self: flex-start;
  align-items: center;
  align-content: start;
  grid-auto-rows: min-content;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  overflow: hidden;
  border: 1px solid #39342f;
  border-radius: 16px;
  color: #f3eee8;
  background: #24211e;
  text-align: left;
}
.CharacterManagementPanel_characterCard[data-state='selected'] {
  border-color: #e38a62;
  background: #492a20;
}
.CharacterManagementPanel_emptyState {
  display: flex;
  padding: 24px 16px;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #c5bbb2;
  text-align: center;
}
[data-component='button'] {
  display: flex;
  min-width: 44px;
  min-height: 44px;
  padding: 4px 16px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 10px;
  color: #f3eee8;
  background: #302c28;
  font-size: 1rem;
  font-weight: 500;
}
[data-component='button'][data-variant='primary'] {
  color: #2a130b;
  background: #e38a62;
}
[data-component='button'][data-variant='ghost'] {
  background: transparent;
}
.CharacterManagementPanel_searchControl {
  display: flex;
  min-height: 44px;
  padding: 0 8px;
  align-items: center;
  gap: 4px;
  border: 1px solid #39342f;
  border-radius: 10px;
  background: #302c28;
}
"""

DARK_ROOT = """
:root {
  color-scheme: dark;
  --st-color-text-primary: #f3eee8;
  --st-color-text-secondary: #c5bbb2;
  --st-color-text-muted: #998f87;
  --st-color-text-inverse: #211b17;
  --st-color-text-link: #f0a07d;
  --st-color-surface-primary: #1b1917;
  --st-color-surface-secondary: #24211e;
  --st-color-surface-tertiary: #302c28;
  --st-color-surface-overlay: #292522;
  --st-color-surface-canvas: #151311;
  --st-color-surface-elevated: #292522;
  --st-color-accent: #e38a62;
  --st-color-accent-hover: #f09a73;
  --st-color-accent-text: #2a130b;
  --st-color-accent-soft: #492a20;
  --st-color-accent-soft-text: #ffc4a8;
  --st-color-border: #39342f;
  --st-color-border-subtle: #2b2723;
  --st-color-border-strong: #625a53;
  --st-color-success: #63c98d;
  --st-color-warning: #e0a35c;
  --st-color-warning-surface: #3f2f1a;
  --st-color-danger: #f0837d;
  --st-color-info: #7fb3c9;
  --st-color-message-quote: #e8943a;
  --st-color-message-emphasis: #919191;
  --st-color-message-code: #c5bbb2;
  --st-color-message-code-bg: #302c28;
  --st-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.35);
  --st-shadow-soft: 0 10px 28px rgba(0, 0, 0, 0.26);
  --st-shadow-focus: 0 0 0 3px rgba(227, 138, 98, 0.2);
  --st-shadow-overlay: 0 24px 64px rgba(0, 0, 0, 0.58);
  --st-chat-wallpaper-overlay: rgba(18, 16, 14, var(--st-custom-wallpaper-overlay-alpha, 0.3));
  --st-custom-wallpaper-overlay-alpha: 0.3;
  --st-custom-ui-opacity: 100%;
  --st-radius-control: 10px;
  --st-radius-card: 16px;
  --st-shell-rail-width: 60px;
  --st-shell-panel-width: 380px;
  --st-space-2xl: 32px;
  --st-control-height: 44px;
  --st-control-height-large: 52px;
}
"""


def strip_layer(css: str) -> str:
    css = re.sub(r"@layer\s+[^{;]+;", "", css)
    while True:
        match = re.search(r"@layer\s+\w+\s*\{", css)
        if not match:
            break
        start = match.end()
        depth = 1
        i = start
        while i < len(css) and depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        inner = css[start : i - 1]
        css = css[: match.start()] + inner + css[i:]
    return css


def unglobal(css: str) -> str:
    return re.sub(r":global\(([^)]+)\)", r"\1", css)


def prefix_classes(css: str, stem: str) -> str:
    names = set(re.findall(r"(?:^|[^A-Za-z0-9_-])\.([A-Za-z_][A-Za-z0-9_-]*)", css))
    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in names:
            return f".{stem}_{name}"
        return match.group(0)
    return re.sub(r"\.([A-Za-z_][A-Za-z0-9_-]*)", repl, css)


def flatten_composes(css: str) -> str:
    classes: dict[str, str] = {}
    for match in re.finditer(r"\.([A-Za-z0-9_-]+)\s*\{([^{}]*)\}", css):
        classes[match.group(1)] = match.group(2)
    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        body = match.group(2)
        composed = re.search(r"composes:\s*([A-Za-z0-9_-]+)\s*;", body)
        if not composed:
            return match.group(0)
        source = classes.get(composed.group(1), "")
        body = re.sub(r"composes:\s*[A-Za-z0-9_-]+\s*;", source, body, count=1)
        return f".{name} {{{body}}}"
    return re.sub(r"\.([A-Za-z0-9_-]+)\s*\{([^{}]*)\}", repl, css)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


TOKENS = {
    "--st-color-text-primary": "#f3eee8",
    "--st-color-text-secondary": "#c5bbb2",
    "--st-color-text-muted": "#998f87",
    "--st-color-text-inverse": "#211b17",
    "--st-color-surface-primary": "#1b1917",
    "--st-color-surface-secondary": "#24211e",
    "--st-color-surface-tertiary": "#302c28",
    "--st-color-surface-overlay": "#292522",
    "--st-color-surface-canvas": "#151311",
    "--st-color-accent": "#e38a62",
    "--st-color-accent-hover": "#f09a73",
    "--st-color-accent-text": "#2a130b",
    "--st-color-accent-soft": "#492a20",
    "--st-color-border": "#39342f",
    "--st-color-border-strong": "#625a53",
    "--st-color-warning": "#e0a35c",
    "--st-radius-control": "10px",
    "--st-radius-card": "16px",
    "--st-radius-overlay": "20px",
    "--st-radius-panel": "28px",
    "--st-radius-round": "999px",
    "--st-radius-inset": "4px",
    "--st-space-2xs": "2px",
    "--st-space-xs": "4px",
    "--st-space-sm": "8px",
    "--st-space-md": "12px",
    "--st-space-lg": "16px",
    "--st-space-xl": "24px",
    "--st-space-2xl": "32px",
    "--st-space-3xl": "48px",
    "--st-control-height": "44px",
    "--st-control-height-large": "52px",
    "--st-control-height-sm": "40px",
    "--st-control-height-xs": "36px",
    "--st-control-hit-min": "44px",
    "--st-shell-rail-width": "60px",
    "--st-shell-panel-width": "380px",
    "--st-shell-panel-min-width": "260px",
    "--st-shell-panel-max-width": "720px",
    "--st-font-ui": "'Outfit Variable', sans-serif",
    "--st-font-mono": "'JetBrains Mono Variable', monospace",
    "--st-font-size-2xs": "0.6875rem",
    "--st-font-size-xs": "0.75rem",
    "--st-font-size-sm": "0.8125rem",
    "--st-font-size-md": "1rem",
    "--st-font-size-lg": "1.25rem",
    "--st-font-weight-medium": "500",
    "--st-font-weight-semibold": "600",
    "--st-line-height-body": "1.45",
    "--st-border-width": "1px",
    "--st-layer-panel": "100",
    "--st-layer-modal": "1000",
    "--st-custom-glass-blur": "16px",
    "--st-effect-glass-blur": "16px",
    "--st-custom-ui-opacity": "100%",
    "--st-motion-duration-fast": "180ms",
    "--st-motion-duration-normal": "320ms",
    "--st-motion-easing-standard": "cubic-bezier(0.22, 1, 0.36, 1)",
}


# React glass mixes transparent over the canvas. Blitz has no backdrop, so
# compositing onto --st-color-surface-canvas keeps the same opaque result.
CANVAS_RGB = (21, 19, 17)


def mix_srgb(color: str, percent: float, into: str = "transparent") -> str:
    r, g, b = hex_to_rgb(color)
    p = percent / 100.0
    if into == "transparent":
        ir, ig, ib = CANVAS_RGB
        return (
            f"rgb({round(r * p + ir * (1 - p))}, "
            f"{round(g * p + ig * (1 - p))}, "
            f"{round(b * p + ib * (1 - p))})"
        )
    ir, ig, ib = hex_to_rgb(into)
    return (
        f"rgb({round(r * p + ir * (1 - p))}, "
        f"{round(g * p + ig * (1 - p))}, "
        f"{round(b * p + ib * (1 - p))})"
    )


COLOR_MIX = re.compile(
    r"color-mix\(\s*in srgb,\s*var\((--st-[a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*(transparent|var\((--st-[a-z0-9-]+)\))\s*\)"
)


def resolve_color_mix(css: str) -> str:
    def repl(match: re.Match[str]) -> str:
        token = match.group(1)
        percent = float(match.group(2))
        into = match.group(3)
        src = TOKENS.get(token)
        if not src:
            return match.group(0)
        if into == "transparent":
            return mix_srgb(src, percent)
        other = TOKENS.get(match.group(4) or "")
        if not other:
            return match.group(0)
        return mix_srgb(src, percent, other)

    return COLOR_MIX.sub(repl, css)


def collect_root_tokens(css: str) -> dict[str, str]:
    tokens = dict(TOKENS)
    for block in re.finditer(r":root(?:\[[^\]]+\])?\s*\{([^}]*)\}", css):
        prelude = css[max(0, block.start() - 96) : block.start()]
        body = block.group(1)
        if "prefers-reduced-motion" in prelude:
            continue
        if "color-scheme: light" in body and "data-theme-mode" not in css[block.start() : block.start() + 48]:
            for prop in re.finditer(r"(--st-(?!color-|shadow-|chat-wallpaper)[A-Za-z0-9-]+)\s*:\s*([^;]+);", body):
                tokens[prop.group(1)] = prop.group(2).strip()
            continue
        for prop in re.finditer(r"(--st-[A-Za-z0-9-]+)\s*:\s*([^;]+);", body):
            tokens[prop.group(1)] = prop.group(2).strip()
    alias = re.compile(r"var\(\s*(--st-[A-Za-z0-9-]+)\s*(?:,\s*([^)]+))?\)")
    for _ in range(12):
        changed = False
        for name, value in list(tokens.items()):
            nxt = alias.sub(
                lambda match: tokens.get(
                    match.group(1),
                    (match.group(2) or "").strip() or match.group(0),
                ),
                value,
            )
            if nxt != value:
                tokens[name] = nxt
                changed = True
        if not changed:
            break
    return tokens


def flatten_st_vars(css: str, tokens: dict[str, str]) -> str:
    pattern = re.compile(r"var\(\s*(--st-[A-Za-z0-9-]+)\s*(?:,\s*([^)]+))?\)")

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in tokens:
            return tokens[name]
        fallback = (match.group(2) or "").strip()
        return fallback if fallback else match.group(0)

    out = css
    for _ in range(12):
        nxt = pattern.sub(repl, out)
        if nxt == out:
            break
        out = nxt
    out = out.replace(
        "--nt-inset-top: max(env(safe-area-inset-top, 0px), var(--nt-safe-area-top));",
        "--nt-inset-top: var(--nt-safe-area-top);",
    )
    out = out.replace(
        "--nt-inset-right: max(env(safe-area-inset-right, 0px), var(--nt-safe-area-right));",
        "--nt-inset-right: var(--nt-safe-area-right);",
    )
    out = out.replace(
        "--nt-inset-bottom: max(env(safe-area-inset-bottom, 0px), var(--nt-safe-area-bottom));",
        "--nt-inset-bottom: var(--nt-safe-area-bottom);",
    )
    out = out.replace(
        "--nt-inset-left: max(env(safe-area-inset-left, 0px), var(--nt-safe-area-left));",
        "--nt-inset-left: var(--nt-safe-area-left);",
    )
    return out


def parse_color_token(value: str) -> tuple[int, int, int] | None:
    value = value.strip()
    if value.startswith("#"):
        hex_value = value.lstrip("#")
        if len(hex_value) == 3:
            hex_value = "".join(ch * 2 for ch in hex_value)
        if len(hex_value) >= 6:
            return hex_to_rgb("#" + hex_value[:6])
        return None
    match = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", value)
    if match:
        return int(match.group(1)), int(match.group(2)), int(match.group(3))
    return None


COLOR_MIX_ANY = re.compile(
    r"color-mix\(\s*in srgb,\s*([^,]+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(transparent|[^)]+?)\s*\)",
    re.S,
)


def resolve_color_mix_literals(css: str) -> str:
    def repl(match: re.Match[str]) -> str:
        src = parse_color_token(match.group(1))
        percent = float(match.group(2))
        into = match.group(3).strip()
        if src is None:
            return match.group(0)
        p = percent / 100.0
        r, g, b = src
        if into == "transparent":
            ir, ig, ib = CANVAS_RGB
            return (
                f"rgb({round(r * p + ir * (1 - p))}, "
                f"{round(g * p + ig * (1 - p))}, "
                f"{round(b * p + ib * (1 - p))})"
            )
        other = parse_color_token(into)
        if other is None:
            return match.group(0)
        ir, ig, ib = other
        return (
            f"rgb({round(r * p + ir * (1 - p))}, "
            f"{round(g * p + ig * (1 - p))}, "
            f"{round(b * p + ib * (1 - p))})"
        )

    return COLOR_MIX_ANY.sub(repl, css)


def flatten_custom_vars(css: str) -> str:
    values: dict[str, set[str]] = {}
    for match in re.finditer(r"(--[A-Za-z0-9-]+)\s*:\s*([^;]+);", css):
        name = match.group(1)
        if name.startswith("--nt-"):
            continue
        values.setdefault(name, set()).add(match.group(2).strip())
    # Last-wins would turn :root[data-navigation-rail-state='collapsed']
    # `--shell-rail-current-width: 0` into every panel offset.
    tokens = {name: next(iter(vals)) for name, vals in values.items() if len(vals) == 1}
    tokens["--shell-rail-current-width"] = "60px"
    pattern = re.compile(r"var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^)]+))?\)")

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        if name.startswith("--nt-"):
            return match.group(0)
        if name in tokens:
            return tokens[name]
        fallback = (match.group(2) or "").strip()
        return fallback if fallback else match.group(0)

    out = css
    for _ in range(8):
        nxt = pattern.sub(repl, out)
        if nxt == out:
            break
        out = nxt
    return out


LOGICAL_PROPS = [
    ("min-block-size", "min-height"),
    ("max-block-size", "max-height"),
    ("min-inline-size", "min-width"),
    ("max-inline-size", "max-width"),
    ("inset-block-start", "top"),
    ("inset-block-end", "bottom"),
    ("inset-inline-start", "left"),
    ("inset-inline-end", "right"),
    ("padding-block-start", "padding-top"),
    ("padding-block-end", "padding-bottom"),
    ("padding-inline-start", "padding-left"),
    ("padding-inline-end", "padding-right"),
    ("margin-block-start", "margin-top"),
    ("margin-block-end", "margin-bottom"),
    ("margin-inline-start", "margin-left"),
    ("margin-inline-end", "margin-right"),
    ("border-block-start", "border-top"),
    ("border-block-end", "border-bottom"),
    ("border-inline-start", "border-left"),
    ("border-inline-end", "border-right"),
    ("overflow-block", "overflow-y"),
    ("overflow-inline", "overflow-x"),
    ("block-size", "height"),
    ("inline-size", "width"),
]


def expand_axis_shorthand(css: str, name: str, start: str, end: str) -> str:
    pattern = re.compile(rf"{re.escape(name)}\s*:\s*([^;]+);")

    def repl(match: re.Match[str]) -> str:
        parts = [part.strip() for part in match.group(1).split() if part.strip()]
        if not parts:
            return match.group(0)
        first = parts[0]
        second = parts[1] if len(parts) > 1 else first
        return f"{start}: {first}; {end}: {second};"

    return pattern.sub(repl, css)


def rewrite_logical_props(css: str) -> str:
    css = expand_axis_shorthand(css, "padding-block", "padding-top", "padding-bottom")
    css = expand_axis_shorthand(css, "padding-inline", "padding-left", "padding-right")
    css = expand_axis_shorthand(css, "margin-block", "margin-top", "margin-bottom")
    css = expand_axis_shorthand(css, "margin-inline", "margin-left", "margin-right")
    css = expand_axis_shorthand(css, "inset-block", "top", "bottom")
    css = expand_axis_shorthand(css, "inset-inline", "left", "right")
    for src, dst in LOGICAL_PROPS:
        css = re.sub(rf"(?<![-A-Za-z]){re.escape(src)}\s*:", f"{dst}:", css)
    css = css.replace("place-items: center;", "align-items: center; justify-content: center;")
    css = re.sub(r"backdrop-filter\s*:[^;]+;", "", css)
    css = re.sub(r"-webkit-backdrop-filter\s*:[^;]+;", "", css)
    css = css.replace("overflow: clip;", "overflow: hidden;")
    css = css.replace("overflow: clip ", "overflow: hidden ")
    # Blitz does not implement fixed/sticky containing blocks; keep App Shell
    # in flex flow so header/tabs use the panel, not the viewport.
    css = re.sub(r"position:\s*fixed\b", "position: relative", css)
    css = re.sub(r"position:\s*sticky\b", "position: relative", css)
    css = css.replace("100dvh", "100%")
    css = css.replace("100vw", "100%")
    return css


def take_block(css: str, brace_idx: int) -> tuple[str, int]:
    depth = 0
    i = brace_idx
    while i < len(css):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return css[brace_idx + 1 : i], i + 1
        i += 1
    return css[brace_idx + 1 :], len(css)


def apply_compact_media(css: str) -> str:
    """Android product path is the 600px overlay breakpoint. Unwrap it; drop desktop-only."""
    out: list[str] = []
    pos = 0
    while True:
        idx = css.find("@media", pos)
        if idx < 0:
            out.append(css[pos:])
            break
        brace = css.find("{", idx)
        if brace < 0:
            out.append(css[pos:])
            break
        out.append(css[pos:idx])
        query = re.sub(r"\s+", " ", css[idx:brace]).lower()
        body, end = take_block(css, brace)
        if "max-width: 600px" in query:
            out.append(body)
        elif "min-width: 601px" in query:
            pass
        else:
            out.append(css[idx:end])
        pos = end
    return "".join(out)


def strip_light_root(css: str) -> str:
    out: list[str] = []
    pos = 0
    while True:
        idx = css.find(":root", pos)
        if idx < 0:
            out.append(css[pos:])
            break
        after = css[idx + 5 :].lstrip()
        if after.startswith("["):
            out.append(css[pos : idx + 5])
            pos = idx + 5
            continue
        brace = css.find("{", idx)
        if brace < 0:
            out.append(css[pos:])
            break
        body, end = take_block(css, brace)
        if "color-scheme: light" in body:
            out.append(css[pos:idx])
            pos = end
            continue
        out.append(css[pos:end])
        pos = end
    return "".join(out)


def read_css(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_regular_path(name: str) -> str:
    text = (PHOSPHOR / f"{name}.es.js").read_text(encoding="utf-8")
    block = text.split('"regular"')[1].split('"thin"')[0]
    found = re.findall(r'd:\s*"([^"]+)"', block)
    if not found:
        raise SystemExit(f"no regular path for {name}")
    return found[-1]


def pack_fonts() -> None:
    fonts = OUT / "fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    pairs = [
        (
            WEB_NM / "@fontsource-variable" / "outfit" / "files" / "outfit-latin-wght-normal.woff2",
            fonts / "outfit-variable-latin.ttf",
        ),
        (
            WEB_NM
            / "@fontsource-variable"
            / "jetbrains-mono"
            / "files"
            / "jetbrains-mono-latin-wght-normal.woff2",
            fonts / "jetbrains-mono-variable-latin.ttf",
        ),
    ]
    for src, dst in pairs:
        if not src.is_file():
            raise SystemExit(f"missing font {src}")
        with src.open("rb") as incoming, dst.open("wb") as outgoing:
            decompress(incoming, outgoing)
        print(f"font {dst.name} {dst.stat().st_size}")


def pack_icons() -> None:
    icons = OUT / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    rust = ["// Generated Phosphor regular paths (viewBox 0 0 256 256)."]
    rust.append("pub struct PhosphorIcon { pub name: &'static str, pub path: &'static str }")
    rust.append("pub const PHOSPHOR_REGULAR: &[PhosphorIcon] = &[")
    masks: list[str] = []
    for name in ICONS:
        path = extract_regular_path(name)
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" '
            f'fill="black"><path d="{path}"/></svg>'
        )
        (icons / f"{name}.svg").write_text(
            svg.replace('fill="black"', 'fill="currentColor"'),
            encoding="utf-8",
        )
        uri = "data:image/svg+xml," + quote(svg, safe="")
        masks.append(
            f".nt-icon-{name} {{ -webkit-mask-image: url(\"{uri}\"); "
            f"mask-image: url(\"{uri}\"); }}"
        )
        rust.append(f'    PhosphorIcon {{ name: "{name}", path: "{path}" }},')
        print(f"icon {name}")
    rust.append("];")
    rust.append(
        """
pub fn phosphor_path(name: &str) -> Option<&'static str> {
    PHOSPHOR_REGULAR.iter().find(|icon| icon.name == name).map(|icon| icon.path)
}
"""
    )
    (OUT / "phosphor.rs").write_text("\n".join(rust), encoding="utf-8")
    (OUT / "icon-masks.css").write_text("\n".join(masks) + "\n", encoding="utf-8")


def pack_css() -> None:
    parts = [
        "/* Packed from packages/ui + Character Manager/App Shell CSS modules. */",
        BLITZ_NEUTRALIZE,
        DARK_ROOT,
        strip_layer(read_css(UI / "tokens.css")),
        DARK_ROOT,
        strip_layer(read_css(UI / "reset.css")),
        strip_layer(read_css(UI / "base.css")),
        strip_layer(read_css(UI / "components.css")),
        strip_layer(read_css(WEB_COMP.parent / "styles" / "preferences.css")),
    ]
    for name in MODULES:
        stem = name.split(".", 1)[0]
        css = prefix_classes(
            flatten_composes(unglobal(strip_layer(read_css(WEB_COMP / name)))),
            stem,
        )
        parts.append(f"/* {name} -> {stem}_* */")
        parts.append(css)
    sheet = resolve_color_mix("\n\n".join(parts))
    tokens = collect_root_tokens(sheet)
    sheet = flatten_st_vars(sheet, tokens)
    sheet = resolve_color_mix_literals(sheet)
    sheet = flatten_custom_vars(sheet)
    sheet = strip_light_root(sheet)
    sheet = apply_compact_media(sheet)
    sheet = rewrite_logical_props(sheet)
    # Last wins over module `position:fixed` / CSS masks. Token vars are already
    # flattened, so the button reset cannot punch out `border-radius: 10px`.
    sheet = rewrite_logical_props(f"{sheet}\n{BLITZ_NEUTRALIZE}")
    out = OUT / "product.css"
    out.write_text(sheet, encoding="utf-8")
    print(f"css {out.stat().st_size}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pack_fonts()
    pack_icons()
    pack_css()


if __name__ == "__main__":
    main()
