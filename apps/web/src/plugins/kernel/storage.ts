/**
 * Rev4 kernel: storage.kv + storage.blobs host handlers (contract §2).
 *
 * KV state lives server-side (one JSON object per (plugin, scope, ownerId),
 * CAS revision). Two planes, one sandbox contract:
 *
 * - kernel plane: `plugins.state.get|set|delete` (M7 cluster 21 part 1) via
 *   the Product Wire facade, so the sandbox is served by the canonical store;
 * - legacy plane: the legacy plugin state route (see stateUrl).
 *
 * Blobs stay on the legacy plane on both (the legacy blob route below): the
 * wire has no binary body in v1, so that route is a documented transport
 * boundary rather than a half-modelled op.
 *
 * The host enforces capabilities before every call and translates backend
 * failures back into KernelErrors so the sandbox only ever sees wire codes.
 */
import { ProductError } from '@neotavern/client-sdk';
import { isKernelMode } from '../../api/backend.js';
import {
  deletePluginBlob,
  listPluginBlobs,
  readPluginBlobRange,
  readPluginState,
  stagePluginBlob,
  writePluginState,
} from '../../api/wireBridge.js';
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

type KvScope = 'installation' | 'user' | 'workspace' | 'chat';
/** Static scope-name lookup table (rev4 §2 storage.kv). */
const KV_SCOPES: Record<string, true> = {
  installation: true,
  user: true,
  workspace: true,
  chat: true,
};

/** rev4 storage limit mirrored host-side (matches the server blob store). */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Chunk size for host→plugin blob streams (well under any credit window). */
const STREAM_CHUNK_BYTES = 256 * 1024;
/** Chunk size for kernel→host blob ranges (the wire cap for one read). */
const BLOB_READ_BYTES = 256 * 1024;

interface StateBody {
  data: Record<string, unknown>;
  revision: number;
}

function fail(code: string, details?: Record<string, unknown>): KernelError {
  return new KernelError(code, { details });
}

function stringParam(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw fail(KernelErrorCode.VALIDATION_FAILED, { field });
  }
  return value;
}

function scopeParam(params: Record<string, unknown>): KvScope {
  const scope = stringParam(params, 'scope');
  if (!(scope in KV_SCOPES)) {
    throw fail(KernelErrorCode.VALIDATION_FAILED, { field: 'scope', scope });
  }
  return scope as KvScope;
}

/**
 * Scope → ownerId per contract §2. The chat scope needs an open chat; the
 * host answers NOT_FOUND when none is focused.
 */
function ownerIdForScope(ctx: KernelHostContext, scope: KvScope): string | null {
  if (scope === 'installation' || scope === 'user') return null;
  if (scope === 'workspace') return 'workspace';
  const chatId = ctx.currentChatId();
  if (!chatId) throw fail(KernelErrorCode.NOT_FOUND, { reason: 'no-current-chat' });
  return chatId;
}

function requireCapability(ctx: KernelHostContext, name: string): void {
  if (!ctx.hasCapability(name)) {
    throw fail(KernelErrorCode.CAPABILITY_DENIED, { capability: name });
  }
}

/** Map the server error envelope onto kernel wire codes. */
function kernelErrorFromStatus(status: number, code: string, params: unknown): KernelError {
  const details = { httpStatus: status, code, params };
  switch (code) {
    case 'CONFLICT':
      return fail(KernelErrorCode.REVISION_CONFLICT, details);
    case 'PLUGIN_PERMISSION_DENIED':
    case 'FORBIDDEN':
      return fail(KernelErrorCode.CAPABILITY_DENIED, details);
    case 'NOT_FOUND':
    case 'PLUGIN_NOT_FOUND':
    case 'FILE_NOT_FOUND':
      return fail(KernelErrorCode.NOT_FOUND, details);
    case 'FILE_TOO_LARGE':
      return fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, details);
    case 'VALIDATION':
    case 'BAD_REQUEST':
      return fail(KernelErrorCode.VALIDATION_FAILED, details);
    default:
      return fail(KernelErrorCode.INTERNAL, details);
  }
}

