use neotavern_neocompositor::{
    DeviceEpoch, GpuCaps, GpuRecovery, HandleOwner, IngressAccept, IngressDropReason,
    IngressReject, PresentSample, PresentationTime, Rect, SharedGpuContext, SharedGpuFactory,
    SharedHandleKind, SurfaceContent, SurfaceFence, SurfaceFrame, SurfaceFrameIngress, SurfaceId,
    TextureUsageFlags, VisualSurfaceDeclare, DEFAULT_FORMAT, INGRESS_SURFACE_CAP,
};

fn ready_frame(
    gpu: &mut SharedGpuContext,
    surface: SurfaceId,
    generation: u64,
    sequence: u64,
) -> SurfaceFrame {
    let handle = gpu.alloc_surface().expect("surface handle");
    SurfaceFrame {
        surface,
        generation,
        sequence,
        timestamp: PresentationTime::from_millis(sequence * 16),
        content: SurfaceContent::Sampleable {
            handle,
            width: 64,
            height: 64,
            format: DEFAULT_FORMAT.texture_format,
            usage: DEFAULT_FORMAT.usage,
            bytes: 64 * 64 * 4,
        },
        damage: Some(Rect::new(0.0, 0.0, 64.0, 64.0)),
        fence: Some(SurfaceFence {
            ready: true,
            device_epoch: gpu.device_epoch(),
        }),
    }
}

#[test]
fn declare_and_latest_ready_wins_without_blocking() {
    let mut factory = SharedGpuFactory::new();
    let gpu = factory.open(GpuCaps::host_default()).expect("gpu");
    let mut ingress = SurfaceFrameIngress::new(gpu.device_epoch());
    let id = ingress
        .declare(VisualSurfaceDeclare::reference("vs.reference"))
        .expect("declare");
    assert!(ingress.surface_frame_ingress());
    assert!(!ingress.plugin_runtime());
    assert!(!ingress.direct_display_list_injection());
    let first = ready_frame(gpu, id, 1, 1);
    assert_eq!(ingress.submit(gpu, first), Ok(IngressAccept::Queued));
    let second = ready_frame(gpu, id, 1, 2);
    assert!(matches!(
        ingress.submit(gpu, second),
        Ok(IngressAccept::Coalesced {
            dropped_sequence: 1
        })
    ));
    match ingress.present_sample(id) {
        PresentSample::Ready(frame) => assert_eq!(frame.sequence, 2),
        other => panic!("{other:?}"),
    }
    assert!(ingress.complete_gpu(id));
}

#[test]
fn late_and_not_ready_do_not_block_last_ready() {
    let mut factory = SharedGpuFactory::new();
    let gpu = factory.open(GpuCaps::host_default()).expect("gpu");
    let mut ingress = SurfaceFrameIngress::new(gpu.device_epoch());
    let id = ingress
        .declare(VisualSurfaceDeclare::reference("vs.reference"))
        .unwrap();
    let ready = ready_frame(gpu, id, 1, 3);
    ingress.submit(gpu, ready).unwrap();
    let late = SurfaceFrame {
        sequence: 1,
        ..ready_frame(gpu, id, 1, 1)
    };
    assert_eq!(
        ingress.submit(gpu, late),
        Ok(IngressAccept::Dropped {
            reason: IngressDropReason::Late
        })
    );
    let not_ready = SurfaceFrame {
        surface: id,
        generation: 1,
        sequence: 4,
        timestamp: PresentationTime::from_millis(64),
        content: SurfaceContent::NotReady,
        damage: None,
        fence: Some(SurfaceFence {
            ready: false,
            device_epoch: gpu.device_epoch(),
        }),
    };
    assert_eq!(
        ingress.submit(gpu, not_ready),
        Ok(IngressAccept::Dropped {
            reason: IngressDropReason::NotReady
        })
    );
    match ingress.present_sample(id) {
        PresentSample::Ready(frame) => assert_eq!(frame.sequence, 3),
        other => panic!("{other:?}"),
    }
}

