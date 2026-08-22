//! Chat surface scene (M2 slice): the portable `chat` document is the
//! structural contract; this materializer realizes it as the same immutable
//! [`UiSceneV1`] projection every other surface receives. Hooks mirror the
//! Theme SDK contract already published by React and the native RSX
//! (`slot:chat.header`, `slot:chat.composer`, `component:chat-message`, …) so
//! a scene-driven renderer keeps DOM-parity by construction.
//!
//! Structure policy: node ids, nesting, order and actions are read from the
//! authored document (`ui-blueprint-document-chat-v1.json`). The tables below
//! only name Theme SDK hooks, semantic roles and label keys per stable node
//! id; dynamic values (draft, character name, per-row content) come from
//! [`ChatSurfaceStateV1`]. Unknown node ids materialize as generic flow nodes
//! so structural edits never need a simultaneous code change; interactive
//! presentation for them lands together with the document change.

use super::scene::{
    collect_hit_targets, collect_paint_nodes, collect_text_interactions, hook, hook_slotted,
    semantic, semantic_tree, UiContentV1, UiCustomParamV1, UiLabelOverrideV1, UiLayoutV1,
    UiNodeOverridesV1, UiNodeV1, UiSceneV1, UiStyleRefV1, ViewportClassV1,
};
use super::UiActionV1;
use crate::generated::ui_blueprint_v1::{
    PresentationUiBlueprintNodeV1Document, PresentationUiBlueprintNodeV1DocumentActionsItemV1,
    UiBlueprintDocumentIdV1, UiBlueprintDocumentResponsiveItemLayoutV1,
    UiBlueprintDocumentResponsiveItemViewportClassV1, UiBlueprintDocumentV1,
};

use serde::Serialize;

use contracts_generated::generated::{MessageDto, MessageRole};

/// Dynamic Product Wire state for one chat surface snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatSurfaceStateV1 {
    pub revision: u64,
    pub messages: Vec<MessageDto>,
    pub composer_draft: String,
    pub character_name: String,
    pub streaming: bool,
}

fn validate_document(
    document: &UiBlueprintDocumentV1,
    viewport: ViewportClassV1,
) -> Result<(), String> {
    if document.id != UiBlueprintDocumentIdV1::Chat {
        return Err(format!(
            "UiBlueprintDocumentV1 id must be 'chat', got {:?}",
            document.id
        ));
    }
    if document.root.component != "Chat" {
        return Err(format!(
            "UiBlueprintDocumentV1 root must be Chat, got {}",
            document.root.component
        ));
    }
    if document.responsive.len() != 3 {
        return Err(format!(
            "responsive must have 3 entries, got {}",
            document.responsive.len()
        ));
    }
    let want_class = match viewport {
        ViewportClassV1::Compact => UiBlueprintDocumentResponsiveItemViewportClassV1::Compact,
        ViewportClassV1::Medium => UiBlueprintDocumentResponsiveItemViewportClassV1::Medium,
        ViewportClassV1::Expanded => UiBlueprintDocumentResponsiveItemViewportClassV1::Expanded,
    };
    let rule = document
        .responsive
        .iter()
        .find(|rule| rule.viewport_class == want_class)
        .ok_or_else(|| format!("responsive missing class {want_class:?}"))?;
    let expected_layout = match viewport {
        ViewportClassV1::Compact => UiBlueprintDocumentResponsiveItemLayoutV1::ChatCompactOverlay,
        _ => UiBlueprintDocumentResponsiveItemLayoutV1::ChatSplitPanel,
    };
    if rule.layout != expected_layout {
        return Err(format!(
            "unexpected chat layout for {viewport:?}: {:?}",
            rule.layout
        ));
    }
    Ok(())
}

/// Theme SDK hook + accessibility naming for one stable document node id.
#[derive(Debug, Clone)]
struct NodePresentation {
    slot: Option<&'static str>,
    component: &'static str,
    part: Option<&'static str>,
    role: &'static str,
    label_key: Option<&'static str>,
    layout: UiLayoutV1,
}

const fn flow(
    slot: Option<&'static str>,
    component: &'static str,
    part: Option<&'static str>,
    role: &'static str,
    label_key: Option<&'static str>,
) -> NodePresentation {
    NodePresentation {
        slot,
        component,
        part,
        role,
        label_key,
        layout: UiLayoutV1::Flow,
    }
}