async function parseError(res: Response): Promise<KernelError> {
  let code = 'INTERNAL';
  let params: unknown = null;
  try {
    const body = (await res.json()) as { code?: unknown; params?: unknown };
    if (typeof body.code === 'string') code = body.code;
    params = body.params ?? null;
  } catch {
    // Non-JSON error body: fall back to the status alone.
  }
  return kernelErrorFromStatus(res.status, code, params);
}

function stateUrl(pluginId: string, scope: KvScope, ownerId: string | null): string {
  const query = new URLSearchParams({ scope });
  if (ownerId !== null) query.set('ownerId', ownerId);
  return `/api/v2/plugins/${encodeURIComponent(pluginId)}/state?${query.toString()}`;
}

/** Map a kernel-plane product error onto the sandbox's kernel codes. */
function kernelErrorFromProduct(error: ProductError): KernelError {
  const details = { code: error.code, params: error.params };
  switch (error.code) {
    case 'REVISION_CONFLICT':
      return fail(KernelErrorCode.REVISION_CONFLICT, details);
    case 'PLUGIN_PERMISSION_DENIED':
      return fail(KernelErrorCode.CAPABILITY_DENIED, details);
    case 'PLUGIN_STATE_NOT_FOUND':
    case 'PLUGIN_NOT_FOUND':
      return fail(KernelErrorCode.NOT_FOUND, details);
    case 'STATE_QUOTA_EXCEEDED':
      return fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, details);
    case 'VALIDATION':
      return fail(KernelErrorCode.VALIDATION_FAILED, details);
    default:
      return fail(KernelErrorCode.INTERNAL, details);
  }
}

/** GET state; `null` when the store is empty (404 / PLUGIN_STATE_NOT_FOUND). */
async function fetchState(
  ctx: KernelHostContext,
  scope: KvScope,
  ownerId: string | null,
): Promise<StateBody | null> {
  if (isKernelMode()) {
    const address =
      ownerId === null
        ? { pluginId: ctx.pluginId, scope }
        : { pluginId: ctx.pluginId, scope, ownerId };
    try {
      const state = await readPluginState(address);
      return state ? { data: state.data, revision: state.revision } : null;
    } catch (error) {
      if (error instanceof ProductError) throw kernelErrorFromProduct(error);
      throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
    }
  }
  const res = await fetch(stateUrl(ctx.pluginId, scope, ownerId));
  if (res.status === 404) return null;
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as StateBody;
  return { data: body.data ?? {}, revision: body.revision ?? 0 };
}

