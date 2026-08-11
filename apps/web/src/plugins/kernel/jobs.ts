/**
 * Rev4 kernel: jobs.* + network.fetch + actions.perform host handlers
 * (contract §2).
 *
 * - `jobs.schedule|cancel|list` persist server-side through the pluginJobs
 *   REST routes (apps/server/src/plugins/pluginJobs.ts); the kernel RPCs are
 *   thin capability-checked wrappers.
 * - Due jobs arrive as the `plugin.job.due` app event over the SSE relay;
 *   `runtime.onAppEvent` (host-side interception) forwards them to the live
 *   sandbox as the `jobs.run` kernel RPC. The subscription is tracked in the
 *   session scope so frame reset / session dispose cannot leak it.
 * - `network.fetch` enforces the `network.domains` grant scope (origins or
 *   all) and returns text capped at 1 MiB.
 * - `actions.perform` maps each action to its fine-grained capability
 *   (clipboard.read / clipboard.write / notifications.show / files.pick) and
 *   gates user-gesture actions on `navigator.userActivation`.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

/** Host-side response body cap for `network.fetch` (rev4 §M2). */
const MAX_FETCH_BODY_BYTES = 1024 * 1024;
/** Inline data-URL cap per picked file (files.pick). */
const MAX_FILE_BYTES = 1024 * 1024;

const JOB_DUE_EVENT = 'plugin.job.due';

const ACTION_CAPABILITY: Record<string, string> = {
  'clipboard.read': 'clipboard.read',
  'clipboard.write': 'clipboard.write',
  'notifications.show': 'notifications.show',
  'files.pick': 'files.pick',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denied(ctx: KernelHostContext, capability: string, reason?: string): KernelError {
  return new KernelError(KernelErrorCode.CAPABILITY_DENIED, {
    details: { capability, ...(reason === undefined ? {} : { reason }) },
  });
}
function requireCapability(ctx: KernelHostContext, capability: string): void {
  if (!ctx.hasCapability(capability)) throw denied(ctx, capability);
}

function failParams(reason: string, extra?: Record<string, unknown>): KernelError {
  return new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { reason, ...extra } });
}

/** Map a pluginJobs REST failure onto a stable kernel error code. */
function mapRestError(status: number, body: unknown): KernelError {
  const code = isPlainRecord(body) && typeof body['code'] === 'string' ? body['code'] : '';
  if (status === 403 || code === 'PLUGIN_PERMISSION_DENIED') {
    return new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { status, code } });
  }
  if (status === 404 || code === 'NOT_FOUND') {
    return new KernelError(KernelErrorCode.NOT_FOUND, { details: { status, code } });
  }
  if (status === 400 || status === 409 || code === 'VALIDATION_FAILED' || code === 'CONFLICT') {
    return new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { status, code } });
  }
  return new KernelError(KernelErrorCode.INTERNAL, { details: { status, code } });
}

