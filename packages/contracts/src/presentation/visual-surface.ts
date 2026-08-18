/**
 * Logical VisualSurface declaration on Product Wire (ADR-0050).
 * Milestone B ingress. Not Plugin SDK. GPU handles MUST NOT appear here.
 */
import { Type, type Static } from '@sinclair/typebox';

export const VisualSurfacePolicySchema = Type.Union([
  Type.Literal('sampleable-texture'),
  Type.Literal('opaque-panel'),
  Type.Literal('poster-frame'),
  Type.Literal('fullscreen-surface'),
  Type.Literal('explicit-error'),
]);
export type VisualSurfacePolicy = Static<typeof VisualSurfacePolicySchema>;

export const VisualSurfaceDeclareSchema = Type.Object(
  {
    surfaceId: Type.String({ minLength: 1, maxLength: 128 }),
    generation: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1, maximum: 8192 }),
    height: Type.Integer({ minimum: 1, maximum: 8192 }),
    sampleable: Type.Boolean(),
    policy: VisualSurfacePolicySchema,
  },
  { additionalProperties: false },
);
export type VisualSurfaceDeclare = Static<typeof VisualSurfaceDeclareSchema>;

const FORBIDDEN_GPU_KEYS = [
  'gpuHandle',
  'wgpuDevice',
  'vulkanDevice',
  'metalDevice',
  'commandEncoder',
  'textureView',
  'buffer',
] as const;

export function visualSurfaceDeclareForbiddenGpuKeys(): readonly string[] {
  return FORBIDDEN_GPU_KEYS;
}
