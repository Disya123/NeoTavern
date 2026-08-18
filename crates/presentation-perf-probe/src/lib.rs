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
#[cfg(feature = "gpu")]
mod remaining;

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
    Perf01Warm,
    Perf01Cold,
    Perf02,
    Perf03,
    Perf04,
    Perf05,
    Perf11,
    Perf12,
    Perf13,
    Perf14,
    Perf16,
    Perf17,
    Perf21,
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
            "perf01" | "perf01-warm" | "01" | "01-warm" => Some(Self::Perf01Warm),
            "perf01-cold" | "01-cold" => Some(Self::Perf01Cold),
            "perf02" | "02" | "streaming" => Some(Self::Perf02),
            "perf03" | "03" | "triple-glass" => Some(Self::Perf03),
            "perf04" | "04" | "nested-glass" => Some(Self::Perf04),
            "perf05" | "05" | "image-pressure" => Some(Self::Perf05),
            "perf11" | "11" | "paint-order" => Some(Self::Perf11),
            "perf12" | "12" | "adversarial" => Some(Self::Perf12),
            "perf13" | "13" | "reversal" | "teleport" => Some(Self::Perf13),
            "perf14" | "14" | "async-hit" => Some(Self::Perf14),
            "perf16" | "16" | "cold-start" => Some(Self::Perf16),
            "perf17" | "17" | "sticky" => Some(Self::Perf17),
            "perf21" | "21" | "nested-scroll" => Some(Self::Perf21),
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
            Self::Perf01Warm => "perf01-warm",
            Self::Perf01Cold => "perf01-cold",
            Self::Perf02 => "perf02",
            Self::Perf03 => "perf03",
            Self::Perf04 => "perf04",
            Self::Perf05 => "perf05",
            Self::Perf11 => "perf11",
            Self::Perf12 => "perf12",
            Self::Perf13 => "perf13",
            Self::Perf14 => "perf14",
            Self::Perf16 => "perf16",
            Self::Perf17 => "perf17",
            Self::Perf21 => "perf21",
        }
    }

    pub fn is_remaining_b(self) -> bool {
        matches!(
            self,
            Self::Perf01Warm
                | Self::Perf01Cold
                | Self::Perf02
                | Self::Perf03
                | Self::Perf04
                | Self::Perf05
                | Self::Perf11
                | Self::Perf12
                | Self::Perf13
                | Self::Perf14
                | Self::Perf16
                | Self::Perf17
                | Self::Perf21
        )
    }
}

#[cfg(feature = "gpu")]
pub use gpu_scenarios::run_scenario;
