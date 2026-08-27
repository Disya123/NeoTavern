//! Host compositor bind: Dioxus+Blitz once, then compositor-only ticks.

use contracts_generated::generated::MessageRole;
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
            run_id: None,
            manual_excluded: false,
            checkpoint_chat_id: None,
        }],
        chrome: ProductChrome::HeaderComposer,
        character_avatar_asset: "asset:avatar-hazel".into(),
        character_name: "Hazel".into(),
        composer_text: String::new(),
        composer_placeholder: String::new(),
        error_code: None,
        streaming: false,
        tool_activity_name: None,
        viewport_width: 1100,
        viewport_height: 760,
        column_width: 0,
        context_panel_open: false,
        context_summary: None,
        editing_message_id: None,
        editing_draft: String::new(),
        history_open_for: None,
        revision_history: Vec::new(),
        snapshots_menu_open: false,
        snapshot_items: Vec::new(),
        header_search_open: false,
        header_search_query: String::new(),
        header_search_match_count: 0,
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
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.action.as_deref() == Some("header-search")),
        "header search control must be hittable"
    );
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.action.as_deref() == Some("context") && rect.key.is_some()),
        "context button must carry its message id"
    );
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.action.as_deref() == Some("prompt") && rect.key.is_some()),
        "prompt button must carry its message id"
    );
    assert!(
        rects
            .rects
            .iter()
            .any(|rect| rect.action.as_deref() == Some("steps") && rect.key.is_some()),
        "steps button must carry its message id"
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
fn lorebook_entries_load_toggle_and_crud_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("lorebooks".into()));
    session.apply_shell_action(ShellAction::SelectLorebook(
        neotavern_presentation_chat::DEMO_LOREBOOK_ID.into(),
    ));
    session.apply_shell_action(ShellAction::SetTab("entries".into()));
    let shell = session.shell_view();
    assert_eq!(shell.lorebook_tab, "entries");
    assert_eq!(
        shell.lorebook_entries.len(),
        2,
        "demo book lists its entries"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.entries.list"));
    let first_id = shell.lorebook_entries[0].id.clone();
    assert!(shell.lorebook_entries.iter().all(|row| row.enabled));

    // Row switch toggles `enabled` through `lorebooks.entries.update`.
    session.apply_shell_action(ShellAction::ToggleLorebookEntry(first_id.clone()));
    let shell = session.shell_view();
    let first = shell
        .lorebook_entries
        .iter()
        .find(|row| row.id == first_id)
        .expect("toggled row");
    assert!(!first.enabled, "row switch flips the enabled flag");
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.entries.update"));

    // Create: EntryDialog -> drafts -> SaveEntry -> `entries.create`.
    session.apply_shell_action(ShellAction::OpenEntryDialog);
    session.set_entry_keys_draft("Sunken Road");
    session.set_entry_secondary_keys_draft("pass\nford");
    session
        .set_entry_content_draft("The Sunken Road runs under the ridge; bells warn of the tide.");
    assert!(
        session.shell_view().entry_content_tokens > 0,
        "dialog token label uses the script-aware estimate"
    );
    session.apply_shell_action(ShellAction::EntryToggleConstant);
    session.apply_shell_action(ShellAction::SaveEntry);
    let shell = session.shell_view();
    assert!(!shell.entry_dialog_open, "save closes the dialog");
    let created = shell
        .lorebook_entries
        .iter()
        .find(|row| row.keys.as_slice() == ["Sunken Road"])
        .expect("created entry");
    assert!(created.enabled && created.constant && !created.selective);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.entries.create"));

    // Edit: dialog pre-fills the row values; SaveEntry updates the entry.
    session.apply_shell_action(ShellAction::EditLorebookEntry(created.id.clone()));
    let shell = session.shell_view();
    assert_eq!(shell.entry_keys_draft, "Sunken Road");
    assert_eq!(shell.entry_secondary_keys_draft, "pass\nford");
    assert_eq!(shell.entry_constant_draft, true);
    session.set_entry_content_draft("Rewritten: the ford bells warn before the tide turns.");
    session.apply_shell_action(ShellAction::SaveEntry);
    let shell = session.shell_view();
    let edited = shell
        .lorebook_entries
        .iter()
        .find(|row| row.id == created.id)
        .expect("edited entry");
    assert!(edited.content.starts_with("Rewritten"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.entries.update"));

    // Delete: confirm dialog -> `entries.delete`; the book count drops.
    session.apply_shell_action(ShellAction::OpenEntryDelete(created.id.clone()));
    assert!(session.shell_view().entry_delete_open);
    session.apply_shell_action(ShellAction::ConfirmEntryDelete);
    let shell = session.shell_view();
    assert!(!shell.entry_delete_open);
    assert!(
        shell
            .lorebook_entries
            .iter()
            .all(|row| row.id != created.id),
        "confirm delete removes the entry"
    );
    let book = shell
        .lorebooks
        .iter()
        .find(|row| row.id == neotavern_presentation_chat::DEMO_LOREBOOK_ID)
        .expect("demo book");
    assert_eq!(book.entry_count, 2, "book count follows the entries");
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.entries.delete"));
}

#[test]
fn profiles_load_create_rename_export_delete_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("profiles".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "profiles");
    assert!(
        shell.profiles.iter().any(|row| row.name == "Main"),
        "demo profiles list through profiles.list"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profiles.list"));

    // Create: inline row -> `profiles.create`; the draft clears.
    session.set_profile_create_name("Longhaul");
    session.apply_shell_action(ShellAction::CreateProfile);
    let shell = session.shell_view();
    assert_eq!(shell.profile_create_name, "");
    assert!(shell.profiles.iter().any(|row| row.name == "Longhaul"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profiles.create"));

    // Rename: inline row pre-fills the name; submit -> `profiles.rename`.
    let id = shell
        .profiles
        .iter()
        .find(|row| row.name == "Longhaul")
        .expect("created profile")
        .id
        .clone();
    session.apply_shell_action(ShellAction::StartProfileRename(id.clone()));
    let shell = session.shell_view();
    assert_eq!(shell.profile_renaming_id.as_deref(), Some(id.as_str()));
    assert_eq!(shell.profile_rename_name, "Longhaul");
    session.set_profile_rename_name("Longhaul II");
    session.apply_shell_action(ShellAction::SubmitProfileRename);
    let shell = session.shell_view();
    assert_eq!(shell.profile_renaming_id, None);
    assert!(shell.profiles.iter().any(|row| row.name == "Longhaul II"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profiles.rename"));

    // Export: `profile.export` reports the scoped record counts in a toast.
    session.apply_shell_action(ShellAction::ExportProfile(id.clone()));
    let toast = session.shell_view().status_message;
    assert!(
        toast.as_deref().unwrap_or("").starts_with("Exported"),
        "export surfaces the honest counts: {toast:?}"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profile.export"));

    // Delete: confirm dialog -> `profiles.delete`.
    session.apply_shell_action(ShellAction::OpenProfileDelete(id.clone()));
    assert!(session.shell_view().profile_delete_open);
    session.apply_shell_action(ShellAction::ConfirmProfileDelete);
    let shell = session.shell_view();
    assert!(!shell.profile_delete_open);
    assert!(
        shell.profiles.iter().all(|row| row.id != id),
        "confirm delete removes the profile"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profiles.delete"));
}

#[test]
fn plugins_toggle_and_uninstall_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("plugins".into()));
    let shell = session.shell_view();
    assert!(
        shell
            .plugins
            .iter()
            .any(|row| row.id == "tavern-speed-dial"),
        "demo plugins list through plugins.list"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "plugins.list"));

    // Toggle: disabled plugin -> plugins.enable -> plugins.disable.
    let disabled_id = "lore-almanac".to_string();
    assert!(
        !shell
            .plugins
            .iter()
            .find(|row| row.id == disabled_id)
            .expect("demo plugin")
            .enabled
    );
    session.apply_shell_action(ShellAction::TogglePlugin(disabled_id.clone()));
    let shell = session.shell_view();
    assert!(
        shell
            .plugins
            .iter()
            .find(|row| row.id == disabled_id)
            .expect("toggled plugin")
            .enabled,
        "toggle enables the plugin"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "plugins.enable"));
    session.apply_shell_action(ShellAction::TogglePlugin(disabled_id.clone()));
    let shell = session.shell_view();
    assert!(
        !shell
            .plugins
            .iter()
            .find(|row| row.id == disabled_id)
            .expect("toggled plugin")
            .enabled,
        "second toggle disables the plugin"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "plugins.disable"));

    // Uninstall: confirm dialog -> plugins.uninstall removes the row.
    session.apply_shell_action(ShellAction::OpenPluginUninstall(disabled_id.clone()));
    assert!(session.shell_view().plugin_uninstall_open);
    session.apply_shell_action(ShellAction::ConfirmPluginUninstall);
    let shell = session.shell_view();
    assert!(!shell.plugin_uninstall_open);
    assert!(
        shell.plugins.iter().all(|row| row.id != disabled_id),
        "confirm uninstall removes the plugin"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "plugins.uninstall"));
    assert!(
        session
            .shell_view()
            .status_message
            .as_deref()
            .unwrap_or("")
            .contains("uninstalled"),
        "uninstall surfaces a toast"
    );
}

#[test]
fn chats_rename_and_delete_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::with_message_count(12), None, None)
            .expect("route");
    session.apply_shell_action(ShellAction::SetPanel("home".into()));
    let shell = session.shell_view();
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "chats.list"),
        "home panel lists chats"
    );
    let first_id = shell.chat_list[0].id.clone();
    let first_title = shell.chat_list[0].title.clone();

    // Rename: dialog pre-fills the title; submit -> `chats.update`.
    session.apply_shell_action(ShellAction::StartChatRename(first_id.clone()));
    let shell = session.shell_view();
    assert!(shell.chat_rename_open);
    assert_eq!(shell.chat_rename_draft, first_title);
    session.set_chat_rename_draft("Renamed route");
    session.apply_shell_action(ShellAction::SubmitChatRename);
    let shell = session.shell_view();
    assert!(!shell.chat_rename_open);
    assert!(
        shell
            .chat_list
            .iter()
            .any(|row| row.id == first_id && row.title == "Renamed route"),
        "rename updates the row title"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.update"));

    // Delete: confirm dialog -> `chats.delete`; the row is gone.
    session.apply_shell_action(ShellAction::OpenChatDelete(first_id.clone()));
    assert!(session.shell_view().chat_delete_open);
    session.apply_shell_action(ShellAction::ConfirmChatDelete);
    let shell = session.shell_view();
    assert!(!shell.chat_delete_open);
    assert!(
        shell.chat_list.iter().all(|row| row.id != first_id),
        "confirm delete removes the chat row"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.delete"));
    assert!(
        session
            .shell_view()
            .status_message
            .as_deref()
            .unwrap_or("")
            .contains("deleted"),
        "delete surfaces a toast"
    );
}

#[test]
fn prompt_plan_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session
        .set_composer_text("Hello from the prompt plan test")
        .expect("composer");
    session.send(None).expect("send");
    session.drain_stream().expect("drain");
    let run_id = session
        .shell_view()
        .chat
        .visible
        .iter()
        .rev()
        .find_map(|row| row.run_id.clone())
        .expect("generated row carries a run id");

    // Trigger: the React footer action only exists for rows with a run id,
    // so the visible row exposes `run_id`; opening the dialog issues
    // `generation.prompt.plan` and renders the durable plan.
    session.apply_shell_action(ShellAction::OpenPromptPlan(run_id.clone()));
    let shell = session.shell_view();
    assert!(shell.prompt_plan_open);
    assert_eq!(shell.prompt_plan_run_id.as_deref(), Some(run_id.as_str()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "generation.prompt.plan"));
    let plan = shell.prompt_plan.as_ref().expect("plan loaded");
    assert_eq!(plan.model, "demo-model");
    assert_eq!(plan.run_id, run_id);
    assert!(plan.system_blocks.iter().any(|b| b.source == "character"));
    assert!(plan
        .messages
        .iter()
        .any(|m| m.role == MessageRole::Assistant));
    assert!(plan.messages.iter().any(|m| m.role == MessageRole::User));
    assert!(
        !plan.excluded.is_empty(),
        "the oldest seeded message is dropped by the token budget"
    );
    assert!(plan
        .excluded
        .iter()
        .all(|item| item.reason == "token_budget"));

    // Close resets the dialog state.
    session.apply_shell_action(ShellAction::ClosePromptPlan);
    let shell = session.shell_view();
    assert!(!shell.prompt_plan_open);
    assert!(shell.prompt_plan.is_none());

    // Unknown run → honest empty state ("This run has no recorded prompt
    // plan."), mirroring React mapping `PROMPT_PLAN_NOT_FOUND` to null.
    session.apply_shell_action(ShellAction::OpenPromptPlan(
        "00000000-0000-4000-8000-000000000000".into(),
    ));
    let shell = session.shell_view();
    assert!(shell.prompt_plan_open);
    assert!(shell.prompt_plan.is_none());
    assert!(shell.prompt_plan_not_found);
}

