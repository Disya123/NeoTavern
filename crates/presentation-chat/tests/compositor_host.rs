//! Host compositor bind: Dioxus+Blitz once, then compositor-only ticks.

use neotavern_neocompositor::PresentationTime;
use neotavern_presentation_chat::{start_flagged_session, ChatCompositor, FakeWire};
use neotavern_presentation_dioxus_shell::{product_chat_app, product_shell_app};
use neotavern_presentation_m0_d2::{produce_app_at, produce_product_app_at};

#[test]
fn compositor_scroll_does_not_rebuild_dioxus_or_blitz() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::with_message_count(256), None, None)
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
    assert_eq!(shell.characters.len(), 1);
    assert_eq!(shell.characters[0].name, "Hazel");
    assert_eq!(shell.sort, "name");
    assert_eq!(shell.tab, "cards");
    assert!(
        shell.characters[0]
            .avatar_data_uri
            .as_deref()
            .is_some_and(|uri| uri.starts_with("data:image/png;base64,")
                && uri.len() <= neotavern_presentation_chat::AVATAR_DISPLAY_URI_MAX_CHARS),
        "Product Wire avatar must hydrate to a display-sized data URI"
    );
    assert_eq!(
        shell.pinned_character_id.as_deref(),
        Some(shell.characters[0].id.as_str())
    );
}

#[test]
fn character_manager_lists_kernel_characters_without_a_chat() {
    let (session, _) =
        start_flagged_session(Some("1"), FakeWire::character_catalog(), None, None)
            .expect("route");
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
    assert!(
        shell.characters[0]
            .avatar_data_uri
            .as_deref()
            .is_some_and(|uri| uri.starts_with("data:image/png;base64,")
                && uri.len() <= neotavern_presentation_chat::AVATAR_DISPLAY_URI_MAX_CHARS),
        "Product Wire avatar must hydrate to a display-sized data URI"
    );
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
fn shell_hit_rail_opens_not_yet_migrated_and_character_tabs() {
    use neotavern_presentation_chat::{hit_test, ShellAction, ShellHit};
    let (mut session, _) =
        start_flagged_session(Some("1"), FakeWire::demo(), None, None).expect("route");
    session.set_surface_size(1220, 2712, 3.0);
    let mut view = session.shell_view();
    view.chat.viewport_width = 407;
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
                    kind: DrawKind::Fill
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
    let hit = hit_test(&view, 80.0, 110.0);
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
    let hit = hit_test(&view, 140.0, 850.0);
    match hit {
        Some(ShellHit::Action(ShellAction::SetTab(tab))) => assert_eq!(tab, "cards"),
        other => panic!("expected Cards tab above home indicator, got {other:?}"),
    }
}