async function jobsRest(
  ctx: KernelHostContext,
  path: string,
  init?: { method: string; body?: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/v2/plugins/${encodeURIComponent(ctx.pluginId)}${path}`, {
    method: init?.method ?? 'GET',
    // An empty body with `content-type: application/json` is a Fastify 400
    // (FST_ERR_CTP_EMPTY_JSON_BODY) — the header only travels with a body.
    ...(init?.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: init.body }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw mapRestError(response.status, body);
  return isPlainRecord(body) ? body : {};
}

function readActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } })
    .userActivation;
  return activation?.isActive === true;
}

async function performClipboardRead(ctx: KernelHostContext): Promise<{ text: string }> {
  if (!readActivation()) throw denied(ctx, 'clipboard.read', 'user-activation-required');
  const clipboard = navigator.clipboard;
  if (!clipboard) {
    throw new KernelError(KernelErrorCode.INTERNAL, {
      details: { reason: 'clipboard-unavailable' },
    });
  }
  return { text: await clipboard.readText() };
}

async function performClipboardWrite(
  ctx: KernelHostContext,
  params: Record<string, unknown>,
): Promise<Record<string, never>> {
  if (typeof params['text'] !== 'string') throw failParams('text-required');
  if (!readActivation()) throw denied(ctx, 'clipboard.write', 'user-activation-required');
  const clipboard = navigator.clipboard;
  if (!clipboard) {
    throw new KernelError(KernelErrorCode.INTERNAL, {
      details: { reason: 'clipboard-unavailable' },
    });
  }
  await clipboard.writeText(params['text']);
  return {};
}

async function performNotification(
  ctx: KernelHostContext,
  params: Record<string, unknown>,
): Promise<{ shown: boolean }> {
  if (typeof params['title'] !== 'string') throw failParams('title-required');
  if (typeof Notification === 'undefined') {
    throw new KernelError(KernelErrorCode.INTERNAL, {
      details: { reason: 'notifications-unavailable' },
    });
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw denied(ctx, 'notifications.show', 'notification-permission-denied');
  }
  const body = typeof params['body'] === 'string' ? params['body'] : undefined;
  new Notification(params['title'], body === undefined ? undefined : { body });
  return { shown: true };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('file-read-failed'));
    reader.readAsDataURL(file);
  });
}

async function performFilesPick(
  ctx: KernelHostContext,
  params: Record<string, unknown>,
): Promise<{ files: Array<{ name: string; size: number; type: string; dataUrl: string }> }> {
  if (!readActivation()) throw denied(ctx, 'files.pick', 'user-activation-required');
  const input = document.createElement('input');
  input.type = 'file';
  input.style.display = 'none';
  if (typeof params['accept'] === 'string') input.accept = params['accept'];
  if (params['multiple'] === true) input.multiple = true;
  document.body.append(input);
  try {
    const files = await new Promise<File[]>((resolve, reject) => {
      const onChange = (): void => resolve([...(input.files ?? [])]);
      const onCancel = (): void =>
        reject(
          new KernelError(KernelErrorCode.OPERATION_ABORTED, {
            details: { reason: 'picker-cancelled' },
          }),
        );
      input.addEventListener('change', onChange, { once: true });
      input.addEventListener('cancel', onCancel, { once: true });
      input.click();
    });
    const picked: Array<{ name: string; size: number; type: string; dataUrl: string }> = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
          details: { limit: 'files.pick.maxBytes', size: file.size },
        });
      }
      picked.push({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: await fileToDataUrl(file),
      });
    }
    return { files: picked };
  } finally {
    input.remove();
  }
}

async function performNetworkFetch(
  ctx: KernelHostContext,
  params: Record<string, unknown>,
): Promise<{ status: number; headers: Record<string, string>; bodyText: string }> {
  if (typeof params['url'] !== 'string') throw failParams('url-required');
  let parsed: URL;
  try {
    parsed = new URL(params['url']);
  } catch {
    throw failParams('url-invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw failParams('url-scheme-unsupported', { protocol: parsed.protocol });
  }
  const origin = parsed.origin;
  if (
    !ctx.hasCapability('network.domains', { kind: 'all' }) &&
    !ctx.hasCapability('network.domains', { kind: 'origins', origins: [origin] })
  ) {
    throw denied(ctx, 'network.domains');
  }
  if (typeof params['connectionId'] === 'string') {
    // Authenticated call: the token lives server-side, so the request must
    // go through the auth/fetch proxy (rev4 §K5), never straight from the
    // browser where the Authorization header would leak to the sandbox.
    if (!ctx.hasCapability('auth.connections')) throw denied(ctx, 'auth.connections');
    const response = await fetch(`/api/v2/plugins/${encodeURIComponent(ctx.pluginId)}/auth/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: params['url'],
        connectionId: params['connectionId'],
        ...(typeof params['method'] === 'string' ? { method: params['method'] } : {}),
        ...(isPlainRecord(params['headers'])
          ? {
              headers: Object.fromEntries(
                Object.entries(params['headers']).filter(([, v]) => typeof v === 'string'),
              ),
            }
          : {}),
        ...(typeof params['bodyText'] === 'string' ? { bodyText: params['bodyText'] } : {}),
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw mapRestError(response.status, body);
    if (!isPlainRecord(body)) throw new KernelError(KernelErrorCode.INTERNAL, {});
    return {
      status: typeof body['status'] === 'number' ? body['status'] : 0,
      headers: isPlainRecord(body['headers']) ? (body['headers'] as Record<string, string>) : {},
      bodyText: typeof body['bodyText'] === 'string' ? body['bodyText'] : '',
    };
  }
  const method = typeof params['method'] === 'string' ? params['method'] : 'GET';
  const headers: Record<string, string> = {};
  if (isPlainRecord(params['headers'])) {
    for (const [key, value] of Object.entries(params['headers'])) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  let body: string | undefined;
  if (typeof params['bodyText'] === 'string') {
    body = params['bodyText'];
    if (new TextEncoder().encode(body).byteLength > MAX_FETCH_BODY_BYTES) {
      throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        details: { limit: 'network.fetch.maxBodyBytes' },
      });
    }
  }
  const response = await fetch(params['url'], {
    method,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  });
  const bodyText = await response.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_FETCH_BODY_BYTES) {
    throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
      details: { limit: 'network.fetch.maxBodyBytes' },
    });
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return { status: response.status, headers: responseHeaders, bodyText };
}