const fn scroll(
    slot: Option<&'static str>,
    component: &'static str,
    part: Option<&'static str>,
    role: &'static str,
    label_key: Option<&'static str>,
) -> NodePresentation {
    NodePresentation {
        layout: UiLayoutV1::Scroll,
        ..flow(slot, component, part, role, label_key)
    }
}

/// Presentation table for every known chat node id. Structure lives in the
/// document; this table only names hooks and labels a renderer resolves.
fn presentation(node_id: &str) -> Option<NodePresentation> {
    Some(match node_id {
        // Header ------------------------------------------------------------
        "chat-header" => flow(
            Some("chat.header"),
            "chat-header",
            None,
            "banner",
            Some("chat:title"),
        ),
        "chat-identity" => flow(
            None,
            "chat-header",
            Some("character-identity"),
            "group",
            None,
        ),
        "identity-avatar" => flow(None, "chat-header", Some("character-avatar"), "group", None),
        "identity-title" => flow(None, "chat-header", None, "heading", Some("chat:title")),
        "header-search" => flow(
            None,
            "chat-header",
            Some("header-search"),
            "button",
            Some("chat:searchInChat"),
        ),
        // Viewport ----------------------------------------------------------
        "chat-viewport" => scroll(
            Some("chat.viewport"),
            "chat-viewport",
            Some("canvas"),
            "region",
            Some("chat:messagesLabel"),
        ),
        "chat-scroll" => scroll(None, "chat-viewport", Some("chat-scroll"), "region", None),
        "chat-message-list" => scroll(None, "chat-message-list", None, "list", None),
        // Message row -------------------------------------------------------
        "message-header" => flow(None, "chat-message", Some("message-header"), "group", None),
        "message-avatar" => flow(None, "chat-message", Some("message-avatar"), "group", None),
        "message-identity" => flow(
            None,
            "chat-message",
            Some("message-identity"),
            "group",
            None,
        ),
        "message-author" => flow(
            None,
            "chat-message",
            Some("message-author"),
            "group",
            Some("chat:author"),
        ),
        "message-timestamp" => flow(
            None,
            "chat-message",
            Some("message-timestamp"),
            "time",
            None,
        ),
        "message-action-bar" => flow(
            None,
            "message-action-bar",
            Some("message-actions-inline"),
            "toolbar",
            None,
        ),
        "message-content" => flow(None, "chat-message", Some("message-content"), "group", None),
        "message-frame" => flow(None, "chat-message", Some("message-frame"), "group", None),
        "message-bubble" => flow(None, "chat-message", Some("message-body"), "article", None),
        "message-art" => flow(None, "chat-message", Some("message-art"), "group", None),
        "version-controls" => flow(
            None,
            "message-version-controls",
            Some("message-version-controls"),
            "group",
            None,
        ),
        "version-actions" => flow(
            None,
            "message-version-controls",
            Some("message-version-actions"),
            "group",
            None,
        ),
        "swipe-pager" => flow(
            None,
            "message-swipe-pager",
            Some("message-swipes"),
            "toolbar",
            None,
        ),
        "swipe-label" => flow(None, "message-swipe-pager", None, "status", None),
        // Composer ----------------------------------------------------------
        "chat-composer" => flow(Some("chat.composer"), "chat-composer", None, "region", None),
        "composer-toolbar" => flow(None, "chat-composer", Some("toolbar"), "toolbar", None),
        "composer-toolbar-actions" => flow(None, "chat-composer", None, "group", None),
        "composer-settings" | "utility-settings" => {
            flow(None, "button", None, "button", Some("navigation:settings"))
        }
        "composer-reset" | "utility-wand" => {
            flow(None, "button", None, "button", Some("common:reset"))
        }
        "composer-context" => flow(None, "button", None, "button", Some("chat:contextLabel")),
        "composer-field" => flow(None, "chat-composer", Some("field"), "form", None),
        "composer-textarea" => flow(None, "textarea", None, "textbox", Some("chat:placeholder")),
        "composer-actions" => flow(
            None,
            "chat-composer",
            Some("composer-actions"),
            "toolbar",
            None,
        ),
        "composer-utilities" => flow(None, "chat-composer", None, "group", None),
        "utility-scroll-latest" => {
            flow(None, "button", None, "button", Some("chat:scrollToLatest"))
        }
        "composer-send" => flow(None, "button", None, "button", Some("chat:send")),
        _ => return None,
    })
}

