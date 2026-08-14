/**
 * Legacy server plugin compatibility host (AGENTS.md §18 / ТЗ §8.3). Old
 * SillyTavern server plugins export `init(router)` / `exit()` / `info` and
 * expect an Express router. We honor that contract here — and ONLY here —
 * using @fastify/express, proxying routes under /api/plugins/{id}/. The new
 * core never uses Express.
 */
import fastifyExpress from '@fastify/express';
import express, { Router, type Application, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Type } from '@sinclair/typebox';
import {
  LegacyExtensionNamespaceSchema,
  LegacyExtensionSettingsResponseSchema,
  LegacyExtensionSettingsUpdateSchema,
} from '@neotavern/contracts';
import { AppError, ErrorCodes, createLogger } from '@neotavern/shared';
import type { PluginManifest } from '@neotavern/plugin-sdk';
import { validatePackageEntryPath } from '../lib/packageArchive.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext, TypedApp } from '../types.js';

const LEGACY_SETTINGS_KEY = 'legacy.extension-settings';
const MAX_LEGACY_SETTINGS_BYTES = 1024 * 1024;
const legacyRouters = new WeakMap<
  TypedApp,
  Map<string, { application: Application; plugin: LegacyServerPluginContract }>
>();

/** An Express router instance handed to legacy plugins. */
export type LegacyRouter = ReturnType<typeof Router>;

/** The documented legacy server-plugin contract. */
export interface LegacyServerPluginContract {
  info: { id: string; name: string; version?: string };
  init(router: LegacyRouter): void;
  exit?(): void;
}

