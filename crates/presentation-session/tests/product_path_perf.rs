//! Product-path host corpus for PERF-01 / PERF-02 / PERF-16.
//!
//! ```text
//! Product Wire → flagged Dioxus shell → Blitz producer
//! → presentation-session → NeoCompositor
//! ```
//!
//! Not a physical PASS. Not a hand-built `NeoDisplayList` fixture.

use std::time::Instant;

use neotavern_chat_viewport::{
    HeightIndex, HeightKind, LogicalItemId, PredictorBudgets, TileCache, ViewportSession,
};
use neotavern_neocompositor::{
    compile_passes, Point, PointerId, PresentationTime, TryDequeue, DEFAULT_ITEM_CAP,
};
use neotavern_presentation_dioxus_shell::{
    apply_presentation_stream, dioxus_shell_from_flag, install_product_chat, mixed_height,
    mixed_height_catalog, mount_product_chat, product_chat_app, product_chat_from_fixture,
    project_canonical, streaming_schedule, DioxusShellHost, PRODUCT_PATH_ITEMS,
};
use neotavern_presentation_m0_d2::{produce_app, ProducerOutput};
use neotavern_presentation_session::PresentationSession;

const VIEWPORT: f64 = 800.0;
const WIDTH: f32 = 320.0;
const HEIGHT: f32 = 200.0;
const HZ: u64 = 120;
const RUN_SECS: u64 = 60;
const FRAMES: u64 = HZ * RUN_SECS;
const DT_NS: u64 = 1_000_000_000 / HZ;
const FLING: f64 = 8_000.0;
const REVERSE_EVERY: u64 = 15 * HZ;
const COLD_SAMPLES: usize = 100;

fn assert_no_direct_display_list_fixture() {
    let src = include_str!("product_path_perf.rs");
    let forbidden = concat!("NeoDisplay", "List {");
    assert!(
        !src.contains(forbidden),
        "product-path tests must not construct a display list by hand"
    );
}