#[test]
fn tap_prompt_on_row_opens_prompt_plan() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session
        .set_composer_text("Hello from the prompt tap test")
        .expect("composer");
    session.send(None).expect("send");
    session.drain_stream().expect("drain");
    let row_id = session
        .shell_view()
        .chat
        .visible
        .iter()
        .rev()
        .find(|row| row.run_id.is_some())
        .map(|row| row.id.clone())
        .expect("generated row");
    session.open_prompt_plan_for_message(&row_id);
    let shell = session.shell_view();
    assert!(shell.prompt_plan_open);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "generation.prompt.plan"));
    session.apply_shell_action(ShellAction::ClosePromptPlan);
    assert!(!session.shell_view().prompt_plan_open);
}

#[test]
fn toggle_message_context_flips_manual_excluded() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let row_id = session
        .view()
        .visible
        .iter()
        .find(|row| row.id != "streaming")
        .map(|row| row.id.clone())
        .expect("a durable row");
    assert!(
        !session
            .view()
            .visible
            .iter()
            .find(|row| row.id == row_id)
            .expect("row")
            .manual_excluded
    );
    session.toggle_message_context(&row_id);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.messages.update"));
    let excluded = session
        .view()
        .visible
        .iter()
        .find(|r| r.id == row_id)
        .expect("row after exclude")
        .manual_excluded;
    assert!(excluded, "first toggle excludes the row");
    assert!(session
        .shell_view()
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains("Excluded"));
    session.toggle_message_context(&row_id);
    let included = session
        .view()
        .visible
        .iter()
        .find(|r| r.id == row_id)
        .expect("row after include")
        .manual_excluded;
    assert!(!included, "second toggle includes the row");
    session.toggle_message_context("00000000-0000-4000-8000-000000000009");
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("MESSAGE_NOT_FOUND")
    );
}

#[test]
fn delete_checkpoint_clears_the_snapshot_link() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let row_id = session
        .view()
        .visible
        .iter()
        .find(|row| row.id != "streaming")
        .map(|row| row.id.clone())
        .expect("a durable row");
    session.create_message_snapshot(&row_id, true);
    let linked = session
        .view()
        .visible
        .iter()
        .find(|row| row.id == row_id)
        .and_then(|row| row.checkpoint_chat_id.clone());
    assert!(linked.is_some(), "checkpoint links the source message");
    session.apply_shell_action(ShellAction::OpenCheckpointDelete(row_id.clone()));
    assert!(session.shell_view().checkpoint_delete_open);
    session.apply_shell_action(ShellAction::ConfirmCheckpointDelete);
    let cleared = session
        .view()
        .visible
        .iter()
        .find(|r| r.id == row_id)
        .and_then(|r| r.checkpoint_chat_id.clone());
    assert!(cleared.is_none());
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.messages.update"));
}

#[test]
fn run_transcript_lists_generation_steps_without_tool_payloads() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session
        .set_composer_text("Hello from the transcript test")
        .expect("composer");
    session.send(None).expect("send");
    session.drain_stream().expect("drain");
    let row = session
        .shell_view()
        .chat
        .visible
        .iter()
        .rev()
        .find(|row| row.run_id.is_some())
        .cloned()
        .expect("generated row");
    session.open_run_transcript_for_message(&row.id);
    let shell = session.shell_view();
    assert!(shell.run_transcript_open);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "generation.events"));
    assert!(
        shell.run_transcript_steps.len() >= 2,
        "provider_turn + final_commit"
    );
    assert!(shell
        .run_transcript_steps
        .iter()
        .any(|step| step.step_type == "provider_turn"));
    assert!(shell
        .run_transcript_steps
        .iter()
        .any(|step| step.step_type == "final_commit"));
    assert!(shell.prompt_plan_open == false);
    session.apply_shell_action(ShellAction::CloseRunTranscript);
    assert!(!session.shell_view().run_transcript_open);

    session.apply_shell_action(ShellAction::OpenRunTranscript(
        "00000000-0000-4000-8000-000000000000".into(),
    ));
    let shell = session.shell_view();
    assert!(shell.run_transcript_open);
    assert_eq!(
        shell.run_transcript_error.as_deref(),
        Some("GENERATION_RUN_NOT_FOUND")
    );
}

#[test]
fn duplicate_character_creates_a_named_copy() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.select_character(neotavern_presentation_chat::DEMO_CHARACTER_ID);
    let before = session.shell_view().characters.len();
    session.apply_shell_action(ShellAction::DuplicateCharacter);
    let shell = session.shell_view();
    assert_eq!(shell.characters.len(), before + 1);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "characters.create"));
    let selected = shell.selected_character_id.clone().expect("selected copy");
    let copy = shell
        .characters
        .iter()
        .find(|card| card.id == selected)
        .expect("copy card");
    assert_eq!(copy.name, "Hazel copy");
    assert_eq!(shell.tab, "edit");
}

#[test]
fn character_editor_name_description_tags_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.select_character(neotavern_presentation_chat::DEMO_CHARACTER_ID);
    session.apply_shell_action(ShellAction::SetTab("edit".into()));
    let draft = session
        .shell_view()
        .selected_draft
        .clone()
        .expect("hazel draft");
    assert_eq!(draft.name, "Hazel");
    assert!(draft.tags.iter().any(|tag| tag == "sharp"));
    assert_eq!(draft.tags.len(), 5);

    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "characters.update")
        .count();
    session.set_tag_input("oc");
    session.apply_shell_action(ShellAction::AddCharacterTag);
    let after_add = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "characters.update")
        .count();
    assert!(after_add > before, "add tag persists tags");
    let draft = session
        .shell_view()
        .selected_draft
        .clone()
        .expect("draft after add");
    assert!(draft.tags.iter().any(|tag| tag == "oc"));
    assert!(session.shell_view().tag_input.is_empty());

    session.set_tag_input("");
    session.apply_shell_action(ShellAction::AddCharacterTag);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "characters.update")
            .count(),
        after_add,
        "empty tag is a no-op"
    );

    session.set_tag_input("SHARP");
    session.apply_shell_action(ShellAction::AddCharacterTag);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "characters.update")
            .count(),
        after_add,
        "duplicate tags are case-insensitive no-ops"
    );

    session.apply_shell_action(ShellAction::RemoveCharacterTag("oc".into()));
    let draft = session
        .shell_view()
        .selected_draft
        .clone()
        .expect("draft after remove");
    assert!(!draft.tags.iter().any(|tag| tag == "oc"));
    session.apply_shell_action(ShellAction::RemoveCharacterTag("no-such-tag".into()));

    session.set_character_name_draft("Hazel Wren");
    session.set_character_description_draft("A tinkerer with a stubborn streak.");
    session.apply_shell_action(ShellAction::CharacterSaveMeta);
    let shell = session.shell_view();
    let card = shell
        .characters
        .iter()
        .find(|item| item.id == neotavern_presentation_chat::DEMO_CHARACTER_ID)
        .expect("card");
    assert_eq!(card.name, "Hazel Wren");
    assert_eq!(card.description, "A tinkerer with a stubborn streak.");
    assert_eq!(shell.status_message.as_deref(), Some("Saved Hazel Wren."));

    let updates = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "characters.update")
        .count();
    session.apply_shell_action(ShellAction::CharacterSaveMeta);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "characters.update")
            .count(),
        updates,
        "no-op save skips the wire"
    );
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("No changes.")
    );

    session.set_character_name_draft("");
    session.apply_shell_action(ShellAction::CharacterSaveMeta);
    let shell = session.shell_view();
    let card = shell
        .characters
        .iter()
        .find(|item| item.id == neotavern_presentation_chat::DEMO_CHARACTER_ID)
        .expect("card");
    assert_eq!(card.name, "Hazel Wren", "empty name keeps the stored one");

    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("character-name-input"),
        "missing character-name-input; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("character-save"),
        "missing character-save; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("character-tag-input"),
        "missing character-tag-input; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("character-tag-add"),
        "missing character-tag-add; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn header_search_counts_matches_without_filtering_rows() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let before = session.view().visible.len();
    session.toggle_header_search();
    assert!(session.view().header_search_open);
    session.set_header_search_query("Hello");
    let view = session.view();
    assert!(view.header_search_match_count > 0);
    assert_eq!(
        view.visible.len(),
        before,
        "search highlights, it does not filter"
    );
    session.toggle_header_search();
    assert!(!session.view().header_search_open);
    assert_eq!(session.view().header_search_match_count, 0);
}

#[test]
fn character_gallery_is_honest_empty_or_primary_and_upload_reports_capability_unavailable() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.select_character(neotavern_presentation_chat::DEMO_CHARACTER_ID);
    session.apply_shell_action(ShellAction::SetTab("gallery".into()));
    let shell = session.shell_view();
    assert_eq!(shell.tab, "gallery");
    assert_eq!(shell.gallery_columns, 3);
    assert_eq!(shell.gallery_sort, "oldest");
    assert!(
        shell
            .selected_draft
            .as_ref()
            .and_then(|draft| draft.avatar_asset_id.as_deref())
            == Some(DEMO_AVATAR_ASSET_ID),
        "Hazel keeps the avatar as the primary gallery figure"
    );
    assert!(
        !session
            .issued_commands()
            .iter()
            .any(|op| op.starts_with("characters.gallery")),
        "no characters.gallery wire op exists"
    );

    session.apply_shell_action(ShellAction::CycleGalleryColumns);
    assert_eq!(session.shell_view().gallery_columns, 4);
    session.apply_shell_action(ShellAction::CycleGallerySort);
    assert_eq!(session.shell_view().gallery_sort, "newest");

    session.set_surface_size(800, 904, 1.0);
    let shell = session.shell_view();
    match hit_test(&shell, 380.0, 140.0) {
        Some(ShellHit::Action(ShellAction::UploadGalleryImage)) => {}
        other => panic!("expected UploadGalleryImage on gallery Add, got {other:?}"),
    }

    session.apply_shell_action(ShellAction::UploadGalleryImage);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );

    session.apply_shell_action(ShellAction::OpenCreate);
    session.set_create_name("Ada");
    session.apply_shell_action(ShellAction::ConfirmCreate);
    session.apply_shell_action(ShellAction::SetTab("gallery".into()));
    let shell = session.shell_view();
    assert!(
        shell
            .selected_draft
            .as_ref()
            .and_then(|draft| draft.avatar_asset_id.as_ref())
            .is_none(),
        "a character without an avatar shows the honest empty gallery"
    );
}

#[test]
fn slash_command_not_found_does_not_send_over_the_wire() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.send(Some("/foo")).expect("send");
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("SLASH_COMMAND_NOT_FOUND")
    );
    assert_eq!(session.view().composer_text, "/foo");
    assert!(
        !session
            .issued_commands()
            .iter()
            .any(|op| op == "chats.messages.create" || op == "generation.start"),
        "slash not-found must not create a message or start generation"
    );
    assert!(!session.send_accepted());
}

#[test]
fn general_settings_language_and_appearance_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "general");
    assert_eq!(shell.language, "en");
    assert_eq!(shell.font_scale, "medium");
    assert_eq!(shell.ui_contrast, "normal");
    assert!(shell.open_home_on_load);

    session.apply_shell_action(ShellAction::CycleLanguage);
    let shell = session.shell_view();
    assert_eq!(shell.language, "ru");
    assert_eq!(shell.dir, "ltr");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "settings.update"),
        "language persists through settings.update"
    );

    session.apply_shell_action(ShellAction::CycleUiScale);
    session.apply_shell_action(ShellAction::CycleContrast);
    session.apply_shell_action(ShellAction::CycleFontProfile);
    session.apply_shell_action(ShellAction::CycleMotion);
    session.apply_shell_action(ShellAction::ToggleOpenHomeOnLoad);
    session.apply_shell_action(ShellAction::CycleChatStyle);
    session.apply_shell_action(ShellAction::CycleUserMessagePosition);
    session.apply_shell_action(ShellAction::CycleUiOpacity);
    session.apply_shell_action(ShellAction::CycleUiGlassBlur);
    let shell = session.shell_view();
    assert_eq!(shell.font_scale, "large");
    assert_eq!(shell.ui_contrast, "high");
    assert_eq!(shell.ui_font_profile, "dyslexia");
    assert_eq!(shell.ui_motion, "reduced");
    assert!(!shell.open_home_on_load);
    assert_eq!(shell.chat_style, "classic");
    assert_eq!(shell.user_message_position, "left");
    assert_eq!(shell.ui_opacity, 75);
    assert_eq!(shell.ui_glass_blur, 20);
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "diagnostics.export"),
        "opening General loads diagnostics.export"
    );
    let bundle = shell.diagnostics.expect("kernel diagnostics bundle");
    assert_eq!(bundle.redaction, "allowlist");
    assert_eq!(bundle.app_version, "0.1.0");
    assert_eq!(bundle.generation_runs.total, 1);

    session.apply_shell_action(ShellAction::RebuildSearch);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert!(!session
        .issued_commands()
        .iter()
        .any(|op| op == "search.rebuild"));
}

