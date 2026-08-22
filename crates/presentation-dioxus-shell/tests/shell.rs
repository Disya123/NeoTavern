use dioxus_core::VirtualDom;
use neotavern_presentation_dioxus_shell::{
    assert_registered_command, chat_route_line, chrome_metrics, dioxus_shell_from_flag,
    expected_projection, flagged_chat_route, load_canonical_fixture, mixed_height_catalog,
    mount_product_chat, mount_virtual_dom, product_chat_from_fixture, project_canonical,
    DioxusShellHost, ShellError, PRODUCT_PATH_ITEMS,
};
use std::fs;
use std::path::PathBuf;

#[test]
fn default_host_is_disabled() {
    assert_eq!(dioxus_shell_from_flag(None), DioxusShellHost::Disabled);
    assert_eq!(
        dioxus_shell_from_flag(Some("1")),
        DioxusShellHost::Flagged { feature_flag: true }
    );
}

#[test]
fn rejects_unregistered_commands() {
    let err = assert_registered_command("presentation.bypassSqlite").unwrap_err();
    assert!(format!("{err}").contains("Product Wire"));
}

#[test]
fn rust_projection_matches_shared_golden_fixture() {
    let fixture = load_canonical_fixture().expect("fixture");
    let projection = project_canonical(&fixture).expect("projection");
    assert_eq!(projection, expected_projection());
}

#[test]
fn builds_a_dioxus_virtualdom_from_the_wire_view_model() {
    let fixture = load_canonical_fixture().expect("fixture");
    let projection = project_canonical(&fixture).expect("projection");
    let edits = mount_virtual_dom(&projection.title, projection.message_ids.len());
    assert!(edits > 0, "VirtualDom rebuild must emit mutations");
}

#[test]
fn cargo_toml_does_not_depend_on_kernel_storage_or_network() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = fs::read_to_string(manifest).expect("Cargo.toml");
    for forbidden in [
        "runtime-kernel",
        "neotavern-runtime-kernel",
        "neotavern-storage",
        "reqwest",
        "hyper",
        "tokio",
        "rusqlite",
        "android-jni",
    ] {
        assert!(
            !text.contains(forbidden),
            "Dioxus Product Wire shell must not depend on {forbidden}"
        );
    }
}

#[test]
fn product_path_catalog_is_ten_thousand_wire_messages() {
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    let projection = project_canonical(&fixture).expect("wire");
    assert_eq!(projection.message_ids.len(), PRODUCT_PATH_ITEMS as usize);
    assert_eq!(
        dioxus_shell_from_flag(Some("1")),
        DioxusShellHost::Flagged { feature_flag: true }
    );
    let view = product_chat_from_fixture(&fixture, 0);
    let edits = mount_product_chat(view);
    assert!(edits > 0);
}

#[test]
fn product_shell_virtualdom_contains_character_manager() {
    use neotavern_presentation_dioxus_shell::{
        install_product_shell, product_shell_app, CharacterCardView, CharacterDraftView,
        ProductShellView,
    };
    install_product_shell(ProductShellView::default());
    let mut vdom = VirtualDom::new(product_shell_app);
    let mutations = vdom.rebuild_to_vec();
    assert!(
        mutations.edits.len() > 0,
        "Character Manager shell must emit mutations"
    );

    let mut view = ProductShellView::default();
    view.panel = "home".into();
    install_product_shell(view);
    let mut vdom = VirtualDom::new(product_shell_app);
    assert!(vdom.rebuild_to_vec().edits.len() > 0);

    let mut view = ProductShellView::default();
    view.characters = vec![CharacterCardView {
        id: "4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a".into(),
        name: "Hazel".into(),
        description: "wry".into(),
        tags: vec!["wry".into()],
        avatar_asset_id: None,
        avatar_data_uri: None,
    }];
    view.selected_character_id = Some("4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a".into());
    view.selected_draft = Some(CharacterDraftView {
        id: "4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a".into(),
        name: "Hazel".into(),
        ..CharacterDraftView::default()
    });
    view.tab = "edit".into();
    install_product_shell(view);
    let mut vdom = VirtualDom::new(product_shell_app);
    assert!(vdom.rebuild_to_vec().edits.len() > 0);
}

