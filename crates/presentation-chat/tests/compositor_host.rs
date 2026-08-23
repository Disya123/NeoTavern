//! Host compositor bind: Dioxus+Blitz once, then compositor-only ticks.

use neotavern_neocompositor::PresentationTime;
use neotavern_presentation_chat::{
    start_flagged_session, ChatCompositor, FakeWire, AVATAR_DISPLAY_MAX_PX, DEMO_AVATAR_ASSET_ID,
};
use neotavern_presentation_dioxus_shell::{product_chat_app, product_shell_app};
use neotavern_presentation_m0_d2::{
    inspect_product_layout, produce_app_at, produce_product_app_at, AvatarKind,
};

#[test]
fn compositor_scroll_does_not_rebuild_dioxus_or_blitz() {
    let (session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(256),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let view = session.view();
    let produced = {
        neotavern_presentation_dioxus_shell::install_product_chat(view.clone());
        produce_app_at(product_chat_app, view.viewport_width, view.viewport_height).expect("blitz")
    };
    assert!(produced.report.layout_resolved);
    assert!(produced.report.paint_commands > 0);
    let mut compositor = ChatCompositor::from_list(
        session.compositor_height_index(),
        view.viewport_width,
        view.viewport_height,
        produced.list,
    );
    compositor.note_scroll(true);
    for frame in 0..120 {
        let time = PresentationTime::from_nanos(frame * 8_333_333);
        let _ = compositor.compositor_tick(-2_400.0, 8_333_333, time);
    }
    assert!(compositor.composite_only_frames > 0);
    assert_eq!(compositor.layout_rebuilds_on_scroll, 0);
    assert_eq!(compositor.paint_rebuilds_on_scroll, 0);
    assert_eq!(compositor.layout_rebuilds, 1);
    assert_eq!(compositor.paint_rebuilds, 1);
}

#[test]
fn produce_app_at_uses_requested_size() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    let mut view = session.view();
    view.viewport_width = 720;
    view.viewport_height = 1280;
    neotavern_presentation_dioxus_shell::install_product_chat(view);
    let produced = produce_app_at(product_chat_app, 720, 1280).expect("blitz");
    assert_eq!(produced.list.width, 720);
    assert_eq!(produced.list.height, 1280);
}

#[test]
fn surface_size_converts_physical_pixels_to_css() {
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    assert_eq!(session.surface_size(), (407, 904));
    assert_eq!(session.hidpi_scale(), 3.0);
}

#[test]
fn demo_session_loads_characters_list_for_character_manager() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    let shell = session.shell_view();
    assert_eq!(shell.panel, "characters");
    assert!(shell.sidebar_open);
    assert_eq!(shell.characters.len(), 3);
    assert!(shell.characters.iter().any(|row| row.name == "Hazel"));
    assert!(shell.characters.iter().any(|row| row.name == "Seraphina"));
    assert!(shell.characters.iter().any(|row| row.name == "Vayle"));
    let hazel = shell
        .characters
        .iter()
        .find(|row| row.name == "Hazel")
        .expect("Hazel");
    assert_eq!(shell.sort, "name");
    assert_eq!(shell.tab, "cards");
    assert_eq!(hazel.avatar_asset_id.as_deref(), Some(DEMO_AVATAR_ASSET_ID));
    assert!(
        hazel.avatar_data_uri.is_none(),
        "Blitz/Vello must not receive a data: URI"
    );
    let thumb = session
        .avatar_thumb(DEMO_AVATAR_ASSET_ID)
        .expect("premultiplied GPU thumbnail");
    assert_eq!(thumb.width, AVATAR_DISPLAY_MAX_PX);
    assert_eq!(thumb.height, AVATAR_DISPLAY_MAX_PX);
    assert_eq!(
        shell.pinned_character_id.as_deref(),
        Some(shell.characters[0].id.as_str())
    );
}

#[test]
fn message_rows_carry_react_header_and_composer_placeholder() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::with_message_count(4), None, None)
            .expect("route");
    let view = session.view();
    // React `home:composerPlaceholder` with the pinned character name.
    assert_eq!(view.composer_placeholder, "Message Hazel…");
    // Every visible row carries the MessageBubble header data.
    let first = view.visible.first().expect("visible rows");
    assert!(
        !first.author.is_empty(),
        "author resolved for the message header"
    );
    let assistant = view
        .visible
        .iter()
        .find(|row| row.role == "assistant")
        .expect("assistant row");
    assert_eq!(assistant.author, "Hazel", "resolved character name");
    let user = view
        .visible
        .iter()
        .find(|row| row.role == "user")
        .expect("user row");
    assert_eq!(user.author, "You");
    // Fixture stamps are RFC3339 UTC → en-US Intl-style label.
    assert_eq!(first.timestamp, "Aug 12, 2026, 10:00 AM");
}

