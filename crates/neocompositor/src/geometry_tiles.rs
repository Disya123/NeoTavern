//! Compositor-facing tile geometry snapshot (RFC §15.6 / §21).
//!
//! This is not `chat-viewport` and carries no chat/model semantics. The
//! producer publishes tile bounds; the compositor clips interaction
//! geometry against them.

use std::sync::Arc;

use crate::display_list::Rect;
use crate::epoch::SceneEpoch;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct TileId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileKind {
    Prepared,
    Fallback,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeometryTile {
    pub id: TileId,
    pub bounds: Rect,
    pub generation: u64,
    pub kind: TileKind,
}

/// Immutable tile geometry bound to a [`SceneEpoch`]. Switches atomically
/// with property and text snapshots on a [`crate::FrameTransaction`].
#[derive(Clone, Debug, PartialEq)]
pub struct GeometryTileSnapshot {
    scene_epoch: SceneEpoch,
    tiles: Arc<[GeometryTile]>,
}

impl GeometryTileSnapshot {
    pub fn empty(scene_epoch: SceneEpoch) -> Self {
        Self {
            scene_epoch,
            tiles: Arc::from([]),
        }
    }

    pub fn commit(scene_epoch: SceneEpoch, tiles: Vec<GeometryTile>) -> Self {
        Self {
            scene_epoch,
            tiles: tiles.into(),
        }
    }

    pub fn scene_epoch(&self) -> SceneEpoch {
        self.scene_epoch
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }

    pub fn tiles(&self) -> &[GeometryTile] {
        &self.tiles
    }

    pub fn get(&self, id: TileId) -> Option<&GeometryTile> {
        self.tiles.iter().find(|tile| tile.id == id)
    }

    pub fn is_fallback(&self, id: TileId) -> bool {
        self.get(id)
            .is_some_and(|tile| tile.kind == TileKind::Fallback)
    }
}

impl Default for GeometryTileSnapshot {
    fn default() -> Self {
        Self::empty(SceneEpoch(0))
    }
}
