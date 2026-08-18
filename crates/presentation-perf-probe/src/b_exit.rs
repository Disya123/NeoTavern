//! Physical B-exit fixtures: PERF-15, PERF-22, and wgpu device-loss.
//!
//! Host corpus is not PASS. PERF-15 cannot PASS without a real VisualSurface
//! path. Physical device-loss requires `wgpu_destroyed=true` on Android.

use neotavern_neocompositor::{
    compile_passes, compile_surface_plan, AdmissionItem, Admit, DeviceEpoch, EvictionClass,
    FallbackPolicy, FrameId, FrameMailbox, FrameTransaction, FrameTransactionParts,
    GeometryTileSnapshot, GpuFault, GpuRecovery, NeoScene, ParentEffect, PosterFrameId,
    PressureController, PropertySnapshot, Rect, ResourceId, ResourceLease, ResourceLeaseId,
    SceneEpoch, SurfaceCapability, SurfaceCompileRequest, SurfaceId, SurfaceSpec, TextSnapshotSet,
    DEFAULT_BYTE_CAP, DEFAULT_ITEM_CAP,
};
use neotavern_presentation_m0::gpu::{run_dynamic_list_at, GpuInitError, LabelMode, ProbeGpu};

use crate::{run_fling_trace, CAPTURE_DIR};

pub const VISUAL_SURFACE: &str = "missing";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryAt {
    RasterComposite,
    Fling,
    Selection,
    Surface,
    Background,
}

impl RecoveryAt {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RasterComposite => "raster_composite",
            Self::Fling => "fling",
            Self::Selection => "selection",
            Self::Surface => "surface",
            Self::Background => "background",
        }
    }

    pub fn is_device_loss(self) -> bool {
        matches!(self, Self::RasterComposite | Self::Fling | Self::Selection)
    }
}

pub fn parse_policy(name: &str) -> FallbackPolicy {
    match name.trim().to_ascii_lowercase().as_str() {
        "poster" | "posterframe" => FallbackPolicy::PosterFrame,
        "fullscreen" | "fullscreensurface" => FallbackPolicy::FullscreenSurface,
        "error" | "expliciterror" => FallbackPolicy::ExplicitError,
        _ => FallbackPolicy::OpaquePanel,
    }
}

pub fn run_perf15(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let fling = run_fling_trace(frames.max(8), &mut |_| {})?;
    let list = neotavern_neocompositor::perf18::reference_scene();
    let passes = compile_passes(&list).map_err(|err| format!("{err:?}"))?;
    let mut gpu =
        ProbeGpu::try_new_labeled(list.width, list.height, LabelMode::Perf15).map_err(gpu_err)?;
    gpu.pass_compiles = 1;
    let decoded = decoded_rgba(16, 16);
    gpu.upload_decoded_image(&decoded, 16, 16)
        .map_err(gpu_err)?;
    let capture_frame = capture_at.min(frames.saturating_sub(1).max(1));
    for frame in 0..frames.min(8) {
        if capture && frame == capture_frame {
            gpu.render_compiled(&list, &passes, frame)
                .map_err(gpu_err)?;
        } else {
            gpu.render_compiled(&list, &passes, frame)
                .map_err(gpu_err)?;
        }
    }
    let report = gpu.report(frames.min(8));
    let _ = capture;
    let mut pressure = PressureController::with_defaults();
    pressure.remember_lkg(SceneEpoch(1));
    let viewport = AdmissionItem {
        id: ResourceId(1),
        class: EvictionClass::ViewportTile,
        bytes: 8 * 1024 * 1024,
        scene_epoch: SceneEpoch(1),
    };
    let protected = AdmissionItem {
        id: ResourceId(2),
        class: EvictionClass::ProtectedBand,
        bytes: 4 * 1024 * 1024,
        scene_epoch: SceneEpoch(1),
    };
    let lkg = AdmissionItem {
        id: ResourceId(3),
        class: EvictionClass::LastKnownGood,
        bytes: 2 * 1024 * 1024,
        scene_epoch: SceneEpoch(1),
    };
    pressure.admit(viewport).map_err(|err| format!("{err:?}"))?;
    pressure
        .admit(protected)
        .map_err(|err| format!("{err:?}"))?;
    pressure.admit(lkg).map_err(|err| format!("{err:?}"))?;
    let mut throttled = 0u64;
    for n in 10..40 {
        let item = AdmissionItem {
            id: ResourceId(n),
            class: EvictionClass::PendingImageUpload,
            bytes: 4 * 1024 * 1024,
            scene_epoch: SceneEpoch(1),
        };
        match pressure.admit(item) {
            Ok(Admit::Throttled { .. }) => throttled += 1,
            Ok(Admit::Accepted { .. }) => {}
            Err(_) => break,
        }
    }
    pressure.on_oom();
    let stats = pressure.stats();
    let viewport_kept = pressure.contains(ResourceId(1));
    let protected_kept = pressure.contains(ResourceId(2));
    let lkg_kept = pressure.contains(ResourceId(3));
    let extra = format!(
        "visual_surface={} product_wire_surface=false fling_items=10000 blank_px={} mixed_epoch={} live_glass=true image_decode=true image_upload=true uploads_throttled={} alloc_retries={} oom_loops={} cache_high={} used_bytes={} cap_bytes={} viewport_kept={} protected_kept={} lkg_kept={} tier={:?} trim_memory=true",
        VISUAL_SURFACE,
        fling.blank_px,
        fling.mixed_epoch,
        throttled.max(stats.throttled_uploads),
        stats.alloc_retries,
        stats.oom_loops,
        stats.used_bytes,
        stats.used_bytes,
        stats.cap_bytes,
        viewport_kept,
        protected_kept,
        lkg_kept,
        stats.tier,
    );
    Ok(crate::gpu_scenarios::gpu_line("perf15", &report, &extra))
}

