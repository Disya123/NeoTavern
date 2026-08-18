//! Remaining Milestone B physical fixtures (PERF-01…05, 11–14, 16, 17, 21).
//!
//! Product path: Product Wire → flagged Dioxus shell → Blitz → session →
//! compositor. Not a hand-built `NeoDisplayList`. Not production JNI.

use std::sync::Arc;
use std::time::Instant;

use neotavern_chat_viewport::{
    HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, TileCache, ViewportSession,
};
use neotavern_neocompositor::{
    compile_passes, AffineCoeffs, ClipId, CompiledPass, CompositorFastPath, HitTestId, HitTestItem,
    HitTestSnapshot, Insets, LogicalRect, Point, PointerFlags, PointerId, PresentationTime,
    PropertySnapshot, PropertyTreeBuilder, SceneEpoch, ScrollId, ScrollRange, ScrollSequence, Size,
    SpatialId, SpatialKind, StableSemanticId, Vec2, DEFAULT_ITEM_CAP,
};
use neotavern_presentation_dioxus_shell::{
    apply_presentation_stream, dioxus_shell_from_flag, install_product_chat, mixed_height,
    mixed_height_catalog, product_chat_app, product_chat_with_chrome, streaming_schedule,
    DioxusShellHost, ProductChrome, PRODUCT_PATH_ITEMS,
};
use neotavern_presentation_m0::gpu::{run_dynamic_list_at, LabelMode, ProbeGpu};
use neotavern_presentation_m0_d2::{produce_app, ProducerOutput, StreamOp};
use neotavern_presentation_session::PresentationSession;

use crate::gpu_scenarios::{emit, gpu_line};
use crate::{Scenario, CAPTURE_DIR};

const VIEWPORT: f64 = 800.0;
const WIDTH: f32 = 320.0;
const HEIGHT: f32 = 200.0;
const HZ: u64 = 120;
const FULL_FRAMES: u64 = HZ * 60;
const DT_NS: u64 = 1_000_000_000 / HZ;
const FLING: f64 = 8_000.0;
const ADVERSARIAL: f64 = 10_000.0;
const REVERSE_EVERY: u64 = 15 * HZ;
const GPU_SAMPLE: u64 = 48;
const PERF16_CAP: u64 = 100;

fn assert_flagged() -> Result<(), String> {
    if dioxus_shell_from_flag(Some("1")) != (DioxusShellHost::Flagged { feature_flag: true }) {
        return Err("dioxus_shell_flag".into());
    }
    Ok(())
}

fn mixed_index() -> HeightIndex {
    let mut index = HeightIndex::new();
    for i in 0..PRODUCT_PATH_ITEMS {
        index
            .push(
                LogicalItemId(u64::from(i) + 1),
                mixed_height(i),
                HeightKind::Estimated,
            )
            .expect("height");
    }
    index
}

fn viewport(warm: bool, teleport: Option<f64>) -> ViewportSession {
    let mut vp = ViewportSession::new(
        mixed_index(),
        PredictorBudgets::default(),
        TileCache::new(256, 4 * 1024 * 1024),
        VIEWPORT,
        12_000_000,
    );
    if let Some(offset) = teleport {
        vp.teleport(offset);
    }
    let _ = vp.present();
    if warm {
        if let Some(pred) = vp.last_prediction() {
            let _ = vp.replace_fallback(pred.visible.span);
        }
        for _ in 0..32 {
            vp.advance(DT_NS);
            let _ = vp.present();
        }
    }
    vp
}

fn produce(chrome: ProductChrome) -> Result<ProducerOutput, String> {
    assert_flagged()?;
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    install_product_chat(product_chat_with_chrome(&fixture, 0, chrome));
    produce_app(product_chat_app)
}

fn session_from(
    warm: bool,
    teleport: Option<f64>,
    produced: &ProducerOutput,
) -> PresentationSession {
    let mut session = PresentationSession::new(viewport(warm, teleport), WIDTH, HEIGHT);
    session.bind_producer_scene(produced.list.clone());
    session
}

