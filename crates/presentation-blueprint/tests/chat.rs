//! Chat surface blueprint: document parse + scene materialization (M2 slice).
//!
//! The canonical `chat` document lives with the other cross-language fixtures
//! (`packages/contracts/src/presentation/fixtures/`) and is parsed by both the
//! TypeScript normalizer tests and this Rust decoder — one source of truth.

use contracts_generated::generated::{FreeObject, MessageDto, MessageRole};
use neotavern_presentation_blueprint::{
    materialize_chat_scene_v1_from_document, ChatSurfaceStateV1, UiActionV1, UiBlueprintDocumentV1,
    UiSceneV1, ViewportClassV1,
};
use serde_json::json;

fn free_object() -> FreeObject {
    FreeObject {
        payload: json!({ "manualExcluded": false }),
    }
}

const CHAT_DOCUMENT_JSON: &str = include_str!(
    "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-chat-v1.json"
);
const CHARACTER_MANAGER_DOCUMENT_JSON: &str = include_str!(
    "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-v1.json"
);

fn message(id: &str, role: MessageRole, content: &str) -> MessageDto {
    MessageDto {
        id: id.to_owned(),
        chat_id: "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c".to_owned(),
        role,
        content: content.to_owned(),
        created_at: "2026-08-12T10:00:00Z".to_owned(),
        sequence: 0,
        generation_run_id: None,
        meta: free_object(),
        checkpoint_chat_id: None,
    }
}

fn state() -> ChatSurfaceStateV1 {
    ChatSurfaceStateV1 {
        revision: 7,
        messages: vec![
            message(
                "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
                MessageRole::User,
                "Hello there",
            ),
            message(
                "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
                MessageRole::Assistant,
                "General Kenobi.",
            ),
        ],
        composer_draft: "draft text".to_owned(),
        character_name: "Hazel".to_owned(),
        streaming: false,
    }
}

fn materialized() -> UiSceneV1 {
    let document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("chat document parses");
    materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
        .expect("scene")
}

#[test]
fn chat_document_parses_and_materializes_the_scene() {
    let scene = materialized();
    assert_eq!(scene.revision, 7);

    let paint_ids: Vec<&str> = scene
        .paint_tree
        .iter()
        .map(|node| node.id.as_str())
        .collect();
    for expected in [
        // Header / viewport ids mirror the authored document verbatim.
        "chat-header",
        "identity-title",
        "header-search",
        "chat-viewport",
        "chat-message-list",
        // One expanded row per Product Wire message, instantiated from the
        // authored template (full native row structure).
        "chat-message:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "chat-message:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.message-action-copy",
        "chat-message:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.message-bubble",
        "chat-message:b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.version-history",
        "chat-message:b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.swipe-next",
        // The composer subtree mirrors its authored node ids verbatim.
        "composer-toolbar",
        "composer-textarea",
        "composer-send",
    ] {
        assert!(
            paint_ids.contains(&expected),
            "missing paint node {expected}; have {paint_ids:?}"
        );
    }

    // Hit targets carry the shared decision-table actions.
    assert!(scene.hit_test_tree.iter().any(|target| target.action
        == UiActionV1::ChatMessageCopy {
            message_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d".to_owned()
        }));
    assert!(scene.hit_test_tree.iter().any(|target| target.action
        == UiActionV1::ChatMessageDelete {
            message_id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e".to_owned()
        }));
    assert!(scene.hit_test_tree.iter().any(|target| target.action
        == UiActionV1::ChatMessageRollback {
            message_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d".to_owned()
        }));
    assert!(scene
        .hit_test_tree
        .iter()
        .any(|t| t.id.ends_with(".version-regenerate")));
    assert!(scene.hit_test_tree.iter().any(|t| t.id == "composer-send"));
    assert!(scene
        .hit_test_tree
        .iter()
        .any(|t| t.id == "composer-settings"));
    assert!(scene
        .hit_test_tree
        .iter()
        .any(|t| t.id == "utility-scroll-latest"));

    // The composer draft is the single editable text interaction.
    assert_eq!(scene.text_interaction_tree.len(), 1);
    let textarea = &scene.text_interaction_tree[0];
    assert_eq!(textarea.id, "composer-textarea");
    assert_eq!(textarea.value, "draft text");
    assert_eq!(textarea.label_key, "chat:placeholder");
    assert!(textarea.editable);
}