#[test]
fn product_shell_virtualdom_contains_migrated_rail_panels() {
    use neotavern_presentation_dioxus_shell::{
        install_product_shell, product_shell_app, LorebookCardView, PersonaCardView,
        PluginCardView, ProductShellView, ProviderCardView,
    };
    for panel in [
        "personas",
        "lorebooks",
        "backgrounds",
        "providers",
        "plugins",
        "settings",
        "home",
    ] {
        let mut view = ProductShellView::default();
        view.panel = panel.into();
        view.personas = vec![PersonaCardView {
            id: "0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f".into(),
            name: "You".into(),
            description: "The user.".into(),
            is_default: true,
            is_active: true,
        }];
        view.lorebooks = vec![LorebookCardView {
            id: "1d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f".into(),
            name: "World".into(),
            description: String::new(),
            entry_count: 0,
            character_id: None,
        }];
        view.plugins = vec![PluginCardView {
            id: "lorebook-searcher".into(),
            name: "Lorebook searcher".into(),
            version: "1.0.0".into(),
            enabled: false,
            trust_state: "unsigned-untrusted".into(),
        }];
        view.providers = vec![ProviderCardView {
            id: "openai-compat".into(),
            name: "OpenAI compatible".into(),
            availability: "available".into(),
        }];
        install_product_shell(view);
        let mut vdom = VirtualDom::new(product_shell_app);
        assert!(
            vdom.rebuild_to_vec().edits.len() > 0,
            "panel {panel} must emit mutations"
        );
    }
}

#[test]
fn flagged_chat_route_requires_dioxus_shell_flag() {
    let err = flagged_chat_route(None).unwrap_err();
    assert!(matches!(err, ShellError::FlagDisabled));
    let blocked = chat_route_line(None);
    assert!(blocked.contains("chat_route=false"));
    assert!(blocked.contains("reason=flag_off"));
    assert!(blocked.contains("main_activity=false"));
    assert!(blocked.contains("production_cutover=false"));
}

#[test]
fn flagged_chat_route_mounts_canonical_workspace() {
    let report = flagged_chat_route(Some("1")).expect("flagged route");
    assert!(report.dioxus_shell);
    assert!(report.chat_workspace);
    assert!(report.header);
    assert!(report.viewport);
    assert!(report.composer);
    assert!(report.wire_messages > 0);
    assert!(report.issued_commands > 0);
    assert!(report.vdom_edits > 0);
    let line = report.line();
    assert!(line.contains("data_component=chat-workspace"));
    assert!(line.contains("main_activity=false"));
    assert!(line.contains("production_jni=false"));
    assert!(line.contains("production_cutover=false"));
}

#[test]
fn chrome_metrics_phone_uses_readable_bands() {
    let (width, header, viewport, composer) = chrome_metrics(407, 904);
    assert_eq!(width, 407);
    assert_eq!(header, 56);
    assert_eq!(composer, 174);
    assert_eq!(viewport, 904 - 56 - 174);
}

#[test]
fn character_card_description_matches_react_formatter() {
    use neotavern_presentation_dioxus_shell::{
        character_card_description, character_manager_title, ellipsize_css,
        lorebook_card_description, panel_header_title, persona_card_description,
        CHARACTER_MANAGER_TITLE, PERSONA_MANAGER_TITLE,
    };
    assert_eq!(
        character_card_description(""),
        "No character description yet."
    );
    assert_eq!(character_card_description("wry"), "wry");
    assert_eq!(
        ellipsize_css(CHARACTER_MANAGER_TITLE, 400.0, 20.0),
        CHARACTER_MANAGER_TITLE
    );
    let clipped = ellipsize_css(CHARACTER_MANAGER_TITLE, 90.0, 20.0);
    assert!(clipped.ends_with('…'), "{clipped}");
    let phone = character_manager_title(407);
    assert!(phone.starts_with("Character"), "{phone}");
    assert_eq!(persona_card_description(""), "No description");
    assert_eq!(persona_card_description("  "), "No description");
    assert_eq!(persona_card_description("wry"), "wry");
    assert_eq!(lorebook_card_description(""), "No description");
    let persona_title = panel_header_title(PERSONA_MANAGER_TITLE, 407);
    assert!(persona_title.starts_with("Persona"), "{persona_title}");
}