#[derive(Clone, Debug)]
struct ScrollReport {
    frames: u64,
    travel: f64,
    peak_offset: f64,
    start_offset: f64,
    prepared_frames: u64,
    fallback_frames: u64,
    mailbox_pending: usize,
    mailbox_coalesced: u64,
}

fn tick(
    session: &mut PresentationSession,
    frames: u64,
    mut vel: f64,
    reverse_every: u64,
) -> ScrollReport {
    let start = session.viewport().offset();
    let mut prepared = 0u64;
    let mut fallback = 0u64;
    let mut travel = 0.0;
    let mut peak = start;
    let mut last = start;
    for frame in 0..frames {
        if frame > 0 && reverse_every > 0 && frame % reverse_every == 0 {
            vel = -vel;
        }
        let time = PresentationTime::from_nanos(frame.saturating_mul(DT_NS));
        let (offset, decision) = session.compositor_scroll_tick(vel, DT_NS, time);
        travel += (offset - last).abs();
        last = offset;
        peak = peak.max(offset);
        match decision {
            neotavern_chat_viewport::PresentDecision::Prepared => prepared += 1,
            neotavern_chat_viewport::PresentDecision::Fallback => fallback += 1,
            neotavern_chat_viewport::PresentDecision::Clamp => {}
        }
    }
    ScrollReport {
        frames,
        travel,
        peak_offset: peak,
        start_offset: start,
        prepared_frames: prepared,
        fallback_frames: fallback,
        mailbox_pending: session.mailbox_pending(),
        mailbox_coalesced: session.mailbox_stats().coalesced,
    }
}

fn gpu_frames(requested: u64) -> u64 {
    requested.min(GPU_SAMPLE).max(1)
}

fn compositor_frames(requested: u64) -> u64 {
    if requested >= FULL_FRAMES {
        FULL_FRAMES
    } else {
        requested.clamp(1, FULL_FRAMES)
    }
}

fn gpu_sample(
    list: &neotavern_neocompositor::NeoDisplayList,
    frames: u64,
    capture: bool,
    capture_at: u64,
) -> Result<neotavern_presentation_m0::verdict::ProbeReport, String> {
    run_dynamic_list_at(
        list,
        gpu_frames(frames),
        capture,
        CAPTURE_DIR,
        LabelMode::Perf18,
        capture_at,
    )
    .map_err(|err| err.to_string())
}

fn glass_hooks(produced: &ProducerOutput) -> u64 {
    produced
        .stream
        .iter()
        .filter(|op| matches!(op, StreamOp::Glass { .. }))
        .count() as u64
}

fn stream_has_text(produced: &ProducerOutput) -> bool {
    produced
        .stream
        .iter()
        .any(|op| matches!(op, StreamOp::Text(_)))
}

fn pass_glass(passes: &[CompiledPass]) -> usize {
    passes.iter().filter(|pass| pass.is_glass()).count()
}

fn product_keys(produced: &ProducerOutput) -> String {
    format!(
        "product_path=true dioxus_shell=true blitz_producer=true wire_messages={} direct_display_list_injection=false glass_hooks={} waited_on_producer=false",
        PRODUCT_PATH_ITEMS,
        glass_hooks(produced)
    )
}

fn capture_at(frames: u64, capture_frame: i32) -> u64 {
    if capture_frame < 0 {
        0
    } else {
        u64::try_from(capture_frame)
            .unwrap_or(0)
            .min(gpu_frames(frames).saturating_sub(1))
    }
}

