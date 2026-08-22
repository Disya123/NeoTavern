//! Temporary bisect probe for the composer Send-button layout escape.
//! Reproduces the `composer-actions` row in isolation and prints the Taffy
//! rect of the right-hand button across style variants. DELETE after M0.

use dioxus_core_macro::rsx;
use neotavern_presentation_dioxus_shell::{install_product_chat, ProductChatView};
use neotavern_presentation_m0_d2::inspect_slot_skeleton;

fn dump(name: &str, app: fn() -> dioxus_core::Element) {
    install_product_chat(ProductChatView::default());
    let skel = inspect_slot_skeleton(app, 1100, 760, 1.0, Default::default()).expect("skeleton");
    let row = skel
        .nodes
        .iter()
        .find(|n| n.identity.contains("probe-row"))
        .expect("row");
    let btn = skel
        .nodes
        .iter()
        .find(|n| n.identity.contains("probe-btn"))
        .expect("btn");
    println!(
        "{name}: row(x={} w={}) btn(x={} y={} w={} h={})",
        row.css_x.round(),
        row.css_width.round(),
        btn.css_x.round(),
        btn.css_y.round(),
        btn.css_width.round(),
        btn.css_height.round(),
    );
}

const BTN_STYLE: &str = "display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:36px;padding:4px 16px;border:none;border-radius:10px;font-size:13px;font-weight:500;";
const UTILS_STYLE: &str = "display:flex;align-items:center;gap:4px;margin-right:auto;";

fn v0_full() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:8px;",
                div {
                    style: "{UTILS_STYLE}",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v1_no_margin_top() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;",
                div {
                    style: "{UTILS_STYLE}",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v2_div_btn() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:8px;",
                div {
                    style: "{UTILS_STYLE}",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                div {
                    "data-part": "probe-btn",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v3_no_auto_margin() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:8px;",
                div {
                    style: "display:flex;align-items:center;gap:4px;",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v4_single_child() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:8px;",
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v5_no_justify() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;gap:12px;margin-top:8px;",
                div {
                    style: "display:flex;align-items:center;gap:4px;margin-right:auto;",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v6_fixed_btn_width() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:8px;",
                div {
                    style: "display:flex;align-items:center;gap:4px;margin-right:auto;",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "width:61px;height:36px;border:none;",
                    "Send"
                }
            }
        }
    }
}

fn v7_justify_start() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:flex-start;gap:12px;margin-top:8px;",
                div {
                    style: "display:flex;align-items:center;gap:4px;margin-right:auto;",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn v8_justify_normal() -> dioxus_core::Element {
    rsx! {
        div {
            style: "display:flex;flex-direction:column;width:594px;height:130px;padding:12px 16px 8px;box-sizing:border-box;",
            div {
                "data-part": "probe-row",
                style: "display:flex;align-items:center;justify-content:normal;gap:12px;margin-top:8px;",
                div {
                    style: "display:flex;align-items:center;gap:4px;margin-right:auto;",
                    div { style: "width:32px;height:32px;", "1" }
                    div { style: "width:32px;height:32px;", "2" }
                    div { style: "width:32px;height:32px;", "3" }
                }
                button {
                    "data-part": "probe-btn",
                    r#type: "button",
                    style: "{BTN_STYLE}",
                    "Send"
                }
            }
        }
    }
}

fn main() {
    dump("v0-full", v0_full);
    dump("v1-no-margin-top", v1_no_margin_top);
    dump("v2-div-btn", v2_div_btn);
    dump("v3-no-auto-margin", v3_no_auto_margin);
    dump("v4-single-child", v4_single_child);
    dump("v5-no-justify", v5_no_justify);
    dump("v6-fixed-btn-width", v6_fixed_btn_width);
    dump("v7-justify-start", v7_justify_start);
    dump("v8-justify-normal", v8_justify_normal);
}