#[test]
fn chat_template_editor_native_custom_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    let shell = session.shell_view();
    assert_eq!(shell.ai_tab, "advanced");
    assert_eq!(shell.prompt_template_mode, "chat");
    assert_eq!(shell.instruct_selection, "native");
    assert!(
        !session
            .issued_commands()
            .iter()
            .any(|op| op.contains("instruct-format")),
        "no instruct-formats catalog wire op exists on the kernel plane"
    );

    session.apply_shell_action(ShellAction::CycleInstructSelection);
    assert_eq!(session.shell_view().instruct_selection, "custom");
    let before_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::SaveInstructTemplate);
    let after_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after_save > before_save, "save writes instruct-format");
    assert_eq!(session.shell_view().instruct_selection, "custom");

    session.apply_shell_action(ShellAction::CycleInstructSelection);
    assert_eq!(session.shell_view().instruct_selection, "native");

    session.apply_shell_action(ShellAction::CyclePromptMode);
    assert_eq!(session.shell_view().prompt_template_mode, "text");
}

#[test]
fn custom_instruct_fields_edit_and_save_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CycleInstructSelection);
    let shell = session.shell_view();
    assert_eq!(shell.instruct_selection, "custom");
    assert!(
        shell.instruct_system.contains("{{{content}}}"),
        "custom seeds the ChatML system template"
    );
    assert_eq!(shell.instruct_stop_strings, "<|im_end|>");

    session.set_instruct_role("system", "<SYS>{{{content}}}</SYS>\n");
    session.set_instruct_role("stopStrings", "<STOP>\n<END>");
    assert_eq!(
        session.shell_view().instruct_system,
        "<SYS>{{{content}}}</SYS>\n"
    );
    assert_eq!(session.shell_view().instruct_stop_strings, "<STOP>\n<END>");
    session.set_instruct_role("unknown", "nope");
    assert_eq!(
        session.shell_view().instruct_system,
        "<SYS>{{{content}}}</SYS>\n",
        "unknown role keys are ignored"
    );

    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::SaveInstructTemplate);
    let after = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after > before, "save writes the edited instruct-format");
    let shell = session.shell_view();
    assert_eq!(shell.instruct_system, "<SYS>{{{content}}}</SYS>\n");
    assert_eq!(shell.instruct_stop_strings, "<STOP>\n<END>");
    assert!(shell.instruct_user.contains("<|im_start|>user"));
}

