//! Host selection. Production Android stays on WebView until Milestone B/C DoD.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PresentationHost {
    WebViewRollback,
    NeoCompositor { feature_flag: bool },
}

pub const NEOCOMPOSITOR_FLAG: &str = "NEOTA_NEOCOMPOSITOR";

pub fn production_host_from_flag(value: Option<&str>) -> PresentationHost {
    match value {
        Some("1") => PresentationHost::NeoCompositor { feature_flag: true },
        _ => PresentationHost::WebViewRollback,
    }
}

pub fn production_host_from_env() -> PresentationHost {
    production_host_from_flag(std::env::var(NEOCOMPOSITOR_FLAG).ok().as_deref())
}
