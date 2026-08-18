//! Scene graph consumed by the compositor (Milestone B start).

use crate::display_list::{NeoDisplayList, Rect};
use crate::epoch::SceneEpoch;
use crate::surface_fallback::{
    compile_surface_plan, SurfaceCapability, SurfaceCompileError, SurfaceCompileRequest, SurfaceId,
    SurfacePlan, SurfaceSpec,
};

#[derive(Clone, Debug, PartialEq)]
pub struct GlassSurface {
    pub barrier_id: u32,
    pub roi: Rect,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NeoScene {
    pub display_list: NeoDisplayList,
    pub glass: Vec<GlassSurface>,
    pub surfaces: Vec<SurfaceSpec>,
    pub surface_plan: Option<SurfacePlan>,
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
            surfaces: Vec::new(),
            surface_plan: None,
        }
    }

    pub fn with_surfaces(mut self, surfaces: Vec<SurfaceSpec>) -> Self {
        self.surfaces = surfaces;
        self
    }

    /// Bind capabilities and fallbacks in this [`SceneEpoch`] before present.
    pub fn compile_surfaces(
        mut self,
        scene_epoch: SceneEpoch,
        previous_epoch: Option<SceneEpoch>,
        previous_capabilities: &[(SurfaceId, SurfaceCapability)],
    ) -> Result<Self, SurfaceCompileError> {
        let viewport = Rect::new(
            0.0,
            0.0,
            self.display_list.width as f32,
            self.display_list.height as f32,
        );
        let compiled = compile_surface_plan(SurfaceCompileRequest {
            scene_epoch,
            previous_epoch,
            previous_capabilities,
            surfaces: &self.surfaces,
            display_list: &self.display_list,
            viewport,
        })?;
        self.display_list = compiled.display_list;
        self.surface_plan = Some(compiled.plan);
        Ok(self)
    }
}
