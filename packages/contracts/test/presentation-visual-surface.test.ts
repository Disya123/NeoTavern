import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  VisualSurfaceDeclareSchema,
  visualSurfaceDeclareForbiddenGpuKeys,
} from '../src/presentation/visual-surface.js';

describe('VisualSurface Product Wire declare', () => {
  it('accepts a logical declaration without GPU handles', () => {
    const declare = {
      surfaceId: 'vs.reference',
      generation: 1,
      width: 64,
      height: 64,
      sampleable: true,
      policy: 'sampleable-texture',
    };
    expect(Value.Check(VisualSurfaceDeclareSchema, declare)).toBe(true);
  });

  it('rejects GPU handle fields on the wire declaration', () => {
    for (const key of visualSurfaceDeclareForbiddenGpuKeys()) {
      const poisoned = {
        surfaceId: 'vs.reference',
        generation: 1,
        width: 64,
        height: 64,
        sampleable: true,
        policy: 'sampleable-texture',
        [key]: 1,
      };
      expect(Value.Check(VisualSurfaceDeclareSchema, poisoned)).toBe(false);
    }
    expect(JSON.stringify(VisualSurfaceDeclareSchema)).not.toMatch(
      /wgpu|vulkan|metal|encoder/i,
    );
  });
});
