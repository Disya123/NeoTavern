//! Frame transaction and damage (Milestone B transactional spine).
//!
//! A published transaction is immutable: later mailbox coalescing drops the
//! Arc, it never mutates an in-flight snapshot.

use std::sync::Arc;

use crate::display_list::Rect;
use crate::epoch::{DeviceEpoch, FrameId, SceneEpoch};
use crate::geometry_tiles::GeometryTileSnapshot;
use crate::property_tree::PropertySnapshot;
use crate::scene::NeoScene;
use crate::text::TextSnapshotSet;

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

    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    pub fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let x1 = i64::from(self.x) + i64::from(self.width);
        let y1 = i64::from(self.y) + i64::from(self.height);
        let ox1 = i64::from(other.x) + i64::from(other.width);
        let oy1 = i64::from(other.y) + i64::from(other.height);
        let nx1 = x1.max(ox1);
        let ny1 = y1.max(oy1);
        Self {
            x,
            y,
            width: u32::try_from((nx1 - i64::from(x)).max(0)).unwrap_or(0),
            height: u32::try_from((ny1 - i64::from(y)).max(0)).unwrap_or(0),
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
    pub geometry: GeometryTileSnapshot,
    pub text: TextSnapshotSet,
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
    geometry: Arc<GeometryTileSnapshot>,
    text: Arc<TextSnapshotSet>,
    byte_size: usize,
}

impl FrameTransaction {
    pub fn publish(parts: FrameTransactionParts) -> Self {
        let generation = parts.scene.display_list.generation;
        let scene = Arc::new(parts.scene);
        let damage: Arc<[DamageRect]> = parts.damage.into();
        let leases: Arc<[ResourceLease]> = parts.leases.into();
        let properties = Arc::new(parts.properties);
        let geometry = Arc::new(align_geometry(parts.geometry, parts.scene_epoch));
        let text = Arc::new(align_text(parts.text, parts.scene_epoch));
        let byte_size = estimate_bytes(&scene, &damage, &leases, &properties, &geometry, &text);
        Self {
            frame_id: parts.frame_id,
            scene_epoch: parts.scene_epoch,
            device_epoch: parts.device_epoch,
            generation,
            scene,
            damage,
            leases,
            properties,
            geometry,
            text,
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
        let geometry = Arc::new(GeometryTileSnapshot::empty(scene_epoch));
        let text = Arc::new(TextSnapshotSet::empty(scene_epoch));
        let byte_size = estimate_bytes(&scene, &damage, &leases, &properties, &geometry, &text);
        Self {
            frame_id,
            scene_epoch,
            device_epoch,
            generation,
            scene,
            damage,
            leases,
            properties,
            geometry,
            text,
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
            geometry: GeometryTileSnapshot::empty(SceneEpoch(generation)),
            text: TextSnapshotSet::empty(SceneEpoch(generation)),
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

    pub fn geometry(&self) -> &GeometryTileSnapshot {
        &self.geometry
    }

    pub fn geometry_arc(&self) -> Arc<GeometryTileSnapshot> {
        Arc::clone(&self.geometry)
    }

    pub fn text(&self) -> &TextSnapshotSet {
        &self.text
    }

    pub fn text_arc(&self) -> Arc<TextSnapshotSet> {
        Arc::clone(&self.text)
    }

    pub fn interaction_epochs_match(&self) -> bool {
        let properties_ok =
            self.properties.is_empty() || self.properties.scene_epoch() == self.scene_epoch;
        let geometry_ok =
            self.geometry.is_empty() || self.geometry.scene_epoch() == self.scene_epoch;
        let text_ok = self.text.is_empty() || self.text.scene_epoch() == self.scene_epoch;
        properties_ok && geometry_ok && text_ok
    }

    pub fn byte_size(&self) -> usize {
        self.byte_size
    }

    /// Keep the logical scene/text/geometry/selection-bearing snapshots and
    /// [`SceneEpoch`]. GPU leases do not survive a device epoch bump.
    pub fn rebind_device(&self, frame_id: FrameId, device_epoch: DeviceEpoch) -> Self {
        let leases: Arc<[ResourceLease]> = Arc::from([]);
        let byte_size = estimate_bytes(
            &self.scene,
            &self.damage,
            &leases,
            &self.properties,
            &self.geometry,
            &self.text,
        );
        Self {
            frame_id,
            scene_epoch: self.scene_epoch,
            device_epoch,
            generation: self.generation,
            scene: Arc::clone(&self.scene),
            damage: Arc::clone(&self.damage),
            leases,
            properties: Arc::clone(&self.properties),
            geometry: Arc::clone(&self.geometry),
            text: Arc::clone(&self.text),
            byte_size,
        }
    }
}

fn align_geometry(snapshot: GeometryTileSnapshot, scene_epoch: SceneEpoch) -> GeometryTileSnapshot {
    if snapshot.is_empty() {
        GeometryTileSnapshot::empty(scene_epoch)
    } else {
        snapshot
    }
}

fn align_text(snapshot: TextSnapshotSet, scene_epoch: SceneEpoch) -> TextSnapshotSet {
    if snapshot.is_empty() {
        TextSnapshotSet::empty(scene_epoch)
    } else {
        snapshot
    }
}

fn estimate_bytes(
    scene: &NeoScene,
    damage: &[DamageRect],
    leases: &[ResourceLease],
    properties: &PropertySnapshot,
    geometry: &GeometryTileSnapshot,
    text: &TextSnapshotSet,
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
        + geometry.tiles().len() * 32
        + text.fragments().len() * 192
}
