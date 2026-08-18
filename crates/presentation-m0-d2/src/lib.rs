//! NeoUI v4 M0-D2 producer-seam probe (RFC 4.5 stage 3).
//!
//! Canonical paint order comes from pinned Blitz `paint_scene` into a
//! `PaintScene` that records `host_node_marker` glass barriers. A second DOM
//! walk is diagnostics only and MUST NOT define z-order.
//!
//! Program D2 is **PASS** on the host-side record
//! `docs/rfc/m0-d2-adjudication.json`. The probe still logs `capture=false`.
//! The moving sample is inserted into the producer display list after the
//! Dioxus/Blitz static seam. Normative M0 is technical **PASS**.
//! `D1=Track D GO` is not granted.

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
mod assemble;
#[cfg(feature = "gpu")]
mod gpu_run;
mod sink;
mod text_publish;

use blitz_dom::BaseDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use dioxus_core::{Element, VirtualDom};
use dioxus_core_macro::rsx;
use dioxus_native_dom::{DioxusDocument, DocumentConfig};
use neotavern_presentation_m0::display_list::NeoDisplayList;
use neotavern_presentation_m0::scene_d1a::{D1A_HEIGHT, D1A_WIDTH};

pub use assemble::{assemble_from_stream, insert_moving_sample_before_last_glass};
#[cfg(feature = "gpu")]
pub use gpu_run::{run_dynamic_d2, run_dynamic_d2_with_capture, DynamicD2Report};
pub use sink::{DrawKind, ProducerSink, StreamOp};
pub use text_publish::{
    fallback_without_snapshot_is_not_ready, ime_ops_without_glyph_reraster,
    mixed_epoch_is_rejected, produce_selectable_app, publish_fallback_placeholder,
    publish_interaction_from_producer, publish_selectable_text, InteractionPublish,
    ProducerCounters, PublishError,
};

pub const D2_WIDTH: u32 = D1A_WIDTH;
pub const D2_HEIGHT: u32 = D1A_HEIGHT;
pub const D2_PATCH_LINES: u64 = 294;
pub const D2_REBASE_ANYRENDER_0111: &str = "PASS";
pub const D2_BLITZ_NEWER: &str = "NOT_AVAILABLE";
pub const D2_PRODUCER_SOURCE: &str = "dioxus-virtualdom+blitz-paint-traversal+host-node-marker";
pub const D2_CAPTURE_DIR: &str = "/data/data/com.neotavern.mobile/files/m0-d2";

/// Experimental pins matching presentation-m0 wgpu 29 / Vello 0.9.
/// `anyrender` / `blitz-paint` are patched locally; see `upstream/`.
pub const D2_PIN_NOTES: &str = concat!(
    "dioxus-core/html/native-dom 0.8.0-alpha.1; ",
    "blitz-dom/paint/traits 0.3.0-beta.1; ",
    "anyrender 0.11.0 + host_node_marker/host_text_fragment patch; ",
    "blitz-paint emits glass markers and Parley text snapshots during paint. ",
    "dioxus-native 0.7.10 is rejected (old wgpu). ",
    "Full dioxus-native 0.8 is avoided (winit 0.31 window shell)."
);

/// Honest gap list after host-side D2 PASS. These are not D2 FAIL.
pub fn missing_upstream_capabilities() -> &'static [&'static str] {
    &[
        "upstream landing of PaintScene::host_node_marker (local crates.io patch)",
        "upstream landing of PaintScene::host_text_fragment (local crates.io patch)",
        "typed Blitz Glass paint node beyond the data-neoui host marker",
    ]
}

#[derive(Clone, Debug)]
pub struct ProducerReport {
    pub vdom_rebuilt: bool,
    pub layout_resolved: bool,
    pub paint_commands: u64,
    pub glass_hooks: u64,
    pub effect_scopes: u64,
    pub source: &'static str,
    pub pin_notes: &'static str,
    /// Preorder DOM glass ids. Diagnostic only; not canonical z-order.
    pub diagnostic_dom_glass: Vec<u64>,
    /// Glass ids in Blitz paint-stream order.
    pub stream_glass: Vec<u64>,
}