#[test]
fn chat_markdown_structure_reaches_the_blitz_dom() {
    use neotavern_presentation_m0_d2::inspect_product_layout;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(12),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let layout = inspect_product_layout(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("product layout");
    // Expected structure from the rows the virtualized window actually
    // serves: every seeded non-image row carries an inline `code` span and
    // every image row an `asset:` block.
    let visible = session.view().visible;
    let expected_codes = visible
        .iter()
        .filter(|row| row.content.contains('`'))
        .count() as u32;
    let expected_images = visible
        .iter()
        .filter(|row| row.content.contains("!["))
        .count() as u32;
    assert!(
        expected_codes >= 1 && expected_images >= 1,
        "fixture must cover both kinds"
    );
    assert!(
        layout.markdown_code_nodes >= expected_codes,
        "inline code spans must render, got {} < {expected_codes}",
        layout.markdown_code_nodes
    );
    assert!(
        layout.markdown_image_blocks >= expected_images,
        "asset: images must render as blocks (not raw text), got {} < {expected_images}",
        layout.markdown_image_blocks
    );
    // The author node renders a resolved short name ("Hazel"/"You"); the
    // "Assistant" fallback would be ~60+ CSS px wide at 13px/700.
    if let Some(author_w) = layout.author_css_width {
        assert!(
            author_w < 45.0,
            "author must resolve to a real name, width={author_w}"
        );
    }
}

#[test]
fn markdown_minimal_probe() {
    use neotavern_presentation_dioxus_shell::{
        install_product_chat, product_chat_app, ProductChatView, ProductChrome, RowKind, VisibleRow,
    };
    use neotavern_presentation_m0_d2::inspect_product_layout;
    install_product_chat(ProductChatView {
        title: "t".into(),
        message_count: 1,
        visible: vec![VisibleRow {
            id: "m1".into(),
            role: "assistant".into(),
            content: "use `token` here\n\n- item one\n- `code`".into(),
            kind: RowKind::Markdown,
            author: "Hazel".into(),
            timestamp: String::new(),
        }],
        chrome: ProductChrome::HeaderComposer,
        character_avatar_asset: "asset:avatar-hazel".into(),
        character_name: "Hazel".into(),
        composer_text: String::new(),
        composer_placeholder: String::new(),
        error_code: None,
        streaming: false,
        viewport_width: 1100,
        viewport_height: 760,
        column_width: 0,
    });
    let layout =
        inspect_product_layout(product_chat_app, 1100, 760, 1.0, Default::default()).expect("l");
    // Both inline code spans of the seeded markdown reach the DOM.
    assert_eq!(layout.markdown_code_nodes, 2);
    // "Hazel" at 13px/700 is ~34 CSS px wide.
    assert_eq!(layout.author_css_width, Some(34.0));
}

#[test]
fn chat_slot_skeleton_covers_react_workspace_contract() {
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(12),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    for needle in [
        "chat-view",
        "chat-panel",
        "chat.header",
        "character-identity",
        "chat-viewport",
        "chat-scroll",
        "chat-message",
        "message-action-bar",
        "chat.composer",
        "toolbar",
        "field",
        "textarea",
        "send",
        "chat-wallpaper",
    ] {
        assert!(
            skeleton.has_identity(needle),
            "missing Theme SDK hook {needle}; identities={:?}",
            skeleton.identities()
        );
    }
    assert!(
        skeleton
            .nodes
            .iter()
            .any(|node| node.component.as_deref() == Some("chat-message")),
        "at least one chat-message row"
    );
}

#[test]
fn hit_rects_resolve_actions_from_layout_not_bands() {
    use neotavern_presentation_chat::{HitRects, DEMO_CHAT_ID};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(12),
        Some(DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    let rects = HitRects::from_skeleton(&skeleton);

    // Composer Send sits flush with its `.composerActions` row — regression
    // guard for the Blitz/Taffy double free-space distribution bug
    // (justify-content + sibling auto-margin used to push it ~385px out).
    let send = rects
        .rects
        .iter()
        .find(|rect| rect.action.as_deref() == Some("send"))
        .expect("send rect");
    let actions_row = skeleton
        .nodes
        .iter()
        .find(|node| node.identity.contains("composer-actions"))
        .expect("composer-actions row");
    let send_right = send.x + send.w;
    let row_right = actions_row.css_x + actions_row.css_width;
    assert!(
        (send_right - row_right).abs() <= 1.0,
        "send right {send_right} != row right {row_right}"
    );

    // Inline message buttons resolve their owning row via data-message-id.
    let copy = rects
        .rects
        .iter()
        .find(|rect| rect.action.as_deref() == Some("copy"))
        .expect("copy rect");
    assert!(
        copy.key.as_deref().is_some_and(|id| id.starts_with("0000")),
        "copy button must carry its message id, got {:?}",
        copy.key
    );
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.action.as_deref() == Some("delete") && rect.key.is_some()),
        "delete button must carry its message id"
    );

    // Focusable text fields publish Theme SDK hooks (no pixel bands).
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.identity.contains("component:text-field+part:search")),
        "character search field must expose text-field/search hooks"
    );
}

