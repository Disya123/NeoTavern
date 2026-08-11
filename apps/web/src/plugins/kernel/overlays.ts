/**
 * Rev4 kernel: ui.overlay.* host handlers with hitPolicy (contract §2).
 *
 * The host owns the interaction contract for every kernel overlay: the
 * container div, the clip-path union membership and (for 'proxy') the
 * hit-div that forwards normalized pointer packets back to the plugin via
 * `ui.overlay.pointer`. Layout pushes (`ui.overlay.layout`) ride the runtime's
 * publishLayout flush; `emergencyClose` is exported for host triggers such as
 * capability revocation UI.
 */
import { kernel } from '@neotavern/plugin-sdk';
import { randomToken } from '@neotavern/shared';
import type { KernelHostContext } from './types.js';
import type {
  OverlayHitPolicy,
  OverlayPointerPacket,
  OverlayRect,
  OverlayShape,
} from '../runtime.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

const OVERLAY_MODES: readonly OverlayHitPolicy[] = ['native', 'proxy', 'full', 'none'];
const SHAPE_KINDS = new Set(['rect', 'circle', 'ellipse', 'polygon']);

function isOverlayMode(value: unknown): value is OverlayHitPolicy {
  return typeof value === 'string' && (OVERLAY_MODES as readonly string[]).includes(value);
}

function fail(code: string, details?: Record<string, unknown>): KernelError {
  return new KernelError(code, { details });
}

function requireCapability(ctx: KernelHostContext, mode: OverlayHitPolicy): void {
  // A plain `ui.overlay` grant covers every mode; `ui.overlay.<mode>` is
  // mode-specific (contract §2 overlays).
  if (ctx.hasCapability('ui.overlay') || ctx.hasCapability(`ui.overlay.${mode}`)) return;
  throw fail(KernelErrorCode.CAPABILITY_DENIED, { capability: `ui.overlay.${mode}` });
}

/** Strict numeric rect parse; `null` (not throw) for absent values. */
export function parseOverlayRect(value: unknown): OverlayRect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { x, y, width, height } = record;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Strict hit-shape parse against `limits.overlays` (rev4 §A4, invariant 7):
 * shape count, polygon points and serialized geometry size are capped; any
 * malformed shape yields `null`. Absent shapes parse to `undefined`.
 */
export function parseOverlayShapes(
  value: unknown,
  limits: { maxShapes: number; maxPolygonPoints: number; maxGeometryBytes: number },
): OverlayShape[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (value.length > limits.maxShapes) return null;
  const shapes: OverlayShape[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string' || !SHAPE_KINDS.has(kind)) return null;
    if (kind === 'rect') {
      const rect = parseOverlayRect(record);
      if (!rect) return null;
      shapes.push({ kind: 'rect', x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    } else if (kind === 'circle') {
      const { cx, cy, r } = record;
      if (!isFiniteNumber(cx) || !isFiniteNumber(cy) || !isFiniteNumber(r) || r <= 0) return null;
      shapes.push({ kind, cx, cy, r });
    } else if (kind === 'ellipse') {
      const { cx, cy, rx, ry } = record;
      if (
        !isFiniteNumber(cx) ||
        !isFiniteNumber(cy) ||
        !isFiniteNumber(rx) ||
        !isFiniteNumber(ry) ||
        rx <= 0 ||
        ry <= 0
      ) {
        return null;
      }
      shapes.push({ kind, cx, cy, rx, ry });
    } else {
      const points = record.points;
      if (!Array.isArray(points) || points.length < 3 || points.length > limits.maxPolygonPoints) {
        return null;
      }
      const tuple: Array<[number, number]> = [];
      for (const point of points) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !isFiniteNumber(point[0]) ||
          !isFiniteNumber(point[1])
        ) {
          return null;
        }
        tuple.push([point[0], point[1]]);
      }
      shapes.push({ kind: 'polygon', points: tuple });
    }
  }
  if (JSON.stringify(shapes).length > limits.maxGeometryBytes) return null;
  return shapes;
}

/** Host→plugin emergency teardown (rev4 §A4): dispose every sandbox overlay. */
export function emergencyClose(ctx: KernelHostContext): void {
  void ctx.session.call('ui.emergencyClose', {}, { deadlineMs: 1000 }).catch(() => undefined);
}

/** Host→plugin layout push (rev4 §A4): recomputes and sends kernel overlay rects. */
export function sendLayout(ctx: KernelHostContext): void {
  ctx.runtime.kernelPushOverlayLayout(ctx.frame);
}