#[test]
fn recovery_bumps_generation_and_rejects_old_frames() {
    let mut factory = SharedGpuFactory::new();
    let gpu = factory.open(GpuCaps::host_default()).expect("gpu");
    let mut ingress = SurfaceFrameIngress::new(gpu.device_epoch());
    let id = ingress
        .declare(VisualSurfaceDeclare::reference("vs.reference"))
        .unwrap();
    let ready = ready_frame(gpu, id, 1, 1);
    ingress.submit(gpu, ready).unwrap();
    let mut recovery = GpuRecovery::new();
    recovery.initialize().unwrap();
    let new_epoch = gpu.on_device_lost(&mut recovery).unwrap();
    ingress.recover_device(new_epoch);
    assert_eq!(ingress.device_epoch(), DeviceEpoch(1));
    assert!(matches!(
        ingress.present_sample(id),
        PresentSample::Fallback { .. }
    ));
    let stale = ready_frame(gpu, id, 1, 2);
    assert_eq!(
        ingress.submit(gpu, stale),
        Err(IngressReject::StaleGeneration)
    );
    let restored = ready_frame(gpu, id, 2, 1);
    assert_eq!(ingress.submit(gpu, restored), Ok(IngressAccept::Queued));
}

#[test]
fn raster_owner_and_readback_usage_are_rejected() {
    let mut factory = SharedGpuFactory::new();
    let gpu = factory.open(GpuCaps::host_default()).expect("gpu");
    gpu.bind_raster().unwrap();
    let mut ingress = SurfaceFrameIngress::new(gpu.device_epoch());
    let id = ingress
        .declare(VisualSurfaceDeclare::reference("vs.reference"))
        .unwrap();
    let raster = gpu
        .alloc(HandleOwner::Raster, SharedHandleKind::RasterTile)
        .unwrap();
    let bad_owner = SurfaceFrame {
        surface: id,
        generation: 1,
        sequence: 1,
        timestamp: PresentationTime::from_millis(16),
        content: SurfaceContent::Sampleable {
            handle: raster,
            width: 64,
            height: 64,
            format: DEFAULT_FORMAT.texture_format,
            usage: DEFAULT_FORMAT.usage,
            bytes: 16,
        },
        damage: None,
        fence: Some(SurfaceFence {
            ready: true,
            device_epoch: gpu.device_epoch(),
        }),
    };
    assert_eq!(
        ingress.submit(gpu, bad_owner),
        Err(IngressReject::Ownership)
    );
    let handle = gpu.alloc_surface().unwrap();
    let readback = SurfaceFrame {
        surface: id,
        generation: 1,
        sequence: 1,
        timestamp: PresentationTime::from_millis(16),
        content: SurfaceContent::Sampleable {
            handle,
            width: 64,
            height: 64,
            format: DEFAULT_FORMAT.texture_format,
            usage: TextureUsageFlags::SAMPLE.union(TextureUsageFlags::CPU_READBACK),
            bytes: 16,
        },
        damage: None,
        fence: Some(SurfaceFence {
            ready: true,
            device_epoch: gpu.device_epoch(),
        }),
    };
    assert_eq!(
        ingress.submit(gpu, readback),
        Err(IngressReject::ReadbackForbidden)
    );
}

#[test]
fn surface_cap_and_unknown_id_fail_closed() {
    let mut ingress = SurfaceFrameIngress::new(DeviceEpoch(0));
    for n in 0..INGRESS_SURFACE_CAP {
        ingress
            .declare(VisualSurfaceDeclare::reference(format!("vs.{n}")))
            .unwrap();
    }
    assert_eq!(
        ingress.declare(VisualSurfaceDeclare::reference("vs.overflow")),
        Err(IngressReject::SurfaceCap)
    );
    assert!(matches!(
        ingress.present_sample(SurfaceId(99)),
        PresentSample::Fallback { .. }
    ));
}
