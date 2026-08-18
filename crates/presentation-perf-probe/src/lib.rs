//! Debug-only PERF-18/19/20 Android probe plus B-exit fixtures.
//!
//! Not production JNI, not `MainActivity`, not Milestone B PASS. The probe
//! cannot stamp PERF PASS; only the host adjudicator does.

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
#[cfg(feature = "gpu")]
mod b_exit;
#[cfg(feature = "gpu")]
mod gpu_scenarios;
mod i2p;
mod perf20;

pub use i2p::{bind_scroll_scene, kind_from_i32, push_sample, I2pCpu, I2pFrame, I2pScene};
pub use perf20::{run_fling_trace, Perf20Summary};

pub const CAPTURE_DIR: &str = "/data/data/com.neotavern.mobile/files/perf-18-20";
pub const B_EXIT_CAPTURE_DIR: &str = "/data/data/com.neotavern.mobile/files/b-exit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    Perf18,
    Perf19,
    Perf20,
    Interop,
    Perf15,
    Perf22,
    Perf22Poster,
    Perf22Fullscreen,
    Perf22Error,
    Recovery,
    RecoveryFling,
    RecoverySelection,
    RecoverySurface,
    RecoveryBackground,
}

impl Scenario {
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "perf18" | "18" => Some(Self::Perf18),
            "perf19" | "19" => Some(Self::Perf19),
            "perf20" | "20" => Some(Self::Perf20),
            "interop" | "shared" | "t18" => Some(Self::Interop),
            "perf15" | "15" | "pressure" => Some(Self::Perf15),
            "perf22" | "22" | "surface" | "perf22-panel" | "panel" => Some(Self::Perf22),
            "perf22-poster" | "poster" => Some(Self::Perf22Poster),
            "perf22-fullscreen" | "fullscreen" => Some(Self::Perf22Fullscreen),
            "perf22-error" | "error" => Some(Self::Perf22Error),
            "recovery" | "device-loss" | "recovery-raster" | "raster_composite" => {
                Some(Self::Recovery)
            }
            "recovery-fling" | "fling" => Some(Self::RecoveryFling),
            "recovery-selection" | "selection" => Some(Self::RecoverySelection),
            "recovery-surface" | "surface-recreation" => Some(Self::RecoverySurface),
            "recovery-background" | "background" => Some(Self::RecoveryBackground),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Perf18 => "perf18",
            Self::Perf19 => "perf19",
            Self::Perf20 => "perf20",
            Self::Interop => "interop",
            Self::Perf15 => "perf15",
            Self::Perf22 => "perf22",
            Self::Perf22Poster => "perf22-poster",
            Self::Perf22Fullscreen => "perf22-fullscreen",
            Self::Perf22Error => "perf22-error",
            Self::Recovery => "recovery",
            Self::RecoveryFling => "recovery-fling",
            Self::RecoverySelection => "recovery-selection",
            Self::RecoverySurface => "recovery-surface",
            Self::RecoveryBackground => "recovery-background",
        }
    }
}

#[cfg(feature = "gpu")]
pub use gpu_scenarios::run_scenario;