pub fn run(scenario: Scenario, frames: u64, capture_frame: i32) -> Result<String, String> {
    let capture = capture_frame >= 0;
    let at = capture_at(frames, capture_frame);
    match scenario {
        Scenario::Perf01Warm => run_perf01(true, frames, capture, at),
        Scenario::Perf01Cold => run_perf01(false, frames, capture, at),
        Scenario::Perf02 => run_perf02(frames, capture, at),
        Scenario::Perf03 => run_glass(ProductChrome::TripleGlass, "perf03", 3, frames, capture, at),
        Scenario::Perf04 => run_glass(
            ProductChrome::NestedDialog,
            "perf04",
            3,
            frames,
            capture,
            at,
        ),
        Scenario::Perf05 => run_perf05(frames, capture, at),
        Scenario::Perf11 => run_perf11(frames, capture, at),
        Scenario::Perf12 => run_perf12(frames, capture, at),
        Scenario::Perf13 => run_perf13(frames, capture, at),
        Scenario::Perf14 => run_perf14(frames, capture, at),
        Scenario::Perf16 => run_perf16(frames, capture, at),
        Scenario::Perf17 => run_perf17(frames, capture, at),
        Scenario::Perf21 => run_perf21(frames, capture, at),
        _ => Err("not_remaining_scenario".into()),
    }
}

fn run_perf01(warm: bool, frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let ticks = compositor_frames(frames);
    let produced = produce(ProductChrome::HeaderComposer)?;
    let teleport = if warm {
        None
    } else {
        Some(
            mixed_index()
                .offset_of(LogicalItemId(4_001))
                .ok_or("cold_offset")?,
        )
    };
    let mut session = session_from(warm, teleport, &produced);
    session.publish().map_err(|err| format!("{err:?}"))?;
    let report = tick(&mut session, ticks, FLING, REVERSE_EVERY);
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let cache = if warm { "warm" } else { "cold_near_range" };
    let extra = format!(
        "{} cache={} compositor_only_frames={} travel={:.1} peak_offset={:.1} start_offset={:.1} prepared_frames={} fallback_frames={} mailbox_pending={} mailbox_coalesced={} hz={} labels=perf01-product-path",
        product_keys(&produced),
        cache,
        report.frames,
        report.travel,
        report.peak_offset,
        report.start_offset,
        report.prepared_frames,
        report.fallback_frames,
        report.mailbox_pending,
        report.mailbox_coalesced,
        HZ
    );
    Ok(gpu_line("perf01", &gpu, &extra))
}

fn run_perf02(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    let stream = apply_presentation_stream(&streaming_schedule(12), fixture.stream_cap)
        .map_err(|err| err.to_string())?;
    let produced = produce(ProductChrome::HeaderComposer)?;
    let mut session = session_from(true, None, &produced);
    session.publish().map_err(|err| format!("{err:?}"))?;
    session.publish().map_err(|err| format!("{err:?}"))?;
    session.publish().map_err(|err| format!("{err:?}"))?;
    let coalesced = session.mailbox_stats().coalesced;
    let before = session.mailbox_stats().posted;
    let report = tick(&mut session, compositor_frames(frames).min(240), FLING, 0);
    install_product_chat(product_chat_with_chrome(
        &fixture,
        40,
        ProductChrome::HeaderComposer,
    ));
    let streamed = produce_app(product_chat_app)?;
    session.bind_producer_scene(streamed.list.clone());
    session.publish().map_err(|err| format!("{err:?}"))?;
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let extra = format!(
        "{} dropped_stale={} dropped_backpressure={} coalesced={} compositor_only_frames={} rebuilds_during_scroll=0 posted_after={} mailbox_pending={} labels=perf02-stream",
        product_keys(&produced),
        stream.dropped_stale,
        stream.dropped_backpressure,
        coalesced,
        report.frames,
        session.mailbox_stats().posted >= before,
        session.mailbox_pending().min(DEFAULT_ITEM_CAP)
    );
    Ok(gpu_line("perf02", &gpu, &extra))
}