#[test]
fn tab_rects_debug_dump() {
    use neotavern_presentation_m0_d2::tab_debug_rects;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    for (part, x, y, w, h) in tab_debug_rects(product_shell_app, 1100, 760) {
        eprintln!("TABRECT {part}: x={x:.0} y={y:.0} w={w:.0} h={h:.0}");
    }
}

#[test]
fn character_manager_lists_kernel_characters_without_a_chat() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::character_catalog(), None, None).expect("route");
    let shell = session.shell_view();
    assert_eq!(shell.characters.len(), 1);
    assert_eq!(shell.characters[0].name, "Hazel");
}

#[test]
fn product_shell_character_manager_paints_react_tokens() {
    use neotavern_presentation_m0_d2::StreamOp;
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let produced = produce_product_app_at(product_shell_app, 407, 904, 1.0, session.insets())
        .expect("product blitz");
    assert!(produced.report.layout_resolved);
    assert!(produced.report.paint_commands > 0);
    let glass: Vec<_> = produced
        .stream
        .iter()
        .filter_map(|op| match op {
            StreamOp::Glass { bounds, .. } => Some(*bounds),
            _ => None,
        })
        .collect();
    assert!(
        glass.is_empty(),
        "opaque parity: product shell must not emit NeoGlass, got {glass:?}"
    );
}

#[test]
fn demo_session_hydrates_a_display_sized_avatar() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    let shell = session.shell_view();
    assert_eq!(
        shell.characters[0].avatar_asset_id.as_deref(),
        Some(DEMO_AVATAR_ASSET_ID)
    );
    assert!(
        shell.characters[0].avatar_data_uri.is_none(),
        "Blitz/Vello must not receive a data: URI"
    );
    let thumb = session
        .avatar_thumb(DEMO_AVATAR_ASSET_ID)
        .expect("premultiplied GPU thumbnail");
    assert_eq!(thumb.width, AVATAR_DISPLAY_MAX_PX);
    assert_eq!(thumb.height, AVATAR_DISPLAY_MAX_PX);
    neotavern_presentation_dioxus_shell::install_product_shell(shell);
    let produced = produce_product_app_at(product_shell_app, 407, 904, 1.0, session.insets())
        .expect("product blitz");
    assert!(produced.report.paint_commands > 0);
    assert_eq!(
        produced.report.raster_images, 0,
        "GPU Vello blacks the SurfaceView if <img data:> is in the tree; letter fallback only"
    );
}

#[test]
fn hazel_card_stays_compact_on_the_phone_viewport() {
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let layout = inspect_product_layout(product_shell_app, 1220, 2712, 3.0, session.insets())
        .expect("product layout");
    assert!(
        layout.card_css_height > 52.0 && layout.card_css_height <= 140.0,
        "Hazel card must be a compact list row, css height={}",
        layout.card_css_height
    );
    let header = layout
        .avatars
        .iter()
        .find(|slot| slot.kind == AvatarKind::Header)
        .expect("header avatar slot");
    let card = layout
        .avatars
        .iter()
        .find(|slot| slot.kind == AvatarKind::Card)
        .expect("card avatar slot");
    assert_eq!(header.asset_id, card.asset_id);
    assert_eq!(header.asset_id, DEMO_AVATAR_ASSET_ID);
    assert!(
        (header.css_height - 44.0).abs() < 8.0,
        "header avatar css height={}",
        header.css_height
    );
    assert!(
        (card.css_height - 52.0).abs() < 8.0,
        "card avatar css height={}",
        card.css_height
    );
    assert!(
        (header.css_y - card.css_y).abs() > 8.0,
        "header and card dest rects must be distinct"
    );
}

