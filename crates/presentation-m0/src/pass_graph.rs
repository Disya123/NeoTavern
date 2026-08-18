//! Re-export of the production pass compiler (`neotavern-neocompositor`).
//!
//! D1a graph tests stay here because they need `static_d1a_scene()`.

pub use neotavern_neocompositor::{
    barriers_cut_raster_runs, compile_passes, CompiledPass, GraphError, InteractionPassKind,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display_list::{EffectScopeId, NeoPaintOp};
    use crate::scene_d1a::static_d1a_scene;

    #[test]
    fn d1a_scene_is_wallpaper_glass_ui_glass_overlay() {
        let scene = static_d1a_scene();
        let passes = compile_passes(&scene).expect("valid D1a list");
        let kinds: Vec<&'static str> = passes
            .iter()
            .map(|pass| match pass {
                CompiledPass::Raster { .. } => "raster",
                CompiledPass::Glass { .. } => "glass",
                CompiledPass::MovingSample { .. } => "moving",
                CompiledPass::Interaction { .. } => "interaction",
            })
            .collect();
        assert_eq!(
            kinds,
            ["raster", "glass", "raster", "raster", "glass", "raster"],
            "expected background → glass A → UI → scoped UI → glass B → overlay"
        );
        assert!(barriers_cut_raster_runs(&scene, &passes));
        let glass: Vec<_> = passes
            .iter()
            .filter_map(|pass| match pass {
                CompiledPass::Glass {
                    barrier,
                    open_scopes,
                } => Some((barrier.id.0, open_scopes.clone())),
                CompiledPass::Raster { .. }
                | CompiledPass::MovingSample { .. }
                | CompiledPass::Interaction { .. } => None,
            })
            .collect();
        assert_eq!(glass.len(), 2);
        assert!(
            glass[0].1.is_empty(),
            "glass A is outside the opacity group"
        );
        assert_eq!(
            glass[1].1,
            vec![crate::EffectScopeId(1)],
            "glass B keeps the ancestor opacity scope"
        );
    }

    #[test]
    fn cannot_merge_chunks_across_a_barrier() {
        let scene = static_d1a_scene();
        let passes = compile_passes(&scene).expect("valid D1a list");
        let mut ids_before_first_glass = Vec::new();
        let mut ids_after_first_glass = Vec::new();
        let mut seen_glass = false;
        for pass in &passes {
            match pass {
                CompiledPass::Glass { .. } => seen_glass = true,
                CompiledPass::MovingSample { .. } | CompiledPass::Interaction { .. } => {}
                CompiledPass::Raster { chunks, .. } if !seen_glass => {
                    ids_before_first_glass.extend(chunks.iter().map(|chunk| chunk.id));
                }
                CompiledPass::Raster { chunks, .. } => {
                    ids_after_first_glass.extend(chunks.iter().map(|chunk| chunk.id));
                }
            }
        }
        assert!(!ids_before_first_glass.is_empty());
        assert!(!ids_after_first_glass.is_empty());
        for id in &ids_before_first_glass {
            assert!(
                !ids_after_first_glass.contains(id),
                "chunk {id:?} appeared on both sides of a BackdropBarrier"
            );
        }
    }

    #[test]
    fn unbalanced_end_is_an_error() {
        let mut scene = static_d1a_scene();
        let mut ops = Vec::from(scene.ops.as_ref());
        ops.push(NeoPaintOp::EndEffectScope(EffectScopeId(99)));
        scene.ops = ops.into();
        assert_eq!(
            compile_passes(&scene),
            Err(GraphError::UnbalancedEnd(EffectScopeId(99)))
        );
    }
}