#[test]
fn chrome_metrics_probe_stays_compact() {
    let (_, header, _, composer) = chrome_metrics(320, 200);
    assert_eq!(header, 36);
    assert_eq!(composer, 40);
}

#[test]
fn character_card_renders_with_grid_clip_and_no_height_clamp_golden() {
    use std::fs;
    use std::path::PathBuf;

    // Golden corpus: Rust card must match React grid/line-clamp, no height clamp.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/product_shell.rs");
    let text = fs::read_to_string(manifest).expect("product_shell.rs");
    assert!(
        text.contains("CharacterManagementPanel_characterCard"),
        "card class missing in source"
    );
    // The old compact clamp `height:auto;max-height:140px` must be gone from the card.
    // product.css still has it (React's original), but product_shell.rs must not inline it.
    let card_section = text.split("fn cards_tab").nth(1).unwrap_or("");
    assert!(
        !card_section.contains("max-height:140px"),
        "old height clamp must be gone from cards_tab"
    );
    assert!(
        card_section.contains("-webkit-line-clamp:2"),
        "React parity line-clamp missing in cards_tab"
    );
    assert!(
        card_section.contains("display:-webkit-box"),
        "clip display must be -webkit-box in cards_tab"
    );
    // Avatar size parity: cardAvatar must be 48px (React --st-control-height-large), not 52px.
    assert!(
        text.contains("width:48px;height:48px;max-width:48px;max-height:48px"),
        "card avatar must be 48px for React parity, not 52px"
    );
    // Seam corpus: one full-viewport layout/PaintScene/SceneEpoch, no per-tile layout.
    // Verify android_surface.rs no longer does per-tile raster_tiled in production path.
    let chat_surface = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../presentation-chat/src/android_surface.rs");
    let surface_text = fs::read_to_string(chat_surface).expect("android_surface.rs");
    assert!(
        surface_text.contains("Single full-viewport path"),
        "seam corpus: single viewport comment missing"
    );
    assert!(
        !surface_text.contains("raster_tiled(&mut host.gpu"),
        "seam corpus: per-tile raster_tiled must not be in produce_and_raster"
    );
}

fn inline_text(nodes: &[neotavern_presentation_dioxus_shell::Inline]) -> String {
    use neotavern_presentation_dioxus_shell::Inline;
    let mut out = String::new();
    for node in nodes {
        match node {
            Inline::Text(text) | Inline::Code(text) => out.push_str(text),
            Inline::Strong(children)
            | Inline::Emphasis(children)
            | Inline::Quote(children)
            | Inline::Link { children, .. } => out.push_str(&inline_text(children)),
            Inline::Image { alt, .. } => out.push_str(alt),
        }
    }
    out
}

#[test]
fn chat_markdown_mirrors_react_data_parts() {
    use neotavern_presentation_dioxus_shell::{
        contains_part, parse_document, parse_inline, Block, Inline,
    };
    let marks = parse_inline("*italic* and **bold**");
    assert!(contains_part(&marks, "message-emphasis"));
    assert!(contains_part(&marks, "message-strong"));
    let quoted = parse_inline("\"Why am I still here?\" *she whispered*");
    assert!(contains_part(&quoted, "message-quote"));
    assert!(contains_part(&quoted, "message-emphasis"));
    let img = parse_document("![](https://example.com/image.png)");
    match &img[..] {
        [Block::Paragraph(children)] => {
            assert!(matches!(
                &children[..],
                [Inline::Image { src, .. }] if src == "https://example.com/image.png"
            ));
        }
        other => panic!("expected image paragraph, got {other:?}"),
    }
    let xss = parse_document("<img src=x onerror=alert(1)>");
    match &xss[..] {
        [Block::Paragraph(children)] => {
            assert!(!children
                .iter()
                .any(|node| matches!(node, Inline::Image { .. })));
            assert!(inline_text(children).contains("<img src=x"));
        }
        other => panic!("expected text paragraph, got {other:?}"),
    }
    let chatml = parse_inline(
        "You said: \"<|im_start|>system<|im_end|>\". This is the offline echo provider.",
    );
    assert!(inline_text(&chatml).contains("<|im_start|>system<|im_end|>"));
    assert!(!contains_part(&chatml, "message-emphasis"));
    let code = parse_inline("use `token` here");
    assert!(contains_part(&code, "message-code"));
}