#[test]
fn prompt_template_blocks_toggle_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    assert!(
        session.shell_view().prompt_blocks.is_empty(),
        "chat mode starts without a hydrated block list"
    );

    session.apply_shell_action(ShellAction::CyclePromptMode);
    let shell = session.shell_view();
    assert_eq!(shell.prompt_template_mode, "text");
    assert_eq!(shell.prompt_blocks.len(), 12);
    assert_eq!(shell.prompt_blocks[0].id, "main-prompt");
    assert_eq!(shell.prompt_blocks[0].name, "Main Prompt");
    assert!(shell.prompt_blocks.iter().all(|block| block.enabled));
    assert_eq!(
        shell.prompt_blocks.last().map(|block| block.id.as_str()),
        Some("post-history-instructions")
    );
    let memory = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "memory")
        .expect("memory block");
    assert_eq!(memory.name, "Memory");
    assert!(!memory.custom);

    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::TogglePromptBlock("memory".into()));
    let after = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after > before, "toggle persists prompt-template");
    let shell = session.shell_view();
    let memory = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "memory")
        .expect("memory block");
    assert!(!memory.enabled);

    session.apply_shell_action(ShellAction::TogglePromptBlock("no-such-block".into()));
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        after,
        "unknown block ids are a no-op"
    );

    session.apply_shell_action(ShellAction::SetTab("memories".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    let shell = session.shell_view();
    let memory = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "memory")
        .expect("hydrated memory block");
    assert!(
        !memory.enabled,
        "settings.get round-trip keeps the disabled flag"
    );

    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-template-editor"),
        "missing prompt-template-editor; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-list"),
        "missing prompt-block-list; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block"),
        "missing prompt-block; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_presets_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    let shell = session.shell_view();
    assert_eq!(shell.prompt_template_mode, "text");
    assert_eq!(shell.prompt_presets.len(), 1);
    assert_eq!(shell.prompt_presets[0].name, "Roleplay");
    assert!(shell.active_prompt_preset_id.is_none());
    assert_eq!(shell.prompt_preset_active_name, None);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "presets.list")
            .count()
            >= 2,
        "generation list on panel open plus prompt-template list on Advanced"
    );

    session.apply_shell_action(ShellAction::CyclePromptPreset);
    let shell = session.shell_view();
    assert_eq!(shell.prompt_preset_active_name.as_deref(), Some("Roleplay"));
    assert_eq!(shell.prompt_blocks.len(), 12);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| *op == "settings.update"));

    session.apply_shell_action(ShellAction::TogglePromptBlock("memory".into()));
    let before_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "presets.update")
        .count();
    session.apply_shell_action(ShellAction::PromptPresetSave);
    let after_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "presets.update")
        .count();
    assert!(
        after_save > before_save,
        "Save writes the active preset data"
    );
    let shell = session.shell_view();
    let memory = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "memory")
        .expect("memory");
    assert!(!memory.enabled);

    session.apply_shell_action(ShellAction::PromptPresetDuplicate);
    assert!(session.shell_view().preset_name_dialog_open);
    assert_eq!(session.shell_view().preset_name_draft, "Roleplay copy");
    session.apply_shell_action(ShellAction::PresetNameSubmit);
    let shell = session.shell_view();
    assert!(!shell.preset_name_dialog_open);
    assert_eq!(shell.prompt_presets.len(), 2);
    assert_eq!(
        shell.prompt_preset_active_name.as_deref(),
        Some("Roleplay copy")
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| *op == "presets.create"));

    session.apply_shell_action(ShellAction::PromptPresetRename);
    session.set_preset_name_draft("Story");
    session.apply_shell_action(ShellAction::PresetNameSubmit);
    assert_eq!(
        session.shell_view().prompt_preset_active_name.as_deref(),
        Some("Story")
    );

    session.apply_shell_action(ShellAction::PromptPresetDelete);
    assert!(session.shell_view().preset_delete_open);
    session.apply_shell_action(ShellAction::PresetDeleteConfirm);
    let shell = session.shell_view();
    assert!(!shell.preset_delete_open);
    assert!(shell.active_prompt_preset_id.is_none());
    assert_eq!(shell.prompt_presets.len(), 1);
    assert_eq!(shell.prompt_presets[0].name, "Roleplay");

    session.apply_shell_action(ShellAction::PromptPresetSave);
    assert!(session.shell_view().preset_name_dialog_open);
    session.set_preset_name_draft("Custom");
    session.apply_shell_action(ShellAction::PresetNameSubmit);
    assert_eq!(
        session.shell_view().prompt_preset_active_name.as_deref(),
        Some("Custom")
    );
    assert_eq!(session.shell_view().prompt_presets.len(), 2);

    session.apply_shell_action(ShellAction::CycleMotion);
    assert_eq!(session.shell_view().ui_motion, "reduced");

    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-preset-cycle"),
        "missing prompt-preset-cycle; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-preset-actions"),
        "missing prompt-preset-actions; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_custom_blocks_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    assert_eq!(session.shell_view().prompt_blocks.len(), 12);

    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::AddPromptBlock);
    let after_add = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after_add > before, "add persists prompt-template");
    let shell = session.shell_view();
    assert_eq!(shell.prompt_blocks.len(), 13);
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("custom-1");
    assert!(custom.custom);
    assert!(custom.enabled);
    assert_eq!(custom.name, "New Prompt");
    assert_eq!(
        shell
            .prompt_blocks
            .iter()
            .position(|block| block.id == "custom-1"),
        Some(10),
        "custom block sits before the terminal anchors"
    );
    assert_eq!(
        shell.prompt_blocks[11].id, "chat-history",
        "chat-history stays penultimate"
    );
    assert_eq!(shell.prompt_blocks[12].id, "post-history-instructions");
    assert!(shell.prompt_block_edit_open);
    assert_eq!(shell.prompt_block_name_draft, "New Prompt");
    assert!(shell.prompt_block_content_editable);

    session.set_prompt_block_name_draft("Greeting");
    session.set_prompt_block_content_draft("Hello {{user}}.");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    let shell = session.shell_view();
    assert!(!shell.prompt_block_edit_open);
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("saved custom-1");
    assert_eq!(custom.name, "Greeting");

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert_eq!(
        session.shell_view().prompt_block_content_draft,
        "Hello {{user}}."
    );
    session.apply_shell_action(ShellAction::PromptBlockEditCancel);
    assert!(!session.shell_view().prompt_block_edit_open);

    session.apply_shell_action(ShellAction::EditPromptBlock("main-prompt".into()));
    assert!(session.shell_view().prompt_block_content_editable);
    session.set_prompt_block_content_draft("Stay in character.");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);

    session.apply_shell_action(ShellAction::EditPromptBlock(
        "post-history-instructions".into(),
    ));
    assert!(session.shell_view().prompt_block_content_editable);
    session.set_prompt_block_content_draft("Drive the scene.");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    session.apply_shell_action(ShellAction::EditPromptBlock(
        "post-history-instructions".into(),
    ));
    assert_eq!(
        session.shell_view().prompt_block_content_draft,
        "Drive the scene."
    );
    session.apply_shell_action(ShellAction::PromptBlockEditCancel);

    session.apply_shell_action(ShellAction::EditPromptBlock("memory".into()));
    assert!(!session.shell_view().prompt_block_content_editable);
    session.apply_shell_action(ShellAction::PromptBlockEditCancel);

    session.apply_shell_action(ShellAction::RemovePromptBlock("memory".into()));
    assert_eq!(
        session.shell_view().prompt_blocks.len(),
        13,
        "core ids cannot be removed"
    );
    session.apply_shell_action(ShellAction::RemovePromptBlock("no-such-block".into()));
    assert_eq!(session.shell_view().prompt_blocks.len(), 13);

    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    assert!(
        session.shell_view().prompt_block_edit_open,
        "empty name is a no-op like React submit"
    );
    session.apply_shell_action(ShellAction::PromptBlockEditCancel);

    session.apply_shell_action(ShellAction::RemovePromptBlock("custom-1".into()));
    session.apply_shell_action(ShellAction::RemovePromptBlock("custom-2".into()));
    assert_eq!(session.shell_view().prompt_blocks.len(), 12);
    assert!(session
        .shell_view()
        .prompt_blocks
        .iter()
        .all(|block| !block.custom));

    session.apply_shell_action(ShellAction::SetTab("memories".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.apply_shell_action(ShellAction::SetTab("memories".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    assert!(
        session
            .shell_view()
            .prompt_blocks
            .iter()
            .any(|block| block.id == "custom-1"),
        "settings.get round-trip keeps the custom block"
    );

    session.set_surface_size(1100, 760, 1.0);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-add"),
        "missing prompt-block-add; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-editor"),
        "missing prompt-block-editor; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-name-input"),
        "missing prompt-block-name-input; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_reorder_blocks_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);

    let shell = session.shell_view();
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("custom-1");
    assert_eq!(custom.name, "Greeting");
    assert!(custom.can_move_up);
    assert!(
        !custom.can_move_down,
        "custom sits immediately before the terminal anchors"
    );
    assert_eq!(
        shell
            .prompt_blocks
            .iter()
            .position(|block| block.id == "custom-1"),
        Some(10)
    );
    let main = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "main-prompt")
        .expect("main-prompt");
    assert!(!main.can_move_up);
    assert!(main.can_move_down);
    let history = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "chat-history")
        .expect("chat-history");
    assert!(!history.can_move_up);
    assert!(!history.can_move_down);

    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::MovePromptBlockUp("custom-1".into()));
    let after_up = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after_up > before, "move up persists prompt-template");
    let shell = session.shell_view();
    assert_eq!(
        shell
            .prompt_blocks
            .iter()
            .position(|block| block.id == "custom-1"),
        Some(9)
    );
    assert_eq!(
        shell.status_message.as_deref(),
        Some("Greeting moved to position 10.")
    );
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("custom-1 after up");
    assert!(custom.can_move_up);
    assert!(custom.can_move_down);

    session.apply_shell_action(ShellAction::MovePromptBlockDown("custom-1".into()));
    let after_down = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after_down > after_up, "move down persists prompt-template");
    let shell = session.shell_view();
    assert_eq!(
        shell
            .prompt_blocks
            .iter()
            .position(|block| block.id == "custom-1"),
        Some(10)
    );
    assert_eq!(
        shell.status_message.as_deref(),
        Some("Greeting moved to position 11.")
    );

    session.apply_shell_action(ShellAction::MovePromptBlockDown("custom-1".into()));
    session.apply_shell_action(ShellAction::MovePromptBlockUp("chat-history".into()));
    session.apply_shell_action(ShellAction::MovePromptBlockDown("chat-history".into()));
    session.apply_shell_action(ShellAction::MovePromptBlockUp("main-prompt".into()));
    session.apply_shell_action(ShellAction::MovePromptBlockUp("no-such-block".into()));
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        after_down,
        "terminals, first-row up, and unknown ids are no-ops"
    );
    assert_eq!(
        session
            .shell_view()
            .prompt_blocks
            .iter()
            .position(|block| block.id == "custom-1"),
        Some(10)
    );

    session.set_surface_size(1100, 760, 1.0);
    let shell = session.shell_view();
    // First row: toggle 48 | name | Up 32 (disabled) | Down 32. Panel 60+380.
    // Import/export sits above Add (+44px vs the pre-import layout).
    match hit_test(&shell, 368.0, 454.0) {
        Some(ShellHit::Absorb) => {}
        other => panic!("expected Absorb on disabled main-prompt Up, got {other:?}"),
    }
    match hit_test(&shell, 400.0, 454.0) {
        Some(ShellHit::Action(ShellAction::MovePromptBlockDown(id))) => {
            assert_eq!(id, "main-prompt");
        }
        other => panic!("expected MovePromptBlockDown main-prompt, got {other:?}"),
    }

    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-move-up"),
        "missing prompt-block-move-up; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-move-down"),
        "missing prompt-block-move-down; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_block_placement_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    let shell = session.shell_view();
    assert!(shell.prompt_block_edit_open);
    assert_eq!(shell.prompt_block_injection_position, "relative");
    assert_eq!(shell.prompt_block_depth_draft, "4");
    assert_eq!(shell.prompt_block_order_draft, "100");

    match hit_test(&shell, 770.0, 308.0) {
        Some(ShellHit::Action(ShellAction::CyclePromptBlockPosition)) => {}
        other => panic!("expected CyclePromptBlockPosition on Position, got {other:?}"),
    }

    let before_cycle = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::CyclePromptBlockPosition);
    assert_eq!(
        session.shell_view().prompt_block_injection_position,
        "in-chat"
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        before_cycle,
        "position cycle is a local draft until Save"
    );

    session.set_prompt_block_depth_draft("2");
    session.set_prompt_block_order_draft("50");
    session.set_prompt_block_depth_draft("99999");
    assert_eq!(
        session.shell_view().prompt_block_depth_draft,
        "9999",
        "depth draft keeps at most 4 digits"
    );
    session.set_prompt_block_depth_draft("2");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    let after_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    assert!(after_save > before_cycle, "Save persists placement");
    let shell = session.shell_view();
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("custom-1");
    assert!(custom.injection_in_chat);
    assert_eq!(custom.injection_depth, 2);

    session.apply_shell_action(ShellAction::CyclePromptBlockPosition);
    assert!(
        !session.shell_view().prompt_block_edit_open,
        "cycle is a no-op when the editor is closed"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    let shell = session.shell_view();
    assert_eq!(shell.prompt_block_injection_position, "in-chat");
    assert_eq!(shell.prompt_block_depth_draft, "2");
    assert_eq!(shell.prompt_block_order_draft, "50");

    session.apply_shell_action(ShellAction::CyclePromptBlockPosition);
    assert_eq!(
        session.shell_view().prompt_block_injection_position,
        "relative"
    );
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    let shell = session.shell_view();
    assert_eq!(shell.prompt_block_injection_position, "relative");
    assert_eq!(shell.prompt_block_depth_draft, "2");
    let custom = shell
        .prompt_blocks
        .iter()
        .find(|block| block.id == "custom-1")
        .expect("custom-1");
    assert!(!custom.injection_in_chat);

    session.apply_shell_action(ShellAction::CyclePromptBlockPosition);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-position-cycle"),
        "missing prompt-block-position-cycle; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-depth-input"),
        "missing prompt-block-depth-input; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-order-input"),
        "missing prompt-block-order-input; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_block_role_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    let shell = session.shell_view();
    assert_eq!(shell.prompt_block_role, "system");

    match hit_test(&shell, 770.0, 264.0) {
        Some(ShellHit::Action(ShellAction::CyclePromptBlockRole)) => {}
        other => panic!("expected CyclePromptBlockRole on Role, got {other:?}"),
    }

    let before_cycle = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "user");
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "assistant");
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "system");
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "user");
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        before_cycle,
        "role cycle is a local draft until Save"
    );

    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count()
            > before_cycle,
        "Save persists role"
    );

    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert!(
        !session.shell_view().prompt_block_edit_open,
        "cycle is a no-op when the editor is closed"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert_eq!(session.shell_view().prompt_block_role, "user");
    session.apply_shell_action(ShellAction::EditPromptBlock("main-prompt".into()));
    assert_eq!(session.shell_view().prompt_block_role, "system");

    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-role-cycle"),
        "missing prompt-block-role-cycle; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_block_triggers_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    let shell = session.shell_view();
    assert_eq!(
        shell.prompt_block_triggers,
        vec![
            "normal",
            "continue",
            "impersonate",
            "swipe",
            "regenerate",
            "quiet"
        ]
    );

    match hit_test(&shell, 895.0, 396.0) {
        Some(ShellHit::Action(ShellAction::TogglePromptBlockTrigger(id))) => {
            assert_eq!(id, "quiet");
        }
        other => panic!("expected TogglePromptBlockTrigger quiet, got {other:?}"),
    }

    let before_toggle = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::TogglePromptBlockTrigger("quiet".into()));
    assert_eq!(
        session.shell_view().prompt_block_triggers,
        vec!["normal", "continue", "impersonate", "swipe", "regenerate"]
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        before_toggle,
        "trigger toggle is a local draft until Save"
    );

    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count()
            > before_toggle,
        "Save persists triggers"
    );

    session.apply_shell_action(ShellAction::TogglePromptBlockTrigger("quiet".into()));
    assert!(
        !session.shell_view().prompt_block_edit_open,
        "toggle is a no-op when the editor is closed"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert_eq!(
        session.shell_view().prompt_block_triggers,
        vec!["normal", "continue", "impersonate", "swipe", "regenerate"]
    );

    for id in ["normal", "continue", "impersonate", "swipe"] {
        session.apply_shell_action(ShellAction::TogglePromptBlockTrigger(id.into()));
    }
    assert_eq!(
        session.shell_view().prompt_block_triggers,
        vec!["regenerate"]
    );
    session.apply_shell_action(ShellAction::TogglePromptBlockTrigger("regenerate".into()));
    assert_eq!(
        session.shell_view().prompt_block_triggers,
        vec![
            "normal",
            "continue",
            "impersonate",
            "swipe",
            "regenerate",
            "quiet"
        ],
        "clearing the last chip restores every kind, like React"
    );
    session.apply_shell_action(ShellAction::TogglePromptBlockTrigger("bogus".into()));
    assert_eq!(
        session.shell_view().prompt_block_triggers.len(),
        6,
        "unknown trigger ids are a no-op"
    );

    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert_eq!(session.shell_view().prompt_block_triggers.len(), 6);

    session.apply_shell_action(ShellAction::EditPromptBlock("memory".into()));
    assert_eq!(
        session.shell_view().prompt_block_triggers.len(),
        6,
        "omitted host-block triggers hydrate as every kind"
    );

    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-trigger"),
        "missing prompt-block-trigger; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_block_forbid_overrides_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    let shell = session.shell_view();
    assert!(shell.prompt_block_content_editable);
    assert_eq!(shell.prompt_block_role, "system");
    assert!(!shell.prompt_block_forbid_overrides);

    match hit_test(&shell, 770.0, 440.0) {
        Some(ShellHit::Action(ShellAction::TogglePromptBlockForbidOverrides)) => {}
        other => panic!("expected TogglePromptBlockForbidOverrides, got {other:?}"),
    }

    let before_toggle = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.apply_shell_action(ShellAction::TogglePromptBlockForbidOverrides);
    assert!(session.shell_view().prompt_block_forbid_overrides);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count(),
        before_toggle,
        "forbidOverrides toggle is a local draft until Save"
    );

    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count()
            > before_toggle,
        "Save persists forbidOverrides"
    );

    session.apply_shell_action(ShellAction::TogglePromptBlockForbidOverrides);
    assert!(
        !session.shell_view().prompt_block_edit_open,
        "toggle is a no-op when the editor is closed"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert!(session.shell_view().prompt_block_forbid_overrides);

    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "user");
    match hit_test(&session.shell_view(), 770.0, 440.0) {
        Some(ShellHit::Absorb) => {}
        other => panic!("expected Absorb when role is user, got {other:?}"),
    }
    session.apply_shell_action(ShellAction::TogglePromptBlockForbidOverrides);
    assert!(
        session.shell_view().prompt_block_forbid_overrides,
        "toggle is a no-op when role is not system"
    );
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    session.apply_shell_action(ShellAction::CyclePromptBlockRole);
    assert_eq!(session.shell_view().prompt_block_role, "system");
    assert!(session.shell_view().prompt_block_forbid_overrides);

    session.apply_shell_action(ShellAction::PromptBlockEditCancel);
    session.apply_shell_action(ShellAction::EditPromptBlock("memory".into()));
    assert!(!session.shell_view().prompt_block_content_editable);
    session.apply_shell_action(ShellAction::TogglePromptBlockForbidOverrides);
    assert!(
        !session.shell_view().prompt_block_forbid_overrides,
        "toggle is a no-op when content is not editable"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-forbid-overrides"),
        "missing prompt-block-forbid-overrides; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_block_model_binding_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::AddPromptBlock);
    session.set_prompt_block_name_draft("Greeting");
    let shell = session.shell_view();
    assert!(shell.prompt_block_model_draft.is_empty());
    assert!(shell.selected_provider_id.is_none());

    session.set_prompt_block_model_draft("gpt-test");
    assert!(
        session.shell_view().prompt_block_model_draft.is_empty(),
        "model draft is disabled without an active provider"
    );

    match hit_test(&shell, 910.0, 520.0) {
        Some(ShellHit::Action(ShellAction::LoadPromptBlockModels)) => {}
        other => panic!("expected LoadPromptBlockModels, got {other:?}"),
    }
    session.apply_shell_action(ShellAction::LoadPromptBlockModels);
    assert!(
        session.shell_view().error_message.is_none(),
        "Load is a no-op without an active provider"
    );

    let provider_id = session.shell_view().provider_configs[0].id.clone();
    session.apply_shell_action(ShellAction::SelectProvider(provider_id));
    session.apply_shell_action(ShellAction::LoadPromptBlockModels);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert!(
        !session
            .issued_commands()
            .iter()
            .any(|op| op.starts_with("providers.models")),
        "no providers.models wire op exists"
    );

    let before_save = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "settings.update")
        .count();
    session.set_prompt_block_model_draft("gpt-test");
    assert_eq!(session.shell_view().prompt_block_model_draft, "gpt-test");
    session.set_prompt_block_model_draft(&"m".repeat(300));
    assert_eq!(
        session.shell_view().prompt_block_model_draft.len(),
        256,
        "model draft keeps at most 256 chars"
    );
    session.set_prompt_block_model_draft("gpt-test");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "settings.update")
            .count()
            > before_save,
        "Save persists model binding"
    );

    session.apply_shell_action(ShellAction::LoadPromptBlockModels);
    assert!(
        !session.shell_view().prompt_block_edit_open,
        "Load is a no-op when the editor is closed"
    );

    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert_eq!(session.shell_view().prompt_block_model_draft, "gpt-test");
    session.set_prompt_block_model_draft("");
    session.apply_shell_action(ShellAction::PromptBlockEditSave);
    session.apply_shell_action(ShellAction::EditPromptBlock("custom-1".into()));
    assert!(
        session.shell_view().prompt_block_model_draft.is_empty(),
        "empty draft omits the model key, like React undefined"
    );

    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-block-model-input"),
        "missing prompt-block-model-input; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-block-model-load"),
        "missing prompt-block-model-load; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn prompt_template_import_export_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    session.apply_shell_action(ShellAction::CyclePromptMode);
    session.apply_shell_action(ShellAction::CyclePromptPreset);
    assert_eq!(
        session.shell_view().prompt_preset_active_name.as_deref(),
        Some("Roleplay")
    );

    let shell = session.shell_view();
    match hit_test(&shell, 124.0, 366.0) {
        Some(ShellHit::Action(ShellAction::PromptTemplateImportOpen)) => {}
        other => panic!("expected PromptTemplateImportOpen, got {other:?}"),
    }
    match hit_test(&shell, 228.0, 366.0) {
        Some(ShellHit::Action(ShellAction::ExportPromptTemplate)) => {}
        other => panic!("expected ExportPromptTemplate, got {other:?}"),
    }

    let before_create = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "presets.create")
        .count();
    session.apply_shell_action(ShellAction::ExportPromptTemplate);
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "presets.create")
            .count()
            == before_create,
        "export is host-owned JSON, not a wire op"
    );
    let export = session.take_last_export().expect("parked export");
    assert_eq!(export.filename, "Roleplay.json");
    let doc: serde_json::Value =
        serde_json::from_slice(&export.bytes).expect("valid export document");
    assert_eq!(
        doc.get("version").and_then(serde_json::Value::as_u64),
        Some(1)
    );
    assert_eq!(
        doc.get("kind").and_then(serde_json::Value::as_str),
        Some("prompt-template")
    );
    assert_eq!(
        doc.get("name").and_then(serde_json::Value::as_str),
        Some("Roleplay")
    );
    assert!(
        doc.get("data")
            .and_then(|value| value.get("blocks"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|blocks| blocks.len() >= 12),
        "envelope carries the 12 host-owned blocks"
    );
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Export ready: Roleplay.json.")
    );

    session.apply_shell_action(ShellAction::PromptTemplateImportOpen);
    assert!(session.shell_view().prompt_template_import_open);
    session.apply_shell_action(ShellAction::PromptTemplateImportConfirm);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Provide a prompt template JSON file from this device.")
    );
    assert!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "presets.create")
            .count()
            == before_create,
        "empty path does not create a preset"
    );

    let import_path = std::env::temp_dir().join(format!(
        "neota-test-prompt-template-{}.json",
        std::process::id()
    ));
    std::fs::write(&import_path, &export.bytes).expect("write export");
    session.set_prompt_template_path_draft(&import_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PromptTemplateImportConfirm);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.create"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "settings.update"));
    let shell = session.shell_view();
    assert!(!shell.prompt_template_import_open);
    assert_eq!(shell.prompt_presets.len(), 2);
    assert_eq!(shell.prompt_preset_active_name.as_deref(), Some("Roleplay"));
    assert_eq!(shell.status_message.as_deref(), Some("Imported Roleplay."));
    assert_eq!(shell.prompt_blocks.len(), 12);

    session.apply_shell_action(ShellAction::PromptTemplateImportOpen);
    let bad_path = std::env::temp_dir().join(format!(
        "neota-test-prompt-template-bad-{}.json",
        std::process::id()
    ));
    std::fs::write(&bad_path, "{not json").expect("write invalid");
    session.set_prompt_template_path_draft(&bad_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PromptTemplateImportConfirm);
    assert_eq!(
        session.shell_view().instruct_form_error.as_deref(),
        Some("This file is not a valid prompt template preset.")
    );
    assert!(
        session.shell_view().prompt_template_import_open,
        "invalid JSON keeps the dialog open"
    );

    let incomplete_path = std::env::temp_dir().join(format!(
        "neota-test-prompt-template-incomplete-{}.json",
        std::process::id()
    ));
    std::fs::write(
        &incomplete_path,
        serde_json::json!({
            "version": 1,
            "kind": "prompt-template",
            "name": "Broken",
            "data": { "mode": "text", "blocks": [] }
        })
        .to_string(),
    )
    .expect("write incomplete");
    session.set_prompt_template_path_draft(&incomplete_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PromptTemplateImportConfirm);
    assert_eq!(
        session.shell_view().instruct_form_error.as_deref(),
        Some("This file is not a valid prompt template preset.")
    );

    let raw_path = std::env::temp_dir().join(format!(
        "neota-test-prompt-template-raw-{}.json",
        std::process::id()
    ));
    let data = doc.get("data").cloned().expect("export data");
    std::fs::write(&raw_path, data.to_string()).expect("write raw template");
    session.set_prompt_template_path_draft(&raw_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PromptTemplateImportConfirm);
    assert!(!session.shell_view().prompt_template_import_open);
    assert_eq!(session.shell_view().prompt_presets.len(), 3);
    let raw_name = raw_path.file_stem().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        session.shell_view().prompt_preset_active_name.as_deref(),
        Some(raw_name.as_str())
    );

    let _ = std::fs::remove_file(&import_path);
    let _ = std::fs::remove_file(&bad_path);
    let _ = std::fs::remove_file(&incomplete_path);
    let _ = std::fs::remove_file(&raw_path);

    session.apply_shell_action(ShellAction::PromptTemplateImportOpen);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("prompt-preset-import"),
        "missing prompt-preset-import; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-preset-export"),
        "missing prompt-preset-export; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-template-import"),
        "missing prompt-template-import; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("prompt-template-path-input"),
        "missing prompt-template-path-input; identities={:?}",
        skeleton.identities()
    );
}