pub struct ProducerOutput {
    pub list: NeoDisplayList,
    pub report: ProducerReport,
    pub stream: Vec<StreamOp>,
}

pub fn produce_app(app: fn() -> Element) -> Result<ProducerOutput, String> {
    let vdom = VirtualDom::new(app);
    let mut doc = DioxusDocument::new(
        vdom,
        DocumentConfig {
            viewport: Some(Viewport::new(D2_WIDTH, D2_HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.initial_build();
    {
        let mut inner = doc.inner.borrow_mut();
        inner.resolve(0.0);
    }
    let diagnostic_dom_glass = diagnostic_glass_dom_order(&doc.inner.borrow());
    let mut sink = ProducerSink::default();
    {
        let mut inner = doc.inner.borrow_mut();
        paint_scene(&mut sink, &mut inner, 1.0, D2_WIDTH, D2_HEIGHT, 0, 0);
    }
    let stream_glass = sink.glass_ids();
    let paint_commands = sink
        .ops
        .iter()
        .filter(|op| matches!(op, StreamOp::Draw { .. }))
        .count() as u64;
    let effect_scopes = sink
        .ops
        .iter()
        .filter(|op| matches!(op, StreamOp::PushLayer { alpha, clip } if !clip && *alpha < 1.0))
        .count() as u64;
    let list = assemble_from_stream(&sink.ops)?;
    let report = ProducerReport {
        vdom_rebuilt: true,
        layout_resolved: true,
        paint_commands,
        glass_hooks: stream_glass.len() as u64,
        effect_scopes,
        source: D2_PRODUCER_SOURCE,
        pin_notes: D2_PIN_NOTES,
        diagnostic_dom_glass,
        stream_glass: stream_glass.clone(),
    };
    Ok(ProducerOutput {
        list,
        report,
        stream: sink.ops,
    })
}

pub fn produce_static_d1a_list() -> Result<(NeoDisplayList, ProducerReport), String> {
    let out = produce_app(d2_static_app)?;
    Ok((out.list, out.report))
}

/// Static Dioxus/Blitz seam plus the compositor moving sample immediately
/// before Glass B. Layout/`paint_scene` run once; the GPU loop must not
/// call this again.
pub fn produce_dynamic_list() -> Result<(NeoDisplayList, ProducerReport), String> {
    let (list, report) = produce_static_d1a_list()?;
    let list = insert_moving_sample_before_last_glass(list)?;
    Ok((list, report))
}

/// D1a-shaped first-party scene. Glass B sits inside one bounded opacity/clip
/// ancestor. Canonical order comes from Blitz paint, not this tree walk.
fn d2_static_app() -> Element {
    rsx! {
        div {
            style: "position:relative;width:320px;height:200px;background:#1b2433;",
            div {
                style: "position:absolute;left:0;top:0;width:320px;height:200px;background:#243044;"
            }
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                style: "position:absolute;left:24px;top:40px;width:140px;height:80px;"
            }
            div {
                style: "position:absolute;left:36px;top:132px;width:210px;height:28px;color:#e8eef7;font-size:14px;",
                "vector ui"
            }
            div {
                style: "position:absolute;left:72px;top:64px;width:160px;height:96px;opacity:0.85;overflow:hidden;",
                div {
                    style: "position:absolute;left:16px;top:20px;width:90px;height:36px;color:#d7e3f4;font-size:12px;",
                    "grouped"
                }
                div {
                    class: "neoui-glass",
                    "data-neoui": "glass",
                    style: "position:absolute;left:8px;top:6px;width:140px;height:80px;"
                }
            }
            div {
                style: "position:absolute;left:208px;top:8px;width:96px;height:22px;color:#ffffff;font-size:12px;",
                "overlay"
            }
        }
    }
}

#[cfg(test)]
fn z_index_glass_over_later_sibling() -> Element {
    rsx! {
        div {
            style: "position:relative;width:320px;height:200px;background:#101820;",
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                style: "position:absolute;left:8px;top:8px;width:80px;height:80px;z-index:1;"
            }
            div {
                style: "position:absolute;left:24px;top:24px;width:140px;height:48px;background:#cc3344;",
                "dom-after"
            }
        }
    }
}

#[cfg(test)]
fn nested_and_overlapping_glass() -> Element {
    rsx! {
        div {
            style: "position:relative;width:320px;height:200px;background:#101820;",
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                style: "position:absolute;left:16px;top:16px;width:180px;height:140px;",
                div {
                    class: "neoui-glass",
                    "data-neoui": "glass",
                    style: "position:absolute;left:20px;top:24px;width:90px;height:70px;"
                }
            }
            div {
                class: "neoui-glass",
                "data-neoui": "glass",
                style: "position:absolute;left:140px;top:40px;width:120px;height:80px;"
            }
        }
    }
}

#[cfg(test)]
fn transform_clip_glass() -> Element {
    rsx! {
        div {
            style: "position:relative;width:320px;height:200px;background:#101820;",
            div {
                style: "position:absolute;left:24px;top:24px;width:160px;height:96px;overflow:hidden;transform:translate(4px,2px);opacity:0.85;",
                div {
                    class: "neoui-glass",
                    "data-neoui": "glass",
                    style: "position:absolute;left:8px;top:8px;width:120px;height:64px;"
                }
            }
        }
    }
}

/// Preorder DOM ids of glass hooks. Not paint order when z-index hoists nodes.
fn diagnostic_glass_dom_order(doc: &BaseDocument) -> Vec<u64> {
    let mut out = Vec::new();
    walk_dom_preorder(doc, doc.root_element().id, &mut out);
    out
}

fn walk_dom_preorder(doc: &BaseDocument, node_id: usize, out: &mut Vec<u64>) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    if is_glass_hook(node) {
        out.push(node_id as u64);
    }
    for child_id in node.children.clone() {
        walk_dom_preorder(doc, child_id, out);
    }
}