/// Message action buttons share one hook family regardless of their node id;
/// the kind lives in the action itself.
const MESSAGE_ACTION_BUTTON: NodePresentation = flow(None, "message-action", None, "button", None);

fn doc_find<'a>(
    node: &'a PresentationUiBlueprintNodeV1Document,
    node_id: &str,
) -> Option<&'a PresentationUiBlueprintNodeV1Document> {
    if node.node_id == node_id {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| doc_find(child, node_id))
}

/// Maps an authored action id onto the closed [`UiActionV1`] union. Builtin
/// ids match by their document string; `custom.<owner>.<name>` ids become
/// authority-free [`UiActionV1::Custom`] intents (bounded params ride along
/// from the authored action). Actions carrying `parameter: "messageId"`
/// bind to the row being instantiated.
fn wire_action(
    item: &PresentationUiBlueprintNodeV1DocumentActionsItemV1,
    message_id: &str,
) -> Option<UiActionV1> {
    let id: &str = &item.id;
    let bound = || message_id.to_owned();
    if let Some(_rest) = id.strip_prefix("custom.") {
        // Keep the FULL authored id as the name: the renderer publishes it
        // verbatim as `data-action`, so the shared hit table recognizes
        // `custom.*` without any out-of-band state.
        return Some(UiActionV1::Custom {
            name: id.to_owned(),
            params: item
                .params
                .as_ref()
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| UiCustomParamV1 {
                            key: entry.key.clone(),
                            value: entry.value.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    Some(match id {
        "chat.send" => UiActionV1::ChatSend,
        "chat.composer.settings" => UiActionV1::ChatComposerSettings,
        "chat.composer.reset" => UiActionV1::ChatComposerReset,
        "chat.composer.context" => UiActionV1::ChatComposerContext,
        "chat.scroll-latest" => UiActionV1::ChatScrollLatest,
        "chat.message.copy" => UiActionV1::ChatMessageCopy {
            message_id: bound(),
        },
        "chat.message.delete" => UiActionV1::ChatMessageDelete {
            message_id: bound(),
        },
        "chat.message.context" => UiActionV1::ChatMessageContext {
            message_id: bound(),
        },
        "chat.message.edit" => UiActionV1::ChatMessageEdit {
            message_id: bound(),
        },
        "chat.message.checkpoint" => UiActionV1::ChatMessageCheckpoint {
            message_id: bound(),
        },
        "chat.message.branch" => UiActionV1::ChatMessageBranch {
            message_id: bound(),
        },
        "chat.message.rollback" => UiActionV1::ChatMessageRollback {
            message_id: bound(),
        },
        "chat.message.history" => UiActionV1::ChatMessageHistory,
        "chat.message.regenerate" => UiActionV1::ChatMessageRegenerate,
        "chat.message.swipe-previous" => UiActionV1::ChatMessageSwipePrevious,
        "chat.message.swipe-next" => UiActionV1::ChatMessageSwipeNext,
        // Unreachable for well-formed documents: `validate_action_ids`
        // rejects unknown builtin ids before materialization.
        _ => return None,
    })
}

/// Rejects unknown builtin action ids up front so a typo like `chat.sned`
/// fails loudly instead of silently losing its action. `custom.*` ids are
/// always accepted — that is their point.
fn validate_action_ids(doc_node: &PresentationUiBlueprintNodeV1Document) -> Result<(), String> {
    for item in &doc_node.actions {
        if !item.id.starts_with("custom.") && wire_action(item, "").is_none() {
            return Err(format!("unknown chat action id {:?}", item.id));
        }
    }
    for child in &doc_node.children {
        validate_action_ids(child)?;
    }
    Ok(())
}

/// Theme SDK hook state mirroring the native `data-role` attribute value.
fn role_state(role: &MessageRole) -> String {
    match role {
        MessageRole::System => "system".to_owned(),
        MessageRole::User => "user".to_owned(),
        MessageRole::Assistant => "assistant".to_owned(),
        MessageRole::Tool => "tool".to_owned(),
    }
}

/// Serializes a generated string enum back to its authored name (`Plus`,
/// `background-color`, …). Keeps the conversion in sync with the schema
/// without hand-maintaining 100+ match arms.
fn serde_name<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value)
        .unwrap_or_default()
        .trim_matches('"')
        .to_owned()
}

/// Converts authored presentation fields onto the scene node: labels keep
/// their i18n path, icons/properties resolve to their authored names, and the
/// semantic label key prefers the document's key over the table fallback.
fn doc_overrides(
    doc_node: &PresentationUiBlueprintNodeV1Document,
    fallback_label_key: Option<&'static str>,
) -> (UiNodeOverridesV1, Option<String>) {
    let overrides = UiNodeOverridesV1 {
        label: doc_node.label.as_ref().map(|label| UiLabelOverrideV1 {
            text: label.text.clone(),
            i18n_key: label.i18n_key.clone(),
        }),
        icon: doc_node.icon.as_ref().map(|icon| serde_name(icon)),
        style_refs: doc_node
            .style_refs
            .as_ref()
            .map(|refs| {
                refs.iter()
                    .map(|reference| UiStyleRefV1 {
                        property: serde_name(&reference.property),
                        token: reference.token.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    let semantic_label_key = doc_node
        .label
        .as_ref()
        .and_then(|label| label.i18n_key.as_deref())
        .or(fallback_label_key);
    (overrides, semantic_label_key.map(str::to_owned))
}

/// Generic passthrough for structural additions the presentation table does
/// not know yet: they stay in the scene (hooks, hit testing, semantics)
/// without inventing interactive presentation.
fn generic_node(doc_node: &PresentationUiBlueprintNodeV1Document) -> UiNodeV1 {
    UiNodeV1 {
        overrides: Default::default(),
        id: doc_node.node_id.clone(),
        hook: hook("chat-view", None, Vec::new()),
        semantic: semantic("group", None, Vec::new()),
        layout: UiLayoutV1::Flow,
        content: UiContentV1::None,
        action: None,
        children: doc_node.children.iter().map(generic_node).collect(),
    }
}

/// One static (non-template) node: hooks/labels from the presentation table,
/// first mapped action attached, children built recursively.
fn build_node(
    doc_node: &PresentationUiBlueprintNodeV1Document,
    state: &ChatSurfaceStateV1,
) -> UiNodeV1 {
    let Some(pres) = presentation(&doc_node.node_id) else {
        return generic_node(doc_node);
    };
    let content = if doc_node.node_id == "chat-identity" {
        UiContentV1::TextKey {
            key: format!("chat:characterName:{}", state.character_name),
        }
    } else if doc_node.node_id == "composer-textarea" {
        UiContentV1::Input {
            value: state.composer_draft.clone(),
            label_key: "chat:placeholder".to_owned(),
        }
    } else {
        UiContentV1::None
    };
    let mut hook = hook(pres.component, pres.part, Vec::new());
    if let Some(slot) = pres.slot {
        hook.slot = Some(slot.to_owned());
    }
    let chrome_states: &[&str] = match doc_node.node_id.as_str() {
        "chat-viewport" | "chat-composer" => {
            if state.streaming {
                &["streaming"]
            } else {
                &["idle"]
            }
        }
        _ => &[],
    };
    hook.states = chrome_states.iter().map(|s| s.to_string()).collect();
    let action = doc_node
        .actions
        .iter()
        // Parameterized actions belong to row instances, not static chrome.
        .filter(|item| item.parameter.is_none())
        .find_map(|item| wire_action(item, ""));
    let (overrides, label_key) = doc_overrides(doc_node, pres.label_key);
    UiNodeV1 {
        overrides,
        id: doc_node.node_id.clone(),
        hook,
        semantic: semantic(pres.role, label_key.as_deref(), Vec::new()),
        layout: pres.layout,
        content,
        action,
        children: doc_node
            .children
            .iter()
            .map(|child| build_node(child, state))
            .collect(),
    }
}

/// Instantiates one message row from the authored `chat-message` template:
/// the row id becomes `{template}:{uuid}`, every child id is prefixed with
/// it, and `parameter: "messageId"` actions bind to the concrete message.
fn instantiate_row(
    template: &PresentationUiBlueprintNodeV1Document,
    message: &MessageDto,
    streaming: bool,
) -> UiNodeV1 {
    let row_id = format!("{}:{}", template.node_id, message.id);
    let mut states = vec![role_state(&message.role)];
    if streaming {
        states.push("streaming".to_owned());
    }
    UiNodeV1 {
        overrides: Default::default(),
        id: row_id.clone(),
        hook: hook("chat-message", None, states),
        semantic: semantic("listitem", None, Vec::new()),
        layout: UiLayoutV1::Flow,
        content: UiContentV1::ChatMessage {
            message: message.clone(),
        },
        action: None,
        children: template
            .children
            .iter()
            .map(|child| row_child(child, &row_id, message))
            .collect(),
    }
}

fn row_child(
    doc_node: &PresentationUiBlueprintNodeV1Document,
    row_id: &str,
    message: &MessageDto,
) -> UiNodeV1 {
    let node_id = format!("{row_id}.{}", doc_node.node_id);
    let pres = presentation(&doc_node.node_id).unwrap_or(MESSAGE_ACTION_BUTTON);
    let is_message_button = doc_node.node_id.starts_with("message-action-");
    let pres = if is_message_button {
        MESSAGE_ACTION_BUTTON
    } else {
        pres
    };
    let mut hook = hook(pres.component, pres.part, Vec::new());
    if doc_node.node_id == "message-action-bar" {
        hook.states.push("idle".to_owned());
    }
    let action = doc_node
        .actions
        .iter()
        .find_map(|item| wire_action(item, &message.id));
    let (overrides, label_key) = doc_overrides(doc_node, pres.label_key);
    UiNodeV1 {
        overrides,
        id: node_id,
        hook,
        semantic: semantic(pres.role, label_key.as_deref(), Vec::new()),
        layout: pres.layout,
        content: UiContentV1::None,
        action,
        children: doc_node
            .children
            .iter()
            .map(|child| row_child(child, row_id, message))
            .collect(),
    }
}

/// Materializes the chat scene from the canonical document plus typed state.
///
/// The document is validated to be the `chat` surface with the expected
/// responsive matrix; structure follows the document contract, dynamic content
/// comes exclusively from [`ChatSurfaceStateV1`]. A future breaking change
/// adds a new versioned document type instead of mutating this validation.
pub fn materialize_chat_scene_v1_from_document(
    document: &UiBlueprintDocumentV1,
    state: &ChatSurfaceStateV1,
    viewport: ViewportClassV1,
) -> Result<UiSceneV1, String> {
    validate_document(document, viewport)?;
    validate_action_ids(&document.root)?;

    let header_doc = doc_find(&document.root, "chat-header")
        .ok_or("chat document must contain a 'chat-header' node")?;
    let viewport_doc = doc_find(&document.root, "chat-viewport")
        .ok_or("chat document must contain a 'chat-viewport' node")?;
    let composer_doc = doc_find(&document.root, "chat-composer")
        .ok_or("chat document must contain a 'chat-composer' node")?;
    let template = doc_find(&document.root, "chat-message")
        .ok_or("chat document must contain a 'chat-message' row template")?;

    let header = build_node(header_doc, state);
    let composer = build_node(composer_doc, state);

    // One expanded row per Product Wire message, each instantiated from the
    // authored template.
    let rows: Vec<UiNodeV1> = state
        .messages
        .iter()
        .map(|message| instantiate_row(template, message, state.streaming))
        .collect();

    // The viewport walks the document except the list's children, which come
    // from the template expansion above.
    let canvas = build_viewport(viewport_doc, state, rows);

    let root = UiNodeV1 {
        overrides: Default::default(),
        id: "chat".to_owned(),
        hook: hook("chat-view", None, Vec::new()),
        semantic: semantic("region", None, Vec::new()),
        layout: UiLayoutV1::Flow,
        content: UiContentV1::None,
        action: None,
        children: vec![header, canvas, composer],
    };

    let mut paint_tree = Vec::new();
    let mut hit_test_tree = Vec::new();
    let mut text_interaction_tree = Vec::new();
    collect_paint_nodes(&root, &mut paint_tree);
    collect_hit_targets(&root, &mut hit_test_tree);
    collect_text_interactions(&root, &mut text_interaction_tree);
    Ok(UiSceneV1 {
        revision: state.revision,
        semantic_tree: semantic_tree(&root),
        root,
        paint_tree,
        hit_test_tree,
        text_interaction_tree,
    })
}

fn build_viewport(
    doc_node: &PresentationUiBlueprintNodeV1Document,
    state: &ChatSurfaceStateV1,
    rows: Vec<UiNodeV1>,
) -> UiNodeV1 {
    // The list's children come from the template expansion, not the document
    // (the document carries the single `chat-message` template definition).
    if doc_node.node_id == "chat-message-list" {
        let mut node = build_node(doc_node, state);
        node.children = rows;
        return node;
    }
    let mut node = build_node(doc_node, state);
    node.children = doc_node
        .children
        .iter()
        .filter(|child| child.node_id != "chat-message")
        .map(|child| build_viewport(child, state, rows.clone()))
        .collect();
    node
}