#[test]
fn diagnostics_export_and_legacy_maintenance_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    let before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "diagnostics.export")
        .count();
    assert!(before >= 1, "General tab loads diagnostics.export on open");
    session.apply_shell_action(ShellAction::RunDiagnostics);
    let after = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "diagnostics.export")
        .count();
    assert!(
        after > before,
        "Run diagnostics re-exports the allowlist bundle"
    );
    let bundle = session
        .shell_view()
        .diagnostics
        .expect("bundle after refresh");
    assert_eq!(bundle.redaction, "allowlist");
    assert_eq!(bundle.schema_hash.len(), 64);
    assert!(bundle.sections.iter().any(|section| section == "settings"));

    session.apply_shell_action(ShellAction::ClearDiagnosticCache);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert!(!session
        .issued_commands()
        .iter()
        .any(|op| op.contains("diagnostics.cache") || op == "search.rebuild"));
}

#[test]
fn data_activation_status_and_sillytavern_import_honesty_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("data".into()));
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "data.activation.status"),
        "opening Data loads data.activation.status"
    );
    let status = session
        .shell_view()
        .data_activation
        .expect("activation status");
    assert_eq!(status.layout_version, 2);
    assert_eq!(status.active_root_id.as_deref(), Some("a1b2c3d4"));
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].kind, "restore");
    assert_eq!(status.entries[0].status, "committed");
    assert!(status.pending.is_none());

    session.apply_shell_action(ShellAction::AnalyzeSillyTavern);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert!(!session
        .issued_commands()
        .iter()
        .any(|op| op.starts_with("imports.sillytavern")));

    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::default(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("data".into()));
    let status = session
        .shell_view()
        .data_activation
        .expect("empty journal still a status");
    assert!(status.entries.is_empty());
    assert!(status.pending.is_none());
}

#[test]
fn character_lorebooks_create_open_and_unlink_honesty_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.select_character(neotavern_presentation_chat::DEMO_CHARACTER_ID);
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "lorebooks.list"),
        "opening Advanced loads lorebooks.list"
    );
    let shell = session.shell_view();
    assert_eq!(shell.tab, "advanced");
    assert!(
        !shell
            .lorebooks
            .iter()
            .any(|book| book.character_id.as_deref()
                == Some(neotavern_presentation_chat::DEMO_CHARACTER_ID)),
        "demo Kestrel Vales is global, not linked to Hazel"
    );

    session.set_surface_size(800, 904, 1.0);
    let shell = session.shell_view();
    match hit_test(&shell, 160.0, 178.0) {
        Some(ShellHit::Action(ShellAction::CreateCharacterLorebook)) => {}
        other => panic!("expected CreateCharacterLorebook on New book, got {other:?}"),
    }
    match hit_test(&shell, 340.0, 178.0) {
        Some(ShellHit::Action(ShellAction::SetPanel(panel))) if panel == "lorebooks" => {}
        other => panic!("expected Open lorebooks, got {other:?}"),
    }

    session.apply_shell_action(ShellAction::CreateCharacterLorebook);
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "lorebooks.create"),
        "New book for character calls lorebooks.create"
    );
    let shell = session.shell_view();
    assert_eq!(shell.panel, "lorebooks");
    let created = shell
        .lorebooks
        .iter()
        .find(|book| book.name == "New lorebook")
        .expect("created book");
    assert_eq!(
        created.character_id.as_deref(),
        Some(neotavern_presentation_chat::DEMO_CHARACTER_ID)
    );
    let created_id = created.id.clone();

    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    session.select_character(neotavern_presentation_chat::DEMO_CHARACTER_ID);
    session.apply_shell_action(ShellAction::SetTab("advanced".into()));
    let shell = session.shell_view();
    assert!(shell.lorebooks.iter().any(|book| book.id == created_id
        && book.character_id.as_deref() == Some(neotavern_presentation_chat::DEMO_CHARACTER_ID)));

    session.set_surface_size(800, 904, 1.0);
    let shell = session.shell_view();
    match hit_test(&shell, 400.0, 224.0) {
        Some(ShellHit::Action(ShellAction::UnlinkCharacterLorebook(id))) if id == created_id => {}
        other => panic!("expected UnlinkCharacterLorebook, got {other:?}"),
    }
    let updates_before = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "lorebooks.update")
        .count();
    session.apply_shell_action(ShellAction::UnlinkCharacterLorebook(created_id.clone()));
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "lorebooks.update")
            .count(),
        updates_before,
        "unlink is not expressible on the wire (characterId null)"
    );
}

#[test]
fn display_macros_expand_user_and_char_on_committed_rows() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let first_id = session.view().visible[0].id.clone();
    session.start_message_edit(&first_id);
    session.set_message_edit_draft("{{user}} meets {{char}} and {{unknown}}");
    session.submit_message_edit();
    let view = session.view();
    let row = view
        .visible
        .iter()
        .find(|row| row.id == first_id)
        .expect("edited row");
    assert_eq!(
        row.content, "You meets Hazel and {{unknown}}",
        "committed bubbles expand {{{{user}}}}/{{{{char}}}}; unknown macros stay"
    );
    drop(view);
    session.start_message_edit(&first_id);
    assert_eq!(
        session.view().editing_draft,
        "{{user}} meets {{char}} and {{unknown}}",
        "stored content stays raw"
    );
}

#[test]
fn tool_activity_badge_from_waiting_tool_call_step() {
    use contracts_generated::generated::{
        GenerationEvent, GenerationStep, GenerationStepStatus, GenerationStepType,
    };
    use neotavern_presentation_chat::StreamFrame;
    use neotavern_presentation_dioxus_shell::{
        install_product_chat, set_chat_blueprint_source, ChatBlueprintSource,
    };
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    use serde_json::json;

    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);

    session.apply_stream_frame(&StreamFrame::from_sequenced(
        0,
        GenerationEvent::GenerationDelta { text: "hi".into() },
    ));
    session.apply_stream_frame(&StreamFrame::from_sequenced(
        1,
        GenerationEvent::GenerationStep {
            step: GenerationStep {
                step_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                sequence: 1,
                r#type: GenerationStepType::ToolCall,
                status: GenerationStepStatus::Waiting,
                attempt: 1,
                idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                input: Some(json!({
                    "toolCall": {
                        "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                        "name": "lookup-weather",
                        "arguments": { "secret": "SECRET_TOOL_ARG_PAYLOAD" }
                    }
                })),
                output: Some(json!({ "leaked": "SECRET_TOOL_RESULT_PAYLOAD" })),
                error: None,
                created_at: "2026-08-12T10:00:00Z".into(),
                updated_at: "2026-08-12T10:00:00Z".into(),
            },
        },
    ));

    let view = session.view();
    assert_eq!(view.tool_activity_name.as_deref(), Some("lookup-weather"));
    assert!(view.streaming);
    let dump = format!("{view:?}");
    assert!(
        !dump.contains("SECRET_TOOL_ARG_PAYLOAD"),
        "tool arguments must not reach ProductChatView"
    );
    assert!(
        !dump.contains("SECRET_TOOL_RESULT_PAYLOAD"),
        "tool results must not reach ProductChatView"
    );
    drop(view);

    let assert_badge = |source: ChatBlueprintSource| {
        set_chat_blueprint_source(source.clone());
        install_product_chat(session.view());
        let skeleton = inspect_slot_skeleton(product_chat_app, 1100, 760, 1.0, session.insets())
            .unwrap_or_else(|err| panic!("skeleton for {source:?}: {err}"));
        assert!(
            skeleton.has_identity("tool-activity"),
            "tool-activity missing for {source:?}"
        );
        // HTML `role="status"` matches React; SlotSkeleton.role is `data-role`.
        let dump = format!("{skeleton:?}");
        assert!(!dump.contains("SECRET_TOOL_ARG_PAYLOAD"));
        assert!(!dump.contains("SECRET_TOOL_RESULT_PAYLOAD"));
    };
    assert_badge(ChatBlueprintSource::Disabled);
    assert_badge(ChatBlueprintSource::Embedded);
    set_chat_blueprint_source(ChatBlueprintSource::Disabled);

    session.apply_stream_frame(&StreamFrame::from_sequenced(
        2,
        GenerationEvent::GenerationStep {
            step: GenerationStep {
                step_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".into(),
                run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                sequence: 2,
                r#type: GenerationStepType::ProviderTurn,
                status: GenerationStepStatus::Completed,
                attempt: 1,
                idempotency_key: "ffffffff-ffff-4fff-8fff-ffffffffffff".into(),
                input: None,
                output: None,
                error: None,
                created_at: "2026-08-12T10:00:00Z".into(),
                updated_at: "2026-08-12T10:00:00Z".into(),
            },
        },
    ));
    assert_eq!(session.view().tool_activity_name, None);

    session.apply_stream_frame(&StreamFrame::from_sequenced(
        3,
        GenerationEvent::GenerationDelta {
            text: " again".into(),
        },
    ));
    session.apply_stream_frame(&StreamFrame::from_sequenced(
        4,
        GenerationEvent::GenerationStep {
            step: GenerationStep {
                step_id: "11111111-1111-4111-8111-111111111111".into(),
                run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                sequence: 4,
                r#type: GenerationStepType::ToolCall,
                status: GenerationStepStatus::Waiting,
                attempt: 1,
                idempotency_key: "22222222-2222-4222-8222-222222222222".into(),
                input: Some(json!({ "toolCall": { "name": "lookup-weather" } })),
                output: None,
                error: None,
                created_at: "2026-08-12T10:00:00Z".into(),
                updated_at: "2026-08-12T10:00:00Z".into(),
            },
        },
    ));
    assert_eq!(
        session.view().tool_activity_name.as_deref(),
        Some("lookup-weather")
    );
    session.apply_stream_frame(&StreamFrame::Terminal);
    assert_eq!(session.view().tool_activity_name, None);
    assert!(!session.view().streaming);
}