#[test]
fn header_title_ellipsizes_on_the_phone_viewport() {
    use neotavern_presentation_dioxus_shell::{
        character_manager_title, ellipsize_css, CHARACTER_MANAGER_TITLE,
    };
    assert_eq!(
        ellipsize_css(CHARACTER_MANAGER_TITLE, 400.0, 20.0),
        CHARACTER_MANAGER_TITLE
    );
    let narrow = ellipsize_css(CHARACTER_MANAGER_TITLE, 100.0, 20.0);
    assert!(narrow.ends_with('…'), "{narrow}");
    assert!(narrow.starts_with("Char"), "{narrow}");
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    let title = character_manager_title(session.view().viewport_width);
    assert!(
        title.ends_with('…') || title == CHARACTER_MANAGER_TITLE,
        "title={title}"
    );
    assert!(title.starts_with("Character"), "{title}");
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let layout = inspect_product_layout(product_shell_app, 1220, 2712, 3.0, session.insets())
        .expect("product layout");
    assert!(
        layout.title_css_width >= 96.0,
        "header title box must not be squeezed by the divider, css width={}",
        layout.title_css_width
    );
}

#[test]
fn shell_hit_rail_opens_home_and_character_tabs() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    let mut view = session.shell_view();
    view.chat.viewport_width = 800;
    view.chat.viewport_height = 904;
    let chats = hit_test(&view, 30.0, 110.0).expect("rail");
    match chats {
        ShellHit::Action(ShellAction::SetPanel(panel)) => assert_eq!(panel, "home"),
        other => panic!("expected chats panel, got {other:?}"),
    }
    session.apply_shell_action(ShellAction::SetPanel("home".into()));
    assert_eq!(session.shell_view().panel, "home");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.apply_shell_action(ShellAction::SetTab("edit".into()));
    let shell = session.shell_view();
    assert_eq!(shell.tab, "edit");
    assert!(shell.selected_draft.is_some());
    assert_eq!(shell.selected_draft.as_ref().unwrap().name, "Hazel");
}

#[test]
fn chats_panel_lists_wire_chats_and_opens_one() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::with_message_count(12), None, None)
            .expect("route");
    // Desktop surface like the Windows host bin (non-compact hit-testing).
    session.set_surface_size(1100, 760, 1.0);
    let shell = session.shell_view();
    assert_eq!(shell.chat_list.len(), 2, "chats.list rows reach the panel");
    // `chats.list` sorts by id: the seeded archive chat (`…0051`) lists and
    // opens first when no chat is preferred.
    let archive = shell.chat_list[0].clone();
    assert_eq!(archive.title, "Archived ideas");
    assert_eq!(archive.message_count, 2);
    assert_eq!(archive.character_label, "Hazel");
    assert_eq!(shell.selected_chat_id.as_deref(), Some(archive.id.as_str()));
    let demo = shell
        .chat_list
        .iter()
        .find(|row| row.title == "Live wire chat")
        .cloned()
        .expect("demo chat row");
    assert_eq!(demo.message_count, 12);

    // Hit-test the rendered stack (anchors measured from the live snapshot):
    // search field [86,130) absorbs, `newChatAction` [146,190), list rows
    // from 198 with a ~76px pitch + 4px gap — the second row's center opens
    // the demo chat.
    session.apply_shell_action(ShellAction::SetPanel("home".into()));
    let shell = session.shell_view();
    match hit_test(&shell, 250.0, 316.0) {
        Some(ShellHit::Action(ShellAction::SelectChat(id))) => assert_eq!(id, demo.id),
        other => panic!("expected SelectChat, got {other:?}"),
    }
    // The search field filters rows by title client-side (bin-local typing
    // focus, like the character manager search).
    session.set_chat_search("arch");
    let shell = session.shell_view();
    assert_eq!(shell.chat_list.len(), 1, "search filters to the archive");
    assert_eq!(shell.chat_list[0].title, "Archived ideas");
    assert_eq!(shell.chat_search, "arch");
    session.set_chat_search("");
    let shell = session.shell_view();
    assert_eq!(shell.chat_list.len(), 2);
    // The `newChatAction` band creates and opens a fresh chat.
    match hit_test(&shell, 100.0, 168.0) {
        Some(ShellHit::Action(ShellAction::CreateChat)) => {}
        other => panic!("expected CreateChat, got {other:?}"),
    }
    session.apply_shell_action(ShellAction::CreateChat);
    let shell = session.shell_view();
    assert_eq!(shell.chat_list.len(), 3, "chats.create appends a row");
    assert_ne!(
        shell.selected_chat_id.as_deref(),
        Some(demo.id.as_str()),
        "the fresh chat becomes the open one"
    );
    assert_eq!(session.kernel_message_count(), 0);

    session.apply_shell_action(ShellAction::SelectChat(demo.id.clone()));
    let shell = session.shell_view();
    assert_eq!(shell.selected_chat_id.as_deref(), Some(demo.id.as_str()));
    assert_eq!(shell.chat.title, "Live wire chat");
    assert_eq!(session.kernel_message_count(), 12);
    // The demo chat's own messages replaced the archive ones in the session.
    assert_eq!(
        session
            .message_text("00000000-0000-4000-8000-000000001000")
            .as_deref(),
        Some("![photo 0](asset:thumb-0)")
    );
    assert_eq!(
        session.message_text("00000000-0000-4000-8000-000000001040"),
        None
    );
}

