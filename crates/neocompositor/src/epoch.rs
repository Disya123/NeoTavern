//! Monotonic compositor epochs (RFC §12).

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameId(pub u64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SceneEpoch(pub u64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceEpoch(pub u64);

/// Allocates strictly increasing frame/scene ids and a bumpable device epoch.
#[derive(Clone, Debug)]
pub struct EpochClock {
    next_frame: u64,
    next_scene: u64,
    device: u64,
}

impl Default for EpochClock {
    fn default() -> Self {
        Self::new()
    }
}

impl EpochClock {
    pub fn new() -> Self {
        Self {
            next_frame: 1,
            next_scene: 1,
            device: 0,
        }
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        DeviceEpoch(self.device)
    }

    pub fn next_frame(&mut self) -> FrameId {
        let id = FrameId(self.next_frame);
        self.next_frame = self.next_frame.checked_add(1).expect("FrameId overflow");
        id
    }

    pub fn next_scene(&mut self) -> SceneEpoch {
        let epoch = SceneEpoch(self.next_scene);
        self.next_scene = self.next_scene.checked_add(1).expect("SceneEpoch overflow");
        epoch
    }

    pub fn bump_device(&mut self) -> DeviceEpoch {
        self.device = self.device.checked_add(1).expect("DeviceEpoch overflow");
        DeviceEpoch(self.device)
    }
}