export function attachJobs(ctx: KernelHostContext): void {
  const { session } = ctx;

  session.handle('jobs.schedule', async (request) => {
    requireCapability(ctx, 'jobs.background');
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['name'] !== 'string') {
      throw failParams('name-required');
    }
    if (
      params['runAt'] === undefined &&
      params['intervalMs'] === undefined &&
      params['cron'] === undefined
    ) {
      throw failParams('schedule-required');
    }
    const modeCount =
      (params['runAt'] === undefined ? 0 : 1) +
      (params['intervalMs'] === undefined ? 0 : 1) +
      (params['cron'] === undefined ? 0 : 1);
    if (modeCount > 1) throw failParams('schedule-exclusive');
    const record = await jobsRest(ctx, '/jobs', {
      method: 'POST',
      body: JSON.stringify({
        name: params['name'],
        ...(typeof params['runAt'] === 'number' ? { runAt: params['runAt'] } : {}),
        ...(typeof params['intervalMs'] === 'number' ? { intervalMs: params['intervalMs'] } : {}),
        ...(typeof params['cron'] === 'string' ? { cron: params['cron'] } : {}),
        ...(params['payload'] === undefined ? {} : { payload: params['payload'] }),
        ...(typeof params['retries'] === 'number' ? { retries: params['retries'] } : {}),
        ...(typeof params['retryDelayMs'] === 'number'
          ? { retryDelayMs: params['retryDelayMs'] }
          : {}),
      }),
    });
    return { jobId: record['jobId'] };
  });

  session.handle('jobs.ack', async (request) => {
    requireCapability(ctx, 'jobs.background');
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['jobId'] !== 'string') {
      throw failParams('jobId-required');
    }
    if (typeof params['ok'] !== 'boolean') throw failParams('ok-required');
    const outcome = await jobsRest(ctx, `/jobs/${encodeURIComponent(params['jobId'])}/ack`, {
      method: 'POST',
      body: JSON.stringify({
        ok: params['ok'],
        ...(typeof params['error'] === 'string' ? { error: params['error'] } : {}),
      }),
    });
    return { acknowledged: outcome['acknowledged'] === true };
  });

  session.handle('jobs.retry', async (request) => {
    requireCapability(ctx, 'jobs.background');
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['jobId'] !== 'string') {
      throw failParams('jobId-required');
    }
    return jobsRest(ctx, `/jobs/${encodeURIComponent(params['jobId'])}/retry`, {
      method: 'POST',
    });
  });

  session.handle('jobs.cancel', async (request) => {
    requireCapability(ctx, 'jobs.background');
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['jobId'] !== 'string') {
      throw failParams('jobId-required');
    }
    await jobsRest(ctx, `/jobs/${encodeURIComponent(params['jobId'])}/cancel`, { method: 'POST' });
    return {};
  });

  session.handle('jobs.list', async () => {
    requireCapability(ctx, 'jobs.background');
    return jobsRest(ctx, '/jobs');
  });

  // Due-job relay: SSE app event -> live sandbox `jobs.run` RPC.
  const unsubscribeDue = ctx.runtime.onAppEvent(JOB_DUE_EVENT, (payload) => {
    if (!isPlainRecord(payload) || payload['pluginId'] !== ctx.pluginId) return;
    if (!ctx.hasCapability('jobs.background')) return;
    void session
      .call('jobs.run', {
        jobId: payload['jobId'],
        name: payload['name'],
        ...(payload['payload'] === undefined ? {} : { payload: payload['payload'] }),
      })
      .catch(() => {
        // Sandbox without a jobs.run handler (or mid-reload) simply misses
        // the dispatch; the persisted record already advanced server-side.
      });
  });
  session.scope.track({ dispose: unsubscribeDue });

  session.handle('network.fetch', async (request) => {
    const params = request.params;
    if (!isPlainRecord(params)) throw failParams('params-required');
    return performNetworkFetch(ctx, params);
  });

  session.handle('actions.perform', async (request) => {
    const params = request.params;
    if (!isPlainRecord(params) || typeof params['action'] !== 'string') {
      throw failParams('action-required');
    }
    const action = params['action'];
    const capability = ACTION_CAPABILITY[action];
    if (capability === undefined) throw failParams('unknown-action', { action });
    requireCapability(ctx, capability);
    const actionParams = isPlainRecord(params['params']) ? params['params'] : {};
    switch (action) {
      case 'clipboard.read':
        return performClipboardRead(ctx);
      case 'clipboard.write':
        return performClipboardWrite(ctx, actionParams);
      case 'notifications.show':
        return performNotification(ctx, actionParams);
      case 'files.pick':
        return performFilesPick(ctx, actionParams);
      default:
        throw failParams('unknown-action', { action });
    }
  });
}
