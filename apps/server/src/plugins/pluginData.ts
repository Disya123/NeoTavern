/**
 * Rev4 plugin data routes (contract §4): CAS-guarded KV state and
 * content-addressed blob storage, gated by the capability broker.
 *
 * Capability mapping (contract §2): the state scope selects the capability —
 * storage.installation | storage.user | storage.workspace | storage.chat —
 * and every blob route needs storage.blobs. Every route first verifies the
 * plugin exists in the registry, then asks the broker.
 */
import { Type } from '@sinclair/typebox';
import { kernel } from '@neotavern/plugin-sdk';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { PluginStateScope } from '@neotavern/db';
import type { CapabilityBroker } from '../plugin/capabilityBroker.js';
import { MAX_BLOB_BYTES, PluginBlobStore, type BlobMeta } from '../plugin/blobStore.js';
import type { AppContext, TypedApp } from '../types.js';

const StateScopeSchema = Type.Union([
  Type.Literal('installation'),
  Type.Literal('user'),
  Type.Literal('workspace'),
  Type.Literal('chat'),
]);

const BlobItemSchema = Type.Object({
  blobId: Type.String(),
  hash: Type.String(),
  name: Type.String(),
  contentType: Type.String(),
  size: Type.Number(),
  createdAt: Type.Number(),
});

function blobItem(meta: BlobMeta) {
  return {
    blobId: meta.blobId,
    hash: meta.hash,
    name: meta.name,
    contentType: meta.contentType,
    size: meta.size,
    createdAt: meta.createdAt,
  };
}

/**
 * Resolve the ownerId for a scope (contract §2 web-host mapping):
 * installation/user → null, workspace → 'workspace' (query override allowed),
 * chat → the explicit ownerId (required; the caller names the chat).
 */
function ownerIdForScope(scope: PluginStateScope, ownerId: string | undefined): string | null {
  if (scope === 'installation' || scope === 'user') return null;
  if (scope === 'workspace') return ownerId ?? 'workspace';
  if (!ownerId) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'OWNER_ID_REQUIRED', scope },
    });
  }
  return ownerId;
}