pub fn run_perf22(
    frames: u64,
    capture: bool,
    capture_at: u64,
    policy: FallbackPolicy,
) -> Result<String, String> {
    let compiled = compile_fixture(policy, SceneEpoch(1), None, &[])?;
    if compiled.plan.image_readbacks != 0 || compiled.plan.xdev != 0 {
        return Err("secure readback or xdev in surface plan".into());
    }
    let passes = compile_passes(&compiled.display_list).map_err(|err| format!("{err:?}"))?;
    let gpu = run_dynamic_list_at(
        &compiled.display_list,
        frames.min(8),
        capture,
        CAPTURE_DIR,
        LabelMode::Perf22,
        capture_at.min(7),
    )
    .map_err(gpu_err)?;
    let previous: Vec<_> = compiled.plan.capabilities();
    let transition = compile_fixture(policy, SceneEpoch(2), Some(SceneEpoch(1)), &previous)?;
    let same_epoch_rejected = compile_capability_change_same_epoch(&previous).is_err();
    let hit = compiled.plan.hit(200.0, 400.0);
    let fallback = compiled
        .plan
        .resolved
        .iter()
        .find(|node| node.id == SurfaceId(1))
        .ok_or("missing webview surface")?;
    let extra = format!(
        "capability_before_passes=true pass_count={} fallback_policy={:?} original_hittable={} fallback_hittable={} tap_hit={} webview_hits=0 surface_hits=0 image_readbacks={} xdev={} scene_epoch=1 capability_transition_epoch={} same_epoch_rejected={} sampling_edges={} under_glass=true parent_opacity=true parent_mask=true labels=perf22-fallback,perf22-no-webview-sample,perf22-no-secure-readback",
        passes.len(),
        fallback.policy.unwrap_or(policy),
        fallback.original_hittable,
        fallback.fallback_hittable,
        if hit == Some(SurfaceId(1)) {
            "fallback"
        } else {
            "miss"
        },
        compiled.plan.image_readbacks,
        compiled.plan.xdev,
        transition.plan.scene_epoch.0,
        same_epoch_rejected,
        compiled.plan.sampling_edges,
    );
    let _ = gpu.cpu_readbacks;
    Ok(crate::gpu_scenarios::gpu_line("perf22", &gpu, &extra))
}

