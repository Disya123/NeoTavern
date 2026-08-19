//! Compile a display list into ordered raster / glass / interaction passes.
//!
//! Adjacent `PaintChunk`/`Image` ops MAY merge only inside the same paint
//! family. Merging across a `BackdropBarrier`, an effect-scope boundary, a
//! `MovingSample`, or an interaction op is forbidden. Glyph/decoration
//! families never merge with box/background chunks, so selection underlay
//! cannot bake into either raster.

use crate::display_list::{
    EffectScopeId, GlassBoundary, ImageLayer, NeoDisplayList, NeoPaintOp, PaintChunk, PaintChunkId,
    StubPayload,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GraphError {
    DuplicateScope(EffectScopeId),
    UnbalancedEnd(EffectScopeId),
    UnclosedScopes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteractionPassKind {
    Text,
    Selection,
    Composition,
    Caret,
    Handle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PaintFamily {
    Background,
    Glyphs,
    Decoration,
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
    /// Same-device blit of a persistent sampleable texture. Not a Vello pass.
    MovingSample {
        chunk: PaintChunk,
        open_scopes: Vec<EffectScopeId>,
    },
    /// CPU-only text/selection/caret/handle ops. M0 GPU skips these.
    Interaction {
        kind: InteractionPassKind,
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
            Self::Glass { .. } | Self::Interaction { .. } => Vec::new(),
            Self::MovingSample { chunk, .. } => vec![chunk.id],
        }
    }

    pub fn open_scopes(&self) -> &[EffectScopeId] {
        match self {
            Self::Raster { open_scopes, .. }
            | Self::Glass { open_scopes, .. }
            | Self::MovingSample { open_scopes, .. }
            | Self::Interaction { open_scopes, .. } => open_scopes,
        }
    }
}

fn paint_family(payload: StubPayload) -> PaintFamily {
    match payload {
        StubPayload::TransparentGlyphs | StubPayload::ColorEmoji | StubPayload::SyntaxGlyphs => {
            PaintFamily::Glyphs
        }
        StubPayload::Decoration => PaintFamily::Decoration,
        StubPayload::Wallpaper
        | StubPayload::VectorUi
        | StubPayload::Overlay
        | StubPayload::MovingSample => PaintFamily::Background,
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
            NeoPaintOp::PaintChunk(chunk) | NeoPaintOp::Image(ImageLayer { chunk }) => {
                if chunk.payload == StubPayload::MovingSample {
                    flush(&mut current, &mut passes, &scope_stack);
                    passes.push(CompiledPass::MovingSample {
                        chunk: chunk.clone(),
                        open_scopes: scope_stack.clone(),
                    });
                } else {
                    let family = paint_family(chunk.payload);
                    let split = current
                        .last()
                        .is_some_and(|open| paint_family(open.payload) != family);
                    if split {
                        flush(&mut current, &mut passes, &scope_stack);
                    }
                    current.push(chunk.clone());
                }
            }
            NeoPaintOp::BackdropBarrier(barrier) => {
                flush(&mut current, &mut passes, &scope_stack);
                passes.push(CompiledPass::Glass {
                    barrier: barrier.clone(),
                    open_scopes: scope_stack.clone(),
                });
            }
            NeoPaintOp::ImagePaint(_) => {}
            NeoPaintOp::TextFragment(_)
            | NeoPaintOp::Selection(_)
            | NeoPaintOp::Composition(_)
            | NeoPaintOp::Caret(_)
            | NeoPaintOp::Handle(_) => {
                flush(&mut current, &mut passes, &scope_stack);
                let kind = match op {
                    NeoPaintOp::TextFragment(_) => InteractionPassKind::Text,
                    NeoPaintOp::Selection(_) => InteractionPassKind::Selection,
                    NeoPaintOp::Composition(_) => InteractionPassKind::Composition,
                    NeoPaintOp::Caret(_) => InteractionPassKind::Caret,
                    NeoPaintOp::Handle(_) => InteractionPassKind::Handle,
                    _ => unreachable!("interaction arm"),
                };
                passes.push(CompiledPass::Interaction {
                    kind,
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
            CompiledPass::MovingSample { .. } | CompiledPass::Interaction { .. } => {}
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
