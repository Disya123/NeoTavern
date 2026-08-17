//! Glass render boundary (RFC §50). Not a production shader or JNI pass.

use crate::scene::GlassSurface;

#[derive(Clone, Debug, PartialEq)]
pub struct NeoGlass {
    pub surface: GlassSurface,
}

impl NeoGlass {
    pub fn from_surface(surface: GlassSurface) -> Self {
        Self { surface }
    }
}
