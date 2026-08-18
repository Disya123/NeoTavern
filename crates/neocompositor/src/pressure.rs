//! PERF-15: unified memory-pressure and degraded admission policy.
//!
//! `Normal → Constrained → Critical → Degraded`. Eviction is deterministic.
//! Viewport tiles, the protected band, and last-known-good are never evicted.
//! Image uploads throttle under Constrained+. Allocation retries are bounded;
//! OOM does not start a recreate/alloc loop. Host corpus is **IMPLEMENTED**,
//! not Milestone B PASS, not production JNI.

use crate::epoch::SceneEpoch;

pub const DEFAULT_PRESSURE_CAP_BYTES: usize = 96 * 1024 * 1024;
pub const DEFAULT_ALLOC_RETRY_CAP: u32 = 3;
pub const CONSTRAINED_NUM: u32 = 70;
pub const CRITICAL_NUM: u32 = 85;
pub const DEGRADED_NUM: u32 = 95;
const DENOM: u32 = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord, Hash)]
pub enum PressureTier {
    Normal,
    Constrained,
    Critical,
    Degraded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord, Hash)]
pub enum EvictionClass {
    ScratchTarget = 0,
    PendingImageUpload = 1,
    CachedLayer = 2,
    OffViewportImage = 3,
    OffViewportTile = 4,
    VisualSurfaceOffViewport = 5,
    ViewportTile = 100,
    ProtectedBand = 101,
    LastKnownGood = 102,
}

