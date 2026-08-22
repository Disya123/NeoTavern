//! Debug HTML renderer for UiSceneV1 — pure Rust, no Dioxus/Blitz/Vello/wgpu.
//! Generates a static HTML file from `UiBlueprintDocumentV1 + CharacterManagerStateV1 + Viewport`
//! so the Rust scene can be viewed in a browser without touching the React oracle.

use neotavern_presentation_blueprint::v1::CaptureBundleV1;
use neotavern_presentation_blueprint::{
    materialize_character_manager_scene_v1_from_document, UiBlueprintDocumentV1, ViewportClassV1,
};

const STATE_FIXTURE: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/character-manager-v1.json");
const DOCUMENT_FIXTURE: &str = include_str!(
    "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-v1.json"
);

fn t(key: &str) -> &str {
    match key {
        "characters:tab_cards" => "Карточки",
        "characters:tab_edit" => "Редактирование",
        "characters:tab_advanced" => "Дополнительно",
        "characters:tab_gallery" => "Галерея",
        "characters:createShort" => "Создать",
        "characters:importShort" => "Импорт",
        "characters:searchPlaceholder" => "Поиск персонажей…",
        "characters:catalog" => "Каталог",
        "characters:managementTitle" => "Управление персонажами",
        "characters:managementTabs" => "Вкладки",
        "common:loadMore" => "Загрузить ещё",
        "common:loading" => "Загрузка…",
        _ => key,
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_phone_preview(
    document: &UiBlueprintDocumentV1,
    state_bundle: &CaptureBundleV1,
    viewport: ViewportClassV1,
) -> String {
    let scene =
        materialize_character_manager_scene_v1_from_document(document, state_bundle, viewport)
            .expect("scene must materialize");
    let state = &state_bundle.character_manager;

    // Derive visual knobs from state / scene
    let query = &state.query;
    let is_list = state.view == neotavern_presentation_blueprint::v1::CharacterCatalogViewV1::List;
    let viewport_label = match viewport {
        ViewportClassV1::Compact => "compact 360×800",
        ViewportClassV1::Medium => "medium 720×800",
        ViewportClassV1::Expanded => "expanded 1280×800",
    };
    let layout_name = match viewport {
        ViewportClassV1::Compact => "compact-panel (phone)",
        ViewportClassV1::Medium => "rail-overlay-panel",
        ViewportClassV1::Expanded => "rail-resizable-panel",
    };
    let _ = document; // keep doc for future recipe checks

    // Build cards HTML from scene paint data (preserves Rust ordering/selected)
    let mut cards_html = String::new();
    for card in &scene
        .paint_tree
        .iter()
        .filter(|n| n.hook.component == "character-card")
        .collect::<Vec<_>>()
    {
        if let neotavern_presentation_blueprint::v1::UiContentV1::CharacterCard { character } =
            &card.content
        {
            let selected = card.hook.states.contains(&"selected".to_string());
            let pinned = card.hook.states.contains(&"pinned".to_string());
            let badge = if selected {
                "<span class=\"badge selected\">● выбрано</span>"
            } else {
                ""
            };
            let pin = if pinned {
                "<span class=\"badge pinned\">📌</span>"
            } else {
                ""
            };
            cards_html.push_str(&format!(
                r#"<div class="phone-card {}" data-node-id="{}">
                  <div class="avatar">{}</div>
                  <div class="card-copy">
                    <div class="card-name">{} {}{}</div>
                    <div class="card-desc">{}</div>
                    <code class="card-id">{}</code>
                  </div>
                </div>"#,
                if selected { "is-selected" } else { "" },
                card.id,
                html_escape(&character.name.chars().next().unwrap_or('?').to_string()),
                html_escape(&character.name),
                badge,
                pin,
                html_escape(character.description.as_deref().unwrap_or("")),
                html_escape(&character.id.chars().take(8).collect::<String>())
            ));
        }
    }
    if cards_html.is_empty() {
        // fallback from state
        for item in &state.catalog.items {
            cards_html.push_str(&format!(
                r#"<div class="phone-card"><div class="avatar">{}</div><div class="card-copy"><div class="card-name">{}</div><div class="card-desc">{}</div></div></div>"#,
                html_escape(&item.name.chars().next().unwrap_or('?').to_string()),
                html_escape(&item.name),
                html_escape(item.description.as_deref().unwrap_or(""))
            ));
        }
    }

    let tabs_html = ["cards", "edit", "advanced", "gallery"]
        .iter()
        .map(|tab| {
            let label_key = format!("characters:tab_{tab}");
            let active = state.tab
                == match *tab {
                    "cards" => neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Cards,
                    "edit" => neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Edit,
                    "advanced" => {
                        neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Advanced
                    }
                    _ => neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Gallery,
                };
            format!(
                r#"<button class="phone-tab {}">{}</button>"#,
                if active { "is-active" } else { "" },
                t(&label_key)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let search_value = html_escape(query);

    // Phone frame size
    let (frame_w, frame_h) = match viewport {
        ViewportClassV1::Compact => ("360px", "740px"),
        ViewportClassV1::Medium => ("720px", "740px"),
        ViewportClassV1::Expanded => ("980px", "560px"),
    };

    format!(
        r#"<div class="phone-preview-wrap">
  <div class="phone-meta"><b>{viewport_label}</b> · {layout_name} · revision {rev} · {paint} paint / {hit} hit</div>
  <div class="phone-frame" style="width:{frame_w}; min-height:{frame_h}">
    <div class="phone-header">
      <div class="phone-eyebrow">NEOTAVERN</div>
      <div class="phone-title">{title}</div>
    </div>
    <div class="phone-tabs">{tabs}</div>
    <div class="phone-toolbar">
      <button class="btn primary">＋ {create}</button>
      <button class="btn">⤓ {import}</button>
      <span class="spacer"></span>
      <span class="pill">{view_label}</span>
    </div>
    <label class="phone-search"><span>🔍</span><input placeholder="{search_ph}" value="{search_value}" readonly /><span class="kbd">Rust • Viewport {vp:?}</span></label>
    <div class="phone-cards {view_class}">{cards}</div>
    <button class="btn load-more">{load_more}</button>
  </div>
</div>"#,
        viewport_label = viewport_label,
        layout_name = layout_name,
        rev = scene.revision,
        paint = scene.paint_tree.len(),
        hit = scene.hit_test_tree.len(),
        frame_w = frame_w,
        frame_h = frame_h,
        title = t("characters:managementTitle"),
        tabs = tabs_html,
        create = t("characters:createShort"),
        import = t("characters:importShort"),
        view_label = if is_list {
            "Список"
        } else {
            "Сетка"
        },
        search_ph = t("characters:searchPlaceholder"),
        search_value = search_value,
        vp = viewport,
        view_class = if is_list { "is-list" } else { "is-grid" },
        cards = cards_html,
        load_more = t("common:loadMore")
    )
}

fn render_node_dump(
    node: &neotavern_presentation_blueprint::v1::UiNodeV1,
    indent: usize,
) -> String {
    let pad = "  ".repeat(indent);
    let mut attrs = format!(
        "data-component=\"{}\" data-role=\"{}\"",
        node.hook.component, node.semantic.role
    );
    if let Some(p) = &node.hook.part {
        attrs.push_str(&format!(" data-part=\"{p}\""));
    }
    if !node.hook.states.is_empty() {
        attrs.push_str(&format!(" data-state=\"{}\"", node.hook.states.join(" ")));
    }
    let content = match &node.content {
        neotavern_presentation_blueprint::v1::UiContentV1::None => String::new(),
        neotavern_presentation_blueprint::v1::UiContentV1::TextKey { key } => {
            format!("<span class=\"rust-text-key\">{}</span>", t(key))
        }
        neotavern_presentation_blueprint::v1::UiContentV1::Input { value, label_key } => {
            format!(
                "<label class=\"rust-input\"><span>{}</span><input value=\"{}\" readonly /></label>",
                t(label_key),
                html_escape(value)
            )
        }
        neotavern_presentation_blueprint::v1::UiContentV1::CharacterCard { character } => {
            format!(
                "<div class=\"rust-card\"><strong>{}</strong><p>{}</p></div>",
                html_escape(&character.name),
                html_escape(character.description.as_deref().unwrap_or(""))
            )
        }
        neotavern_presentation_blueprint::v1::UiContentV1::ChatMessage { message } => {
            format!(
                "<div class=\"rust-message\" data-role=\"{role:?}\"><p>{}</p></div>",
                html_escape(&message.content),
                role = message.role
            )
        }
    };
    let mut out = format!("{pad}<div class=\"rust-node\" {attrs}>\n");
    if !content.is_empty() {
        out.push_str(&format!("{pad}  {content}\n"));
    }
    for child in &node.children {
        out.push_str(&render_node_dump(child, indent + 1));
    }
    out.push_str(&format!("{pad}</div>\n"));
    out
}

fn scene_section(
    document: &UiBlueprintDocumentV1,
    bundle: &CaptureBundleV1,
    viewport: ViewportClassV1,
    label: &str,
) -> String {
    let scene =
        materialize_character_manager_scene_v1_from_document(document, bundle, viewport).unwrap();
    let mut out = String::new();
    out.push_str(&format!(
        "<section class=\"rust-viewport\" data-viewport=\"{label}\">\n<h2>{label} — {viewport:?} — revision {}</h2>\n",
        scene.revision
    ));
    // Visual phone preview FIRST
    out.push_str(&render_phone_preview(document, bundle, viewport));
    // Then structural dump (collapsed)
    out.push_str("<details open><summary>Структура Rust UiScene (данные, не пиксели) — paint/hit/text/semantic</summary>\n");
    out.push_str(&render_node_dump(&scene.root, 1));
    out.push_str(&format!(
        "<details><summary>hit_test_tree ({} targets)</summary><pre>{}</pre></details>\n",
        scene.hit_test_tree.len(),
        html_escape(&format!("{:#?}", scene.hit_test_tree))
    ));
    out.push_str(&format!(
        "<details><summary>text_interaction_tree</summary><pre>{}</pre></details>\n",
        html_escape(&format!("{:#?}", scene.text_interaction_tree))
    ));
    out.push_str("</details>\n</section>\n");
    out
}

fn main() {
    let document: UiBlueprintDocumentV1 =
        serde_json::from_str(DOCUMENT_FIXTURE).expect("document fixture");
    let bundle: CaptureBundleV1 = serde_json::from_str(STATE_FIXTURE).expect("state fixture");

    let html = format!(
        r#"<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Rust UiScene — phone preview</title>
<style>
  *{{box-sizing:border-box}} body{{font-family:Inter,ui-sans-serif,system-ui;margin:0;padding:16px;background:#0b0b0f;color:#e6e6eb}}
  h1{{font-size:22px;margin:0 0 6px}} .subtitle{{opacity:.65;margin:0 0 12px;line-height:1.4}}
  a{{color:#8ab4ff}} .hint{{background:#1a1a22;border:1px solid #2a2a33;border-radius:8px;padding:10px;margin:12px 0;opacity:.9}}
  .rust-viewport{{border:1px solid #242438;border-radius:14px;padding:14px;margin:18px 0;background:#111118}}
  .phone-preview-wrap{{display:flex;flex-direction:column;align-items:center;gap:8px}}
  .phone-meta{{font-size:12px;opacity:.55}}
  .phone-frame{{background:#0f0f14;border:1px solid #2a2a3a;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06); overflow:hidden; display:flex; flex-direction:column}}
  .phone-header{{padding:14px 14px 10px; background:linear-gradient(180deg,#1b1b24,#13131a); border-bottom:1px solid #232332}}
  .phone-eyebrow{{font-size:10px; letter-spacing:.14em; opacity:.5}} .phone-title{{font-size:16px; font-weight:700; margin-top:2px}}
  .phone-tabs{{display:flex; gap:6px; padding:10px 10px 0; overflow:auto}}
  .phone-tab{{flex:0 0 auto; padding:7px 10px; border-radius:999px; border:1px solid #2a2a3a; background:#1a1a22; color:#c9c9d6; font-size:13px}}
  .phone-tab.is-active{{background:#2d2dff; border-color:#4a4aff; color:white; box-shadow:0 2px 10px rgba(45,45,255,.35)}}
  .phone-toolbar{{display:flex; gap:8px; align-items:center; padding:10px}}
  .btn{{padding:7px 11px; border-radius:10px; border:1px solid #2a2a3a; background:#1e1e28; color:#e6e6eb; font-size:13px}}
  .btn.primary{{background:#2d2dff; border-color:#4a4aff; color:white}} .spacer{{flex:1}}
  .pill{{font-size:12px; padding:4px 8px; border-radius:999px; background:#1e1e28; border:1px solid #2a2a3a; opacity:.8}}
  .phone-search{{display:flex; align-items:center; gap:8px; margin:0 10px; padding:8px 10px; background:#0d0d12; border:1px solid #242438; border-radius:10px}}
  .phone-search input{{flex:1; background:transparent; border:0; color:#e6e6eb; outline:none}} .kbd{{font-size:11px; opacity:.45}}
  .phone-cards{{padding:10px; display:grid; gap:10px}} .phone-cards.is-list{{grid-template-columns:1fr}} .phone-cards.is-grid{{grid-template-columns:1fr 1fr}}
  .phone-card{{display:flex; gap:10px; align-items:center; padding:10px; background:#1a1a22; border:1px solid #262637; border-radius:12px}}
  .phone-card.is-selected{{border-color:#4a4aff; box-shadow:0 0 0 1px rgba(74,74,255,.25) inset}} .avatar{{width:36px; height:36px; border-radius:10px; display:grid; place-items:center; background:#2a2a3a; font-weight:700}} .card-name{{font-weight:700; font-size:14px}} .card-desc{{font-size:12px; opacity:.65; margin-top:2px}} .card-id{{font-size:10px; opacity:.35}} .badge{{font-size:10px; margin-left:6px; padding:2px 6px; border-radius:999px; background:#2a2a3a}} .badge.selected{{background:#2d2dff; color:white}} .btn.load-more{{margin:10px; align-self:center}}
  .rust-node{{border:1px dashed #232334; border-radius:8px; padding:6px; margin:6px 0; background:#15151d; font-size:12px}}
  pre{{white-space:pre-wrap; word-break:break-word; font-size:11px; background:#0d0d12; padding:8px; border-radius:8px; border:1px solid #222233}}
  details{{margin-top:8px}} details summary{{cursor:pointer; opacity:.8}}
</style>
</head>
<body>
<h1>Rust UiScene — телефон превью (без компиляции телефона)</h1>
<p class="subtitle">Сгенерировано <b>чистым Rust</b> из <code>UiBlueprintDocumentV1 + CharacterManagerStateV1 + ViewportClassV1</code>. React не используется. Это тот же <code>UiSceneV1</code>, что поедет на Android/desktop/iOS/WebGPU — здесь просто отрисован HTML-адаптером для дебага.</p>
<p><a href="http://localhost:5173/">← React эталон (5173)</a> · <code>apps/web/public/rust-scene.html</code> · <code>cargo run -p neotavern-presentation-blueprint --example debug_render</code> → F5 (1.5 сек, без телефона)</p>
<div class="hint">💡 <b>Как дебажить без телефона:</b> меняешь <code>crates/presentation-blueprint/src/v1/*.rs</code> → <code>cargo test</code> (1 сек) → <code>cargo run --example debug_render | Out-File -Encoding utf8 apps/web/public/rust-scene.html</code> → F5. <code>hit_test_tree</code> и <code>selected/pinned</code> уже внизу.</div>
{}
</body>
</html>
"#,
        [
            (ViewportClassV1::Compact, "compact 360×800"),
            (ViewportClassV1::Medium, "medium 720×800"),
            (ViewportClassV1::Expanded, "expanded 1280×800"),
        ]
        .iter()
        .map(|(vp, label)| scene_section(&document, &bundle, *vp, label))
        .collect::<Vec<_>>()
        .join("\n")
    );

    println!("{html}");
}