export function attachOverlays(ctx: KernelHostContext): void {
  ctx.session.handle('ui.overlay.register', (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const mode = params.mode;
    if (!isOverlayMode(mode)) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        reason: 'mode',
        modes: [...OVERLAY_MODES],
      });
    }
    requireCapability(ctx, mode);
    let initialRect: OverlayRect | null = null;
    if (params.initialRect !== undefined) {
      initialRect = parseOverlayRect(params.initialRect);
      if (!initialRect) throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'initialRect' });
    }
    const hitShapes = parseOverlayShapes(params.hitShapes, kernel.DEFAULT_PLUGIN_LIMITS.overlays);
    if (hitShapes === null) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, {
        reason: 'hitShapes',
        limits: {
          maxShapes: kernel.DEFAULT_PLUGIN_LIMITS.overlays.maxShapes,
          maxPolygonPoints: kernel.DEFAULT_PLUGIN_LIMITS.overlays.maxPolygonPoints,
          maxGeometryBytes: kernel.DEFAULT_PLUGIN_LIMITS.overlays.maxGeometryBytes,
        },
      });
    }
    if ((mode === 'full' || mode === 'none') && hitShapes && hitShapes.length > 0) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'hitShapes-mode' });
    }
    if (
      mode === 'full' &&
      [...ctx.frame.overlays.values()].some((overlay) => overlay.hitPolicy === 'full')
    ) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'single-full-overlay' });
    }
    const registrationId = `${ctx.pluginId}:overlay:${randomToken(10)}`;
    const container = document.createElement('div');
    container.dataset.neotavernOverlay = registrationId;
    // Pure geometry scaffold: 'native'/'full' clicks go to the iframe,
    // 'proxy' to the forwarding hit-div above, 'none' to its absorbing
    // hit-div.
    container.style.pointerEvents = 'none';
    container.style.left = `${initialRect?.x ?? 0}px`;
    container.style.top = `${initialRect?.y ?? 0}px`;
    container.style.width = `${initialRect?.width ?? 0}px`;
    container.style.height = `${initialRect?.height ?? 0}px`;
    ctx.frame.host.append(container);
    const forward = (packet: OverlayPointerPacket): void => {
      void ctx.session
        .call('ui.overlay.pointer', { registrationId, packet }, { deadlineMs: 1000 })
        .catch(() => undefined);
    };
    ctx.runtime.kernelMountOverlay(
      ctx.frame,
      registrationId,
      container,
      mode,
      mode === 'proxy' ? forward : undefined,
      hitShapes,
    );
    ctx.runtime.kernelAddRegistration({
      pluginId: ctx.frame.plugin.id,
      pluginName: ctx.frame.plugin.name,
      registrationId,
      kind: 'overlays',
      definition: { id: registrationId, title: `${ctx.frame.plugin.name} overlay` },
    });
    return { registrationId };
  });

  ctx.session.handle('ui.overlay.update', (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const registrationId = params.registrationId;
    if (typeof registrationId !== 'string' || registrationId.length === 0) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'registrationId' });
    }
    const registration = ctx.runtime.kernelGetRegistration(registrationId);
    const overlay = ctx.frame.overlays.get(registrationId);
    if (!registration || registration.pluginId !== ctx.pluginId || !overlay) {
      throw fail(KernelErrorCode.NOT_FOUND, { registrationId });
    }
    requireCapability(ctx, overlay.hitPolicy ?? 'native');
    const hitShapes = parseOverlayShapes(params.hitShapes, kernel.DEFAULT_PLUGIN_LIMITS.overlays);
    if (hitShapes === null) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'hitShapes' });
    }
    if (params.rect !== undefined) {
      const rect = parseOverlayRect(params.rect);
      if (!rect) throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'rect' });
      ctx.runtime.kernelUpdateOverlay(ctx.frame, registrationId, rect, hitShapes);
    } else if (hitShapes !== undefined) {
      ctx.runtime.kernelUpdateOverlay(ctx.frame, registrationId, undefined, hitShapes);
    }
    return {};
  });

  ctx.session.handle('ui.overlay.dispose', (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const registrationId = params.registrationId;
    if (typeof registrationId !== 'string' || registrationId.length === 0) {
      throw fail(KernelErrorCode.VALIDATION_FAILED, { reason: 'registrationId' });
    }
    const registration = ctx.runtime.kernelGetRegistration(registrationId);
    if (!registration || registration.pluginId !== ctx.pluginId) {
      throw fail(KernelErrorCode.NOT_FOUND, { registrationId });
    }
    ctx.runtime.kernelRemoveRegistration(registrationId);
    return {};
  });

  // rev4 §G7: the sandbox relays Escape from its own document (host window
  // listeners never see iframe keys); the host closes the live 'full'
  // overlay of this plugin. No capability gate: the plugin can only ask
  // the host to close its own overlay.
  ctx.session.handle('ui.overlay.escape', () => {
    ctx.runtime.closeFullOverlay();
    return {};
  });
}