#[test]
fn message_rows_carry_role_state_and_wire_effects() {
    let scene = materialized();
    let user_row = scene
        .paint_tree
        .iter()
        .find(|node| node.id == "chat-message:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")
        .expect("user row");
    assert!(user_row.hook.states.contains(&"user".to_owned()));
    // Copy stays a local intent; delete maps onto chats.messages.delete.
    assert_eq!(
        UiActionV1::ChatSend
            .wire_effect()
            .map(|effect| effect.operation_id),
        Some("chats.messages.create".to_owned())
    );
    assert_eq!(
        UiActionV1::ChatMessageDelete {
            message_id: "x".to_owned()
        }
        .wire_effect()
        .map(|effect| effect.operation_id),
        Some("chats.messages.delete".to_owned())
    );
    assert_eq!(UiActionV1::ChatComposerReset.wire_effect(), None);
    assert_eq!(UiActionV1::ChatComposerContext.wire_effect(), None);
}

#[test]
fn document_structure_drives_the_scene() {
    // Editing the canonical JSON — not Rust — must change the materialized
    // structure: this is the M2 contract ("UI changes are data changes").
    let mut document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("chat document parses");

    // 1. Removing the context trigger from the JSON removes it from the scene.
    let toolbar = document
        .root
        .children
        .iter_mut()
        .find(|node| node.node_id == "chat-composer")
        .and_then(|composer| {
            composer
                .children
                .iter_mut()
                .find(|node| node.node_id == "composer-toolbar")
        })
        .expect("composer-toolbar in fixture");
    toolbar
        .children
        .retain(|node| node.node_id != "composer-context");
    let scene =
        materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
            .expect("scene");
    assert!(!scene
        .paint_tree
        .iter()
        .any(|node| node.id == "composer-context"));
    assert!(!scene
        .hit_test_tree
        .iter()
        .any(|t| t.id == "composer-context"));

    // 2. Adding an unknown structural node still flows through as a generic
    // flow node (no action, no label) so structural edits never need a
    // simultaneous code change.
    let mut document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("chat document parses");
    let field = document
        .root
        .children
        .iter_mut()
        .find(|node| node.node_id == "chat-composer")
        .and_then(|composer| {
            composer
                .children
                .iter_mut()
                .find(|node| node.node_id == "composer-field")
        })
        .expect("composer-field in fixture");
    field.children.push(
        serde_json::from_value(json!({
            "nodeId": "composer-experimental-strip",
            "component": "ComposerExperimentalStrip",
            "recipe": "experimental",
            "stateSlots": [],
            "actions": [],
            "children": []
        }))
        .expect("experimental node"),
    );
    let scene =
        materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
            .expect("scene");
    let strip = scene
        .paint_tree
        .iter()
        .find(|node| node.id == "composer-experimental-strip")
        .expect("unknown nodes flow through the scene");
    assert_eq!(strip.hook.component, "chat-view");
    // Paint nodes carry no actions; the hit tree must not gain one either.
    assert!(!scene
        .hit_test_tree
        .iter()
        .any(|t| t.id == "composer-experimental-strip"));
}

#[test]
fn rejects_a_foreign_surface_document() {
    let document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHARACTER_MANAGER_DOCUMENT_JSON).expect("cm document parses");
    let err =
        materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
            .expect_err("character-manager document must not materialize as chat");
    assert!(err.contains("must be 'chat'"), "got: {err}");
}

#[test]
fn rejects_an_unexpected_responsive_layout() {
    use neotavern_presentation_blueprint::UiBlueprintDocumentResponsiveItemLayoutV1;
    let mut document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("chat document parses");
    document.responsive[2].layout = UiBlueprintDocumentResponsiveItemLayoutV1::RailResizablePanel;
    let err =
        materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
            .expect_err("rail-resizable-panel must not satisfy the chat matrix");
    assert!(err.contains("unexpected chat layout"), "got: {err}");
}

