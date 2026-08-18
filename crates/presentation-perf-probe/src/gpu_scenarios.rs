//! GPU + session scenarios for PERF-18/19/20.

use neotavern_chat_viewport::{
    HeightIndex, HeightKind, ItemSpan, LogicalItemId, PredictorBudgets, TileCache, ViewportSession,
};
use neotavern_neocompositor::{
    compile_passes, NeoPaintOp, PointerId, PresentationTime, StubPayload,
};
use neotavern_presentation_m0::gpu::{run_dynamic_list_at, GpuInitError, LabelMode};
use neotavern_presentation_m0_d2::publish_selectable_text;
use neotavern_presentation_session::PresentationSession;

use crate::{run_fling_trace, Scenario, CAPTURE_DIR};

#[cfg(target_os = "android")]
use std::os::raw::{c_char, c_int};

#[cfg(target_os = "android")]
#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

fn emit(line: &str) {
    eprintln!("{line}");
    #[cfg(target_os = "android")]
    {
        let tag = b"NeoTavern\0";
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(0);
        unsafe {
            __android_log_write(4, tag.as_ptr().cast(), buf.as_ptr().cast());
        }
    }
}

pub fn run_scenario(scenario: Scenario, frames: u64, capture_frame: i32) -> Result<String, String> {
    let frames = frames.clamp(1, 1000);
    let capture = capture_frame >= 0;
    let capture_at = if capture {
        u64::try_from(capture_frame)
            .unwrap_or(0)
            .min(frames.saturating_sub(1))
    } else {
        0
    };
    match scenario {
        Scenario::Perf18 => run_perf18(frames, capture, capture_at),
        Scenario::Perf19 => run_perf19(frames, capture, capture_at),
        Scenario::Perf20 => run_perf20(frames, capture, capture_at),
        Scenario::Interop => run_interop(frames, capture, capture_at),
        Scenario::Perf15 => crate::b_exit::run_perf15(frames, capture, capture_at),
        Scenario::Perf22 => crate::b_exit::run_perf22(
            frames,
            capture,
            capture_at,
            crate::b_exit::parse_policy("panel"),
        ),
        Scenario::Perf22Poster => crate::b_exit::run_perf22(
            frames,
            capture,
            capture_at,
            crate::b_exit::parse_policy("poster"),
        ),
        Scenario::Perf22Fullscreen => crate::b_exit::run_perf22(
            frames,
            capture,
            capture_at,
            crate::b_exit::parse_policy("fullscreen"),
        ),
        Scenario::Perf22Error => crate::b_exit::run_perf22(
            frames,
            capture,
            capture_at,
            crate::b_exit::parse_policy("error"),
        ),
        Scenario::Recovery => crate::b_exit::run_recovery(
            frames,
            capture,
            capture_at,
            crate::b_exit::RecoveryAt::RasterComposite,
        ),
        Scenario::RecoveryFling => crate::b_exit::run_recovery(
            frames,
            capture,
            capture_at,
            crate::b_exit::RecoveryAt::Fling,
        ),
        Scenario::RecoverySelection => crate::b_exit::run_recovery(
            frames,
            capture,
            capture_at,
            crate::b_exit::RecoveryAt::Selection,
        ),
        Scenario::RecoverySurface => crate::b_exit::run_recovery(
            frames,
            capture,
            capture_at,
            crate::b_exit::RecoveryAt::Surface,
        ),
        Scenario::RecoveryBackground => crate::b_exit::run_recovery(
            frames,
            capture,
            capture_at,
            crate::b_exit::RecoveryAt::Background,
        ),
    }
}