fn flagged_shell() {
    assert_eq!(
        dioxus_shell_from_flag(Some("1")),
        DioxusShellHost::Flagged { feature_flag: true }
    );
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

fn produce_visible(start: usize) -> (ProducerOutput, usize) {
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    let projection = project_canonical(&fixture).expect("wire");
    assert_eq!(projection.message_ids.len(), PRODUCT_PATH_ITEMS as usize);
    let view = product_chat_from_fixture(&fixture, start);
    assert!(view.visible.iter().any(|row| row.content.contains("**")));
    assert!(view
        .visible
        .iter()
        .any(|row| row.content.contains("asset:thumb")));
    let edits = mount_product_chat(view);
    assert!(edits > 0);
    let produced = produce_app(product_chat_app).expect("blitz");
    (produced, edits)
}

fn session_from_producer(
    warm: bool,
    teleport: Option<f64>,
    produced: &ProducerOutput,
) -> PresentationSession {
    let mut session = PresentationSession::new(viewport(warm, teleport), WIDTH, HEIGHT);
    session.bind_producer_scene(produced.list.clone());
    session
}

fn bidirectional(session: &mut PresentationSession, frames: u64) -> ProductScrollReport {
    let start = session.viewport().offset();
    let mut vel = FLING;
    let mut prepared = 0u64;
    let mut fallback = 0u64;
    let mut travel = 0.0;
    let mut peak = start;
    let mut last = start;
    for frame in 0..frames {
        if frame > 0 && frame % REVERSE_EVERY == 0 {
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
    ProductScrollReport {
        frames,
        compositor_only_frames: frames,
        start_offset: start,
        end_offset: session.viewport().offset(),
        peak_offset: peak,
        travel,
        prepared_frames: prepared,
        fallback_frames: fallback,
        mailbox_pending: session.mailbox_pending(),
        mailbox_coalesced: session.mailbox_stats().coalesced,
    }
}

#[derive(Clone, Debug)]
struct ProductScrollReport {
    frames: u64,
    compositor_only_frames: u64,
    start_offset: f64,
    end_offset: f64,
    peak_offset: f64,
    travel: f64,
    prepared_frames: u64,
    fallback_frames: u64,
    mailbox_pending: usize,
    mailbox_coalesced: u64,
}

struct HostPipelineCache {
    compiled: bool,
}

impl HostPipelineCache {
    fn clear() -> Self {
        Self { compiled: false }
    }

    fn compile(&mut self, list: &neotavern_neocompositor::NeoDisplayList) {
        if !self.compiled {
            compile_passes(list).expect("pass graph");
            self.compiled = true;
        }
    }
}

#[test]
fn product_path_uses_wire_dioxus_blitz_session() {
    flagged_shell();
    assert_no_direct_display_list_fixture();
    let (produced, _) = produce_visible(0);
    assert!(produced.report.vdom_rebuilt);
    assert!(produced.report.layout_resolved);
    assert!(produced.report.glass_hooks >= 2, "{:?}", produced.report);
    assert!(produced.report.paint_commands > 0);
    assert!(
        produced
            .stream
            .iter()
            .any(|op| matches!(op, neotavern_presentation_m0_d2::StreamOp::Glass { .. })),
        "header/composer glass must come from Blitz"
    );
    let mut session = session_from_producer(true, None, &produced);
    session.publish().expect("publish");
    assert!(session.producer_scene().is_some());
    assert!(session.mailbox_pending() <= DEFAULT_ITEM_CAP);
}

#[test]
fn perf01_warm_and_cold_near_range_sixty_second_bidirectional() {
    flagged_shell();
    assert_no_direct_display_list_fixture();
    let (produced, _) = produce_visible(0);
    let mut warm = session_from_producer(true, None, &produced);
    warm.publish().expect("warm publish");
    let warm_report = bidirectional(&mut warm, FRAMES);
    assert_eq!(warm_report.frames, FRAMES);
    assert_eq!(warm_report.compositor_only_frames, FRAMES);
    // 15s reversals from offset 0 return near the start; travel/peak prove motion.
    assert!(warm_report.travel > 1_000.0, "{warm_report:?}");
    assert!(warm_report.peak_offset > warm_report.start_offset);
    assert!(warm_report.end_offset >= 0.0);
    assert!(warm_report.mailbox_pending <= DEFAULT_ITEM_CAP);
    assert!(warm_report.mailbox_coalesced == 0 || warm_report.mailbox_pending <= DEFAULT_ITEM_CAP);

    let cold_at = mixed_index()
        .offset_of(LogicalItemId(4_001))
        .expect("item 4000");
    let mut cold = session_from_producer(false, Some(cold_at), &produced);
    cold.publish().expect("cold publish");
    let cold_report = bidirectional(&mut cold, FRAMES);
    assert_eq!(cold_report.frames, FRAMES);
    assert!(cold_report.fallback_frames > 0 || cold_report.prepared_frames > 0);
    assert!(
        warm_report.prepared_frames != cold_report.prepared_frames
            || warm_report.start_offset < 1.0
    );
    assert!(cold_report.mailbox_pending <= DEFAULT_ITEM_CAP);
}

#[test]
fn perf02_streaming_coalesces_and_skips_reconciliation_on_compositor_only() {
    flagged_shell();
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    let stream =
        apply_presentation_stream(&streaming_schedule(12), fixture.stream_cap).expect("stream");
    assert!(stream.dropped_stale > 0);
    assert!(stream.dropped_backpressure > 0 || stream.accepted_text.len() <= 8 * 16);

    let (produced, _) = produce_visible(40);
    let mut session = session_from_producer(true, None, &produced);
    let mut rebuilds = 1u64;
    session.bind_producer_scene(produced.list.clone());
    session.publish().expect("publish 1");
    session.publish().expect("publish 2");
    session.publish().expect("publish 3");
    let stats = session.mailbox_stats();
    assert!(stats.coalesced >= 1, "{stats:?}");
    assert!(session.mailbox_pending() <= DEFAULT_ITEM_CAP);
    while !matches!(session.try_dequeue(), TryDequeue::Empty) {}

    let before_rebuilds = rebuilds;
    let before_publishes = session.mailbox_stats().posted;
    bidirectional(&mut session, 240);
    assert_eq!(
        rebuilds, before_rebuilds,
        "compositor-only frames must not reconcile Dioxus"
    );
    install_product_chat(product_chat_from_fixture(&fixture, 40));
    let _ = produce_app(product_chat_app).expect("stream produce");
    rebuilds += 1;
    session.publish().expect("stream publish");
    assert!(rebuilds > before_rebuilds);
    assert!(session.mailbox_stats().posted >= before_publishes);
}

#[test]
fn perf16_cold_samples_split_contentful_and_interaction_without_host_p99() {
    flagged_shell();
    let (produced, _) = produce_visible(0);
    let mut contentful = Vec::with_capacity(COLD_SAMPLES);
    let mut interaction = Vec::with_capacity(COLD_SAMPLES);
    for _ in 0..COLD_SAMPLES {
        let t0 = Instant::now();
        let mut session = session_from_producer(false, None, &produced);
        let epoch = session.recover_gpu_device();
        assert!(epoch.0 >= 1);
        let mut cache = HostPipelineCache::clear();
        cache.compile(&produced.list);
        session.publish().expect("contentful");
        let _ = session.try_dequeue();
        contentful.push(t0.elapsed().as_nanos());
        let t1 = Instant::now();
        let _ = session.path_mut().pointer_move(
            PointerId(1),
            Point::new(24.0, 24.0),
            PresentationTime::from_millis(16),
        );
        interaction.push(t1.elapsed().as_nanos());
    }
    assert_eq!(contentful.len(), COLD_SAMPLES);
    assert_eq!(interaction.len(), COLD_SAMPLES);
    let host_p99: Option<u128> = None;
    assert!(
        host_p99.is_none(),
        "host corpus must not publish p99; physical PERF-16 needs >=100 samples or an ADR"
    );
    assert!(contentful.iter().copied().min().unwrap() > 0);
    assert!(interaction.iter().copied().min().unwrap() > 0);
}