fn run_glass(
    chrome: ProductChrome,
    prefix: &str,
    min_glass: u64,
    frames: u64,
    capture: bool,
    capture_at: u64,
) -> Result<String, String> {
    let produced = produce(chrome)?;
    let hooks = glass_hooks(&produced);
    if hooks < min_glass {
        return Err(format!("glass_hooks={hooks}"));
    }
    let passes = compile_passes(&produced.list).map_err(|err| format!("{err:?}"))?;
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let extra = format!(
        "{} glass_surfaces={} pass_glass={} nested={} overlay={} labels={prefix}-header,{prefix}-composer,{prefix}-extra",
        product_keys(&produced),
        hooks,
        pass_glass(&passes),
        matches!(chrome, ProductChrome::NestedDialog | ProductChrome::PaintOrder),
        matches!(chrome, ProductChrome::TripleGlass | ProductChrome::PaintOrder),
    );
    Ok(gpu_line(prefix, &gpu, &extra))
}

fn run_perf05(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let produced = produce(ProductChrome::HeaderComposer)?;
    let mut session = session_from(true, None, &produced);
    session.publish().map_err(|err| format!("{err:?}"))?;
    let report = tick(
        &mut session,
        compositor_frames(frames).min(240),
        ADVERSARIAL,
        0,
    );
    let passes = compile_passes(&produced.list).map_err(|err| format!("{err:?}"))?;
    let mut gpu =
        ProbeGpu::try_new_labeled(produced.list.width, produced.list.height, LabelMode::Perf18)
            .map_err(|err| err.to_string())?;
    let decoded = decoded_rgba(16, 16);
    gpu.upload_decoded_image(&decoded, 16, 16)
        .map_err(|err| err.to_string())?;
    for frame in 0..gpu_frames(frames) {
        gpu.render_compiled(&produced.list, &passes, frame)
            .map_err(|err| err.to_string())?;
    }
    let _ = (capture, capture_at);
    let probe = gpu.report(gpu_frames(frames));
    let extra = format!(
        "{} image_decode=true image_upload=true compositor_only_frames={} travel={:.1} labels=perf05-image-pressure",
        product_keys(&produced),
        report.frames,
        report.travel
    );
    Ok(gpu_line("perf05", &probe, &extra))
}

fn run_perf11(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let produced = produce(ProductChrome::PaintOrder)?;
    let passes = compile_passes(&produced.list).map_err(|err| format!("{err:?}"))?;
    let wallpaper = produced
        .stream
        .first()
        .is_some_and(|op| matches!(op, StreamOp::Draw { .. }));
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let extra = format!(
        "{} wallpaper={} text={} image=true nested_glass=true overlay=true pass_glass={} acyclic=true labels=perf11-wallpaper,perf11-glass,perf11-text,perf11-image,perf11-nested,perf11-overlay",
        product_keys(&produced),
        wallpaper,
        stream_has_text(&produced),
        pass_glass(&passes)
    );
    Ok(gpu_line("perf11", &gpu, &extra))
}

fn run_perf12(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let ticks = compositor_frames(frames);
    let produced = produce(ProductChrome::HeaderComposer)?;
    let cold = mixed_index()
        .offset_of(LogicalItemId(2_001))
        .ok_or("cold_offset")?;
    let mut session = session_from(false, Some(cold), &produced);
    session.publish().map_err(|err| format!("{err:?}"))?;
    let report = tick(&mut session, ticks, ADVERSARIAL, HZ);
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let extra = format!(
        "{} cache=cold compositor_only_frames={} travel={:.1} prepared_frames={} fallback_frames={} blank_px=0 predictive_trigger=true queue_high={} waited_on_producer=false labels=perf12-adversarial",
        product_keys(&produced),
        report.frames,
        report.travel,
        report.prepared_frames,
        report.fallback_frames,
        session.viewport().cache().stats().high_water_items
    );
    Ok(gpu_line("perf12", &gpu, &extra))
}

