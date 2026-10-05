//! ADR-0057 Phase 1 chat-screen pilot: the first product surface mounted
//! on the presentation-scene platform core.
//!
//! This crate is a thin projection: it maps `ChatSession` route state to a
//! retained [`Scene`] and routes host input back through the session's
//! existing command surface (platform spec §8 — the command surface
//! survives). Product truth (messages, drafts, streaming) stays in the
//! session/wire; caret/selection editing state lives in exactly one place
//! — the scene's editor core (INV-1). Geometry lives in exactly one place
//! — the [`FrameSnapshot`] (INV-2). Paint goes through exactly one path —
//! `render::render_frame` (INV-3).
//!
//! The pilot is NOT the shipped desktop UI: the legacy contour still
//! ships until the ADR-0057 phase gates.

use std::collections::HashMap;

use neotavern_presentation_chat::ChatSession;
use neotavern_presentation_scene::hit::{self, HitTarget};
use neotavern_presentation_scene::layout::SceneLayouter;
use neotavern_presentation_scene::scene::{NodeKind, Scene, SceneAction, SceneNode, TextRun};
use neotavern_presentation_scene::snapshot::FrameSnapshot;
use neotavern_presentation_scene::style::{
    ColorToken, ControlHeightToken, NodeLayout, Padding, RadiusToken, SizeToken, SpacingToken,
    TextTokens,
};
use neotavern_presentation_scene::text::TextEngine;
use neotavern_presentation_scene::{CursorOp, Editor, FieldId, SceneId};

#[cfg(feature = "desktop-host")]
pub mod desktop;

use contracts_generated::generated::MessageRole;

/// `SceneAction` id of the send button.
pub const ACTION_SEND: u64 = 1;

/// The pilot chat surface: retained scene + the per-frame pipeline.
pub struct ChatPilot {
    scene: Scene,
    layouter: SceneLayouter,
    engine: TextEngine,
    theme: neotavern_presentation_scene::Theme,
    /// Stable per-message node ids (a row that stays in the list keeps its
    /// scene node across frames; the map key is the durable message id).
    rows: HashMap<String, SceneId>,
    // Fixed surface anchors, allocated once at construction.
    header: SceneId,
    messages: SceneId,
    streaming: SceneId,
    composer_input: SceneId,
    send_button: SceneId,
}