async function putState(
  ctx: KernelHostContext,
  scope: KvScope,
  ownerId: string | null,
  data: Record<string, unknown>,
  expectedRevision: number | undefined,
): Promise<{ revision: number }> {
  if (isKernelMode()) {
    try {
      const result = await writePluginState({
        pluginId: ctx.pluginId,
        scope,
        ...(ownerId === null ? {} : { ownerId }),
        data,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return { revision: result.revision };
    } catch (error) {
      if (error instanceof ProductError) throw kernelErrorFromProduct(error);
      throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
    }
  }
  const res = await fetch(stateUrl(ctx.pluginId, scope, ownerId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expectedRevision === undefined ? { data } : { data, expectedRevision }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as { revision: number };
}

function toBytes(source: ArrayBuffer | Uint8Array): Uint8Array {
  return source instanceof Uint8Array ? source : new Uint8Array(source);
}

export function attachStorage(ctx: KernelHostContext): void {
  // ── storage.kv ────────────────────────────────────────────────────────────
  ctx.session.handle('storage.kv.get', async (request) => {
    const params = request.params as Record<string, unknown>;
    const scope = scopeParam(params);
    const key = stringParam(params, 'key');
    requireCapability(ctx, `storage.${scope}`);
    const ownerId = ownerIdForScope(ctx, scope);
    const state = await fetchState(ctx, scope, ownerId);
    return { value: state?.data[key] ?? null, revision: state?.revision ?? 0 };
  });

  ctx.session.handle('storage.kv.set', async (request) => {
    const params = request.params as Record<string, unknown>;
    const scope = scopeParam(params);
    const key = stringParam(params, 'key');
    requireCapability(ctx, `storage.${scope}`);
    const ownerId = ownerIdForScope(ctx, scope);
    const current = await fetchState(ctx, scope, ownerId);
    // Read-modify-write: one CAS row per (plugin, scope, ownerId), so merge
    // locally and guard the whole object with the observed (or caller-given)
    // revision. A concurrent writer flips the CAS and we surface
    // REVISION_CONFLICT.
    const expectedRevision =
      typeof params.expectedRevision === 'number'
        ? params.expectedRevision
        : (current?.revision ?? 0);
    const data = { ...(current?.data ?? {}), [key]: params.value };
    const result = await putState(ctx, scope, ownerId, data, expectedRevision);
    return { revision: result.revision };
  });

  ctx.session.handle('storage.kv.delete', async (request) => {
    const params = request.params as Record<string, unknown>;
    const scope = scopeParam(params);
    const key = stringParam(params, 'key');
    requireCapability(ctx, `storage.${scope}`);
    const ownerId = ownerIdForScope(ctx, scope);
    const current = await fetchState(ctx, scope, ownerId);
    if (!current || !(key in current.data)) {
      return { deleted: false, revision: current?.revision ?? 0 };
    }
    const data = { ...current.data };
    delete data[key];
    const result = await putState(ctx, scope, ownerId, data, current.revision);
    return { deleted: true, revision: result.revision };
  });

  ctx.session.handle('storage.kv.list', async (request) => {
    const params = request.params as Record<string, unknown>;
    const scope = scopeParam(params);
    requireCapability(ctx, `storage.${scope}`);
    const ownerId = ownerIdForScope(ctx, scope);
    const state = await fetchState(ctx, scope, ownerId);
    return { keys: state ? Object.keys(state.data) : [], revision: state?.revision ?? 0 };
  });

  // ── storage.blobs ─────────────────────────────────────────────────────────
  //
  // Kernel plane: the chunked `plugins.blobs` family (M7 cluster 21a) — bytes
  // are staged, hashed and published by the kernel under the plugin's own
  // namespace, then served back as bounded ranges. Legacy plane: the legacy
  // blob route, unchanged, while the sidecar owns the feature.
  const blobsUrl = `/api/v2/plugins/${encodeURIComponent(ctx.pluginId)}/blobs`;

  ctx.session.handle('storage.blobs.put', async (request) => {
    const params = request.params as Record<string, unknown>;
    const streamId = stringParam(params, 'streamId');
    const name = stringParam(params, 'name');
    const contentType = stringParam(params, 'contentType');
    requireCapability(ctx, 'storage.blobs');

    const inbound = ctx.session.getInboundStream(streamId);
    if (!inbound) {
      throw fail(KernelErrorCode.STREAM_FAILED, { streamId });
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await inbound.pull();
      if (chunk === null) break;
      total += chunk.byteLength;
      if (total > MAX_BLOB_BYTES) {
        throw fail(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
          limit: 'storage.maxBlobFileBytes',
          max: MAX_BLOB_BYTES,
        });
      }
      parts.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }

    if (isKernelMode()) {
      try {
        const stored = await stagePluginBlob({
          pluginId: ctx.pluginId,
          name,
          contentType,
          bytes,
        });
        return { blobId: stored.blobId, hash: stored.hash, size: stored.sizeBytes };
      } catch (error) {
        if (error instanceof ProductError) throw kernelErrorFromProduct(error);
        throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
      }
    }

    const query = new URLSearchParams({ name, contentType });
    const res = await fetch(`${blobsUrl}?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { blobId: string; hash: string; size: number };
    return { blobId: body.blobId, hash: body.hash, size: body.size };
  });

  ctx.session.handle('storage.blobs.get', async (request) => {
    const params = request.params as Record<string, unknown>;
    const blobId = stringParam(params, 'blobId');
    requireCapability(ctx, 'storage.blobs');

    let chunks: Uint8Array[];
    let contentType: string;
    let size: number;
    if (isKernelMode()) {
      const collected: Uint8Array[] = [];
      let offset = 0;
      let eof = false;
      contentType = 'application/octet-stream';
      size = 0;
      while (!eof) {
        let range;
        try {
          range = await readPluginBlobRange({
            pluginId: ctx.pluginId,
            blobId,
            offset,
            length: BLOB_READ_BYTES,
          });
        } catch (error) {
          if (error instanceof ProductError) throw kernelErrorFromProduct(error);
          throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
        }
        contentType = range.contentType;
        size = range.sizeBytes;
        const slice = bytesFromBase64(range.dataBase64);
        // No progress + no eof can only mean a corrupt store: refuse instead
        // of spinning forever in the sandbox's read loop.
        if (slice.byteLength === 0 && !range.eof) {
          throw fail(KernelErrorCode.INTERNAL, { reason: 'blob-read-stalled', blobId });
        }
        if (slice.byteLength > 0) collected.push(slice);
        offset += slice.byteLength;
        eof = range.eof;
      }
      chunks = collected;
    } else {
      const res = await fetch(`${blobsUrl}/${encodeURIComponent(blobId)}`);
      if (!res.ok) throw await parseError(res);
      chunks = [toBytes(await res.arrayBuffer())];
      contentType = res.headers.get('Content-Type') ?? 'application/octet-stream';
      size = chunks[0]?.byteLength ?? 0;
    }

    const outbound = ctx.session.openOutboundStream({
      kind: 'blobs.get',
      blobId,
      contentType,
      size,
    });
    try {
      for (const chunk of chunks) {
        for (let offset = 0; offset < chunk.byteLength; offset += STREAM_CHUNK_BYTES) {
          await outbound.write(chunk.subarray(offset, offset + STREAM_CHUNK_BYTES));
        }
      }
      outbound.end();
    } catch (error) {
      outbound.fail(error);
      throw error;
    }
    return { streamId: outbound.streamId, contentType, size };
  });

  ctx.session.handle('storage.blobs.list', async () => {
    requireCapability(ctx, 'storage.blobs');
    if (isKernelMode()) {
      try {
        const page = await listPluginBlobs({ pluginId: ctx.pluginId });
        return {
          items: page.items.map((item) => ({
            blobId: item.blobId,
            hash: item.hash,
            size: item.sizeBytes,
            name: item.name,
            contentType: item.contentType,
            createdAt: Date.parse(item.createdAt),
          })),
        };
      } catch (error) {
        if (error instanceof ProductError) throw kernelErrorFromProduct(error);
        throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
      }
    }
    const res = await fetch(blobsUrl);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as { items: unknown[] };
  });

  ctx.session.handle('storage.blobs.delete', async (request) => {
    const params = request.params as Record<string, unknown>;
    const blobId = stringParam(params, 'blobId');
    requireCapability(ctx, 'storage.blobs');
    if (isKernelMode()) {
      try {
        const result = await deletePluginBlob({ pluginId: ctx.pluginId, blobId });
        return { deleted: result.deleted };
      } catch (error) {
        if (error instanceof ProductError) throw kernelErrorFromProduct(error);
        throw fail(KernelErrorCode.INTERNAL, { message: String(error) });
      }
    }
    const res = await fetch(`${blobsUrl}/${encodeURIComponent(blobId)}`, { method: 'DELETE' });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as { deleted: boolean };
  });
}

/** Raw bytes of one base64 wire range. */
function bytesFromBase64(data: string): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
