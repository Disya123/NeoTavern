use contracts_generated::generated::{CharacterDto, MessageDto};
use serde::{Deserialize, Serialize};

use super::{
    CharacterCatalogViewV1, CharacterManagerBlueprintV1, CharacterManagerTabV1, UiActionV1,
    UiBlueprintV1, UiFeedbackV1,
};

/// Viewport category is an input to scene materialization, not a browser pixel
/// measurement embedded in the portable blueprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewportClassV1 {
    Compact,
    Medium,
    Expanded,
}

/// Stable semantic hooks shared with the theme contract. These are explicitly
/// not CSS Modules classes, DOM node IDs, or renderer handles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiStyleHookV1 {
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    /// Theme SDK slot hook (`data-slot`, e.g. `"chat.composer"`). Optional:
    /// the Character Manager pilot surfaces publish component/part only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<String>,
}

/// Layout intent. A renderer chooses physical constraints and paint operations
/// from this semantic form; no hand-maintained coordinate hit boxes are stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UiLayoutV1 {
    Flow,
    Scroll,
    Overlay,
    Collection {
        presentation: CollectionPresentationV1,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CollectionPresentationV1 {
    List,
    Grid,
}

/// Renderer-neutral content. Translation keys are keys, not hard-coded user
/// strings; character data remains the canonical Product Wire DTO.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UiContentV1 {
    None,
    TextKey {
        key: String,
    },
    Input {
        value: String,
        label_key: String,
    },
    CharacterCard {
        character: CharacterDto,
    },
    /// Chat message row body. The renderer renders the canonical Product Wire
    /// message (markdown/image per its role) вЂ” never a flattened string.
    ChatMessage {
        message: MessageDto,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiSemanticStateV1 {
    Disabled,
    Selected,
    Expanded,
    Current,
}

/// Authored label override (`label` in the document): user-visible text plus
/// the i18n resource path it mirrors. Text is data authored next to structure;
/// the key keeps localization resolvable without re-decoding the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiLabelOverrideV1 {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_key: Option<String>,
}

/// Authored presentation overrides carried on one scene node (`label`,
/// `icon`, `styleRefs` in the document). Empty = renderer falls back to its
/// built-in presentation table for the node id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiNodeOverridesV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<UiLabelOverrideV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub style_refs: Vec<UiStyleRefV1>,
}

impl UiNodeOverridesV1 {
    pub fn is_empty(&self) -> bool {
        self.label.is_none() && self.icon.is_none() && self.style_refs.is_empty()
    }
}

/// One authored token-backed declaration (`styleRefs[]`). Only design-token
/// references are expressible — raw colors/sizes stay out of documents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiStyleRefV1 {
    pub property: String,
    pub token: String,
}

/// One bounded key/value pair of a declarative custom intent
/// (`custom.<owner>.<name>`). Values are plain strings — no nesting, no
/// blobs, no Product Wire authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiCustomParamV1 {
    pub key: String,
    pub value: String,
}

/// Accessible metadata is separate from paint/content and is projected into a
/// platform accessibility bridge by a renderer adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiSemanticV1 {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<UiSemanticStateV1>,
}

/// Canonical retained scene node. Stable logical `id` is intentionally not a
/// Blitz ID, Dioxus ID, DOM ID, or NeoCompositor resource handle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiNodeV1 {
    pub id: String,
    pub hook: UiStyleHookV1,
    pub semantic: UiSemanticV1,
    pub layout: UiLayoutV1,
    pub content: UiContentV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<UiActionV1>,
    /// Authored presentation overrides (M4 wave 1); see [`UiNodeOverridesV1`].
    #[serde(default, skip_serializing_if = "UiNodeOverridesV1::is_empty")]
    pub overrides: UiNodeOverridesV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<UiNodeV1>,
}

/// Paint-facing tree. The actual `NeoDisplayList` is produced only by a
/// renderer adapter after layout and is deliberately outside this ABI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiPaintNodeV1 {
    pub id: String,
    pub hook: UiStyleHookV1,
    pub content: UiContentV1,
}

/// Coordinate-free hit target. A backend derives physical bounds from layout;
/// it does not rebuild target geometry by hand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiHitTargetV1 {
    pub id: String,
    pub action: UiActionV1,
}

/// Text bridge metadata for platform IME, selection, and accessibility hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTextInteractionV1 {
    pub id: String,
    pub value: String,
    pub label_key: String,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiSemanticNodeV1 {
    pub id: String,
    pub semantic: UiSemanticV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<UiSemanticNodeV1>,
}

/// Runtime transaction delivered to all backend adapters from one Rust state
/// projection. The four trees let paint, hit testing, text interaction, and
/// accessibility remain synchronized without reinstating a browser DOM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiSceneV1 {
    pub revision: u64,
    pub root: UiNodeV1,
    pub paint_tree: Vec<UiPaintNodeV1>,
    pub hit_test_tree: Vec<UiHitTargetV1>,
    pub text_interaction_tree: Vec<UiTextInteractionV1>,
    pub semantic_tree: UiSemanticNodeV1,
}

