//! Character Manager → vello::Scene adapter.
//!
//! Walks `UiSceneV1` and builds a `vello::Scene` with rectangles, colors, and
//! layout matching the phone theme. This is a real GPU raster through the same
//! `vello 0.9` / `wgpu 29` pipeline as Android — not HTML/SVG.

use vello::kurbo::{Affine, RoundedRect, Stroke};
use vello::peniko::{Color, Fill};
use vello::Scene;

use neotavern_presentation_blueprint::v1::{UiContentV1, UiNodeV1, UiSceneV1};

// Phone theme colors (matching the dark theme on device)
const BG: Color = Color::from_rgb8(15, 10, 8);
const SIDEBAR_BG: Color = Color::from_rgb8(26, 18, 14);
const CARD_BG: Color = Color::from_rgb8(26, 18, 14);
const CARD_SELECTED_BORDER: Color = Color::from_rgb8(255, 122, 26);
const BTN_PRIMARY: Color = Color::from_rgb8(255, 122, 26);
const BTN_SECONDARY: Color = Color::from_rgb8(42, 26, 18);
const INPUT_BG: Color = Color::from_rgb8(26, 14, 8);
const TAB_ACTIVE: Color = Color::from_rgb8(42, 18, 8);
const TAB_INACTIVE: Color = Color::from_rgb8(26, 14, 8);
const TEXT_MUTED: Color = Color::from_rgb8(90, 58, 32);
const ICON_ACTIVE: Color = Color::from_rgb8(255, 122, 26);

/// Build a `vello::Scene` from `UiSceneV1` for a compact 360×800 phone viewport.
pub fn build_cm_vello_scene(scene: &UiSceneV1, width: f64, height: f64) -> Scene {
    let mut vello_scene = Scene::new();
    // Background
    vello_scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        BG,
        None,
        &vello::kurbo::Rect::new(0.0, 0.0, width, height),
    );
    // Walk the root node tree, drawing rectangles for each node
    draw_node(&mut vello_scene, &scene.root, 0.0, 0.0, width, height);
    vello_scene
}

fn draw_node(scene: &mut Scene, node: &UiNodeV1, x: f64, y: f64, available_w: f64, available_h: f64) {
    let component = &node.hook.component;
    let part = node.hook.part.as_deref().unwrap_or("");
    let states = &node.hook.states;
    let content = &node.content;

    // Determine layout for this node based on component/part
    match component.as_str() {
        "character-management" if part.is_empty() => {
            // Root: sidebar + main area
            draw_sidebar(scene, x, y, 56.0, available_h);
            draw_node_children(scene, node, x + 56.0, y, available_w - 56.0, available_h);
        }
        "tabs" if part == "root" => {
            // Tab bar at the bottom of the panel
            let tab_y = y + available_h - 44.0;
            draw_tab_bar(scene, node, x, tab_y, available_w, 44.0);
        }
        "character-management" if part == "character-cards" => {
            // Cards area: toolbar + search + collection + load-more
            let mut cy = y;
            // Draw children in order
            for child in &node.children {
                let child_h = match child.hook.part.as_deref() {
                    Some("character-card-toolbar") => 44.0,
                    Some("search") => 40.0,
                    _ => {
                        // Collection and load-more share remaining space
                        let remaining = available_h - (cy - y);
                        if remaining > 0.0 { remaining } else { 100.0 }
                    }
                };
                draw_node(scene, child, x, cy, available_w, child_h);
                cy += child_h;
            }
        }
        "action-bar" if part == "character-card-toolbar" => {
            // Toolbar: + New | Import | A-Z
            draw_toolbar(scene, node, x, y, available_w, available_h);
        }
        "text-field" if part == "search" => {
            // Search input
            let rect = RoundedRect::new(x + 8.0, y + 2.0, x + available_w - 8.0, y + available_h - 2.0, 10.0);
            scene.fill(Fill::NonZero, Affine::IDENTITY, INPUT_BG, None, &rect);
            // Search icon placeholder
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                TEXT_MUTED,
                None,
                &vello::kurbo::Circle::new((x + 22.0, y + available_h / 2.0), 6.0),
            );
        }
        "character-management" if part == "character-cards" && node.id.ends_with(".collection") => {
            // Card collection
            let mut cy = y + 4.0;
            for child in &node.children {
                let card_h = 80.0;
                draw_node(scene, child, x + 8.0, cy, available_w - 16.0, card_h);
                cy += card_h + 8.0;
            }
        }
        "character-card" => {
            // Individual card
            let selected = states.contains(&"selected".to_string());
            let border_color = if selected { CARD_SELECTED_BORDER } else { TEXT_MUTED };
            let rect = RoundedRect::new(x, y, x + available_w, y + available_h, 12.0);
            scene.fill(Fill::NonZero, Affine::IDENTITY, CARD_BG, None, &rect);
            if selected {
                scene.stroke(
                    &Stroke::new(1.5),
                    Affine::IDENTITY,
                    border_color,
                    None,
                    &rect,
                );
            }
            // Avatar placeholder
            let avatar = RoundedRect::new(x + 10.0, y + 10.0, x + 50.0, y + 50.0, 8.0);
            scene.fill(Fill::NonZero, Affine::IDENTITY, SIDEBAR_BG, None, &avatar);
            // Character name initial
            if let UiContentV1::CharacterCard { character } = content {
                let _initial = character.name.chars().next().unwrap_or('?');
                // Draw initial as a colored circle
                let circle = vello::kurbo::Circle::new((x + 30.0, y + 30.0), 14.0);
                scene.fill(Fill::NonZero, Affine::IDENTITY, BTN_SECONDARY, None, &circle);
            }
            // Pin indicator
            if states.contains(&"pinned".to_string()) {
                let pin = vello::kurbo::Circle::new((x + available_w - 20.0, y + 20.0), 6.0);
                scene.fill(Fill::NonZero, Affine::IDENTITY, BTN_PRIMARY, None, &pin);
            }
        }
        "button" => {
            // Button
            let is_primary = part == "create";
            let color = if is_primary { BTN_PRIMARY } else { BTN_SECONDARY };
            let rect = RoundedRect::new(x + 4.0, y + 2.0, x + available_w - 4.0, y + available_h - 2.0, 16.0);
            scene.fill(Fill::NonZero, Affine::IDENTITY, color, None, &rect);
        }
        "character-view-toggle" => {
            // View toggle: list | grid
            let rect = RoundedRect::new(x, y, x + 64.0, y + available_h, 8.0);
            scene.fill(Fill::NonZero, Affine::IDENTITY, INPUT_BG, None, &rect);
        }
        _ => {
            // Generic node: draw a subtle background
            if available_w > 0.0 && available_h > 0.0 {
                let rect = RoundedRect::new(x, y, x + available_w, y + available_h.min(200.0), 4.0);
                scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(20, 14, 10), None, &rect);
            }
        }
    }

    // For non-container nodes, draw children within the same bounds
    if !matches!(component.as_str(), "character-management" | "tabs" | "action-bar" | "text-field" | "character-card") {
        // Don't draw children for leaf nodes
    }
}