#[test]
fn backgrounds_panel_is_honest_empty_and_upload_reports_capability_unavailable() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("backgrounds".into()));
    let shell = session.shell_view();
    assert_eq!(shell.panel, "backgrounds");
    assert!(shell.sidebar_open);
    // The kernel plane has no wallpaper catalog: the panel issues no wire op
    // (React `useBackgrounds` returns an honest empty list).
    assert!(
        !session
            .issued_commands()
            .iter()
            .any(|op| op.starts_with("backgrounds")),
        "no backgrounds wire op exists"
    );
    // Upload mirrors the React kernel plane: `UnsupportedError` surfaces as
    // the CAPABILITY_UNAVAILABLE error code, not a fake dialog or op.
    session.apply_shell_action(ShellAction::UploadBackground);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    session.apply_shell_action(ShellAction::ClosePanel);
    assert!(!session.shell_view().sidebar_open);
}

#[test]
fn themes_catalog_activate_deactivate_uninstall_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("themes".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "themes");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "themes.list"),
        "opening the Themes tab loads the catalog"
    );
    assert_eq!(shell.themes.len(), 2);
    assert!(shell.themes.iter().all(|item| !item.active));
    let target = shell.themes[0].id.clone();
    let target_name = shell.themes[0].name.clone();

    // Activate -> wire response marks exactly one active; the shell root
    // exposes the active id via data-theme-id.
    session.apply_shell_action(ShellAction::ActivateTheme(target.clone()));
    let shell = session.shell_view();
    let active: Vec<_> = shell.themes.iter().filter(|item| item.active).collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, target);
    assert!(
        shell
            .status_message
            .as_deref()
            .unwrap_or("")
            .contains("Applied"),
        "activate surfaces a toast"
    );

    // Built-in restore -> themes.deactivate clears the active flag.
    session.apply_shell_action(ShellAction::UseBuiltInTheme);
    let shell = session.shell_view();
    assert!(shell.themes.iter().all(|item| !item.active));

    // Delete: confirm dialog -> themes.uninstall removes the row.
    session.apply_shell_action(ShellAction::ActivateTheme(target.clone()));
    session.apply_shell_action(ShellAction::OpenThemeDelete(target.clone()));
    assert!(session.shell_view().theme_delete_open);
    session.apply_shell_action(ShellAction::ConfirmThemeDelete);
    let shell = session.shell_view();
    assert!(!shell.theme_delete_open);
    assert!(
        shell.themes.iter().all(|item| item.id != target),
        "confirm delete removes the theme row"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "themes.uninstall"));
    assert!(session
        .shell_view()
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains(&target_name));

    // Install stays a host-side capability: React kernel plane rejects it
    // with UnsupportedError, so no themes.install wire op is issued.
    session.apply_shell_action(ShellAction::InstallTheme);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
    assert!(!session
        .issued_commands()
        .iter()
        .any(|op| op == "themes.install"));
}

#[test]
fn secrets_status_and_lock_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("secrets".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "secrets");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "secrets.status"),
        "opening the Secrets tab reads the store status"
    );
    let status = shell.secrets_status.as_ref().expect("status loaded");
    assert_eq!(status.kind, "portable");
    assert!(status.persistent && status.writable && status.available);
    assert_eq!(status.record_count, 2);
    assert_eq!(status.format_version, Some(1));

    // Lock -> `secrets.lock`, then the status is re-read: the store reports
    // itself locked (React invalidates the status query after the mutation).
    session.apply_shell_action(ShellAction::LockSecrets);
    let shell = session.shell_view();
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "secrets.lock"));
    let status = shell.secrets_status.as_ref().expect("status after lock");
    assert!(!status.available, "locked store reports available=false");

    // No store wired -> honest fail-closed status and a CAPABILITY_UNAVAILABLE
    // lock (kernel `secrets.rs`), never a value leak.
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::default(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("secrets".into()));
    let shell = session.shell_view();
    let status = shell.secrets_status.as_ref().expect("status loaded");
    assert_eq!(status.kind, "unavailable");
    assert!(!status.persistent && !status.writable && !status.available);
    assert_eq!(status.record_count, 0);
    session.apply_shell_action(ShellAction::LockSecrets);
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("CAPABILITY_UNAVAILABLE")
    );
}

#[test]
fn tools_registry_list_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("tools".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "tools");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "generation.tools.list"),
        "opening the Tools tab reads the registry"
    );
    let tool = shell.tools.iter().find(|item| item.id == "lookup-weather");
    let tool = tool.expect("demo registry carries the fixture tool");
    assert_eq!(tool.name, "lookup_weather");
    assert_eq!(tool.description, "Look up current weather for a city");
    assert_eq!(tool.required, vec!["city".to_string()]);

    // Empty registry is a success, never an error (kernel
    // `generation_tools_list`), and the panel shows the honest empty state.
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::default(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("tools".into()));
    let shell = session.shell_view();
    assert!(shell.tools.is_empty());
    assert!(shell.error_message.is_none());
}

#[test]
fn ai_providers_and_presets_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    let shell = session.shell_view();
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "providers.list"),
        "opening AI Settings lists providers"
    );
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "providers.config.list"),
        "opening AI Settings lists connection profiles"
    );
    let provider = shell.providers.iter().find(|item| item.id == "fake");
    let provider = provider.expect("kernel registers the built-in fake provider");
    assert_eq!(provider.name, "Fake Provider");
    assert_eq!(provider.availability, "available");

    // Select a connection profile -> settings.update activeProviderConfigId.
    let profile = &shell.provider_configs[0];
    assert_eq!(profile.detail.contains("not set"), true);
    session.apply_shell_action(ShellAction::SelectProvider(profile.id.clone()));
    let shell = session.shell_view();
    assert_eq!(
        shell.selected_provider_id.as_deref(),
        Some(profile.id.as_str())
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "settings.update"));

    // Presets tab: list (kind generation), then select -> settings.update
    // activeGenerationPresetId.
    session.apply_shell_action(ShellAction::SetTab("presets".into()));
    let shell = session.shell_view();
    assert_eq!(shell.ai_tab, "presets");
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.list"));
    assert_eq!(shell.presets.len(), 2);
    let preset_id = shell.presets[0].id.clone();
    session.apply_shell_action(ShellAction::SelectPreset(preset_id.clone()));
    let shell = session.shell_view();
    assert_eq!(
        shell.selected_preset_id.as_deref(),
        Some(preset_id.as_str())
    );
    assert!(session
        .shell_view()
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains("selected"));

    // Default wire has no providers/presets -> honest empty states, no error.
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::default(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    let shell = session.shell_view();
    assert!(shell.providers.is_empty());
    assert!(shell.error_message.is_none());
}

#[test]
fn provider_profiles_crud_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));

    // Create: dialog -> kind cycle -> name -> providers.config.set + select.
    session.apply_shell_action(ShellAction::ProviderCreateOpen);
    assert!(session.shell_view().provider_create_dialog_open);
    session.apply_shell_action(ShellAction::ProviderCycleKind);
    session.set_provider_name_draft("second-profile");
    session.apply_shell_action(ShellAction::ProviderCreateSubmit);
    let shell = session.shell_view();
    assert!(!shell.provider_create_dialog_open);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "providers.config.set"));
    assert_eq!(shell.provider_configs.len(), 2);
    assert_eq!(
        shell.selected_provider_id.as_deref(),
        Some(shell.provider_configs[1].id.as_str())
    );

    // Empty name stays client-side without a wire call.
    session.apply_shell_action(ShellAction::ProviderCreateOpen);
    let set_calls = session
        .issued_commands()
        .iter()
        .filter(|op| **op == "providers.config.set")
        .count();
    session.apply_shell_action(ShellAction::ProviderCreateSubmit);
    assert_eq!(
        session.shell_view().provider_form_error.as_deref(),
        Some("REQUIRED")
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "providers.config.set")
            .count(),
        set_calls
    );
    session.apply_shell_action(ShellAction::ProviderCreateClose);

    // Delete the active profile -> config.delete + selection cleared.
    let target = session.shell_view().provider_configs[1].id.clone();
    session.apply_shell_action(ShellAction::ProviderDeleteOpen(target));
    session.apply_shell_action(ShellAction::ProviderDeleteConfirm);
    let shell = session.shell_view();
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "providers.config.delete"));
    assert_eq!(shell.provider_configs.len(), 1);
    assert!(shell.selected_provider_id.is_none());
}

#[test]
fn backups_list_create_restore_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("data".into()));
    let shell = session.shell_view();
    assert_eq!(shell.settings_tab, "data");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "backups.list"),
        "opening the Data tab loads the backup catalog"
    );
    assert_eq!(shell.backups.len(), 2);
    assert!(shell
        .backups
        .iter()
        .all(|item| item.detail.contains("Manual backup")));

    // Create -> backups.create appends and refreshes the catalog.
    session.apply_shell_action(ShellAction::CreateBackup);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "backups.create"));
    assert_eq!(session.shell_view().backups.len(), 3);

    // Refresh re-issues backups.list.
    session.apply_shell_action(ShellAction::RefreshBackups);
    assert_eq!(session.shell_view().backups.len(), 3);

    // Restore an existing backup: committed outcome refreshes silently.
    let target = session.shell_view().backups[0].id.clone();
    session.apply_shell_action(ShellAction::RestoreBackup(target));
    let shell = session.shell_view();
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "backups.restore"));
    assert!(!shell
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains("Reload"));
    assert!(shell.error_message.is_none());

    // Unknown id -> NOT_FOUND surfaced as the machine-readable code.
    session.apply_shell_action(ShellAction::RestoreBackup(
        "00000000-0000-1000-8000-000000000000".into(),
    ));
    assert_eq!(
        session.shell_view().error_message.as_deref(),
        Some("NOT_FOUND")
    );

    // Default wire has no backups -> honest empty state, no error.
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::default(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("data".into()));
    let shell = session.shell_view();
    assert!(shell.backups.is_empty());
    assert!(shell.error_message.is_none());
}