pub(super) fn hook(component: &str, part: Option<&str>, states: Vec<String>) -> UiStyleHookV1 {
    UiStyleHookV1 {
        component: component.to_owned(),
        part: part.map(str::to_owned),
        slot: None,
        states,
    }
}

/// Hook with an explicit Theme SDK slot (`data-slot`) вЂ” chat chrome publishes
/// slots alongside component/part.
pub(super) fn hook_slotted(
    slot: &str,
    component: &str,
    part: Option<&str>,
    states: Vec<String>,
) -> UiStyleHookV1 {
    let mut hook = hook(component, part, states);
    hook.slot = Some(slot.to_owned());
    hook
}

pub(super) fn semantic(
    role: &str,
    label_key: Option<&str>,
    states: Vec<UiSemanticStateV1>,
) -> UiSemanticV1 {
    UiSemanticV1 {
        role: role.to_owned(),
        label_key: label_key.map(str::to_owned),
        states,
    }
}

fn tab_node(tab: CharacterManagerTabV1, active: CharacterManagerTabV1) -> UiNodeV1 {
    let (id, label_key) = match tab {
        CharacterManagerTabV1::Cards => ("character-manager.tab.cards", "characters:tab_cards"),
        CharacterManagerTabV1::Edit => ("character-manager.tab.edit", "characters:tab_edit"),
        CharacterManagerTabV1::Advanced => {
            ("character-manager.tab.advanced", "characters:tab_advanced")
        }
        CharacterManagerTabV1::Gallery => {
            ("character-manager.tab.gallery", "characters:tab_gallery")
        }
    };
    let current = tab == active;
    UiNodeV1 {
        overrides: Default::default(),
        id: id.to_owned(),
        hook: hook(
            "tabs",
            Some("trigger"),
            if current {
                vec!["active".to_owned()]
            } else {
                Vec::new()
            },
        ),
        semantic: semantic(
            "tab",
            Some(label_key),
            if current {
                vec![UiSemanticStateV1::Selected]
            } else {
                Vec::new()
            },
        ),
        layout: UiLayoutV1::Flow,
        content: UiContentV1::TextKey {
            key: label_key.to_owned(),
        },
        action: Some(UiActionV1::SetTab { value: tab }),
        children: Vec::new(),
    }
}

fn collection_presentation(view: CharacterCatalogViewV1) -> CollectionPresentationV1 {
    match view {
        CharacterCatalogViewV1::List => CollectionPresentationV1::List,
        CharacterCatalogViewV1::Grid => CollectionPresentationV1::Grid,
    }
}