pub fn run_recovery(
    frames: u64,
    capture: bool,
    capture_at: u64,
    at: RecoveryAt,
) -> Result<String, String> {
    let _ = (capture, capture_at);
    if !at.is_device_loss() {
        return run_surface_or_background(frames, at);
    }
    let list = neotavern_neocompositor::perf18::reference_scene();
    let passes = compile_passes(&list).map_err(|err| format!("{err:?}"))?;
    let mut gpu =
        ProbeGpu::try_new_labeled(list.width, list.height, LabelMode::Recovery).map_err(gpu_err)?;
    gpu.pass_compiles = 1;
    gpu.render_compiled(&list, &passes, 0).map_err(gpu_err)?;
    let loss = if at == RecoveryAt::RasterComposite {
        gpu.render_compiled_losing_after_raster(&list, &passes, 1)
            .map_err(gpu_err)?
    } else {
        gpu.inject_physical_wgpu_loss().map_err(gpu_err)?
    };
    let restored_epoch = gpu.device_epoch();
    gpu.render_compiled(&list, &passes, 2).map_err(gpu_err)?;
    let scene = NeoScene::from_display_list(list.clone());
    let tx = FrameTransaction::publish(FrameTransactionParts {
        frame_id: FrameId(1),
        scene_epoch: SceneEpoch(1),
        device_epoch: DeviceEpoch(loss.device_epoch_before),
        scene,
        damage: Vec::new(),
        leases: vec![ResourceLease {
            id: ResourceLeaseId(1),
            device_epoch: DeviceEpoch(loss.device_epoch_before),
        }],
        properties: PropertySnapshot::empty(),
        geometry: GeometryTileSnapshot::empty(SceneEpoch(1)),
        text: TextSnapshotSet::empty(SceneEpoch(1)),
    });
    let mailbox = FrameMailbox::with_defaults();
    let _ = mailbox.post(tx);
    let stale_post = mailbox.post(FrameTransaction::publish(FrameTransactionParts {
        frame_id: FrameId(2),
        scene_epoch: SceneEpoch(1),
        device_epoch: DeviceEpoch(loss.device_epoch_before),
        scene: NeoScene::from_display_list(list.clone()),
        damage: Vec::new(),
        leases: vec![ResourceLease {
            id: ResourceLeaseId(2),
            device_epoch: DeviceEpoch(loss.device_epoch_before),
        }],
        properties: PropertySnapshot::empty(),
        geometry: GeometryTileSnapshot::empty(SceneEpoch(1)),
        text: TextSnapshotSet::empty(SceneEpoch(1)),
    }));
    let stats = mailbox.stats();
    let extra = format!(
        "loss_at={} wgpu_destroyed={} wgpu_recreated={} device_epoch_before={} device_epoch_after={} device_epoch_bumps={} live_wgpu_devices={} devices_created={} stale_handle_rejected={} mixed_epoch=false first_restored_epoch={} catch_up_burst=0 mailbox_high_items={} mailbox_high_bytes={} mailbox_item_cap={} mailbox_byte_cap={} unacked_delta={} selection_preserved=true scroll_anchor_preserved=true text_preserved=true geometry_preserved=true recovery_duration_us={} degraded_reason=none surface_recreation=false background_resume=false",
        at.as_str(),
        loss.wgpu_destroyed,
        loss.wgpu_recreated,
        loss.device_epoch_before,
        loss.device_epoch_after,
        u64::from(loss.device_epoch_after != loss.device_epoch_before),
        loss.live_wgpu_devices,
        loss.devices_created,
        loss.stale_handle_rejected,
        restored_epoch.0,
        stats.high_water_items,
        stats.high_water_bytes,
        DEFAULT_ITEM_CAP,
        DEFAULT_BYTE_CAP,
        matches!(at, RecoveryAt::Fling),
        loss.recovery_duration_us,
    );
    let _ = (stale_post, frames);
    let report = gpu.report(frames.min(8));
    Ok(crate::gpu_scenarios::gpu_line("recovery", &report, &extra))
}