export async function registerPluginDataRoutes(
  app: TypedApp,
  ctx: AppContext,
  broker: CapabilityBroker,
): Promise<void> {
  const plugins = ctx.database.repos.plugins;
  const state = ctx.database.repos.pluginState;
  const blobs = new PluginBlobStore(ctx.paths.pluginBlobs);

  function requirePlugin(pluginId: string): void {
    if (!plugins.getById(pluginId)) {
      throw new AppError({ code: ErrorCodes.PLUGIN_NOT_FOUND, params: { pluginId } });
    }
  }

  function requireAccess(pluginId: string, scope: PluginStateScope): void {
    requirePlugin(pluginId);
    const capability = `storage.${scope}`;
    if (!broker.check(pluginId, { name: capability })) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
        params: { pluginId, capability },
      });
    }
  }

  function requireBlobAccess(pluginId: string): void {
    requirePlugin(pluginId);
    if (!broker.check(pluginId, { name: 'storage.blobs' })) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
        params: { pluginId, capability: 'storage.blobs' },
      });
    }
  }

  const stateParams = Type.Object({ id: Type.String() });
  const stateQuery = Type.Object({
    scope: StateScopeSchema,
    ownerId: Type.Optional(Type.String()),
  });

  app.get(
    '/api/v2/plugins/:id/state',
    {
      schema: {
        params: stateParams,
        querystring: stateQuery,
        response: {
          200: Type.Object({
            scope: StateScopeSchema,
            ownerId: Type.Union([Type.String(), Type.Null()]),
            revision: Type.Number(),
            schemaVersion: Type.Number(),
            data: Type.Record(Type.String(), Type.Unknown()),
            updatedAt: Type.Number(),
          }),
        },
      },
    },
    async (request) => {
      const scope = request.query.scope as PluginStateScope;
      const ownerId = ownerIdForScope(scope, request.query.ownerId);
      requireAccess(request.params.id, scope);
      const entry = state.get(request.params.id, scope, ownerId);
      if (!entry) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { pluginId: request.params.id, scope },
        });
      }
      return {
        scope: entry.scope,
        ownerId: entry.ownerId,
        revision: entry.revision,
        schemaVersion: entry.schemaVersion,
        data: entry.data,
        updatedAt: entry.updatedAt,
      };
    },
  );

  app.put(
    '/api/v2/plugins/:id/state',
    {
      schema: {
        params: stateParams,
        querystring: stateQuery,
        body: Type.Object({
          data: Type.Record(Type.String(), Type.Unknown()),
          expectedRevision: Type.Optional(Type.Number()),
        }),
        response: { 200: Type.Object({ revision: Type.Number() }) },
      },
    },
    async (request) => {
      const scope = request.query.scope as PluginStateScope;
      const ownerId = ownerIdForScope(scope, request.query.ownerId);
      requireAccess(request.params.id, scope);
      // ТЗ §54 namespaced-state quota (DEFAULT_PLUGIN_LIMITS.storage): keys =
      // top-level JSON keys of `data`, bytes = UTF-8 length of the serialized
      // data. Existing rows are unaffected — the quota applies on the next
      // write only.
      const { kvBytes, kvKeys } = kernel.DEFAULT_PLUGIN_LIMITS.storage;
      const keys = Object.keys(request.body.data);
      const bytes = Buffer.byteLength(JSON.stringify(request.body.data), 'utf8');
      if (keys.length > kvKeys || bytes > kvBytes) {
        throw new AppError({
          code: ErrorCodes.STATE_QUOTA_EXCEEDED,
          params: { limitKeys: kvKeys, limitBytes: kvBytes, keys: keys.length, bytes },
        });
      }
      const result = state.set({
        pluginId: request.params.id,
        scope,
        ownerId,
        data: request.body.data,
        ...(request.body.expectedRevision === undefined
          ? {}
          : { expectedRevision: request.body.expectedRevision }),
      });
      if (!result.ok) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: {
            expectedRevision: request.body.expectedRevision,
            revision: result.current?.revision ?? null,
          },
        });
      }
      return { revision: result.entry.revision };
    },
  );

  app.delete(
    '/api/v2/plugins/:id/state',
    {
      schema: {
        params: stateParams,
        querystring: stateQuery,
        response: { 200: Type.Object({ deleted: Type.Boolean() }) },
      },
    },
    async (request) => {
      const scope = request.query.scope as PluginStateScope;
      const ownerId = ownerIdForScope(scope, request.query.ownerId);
      requireAccess(request.params.id, scope);
      return { deleted: state.delete(request.params.id, scope, ownerId) };
    },
  );

  const blobParams = Type.Object({ id: Type.String(), blobId: Type.String() });

  app.get(
    '/api/v2/plugins/:id/blobs',
    {
      schema: {
        params: stateParams,
        response: { 200: Type.Object({ items: Type.Array(BlobItemSchema) }) },
      },
    },
    async (request) => {
      requireBlobAccess(request.params.id);
      const items = await blobs.list(request.params.id);
      return { items: items.map(blobItem) };
    },
  );

  // Blob upload accepts a RAW body: the blob's own content type arrives in the
  // content-type header (or the contentType query override) and must not be
  // parsed as JSON/text. The encapsulated scope overrides content-type
  // parsers for this route only; the app-wide JSON routes keep their parsers.
  await app.register(async (scope: TypedApp) => {
    const rawBody = (
      _request: unknown,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ): void => {
      done(null, body);
    };
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BLOB_BYTES }, rawBody);
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MAX_BLOB_BYTES },
      rawBody,
    );
    scope.addContentTypeParser(
      'text/plain',
      { parseAs: 'buffer', bodyLimit: MAX_BLOB_BYTES },
      rawBody,
    );

    scope.post(
      '/api/v2/plugins/:id/blobs',
      {
        schema: {
          params: stateParams,
          querystring: Type.Object({
            name: Type.Optional(Type.String()),
            contentType: Type.Optional(Type.String()),
          }),
          response: {
            200: Type.Object({
              blobId: Type.String(),
              hash: Type.String(),
              size: Type.Number(),
            }),
          },
        },
      },
      async (request) => {
        requireBlobAccess(request.params.id);
        const body = request.body;
        const bytes = body instanceof Buffer ? new Uint8Array(body) : new Uint8Array(0);
        const headerType = request.headers['content-type'];
        const contentType =
          request.query.contentType ??
          (typeof headerType === 'string' && headerType.length > 0
            ? headerType.split(';')[0]!.trim() || 'application/octet-stream'
            : 'application/octet-stream');
        const meta = await blobs.put(
          request.params.id,
          bytes,
          request.query.name ?? 'blob',
          contentType,
        );
        return { blobId: meta.blobId, hash: meta.hash, size: meta.size };
      },
    );
  });

  app.get(
    '/api/v2/plugins/:id/blobs/:blobId',
    { schema: { params: blobParams } },
    async (request, reply) => {
      requireBlobAccess(request.params.id);
      const found = await blobs.getStream(request.params.id, request.params.blobId);
      if (!found) {
        throw new AppError({
          code: ErrorCodes.FILE_NOT_FOUND,
          params: { pluginId: request.params.id, blobId: request.params.blobId },
        });
      }
      reply.header('Content-Type', found.meta.contentType);
      reply.header('Content-Length', String(found.meta.size));
      return found.stream;
    },
  );

  app.delete(
    '/api/v2/plugins/:id/blobs/:blobId',
    {
      schema: {
        params: blobParams,
        response: { 200: Type.Object({ deleted: Type.Boolean() }) },
      },
    },
    async (request) => {
      requireBlobAccess(request.params.id);
      return { deleted: await blobs.delete(request.params.id, request.params.blobId) };
    },
  );
}
