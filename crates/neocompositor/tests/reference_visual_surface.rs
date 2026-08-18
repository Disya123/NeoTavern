use neotavern_neocompositor::{
    atlas_is_checkerboard, PresentationTime, ReferenceVisualSurfaceProducer, LAYER_COUNT,
    PRODUCER_QUEUE_CAP, REFERENCE_VISUAL_SURFACE_PRODUCER,
};

#[test]
fn reference_producer_deforms_atlas_layers_and_stays_off_display_list() {
    let mut producer = ReferenceVisualSurfaceProducer::new();
    assert_eq!(
        ReferenceVisualSurfaceProducer::producer_name(),
        REFERENCE_VISUAL_SURFACE_PRODUCER
    );
    assert!(ReferenceVisualSurfaceProducer::surface_frame_ingress());
    assert!(!ReferenceVisualSurfaceProducer::plugin_runtime());
    assert!(!ReferenceVisualSurfaceProducer::direct_display_list_injection());
    producer.tick(PresentationTime::from_millis(0));
    let first = producer.take_latest().expect("first");
    producer.tick(PresentationTime::from_millis(16));
    let second = producer.take_latest().expect("second");
    assert_eq!(first.layers.len(), LAYER_COUNT);
    assert!(first.layers.iter().any(|layer| layer.alpha < 1.0));
    assert!(first.layers.iter().any(|layer| layer.alpha == 1.0));
    assert_ne!(first.vertices, second.vertices);
    assert_eq!(second.sequence, first.sequence + 1);
    assert!(second.timestamp.as_nanos() > first.timestamp.as_nanos());
    assert!(second.damage.width > 0.0 && second.damage.height > 0.0);
    assert!(!atlas_is_checkerboard(
        &first.atlas_rgba,
        first.width,
        first.height
    ));
    let unique: std::collections::BTreeSet<[u8; 4]> = first
        .atlas_rgba
        .chunks_exact(4)
        .take(64)
        .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
        .collect();
    assert!(unique.len() > 4, "atlas tile must not be a solid fill");
}

#[test]
fn producer_queue_is_bounded_latest_wins() {
    let mut producer = ReferenceVisualSurfaceProducer::new();
    assert_eq!(producer.queue_cap(), PRODUCER_QUEUE_CAP);
    producer.tick(PresentationTime::from_millis(0));
    producer.tick(PresentationTime::from_millis(16));
    producer.tick(PresentationTime::from_millis(32));
    assert_eq!(producer.queued(), PRODUCER_QUEUE_CAP);
    assert!(producer.dropped() >= 2);
    let latest = producer.take_latest().expect("latest");
    assert_eq!(latest.sequence, 3);
    assert_eq!(producer.queued(), 0);
}
