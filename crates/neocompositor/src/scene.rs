//! Scene graph consumed by the compositor (Milestone B start).

use crate::display_list::{NeoDisplayList, Rect};

#[derive(Clone, Debug, PartialEq)]
pub struct GlassSurface {
    pub barrier_id: u32,
    pub roi: Rect,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NeoScene {
    pub display_list: NeoDisplayList,
    pub glass: Vec<GlassSurface>,
}

impl NeoScene {
    pub fn from_display_list(display_list: NeoDisplayList) -> Self {
        let glass = display_list
            .ops
            .iter()
            .filter_map(|op| match op {
                crate::display_list::NeoPaintOp::BackdropBarrier(b) => Some(GlassSurface {
                    barrier_id: b.id.0,
                    roi: b.roi,
                }),
                _ => None,
            })
            .collect();
        Self {
            display_list,
            glass,
        }
    }
}
