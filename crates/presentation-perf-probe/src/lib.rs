//! Debug-only PERF-18/19/20 Android probe.
//!
//! Not production JNI, not `MainActivity`, not Milestone B PASS. The probe
//! cannot stamp PERF PASS; only the host adjudicator does.

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
#[cfg(feature = "gpu")]
mod gpu_scenarios;
mod i2p;
mod perf20;

pub use i2p::{bind_scroll_scene, kind_from_i32, push_sample, I2pCpu, I2pFrame, I2pScene};
pub use perf20::{run_fling_trace, Perf20Summary};

pub const CAPTURE_DIR: &str = "/data/data/com.neotavern.mobile/files/perf-18-20";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    Perf18,
    Perf19,
    Perf20,
    Interop,
}

impl Scenario {
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "perf18" | "18" => Some(Self::Perf18),
            "perf19" | "19" => Some(Self::Perf19),
            "perf20" | "20" => Some(Self::Perf20),
            "interop" | "shared" | "t18" => Some(Self::Interop),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Perf18 => "perf18",
            Self::Perf19 => "perf19",
            Self::Perf20 => "perf20",
            Self::Interop => "interop",
        }
    }
}

#[cfg(feature = "gpu")]
pub use gpu_scenarios::run_scenario;