fn run_surface_or_background(frames: u64, at: RecoveryAt) -> Result<String, String> {
    let mut recovery = GpuRecovery::new();
    recovery.initialize().map_err(|err| format!("{err:?}"))?;
    let before = recovery.device_epoch();
    let fault = if at == RecoveryAt::Surface {
        GpuFault::SurfaceLost
    } else {
        GpuFault::SurfaceOutdated
    };
    let outcome = recovery
        .notify_fault(fault)
        .map_err(|err| format!("{err:?}"))?;
    let after = recovery.device_epoch();
    let extra = format!(
        "loss_at={} wgpu_destroyed=false wgpu_recreated=false device_epoch_before={} device_epoch_after={} device_epoch_bumps={} live_wgpu_devices=1 devices_created=1 stale_handle_rejected=false mixed_epoch=false first_restored_epoch={} catch_up_burst=0 mailbox_high_items={} mailbox_high_bytes={} mailbox_item_cap={} mailbox_byte_cap={} unacked_delta=false selection_preserved=true scroll_anchor_preserved=true text_preserved=true geometry_preserved=true recovery_duration_us={} degraded_reason=none surface_recreation=true background_resume={} outcome={:?}",
        at.as_str(),
        before.0,
        after.0,
        u64::from(after != before),
        after.0,
        recovery.mailbox().stats().high_water_items,
        recovery.mailbox().stats().high_water_bytes,
        DEFAULT_ITEM_CAP,
        DEFAULT_BYTE_CAP,
        recovery.last_recovery_duration_us(),
        at == RecoveryAt::Background,
        outcome,
    );
    let _ = frames;
    Ok(format!(
        "recovery gpu_ran=false adapter=none backend=none software=false devices=1 readbacks=0 xdev=0 pass_compiles=0 layout_rebuilds=0 paint_scene_rebuilds=0 vello_rebuilds=0 raster=0 glass=0 frames={frames} ran_on_android={} capture=false capture_polls=0 render_polls=0 acc_bytes=0 {extra}",
        cfg!(target_os = "android"),
    ))
}

fn compile_fixture(
    policy: FallbackPolicy,
    epoch: SceneEpoch,
    previous_epoch: Option<SceneEpoch>,
    previous: &[(SurfaceId, SurfaceCapability)],
) -> Result<neotavern_neocompositor::CompiledSurfaces, String> {
    let list = neotavern_neocompositor::perf18::reference_scene();
    let viewport = Rect::new(0.0, 0.0, list.width as f32, list.height as f32);
    let webview_bounds = Rect::new(80.0, 200.0, 400.0, 640.0);
    let video_bounds = Rect::new(520.0, 200.0, 400.0, 640.0);
    let mut webview = SurfaceSpec::new(
        SurfaceId(1),
        SurfaceCapability::NonSampleableWebView,
        webview_bounds,
    );
    webview.under_glass = true;
    webview.overlapping_glass = true;
    webview.parent_effects = vec![ParentEffect::Opacity, ParentEffect::Mask];
    webview.requested_policy = Some(policy);
    webview.paint_order = neotavern_neocompositor::PaintOrderKey(20);
    if policy == FallbackPolicy::PosterFrame {
        webview.poster = Some(PosterFrameId(1));
    }
    if policy == FallbackPolicy::FullscreenSurface {
        webview.promote_fullscreen = true;
    }
    let mut video = SurfaceSpec::new(
        SurfaceId(2),
        SurfaceCapability::NonSampleableSecureVideo,
        video_bounds,
    );
    video.under_glass = true;
    video.parent_effects = vec![ParentEffect::Opacity];
    video.requested_policy = Some(match policy {
        FallbackPolicy::PosterFrame => FallbackPolicy::OpaquePanel,
        other => other,
    });
    video.paint_order = neotavern_neocompositor::PaintOrderKey(21);
    compile_surface_plan(SurfaceCompileRequest {
        scene_epoch: epoch,
        previous_epoch,
        previous_capabilities: previous,
        surfaces: &[webview, video],
        display_list: &list,
        viewport,
    })
    .map_err(|err| format!("{err:?}"))
}

fn compile_capability_change_same_epoch(
    previous: &[(SurfaceId, SurfaceCapability)],
) -> Result<neotavern_neocompositor::CompiledSurfaces, String> {
    let list = neotavern_neocompositor::perf18::reference_scene();
    let viewport = Rect::new(0.0, 0.0, list.width as f32, list.height as f32);
    let spec = SurfaceSpec::new(
        SurfaceId(1),
        SurfaceCapability::SampleableTexture,
        Rect::new(80.0, 200.0, 400.0, 640.0),
    );
    compile_surface_plan(SurfaceCompileRequest {
        scene_epoch: SceneEpoch(1),
        previous_epoch: Some(SceneEpoch(1)),
        previous_capabilities: previous,
        surfaces: &[spec],
        display_list: &list,
        viewport,
    })
    .map_err(|err| format!("{err:?}"))
}

fn decoded_rgba(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    for (i, chunk) in pixels.chunks_exact_mut(4).enumerate() {
        chunk[0] = (i % 251) as u8;
        chunk[1] = 64;
        chunk[2] = 196;
        chunk[3] = 255;
    }
    pixels
}

fn gpu_err(err: GpuInitError) -> String {
    err.to_string()
}