fn materialize_character_manager(
    blueprint: &CharacterManagerBlueprintV1,
    viewport: ViewportClassV1,
) -> UiNodeV1 {
    let active_tab = blueprint.controls.active_tab;
    let mut catalog_children = Vec::with_capacity(blueprint.catalog.len());
    for card in &blueprint.catalog {
        let mut states = Vec::new();
        let mut semantic_states = Vec::new();
        if card.selected {
            states.push("selected".to_owned());
            semantic_states.push(UiSemanticStateV1::Selected);
        }
        if card.pinned {
            states.push("pinned".to_owned());
        }
        catalog_children.push(UiNodeV1 {
            overrides: Default::default(),
            id: format!("character-manager.card:{}", card.character.id),
            hook: hook("character-card", Some("catalog-item"), states),
            semantic: semantic("button", None, semantic_states),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::CharacterCard {
                character: card.character.clone(),
            },
            action: Some(UiActionV1::SelectCharacter {
                character_id: card.character.id.clone(),
            }),
            children: Vec::new(),
        });
    }

    let catalog = UiNodeV1 {
        overrides: Default::default(),
        id: "character-manager.cards.collection".to_owned(),
        hook: hook(
            "character-management",
            Some("character-cards"),
            match blueprint.controls.view {
                CharacterCatalogViewV1::List => vec!["list".to_owned()],
                CharacterCatalogViewV1::Grid => vec!["grid".to_owned()],
            },
        ),
        semantic: semantic("list", Some("characters:catalog"), Vec::new()),
        layout: UiLayoutV1::Collection {
            presentation: collection_presentation(blueprint.controls.view),
        },
        content: UiContentV1::None,
        action: None,
        children: catalog_children,
    };

    let feedback = blueprint.feedback.as_ref().map(|feedback| match feedback {
        UiFeedbackV1::Loading => UiNodeV1 {
            overrides: Default::default(),
            id: "character-manager.feedback.loading".to_owned(),
            hook: hook("character-management", Some("loading"), Vec::new()),
            semantic: semantic("status", Some("common:loading"), Vec::new()),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::TextKey {
                key: "common:loading".to_owned(),
            },
            action: None,
            children: Vec::new(),
        },
        UiFeedbackV1::Error { .. } => UiNodeV1 {
            overrides: Default::default(),
            id: "character-manager.feedback.error".to_owned(),
            hook: hook("character-management", Some("error"), Vec::new()),
            semantic: semantic("alert", Some("characters:errorTitle"), Vec::new()),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::TextKey {
                key: "characters:errorTitle".to_owned(),
            },
            action: Some(UiActionV1::RetryList),
            children: Vec::new(),
        },
    });

    let mut cards_children = vec![
        UiNodeV1 {
            overrides: Default::default(),
            id: "character-manager.cards.toolbar".to_owned(),
            hook: hook("action-bar", Some("character-card-toolbar"), Vec::new()),
            semantic: semantic("toolbar", Some("characters:managementTitle"), Vec::new()),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::None,
            action: None,
            children: vec![
                UiNodeV1 {
                    overrides: Default::default(),
                    id: "character-manager.action.create".to_owned(),
                    hook: hook("button", Some("create"), Vec::new()),
                    semantic: semantic("button", Some("characters:createShort"), Vec::new()),
                    layout: UiLayoutV1::Flow,
                    content: UiContentV1::TextKey {
                        key: "characters:createShort".to_owned(),
                    },
                    action: Some(UiActionV1::OpenCreate),
                    children: Vec::new(),
                },
                UiNodeV1 {
                    overrides: Default::default(),
                    id: "character-manager.action.import".to_owned(),
                    hook: hook("button", Some("import"), Vec::new()),
                    semantic: semantic("button", Some("characters:importShort"), Vec::new()),
                    layout: UiLayoutV1::Flow,
                    content: UiContentV1::TextKey {
                        key: "characters:importShort".to_owned(),
                    },
                    action: Some(UiActionV1::BeginImport),
                    children: Vec::new(),
                },
            ],
        },
        UiNodeV1 {
            overrides: Default::default(),
            id: "character-manager.cards.search".to_owned(),
            hook: hook("text-field", Some("search"), Vec::new()),
            semantic: semantic(
                "searchbox",
                Some("characters:searchPlaceholder"),
                Vec::new(),
            ),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::Input {
                value: blueprint.controls.query.clone(),
                label_key: "characters:searchPlaceholder".to_owned(),
            },
            action: Some(UiActionV1::SetQuery {
                value: blueprint.controls.query.clone(),
            }),
            children: Vec::new(),
        },
        catalog,
    ];
    if blueprint.controls.can_load_more {
        cards_children.push(UiNodeV1 {
            overrides: Default::default(),
            id: "character-manager.cards.load-more".to_owned(),
            hook: hook("button", Some("load-more"), Vec::new()),
            semantic: semantic("button", Some("common:loadMore"), Vec::new()),
            layout: UiLayoutV1::Flow,
            content: UiContentV1::TextKey {
                key: "common:loadMore".to_owned(),
            },
            action: None,
            children: Vec::new(),
        });
    }
    if let Some(feedback) = feedback {
        cards_children.push(feedback);
    }

    let root_layout = match viewport {
        ViewportClassV1::Compact => UiLayoutV1::Overlay,
        ViewportClassV1::Medium => UiLayoutV1::Overlay,
        ViewportClassV1::Expanded => UiLayoutV1::Flow,
    };
    UiNodeV1 {
        overrides: Default::default(),
        id: "character-manager".to_owned(),
        hook: hook(
            "character-management",
            None,
            vec![match viewport {
                ViewportClassV1::Compact => "compact".to_owned(),
                ViewportClassV1::Medium => "medium".to_owned(),
                ViewportClassV1::Expanded => "expanded".to_owned(),
            }],
        ),
        semantic: semantic("region", Some("characters:managementTitle"), Vec::new()),
        layout: root_layout,
        content: UiContentV1::None,
        action: Some(UiActionV1::ClosePanel),
        children: vec![
            UiNodeV1 {
                overrides: Default::default(),
                id: "character-manager.tabs".to_owned(),
                hook: hook("tabs", Some("root"), Vec::new()),
                semantic: semantic("tablist", Some("characters:managementTabs"), Vec::new()),
                layout: UiLayoutV1::Scroll,
                content: UiContentV1::None,
                action: None,
                children: vec![
                    tab_node(CharacterManagerTabV1::Cards, active_tab),
                    tab_node(CharacterManagerTabV1::Edit, active_tab),
                    tab_node(CharacterManagerTabV1::Advanced, active_tab),
                    tab_node(CharacterManagerTabV1::Gallery, active_tab),
                ],
            },
            UiNodeV1 {
                overrides: Default::default(),
                id: "character-manager.cards".to_owned(),
                hook: hook("character-management", Some("character-cards"), Vec::new()),
                semantic: semantic("group", Some("characters:tab_cards"), Vec::new()),
                layout: UiLayoutV1::Scroll,
                content: UiContentV1::None,
                action: None,
                children: cards_children,
            },
        ],
    }
}

