use neotavern_presentation_blueprint::v1::{
    compile_character_manager_v1, materialize_character_manager_scene_v1,
    materialize_character_manager_scene_v1_from_document, CaptureBundleV1, UiActionV1,
    UiBlueprintV1, ViewportClassV1,
};
use neotavern_presentation_blueprint::UiBlueprintDocumentV1;

const CHARACTER_MANAGER_FIXTURE: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/character-manager-v1.json");
const UI_BLUEPRINT_DOCUMENT_FIXTURE: &str = include_str!(
    "../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-v1.json"
);

#[test]
fn compiles_shared_character_manager_fixture_without_renderer_types() {
    let capture: CaptureBundleV1 =
        serde_json::from_str(CHARACTER_MANAGER_FIXTURE).expect("fixture must be valid ABI JSON");

    let blueprint = compile_character_manager_v1(&capture).expect("capture must compile");
    let UiBlueprintV1::CharacterManager(character_manager) = &blueprint;
    assert_eq!(character_manager.revision, 7);
    assert_eq!(character_manager.catalog.len(), 2);
    assert!(character_manager.catalog[0].selected);
    assert!(character_manager.catalog[0].pinned);
    assert!(character_manager.controls.can_load_more);

    let scene = materialize_character_manager_scene_v1(&blueprint, ViewportClassV1::Compact);
    assert_eq!(scene.revision, 7);
    assert_eq!(scene.root.id, "character-manager");
    assert_eq!(scene.semantic_tree.semantic.role, "region");
    assert!(scene
        .paint_tree
        .iter()
        .any(|node| node.id == "character-manager.card:11111111-1111-4111-8111-111111111111"));
    assert!(scene.hit_test_tree.iter().any(|target| {
        matches!(
            target.action,
            UiActionV1::SelectCharacter { ref character_id }
                if character_id == "11111111-1111-4111-8111-111111111111"
        )
    }));
    assert_eq!(scene.text_interaction_tree.len(), 1);
    assert_eq!(
        scene.text_interaction_tree[0].id,
        "character-manager.cards.search"
    );
}

#[test]
fn local_intents_do_not_become_fake_product_wire_commands() {
    assert!(UiActionV1::SetQuery {
        value: "hazel".to_owned(),
    }
    .wire_effect()
    .is_none());
    assert_eq!(
        UiActionV1::RetryList
            .wire_effect()
            .expect("retry is a real Product Wire list request")
            .operation_id,
        "characters.list"
    );
}

#[test]
fn typed_action_maps_to_respective_wire_effect_or_none() {
    // Local UI state actions must not produce a Product Wire operation.
    for action in [
        UiActionV1::ClosePanel,
        UiActionV1::SetQuery {
            value: "test".to_owned(),
        },
        UiActionV1::SetSort {
            value: neotavern_presentation_blueprint::v1::CharacterSortV1::Name,
        },
        UiActionV1::SetView {
            value: neotavern_presentation_blueprint::v1::CharacterCatalogViewV1::List,
        },
        UiActionV1::SetTab {
            value: neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Cards,
        },
        UiActionV1::SelectCharacter {
            character_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        },
        UiActionV1::OpenCreate,
        UiActionV1::CancelCreate,
        UiActionV1::OpenDelete {
            character_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        },
        UiActionV1::CancelDelete,
        UiActionV1::BeginImport,
    ] {
        assert!(
            action.wire_effect().is_none(),
            "action {action:?} must be local and not map to a wire operation"
        );
    }
    // Product Wire commands must map to a stable operation_id.
    let cases = [
        (UiActionV1::RetryList, "characters.list"),
        (
            UiActionV1::Create {
                request: serde_json::from_value(serde_json::json!({
                    "name": "Hazel",
                    "description": "test"
                }))
                .unwrap(),
            },
            "characters.create",
        ),
        (
            UiActionV1::Delete {
                request: serde_json::from_value(serde_json::json!({
                    "characterId": "11111111-1111-4111-8111-111111111111"
                }))
                .unwrap(),
            },
            "characters.delete",
        ),
    ];
    for (action, expected) in cases {
        assert_eq!(
            action
                .wire_effect()
                .expect("wire effect must exist")
                .operation_id,
            expected
        );
    }
}

#[test]
fn same_action_trace_for_react_and_rust_fixture() {
    let capture: CaptureBundleV1 =
        serde_json::from_str(CHARACTER_MANAGER_FIXTURE).expect("fixture must be valid");
    let blueprint = compile_character_manager_v1(&capture).expect("must compile");
    let scene = materialize_character_manager_scene_v1(&blueprint, ViewportClassV1::Compact);
    // The scene's hit-test tree must contain the same character-select action
    // that the React capture's actionTrace would carry for the selected card.
    let has_select = scene.hit_test_tree.iter().any(|target| {
        matches!(
            &target.action,
            UiActionV1::SelectCharacter { character_id } if character_id == "11111111-1111-4111-8111-111111111111"
        )
    });
    assert!(
        has_select,
        "scene must preserve character-select action trace"
    );
    // Local query/view/tab intents are also present as actions on their nodes.
    assert!(scene.hit_test_tree.iter().any(|t| matches!(
        t.action,
        UiActionV1::SetTab {
            value: neotavern_presentation_blueprint::v1::CharacterManagerTabV1::Cards
        }
    )));
}

#[test]
fn parses_same_canonical_ui_blueprint_fixture_in_rust() {
    let document: UiBlueprintDocumentV1 = serde_json::from_str(UI_BLUEPRINT_DOCUMENT_FIXTURE)
        .expect("UiBlueprintDocumentV1 fixture must deserialize in Rust");
    assert_eq!(document.responsive.len(), 3);
    assert_eq!(document.root.component, "CharacterManager");
    assert!(document
        .bindings
        .iter()
        .any(|b| b.node_id == "character-card" && b.expression == "characters.items[*]"));
    // Round-trip through serde must preserve the canonical JSON shape.
    let round_trip = serde_json::to_value(&document).expect("serialize");
    let reparsed: UiBlueprintDocumentV1 =
        serde_json::from_value(round_trip).expect("re-parse round-trip");
    assert_eq!(document, reparsed);
}

#[test]
fn document_plus_state_plus_viewport_produces_same_scene() {
    let document: UiBlueprintDocumentV1 = serde_json::from_str(UI_BLUEPRINT_DOCUMENT_FIXTURE)
        .expect("document fixture must deserialize");
    let capture: CaptureBundleV1 =
        serde_json::from_str(CHARACTER_MANAGER_FIXTURE).expect("state fixture must deserialize");
    let scene_via_blueprint = {
        let blueprint =
            compile_character_manager_v1(&capture).expect("state must compile to blueprint");
        materialize_character_manager_scene_v1(&blueprint, ViewportClassV1::Expanded)
    };
    let scene_via_document = materialize_character_manager_scene_v1_from_document(
        &document,
        &capture,
        ViewportClassV1::Expanded,
    )
    .expect("document+state+viewport must materialize");
    assert_eq!(scene_via_blueprint.revision, scene_via_document.revision);
    assert_eq!(scene_via_blueprint.revision, 7);
    assert_eq!(scene_via_blueprint.root.id, scene_via_document.root.id);
    assert_eq!(
        scene_via_blueprint.paint_tree.len(),
        scene_via_document.paint_tree.len()
    );
    assert_eq!(
        scene_via_blueprint.hit_test_tree.len(),
        scene_via_document.hit_test_tree.len()
    );
}
