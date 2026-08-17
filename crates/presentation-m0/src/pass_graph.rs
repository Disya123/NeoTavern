//! Compile a display list into ordered raster / glass passes.
//!
//! Adjacent `PaintChunk`/`Image` ops MAY merge. Merging across a
//! `BackdropBarrier` or an effect-scope boundary is forbidden.

use crate::display_list::{
    EffectScopeId, GlassBoundary, NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GraphError {
    DuplicateScope(EffectScopeId),
    UnbalancedEnd(EffectScopeId),
    UnclosedScopes,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CompiledPass {
    Raster {
        chunks: Vec<PaintChunk>,
        open_scopes: Vec<EffectScopeId>,
    },
    Glass {
        barrier: GlassBoundary,
        open_scopes: Vec<EffectScopeId>,
    },
}

impl CompiledPass {
    pub fn is_glass(&self) -> bool {
        matches!(self, Self::Glass { .. })
    }

    pub fn chunk_ids(&self) -> Vec<PaintChunkId> {
        match self {
            Self::Raster { chunks, .. } => chunks.iter().map(|chunk| chunk.id).collect(),
            Self::Glass { .. } => Vec::new(),
        }
    }

    pub fn open_scopes(&self) -> &[EffectScopeId] {
        match self {
            Self::Raster { open_scopes, .. } | Self::Glass { open_scopes, .. } => open_scopes,
        }
    }
}

pub fn compile_passes(list: &NeoDisplayList) -> Result<Vec<CompiledPass>, GraphError> {
    let mut passes = Vec::new();
    let mut current: Vec<PaintChunk> = Vec::new();
    let mut scope_stack: Vec<EffectScopeId> = Vec::new();

    let flush = |current: &mut Vec<PaintChunk>,
                 passes: &mut Vec<CompiledPass>,
                 scope_stack: &[EffectScopeId]| {
        if current.is_empty() {
            return;
        }
        passes.push(CompiledPass::Raster {
            chunks: std::mem::take(current),
            open_scopes: scope_stack.to_vec(),
        });
    };

    for op in list.ops.iter() {
        match op {
            NeoPaintOp::BeginEffectScope(id) => {
                if scope_stack.contains(id) {
                    return Err(GraphError::DuplicateScope(*id));
                }
                flush(&mut current, &mut passes, &scope_stack);
                scope_stack.push(*id);
            }
            NeoPaintOp::EndEffectScope(id) => {
                flush(&mut current, &mut passes, &scope_stack);
                match scope_stack.pop() {
                    Some(open) if open == *id => {}
                    Some(_) | None => return Err(GraphError::UnbalancedEnd(*id)),
                }
            }
            NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(crate::ImageLayer { chunk }) => {
                current.push(chunk.clone());
            }
            NeoPaintOp::BackdropBarrier(barrier) => {
                flush(&mut current, &mut passes, &scope_stack);
                passes.push(CompiledPass::Glass {
                    barrier: barrier.clone(),
                    open_scopes: scope_stack.clone(),
                });
            }
        }
    }
    flush(&mut current, &mut passes, &scope_stack);
    if !scope_stack.is_empty() {
        return Err(GraphError::UnclosedScopes);
    }
    Ok(passes)
}

/// True when no raster pass contains chunks from both sides of any barrier.
pub fn barriers_cut_raster_runs(list: &NeoDisplayList, passes: &[CompiledPass]) -> bool {
    let mut seen_chunks: Vec<PaintChunkId> = Vec::new();
    let mut op_i = 0usize;
    for pass in passes {
        match pass {
            CompiledPass::Raster { chunks, .. } => {
                for chunk in chunks {
                    if seen_chunks.contains(&chunk.id) {
                        return false;
                    }
                    seen_chunks.push(chunk.id);
                }
            }
            CompiledPass::Glass { barrier, .. } => {
                while op_i < list.ops.len() {
                    match &list.ops[op_i] {
                        NeoPaintOp::BackdropBarrier(op_barrier) if op_barrier.id == barrier.id => {
                            op_i += 1;
                            break;
                        }
                        _ => op_i += 1,
                    }
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
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
                CompiledPass::Raster { .. } => None,
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