pub(super) fn collect_paint_nodes(node: &UiNodeV1, output: &mut Vec<UiPaintNodeV1>) {
    output.push(UiPaintNodeV1 {
        id: node.id.clone(),
        hook: node.hook.clone(),
        content: node.content.clone(),
    });
    for child in &node.children {
        collect_paint_nodes(child, output);
    }
}

pub(super) fn collect_hit_targets(node: &UiNodeV1, output: &mut Vec<UiHitTargetV1>) {
    if let Some(action) = &node.action {
        output.push(UiHitTargetV1 {
            id: node.id.clone(),
            action: action.clone(),
        });
    }
    for child in &node.children {
        collect_hit_targets(child, output);
    }
}

pub(super) fn collect_text_interactions(node: &UiNodeV1, output: &mut Vec<UiTextInteractionV1>) {
    if let UiContentV1::Input { value, label_key } = &node.content {
        output.push(UiTextInteractionV1 {
            id: node.id.clone(),
            value: value.clone(),
            label_key: label_key.clone(),
            editable: true,
        });
    }
    for child in &node.children {
        collect_text_interactions(child, output);
    }
}

pub(super) fn semantic_tree(node: &UiNodeV1) -> UiSemanticNodeV1 {
    UiSemanticNodeV1 {
        id: node.id.clone(),
        semantic: node.semantic.clone(),
        children: node.children.iter().map(semantic_tree).collect(),
    }
}

/// Materializes one immutable runtime scene from one portable Rust blueprint.
/// Every platform adapter receives the same paint/hit/text/semantic projection.
pub fn materialize_character_manager_scene_v1(
    blueprint: &UiBlueprintV1,
    viewport: ViewportClassV1,
) -> UiSceneV1 {
    let UiBlueprintV1::CharacterManager(character_manager) = blueprint;
    let root = materialize_character_manager(character_manager, viewport);
    let mut paint_tree = Vec::new();
    let mut hit_test_tree = Vec::new();
    let mut text_interaction_tree = Vec::new();
    collect_paint_nodes(&root, &mut paint_tree);
    collect_hit_targets(&root, &mut hit_test_tree);
    collect_text_interactions(&root, &mut text_interaction_tree);
    UiSceneV1 {
        revision: character_manager.revision,
        semantic_tree: semantic_tree(&root),
        root,
        paint_tree,
        hit_test_tree,
        text_interaction_tree,
    }
}

/// Materializes a scene from the explicit document + state + viewport
/// boundary. The `UiBlueprintDocumentV1` is the static structure imported
/// from the React CaptureBundle via the TypeBox normalizer; the
/// `CharacterManagerStateV1` is the dynamic Product Wire state. Viewport
/// selects the responsive layout. This keeps the Chromium `CaptureBundle`
/// out of the renderer вЂ” only the portable document and typed state reach
/// the scene.
///
/// The document is validated for the expected `character-manager` surface
/// and responsive matrix; a future breaking change adds a new versioned
/// document type rather than altering this validation in place.
pub fn materialize_character_manager_scene_v1_from_document(
    document: &crate::generated::ui_blueprint_v1::UiBlueprintDocumentV1,
    state: &super::CaptureBundleV1,
    viewport: ViewportClassV1,
) -> Result<UiSceneV1, String> {
    // Validate that the imported document is the expected character-manager
    // surface and carries the required responsive variants. This mirrors the
    // TypeScript normalizer's guarantees without reimplementing its full
    // CSS/component validation вЂ” the document decoder already enforces shape.
    if document.responsive.len() != 3 {
        return Err(format!(
            "UiBlueprintDocumentV1 responsive must have 3 entries, got {}",
            document.responsive.len()
        ));
    }
    // The document's root must be the CharacterManager component; the scene
    // hook for the root is always `character-management` regardless of the
    // document's recipe string, but we validate that the document was not
    // produced for a different surface.
    if document.root.component != "CharacterManager" {
        return Err(format!(
            "UiBlueprintDocumentV1 root must be CharacterManager, got {}",
            document.root.component
        ));
    }
    // Build the runtime blueprint from the Product Wire state bundle (the sole
    // dynamic input, preserving its revision) and materialize. The document's
    // recipes/bindings are the contract that this scene satisfies; mismatches
    // are caught when the document and state diverge in future versions.
    let blueprint = super::compile_character_manager_v1(state)
        .map_err(|e| format!("state compile failed: {e}"))?;
    Ok(materialize_character_manager_scene_v1(&blueprint, viewport))
}
