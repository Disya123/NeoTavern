use neotavern_presentation_blueprint::v1::{
    compile_character_manager_v1, materialize_character_manager_scene_v1, CaptureBundleV1,
    UiActionV1, UiBlueprintV1, ViewportClassV1,
};

const CHARACTER_MANAGER_FIXTURE: &str =
    include_str!("../../../packages/contracts/src/presentation/fixtures/character-manager-v1.json");

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