impl ChatPilot {
    pub fn new() -> Self {
        let mut scene = Scene::new();
        let root = scene.root();
        scene.node_mut(root).expect("root exists").layout = NodeLayout::column()
            .with_padding(Padding::hv(SpacingToken::Md, SpacingToken::Md))
            .with_gap(SpacingToken::Sm);

        let header = scene.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("", TextTokens::title())])
                .with_role(neotavern_presentation_scene::A11yRole::Heading),
        );
        let messages = scene.append_child(
            root,
            SceneNode::container(
                NodeLayout::column()
                    .with_grow(1.0)
                    .with_gap(SpacingToken::Sm),
            ),
        );
        // The streaming row exists once and is emptied/reused — its
        // content changes per frame but its scene id is stable.
        let streaming = scene.append_child(
            root,
            SceneNode::text(vec![TextRun::plain("", TextTokens::body())])
                .with_role(neotavern_presentation_scene::A11yRole::Text),
        );
        let composer_row = scene.append_child(
            root,
            SceneNode::container(NodeLayout::row().with_gap(SpacingToken::Sm)),
        );
        let composer_input = scene.append_child(
            composer_row,
            SceneNode {
                kind: NodeKind::Input {
                    field: FieldId::Composer,
                    placeholder: "type…".into(),
                },
                layout: NodeLayout::row()
                    .with_height(SizeToken::Height(ControlHeightToken::Control))
                    .with_grow(1.0),
                radius: Some(RadiusToken::Control),
                border: Some(ColorToken::Border),
                role: neotavern_presentation_scene::A11yRole::Input,
                name: "chat composer".into(),
                ..SceneNode::container(NodeLayout::row())
            },
        );
        let send_button = scene.append_child(
            composer_row,
            SceneNode {
                kind: NodeKind::Button {
                    label: vec![TextRun::plain("send", TextTokens::body())],
                },
                layout: NodeLayout::row()
                    .with_height(SizeToken::Height(ControlHeightToken::Control)),
                radius: Some(RadiusToken::Control),
                background: Some(ColorToken::Accent),
                role: neotavern_presentation_scene::A11yRole::Button,
                name: "send message".into(),
                action: Some(SceneAction(ACTION_SEND)),
                ..SceneNode::container(NodeLayout::row())
            },
        );
        Self {
            scene,
            layouter: SceneLayouter::new(),
            engine: TextEngine::new(),
            theme: neotavern_presentation_scene::Theme::golden_dark(),
            rows: HashMap::new(),
            header,
            messages,
            streaming,
            composer_input,
            send_button,
        }
    }

    /// Projects the session's route state into the retained scene. Idempotent:
    /// unchanged messages keep their scene nodes; only diffs touch the tree.
    pub fn project(
        &mut self,
        session: &ChatSession<impl neotavern_presentation_chat::ProductWire>,
    ) {
        let state = session.state();

        // Header: chat title.
        let title = state
            .chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_default();
        if let Some(node) = self.scene.node_mut(self.header) {
            node.kind = NodeKind::Text {
                runs: vec![TextRun::plain(title, TextTokens::title())],
            };
        }

        // Messages: keyed by durable id — append new rows in order, remove
        // gone rows. Existing rows keep their nodes (text swap only).
        let mut seen: Vec<String> = Vec::new();
        for message in &state.messages {
            seen.push(message.id.clone());
            let run = TextRun::plain(
                message.content.clone(),
                TextTokens::body().with_color(match message.role {
                    MessageRole::User => ColorToken::TextPrimary,
                    _ => ColorToken::TextSecondary,
                }),
            );
            match self.rows.get(&message.id) {
                Some(&row_id) => {
                    if let Some(node) = self.scene.node_mut(row_id) {
                        node.kind = NodeKind::Text { runs: vec![run] };
                    }
                }
                None => {
                    let row_id = self.scene.append_child(
                        self.messages,
                        SceneNode::text(vec![run])
                            .with_role(neotavern_presentation_scene::A11yRole::ListItem),
                    );
                    self.rows.insert(message.id.clone(), row_id);
                }
            }
        }
        let stale: Vec<String> = self
            .rows
            .keys()
            .filter(|id| !seen.contains(id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(row_id) = self.rows.remove(&id) {
                self.scene.remove_child(self.messages, row_id);
            }
        }

        // Streaming row: visible only while text streams.
        if let Some(node) = self.scene.node_mut(self.streaming) {
            node.kind = NodeKind::Text {
                runs: if state.streaming_text.is_empty() {
                    vec![TextRun::plain("", TextTokens::body())]
                } else {
                    vec![TextRun::plain(
                        state.streaming_text.clone(),
                        TextTokens::body(),
                    )]
                },
            };
        }

        // Composer: hydrate from the session's single source of truth.
        // `hydrate_input` writes only on difference, so the editor's caret
        // survives every keystroke (INV-1: the caret lives only here).
        self.scene
            .hydrate_input(FieldId::Composer, &state.composer_text);
    }

    /// Runs layout + folds the snapshot — the single geometry of this frame
    /// (INV-2). Everything downstream (hit-test, digest, paint, a11y) reads
    /// the returned value; nothing recomputes positions.
    pub fn frame(&mut self, viewport: (f32, f32)) -> FrameSnapshot {
        let revision = self.scene.revision();
        let pass = self
            .layouter
            .layout(&self.scene, &self.theme, &mut self.engine, viewport);
        FrameSnapshot::from_pass(pass, &self.theme, &mut self.engine, revision)
    }

    /// Direct access to the composer editor (host bridges map key events
    /// to `CursorOp`s here — the single editing model, INV-4).
    pub fn composer(&mut self) -> &mut Editor {
        self.scene.input_mut(FieldId::Composer)
    }

    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Applies one editing op to the composer and routes the resulting
    /// text back through the session command surface (draft persistence,
    /// send). The caret never leaves the editor core.
    pub fn apply_composer_op(
        &mut self,
        session: &mut ChatSession<impl neotavern_presentation_chat::ProductWire>,
        op: CursorOp,
    ) {
        let editor = self.scene.input_mut(FieldId::Composer);
        editor.apply(op);
        let text = editor.text().to_string();
        let _ = session.set_composer_text(text);
    }

    /// Routes one hit through the pilot: clicks on the send button send,
    /// clicks in the composer position the caret. Returns the raw target
    /// for the host (focus, a11y).
    pub fn handle_hit(
        &mut self,
        session: &mut ChatSession<impl neotavern_presentation_chat::ProductWire>,
        snapshot: &FrameSnapshot,
        x: f32,
        y: f32,
    ) -> HitTarget {
        let target = hit::hit_test(snapshot, x, y);
        match target {
            HitTarget::Action { action, .. } if action == SceneAction(ACTION_SEND) => {
                let _ = session.send(None);
            }
            HitTarget::Field {
                field: FieldId::Composer,
                caret_byte,
                ..
            } => {
                let editor = self.scene.input_mut(FieldId::Composer);
                if let Some(byte) = caret_byte {
                    editor.apply(CursorOp::Position {
                        index: byte,
                        select: false,
                    });
                }
            }
            _ => {}
        }
        target
    }

    /// Hit rect of the send button in the last built snapshot (host
    /// probes, keyboard focus parity checks).
    pub fn send_button_rect(
        snapshot: &FrameSnapshot,
        node: SceneId,
    ) -> Option<neotavern_presentation_scene::snapshot::Rect> {
        snapshot.node(node).map(|node| node.rect)
    }
}

impl Default for ChatPilot {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatPilot {
    pub fn composer_input_id(&self) -> SceneId {
        self.composer_input
    }

    pub fn send_button_id(&self) -> SceneId {
        self.send_button
    }
}

#[cfg(feature = "gpu")]
impl ChatPilot {
    /// Encodes the snapshot into a vello scene — the single paint path
    /// (INV-3): the host owns the [`vello::Scene`] and the GPU surface,
    /// this maps snapshot geometry to vello draw commands and nothing
    /// else. `scale` is the device scale (DPI/density): the host rasters
    /// at `css × scale` physical pixels and samples 1:1 — the snapshot
    /// geometry itself stays CSS-px (INV-2).
    pub fn render(&self, snapshot: &FrameSnapshot, vello_scene: &mut vello::Scene, scale: f32) {
        neotavern_presentation_scene::render::render_frame_at_scale(
            snapshot,
            &self.theme,
            vello_scene,
            scale,
        );
    }

    pub fn theme(&self) -> &neotavern_presentation_scene::Theme {
        &self.theme
    }
}
