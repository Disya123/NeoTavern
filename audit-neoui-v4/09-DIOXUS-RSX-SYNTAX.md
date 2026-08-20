# Dioxus RSX — проверка синтаксиса

## ТЗ

> Синтаксис компонентов Android — Dioxus RSX, аналогичный React.

---

## Реализация

**Крейты:**

- `crates/presentation-dioxus-shell` — `DioxusShellHost::Flagged`, `VirtualDom`, `rsx!`
- `crates/presentation-chat/src/compositor.rs` — `produce_app_at(product_chat_app, w, h)`
- `crates/presentation-m0-d2/src/lib.rs` — `produce_vdom(VirtualDom::new(app))`

**Примеры RSX:**

```rust
// crates/presentation-dioxus-shell/src/product_shell.rs
use dioxus_core_macro::rsx;
fn rail_button(item: &RailSpec, selected: bool) -> Element {
  rsx! {
    span {
      class: "{class}",
      "data-part": "item",
      "data-item": "{item.theme_id}",
      button {
        r#type: "button",
        "data-state": "{state}",
        "aria-label": "{item.label}",
        {icon_fill(item.icon, 21, fill)}
        span { class: "Sidebar_railLabel", "{item.label}" }
      }
    }
  }
}
```

```rust
// crates/presentation-dioxus-shell/src/lib.rs — product_chat_app
rsx! {
  div {
    "data-component": "chat-workspace",
    style: "{workspace_style}",
    div { style: "{wallpaper_style}" }
    div { style: "{header_style}", "{view.title}" }
    div { style: "{viewport_style}",
          for row in view.visible_rows() { div { "{row.text}" } }
        }
    div { style: "{composer_style}", "{composer_label}" }
  }
}
```

```rust
// crates/presentation-dioxus-shell/src/product_shell.rs — character_avatar
rsx! {
  span {
    class: "{class}",
    style: "{box_style}",
    "data-part": "avatar-fallback",
    "data-avatar-asset": "{asset}",
    if letter.is_empty() { {icon("UsersThree", 20)} }
    else { span { "{letter}" } }
  }
}
```

**Аналогия React:**

| React (apps/web) | Dioxus RSX |
|---|---|
| `<div data-component="chat-workspace" style={workspaceStyle}>` | `div { "data-component": "chat-workspace", style: "{workspace_style}" }` |
| `{visibleRows.map(row => <div key={row.id}>{row.text}</div>)}` | `for row in view.visible_rows() { div { "{row.text}" } }` |
| `className={styles.shell}` | `class: "{class}"` (CSS Modules имена пакует `product.css`) |
| `aria-label={item.label}` | `"aria-label": "{item.label}"` |

Комментарий в `product_shell.rs:1-5`:
```
// App Shell + Character Manager RSX using packed React CSS modules.
// Class names, tokens, Phosphor regular paths, and English copy come from the
// React source (apps/web/src/components/* + packages/i18n/src/resources/en.ts).
// This is not a Dioxus restyle.
```

**Вердикт:** ✅ PASS — синтаксис Dioxus RSX, однотипный с React JSX, используется для **всех** first-party Android экранов (chat, shell, cards). Kotlin XML/Compose отсутствует.

---

## Что не покрыто (честно)

- `D2` producer seam использует `blitz-dom` + `paint_scene` + локальные патчи `host_node_marker`/`host_text_fragment` для glass barriers — не чистый RSX, но это bridge, не компонентный синтаксис.
- `PresentationChatComposer: EditText` — Kotlin, не RSX, но он — IME bridge, не UI компонент (см. `08-NATIVE-VIEW-BYPASS-CHECK.md`).

---

## Рекомендация

Добавить `crates/presentation-dioxus-shell/tests/rsx_coverage.rs` — assert что каждый `ProductShellView` поле (search/sort/view/tab/panel/sidebar_open/rail_expanded) имеет ветку `rsx!`, чтобы не пропустить `DEFERRED` без визуала.