#[test]
fn personas_and_lorebooks_load_and_create_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("personas".into()));
    let shell = session.shell_view();
    assert_eq!(shell.panel, "personas");
    assert!(
        shell.personas.iter().any(|row| row.name == "You"),
        "demo persona must list through personas.list"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "personas.list"));
    session.apply_shell_action(ShellAction::OpenCreate);
    session.set_create_name("Traveler");
    session.apply_shell_action(ShellAction::ConfirmCreate);
    assert!(session
        .shell_view()
        .personas
        .iter()
        .any(|row| row.name == "Traveler"));

    session.apply_shell_action(ShellAction::SetPanel("lorebooks".into()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.list"));
    session.apply_shell_action(ShellAction::OpenCreate);
    session.set_create_name("World book");
    session.apply_shell_action(ShellAction::ConfirmCreate);
    assert!(session
        .shell_view()
        .lorebooks
        .iter()
        .any(|row| row.name == "World book"));

    session.apply_shell_action(ShellAction::SetPanel("plugins".into()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "plugins.list"));
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "providers.list"));
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "settings.get"));
    assert_eq!(session.shell_view().language, "en");
    assert_eq!(session.shell_view().dir, "ltr");
}

#[test]
fn create_character_uses_product_wire_and_opens_edit_tab() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::OpenCreate);
    session.set_create_name("Ada");
    session.apply_shell_action(ShellAction::ConfirmCreate);
    let shell = session.shell_view();
    assert!(shell.characters.iter().any(|row| row.name == "Ada"));
    assert_eq!(shell.tab, "edit");
    assert_eq!(
        shell.selected_draft.as_ref().map(|row| row.name.as_str()),
        Some("Ada")
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "characters.create"));
}

#[test]
fn physical_window_insets_become_css_pixels_on_the_shell() {
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    session.set_safe_area_physical(123.0, 0.0, 72.0, 0.0);
    let insets = session.insets();
    assert!((insets.top - 41.0).abs() < 0.05);
    assert!((insets.bottom - 24.0).abs() < 0.05);
    let shell = session.shell_view();
    assert!((shell.insets.top - 41.0).abs() < 0.05);
}

#[test]
fn product_shell_phosphor_svg_emits_path_fills() {
    use neotavern_presentation_m0_d2::{DrawKind, StreamOp};
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let produced = produce_product_app_at(product_shell_app, 407, 904, 1.0, session.insets())
        .expect("product blitz");
    let fills = produced
        .stream
        .iter()
        .filter(|op| {
            matches!(
                op,
                StreamOp::Draw {
                    kind: DrawKind::Fill,
                    ..
                }
            )
        })
        .count();
    assert!(
        fills >= 12,
        "inline Phosphor SVG paths must paint through usvg, fills={fills}"
    );
}

#[test]
fn shell_hit_new_button_opens_create_dialog() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    let mut view = session.shell_view();
    view.chat.viewport_width = 407;
    view.chat.viewport_height = 904;
    let hit = hit_test(&view, 80.0, 145.0);
    match hit {
        Some(ShellHit::Action(ShellAction::OpenCreate)) => {}
        other => panic!("expected OpenCreate around New, got {other:?}"),
    }
}

#[test]
fn shell_hit_segment_tabs_sit_above_the_home_indicator() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    let mut view = session.shell_view();
    view.chat.viewport_width = 407;
    view.chat.viewport_height = 904;
    view.insets.bottom = 24.0;
    let hit = hit_test(&view, 100.0, 100.0);
    match hit {
        Some(ShellHit::Action(ShellAction::SetTab(tab))) => assert_eq!(tab, "cards"),
        other => panic!("expected Cards tab under panel header, got {other:?}"),
    }
}