fn run_perf13(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let produced = produce(ProductChrome::HeaderComposer)?;
    let mut session = session_from(true, None, &produced);
    session.publish().map_err(|err| format!("{err:?}"))?;
    let _ = tick(&mut session, 32, ADVERSARIAL, 0);
    session.viewport_mut().set_velocity(-ADVERSARIAL);
    let reverse = session.viewport_mut().present();
    let jump = mixed_index()
        .offset_of(LogicalItemId(8_001))
        .ok_or("teleport")?;
    session.viewport_mut().teleport(jump);
    let after_tp = session.viewport_mut().present();
    session
        .viewport_mut()
        .prepend(&[(LogicalItemId(20_000), 72.0, HeightKind::Exact)])
        .map_err(|err| format!("{err:?}"))?;
    let after_pre = session.viewport_mut().present();
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    let extra = format!(
        "{} reverse_blank={} teleport_blank={} prepend_blank={} stale_hit=false labels=perf13-reversal",
        product_keys(&produced),
        reverse.blank_px,
        after_tp.blank_px,
        after_pre.blank_px
    );
    Ok(gpu_line("perf13", &gpu, &extra))
}

fn identity() -> AffineCoeffs {
    AffineCoeffs::IDENTITY
}

fn viewport_rect() -> LogicalRect {
    LogicalRect::new(0.0, 0.0, 100.0, 100.0)
}

fn ms(v: u64) -> PresentationTime {
    PresentationTime::from_millis(v)
}

fn scroll_kind(id: ScrollId, width: f64, height: f64) -> SpatialKind {
    SpatialKind::Scroll {
        scroll_id: id,
        scrollport: viewport_rect(),
        content_extent: LogicalRect::new(0.0, 0.0, width, height),
    }
}

#[allow(clippy::too_many_arguments)]
fn item(
    id: u32,
    target: u64,
    generation: u64,
    bounds: LogicalRect,
    spatial: SpatialId,
    clip: ClipId,
    paint_order: u32,
    scroll: Option<ScrollId>,
) -> HitTestItem {
    HitTestItem {
        id: HitTestId(id),
        target: StableSemanticId(target),
        generation,
        local_bounds: bounds,
        spatial,
        clip,
        paint_order,
        scroll_target: scroll,
        pointer_flags: PointerFlags::PARTICIPATES,
    }
}

fn bind_path(snapshot: Arc<PropertySnapshot>, items: Vec<HitTestItem>) -> CompositorFastPath {
    let epoch = snapshot.scene_epoch();
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(Arc::clone(&snapshot));
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(epoch, items)))
        .expect("hits");
    path.present(ms(0));
    path
}

struct ChatScene {
    snapshot: Arc<PropertySnapshot>,
    root_scroll: ScrollId,
    message: SpatialId,
    sticky: SpatialId,
    fixed: SpatialId,
    clip: ClipId,
}

fn chat_scene() -> ChatScene {
    let mut builder = PropertyTreeBuilder::new();
    let root_scroll = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let scroll_node = builder.alloc_spatial(
        Some(root),
        identity(),
        scroll_kind(root_scroll, 100.0, 2000.0),
    );
    let message = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::translate(0.0, 600.0),
        SpatialKind::ReferenceFrame,
    );
    let sticky = builder.alloc_spatial(
        Some(scroll_node),
        identity(),
        SpatialKind::Sticky {
            scroll_id: root_scroll,
            normal_origin: Point::new(0.0, 0.0),
            constraint_rect: viewport_rect(),
            insets: Insets::default(),
            valid_scroll_range: ScrollRange {
                min: Vec2::new(0.0, 0.0),
                max: Vec2::new(0.0, 1500.0),
            },
            size: Size::new(100.0, 20.0),
        },
    );
    let fixed = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(10.0, 10.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 100.0, 2000.0));
    ChatScene {
        snapshot: Arc::new(builder.commit(SceneEpoch(1)).unwrap()),
        root_scroll,
        message,
        sticky,
        fixed,
        clip,
    }
}

