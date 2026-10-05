//! Epoch arena for retained scene nodes (ADR-0057 platform spec §3).
//!
//! Every node lives in a slot; every slot has an epoch. A [`SceneId`] is
//! `(slot, epoch)`; when a slot is freed and reallocated its epoch bumps, so
//! a stale handle carried from an older frame can never silently address a
//! *different* node — the exact failure class of the vendored
//! `add_children_to_parent` patch (dioxus-native-dom `ElementId` recycling
//! orphaning arena-dropped nodes; audit PL-L03/UI-13).

use std::fmt;

/// Stable handle to a scene node. Valid only while the slot still holds the
/// same epoch.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct SceneId {
    slot: u32,
    epoch: u32,
}

impl fmt::Debug for SceneId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SceneId(#{}.{})", self.slot, self.epoch)
    }
}

impl SceneId {
    /// Slot index (stable identity component).
    pub fn slot(&self) -> u32 {
        self.slot
    }

    /// Epoch of this handle (bumped on slot reuse).
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
}

/// Slot index type.
pub type NodeId = usize;

/// One arena slot. `occupied: false` means free-listed; `epoch` bumped on
/// every free and every alloc into that slot.
#[derive(Debug)]
struct Slot<T> {
    epoch: u32,
    occupied: bool,
    value: Option<T>,
}

/// Retained node arena with epoch validation.
///
/// The arena never panics on a stale id — [`SceneArena::get`] and friends
/// return `None` and callers treat "the node is gone" as a normal frame
/// event (the next projection rebuilds it). No fifth-copy workarounds
/// (AGENTS: parallel truths are fixed by deletion, not by duplication).
#[derive(Debug)]
pub struct SceneArena<T> {
    slots: Vec<Slot<T>>,
    free: Vec<NodeId>,
}

impl<T> Default for SceneArena<T> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
        }
    }
}

impl<T> SceneArena<T> {
    pub fn new() -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.slots.iter().filter(|s| s.occupied).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }

    /// Allocates a node, reusing a freed slot when one exists (real reuse,
    /// with an epoch bump — unlike the no-op GC the audit found in the
    /// blitz-dom patch, PL-L03).
    pub fn alloc(&mut self, value: T) -> SceneId {
        let (slot, epoch) = match self.free.pop() {
            Some(slot) => {
                let s = &mut self.slots[slot];
                s.epoch = s.epoch.wrapping_add(1);
                s.occupied = true;
                (slot, s.epoch)
            }
            None => {
                let slot = self.slots.len();
                self.slots.push(Slot {
                    epoch: 0,
                    occupied: true,
                    value: None,
                });
                (slot, 0)
            }
        };
        self.slots[slot].value = Some(value);
        SceneId {
            slot: slot as u32,
            epoch,
        }
    }

    /// Frees the node if the id is current. Returns the value. A stale or
    /// already-freed id is a no-op (`None`) — never a wrong-node free.
    pub fn remove(&mut self, id: SceneId) -> Option<T> {
        self.live_slot(id.slot as usize, id.epoch)?;
        let slot = &mut self.slots[id.slot as usize];
        slot.occupied = false;
        let value = slot.value.take();
        self.free.push(id.slot as usize);
        value
    }

    /// Current value for a live id.
    pub fn get(&self, id: SceneId) -> Option<&T> {
        self.live_slot(id.slot as usize, id.epoch)
            .and_then(|i| self.slots[i].value.as_ref())
    }

    pub fn get_mut(&mut self, id: SceneId) -> Option<&mut T> {
        match self.live_slot(id.slot as usize, id.epoch) {
            Some(i) => self.slots[i].value.as_mut(),
            None => None,
        }
    }

    pub fn contains(&self, id: SceneId) -> bool {
        self.live_slot(id.slot as usize, id.epoch).is_some()
    }

    /// Iterates live `(SceneId, &T)` pairs in slot order (paint order is the
    /// scene tree, not arena order — this exists for tests and diagnostics).
    pub fn iter(&self) -> impl Iterator<Item = (SceneId, &T)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| {
            s.occupied
                .then(|| {
                    s.value.as_ref().map(|v| {
                        (
                            SceneId {
                                slot: i as u32,
                                epoch: s.epoch,
                            },
                            v,
                        )
                    })
                })
                .flatten()
        })
    }

    fn live_slot(&self, slot: NodeId, epoch: u32) -> Option<NodeId> {
        let s = self.slots.get(slot)?;
        (s.occupied && s.epoch == epoch).then_some(slot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_ids_never_alias_new_nodes() {
        let mut a = SceneArena::new();
        let id0 = a.alloc("first");
        assert_eq!(a.remove(id0).as_deref(), Some("first"));
        // Slot is reused for a different value…
        let id1 = a.alloc("second");
        assert_eq!(id1.slot, id0.slot, "free-list must reuse the slot");
        assert_ne!(id1.epoch, id0.epoch, "epoch must bump on reuse");
        // …but the stale handle must NOT read it.
        assert!(!a.contains(id0));
        assert_eq!(a.get(id0), None);
        assert_eq!(
            a.remove(id0),
            None,
            "stale remove must not free the new node"
        );
        assert!(a.contains(id1));
        assert_eq!(a.get(id1).copied(), Some("second"));
    }

    #[test]
    fn double_free_is_a_noop() {
        let mut a = SceneArena::new();
        let id = a.alloc(1u8);
        assert_eq!(a.remove(id), Some(1));
        assert_eq!(a.remove(id), None);
        // The free-list must not have grown twice.
        let id2 = a.alloc(2u8);
        assert!(a.contains(id2));
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn arena_reuse_keeps_len_honest() {
        let mut a: SceneArena<u32> = SceneArena::new();
        let ids: Vec<_> = (0..100).map(|i| a.alloc(i)).collect();
        assert_eq!(a.len(), 100);
        for id in &ids[..50] {
            a.remove(*id);
        }
        assert_eq!(a.len(), 50);
        for i in 0..50 {
            let id = a.alloc(i);
            assert!(a.contains(id));
        }
        assert_eq!(a.len(), 100);
        assert_eq!(a.capacity(), 100, "no growth when the free list covers it");
    }
}