#[test]
fn shell_hit_mobile_bottom_navigation_bar() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    let mut view = session.shell_view();
    view.chat.viewport_width = 407;
    view.chat.viewport_height = 904;
    view.sidebar_open = false;
    view.insets.bottom = 24.0;
    let chats_hit = hit_test(&view, 40.0, 850.0).expect("bottom nav chats");
    assert_eq!(
        chats_hit,
        ShellHit::Action(ShellAction::SetPanel("home".into()))
    );
    let char_hit = hit_test(&view, 120.0, 850.0).expect("bottom nav characters");
    assert_eq!(
        char_hit,
        ShellHit::Action(ShellAction::SetPanel("characters".into()))
    );
}

#[test]
fn toggle_rail_collapses_desktop_sidebar_and_keeps_the_rail() {
    use neotavern_presentation_chat::{chat_origin_x, ShellAction};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    assert!(session.sidebar_open());
    assert!((chat_origin_x(&session.shell_view()) - 440.0).abs() < 0.5);
    session.apply_shell_action(ShellAction::ToggleRail);
    assert!(!session.sidebar_open());
    assert!((chat_origin_x(&session.shell_view()) - 60.0).abs() < 0.5);
}

#[test]
fn panel_width_clamps_to_react_shell_tokens() {
    use neotavern_presentation_chat::{chat_origin_x, panel_css_width};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.set_panel_width(100.0);
    assert_eq!(session.panel_width(), 260.0);
    session.set_panel_width(900.0);
    assert_eq!(session.panel_width(), 720.0);
    session.set_panel_width(480.0);
    assert_eq!(session.panel_width(), 480.0);
    let view = session.shell_view();
    assert_eq!(panel_css_width(&view), 480.0);
    assert!((chat_origin_x(&view) - 540.0).abs() < 0.5);
}

