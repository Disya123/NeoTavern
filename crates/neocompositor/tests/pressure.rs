//! PERF-15 host corpus: pressure and degraded admission policy.
//!
//! Host status is **IMPLEMENTED**. Not Milestone B PASS. Not production JNI.

use neotavern_neocompositor::{
    AdmissionItem, Admit, EvictionClass, PressureController, PressureReject, PressureTier,
    ResourceId, SceneEpoch, DEFAULT_ALLOC_RETRY_CAP,
};

fn item(id: u64, class: EvictionClass, bytes: usize) -> AdmissionItem {
    AdmissionItem {
        id: ResourceId(id),
        class,
        bytes,
        scene_epoch: SceneEpoch(1),
    }
}

#[test]
fn tiers_walk_normal_constrained_critical_degraded() {
    let mut ctl = PressureController::new(1_000);
    assert_eq!(ctl.tier(), PressureTier::Normal);
    ctl.admit(item(1, EvictionClass::OffViewportImage, 700))
        .unwrap();
    assert_eq!(ctl.tier(), PressureTier::Constrained);
    ctl.admit(item(2, EvictionClass::OffViewportTile, 160))
        .unwrap();
    assert_eq!(ctl.tier(), PressureTier::Critical);
    ctl.admit(item(3, EvictionClass::CachedLayer, 100)).unwrap();
    assert_eq!(ctl.tier(), PressureTier::Degraded);
}

#[test]
fn eviction_order_is_deterministic_and_keeps_viewport_protected_lkg() {
    let mut ctl = PressureController::new(1_000);
    ctl.remember_lkg(SceneEpoch(1));
    ctl.admit(item(10, EvictionClass::LastKnownGood, 200))
        .unwrap();
    ctl.admit(item(11, EvictionClass::ProtectedBand, 200))
        .unwrap();
    ctl.admit(item(12, EvictionClass::ViewportTile, 200))
        .unwrap();
    ctl.admit(item(1, EvictionClass::ScratchTarget, 50))
        .unwrap();
    ctl.admit(item(2, EvictionClass::PendingImageUpload, 50))
        .unwrap();
    ctl.admit(item(3, EvictionClass::CachedLayer, 50)).unwrap();
    ctl.admit(item(4, EvictionClass::OffViewportImage, 50))
        .unwrap();
    ctl.admit(item(5, EvictionClass::OffViewportTile, 50))
        .unwrap();
    ctl.admit(item(6, EvictionClass::VisualSurfaceOffViewport, 50))
        .unwrap();
    let report = ctl.evict_to_fit(400);
    assert_eq!(
        report.evicted,
        vec![
            ResourceId(1),
            ResourceId(2),
            ResourceId(3),
            ResourceId(4),
            ResourceId(5),
            ResourceId(6),
        ]
    );
    assert!(ctl.contains(ResourceId(10)));
    assert!(ctl.contains(ResourceId(11)));
    assert!(ctl.contains(ResourceId(12)));
    assert_eq!(ctl.lkg_epoch(), Some(SceneEpoch(1)));
    assert_eq!(report.kept_protected, 3);
}

#[test]
fn constrained_throttles_image_uploads() {
    let mut ctl = PressureController::new(1_000);
    ctl.admit(item(1, EvictionClass::ViewportTile, 700))
        .unwrap();
    assert_eq!(ctl.tier(), PressureTier::Constrained);
    let outcome = ctl
        .admit(item(2, EvictionClass::PendingImageUpload, 100))
        .unwrap();
    assert_eq!(
        outcome,
        Admit::Throttled {
            tier: PressureTier::Constrained
        }
    );
    assert!(!ctl.contains(ResourceId(2)));
    assert_eq!(ctl.stats().throttled_uploads, 1);
}

#[test]
fn fling_glass_upload_visual_surface_does_not_drop_protected_band() {
    let mut ctl = PressureController::new(1_000);
    ctl.admit(item(1, EvictionClass::ViewportTile, 200))
        .unwrap();
    ctl.admit(item(2, EvictionClass::ProtectedBand, 200))
        .unwrap();
    ctl.admit(item(3, EvictionClass::LastKnownGood, 100))
        .unwrap();
    ctl.admit(item(4, EvictionClass::CachedLayer, 100)).unwrap();
    ctl.admit(item(5, EvictionClass::OffViewportImage, 200))
        .unwrap();
    ctl.admit(item(6, EvictionClass::VisualSurfaceOffViewport, 100))
        .unwrap();
    let _ = ctl.evict_to_fit(250);
    assert!(ctl.contains(ResourceId(1)));
    assert!(ctl.contains(ResourceId(2)));
    assert!(ctl.contains(ResourceId(3)));
}

#[test]
fn allocation_retries_are_bounded_then_degraded() {
    let mut ctl = PressureController::new(1_000);
    ctl.admit(item(1, EvictionClass::ViewportTile, 400))
        .unwrap();
    assert_eq!(ctl.tier(), PressureTier::Normal);
    let mut last = None;
    for _ in 0..DEFAULT_ALLOC_RETRY_CAP {
        last = Some(ctl.alloc_retry());
    }
    assert!(last.unwrap().is_ok());
    assert_eq!(ctl.alloc_retry(), Err(PressureReject::RetryCap));
    assert_eq!(ctl.tier(), PressureTier::Degraded);
    assert_eq!(
        ctl.admit(item(9, EvictionClass::OffViewportImage, 10)),
        Err(PressureReject::Degraded)
    );
}

#[test]
fn oom_does_not_start_an_alloc_loop() {
    let mut ctl = PressureController::new(1_000);
    ctl.admit(item(1, EvictionClass::ViewportTile, 100))
        .unwrap();
    ctl.admit(item(2, EvictionClass::ProtectedBand, 100))
        .unwrap();
    ctl.admit(item(3, EvictionClass::LastKnownGood, 100))
        .unwrap();
    for _ in 0..100 {
        assert_eq!(ctl.on_oom(), PressureTier::Degraded);
    }
    assert_eq!(ctl.stats().oom_loops, 0);
    assert_eq!(ctl.stats().oom_events, 100);
    assert_eq!(ctl.tier(), PressureTier::Degraded);
    assert!(ctl.contains(ResourceId(1)));
    assert!(ctl.contains(ResourceId(2)));
    assert!(ctl.contains(ResourceId(3)));
    assert_eq!(ctl.alloc_retry(), Err(PressureReject::Degraded));
}

#[test]
fn cannot_evict_protected_to_make_room() {
    let mut ctl = PressureController::new(100);
    ctl.admit(item(1, EvictionClass::ViewportTile, 50)).unwrap();
    ctl.admit(item(2, EvictionClass::ProtectedBand, 20))
        .unwrap();
    assert_eq!(ctl.tier(), PressureTier::Constrained);
    assert_eq!(
        ctl.admit(item(3, EvictionClass::OffViewportImage, 40)),
        Err(PressureReject::WouldEvictProtected)
    );
    assert!(ctl.contains(ResourceId(1)));
    assert!(ctl.contains(ResourceId(2)));
    assert_eq!(ctl.tier(), PressureTier::Degraded);
}
