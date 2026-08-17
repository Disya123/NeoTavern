//! Frame transaction and damage (Milestone B start).

use crate::display_list::Rect;
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

#[derive(Clone, Debug, PartialEq)]
pub struct FrameTransaction {
    pub generation: u64,
    pub scene: NeoScene,
    pub damage: Vec<DamageRect>,
}

impl FrameTransaction {
    pub fn full_frame(scene: NeoScene) -> Self {
        let generation = scene.display_list.generation;
        let damage = vec![DamageRect {
            x: 0,
            y: 0,
            width: scene.display_list.width,
            height: scene.display_list.height,
        }];
        Self {
            generation,
            scene,
            damage,
        }
    }
}