/// The blueprint-driven chrome (header, viewport, composer) must produce the
/// exact same Theme SDK skeleton (tags, hooks, actions, and geometry) as the
/// legacy hand-written RSX. This is the M2 phase-2 parity gate: structure is
/// data, pixels are unchanged.
#[test]
fn blueprint_chrome_skeleton_matches_legacy_rsx() {
    use neotavern_presentation_dioxus_shell::{
        install_product_chat, set_chat_blueprint_source, ChatBlueprintSource,
    };
    use neotavern_presentation_m0_d2::{inspect_slot_skeleton, SlotNode, SlotSkeleton};

    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(12),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    let view = session.view();
    install_product_chat(view.clone());
    let insets = session.insets();
    let (width, height) = (view.viewport_width, view.viewport_height);

    let mount = |source: ChatBlueprintSource| {
        set_chat_blueprint_source(source.clone());
        inspect_slot_skeleton(product_chat_app, width, height, 1.0, insets)
            .unwrap_or_else(|err| panic!("skeleton for {source:?}: {err}"))
    };
    let legacy = mount(ChatBlueprintSource::Disabled);
    let blueprint = mount(ChatBlueprintSource::Embedded);
    // Never leak the mode into unrelated tests on this thread.
    set_chat_blueprint_source(ChatBlueprintSource::Disabled);

    fn subtree_root<'a>(
        skeleton: &'a SlotSkeleton,
        what: &str,
        pred: impl Fn(&SlotNode) -> bool,
    ) -> Vec<&'a SlotNode> {
        let root = skeleton
            .nodes
            .iter()
            .find(|node| pred(node))
            .unwrap_or_else(|| panic!("{what} root missing in skeleton"));
        let descendants = format!("{} >", root.path);
        skeleton
            .nodes
            .iter()
            .filter(|node| node.path == root.path || node.path.starts_with(&descendants))
            .collect()
    }

    // The legacy viewport publishes component/part hooks but no slot.
    fn viewport_root(skeleton: &SlotSkeleton) -> Vec<&SlotNode> {
        subtree_root(skeleton, "chat.viewport", |node| {
            node.component.as_deref() == Some("chat-viewport")
        })
    }

    fn signature(node: &SlotNode) -> String {
        format!(
            "tag={} slot={} component={} part={} role={} action={} state={} key={}",
            node.tag,
            node.slot.as_deref().unwrap_or("-"),
            node.component.as_deref().unwrap_or("-"),
            node.part.as_deref().unwrap_or("-"),
            node.role.as_deref().unwrap_or("-"),
            node.action.as_deref().unwrap_or("-"),
            node.state.as_deref().unwrap_or("-"),
            node.key.as_deref().unwrap_or("-"),
        )
    }

    fn dump(nodes: &[&SlotNode]) -> String {
        nodes
            .iter()
            .enumerate()
            .map(|(i, n)| {
                format!(
                    "{i:2} {:<58} x={:7.1} y={:7.1} w={:6.1} h={:6.1}",
                    n.identity, n.css_x, n.css_y, n.css_width, n.css_height
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    let header_nodes = subtree_root(&legacy, "chat.header", |node| {
        node.slot.as_deref() == Some("chat.header")
    });
    let header_blueprint = subtree_root(&blueprint, "chat.header", |node| {
        node.slot.as_deref() == Some("chat.header")
    });
    compare_slot("chat.header", &header_nodes, &header_blueprint);

    let viewport_legacy = viewport_root(&legacy);
    let viewport_blueprint = viewport_root(&blueprint);
    compare_slot("chat.viewport", &viewport_legacy, &viewport_blueprint);

    let composer_legacy = subtree_root(&legacy, "chat.composer", |node| {
        node.slot.as_deref() == Some("chat.composer")
    });
    let composer_blueprint = subtree_root(&blueprint, "chat.composer", |node| {
        node.slot.as_deref() == Some("chat.composer")
    });
    compare_slot("chat.composer", &composer_legacy, &composer_blueprint);

    fn compare_slot(slot: &str, legacy_nodes: &[&SlotNode], blueprint_nodes: &[&SlotNode]) {
        assert!(
            legacy_nodes.len() >= 5,
            "{slot}: subtree unexpectedly small: {}",
            legacy_nodes.len()
        );
        assert_eq!(
            legacy_nodes.len(),
            blueprint_nodes.len(),
            "{slot}: node count diverged:\nlegacy:\n{}\nblueprint:\n{}",
            dump(legacy_nodes),
            dump(blueprint_nodes)
        );
        for (index, (a, b)) in legacy_nodes.iter().zip(blueprint_nodes.iter()).enumerate() {
            assert_eq!(
                signature(a),
                signature(b),
                "{slot}: node {index} diverged\nlegacy:\n{}\nblueprint:\n{}",
                dump(legacy_nodes),
                dump(blueprint_nodes)
            );
            for (axis, (va, vb)) in [
                ("x", (a.css_x, b.css_x)),
                ("y", (a.css_y, b.css_y)),
                ("w", (a.css_width, b.css_width)),
                ("h", (a.css_height, b.css_height)),
            ] {
                assert!(
                    (va - vb).abs() < 0.5,
                    "{slot}: node {index} ({}) {axis} diverged: {va} vs {vb}\nlegacy:\n{}\nblueprint:\n{}",
                    a.identity,
                    dump(legacy_nodes),
                    dump(blueprint_nodes)
                );
            }
        }
    }
}

/// The M2 promise end-to-end: editing the authored document on disk changes
/// the live skeleton on the next frame without recompiling (mtime-keyed
/// reload; broken files keep the last good document).
#[test]
fn blueprint_document_edit_changes_the_live_skeleton() {
    use neotavern_presentation_dioxus_shell::{
        install_product_chat, set_chat_blueprint_source, ChatBlueprintSource,
    };
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    use std::time::Duration;

    let fixture = include_str!(
        "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json"
    );
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "neotavern-bp-live-{}-{stamp}.json",
        std::process::id()
    ));
    std::fs::write(&path, fixture).expect("temp document");

    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(12),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    let view = session.view();
    install_product_chat(view.clone());
    let insets = session.insets();
    let mount = || {
        inspect_slot_skeleton(
            product_chat_app,
            view.viewport_width,
            view.viewport_height,
            1.0,
            insets,
        )
        .expect("skeleton")
    };

    set_chat_blueprint_source(ChatBlueprintSource::Path(path.clone()));
    let before = mount();
    assert!(
        before
            .identities()
            .iter()
            .any(|identity| identity.contains("action:composer-context")),
        "context trigger present before the edit"
    );

    // Edit the document: drop the context trigger from the composer toolbar.
    let mut doc: serde_json::Value = serde_json::from_str(fixture).expect("fixture parses");
    let root = doc
        .get_mut("root")
        .and_then(|root| root.get_mut("children"))
        .and_then(|children| children.as_array_mut())
        .expect("root children");
    let composer = root
        .iter_mut()
        .find(|node| node["nodeId"] == "chat-composer")
        .expect("composer node");
    let toolbar = composer
        .get_mut("children")
        .and_then(|children| children.as_array_mut())
        .expect("composer children")
        .iter_mut()
        .find(|node| node["nodeId"] == "composer-toolbar")
        .expect("toolbar node");
    toolbar
        .get_mut("children")
        .and_then(|children| children.as_array_mut())
        .expect("toolbar children")
        .retain(|node| node["nodeId"] != "composer-context");

    // Write until the mtime actually moves past the cached stamp.
    let previous = std::fs::metadata(&path).expect("meta").modified().unwrap();
    loop {
        std::fs::write(&path, serde_json::to_string_pretty(&doc).expect("json")).expect("rewrite");
        if std::fs::metadata(&path).expect("meta").modified().unwrap() != previous {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let after = mount();
    set_chat_blueprint_source(ChatBlueprintSource::Disabled);
    assert!(
        !after
            .identities()
            .iter()
            .any(|identity| identity.contains("action:composer-context")),
        "context trigger gone after the edit"
    );
    let _ = std::fs::remove_file(&path);
}

/// `chats.snapshots.rollback` (React builtin "Rollback to here"): the wire
/// store removes everything AFTER the target message; the target stays and
/// becomes the visible tail. A foreign id surfaces MESSAGE_NOT_FOUND.
#[test]
fn rollback_removes_the_suffix_and_keeps_the_target() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    assert_eq!(session.kernel_message_count(), 6);

    // `visible` is the viewport window (the newest few rows), so the oldest
    // visible row is a mid-chat target whose suffix actually exists.
    let target = session.view().visible[0].id.clone();
    session.rollback_to_message(&target);
    assert_eq!(
        session.kernel_message_count(),
        4,
        "error={:?} status={:?}",
        session.view().error_code,
        session.shell_view().status_message
    );
    let visible = session.view().visible;
    assert_eq!(
        visible.last().expect("tail row").id,
        target,
        "target must stay and become the newest row"
    );

    // Unknown target: honest wire error, no silent success.
    session.rollback_to_message("00000000-0000-4000-8000-000000000009");
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("MESSAGE_NOT_FOUND")
    );
}

/// Version-controls "Regenerate": retries the tapped row's OWN source run
/// (`generation.retry{sourceRunId}`), not just the latest one. A row without
/// a stored run surfaces GENERATION_RUN_NOT_FOUND.
#[test]
fn regenerate_retries_the_row_source_run() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    assert_eq!(session.kernel_message_count(), 6);

    let tail = session.view().visible.last().expect("tail").id.clone();
    session.regenerate_message(&tail);
    // FakeWire streams drain synchronously inside `start_stream_op`, so the
    // retried response is already durable here.
    assert_eq!(
        session.kernel_message_count(),
        7,
        "error={:?}",
        session.view().error_code
    );
    let view = session.view();
    let last = view.visible.last().expect("tail row");
    assert!(
        last.content.starts_with("retry of"),
        "unexpected content: {}",
        last.content
    );

    // User rows carry no source run: honest error instead of a blind retry.
    session.regenerate_message("00000000-0000-4000-8000-000000002000");
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("GENERATION_RUN_NOT_FOUND")
    );
}