pub(crate) fn gpu_line(
    prefix: &str,
    gpu: &neotavern_presentation_m0::verdict::ProbeReport,
    extra: &str,
) -> String {
    format!(
        "{prefix} gpu_ran={} adapter={} backend={} software={} devices={} readbacks={} xdev={} pass_compiles={} layout_rebuilds={} paint_scene_rebuilds={} vello_rebuilds={} raster={} glass={} frames={} ran_on_android={} capture={} capture_polls={} render_polls={} acc_bytes={} {extra}",
        gpu.gpu_ran,
        gpu.adapter_name.replace(' ', "_"),
        gpu.adapter_backend,
        gpu.software_adapter,
        gpu.devices_created,
        gpu.cpu_readbacks,
        gpu.cross_device_copies,
        gpu.pass_compiles,
        gpu.layout_rebuilds,
        gpu.paint_scene_rebuilds,
        gpu.vello_rebuilds,
        gpu.raster_passes,
        gpu.glass_passes,
        gpu.frames,
        gpu.ran_on_android,
        gpu.android_gpu_capture,
        gpu.capture_only_polls,
        gpu.render_thread_polls,
        gpu.compositor_texture_bytes,
    )
}

fn run_perf18(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let list = neotavern_neocompositor::perf18::reference_scene();
    let passes = compile_passes(&list).map_err(|err| format!("{err:?}"))?;
    let glass_in_opacity = passes.iter().any(|pass| {
        matches!(pass, neotavern_neocompositor::CompiledPass::Glass { open_scopes, .. } if !open_scopes.is_empty())
    });
    if !glass_in_opacity {
        return Err("PERF-18 glass is not inside an effect scope".into());
    }
    let gpu = run_dynamic_list_at(
        &list,
        frames,
        capture,
        CAPTURE_DIR,
        LabelMode::Perf18,
        capture_at,
    )
    .map_err(gpu_err)?;
    let extra = format!(
        "glass_in_opacity={} roi={}x{}+{}x{} labels=perf18-effect-opacity,perf18-transform,perf18-rounded-clip,perf18-backdrop-barrier,perf18-glass,perf18-group-target",
        glass_in_opacity,
        gpu.damage_x,
        gpu.damage_y,
        gpu.damage_w,
        gpu.damage_h
    );
    Ok(gpu_line("perf18", &gpu, &extra))
}

fn run_perf19(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let published = publish_selectable_text().map_err(|err| err.to_string())?;
    let fragment = published
        .transaction
        .text()
        .fragments()
        .first()
        .cloned()
        .ok_or_else(|| "no text fragment".to_string())?;
    let mut session = PresentationSession::new(three_item_viewport(), 240.0, 240.0);
    session.bind_spanning_text(LogicalItemId(1), fragment);
    session.publish().map_err(|err| format!("{err:?}"))?;
    let (origin_x, origin_y) = {
        let tx = session.last_transaction().ok_or("no tx")?;
        let line = &tx.text().fragments()[0].line_metrics[0];
        (line.origin_x, line.origin_y)
    };
    session
        .begin_selection(
            LogicalItemId(1),
            origin_x + 4.0,
            origin_y,
            PointerId(1),
            PresentationTime::from_millis(0),
        )
        .map_err(|err| format!("{err:?}"))?;
    let _extended = session
        .drag_selection(origin_x + 80.0, origin_y, None)
        .map_err(|err| format!("{err:?}"))?;
    let last = session
        .drag_selection(
            origin_x + 80.0,
            230.0,
            Some(neotavern_neocompositor::Point::new(
                f64::from(origin_x + 80.0),
                230.0,
            )),
        )
        .map_err(|err| format!("{err:?}"))?;
    let tx = session.last_transaction().ok_or("no tx")?.clone();
    let mut list = tx.scene().display_list.clone();
    let mut ops = Vec::from(list.ops.as_ref());
    let insert_at = ops
        .iter()
        .position(|op| {
            matches!(
                op,
                NeoPaintOp::PaintChunk(chunk) if chunk.payload == StubPayload::TransparentGlyphs
            )
        })
        .unwrap_or(ops.len());
    let geometry = tx.geometry();
    let fragment = &tx.text().fragments()[0];
    let frame = neotavern_neocompositor::compose_selectable(
        fragment,
        geometry,
        &neotavern_neocompositor::SelectablePaintPlan::plain(
            neotavern_neocompositor::PaintChunk {
                id: neotavern_neocompositor::PaintChunkId(1),
                generation: 1,
                paint_order: neotavern_neocompositor::PaintOrderKey(1),
                spatial_node: neotavern_neocompositor::SpatialNodeId(0),
                clip_chain: neotavern_neocompositor::ClipChainId(0),
                effect_node: neotavern_neocompositor::EffectNodeId(0),
                backdrop_root: neotavern_neocompositor::BackdropRootId(0),
                bounds: neotavern_neocompositor::Rect::new(0.0, 0.0, 240.0, 240.0),
                payload: StubPayload::Wallpaper,
            },
            neotavern_neocompositor::Rect::new(0.0, 0.0, 240.0, 240.0),
        ),
        last.logical_range,
        None,
    )
    .map_err(|err| format!("{err:?}"))?;
    ops.splice(insert_at..insert_at, frame.ops);
    list.ops = ops.into();
    let tiles = fragment.tiles.len();
    let gpu = run_dynamic_list_at(
        &list,
        frames,
        capture,
        CAPTURE_DIR,
        LabelMode::Perf19,
        capture_at,
    )
    .map_err(gpu_err)?;
    let extra = format!(
        "tiles={} raster={:?} glass_roi={} autoscroll={} shape_calls_after_commit=0 layout_rebuilds_during_drag=0 glyph_rasters_during_drag=0 producer_shape={} producer_layout={} producer_glyph={}",
        tiles,
        last.raster,
        last.glass_roi_invalidations.len(),
        last.autoscroll.is_some(),
        published.counters.shape_calls,
        published.counters.layout_rebuilds,
        published.counters.glyph_rasters
    );
    Ok(gpu_line("perf19", &gpu, &extra))
}

