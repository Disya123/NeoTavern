use neotavern_presentation_perf_probe::{kind_from_i32, push_sample, I2pCpu};

#[test]
fn kind_mapping_matches_jni_ints() {
    assert!(matches!(
        kind_from_i32(0),
        neotavern_neocompositor::PlatformPointerKind::Down
    ));
    assert!(matches!(
        kind_from_i32(1),
        neotavern_neocompositor::PlatformPointerKind::Up
    ));
    assert!(matches!(
        kind_from_i32(2),
        neotavern_neocompositor::PlatformPointerKind::Move
    ));
    assert!(matches!(
        kind_from_i32(3),
        neotavern_neocompositor::PlatformPointerKind::Cancel
    ));
}

#[test]
fn compositor_only_after_warmup_has_zero_producer_layout_shaping_raster() {
    let mut cpu = I2pCpu::new();
    let mut last = cpu.drain_present(1_000);
    for frame in 2u64..16 {
        push_sample(
            &cpu.input,
            0,
            2,
            540.0,
            1_000.0 - frame as f32 * 4.0,
            (frame * 8_333_333) as i64,
        );
        last = cpu.drain_present(frame * 8_333_333);
    }
    assert_eq!(last.producer, 0, "{last:?}");
    assert_eq!(last.layout, 0, "{last:?}");
    assert_eq!(last.shaping, 0, "{last:?}");
    assert_eq!(last.raster, 0, "{last:?}");
    assert!(last.high_water <= 64, "{last:?}");
}