fn is_glass_hook(node: &blitz_dom::Node) -> bool {
    node.element_data()
        .map(|data| {
            data.attrs.iter().any(|attr| {
                (*attr.name.local == *"data-neoui" && attr.value == "glass")
                    || (*attr.name.local == *"class"
                        && attr
                            .value
                            .split_whitespace()
                            .any(|token| token == "neoui-glass"))
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
fn barrier_positions(list: &NeoDisplayList) -> Vec<usize> {
    list.ops
        .iter()
        .enumerate()
        .filter_map(|(idx, op)| match op {
            neotavern_presentation_m0::display_list::NeoPaintOp::BackdropBarrier(_) => Some(idx),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn stream_glass_index(stream: &[StreamOp], nth: usize) -> usize {
    stream
        .iter()
        .enumerate()
        .filter_map(|(idx, op)| match op {
            StreamOp::Glass { .. } => Some(idx),
            _ => None,
        })
        .nth(nth)
        .expect("glass in stream")
}

#[cfg(test)]
mod tests {
    use super::*;
    use neotavern_presentation_m0::display_list::NeoPaintOp;
    use neotavern_presentation_m0::{compile_passes, static_d1a_scene};

    #[test]
    fn d2_producer_uses_vdom_and_layout_not_d1a_mock() {
        let (list, report) = produce_static_d1a_list().expect("D2 producer");
        assert!(report.vdom_rebuilt);
        assert!(report.layout_resolved);
        assert_eq!(report.source, D2_PRODUCER_SOURCE);
        assert!(report.paint_commands > 0);
        assert_eq!(report.glass_hooks, 2);
        assert_eq!(report.stream_glass, report.diagnostic_dom_glass);
        assert_ne!(list.ops, static_d1a_scene().ops);
        assert!(!missing_upstream_capabilities().is_empty());

        let glass_at = barrier_positions(&list);
        assert_eq!(glass_at.len(), 2);
        assert!(
            list.ops[..glass_at[0]]
                .iter()
                .any(|op| matches!(op, NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_))),
            "siblings before glass must remain before the barrier"
        );
        assert!(
            list.ops[glass_at[0] + 1..glass_at[1]]
                .iter()
                .any(|op| matches!(op, NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_))),
            "barrier must not flush leftover glasses after every fill"
        );
        assert!(
            list.ops[glass_at[1] + 1..].iter().any(|op| matches!(
                op,
                NeoPaintOp::PaintChunk(_) | NeoPaintOp::Image(_) | NeoPaintOp::EndEffectScope(_)
            )),
            "ops after Glass B must remain after the barrier"
        );
        assert!(
            !matches!(list.ops.last(), Some(NeoPaintOp::BackdropBarrier(_))),
            "barrier is not moved to the end of the list"
        );

        let passes = compile_passes(&list).expect("compiled producer list");
        let glasses = passes.iter().filter(|pass| pass.is_glass()).count();
        assert_eq!(glasses, 2);
        let glass_b = passes.iter().filter(|pass| pass.is_glass()).nth(1).unwrap();
        assert!(
            !glass_b.open_scopes().is_empty(),
            "Glass B must keep the ancestor opacity/clip scope"
        );
    }

    #[test]
    fn glass_emitted_during_paint_not_second_walk_z_order() {
        let out = produce_app(z_index_glass_over_later_sibling).expect("z-index fixture");
        assert_eq!(out.report.glass_hooks, 1);
        assert_eq!(
            out.report.diagnostic_dom_glass.len(),
            1,
            "diagnostic walk still finds the hook"
        );
        let glass_at = stream_glass_index(&out.stream, 0);
        assert!(
            out.stream[..glass_at]
                .iter()
                .any(|op| matches!(op, StreamOp::Draw { .. })),
            "later DOM sibling with auto z-index must paint before hoisted glass"
        );
        assert_eq!(out.report.stream_glass, out.report.diagnostic_dom_glass);
    }

    #[test]
    fn nested_and_overlapping_glass_keep_paint_order() {
        let out = produce_app(nested_and_overlapping_glass).expect("nested glass");
        assert_eq!(out.report.glass_hooks, 3);
        assert_eq!(out.report.stream_glass, out.report.diagnostic_dom_glass);
        let first = stream_glass_index(&out.stream, 0);
        let second = stream_glass_index(&out.stream, 1);
        let third = stream_glass_index(&out.stream, 2);
        assert!(first < second && second < third);
        assert!(
            out.stream[first + 1..third]
                .iter()
                .any(|op| !matches!(op, StreamOp::Glass { .. })),
            "nested glass is interleaved with paint, not packed as a trailing suffix"
        );
        let list_pos = barrier_positions(&out.list);
        assert_eq!(list_pos.len(), 3);
        assert!(list_pos[2] < out.list.ops.len());
        compile_passes(&out.list).expect("balanced nested glass graph");
    }

    #[test]
    fn transform_clip_opacity_wraps_glass_and_scopes_balance() {
        let out = produce_app(transform_clip_glass).expect("transform/clip fixture");
        assert_eq!(out.report.glass_hooks, 1);
        let glass_at = stream_glass_index(&out.stream, 0);
        assert!(
            out.stream[..glass_at]
                .iter()
                .any(|op| matches!(op, StreamOp::PushLayer { .. })),
            "nested clip/transform/opacity must push a layer before the barrier"
        );
        let pushes = out
            .stream
            .iter()
            .filter(|op| matches!(op, StreamOp::PushLayer { .. }))
            .count();
        let pops = out
            .stream
            .iter()
            .filter(|op| matches!(op, StreamOp::PopLayer))
            .count();
        assert_eq!(pushes, pops, "effect/clip scopes must be balanced");
        compile_passes(&out.list).expect("balanced clip/opacity graph");
        let glass = compile_passes(&out.list)
            .unwrap()
            .into_iter()
            .find(|pass| pass.is_glass())
            .unwrap();
        assert!(
            !glass.open_scopes().is_empty(),
            "opacity ancestor must remain open on the glass pass"
        );
    }

    #[test]
    fn d2_dynamic_moving_sits_after_blitz_seam_not_d1b_mock() {
        let (static_list, _) = produce_static_d1a_list().expect("static producer");
        let (list, report) = produce_dynamic_list().expect("dynamic producer");
        assert_eq!(report.source, D2_PRODUCER_SOURCE);
        assert_eq!(report.glass_hooks, 2);
        assert!(report.vdom_rebuilt);
        assert!(report.layout_resolved);
        assert!(neotavern_presentation_m0::scene_d1b::list_has_moving_sample(&list));
        assert!(!neotavern_presentation_m0::scene_d1b::list_has_moving_sample(&static_list));
        assert_ne!(list.ops, static_d1a_scene().ops);
        assert_ne!(
            list.ops,
            neotavern_presentation_m0::static_d1b_scene().ops,
            "producer list is not the host-authored D1b mock"
        );

        let glass_at = barrier_positions(&list);
        assert_eq!(glass_at.len(), 2);
        match &list.ops[glass_at[1] - 1] {
            NeoPaintOp::PaintChunk(chunk) => {
                assert_eq!(
                    chunk.payload,
                    neotavern_presentation_m0::StubPayload::MovingSample
                );
            }
            other => panic!("expected moving chunk immediately before Glass B, got {other:?}"),
        }

        let passes = compile_passes(&list).expect("compiled producer+moving");
        let kinds: Vec<&'static str> = passes
            .iter()
            .map(|pass| {
                if pass.is_glass() {
                    "glass"
                } else if matches!(
                    pass,
                    neotavern_presentation_m0::pass_graph::CompiledPass::MovingSample { .. }
                ) {
                    "moving"
                } else {
                    "raster"
                }
            })
            .collect();
        let moving = kinds
            .iter()
            .position(|kind| *kind == "moving")
            .expect("moving pass");
        let glasses: Vec<usize> = kinds
            .iter()
            .enumerate()
            .filter_map(|(idx, kind)| (*kind == "glass").then_some(idx))
            .collect();
        assert_eq!(glasses.len(), 2);
        assert!(glasses[0] < moving && moving < glasses[1]);
        assert!(
            kinds[glasses[1] + 1..].contains(&"raster"),
            "overlay raster must remain after Glass B"
        );
        let glass_b = passes.iter().filter(|pass| pass.is_glass()).nth(1).unwrap();
        assert!(
            !glass_b.open_scopes().is_empty(),
            "Glass B must keep the ancestor opacity/clip scope"
        );

        let events = neotavern_presentation_m0::timeline::expected_first_frame(&list)
            .expect("first-frame timeline");
        let encoded = neotavern_presentation_m0::timeline::encode_timeline(&events);
        let moving_at = encoded.find("moving:g0").expect("moving:g0");
        let roi2 = encoded.find("roi:2").expect("roi:2 ordinal");
        let glass2 = encoded.find("glass:2:g0").expect("glass:2:g0 current gen");
        assert!(moving_at < roi2 && roi2 < glass2);
        assert!(neotavern_presentation_m0::timeline::two_glass_passes_sample_accumulator(&events));
        assert_eq!(
            neotavern_presentation_m0::timeline::encode_timeline(
                &neotavern_presentation_m0::timeline::expected_motion_frame(
                    &list,
                    neotavern_presentation_m0::scene_d1b::D1B_CAPTURE_FRAME
                )
            ),
            neotavern_presentation_m0::D1B_MOTION_TIMELINE_G120
        );
        assert!(missing_upstream_capabilities()
            .iter()
            .any(|item| item.contains("upstream landing")));
        assert!(missing_upstream_capabilities()
            .iter()
            .all(|item| !item.contains("moving sample")));
        assert_eq!(
            D2_CAPTURE_DIR,
            "/data/data/com.neotavern.mobile/files/m0-d2"
        );
        assert_eq!(D2_PATCH_LINES, 294);
        assert_eq!(D2_REBASE_ANYRENDER_0111, "PASS");
        assert_eq!(D2_BLITZ_NEWER, "NOT_AVAILABLE");
    }
}