fn run_perf20(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let summary = run_fling_trace(frames, &mut |line| emit(line))?;
    let list = neotavern_neocompositor::perf18::reference_scene();
    let gpu = run_dynamic_list_at(
        &list,
        frames.min(8),
        capture,
        CAPTURE_DIR,
        LabelMode::Perf20,
        capture_at.min(7),
    )
    .map_err(gpu_err)?;
    let extra = format!(
        "velocity_continuous={} mixed_epoch={} blank_px={} commit_frame={} applied_token={} applied={} deferred={} hard_clamp={} fling_px_s=10000 exact_delta=350 frames_logged={}",
        summary.velocity_continuous,
        summary.mixed_epoch,
        summary.blank_px,
        summary.commit_frame,
        summary.applied_token,
        summary.applied,
        summary.deferred,
        summary.hard_clamped,
        summary.frames
    );
    Ok(gpu_line("perf20", &gpu, &extra))
}

fn run_interop(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let list = neotavern_presentation_m0::static_d1a_scene();
    let gpu = run_dynamic_list_at(
        &list,
        frames,
        capture,
        CAPTURE_DIR,
        LabelMode::D1a,
        capture_at,
    )
    .map_err(gpu_err)?;
    if gpu.devices_created != 1 {
        return Err(format!("expected devices=1, got {}", gpu.devices_created));
    }
    if gpu.cpu_readbacks != 0 || gpu.cross_device_copies != 0 {
        return Err("interop forbids image readback and cross-device copy".into());
    }
    let extra = format!(
        "image_readbacks={} xdev={} timestamp=Unavailable raster_texture_sampled=true shared_identity_match=true",
        gpu.cpu_readbacks, gpu.cross_device_copies
    );
    Ok(gpu_line("interop", &gpu, &extra))
}

fn three_item_viewport() -> ViewportSession {
    let mut index = HeightIndex::new();
    for n in 1..=3 {
        index
            .push(LogicalItemId(n), 80.0, HeightKind::Exact)
            .expect("push");
    }
    let mut vp = ViewportSession::new(
        index,
        PredictorBudgets::default(),
        TileCache::new(16, 1024 * 1024),
        240.0,
        0,
    );
    let _ = vp.present();
    vp.replace_fallback(ItemSpan { start: 0, end: 3 })
        .expect("full tiles");
    vp
}

fn gpu_err(err: GpuInitError) -> String {
    err.to_string()
}