#[test]
fn memories_crud_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("memories".into()));
    let shell = session.shell_view();
    assert_eq!(shell.ai_tab, "memories");
    assert!(
        session
            .issued_commands()
            .iter()
            .any(|op| op == "memories.list"),
        "opening the Memories tab loads the list"
    );
    assert_eq!(shell.memories.len(), 2);
    assert!(shell.memories[0].meta.starts_with("Global"));
    assert!(!shell.memories[1].enabled);

    // Toggle -> partial update with only `enabled`.
    let toggle_id = shell.memories[1].id.clone();
    session.apply_shell_action(ShellAction::MemoryToggle(toggle_id));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "memories.update"));
    assert!(session.shell_view().memories[1].enabled);

    // Create form: type content, add -> memories.create + refreshed list.
    session.set_memory_draft_content("The docks flood at high tide.");
    session.apply_shell_action(ShellAction::MemorySave);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "memories.create"));
    let shell = session.shell_view();
    assert_eq!(shell.memories.len(), 3);
    assert!(shell.memory_edit_id.is_none());
    assert!(shell.memories[2].content.contains("docks"));

    // Empty content is rejected client-side without a wire call.
    let create_calls = session
        .issued_commands()
        .iter()
        .filter(|op| **op == "memories.create")
        .count();
    session.apply_shell_action(ShellAction::MemorySave);
    assert_eq!(
        session.shell_view().memory_form_error.as_deref(),
        Some("Memory content is required.")
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "memories.create")
            .count(),
        create_calls,
        "validation failure must not reach the wire"
    );

    // Edit flow: prefill from the card, save via the wire.
    let edit_target = shell.memories[0].id.clone();
    session.apply_shell_action(ShellAction::MemoryEditOpen(edit_target.clone()));
    let shell = session.shell_view();
    assert_eq!(
        shell.memory_draft_content,
        "The city sleeps under a permanent curfew; the vigilantes own the dark."
    );
    session.apply_shell_action(ShellAction::MemoryEditCancel);
    assert!(session.shell_view().memory_edit_id.is_none());

    // Delete: confirm dialog -> memories.delete removes the row.
    session.apply_shell_action(ShellAction::MemoryDeleteOpen(edit_target.clone()));
    assert!(session.shell_view().memory_delete_open);
    session.apply_shell_action(ShellAction::MemoryDeleteConfirm);
    let shell = session.shell_view();
    assert!(!shell.memory_delete_open);
    assert!(
        shell.memories.iter().all(|item| item.id != edit_target),
        "confirm delete removes the memory"
    );
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "memories.delete"));
}

#[test]
fn generation_preset_management_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("presets".into()));
    let shell = session.shell_view();
    assert_eq!(shell.ai_tab, "presets");
    assert_eq!(shell.presets.len(), 2);
    assert!(shell.preset_active_name.is_none());
    assert_eq!(shell.preset_rows.len(), 13);

    // Select -> settings.update carries the id AND the preset values
    // (maxContextTokens + generationDefaults), like React selectPreset.
    let balanced = shell.presets.iter().find(|item| item.name == "Balanced");
    let balanced_id = balanced.expect("Balanced seeded").id.clone();
    session.apply_shell_action(ShellAction::SelectPreset(balanced_id.clone()));
    let shell = session.shell_view();
    assert_eq!(
        shell.selected_preset_id.as_deref(),
        Some(balanced_id.as_str())
    );
    assert_eq!(shell.preset_active_name.as_deref(), Some("Balanced"));
    assert_eq!(
        shell
            .preset_rows
            .iter()
            .find(|row| row.label == "Temperature")
            .map(|row| row.value.as_str()),
        Some("0.80")
    );
    assert_eq!(
        shell
            .preset_rows
            .iter()
            .find(|row| row.label == "Context size")
            .map(|row| row.value.as_str()),
        Some("8192")
    );

    // Duplicate -> presets.create with " (copy)" + becomes active.
    session.apply_shell_action(ShellAction::PresetDuplicate);
    let shell = session.shell_view();
    assert_eq!(shell.presets.len(), 3);
    assert_eq!(shell.preset_active_name.as_deref(), Some("Balanced (copy)"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.create"));

    // Rename via the name dialog.
    session.apply_shell_action(ShellAction::PresetRenameOpen);
    assert!(session.shell_view().preset_name_dialog_open);
    session.set_preset_name_draft("Renamed copy");
    session.apply_shell_action(ShellAction::PresetNameSubmit);
    let shell = session.shell_view();
    assert!(!shell.preset_name_dialog_open);
    assert_eq!(shell.preset_active_name.as_deref(), Some("Renamed copy"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.update"));

    // Apply writes the draft values through settings.update.
    session.apply_shell_action(ShellAction::PresetApply);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Generation settings applied.")
    );

    // Delete confirm -> presets.delete + selection cleared.
    session.apply_shell_action(ShellAction::PresetDeleteOpen);
    assert!(session.shell_view().preset_delete_open);
    session.apply_shell_action(ShellAction::PresetDeleteConfirm);
    let shell = session.shell_view();
    assert!(!shell.preset_delete_open);
    assert!(shell.selected_preset_id.is_none());
    assert_eq!(shell.presets.len(), 2);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.delete"));
}

#[test]
fn generation_preset_import_export_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    use neotavern_presentation_m0_d2::inspect_slot_skeleton;
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1100, 760, 1.0);
    session.apply_shell_action(ShellAction::SetPanel("providers".into()));
    session.apply_shell_action(ShellAction::SetTab("presets".into()));
    let balanced_id = session
        .shell_view()
        .presets
        .iter()
        .find(|item| item.name == "Balanced")
        .expect("Balanced")
        .id
        .clone();
    session.apply_shell_action(ShellAction::SelectPreset(balanced_id));

    let shell = session.shell_view();
    match hit_test(&shell, 124.0, 262.0) {
        Some(ShellHit::Action(ShellAction::PresetImportOpen)) => {}
        other => panic!("expected PresetImportOpen, got {other:?}"),
    }
    match hit_test(&shell, 228.0, 262.0) {
        Some(ShellHit::Action(ShellAction::PresetExport)) => {}
        other => panic!("expected PresetExport, got {other:?}"),
    }

    let before_create = session
        .issued_commands()
        .iter()
        .filter(|op| *op == "presets.create")
        .count();
    session.apply_shell_action(ShellAction::PresetExport);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "presets.create")
            .count(),
        before_create,
        "export is host-owned JSON, not a wire op"
    );
    let export = session.take_last_export().expect("parked export");
    assert_eq!(export.filename, "Balanced.json");
    let doc: serde_json::Value =
        serde_json::from_slice(&export.bytes).expect("valid export document");
    assert_eq!(
        doc.get("version").and_then(serde_json::Value::as_u64),
        Some(1)
    );
    assert_eq!(
        doc.get("kind").and_then(serde_json::Value::as_str),
        Some("generation")
    );
    assert_eq!(
        doc.get("name").and_then(serde_json::Value::as_str),
        Some("Balanced")
    );
    assert_eq!(
        doc.pointer("/data/maxContextTokens")
            .and_then(serde_json::Value::as_i64),
        Some(8192)
    );
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Export ready: Balanced.json.")
    );

    session.apply_shell_action(ShellAction::PresetImportOpen);
    assert!(session.shell_view().generation_preset_import_open);
    session.apply_shell_action(ShellAction::PresetImportConfirm);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Provide a generation preset JSON file from this device.")
    );
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| *op == "presets.create")
            .count(),
        before_create,
        "empty path does not create a preset"
    );

    let import_path = std::env::temp_dir().join(format!(
        "neota-test-generation-preset-{}.json",
        std::process::id()
    ));
    std::fs::write(&import_path, &export.bytes).expect("write export");
    session.set_generation_preset_path_draft(&import_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PresetImportConfirm);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "presets.create"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "settings.update"));
    let shell = session.shell_view();
    assert!(!shell.generation_preset_import_open);
    assert_eq!(shell.presets.len(), 3);
    assert_eq!(shell.preset_active_name.as_deref(), Some("Balanced"));
    assert_eq!(shell.status_message.as_deref(), Some("Imported Balanced."));
    assert_eq!(
        shell
            .preset_rows
            .iter()
            .find(|row| row.label == "Context size")
            .map(|row| row.value.as_str()),
        Some("8192")
    );

    session.apply_shell_action(ShellAction::PresetImportOpen);
    let bad_path = std::env::temp_dir().join(format!(
        "neota-test-generation-preset-bad-{}.json",
        std::process::id()
    ));
    std::fs::write(&bad_path, "{not json").expect("write invalid");
    session.set_generation_preset_path_draft(&bad_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PresetImportConfirm);
    assert_eq!(
        session.shell_view().preset_form_error.as_deref(),
        Some("This file is not a valid generation preset.")
    );
    assert!(session.shell_view().generation_preset_import_open);

    let incomplete_path = std::env::temp_dir().join(format!(
        "neota-test-generation-preset-incomplete-{}.json",
        std::process::id()
    ));
    std::fs::write(
        &incomplete_path,
        serde_json::json!({
            "version": 1,
            "kind": "generation",
            "name": "Broken",
            "data": { "maxContextTokens": 8192 }
        })
        .to_string(),
    )
    .expect("write incomplete");
    session.set_generation_preset_path_draft(&incomplete_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PresetImportConfirm);
    assert_eq!(
        session.shell_view().preset_form_error.as_deref(),
        Some("This file is not a valid generation preset.")
    );

    let raw_path = std::env::temp_dir().join(format!(
        "neota-test-generation-preset-raw-{}.json",
        std::process::id()
    ));
    let data = doc.get("data").cloned().expect("export data");
    std::fs::write(&raw_path, data.to_string()).expect("write raw");
    session.set_generation_preset_path_draft(&raw_path.to_string_lossy());
    session.apply_shell_action(ShellAction::PresetImportConfirm);
    assert!(!session.shell_view().generation_preset_import_open);
    assert_eq!(session.shell_view().presets.len(), 4);
    let raw_name = raw_path.file_stem().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        session.shell_view().preset_active_name.as_deref(),
        Some(raw_name.as_str())
    );

    let _ = std::fs::remove_file(&import_path);
    let _ = std::fs::remove_file(&bad_path);
    let _ = std::fs::remove_file(&incomplete_path);
    let _ = std::fs::remove_file(&raw_path);

    session.apply_shell_action(ShellAction::PresetImportOpen);
    neotavern_presentation_dioxus_shell::install_product_shell(session.shell_view());
    let skeleton = inspect_slot_skeleton(product_shell_app, 1100, 760, 1.0, session.insets())
        .expect("slot skeleton");
    assert!(
        skeleton.has_identity("preset-import"),
        "missing preset-import; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("preset-export"),
        "missing preset-export; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("generation-preset-import"),
        "missing generation-preset-import; identities={:?}",
        skeleton.identities()
    );
    assert!(
        skeleton.has_identity("generation-preset-path-input"),
        "missing generation-preset-path-input; identities={:?}",
        skeleton.identities()
    );
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

/// Inline message edit (React `MessageBubble` editing branch) over
/// `chats.messages.update`: a changed draft updates the stored content and
/// records the previous text as a revision; empty/unchanged drafts close the
/// editor without a wire call. `chats.messages.revisions.list` reads the
/// immutable history back; a foreign id surfaces MESSAGE_NOT_FOUND.
#[test]
fn message_edit_records_revisions_over_product_wire() {
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    assert_eq!(session.kernel_message_count(), 6);
    let target = session.view().visible[0].id.clone();
    let original = session
        .view()
        .visible
        .iter()
        .find(|row| row.id == target)
        .expect("row")
        .content
        .clone();

    // Edit: seed -> type -> save. The visible content changes.
    session.start_message_edit(&target);
    assert_eq!(
        session.view().editing_message_id.as_deref(),
        Some(target.as_str())
    );
    assert_eq!(session.view().editing_draft, original);
    session.set_message_edit_draft(&format!("{original} (edited)"));
    session.submit_message_edit();
    assert!(session.view().editing_message_id.is_none());
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.messages.update"));
    let edited = session
        .view()
        .visible
        .iter()
        .find(|row| row.id == target)
        .expect("row")
        .content
        .clone();
    assert_eq!(edited, format!("{original} (edited)"));
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Message updated.")
    );

    // Unchanged submit: editor closes WITHOUT another wire call.
    session.start_message_edit(&target);
    session.submit_message_edit();
    assert!(session.view().editing_message_id.is_none());
    let update_calls = session
        .issued_commands()
        .iter()
        .filter(|op| **op == "chats.messages.update")
        .count();
    assert_eq!(update_calls, 1);

    // Empty draft behaves like cancel (React parity).
    session.start_message_edit(&target);
    session.set_message_edit_draft("");
    session.submit_message_edit();
    assert!(session.view().editing_message_id.is_none());
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "chats.messages.update")
            .count(),
        1
    );

    // History: exactly one revision (the original text), oldest first.
    session.open_message_history(&target);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.messages.revisions.list"));
    assert_eq!(
        session.view().history_open_for.as_deref(),
        Some(target.as_str())
    );
    let history = session.view().revision_history.clone();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].content, original);
    session.close_message_history();
    assert!(session.view().history_open_for.is_none());
    assert!(session.view().revision_history.is_empty());

    // Foreign ids surface honest wire errors.
    session.open_message_history("00000000-0000-4000-8000-000000000009");
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("MESSAGE_NOT_FOUND")
    );
}