impl EvictionClass {
    pub fn is_protected(self) -> bool {
        matches!(
            self,
            Self::ViewportTile | Self::ProtectedBand | Self::LastKnownGood
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct ResourceId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdmissionItem {
    pub id: ResourceId,
    pub class: EvictionClass,
    pub bytes: usize,
    pub scene_epoch: SceneEpoch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    Accepted { tier: PressureTier },
    Throttled { tier: PressureTier },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PressureReject {
    Degraded,
    WouldEvictProtected,
    RetryCap,
    OutOfMemory,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvictReport {
    pub evicted: Vec<ResourceId>,
    pub kept_protected: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PressureStats {
    pub used_bytes: usize,
    pub cap_bytes: usize,
    pub tier: PressureTier,
    pub evictions: u64,
    pub throttled_uploads: u64,
    pub alloc_retries: u32,
    pub oom_events: u64,
    pub oom_loops: u64,
}

pub struct PressureController {
    cap_bytes: usize,
    used_bytes: usize,
    tier: PressureTier,
    items: Vec<AdmissionItem>,
    alloc_retries: u32,
    alloc_retry_cap: u32,
    evictions: u64,
    throttled_uploads: u64,
    oom_events: u64,
    oom_loops: u64,
    lkg_epoch: Option<SceneEpoch>,
}

impl PressureController {
    pub fn new(cap_bytes: usize) -> Self {
        Self {
            cap_bytes: cap_bytes.max(1),
            used_bytes: 0,
            tier: PressureTier::Normal,
            items: Vec::new(),
            alloc_retries: 0,
            alloc_retry_cap: DEFAULT_ALLOC_RETRY_CAP,
            evictions: 0,
            throttled_uploads: 0,
            oom_events: 0,
            oom_loops: 0,
            lkg_epoch: None,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(DEFAULT_PRESSURE_CAP_BYTES)
    }

    pub fn tier(&self) -> PressureTier {
        self.tier
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn stats(&self) -> PressureStats {
        PressureStats {
            used_bytes: self.used_bytes,
            cap_bytes: self.cap_bytes,
            tier: self.tier,
            evictions: self.evictions,
            throttled_uploads: self.throttled_uploads,
            alloc_retries: self.alloc_retries,
            oom_events: self.oom_events,
            oom_loops: self.oom_loops,
        }
    }

    pub fn remember_lkg(&mut self, epoch: SceneEpoch) {
        self.lkg_epoch = Some(epoch);
    }

    pub fn contains(&self, id: ResourceId) -> bool {
        self.items.iter().any(|item| item.id == id)
    }

    pub fn items(&self) -> &[AdmissionItem] {
        &self.items
    }

    pub fn lkg_epoch(&self) -> Option<SceneEpoch> {
        self.lkg_epoch
    }

    pub fn admit(&mut self, item: AdmissionItem) -> Result<Admit, PressureReject> {
        self.refresh_tier();
        if item.class == EvictionClass::PendingImageUpload && self.tier >= PressureTier::Constrained
        {
            self.throttled_uploads = self.throttled_uploads.saturating_add(1);
            return Ok(Admit::Throttled { tier: self.tier });
        }
        if self.tier == PressureTier::Degraded && !item.class.is_protected() {
            return Err(PressureReject::Degraded);
        }
        if self.used_bytes.saturating_add(item.bytes) > self.cap_bytes {
            let report = self.evict_to_fit(item.bytes);
            if self.used_bytes.saturating_add(item.bytes) > self.cap_bytes {
                if item.class.is_protected() {
                    return Err(PressureReject::WouldEvictProtected);
                }
                return self.fail_alloc(report.evicted.is_empty());
            }
        }
        self.items.push(item);
        self.items.sort_by_key(|entry| (entry.class, entry.id));
        self.used_bytes = self.used_bytes.saturating_add(item.bytes);
        self.refresh_tier();
        Ok(Admit::Accepted { tier: self.tier })
    }

    pub fn evict_to_fit(&mut self, need: usize) -> EvictReport {
        let mut evicted = Vec::new();
        let protected = self
            .items
            .iter()
            .filter(|item| item.class.is_protected())
            .count();
        while self.used_bytes.saturating_add(need) > self.cap_bytes {
            let Some(index) = self.next_eviction_index() else {
                break;
            };
            let item = self.items.remove(index);
            self.used_bytes = self.used_bytes.saturating_sub(item.bytes);
            self.evictions = self.evictions.saturating_add(1);
            evicted.push(item.id);
        }
        self.refresh_tier();
        EvictReport {
            evicted,
            kept_protected: protected,
        }
    }

    pub fn on_oom(&mut self) -> PressureTier {
        self.tier = PressureTier::Degraded;
        self.oom_events = self.oom_events.saturating_add(1);
        self.alloc_retries = self.alloc_retry_cap;
        self.oom_loops = 0;
        PressureTier::Degraded
    }

    pub fn alloc_retry(&mut self) -> Result<PressureTier, PressureReject> {
        if self.oom_events > 0 {
            self.tier = PressureTier::Degraded;
            return Err(PressureReject::Degraded);
        }
        if self.alloc_retries >= self.alloc_retry_cap {
            self.tier = PressureTier::Degraded;
            return Err(PressureReject::RetryCap);
        }
        self.alloc_retries = self.alloc_retries.saturating_add(1);
        self.refresh_tier();
        Ok(self.tier)
    }

    fn fail_alloc(&mut self, nothing_evicted: bool) -> Result<Admit, PressureReject> {
        if nothing_evicted {
            self.tier = PressureTier::Degraded;
            return Err(PressureReject::WouldEvictProtected);
        }
        match self.alloc_retry() {
            Ok(_) => Err(PressureReject::OutOfMemory),
            Err(err) => Err(err),
        }
    }

    fn next_eviction_index(&self) -> Option<usize> {
        self.items
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.class.is_protected())
            .min_by_key(|(_, item)| (item.class, item.id))
            .map(|(index, _)| index)
    }

    fn refresh_tier(&mut self) {
        if self.oom_events > 0 || self.alloc_retries >= self.alloc_retry_cap {
            self.tier = PressureTier::Degraded;
            return;
        }
        let pct = if self.cap_bytes == 0 {
            DENOM
        } else {
            u32::try_from((self.used_bytes.saturating_mul(DENOM as usize)) / self.cap_bytes)
                .unwrap_or(DENOM)
        };
        self.tier = if pct >= DEGRADED_NUM {
            PressureTier::Degraded
        } else if pct >= CRITICAL_NUM {
            PressureTier::Critical
        } else if pct >= CONSTRAINED_NUM {
            PressureTier::Constrained
        } else {
            PressureTier::Normal
        };
    }
}
