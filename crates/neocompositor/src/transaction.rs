//! Frame transaction and damage (Milestone B transactional spine).
//!
//! A published transaction is immutable: later mailbox coalescing drops the
//! Arc, it never mutates an in-flight snapshot.

use std::sync::Arc;

use crate::display_list::Rect;
use crate::epoch::{DeviceEpoch, FrameId, SceneEpoch};
use crate::property_tree::PropertySnapshot;
use crate::scene::NeoScene;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamageRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl DamageRect {
    pub fn from_rect(rect: Rect) -> Self {
        Self {
            x: rect.x.floor() as i32,
            y: rect.y.floor() as i32,
            width: rect.width.ceil() as u32,
            height: rect.height.ceil() as u32,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct ResourceLeaseId(pub u64);

/// GPU/CPU resource held until the mailbox retires a dropped transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct ResourceLease {
    pub id: ResourceLeaseId,
    pub device_epoch: DeviceEpoch,
}

#[derive(Clone, Debug)]
pub struct FrameTransactionParts {
    pub frame_id: FrameId,
    pub scene_epoch: SceneEpoch,
    pub device_epoch: DeviceEpoch,
    pub scene: NeoScene,
    pub damage: Vec<DamageRect>,
    pub leases: Vec<ResourceLease>,
    pub properties: PropertySnapshot,
}

/// Immutable UI→render snapshot. Fields are not mutated after [`Self::publish`].
#[derive(Clone, Debug, PartialEq)]
pub struct FrameTransaction {
    frame_id: FrameId,
    scene_epoch: SceneEpoch,
    device_epoch: DeviceEpoch,
    generation: u64,
    scene: Arc<NeoScene>,
    damage: Arc<[DamageRect]>,
    leases: Arc<[ResourceLease]>,
    properties: Arc<PropertySnapshot>,
    byte_size: usize,
}

impl FrameTransaction {
    pub fn publish(parts: FrameTransactionParts) -> Self {
        let generation = parts.scene.display_list.generation;
        let scene = Arc::new(parts.scene);
        let damage: Arc<[DamageRect]> = parts.damage.into();
        let leases: Arc<[ResourceLease]> = parts.leases.into();
        let properties = Arc::new(parts.properties);
        let byte_size = estimate_bytes(&scene, &damage, &leases, &properties);
        Self {
            frame_id: parts.frame_id,
            scene_epoch: parts.scene_epoch,
            device_epoch: parts.device_epoch,
            generation,
            scene,
            damage,
            leases,
            properties,
            byte_size,
        }
    }

    pub fn publish_shared(
        frame_id: FrameId,
        scene_epoch: SceneEpoch,
        device_epoch: DeviceEpoch,
        scene: Arc<NeoScene>,
        damage: Vec<DamageRect>,
        leases: Vec<ResourceLease>,
    ) -> Self {
        let generation = scene.display_list.generation;
        let damage: Arc<[DamageRect]> = damage.into();
        let leases: Arc<[ResourceLease]> = leases.into();
        let properties = Arc::new(PropertySnapshot::empty());
        let byte_size = estimate_bytes(&scene, &damage, &leases, &properties);
        Self {
            frame_id,
            scene_epoch,
            device_epoch,
            generation,
            scene,
            damage,
            leases,
            properties,
            byte_size,
        }
    }

    pub fn full_frame(scene: NeoScene) -> Self {
        let generation = scene.display_list.generation;
        let damage = vec![DamageRect {
            x: 0,
            y: 0,
            width: scene.display_list.width,
            height: scene.display_list.height,
        }];
        Self::publish(FrameTransactionParts {
            frame_id: FrameId(generation),
            scene_epoch: SceneEpoch(generation),
            device_epoch: DeviceEpoch(0),
            scene,
            damage,
            leases: Vec::new(),
            properties: PropertySnapshot::empty(),
        })
    }

    pub fn frame_id(&self) -> FrameId {
        self.frame_id
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.device_epoch
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn scene(&self) -> &NeoScene {
        &self.scene
    }

    pub fn scene_arc(&self) -> Arc<NeoScene> {
        Arc::clone(&self.scene)
    }

    pub fn damage(&self) -> &[DamageRect] {
        &self.damage
    }

    pub fn leases(&self) -> &[ResourceLease] {
        &self.leases
    }

    pub fn properties(&self) -> &PropertySnapshot {
        &self.properties
    }

    pub fn properties_arc(&self) -> Arc<PropertySnapshot> {
        Arc::clone(&self.properties)
    }

    pub fn byte_size(&self) -> usize {
        self.byte_size
    }
}

fn estimate_bytes(
    scene: &NeoScene,
    damage: &[DamageRect],
    leases: &[ResourceLease],
    properties: &PropertySnapshot,
) -> usize {
    256 + scene.display_list.ops.len() * 96
        + scene.display_list.spatial.len() * 48
        + scene.glass.len() * 32
        + damage.len() * 16
        + leases.len() * 16
        + properties.spatial_slot_count() * 80
        + properties.clip_slot_count() * 48
        + properties.effect_slot_count() * 64
        + properties.scroll_slot_count() * 16
}