#[test]
fn authored_presentation_overrides_flow_into_the_scene() {
    fn find<'a>(
        node: &'a neotavern_presentation_blueprint::v1::UiNodeV1,
        id: &str,
    ) -> Option<&'a neotavern_presentation_blueprint::v1::UiNodeV1> {
        if node.id == id {
            return Some(node);
        }
        node.children.iter().find_map(|child| find(child, id))
    }

    let document: UiBlueprintDocumentV1 =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("chat document parses");
    let scene =
        materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
            .expect("scene");

    // The canonical fixture authors its composer presentation as data.
    let send = find(&scene.root, "composer-send").expect("send node present");
    let label = send.overrides.label.as_ref().expect("authored label");
    assert_eq!(label.text, "Send");
    assert_eq!(label.i18n_key.as_deref(), Some("chat.send"));
    assert_eq!(send.overrides.icon.as_deref(), Some("PaperPlaneRight"));
    // The semantic key prefers the authored i18n path over the table.
    assert_eq!(send.semantic.label_key.as_deref(), Some("chat.send"));

    // Editing only the JSON changes the realized presentation: same decoder,
    // same materializer, zero Rust changes.
    let mut doc: serde_json::Value =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("fixture json");
    fn find_mut<'a>(
        node: &'a mut serde_json::Value,
        id: &str,
    ) -> Option<&'a mut serde_json::Value> {
        if node.get("nodeId").and_then(|value| value.as_str()) == Some(id) {
            return Some(node);
        }
        node.get_mut("children")
            .and_then(|children| children.as_array_mut())
            .and_then(|children| children.iter_mut().find_map(|child| find_mut(child, id)))
    }
    let send_doc = find_mut(doc.get_mut("root").expect("root node"), "composer-send")
        .expect("composer-send in json");
    send_doc["label"] = json!({ "text": "Отправить", "i18nKey": "chat.send" });
    send_doc["icon"] = json!("ArrowDown");
    send_doc["styleRefs"] = json!([
        { "property": "background-color", "token": "var(--nt-accent-strong)" }
    ]);
    let edited: UiBlueprintDocumentV1 = serde_json::from_value(doc).expect("edited doc parses");
    let scene =
        materialize_chat_scene_v1_from_document(&edited, &state(), ViewportClassV1::Expanded)
            .expect("edited scene");
    let send = find(&scene.root, "composer-send").expect("send node present");
    assert_eq!(
        send.overrides.label.as_ref().expect("label").text,
        "Отправить"
    );
    assert_eq!(send.overrides.icon.as_deref(), Some("ArrowDown"));
    assert_eq!(send.overrides.style_refs.len(), 1);
    assert_eq!(send.overrides.style_refs[0].property, "background-color");
    assert_eq!(
        send.overrides.style_refs[0].token,
        "var(--nt-accent-strong)"
    );
}

#[test]
fn declarative_custom_intents_materialize_without_authority() {
    use neotavern_presentation_blueprint::v1::UiActionV1;

    fn find<'a>(
        node: &'a neotavern_presentation_blueprint::v1::UiNodeV1,
        id: &str,
    ) -> Option<&'a neotavern_presentation_blueprint::v1::UiNodeV1> {
        if node.id == id {
            return Some(node);
        }
        node.children.iter().find_map(|child| find(child, id))
    }

    let mut doc: serde_json::Value =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("fixture json");
    let send = find_mut_value(doc.get_mut("root").expect("root"), "composer-send")
        .expect("composer-send in json");
    send["actions"] = json!([
        { "id": "chat.send" },
        {
            "id": "custom.demo.pin-chat",
            "params": [
                { "key": "target", "value": "sidebar" },
                { "key": "priority", "value": "low" }
            ]
        }
    ]);
    let edited: UiBlueprintDocumentV1 = serde_json::from_value(doc).expect("edited parses");
    let scene =
        materialize_chat_scene_v1_from_document(&edited, &state(), ViewportClassV1::Expanded)
            .expect("scene");
    let node = find(&scene.root, "composer-send").expect("send node");
    match node.action.as_ref().expect("first action wins") {
        UiActionV1::ChatSend => {}
        other => panic!("expected ChatSend, got {other:?}"),
    }

    // Unknown BUILTIN ids fail loudly; unknown custom ids stay legal.
    let mut doc: serde_json::Value =
        serde_json::from_str(CHAT_DOCUMENT_JSON).expect("fixture json");
    let send = find_mut_value(doc.get_mut("root").expect("root"), "composer-send")
        .expect("composer-send in json");
    send["actions"] = json!([{ "id": "chat.sned" }]);
    let broken: Result<UiBlueprintDocumentV1, _> = serde_json::from_value(doc.clone());
    if let Ok(document) = broken {
        let err =
            materialize_chat_scene_v1_from_document(&document, &state(), ViewportClassV1::Expanded)
                .expect_err("typo'd builtin id must be rejected");
        assert!(err.contains("unknown chat action id"), "got: {err}");
    } else {
        // Decoder-level rejection is equally loud.
    }
}

/// Finds a node by `nodeId` anywhere in the raw JSON tree (shared by tests).
fn find_mut_value<'a>(
    node: &'a mut serde_json::Value,
    id: &str,
) -> Option<&'a mut serde_json::Value> {
    if node.get("nodeId").and_then(|value| value.as_str()) == Some(id) {
        return Some(node);
    }
    node.get_mut("children")
        .and_then(|children| children.as_array_mut())
        .and_then(|children| {
            children
                .iter_mut()
                .find_map(|child| find_mut_value(child, id))
        })
}