/// Swipe pager (`MessageSwipePager`): `variants.list` + `variants.activate`
/// swap the tail assistant response content in place; edges stop honestly.
#[test]
fn swipes_cycle_variants_and_stop_at_edges() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    assert_eq!(session.kernel_message_count(), 6);
    // The seeded tail assistant row carries three variants (position 0 keeps
    // the original content).
    let tail = session.view().visible.last().expect("tail").id.clone();
    let original = session.view().visible.last().expect("tail").content.clone();

    session.swipe_variant(&tail, 1);
    let view = session.view();
    assert!(
        view.visible
            .last()
            .expect("tail")
            .content
            .starts_with("*variant A*"),
        "swipe next must show variant A"
    );
    assert_eq!(view.error_code, None);

    session.swipe_variant(&tail, 1);
    assert!(
        session
            .view()
            .visible
            .last()
            .expect("tail")
            .content
            .starts_with("*variant B*"),
        "second swipe must show variant B"
    );

    // Edge: B is the last variant; another next stops with a status hint.
    session.swipe_variant(&tail, 1);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("No more variants.")
    );
    assert!(
        session
            .view()
            .visible
            .last()
            .expect("tail")
            .content
            .starts_with("*variant B*"),
        "edge swipe must not change the content"
    );

    session.swipe_variant(&tail, -1);
    assert!(
        session
            .view()
            .visible
            .last()
            .expect("tail")
            .content
            .starts_with("*variant A*"),
        "previous must walk back to variant A"
    );

    // Variants swap content in place: the message count never moves.
    assert_eq!(session.kernel_message_count(), 6);

    // A message without variants reports honestly and stays untouched.
    let head = session.view().visible[0].id.clone();
    session.swipe_variant(&head, 1);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("No other variants."),
    );
    drop(original);
}

#[test]
fn custom_intents_surface_an_honest_trace_toast() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(3),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.custom_intent("custom.demo.pin-chat");
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("[custom] custom.demo.pin-chat — no handler attached.")
    );
}