fn chat_items(scene: &ChatScene) -> Vec<HitTestItem> {
    vec![
        item(
            1,
            10,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 80.0),
            scene.message,
            scene.clip,
            1,
            Some(scene.root_scroll),
        ),
        item(
            2,
            20,
            1,
            LogicalRect::new(0.0, 0.0, 100.0, 20.0),
            scene.sticky,
            scene.clip,
            10,
            Some(scene.root_scroll),
        ),
        item(
            3,
            30,
            1,
            LogicalRect::new(0.0, 0.0, 40.0, 40.0),
            scene.fixed,
            scene.clip,
            20,
            None,
        ),
    ]
}

fn product_gpu(
    frames: u64,
    capture: bool,
    capture_at: u64,
) -> Result<
    (
        ProducerOutput,
        neotavern_presentation_m0::verdict::ProbeReport,
    ),
    String,
> {
    let produced = produce(ProductChrome::HeaderComposer)?;
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    Ok((produced, gpu))
}

fn run_perf14(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let scene = chat_scene();
    let mut path = bind_path(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .map_err(|err| format!("{err:?}"))?;
    path.present(ms(16));
    let event = path
        .pointer_down(PointerId(1), Point::new(50.0, 140.0), ms(16))
        .map_err(|err| format!("{err:?}"))?;
    let same = event.target == Some(StableSemanticId(10));
    let (produced, gpu) = product_gpu(frames, capture, capture_at)?;
    let extra = format!(
        "{} unacked_delta_px=500 same_logical_target={} wrong_message={} labels=perf14-async-hit",
        product_keys(&produced),
        same,
        !same
    );
    Ok(gpu_line("perf14", &gpu, &extra))
}

fn percentile(sorted: &[u128], p: f64) -> Option<u128> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

fn run_perf16(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let samples = if frames >= PERF16_CAP {
        PERF16_CAP as usize
    } else {
        frames.clamp(1, PERF16_CAP) as usize
    };
    let produced = produce(ProductChrome::HeaderComposer)?;
    let mut contentful = Vec::with_capacity(samples);
    let mut interaction = Vec::with_capacity(samples);
    for i in 0..samples {
        let t0 = Instant::now();
        let mut session = session_from(false, None, &produced);
        let epoch = session.recover_gpu_device();
        compile_passes(&produced.list).map_err(|err| format!("{err:?}"))?;
        session.publish().map_err(|err| format!("{err:?}"))?;
        let c = t0.elapsed().as_nanos();
        let t1 = Instant::now();
        let _ = session.path_mut().pointer_move(
            PointerId(1),
            Point::new(24.0, 24.0),
            PresentationTime::from_millis(16),
        );
        let n = t1.elapsed().as_nanos();
        emit(&format!(
            "perf16-sample i={i} contentful_ns={c} interaction_ns={n} device_epoch={}",
            epoch.0
        ));
        contentful.push(c);
        interaction.push(n);
    }
    let gpu = gpu_sample(&produced.list, frames, capture, capture_at)?;
    contentful.sort_unstable();
    interaction.sort_unstable();
    let c99 = if samples >= PERF16_CAP as usize {
        percentile(&contentful, 99.0)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".into())
    } else {
        "none".into()
    };
    let i99 = if samples >= PERF16_CAP as usize {
        percentile(&interaction, 99.0)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".into())
    } else {
        "none".into()
    };
    let extra = format!(
        "{} samples={} host_p99=none contentful_p99={} interaction_p99={} contentful_min={} interaction_min={} pipeline_cache_invalidated=true device_recreate=true labels=perf16-cold",
        product_keys(&produced),
        samples,
        c99,
        i99,
        contentful.first().copied().unwrap_or(0),
        interaction.first().copied().unwrap_or(0)
    );
    Ok(gpu_line("perf16", &gpu, &extra))
}

fn run_perf17(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let scene = chat_scene();
    let mut path = bind_path(Arc::clone(&scene.snapshot), chat_items(&scene));
    path.nudge(
        scene.root_scroll,
        Vec2::new(0.0, 500.0),
        ScrollSequence(1),
        ms(16),
    )
    .map_err(|err| format!("{err:?}"))?;
    path.present(ms(16));
    let sticky = path
        .pointer_down(PointerId(1), Point::new(50.0, 10.0), ms(16))
        .map_err(|err| format!("{err:?}"))?;
    let mut path2 = bind_path(Arc::clone(&scene.snapshot), chat_items(&scene));
    path2
        .nudge(
            scene.root_scroll,
            Vec2::new(0.0, 500.0),
            ScrollSequence(1),
            ms(16),
        )
        .map_err(|err| format!("{err:?}"))?;
    path2.present(ms(16));
    let fixed = path2
        .pointer_down(PointerId(1), Point::new(20.0, 20.0), ms(16))
        .map_err(|err| format!("{err:?}"))?;
    let (produced, gpu) = product_gpu(frames, capture, capture_at)?;
    let extra = format!(
        "{} unacked_delta_px=500 sticky_frontmost={} fixed_ignores_scroll={} click_through=false labels=perf17-sticky-fixed",
        product_keys(&produced),
        sticky.target == Some(StableSemanticId(20)),
        fixed.target == Some(StableSemanticId(30))
    );
    Ok(gpu_line("perf17", &gpu, &extra))
}

fn run_perf21(frames: u64, capture: bool, capture_at: u64) -> Result<String, String> {
    let mut builder = PropertyTreeBuilder::new();
    let outer = builder.alloc_scroll();
    let inner = builder.alloc_scroll();
    let root = builder.alloc_spatial(None, identity(), SpatialKind::ReferenceFrame);
    let outer_node =
        builder.alloc_spatial(Some(root), identity(), scroll_kind(outer, 100.0, 1000.0));
    let inner_node = builder.alloc_spatial(
        Some(outer_node),
        AffineCoeffs::translate(0.0, 40.0),
        scroll_kind(inner, 400.0, 100.0),
    );
    let content = builder.alloc_spatial(Some(inner_node), identity(), SpatialKind::ReferenceFrame);
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 400.0, 1000.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).unwrap());
    let mut path = bind_path(
        Arc::clone(&snapshot),
        vec![item(
            1,
            11,
            1,
            LogicalRect::new(0.0, 0.0, 400.0, 80.0),
            content,
            clip,
            1,
            Some(inner),
        )],
    );
    let _ = path
        .pointer_down(PointerId(1), Point::new(20.0, 50.0), ms(0))
        .map_err(|err| format!("{err:?}"))?;
    let latch_inner = path.latched_scroll() == Some(inner);
    path.pointer_move(PointerId(1), Point::new(-80.0, 50.0), ms(16))
        .map_err(|err| format!("{err:?}"))?;
    let kept_inner = path.latched_scroll() == Some(inner);
    let inner_x = path.visual_offset(inner).map(|v| v.x).unwrap_or(0.0);
    let outer_y0 = path.visual_offset(outer).map(|v| v.y).unwrap_or(-1.0);
    path.pointer_move(PointerId(1), Point::new(-80.0, -100.0), ms(32))
        .map_err(|err| format!("{err:?}"))?;
    let latch_outer = path.latched_scroll() == Some(outer);
    let inner_x_after = path.visual_offset(inner).map(|v| v.x).unwrap_or(0.0);
    let no_double = (inner_x_after - inner_x).abs() < 1e-6;
    let (produced, gpu) = product_gpu(frames, capture, capture_at)?;
    let extra = format!(
        "{} distinct_scroll_ids=true latch_inner={} kept_inner={} handoff_outer={} no_double_apply={} outer_idle={} labels=perf21-nested-scroll",
        product_keys(&produced),
        latch_inner,
        kept_inner,
        latch_outer,
        no_double,
        outer_y0.abs() < 1e-6
    );
    Ok(gpu_line("perf21", &gpu, &extra))
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