/** Register the Express compatibility layer onto the Fastify instance. */
export async function registerLegacyHost(app: TypedApp, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v2/legacy/extension-settings',
    { schema: { response: { 200: LegacyExtensionSettingsResponseSchema } } },
    async () => {
      const rows = ctx.database.sqlite
        .prepare(
          `SELECT plugin_id, value
             FROM plugin_storage
            WHERE key = ?
            ORDER BY plugin_id`,
        )
        .all(LEGACY_SETTINGS_KEY) as Array<{ plugin_id: string; value: string }>;
      return {
        items: Object.fromEntries(
          rows.flatMap((row) => {
            try {
              const value: unknown = JSON.parse(row.value) as unknown;
              return isRecord(value) ? [[row.plugin_id, value] as const] : [];
            } catch {
              return [];
            }
          }),
        ),
      };
    },
  );

  app.patch(
    '/api/v2/legacy/extension-settings/:namespace',
    {
      schema: {
        params: Type.Object({ namespace: LegacyExtensionNamespaceSchema }),
        body: LegacyExtensionSettingsUpdateSchema,
        response: { 200: LegacyExtensionSettingsUpdateSchema },
      },
    },
    async (request) => {
      if (!ctx.database.repos.plugins.getById(request.params.namespace)) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: request.params.namespace },
        });
      }
      const json = JSON.stringify(request.body.settings);
      if (Buffer.byteLength(json) > MAX_LEGACY_SETTINGS_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_LEGACY_SETTINGS_BYTES },
        });
      }
      ctx.database.sqlite
        .prepare(
          `INSERT INTO plugin_storage (plugin_id, key, value)
           VALUES (?, ?, ?)
           ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(request.params.namespace, LEGACY_SETTINGS_KEY, json);
      return { settings: request.body.settings };
    },
  );
  await app.register(fastifyExpress);
  const mounted = new Map<
    string,
    { application: Application; plugin: LegacyServerPluginContract }
  >();
  legacyRouters.set(app, mounted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mount a legacy server plugin. Returns a cleanup function that calls
 * `exit()` and immediately gates off its Express router. The tiny inert
 * middleware wrapper remains until process restart, but no legacy route or
 * handler stays reachable after cleanup.
 */
export function mountLegacyServerPlugin(
  app: TypedApp,
  plugin: LegacyServerPluginContract,
): () => void {
  const mounted = legacyRouters.get(app);
  if (!mounted) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_LOAD_FAILED,
      params: { pluginId: plugin.info.id, reason: 'LEGACY_HOST_NOT_READY' },
    });
  }
  const router = Router();
  plugin.init(router);
  const application = express();
  application.disable('x-powered-by');
  application.use(router);
  const registration = { application, plugin };
  mounted.set(plugin.info.id, registration);
  return () => {
    if (mounted.get(plugin.info.id) !== registration) return;
    mounted.delete(plugin.info.id);
    // A throwing legacy exit() must not escape cleanup: disable/activate
    // sequences and the host registry would desynchronize (PLUG-57). Mirrors
    // the safeRun semantics of the plugin-sdk cleanup helper.
    try {
      plugin.exit?.();
    } catch (error) {
      legacyHostLogger.warn(
        `legacy plugin "${plugin.info.id}" exit() failed during cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

const legacyHostLogger = createLogger({ scope: 'legacy-host' });

/**
 * Lifecycle owner for explicitly trusted legacy backend entries. Unlike v2
 * backend plugins these modules execute in the server process, so activation
 * requires the separately consented `legacy.trusted` permission.
 */
export class LegacyServerPluginHost {
  private readonly cleanups = new Map<string, () => void>();

  constructor(private readonly app: TypedApp) {}

  async activate(
    manifest: PluginManifest,
    packageRoot: string,
    grantedPermissions: readonly string[],
  ): Promise<void> {
    if (!manifest.legacy?.backend) return;
    if (!grantedPermissions.includes('legacy.trusted')) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
        params: { pluginId: manifest.id, permission: 'legacy.trusted' },
      });
    }
    await this.deactivate(manifest.id);
    const entrySegments = validatePackageEntryPath(manifest.legacy.backend);
    // SEC-05 fail-closed (defense in depth): `signature/` is excluded from
    // the publisher digest, so a legacy backend entry there would escape
    // signed verification. `validatePackage` rejects this at install;
    // re-checking here keeps activation safe for pre-rule packages.
    if (entrySegments[0] === 'signature') {
      throw new AppError({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
        params: { pluginId: manifest.id, reason: 'ENTRYPOINT_INSIDE_SIGNATURE' },
      });
    }
    const entryPath = resolve(packageRoot, ...entrySegments);
    let loaded: unknown;
    const inPkgSnapshot = Boolean(
      (process as NodeJS.Process & { pkg?: string }).pkg,
    );
    if (inPkgSnapshot) {
      // pkg's snapshot VM provides no dynamic-import callback; legacy entries are
      // external files, so load them through createRequire (Node 24 require(esm)
      // handles ESM entries; the cache-buster below mirrors the ESM reload path).
      const runtimeRequire = createRequire(import.meta.url);
      const resolvedEntry = runtimeRequire.resolve(entryPath);
      delete runtimeRequire.cache[resolvedEntry];
      loaded = runtimeRequire(resolvedEntry);
    } else {
      loaded = await import(`${pathToFileURL(entryPath).href}?legacy=${Date.now()}`);
    }
    const candidate = isRecord(loaded) && 'default' in loaded ? loaded['default'] : loaded;
    if (!isLegacyServerPlugin(candidate) || candidate.info.id !== manifest.id) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
        params: { pluginId: manifest.id, reason: 'LEGACY_CONTRACT_INVALID' },
      });
    }
    this.cleanups.set(manifest.id, mountLegacyServerPlugin(this.app, candidate));
  }

  async deactivate(pluginId: string): Promise<void> {
    const cleanup = this.cleanups.get(pluginId);
    if (!cleanup) return;
    this.cleanups.delete(pluginId);
    cleanup();
  }

  async close(): Promise<void> {
    for (const pluginId of [...this.cleanups.keys()]) {
      await this.deactivate(pluginId);
    }
  }

  async dispatch(
    pluginId: string,
    routePath: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ handled: boolean; body?: unknown }> {
    const registration = legacyRouters.get(this.app)?.get(pluginId);
    if (!registration) return { handled: false };
    const rawRequest = request.raw as Request;
    const rawResponse = reply.raw as Response;
    const previousUrl = rawRequest.url;
    const previousRequestPrototype = Object.getPrototypeOf(rawRequest);
    const previousResponsePrototype = Object.getPrototypeOf(rawResponse);
    rawRequest.url = `${routePath}${request.url.includes('?') ? `?${request.url.split('?')[1] ?? ''}` : ''}`;
    return new Promise<{ handled: boolean; body?: unknown }>((resolveDispatch, rejectDispatch) => {
      let settled = false;
      const settle = (result: { handled: boolean; body?: unknown }, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rawRequest.url = previousUrl;
        Object.setPrototypeOf(rawRequest, previousRequestPrototype);
        Object.setPrototypeOf(rawResponse, previousResponsePrototype);
        if (error) rejectDispatch(error);
        else resolveDispatch(result);
      };
      const timer = setTimeout(() => {
        settle(
          { handled: false },
          new AppError({
            code: ErrorCodes.TIMEOUT,
            params: { pluginId, timeoutMs: 30_000 },
          }),
        );
      }, 30_000);
      timer.unref();
      const forwardHeaders = (): void => {
        reply.code(rawResponse.statusCode);
        for (const [name, value] of Object.entries(rawResponse.getHeaders())) {
          if (value !== undefined) reply.header(name, value);
        }
      };
      Object.defineProperty(rawResponse, 'send', {
        configurable: true,
        value: (body: unknown) => {
          forwardHeaders();
          settle({ handled: true, body });
          return rawResponse;
        },
      });
      // Handlers that stream with res.write/res.end (incl. SSE-style responses)
      // are buffered and settled on end — previously such handlers never
      // resolved and hung until the 30s timeout (ТЗ §8.3 Express host). Once
      // settled, both methods pass through untouched so Fastify can finish
      // writing the response it owns.
      const chunks: Buffer[] = [];
      const originalWrite = rawResponse.write.bind(rawResponse);
      const originalEnd = rawResponse.end.bind(rawResponse);
      Object.defineProperty(rawResponse, 'write', {
        configurable: true,
        value: (...args: unknown[]) => {
          if (settled) return originalWrite(...(args as [unknown]));
          const chunk = args[0];
          if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
          else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
          return true;
        },
      });
      Object.defineProperty(rawResponse, 'end', {
        configurable: true,
        value: (...args: unknown[]) => {
          if (settled) return originalEnd(...(args as [unknown]));
          const chunk = args[0];
          if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
          else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
          forwardHeaders();
          settle({
            handled: true,
            body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
          });
          return rawResponse;
        },
      });
      try {
        const result = registration.application(rawRequest, rawResponse, (error?: unknown) => {
          settle({ handled: false }, error);
        });
        // Express only routes *synchronous* throws through next(error); an
        // async legacy handler that rejects would otherwise escape as an
        // unhandled rejection. Routers that surface their chain as a returned
        // promise are caught here (ТЗ §8.3 legacy host containment).
        if (result && typeof (result as { catch?: unknown }).catch === 'function') {
          (result as Promise<unknown>).catch((error) => settle({ handled: false }, error));
        }
      } catch (error) {
        settle({ handled: false }, error);
      }
    });
  }
}

function isLegacyServerPlugin(value: unknown): value is LegacyServerPluginContract {
  return (
    isRecord(value) &&
    isRecord(value['info']) &&
    typeof value['info']['id'] === 'string' &&
    typeof value['info']['name'] === 'string' &&
    typeof value['init'] === 'function' &&
    (value['exit'] === undefined || typeof value['exit'] === 'function')
  );
}