fn draw_sidebar(scene: &mut Scene, x: f64, y: f64, w: f64, h: f64) {
    let rect = RoundedRect::new(x, y, x + w, y + h, 0.0);
    scene.fill(Fill::NonZero, Affine::IDENTITY, SIDEBAR_BG, None, &rect);
    // Rail icons (7 circles)
    for i in 0..7 {
        let icon_y = y + 18.0 + i as f64 * 46.0;
        let circle = vello::kurbo::Circle::new((x + 28.0, icon_y), 14.0);
        let color = if i == 2 { ICON_ACTIVE } else { Color::from_rgb8(107, 74, 42) };
        scene.fill(Fill::NonZero, Affine::IDENTITY, color, None, &circle);
    }
}

fn draw_toolbar(scene: &mut Scene, node: &UiNodeV1, x: f64, y: f64, _w: f64, h: f64) {
    let mut bx = x + 8.0;
    for child in &node.children {
        let btn_w = match child.hook.part.as_deref() {
            Some("create") => 72.0,
            Some("import") => 84.0,
            _ => 48.0,
        };
        draw_node(scene, child, bx, y + 4.0, btn_w, h - 8.0);
        bx += btn_w + 8.0;
    }
}

fn draw_tab_bar(scene: &mut Scene, node: &UiNodeV1, x: f64, y: f64, w: f64, h: f64) {
    let rect = RoundedRect::new(x, y, x + w, y + h, 0.0);
    scene.fill(Fill::NonZero, Affine::IDENTITY, INPUT_BG, None, &rect);
    let tab_w = w / node.children.len().max(1) as f64;
    for (i, child) in node.children.iter().enumerate() {
        let tx = x + i as f64 * tab_w;
        let active = child.hook.states.contains(&"active".to_string());
        let color = if active { TAB_ACTIVE } else { TAB_INACTIVE };
        let rect = RoundedRect::new(tx + 4.0, y + 6.0, tx + tab_w - 4.0, y + h - 6.0, 8.0);
        scene.fill(Fill::NonZero, Affine::IDENTITY, color, None, &rect);
    }
}

fn draw_node_children(scene: &mut Scene, node: &UiNodeV1, x: f64, y: f64, w: f64, h: f64) {
    // Simple vertical stack layout
    let mut cy = y;
    for child in &node.children {
        let child_h = h / node.children.len().max(1) as f64;
        draw_node(scene, child, x, cy, w, child_h);
        cy += child_h;
    }
}
