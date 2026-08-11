/**
 * Rev4 kernel: workers.* host handlers (rev4 §C2).
 *
 * Compute workers run inside the plugin's own opaque-origin sandbox iframe
 * (spike 6/8: classic Workers from blob bundles work there; module entries
 * ride `data:` URLs because blob: module workers cannot resolve their entry
 * across opaque origins — ADR-0018). The sandbox CSP grants
 * `worker-src blob: data:` plus `script-src … blob: data:` and
 * `connect-src 'none'`, so a worker inherits the opaque origin and has no
 * direct network. The host never executes plugin code in the app origin:
 *
 *  1. the entry must be on the manifest `workers` allowlist (install-time
 *     validated safe relative JS path) and the plugin must hold
 *     `compute.worker`;
 *  2. the host fetches the bundle same-origin over the guard-checked
 *     `/api/v2/plugins/:id/assets/*` route, enforcing the size caps and the
 *     `text/javascript` MIME before any byte leaves the host;
 *  3. the bytes ride a kernel stream into the sandbox, which constructs the
 *     Worker from a blob URL (classic) or a data: URL (module) and reports
 *     lifecycle back (`workers.exited`, `workers.error`) so the host can
 *     keep its quota ledger honest.
 *
 * Data authority stays separate from compute authority (rev4 §0 invariant 3):
 * a worker has none; the plugin shuttles data over its own kernel
 * capabilities. Live workers are capped by `limits.workers.maxInstances`
 * (default 2) and are terminated with the session (frame reset, disable,
 * uninstall — rev4 §0 invariant 6) and on `compute.worker` revocation.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;

/** Entry bundle caps; mirrored in the sandbox and enforced on the asset route. */
const MAX_WORKER_BUNDLE_BYTES = kernel.DEFAULT_PLUGIN_LIMITS.workers.maxBundleBytes;
const MAX_MODULE_BUNDLE_BYTES = kernel.DEFAULT_PLUGIN_LIMITS.workers.maxModuleDataUrlBytes;

function fail(code: string, details?: Record<string, unknown>): never {
  throw new KernelError(code, { details });
}

function paramsRecord(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    fail(KernelErrorCode.VALIDATION_FAILED, { field: 'params', method });
  }
  return params as Record<string, unknown>;
}

/**
 * Manifest `workers` allowlist: install-time validated safe relative JS
 * module paths. The manifest record is a plain object on the wire.
 */
function manifestWorkers(frame: KernelHostContext['frame']): string[] {
  const manifest = frame.plugin.manifest as { workers?: unknown } | undefined;
  if (!manifest || !Array.isArray(manifest.workers)) return [];
  return manifest.workers.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

export function attachWorkers(ctx: KernelHostContext): void {
  const session = ctx.session;
  /** Quota ledger: workerId -> manifest entry of the live worker. */
  const live = new Map<string, string>();

  function terminateAll(): void {
    for (const workerId of [...live.keys()]) {
      live.delete(workerId);
      void session.call('workers.terminate', { workerId }, { deadlineMs: 5_000 }).catch(() => {});
    }
  }

  // Session teardown (frame reset/disable/uninstall) kills the workers the
  // sandbox realm might otherwise keep (rev4 §0 invariant 6).
  session.scope.track({ dispose: terminateAll });

  // Revocation of the compute capability stops dependent workers (rev4 §B2).
  session.onCapabilityRevoked((name) => {
    if (name === 'compute.worker') terminateAll();
  });

  session.handle('workers.spawn', async ({ params, signal }) => {
    const method = 'workers.spawn';
    if (!ctx.hasCapability('compute.worker')) {
      fail(KernelErrorCode.CAPABILITY_DENIED, { capability: 'compute.worker' });
    }
    const record = paramsRecord(params, method);
    const entry = record['entry'];
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) {
      fail(KernelErrorCode.VALIDATION_FAILED, { field: 'entry', method });
    }
    if (!manifestWorkers(ctx.frame).includes(entry)) {
      fail(KernelErrorCode.VALIDATION_FAILED, {
        field: 'entry',
        method,
        reason: 'not-in-manifest-workers',
      });
    }
    const maxInstances = kernel.DEFAULT_PLUGIN_LIMITS.workers.maxInstances;
    if (live.size >= maxInstances) {
      fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        limit: 'workers.maxInstances',
        max: maxInstances,
      });
    }

    // Host-side verified fetch over the same guard-checked asset route the
    // sandbox uses; the host enforces the worker size caps and MIME here.
    const url = `/api/v2/plugins/${encodeURIComponent(ctx.pluginId)}/assets/${entry
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      fail(KernelErrorCode.NOT_FOUND, { entry, status: response.status });
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('javascript')) {
      fail(KernelErrorCode.VALIDATION_FAILED, { field: 'entry', reason: 'bad-mime' });
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader !== null && Number(lengthHeader) > MAX_WORKER_BUNDLE_BYTES) {
      fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        limit: 'workers.maxBundleBytes',
        max: MAX_WORKER_BUNDLE_BYTES,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_WORKER_BUNDLE_BYTES) {
      fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        limit: 'workers.maxBundleBytes',
        max: MAX_WORKER_BUNDLE_BYTES,
      });
    }
    // Module entries become data: URLs inside the opaque sandbox; Chromium
    // rejects data: scripts above ~2 MiB, so they get the tighter cap.
    if (entry.endsWith('.mjs') && bytes.byteLength > MAX_MODULE_BUNDLE_BYTES) {
      fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        limit: 'workers.maxModuleDataUrlBytes',
        max: MAX_MODULE_BUNDLE_BYTES,
      });
    }
    if (signal?.aborted) fail(KernelErrorCode.OPERATION_ABORTED);

    // Deliver the verified bundle over a kernel stream; the sandbox spawns
    // the Worker from it inside its own opaque origin.
    const stream = session.openOutboundStream({ kind: 'workers.bundle', entry });
    try {
      await stream.write(bytes);
      stream.end();
    } catch (error) {
      stream.fail(error);
      throw error;
    }
    live.set(stream.streamId, entry);
    return { workerId: stream.streamId, streamId: stream.streamId };
  });

  // Plugin-initiated termination; bookkeeping only — the sandbox terminates
  // its own Worker and reports `workers.exited` as well.
  session.handle('workers.terminate', ({ params }) => {
    const record = paramsRecord(params, 'workers.terminate');
    const workerId = record['workerId'];
    if (typeof workerId !== 'string' || workerId.length === 0) {
      fail(KernelErrorCode.VALIDATION_FAILED, { field: 'workerId' });
    }
    live.delete(workerId);
    return {};
  });

  // Sandbox lifecycle reports keep the quota ledger honest even when the
  // plugin never terminates (crash, onerror, signal abort).
  session.handle('workers.exited', ({ params }) => {
    const record = paramsRecord(params, 'workers.exited');
    if (typeof record['workerId'] === 'string') live.delete(record['workerId']);
    return {};
  });
  session.handle('workers.error', ({ params }) => {
    const record = paramsRecord(params, 'workers.error');
    if (typeof record['workerId'] === 'string') live.delete(record['workerId']);
    return {};
  });
}