/// Chat snapshots (React `ChatSnapshotsMenu` + builtin checkpoint/branch
/// actions) over `chats.snapshots.create/list`: a checkpoint/branch freezes
/// the prefix into a real child chat (visible in the chats list and the
/// snapshots menu), opening a row switches to that chat, a tap outside the
/// menu closes it. A foreign id surfaces MESSAGE_NOT_FOUND.
#[test]
fn chat_snapshots_checkpoint_branch_over_product_wire() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.set_surface_size(1100, 760, 1.0);
    assert_eq!(session.kernel_message_count(), 6);
    let visible = session.view().visible;
    let branch_target = visible[0].id.clone();
    let checkpoint_target = visible[2].id.clone();
    let chats_before = session.shell_view().chat_list.len();

    // Checkpoint on visible[2]: prefix of 3 messages copied into a child.
    session.create_message_snapshot(&checkpoint_target, true);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.snapshots.create"));
    assert!(session
        .shell_view()
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains("Checkpoint created"));
    assert_eq!(session.kernel_message_count(), 6);
    let shell = session.shell_view();
    assert_eq!(shell.chat_list.len(), chats_before + 1);

    // Branch on visible[0]: single-message child.
    session.create_message_snapshot(&branch_target, false);
    assert!(session
        .shell_view()
        .status_message
        .as_deref()
        .unwrap_or("")
        .contains("Branch created"));

    // Menu: two children, newest first (branch was created last).
    session.toggle_snapshots_menu();
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.snapshots.list"));
    let view = session.view();
    assert!(view.snapshots_menu_open);
    assert_eq!(view.snapshot_items.len(), 2);
    assert_eq!(view.snapshot_items[0].origin_label, "Branch");
    assert_eq!(view.snapshot_items[1].origin_label, "Checkpoint");
    assert_eq!(view.snapshot_items[1].message_count, 3);

    // Open the checkpoint child through its menu action.
    let child_id = view.snapshot_items[1].id.clone();
    session.apply_shell_action(ShellAction::OpenSnapshot(child_id.clone()));
    assert!(!session.view().snapshots_menu_open);
    assert_eq!(session.kernel_message_count(), 3);

    // Outside tap closes the reopened menu.
    session.toggle_snapshots_menu();
    let shell = session.shell_view();
    match hit_test(&shell, 800.0, 400.0) {
        Some(ShellHit::Action(ShellAction::SnapshotsClose)) => {}
        other => panic!("expected outside-close hit, got {other:?}"),
    }
    session.apply_shell_action(ShellAction::SnapshotsClose);
    assert!(!session.view().snapshots_menu_open);

    // Foreign ids surface honest wire errors.
    session.create_message_snapshot("00000000-0000-4000-8000-000000000009", true);
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("MESSAGE_NOT_FOUND")
    );

    // A chat without snapshots lists an honest empty page.
    session.apply_shell_action(ShellAction::OpenSnapshot(child_id));
    session.toggle_snapshots_menu();
    assert!(session.view().snapshot_items.is_empty());
}

/// `chats.export` (React `ChatManagementPanel` "Export"): the wire returns a
/// kind-tagged JSON document as base64; the session decodes it into
/// `last_export`, the chats-panel row action drives it, and a foreign id
/// surfaces CHAT_NOT_FOUND.
#[test]
fn chat_export_over_product_wire() {
    use base64::Engine as _;
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::with_message_count(6),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    let chat_id = neotavern_presentation_chat::DEMO_CHAT_ID.to_string();

    session.apply_shell_action(ShellAction::ExportChat(chat_id.clone()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "chats.export"));
    let shell = session.shell_view();
    assert!(shell
        .status_message
        .as_deref()
        .unwrap_or("")
        .starts_with("Export ready:"));
    let export = session.take_last_export().expect("parked export");
    assert_eq!(export.filename, format!("chat-{chat_id}.json"));
    let doc: serde_json::Value =
        serde_json::from_slice(&export.bytes).expect("valid export document");
    assert_eq!(
        doc.get("kind").and_then(serde_json::Value::as_str),
        Some("neotavern-chat-export")
    );
    // The sink handoff consumed the parked payload.
    assert!(session.state().last_export.is_none());

    // Foreign chat: honest wire error, nothing parked.
    session.apply_shell_action(ShellAction::ExportChat(
        "00000000-0000-4000-8000-000000000009".into(),
    ));
    assert_eq!(session.view().error_code.as_deref(), Some("CHAT_NOT_FOUND"));
    assert!(session.state().last_export.is_none());
}

/// Book editor (React `LorebookPanel` BookTab) over `lorebooks.update`:
/// only changed fields cross the wire, an empty trimmed name keeps the
/// stored one, a no-op save skips the wire call entirely.
#[test]
fn lorebook_meta_update_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.apply_shell_action(ShellAction::SetPanel("lorebooks".into()));
    assert!(!session.shell_view().lorebooks.is_empty());
    let book = session.shell_view().lorebooks[0].clone();
    session.select_lorebook(&book.id);
    assert_eq!(session.shell_view().lorebook_tab, "book");
    assert_eq!(session.shell_view().lorebook_name_draft, book.name);

    // Change name + description -> one wire call with both fields.
    session.set_lorebook_name_draft(&format!("{} v2", book.name));
    session.set_lorebook_description_draft("Updated description");
    session.apply_shell_action(ShellAction::LorebookSaveMeta);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "lorebooks.update"));
    let shell = session.shell_view();
    let card = shell
        .lorebooks
        .iter()
        .find(|item| item.id == book.id)
        .expect("card");
    assert_eq!(card.name, format!("{} v2", book.name));
    assert_eq!(shell.lorebook_description_draft, "Updated description");
    assert_eq!(shell.status_message.as_deref(), Some("Book updated."));

    // No-op save: drafts match the store -> no second wire call.
    session.set_lorebook_name_draft(&format!("{} v2", book.name));
    session.set_lorebook_description_draft("Updated description");
    session.apply_shell_action(ShellAction::LorebookSaveMeta);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "lorebooks.update")
            .count(),
        1
    );

    // Empty trimmed name keeps the stored one; description-only update.
    session.set_lorebook_name_draft("   ");
    session.set_lorebook_description_draft("Rewritten again");
    session.apply_shell_action(ShellAction::LorebookSaveMeta);
    let shell = session.shell_view();
    let card = shell
        .lorebooks
        .iter()
        .find(|item| item.id == book.id)
        .expect("card");
    assert_eq!(card.name, format!("{} v2", book.name));
    assert_eq!(shell.status_message.as_deref(), Some("Book updated."));
}

/// Persona editor (React `PersonasPanel` edit tab) over `personas.update`:
/// only changed fields cross the wire, an empty trimmed name keeps the
/// stored one, a no-op save skips the wire call.
#[test]
fn persona_meta_update_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.apply_shell_action(ShellAction::SetPanel("personas".into()));
    assert!(!session.shell_view().personas.is_empty());
    let persona = session.shell_view().personas[0].clone();
    session.select_persona(&persona.id);
    assert_eq!(session.shell_view().persona_tab, "edit");
    assert_eq!(session.shell_view().persona_name_draft, persona.name);

    // Change name + description -> one wire call with both fields.
    session.set_persona_name_draft(&format!("{} v2", persona.name));
    session.set_persona_description_draft("A weathered caravan mapmaker.");
    session.apply_shell_action(ShellAction::PersonaSaveMeta);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "personas.update"));
    let shell = session.shell_view();
    let card = shell
        .personas
        .iter()
        .find(|item| item.id == persona.id)
        .expect("card");
    assert_eq!(card.name, format!("{} v2", persona.name));
    assert_eq!(
        shell.persona_description_draft,
        "A weathered caravan mapmaker."
    );
    assert_eq!(shell.status_message.as_deref(), Some("Persona updated."));

    // No-op save: drafts match the store -> no second wire call.
    session.set_persona_name_draft(&format!("{} v2", persona.name));
    session.set_persona_description_draft("A weathered caravan mapmaker.");
    session.apply_shell_action(ShellAction::PersonaSaveMeta);
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "personas.update")
            .count(),
        1
    );
}

/// Character-card import/export over Product Wire: `assets.put` (kind
/// `card`) stages the file, `imports.character.card` parses + dedupes by
/// content sha256 (re-import reports `created == false`), and
/// `characters.export.card` returns the SillyTavern container that parks in
/// `last_export` for the host's file sink.
#[test]
fn character_card_import_export_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.apply_shell_action(ShellAction::SetPanel("characters".into()));
    let count_before = session.shell_view().characters.len();

    // Stage a V2 JSON card on disk and import it through the dialog flow.
    let card_path =
        std::env::temp_dir().join(format!("neota-test-card-{}.json", std::process::id()));
    std::fs::write(
        &card_path,
        serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": "Imported Wanderer",
                "description": "A road-worn cartographer.",
                "tags": ["test"]
            }
        })
        .to_string(),
    )
    .expect("write card");

    session.open_card_import();
    assert!(session.shell_view().card_import_dialog_open);
    session.apply_shell_action(ShellAction::ConfirmCardImport);
    assert!(session.view().error_code.is_none());
    session.set_card_path_draft(&card_path.to_string_lossy());
    session.apply_shell_action(ShellAction::ConfirmCardImport);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "assets.put"));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "imports.character.card"));
    let shell = session.shell_view();
    assert!(!shell.card_import_dialog_open);
    assert_eq!(
        shell.status_message.as_deref(),
        Some("Imported Imported Wanderer.")
    );
    assert_eq!(shell.characters.len(), count_before + 1);
    let imported = shell
        .characters
        .iter()
        .find(|item| item.name == "Imported Wanderer")
        .expect("imported card");
    let imported_id = imported.id.clone();

    // Re-import the same content: kernel dedupe -> created == false.
    session.open_card_import();
    session.set_card_path_draft(&card_path.to_string_lossy());
    session.apply_shell_action(ShellAction::ConfirmCardImport);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Already imported (Imported Wanderer).")
    );
    assert_eq!(session.shell_view().characters.len(), count_before + 1);
    let _ = std::fs::remove_file(&card_path);

    // Export the imported card back out as JSON.
    session.apply_shell_action(ShellAction::ExportCharacterCard(imported_id.clone()));
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "characters.export.card"));
    let export = session.take_last_export().expect("parked export");
    assert_eq!(export.filename, format!("card-{imported_id}.json"));
    let doc: serde_json::Value =
        serde_json::from_slice(&export.bytes).expect("valid export document");
    assert_eq!(
        doc.pointer("/data/name")
            .and_then(serde_json::Value::as_str),
        Some("Imported Wanderer")
    );

    // Foreign ids surface honest wire errors.
    session.apply_shell_action(ShellAction::ExportCharacterCard(
        "00000000-0000-4000-8000-000000000009".into(),
    ));
    assert_eq!(
        session.view().error_code.as_deref(),
        Some("CHARACTER_NOT_FOUND")
    );
}

/// Profile container import (React `ProfilesPanel` import form) over
/// `profile.import`: path + duplicate policy, honest empty pass on the fake,
/// status notice with counters; an empty path stays client-side.
#[test]
fn profile_import_over_product_wire() {
    use neotavern_presentation_chat::ShellAction;
    let (mut session, _) = start_flagged_session(
        Some("1"),
        FakeWire::demo(),
        Some(neotavern_presentation_chat::DEMO_CHAT_ID),
        None,
    )
    .expect("route");
    session.apply_shell_action(ShellAction::SetPanel("settings".into()));
    session.apply_shell_action(ShellAction::SetTab("profiles".into()));

    // Empty path: client-side hint, no wire call.
    session.apply_shell_action(ShellAction::ProfileImportSubmit);
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Provide the container path staged under the data root.")
    );
    let imports_before = session
        .issued_commands()
        .iter()
        .filter(|op| **op == "profile.import")
        .count();

    // Path + policy cycle -> wire op with counters in the notice.
    session.set_profile_import_path("imports/profile-2c2c/");
    assert_eq!(session.shell_view().profile_import_policy_label, "Reject");
    session.apply_shell_action(ShellAction::ProfileImportPolicyCycle);
    assert_eq!(session.shell_view().profile_import_policy_label, "Replace");
    session.apply_shell_action(ShellAction::ProfileImportSubmit);
    assert!(session
        .issued_commands()
        .iter()
        .any(|op| op == "profile.import"));
    assert_eq!(
        session
            .issued_commands()
            .iter()
            .filter(|op| **op == "profile.import")
            .count(),
        imports_before + 1
    );
    assert_eq!(
        session.shell_view().status_message.as_deref(),
        Some("Imported: 0 inserted, 0 updated, 0 skipped.")
    );
    // The path clears after a successful import, like React.
    assert!(session.shell_view().profile_import_path.is_empty());
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
