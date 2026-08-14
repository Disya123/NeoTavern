/** Process-isolated backend plugin host with capability-checked IPC. */
import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PluginManifest } from '@neotavern/plugin-sdk';
import type { PluginResourceLimits } from '@neotavern/contracts';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import { validatePackageEntryPath } from '../lib/packageArchive.js';
import { DEPENDENCY_MARKER_FILE } from './dependencyInstaller.js';
import type { ContextShiftResult, PromptMessage } from '../pipeline/contextShift.js';
import type { AppContext, TypedApp } from '../types.js';
import { DEFAULT_RESOURCE_CONFIG } from '../config.js';
import type { LegacyServerPluginHost } from '../legacy/host.js';
import { IsolatedPluginProviderAdapter as PluginProviderAdapter } from './isolatedProviderAdapter.js';
import { RESOURCE_LIMITS_VERSION, type ResourceGovernor } from './resourceGovernor.js';

const ACTIVATION_TIMEOUT_MS = 15_000;
const ROUTE_TIMEOUT_MS = 30_000;
/**
 * Tokenizer callbacks run inside generation for every chat: a broken plugin
 * tokenizer must not stall all generations for the full route timeout, so its
 * callbacks get a tight dedicated deadline (PLUG-56).
 */
const TOKENIZER_CALLBACK_TIMEOUT_MS = 5_000;
const MAX_STORAGE_BYTES = 1024 * 1024;
const MAX_STORAGE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PLUGIN_ROUTES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const MAX_EVENT_SUBSCRIPTIONS = 128;
const MAX_PLUGIN_FETCH_BYTES = 10 * 1024 * 1024;
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;
/**
 * rev4 §D: streamed route bodies (worker→host→HTTP) are capped in total;
 * exceeding the cap tears the stream down instead of buffering further.
 */
const MAX_STREAM_BODY_BYTES = 8 * 1024 * 1024;
/** Internal buffer high-water mark for one streamed route body. */
const STREAM_HIGH_WATER_BYTES = 64 * 1024;
/** Sanity cap on a single decoded worker chunk (the worker slices ≤256 KiB). */
const MAX_STREAM_CHUNK_BYTES = 1024 * 1024;

/** App-bus events that carry chat content (require `chat.read` to subscribe). */
const CHAT_CONTENT_EVENTS = new Set([
  'generation.started',
  'generation.delta',
  'generation.finished',
  'generation.error',
  'chat.message.created',
  'chat.message.updated',
  'chat.message.deleted',
]);

interface RpcMessage {
  type: 'rpc';
  requestId: string;
  method: string;
  args: Record<string, unknown>;
}

interface RouteRegistration {
  pluginId: string;
  routeId: string;
  method: string;
  path: string;
  patternKey: string;
  matcher: RegExp;
  paramNames: readonly string[];
  specificity: number;
  process: BackendProcess;
}

interface PendingInvocation {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  removeAbortListener(): void;
  onEvent?(value: unknown): void;
  /**
   * Re-arm the deadline after progress (streaming callbacks). Absent for
   * one-shot invocations, which keep their fixed timeout.
   */
  rearm?(): void;
}
/**
 * rev4 §D: worker→host streamed route body. The worker sends
 * `route.body.open` / `route.body.chunk` / `route.body.end` / `route.body.error`
 * and only transmits chunks within the credit granted by `route.body.ack`,
 * which the host issues as the HTTP consumer drains `pipe` — so a slow client
 * bounds memory end to end (invariant 5).
 */
interface StreamBodyState {
  pipe: PassThrough;
  receivedBytes: number;
  /** Bytes held after write backpressure, acknowledged together on drain. */
  credit: number;
  finished: boolean;
  /** Invocation whose deadline must re-arm while chunks flow. */
  pendingId: string | null;
}

/** @internal used by backendHost tests to drive the stream contract. */
export class BackendProcess {
  readonly invocations = new Map<string, PendingInvocation>();
  /** rev4 §D: in-flight streamed route bodies, keyed by invocationId. */
  readonly streamBodies = new Map<string, StreamBodyState>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: unknown) => void) | null = null;
  private exited = false;

  constructor(
    readonly pluginId: string,
    readonly permissions: readonly string[],
    readonly child: ChildProcess,
    private readonly host: BackendPluginHost,
  ) {
    child.on('message', (message: unknown) => void this.onMessage(message));
    // Spawn/start failures (ENOENT, EMFILE, …) surface as 'error' — often
    // without a following 'exit'. Without a listener the event becomes an
    // uncaughtException and kills the whole server, so it is handled here and
    // funneled into the same fail-fast path as an unexpected exit.
    child.on('error', (error: unknown) => {
      const systemCode =
        error instanceof Error
          ? ((error as NodeJS.ErrnoException).code ?? error.name)
          : 'WORKER_ERROR';
      host.logPluginMessage(pluginId, 'error', `worker process error: ${systemCode}`);
      this.failAll(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId, reason: 'WORKER_PROCESS_ERROR', systemCode },
          cause: error instanceof Error ? error : undefined,
        }),
      );
    });
    child.once('exit', (code, signal) => {
      this.failAll(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId, reason: 'WORKER_EXITED', code, signal },
        }),
      );
    });
    consumeOutput(child.stdout, (line) => host.logWorkerOutput(pluginId, 'debug', line));
    consumeOutput(child.stderr, (line) => host.logWorkerOutput(pluginId, 'error', line));
  }

  /**
   * Reject everything in flight and release host-side registrations. Shared by
   * the 'exit' and 'error' paths; idempotent when both fire.
   */
  private failAll(error: AppError): void {
    this.exited = true;
    this.readyReject?.(error);
    for (const state of this.streamBodies.values()) {
      state.pipe.destroy(error);
    }
    this.streamBodies.clear();
    for (const pending of this.invocations.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.invocations.clear();
    this.host.removeProcessRegistrations(this);
  }

  /**
   * IPC send guarded against a channel that closed mid-flight (the event bus
   * can still deliver between 'exit' and cleanup). `child.send` on a closed
   * channel throws synchronously; that must never escape into host code.
   */
  safeSend(message: Serializable): void {
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.send?.(message);
    } catch {
      // The exit/error handler reaps all pending state.
    }
  }

  waitUntilReady(): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
      const timer = setTimeout(() => {
        rejectReady(
          new AppError({
            code: ErrorCodes.PLUGIN_LOAD_FAILED,
            params: { pluginId: this.pluginId, reason: 'ACTIVATION_TIMEOUT' },
          }),
        );
      }, ACTIVATION_TIMEOUT_MS);
      timer.unref();
      const settle = (): void => clearTimeout(timer);
      void Promise.resolve().then(() => undefined);
      const originalResolve = this.readyResolve;
      const originalReject = this.readyReject;
      this.readyResolve = () => {
        settle();
        originalResolve?.();
      };
      this.readyReject = (error) => {
        settle();
        originalReject?.(error);
      };
    });
  }

  async deactivate(): Promise<void> {
    if (this.exited) return;
    const completed = new Promise<void>((resolveDone) => {
      const finish = (): void => resolveDone();
      this.child.once('exit', finish);
      this.child.once('message', (message: unknown) => {
        if (isMessage(message) && message['type'] === 'deactivated') finish();
      });
    });
    this.safeSend({ type: 'deactivate' });
    await Promise.race([
      completed,
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, 3_000);
        timer.unref();
      }),
    ]);
    if (!this.exited) this.child.kill();
  }

  invoke(routeId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const invocationId = `${this.pluginId}:invoke:${randomToken(10)}`;
    return new Promise((resolveInvocation, rejectInvocation) => {
      const abort = (): void => {
        this.safeSend({ type: 'route.abort', invocationId });
        this.teardownStreamBody(
          invocationId,
          new AppError({ code: ErrorCodes.ABORTED, params: { pluginId: this.pluginId } }),
        );
      };
      const timer = setTimeout(() => {
        this.invocations.delete(invocationId);
        signal.removeEventListener('abort', abort);
        this.safeSend({ type: 'route.abort', invocationId });
        this.teardownStreamBody(
          invocationId,
          new AppError({
            code: ErrorCodes.TIMEOUT,
            params: { pluginId: this.pluginId, timeoutMs: ROUTE_TIMEOUT_MS },
          }),
        );
        rejectInvocation(
          new AppError({
            code: ErrorCodes.TIMEOUT,
            params: { pluginId: this.pluginId, timeoutMs: ROUTE_TIMEOUT_MS },
          }),
        );
      }, ROUTE_TIMEOUT_MS);
      timer.unref();
      this.invocations.set(invocationId, {
        resolve: resolveInvocation,
        reject: rejectInvocation,
        timer,
        removeAbortListener: () => signal.removeEventListener('abort', abort),
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.safeSend({ type: 'route.invoke', invocationId, routeId, request });
    });
  }

  invokeCallback(
    registrationId: string,
    operation: string,
    payload: unknown,
    signal: AbortSignal,
    onEvent?: (value: unknown) => void,
    options?: {
      /**
       * Idle deadline for streaming callbacks: the timer re-arms on every
       * received event, so long-running streams (provider generation) are
       * bounded by silence, not total duration. One-shot callbacks keep the
       * fixed ROUTE_TIMEOUT_MS.
       */
      idleTimeoutMs?: number;
    },
  ): Promise<unknown> {
    const invocationId = `${this.pluginId}:callback:${randomToken(10)}`;
    return new Promise((resolveInvocation, rejectInvocation) => {
      const abort = (): void => {
        this.safeSend({ type: 'callback.abort', invocationId });
      };
      const timeoutMs = options?.idleTimeoutMs ?? ROUTE_TIMEOUT_MS;
      const pending: PendingInvocation = {
        resolve: resolveInvocation,
        reject: rejectInvocation,
        timer: undefined as unknown as NodeJS.Timeout,
        removeAbortListener: () => signal.removeEventListener('abort', abort),
        onEvent,
      };
      const fail = (): void => {
        this.invocations.delete(invocationId);
        signal.removeEventListener('abort', abort);
        this.safeSend({ type: 'callback.abort', invocationId });
        rejectInvocation(
          new AppError({
            code: ErrorCodes.TIMEOUT,
            params: { pluginId: this.pluginId, timeoutMs },
          }),
        );
      };
      const arm = (): void => {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(fail, timeoutMs);
        pending.timer.unref();
      };
      if (options?.idleTimeoutMs !== undefined) pending.rearm = arm;
      arm();
      this.invocations.set(invocationId, pending);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.safeSend({
        type: 'callback.invoke',
        invocationId,
        registrationId,
        operation,
        payload,
      });
    });
  }

  /**
   * rev4 §D: the worker announced a streamed route body. The pending route
   * invocation is resolved up front with a stream marker so the HTTP layer can
   * send status/headers and start pumping `pipe`; the worker then transmits
   * only within credit returned when the bounded pipe accepts or drains data
   * (`route.body.ack`). The abort listener stays attached so a client
   * disconnect tears the stream down; only the deadline timer is released.
   */
  private onStreamOpen(invocationId: string, message: Record<string, unknown>): void {
    if (this.streamBodies.has(invocationId)) return;
    const pipe = new PassThrough({ highWaterMark: STREAM_HIGH_WATER_BYTES });
    const state: StreamBodyState = {
      pipe,
      receivedBytes: 0,
      credit: 0,
      finished: false,
      pendingId: invocationId,
    };
    const pending = this.invocations.get(invocationId);
    if (!pending) {
      // Nobody awaits this stream (abort won the race): drop it.
      pipe.destroy();
      return;
    }
    clearTimeout(pending.timer);

    this.streamBodies.set(invocationId, state);
    pending.resolve({
      kind: 'stream-response',
      status: message['status'],
      headers: message['headers'],
      pipe,
    });
  }

  /** rev4 §D: one worker chunk; quota violations tear the stream down. */
  private onStreamChunk(invocationId: string, message: Record<string, unknown>): void {
    const state = this.streamBodies.get(invocationId);
    if (!state || state.finished) return;
    const bytes = message['bytes'];
    const data = message['data'];
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return;
    if (typeof data !== 'string') return;
    if (bytes > MAX_STREAM_CHUNK_BYTES) {
      this.failStreamBody(state, invocationId, 'STREAM_CHUNK_TOO_LARGE', 'chunk exceeds limit');
      return;
    }
    const chunk = Buffer.from(data, 'base64');
    if (chunk.byteLength !== bytes) {
      this.failStreamBody(state, invocationId, 'STREAM_CHUNK_INVALID', 'declared size mismatch');
      return;
    }
    state.receivedBytes += bytes;
    if (state.receivedBytes > MAX_STREAM_BODY_BYTES) {
      this.failStreamBody(state, invocationId, 'STREAM_BODY_TOO_LARGE', 'stream exceeded quota');
      return;
    }
    if (state.pipe.destroyed) return;
    const accepted = state.pipe.write(chunk);
    if (accepted) {
      this.safeSend({ type: 'route.body.ack', invocationId, bytes });
      return;
    }
    const drainAlreadyArmed = state.credit > 0;
    state.credit += bytes;
    if (!drainAlreadyArmed) {
      state.pipe.once('drain', () => {
        if (this.streamBodies.get(invocationId) !== state || state.credit <= 0) return;
        const drainedBytes = state.credit;
        state.credit = 0;
        this.safeSend({ type: 'route.body.ack', invocationId, bytes: drainedBytes });
      });
    }
  }

  /** rev4 §D: the worker finished the body; EOF reaches the HTTP consumer. */
  private onStreamEnd(invocationId: string): void {
    const state = this.streamBodies.get(invocationId);
    if (!state) return;
    state.finished = true;
    this.streamBodies.delete(invocationId);
    if (!state.pipe.destroyed) state.pipe.end();
    this.releaseInvocation(invocationId);
  }

  /** rev4 §D: the worker failed mid-stream; the consumer sees the error. */
  private onStreamError(invocationId: string, message: string): void {
    const state = this.streamBodies.get(invocationId);
    if (!state) return;
    this.streamBodies.delete(invocationId);
    if (!state.pipe.destroyed) {
      state.pipe.destroy(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId: this.pluginId, reason: 'STREAM_BODY_FAILED', message },
        }),
      );
    }
    this.releaseInvocation(invocationId);
  }

  /**
   * Host-side stream teardown (abort/timeout/quota): destroy the pipe so the
   * HTTP consumer sees the failure and abort the worker's pump so its credit
   * stall cannot leak a pending route handler.
   */
  private teardownStreamBody(invocationId: string, error: AppError): void {
    const state = this.streamBodies.get(invocationId);
    if (!state) return;
    this.streamBodies.delete(invocationId);
    if (!state.pipe.destroyed) state.pipe.destroy(error);
    this.safeSend({ type: 'route.abort', invocationId });
    this.releaseInvocation(invocationId);
  }

  /** rev4 §D: shared failure path for host-detected stream violations. */
  private failStreamBody(
    state: StreamBodyState,
    invocationId: string,
    reason: string,
    detail: string,
  ): void {
    this.streamBodies.delete(invocationId);
    if (!state.pipe.destroyed) {
      state.pipe.destroy(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId: this.pluginId, reason, detail },
        }),
      );
    }
    this.safeSend({ type: 'route.abort', invocationId });
    this.releaseInvocation(invocationId);
  }

  /** Detach a resolved stream invocation's remaining listeners and entry. */
  private releaseInvocation(invocationId: string): void {
    const pending = this.invocations.get(invocationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    this.invocations.delete(invocationId);
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isMessage(message)) return;
    const type = message['type'];
    if (type === 'ready') {
      this.readyResolve?.();
      return;
    }
    if (type === 'activationError') {
      this.host.logPluginMessage(
        this.pluginId,
        'error',
        `activation failed: ${safeString(message['message'])}`,
      );
      this.readyReject?.(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: {
            pluginId: this.pluginId,
            reason: 'ACTIVATION_FAILED',
            workerCode: safeString(message['code']),
          },
        }),
      );
      return;
    }
    if (type === 'rpc') {
      if (!isRpcMessage(message)) return;
      await this.host.handleRpc(this, message);
      return;
    }
    if (type === 'route.result') {
      const invocationId = safeString(message['invocationId']);
      const pending = this.invocations.get(invocationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      this.invocations.delete(invocationId);
      if (message['ok'] === true) pending.resolve(message['response']);
      else {
        pending.reject(
          new AppError({
            code: ErrorCodes.PLUGIN_LOAD_FAILED,
            params: {
              pluginId: this.pluginId,
              reason: 'ROUTE_HANDLER_FAILED',
              workerCode: isMessage(message['error'])
                ? safeString(message['error']['code'])
                : undefined,
            },
          }),
        );
      }
      return;
    }
    if (type === 'route.body.open') {
      this.onStreamOpen(safeString(message['invocationId']), message);
      return;
    }
    if (type === 'route.body.chunk') {
      this.onStreamChunk(safeString(message['invocationId']), message);
      return;
    }
    if (type === 'route.body.end') {
      this.onStreamEnd(safeString(message['invocationId']));
      return;
    }
    if (type === 'route.body.error') {
      this.onStreamError(
        safeString(message['invocationId']),
        safeString(message['message']) || 'stream failed',
      );
      return;
    }
    if (type === 'callback.event') {
      const pending = this.invocations.get(safeString(message['invocationId']));
      if (pending) {
        // Progress was made — extend the idle deadline for streaming callbacks.
        pending.rearm?.();
        pending.onEvent?.(message['value']);
      }
      return;
    }
    if (type === 'callback.result') {
      const invocationId = safeString(message['invocationId']);
      const pending = this.invocations.get(invocationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      this.invocations.delete(invocationId);
      if (message['ok'] === true) pending.resolve(message['value']);
      else {
        pending.reject(
          new AppError({
            code: ErrorCodes.PLUGIN_LOAD_FAILED,
            params: {
              pluginId: this.pluginId,
              reason: 'PLUGIN_CALLBACK_FAILED',
              workerCode: isMessage(message['error'])
                ? safeString(message['error']['code'])
                : undefined,
            },
          }),
        );
      }
      return;
    }
    if (type === 'workerError') {
      this.host.logPluginMessage(
        this.pluginId,
        'error',
        `runtime registration failed: ${safeString(message['code'])}`,
      );
      return;
    }
    if (type === 'usage') {
      this.host.handleUsageReport(this, message);
      return;
    }
    if (type === 'log') {
      this.host.logPluginMessage(
        this.pluginId,
        safeString(message['level']),
        safeString(message['message']),
      );
    }
  }
}

export class BackendPluginHost {
  private readonly processes = new Map<string, BackendProcess>();
  private readonly routes = new Map<string, RouteRegistration>();
  private readonly runtimeCleanups = new Map<BackendProcess, Set<() => void>>();
  /** rev4 §3: kernel-namespaced RPCs contributed by server modules. */
  private readonly externalRpc = new Map<
    string,
    (process: BackendProcess, args: Record<string, unknown>) => Promise<unknown> | unknown
  >();
  private readonly eventSubscriptions = new Map<BackendProcess, Map<string, () => void>>();
  /** Per-plugin promise chains serializing activate/deactivate (PLUG-52). */
  private readonly lifecycleLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly app: TypedApp,
    private readonly ctx: AppContext,
    private readonly legacyHost?: LegacyServerPluginHost,
    /**
     * Resource Governor (ТЗ §8, ADR-0026). When present, every spawned
     * backend process is registered in the tree ledger, gets a V8 heap cap
     * and the `NEOTA_PLUGIN_RESOURCE_LIMITS` handshake, and its cooperative
     * usage reports feed the governor's fallback sampling. Absent in
     * unit-style tests that provide a partial context.
     */
    private readonly governor?: ResourceGovernor,
  ) {}

  registerDispatcher(): void {
    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const params = request.params as { pluginId?: string; '*': string };
      const pluginId = params.pluginId ?? '';
      const routePath = `/${params['*']}`;
      const matched = this.findRoute(pluginId, request.method, routePath);
      if (!matched) {
        const legacy = await this.legacyHost?.dispatch(pluginId, routePath, request, reply);
        if (legacy?.handled) {
          return reply.send(legacy.body);
        }
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { pluginId, path: routePath },
        });
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.raw.once('aborted', abort);
      try {
        const response = await matched.registration.process.invoke(
          matched.registration.routeId,
          {
            params: matched.params,
            query: normalizeStringRecord(request.query),
            headers: normalizeHeaders(request.headers),
            body: request.body,
          },
          controller.signal,
        );
        if (isStreamResponse(response)) {
          // rev4 §D: streamed route body — status/headers arrive with
          // `route.body.open`; the pipe drains as the worker sends chunks
          // within the credit the bounded pipe grants back.
          const status = normalizeStatus(response['status']);
          if (status) reply.code(status);
          for (const [name, value] of Object.entries(
            normalizeResponseHeaders(response['headers']),
          )) {
            reply.header(name, value);
          }
          return reply.send(response['pipe']);
        }
        // Plain JSON/string responses pass through untouched; only responses
        // shaped like a PluginResponse envelope ({status,headers,body}) are
        // normalized. A bare object without any of those keys would otherwise
        // send an empty body.
        if (!isMessage(response) || !isResponseEnvelope(response)) return reply.send(response);
        const status = normalizeStatus(response['status']);
        if (status) reply.code(status);
        for (const [name, value] of Object.entries(normalizeResponseHeaders(response['headers']))) {
          reply.header(name, value);
        }
        return reply.send(response['body']);
      } finally {
        request.raw.off('aborted', abort);
      }
    };

    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      this.app.route({
        method,
        url: '/api/plugins/:pluginId/*',
        handler,
      });
    }
  }

  async activate(
    manifest: PluginManifest,
    packageRoot: string,
    permissions: readonly string[],
  ): Promise<void> {
    if (!manifest.backend) return;
    // Lifecycle transitions for one plugin are serialized: concurrent
    // activate/activate or activate/deactivate previously orphaned workers
    // and left live routes for deleted plugins (PLUG-52).
    await this.withLifecycleLock(manifest.id, () =>
      this.activateUnlocked(manifest, packageRoot, permissions),
    );
  }

  /** Run an action once all previous lifecycle actions for the plugin settled. */
  private withLifecycleLock<T>(pluginId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(pluginId) ?? Promise.resolve();
    const run = previous.then(action);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleLocks.set(pluginId, tail);
    void tail.then(() => {
      if (this.lifecycleLocks.get(pluginId) === tail) this.lifecycleLocks.delete(pluginId);
    });
    return run;
  }

  private async activateUnlocked(
    manifest: PluginManifest,
    packageRoot: string,
    permissions: readonly string[],
  ): Promise<void> {
    if (!manifest.backend) return;
    await this.deactivateUnlocked(manifest.id);
    const nodePath = this.ctx.config.pluginNodePath;
    if (!nodePath) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
        params: { pluginId: manifest.id, reason: 'PLUGIN_NODE_RUNTIME_UNAVAILABLE' },
      });
    }
    const workerPath =
      this.ctx.config.pluginWorkerPath ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/plugin-worker.mjs');
    const loaderPath =
      this.ctx.config.pluginLoaderPath ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/plugin-loader.mjs');
    const entrySegments = validatePackageEntryPath(manifest.backend);
    // SEC-05 fail-closed (defense in depth): `signature/` is excluded from
    // the publisher digest, so a backend entry there would escape signed
    // verification. `validatePackage` rejects this at install; re-checking
    // here keeps activation safe even for packages installed before the rule.
    if (entrySegments[0] === 'signature') {
      throw new AppError({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
        params: { pluginId: manifest.id, reason: 'ENTRYPOINT_INSIDE_SIGNATURE' },
      });
    }
    // Resolve aliases before applying Node's permission model. The restricted
    // child cannot call realpath outside an already granted canonical root
    // (notably macOS maps /var to /private/var).
    const canonicalPackageRoot = await realpath(packageRoot);
    const canonicalLoaderPath = await realpath(loaderPath);
    const canonicalWorkerPath = await realpath(workerPath);
    // The entry is passed relative to the worker cwd (the package root) so
    // the plugin argv carries no absolute paths (ADR-0007); the worker
    // resolves it against its own cwd. The loader/worker paths are host
    // infrastructure Node requires on the command line. `--allow-worker`
    // stays: on Node 24 the ESM loader runs hooks in an internal worker
    // thread, and the permission model denies that without the flag.
    // Plugins still get no Worker threads in practice: the loader rejects
    // bare `node:`/data:/network imports (including node:worker_threads) and
    // the worker bootstrap zeroes the global `Worker` (PLUG-59 L5).
    //
    // Resource governance (ТЗ RUN-06, RES-09): the V8 heap cap is the first
    // line of defense applied before user code runs; the versioned limits
    // handshake lets the worker expose its own budget via diagnostics.
    const limits = this.governor?.limitsFor(manifest.id) ?? this.defaultLimits();
    const nodeArgs = [
      `--experimental-loader=${pathToFileURL(canonicalLoaderPath).href}`,
      '--permission',
      `--allow-fs-read=${canonicalPackageRoot}`,
      `--allow-fs-read=${canonicalLoaderPath}`,
      `--allow-fs-read=${canonicalWorkerPath}`,
      '--allow-worker',
      `--max-old-space-size=${limits.heapMiB}`,
      canonicalWorkerPath,
      entrySegments.join('/'),
      manifest.id,
      JSON.stringify(permissions),
    ];
    const child = spawn(nodePath, nodeArgs, {
      cwd: canonicalPackageRoot,
      env: minimalWorkerEnvironment(manifest.id, canonicalPackageRoot, canonicalWorkerPath, limits),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    if (child.pid !== undefined) {
      this.governor?.registerProcess({
        pluginId: manifest.id,
        pid: child.pid,
        heapMiB: limits.heapMiB,
        rssSoftMiB: limits.rssSoftMiB,
        rssHardMiB: limits.rssHardMiB,
        cpuSoftPercent: limits.cpuSoftPercent,
        cpuHardPercent: limits.cpuHardPercent,
      });
    }
    const process = new BackendProcess(manifest.id, permissions, child, this);
    this.processes.set(manifest.id, process);
    try {
      await process.waitUntilReady();
    } catch (error) {
      await process.deactivate();
      // Never remove a foreign map entry: only our own process may be evicted.
      if (this.processes.get(manifest.id) === process) this.processes.delete(manifest.id);
      this.removeProcessRegistrations(process);
      throw error;
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    await this.withLifecycleLock(pluginId, () => this.deactivateUnlocked(pluginId));
  }

  private async deactivateUnlocked(pluginId: string): Promise<void> {
    const process = this.processes.get(pluginId);
    if (!process) return;
    this.processes.delete(pluginId);
    await process.deactivate();
    this.removeProcessRegistrations(process);
    this.governor?.unregisterProcess(pluginId);
  }

  /**
   * Cooperative usage report from the worker (ТЗ RES-02 fallback source on
   * platforms without /proc; cross-check on Linux). No message-shaped data
   * is ever trusted beyond the numbers themselves.
   */
  handleUsageReport(process: BackendProcess, message: Record<string, unknown>): void {
    const usage = message['usage'];
    if (!isMessage(usage)) return;
    const heapUsed = usage['heapUsed'];
    const rss = usage['rss'];
    const cpuMs = usage['cpuMs'];
    const uptimeMs = usage['uptimeMs'];
    if (typeof heapUsed !== 'number' || typeof rss !== 'number') return;
    this.governor?.handleUsageReport(process.pluginId, {
      heapUsed,
      rss,
      cpuMs: typeof cpuMs === 'number' ? cpuMs : 0,
      uptimeMs: typeof uptimeMs === 'number' ? uptimeMs : 0,
    });
  }

  /**
   * Limits used when the governor has no entry for the plugin yet (before its
   * ledger registration settles). With a governor the profile defaults come
   * from it; without one (partial-context tests) sane low-vps defaults apply.
   */
  private defaultLimits(): PluginResourceLimits {
    const config = this.governor?.config ?? this.ctx.config.resources ?? DEFAULT_RESOURCE_CONFIG;
    return {
      version: RESOURCE_LIMITS_VERSION,
      heapMiB: config.plugins.defaultProcessHeapMiB,
      rssSoftMiB: config.plugins.defaultProcessRssSoftMiB,
      rssHardMiB: config.plugins.defaultProcessRssHardMiB,
      cpuSoftPercent: this.governor?.cpuSoftPercent ?? 63,
      cpuHardPercent: this.governor?.cpuHardPercent ?? 90,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.deactivate(id)));
  }

  removeProcessRegistrations(process: BackendProcess): void {
    for (const [key, route] of this.routes) {
      if (route.process === process) this.routes.delete(key);
    }
    for (const cleanup of this.runtimeCleanups.get(process) ?? []) {
      try {
        cleanup();
      } catch {
        // Registry cleanup is isolated per registration.
      }
    }
    this.runtimeCleanups.delete(process);
    for (const cleanup of this.eventSubscriptions.get(process)?.values() ?? []) {
      cleanup();
    }
    this.eventSubscriptions.delete(process);
  }

  private findRoute(
    pluginId: string,
    method: string,
    path: string,
  ): { registration: RouteRegistration; params: Record<string, string> } | null {
    // Collision rule (PLUG-59 L9): identical pattern shapes are rejected at
    // registration (CONFLICT — pattern keys normalize parameter names), and
    // for overlapping patterns the higher specificity wins; a residual
    // equal-specificity tie resolves to the LATEST registration — Map
    // iteration order is insertion order, so resolution is deterministic.
    let best: RouteRegistration | null = null;
    let match: RegExpExecArray | null = null;
    for (const registration of this.routes.values()) {
      if (
        registration.pluginId !== pluginId ||
        registration.method !== method.toUpperCase() ||
        registration.specificity < (best?.specificity ?? -1)
      ) {
        continue;
      }
      const candidate = registration.matcher.exec(path);
      if (!candidate) continue;
      best = registration;
      match = candidate;
    }
    if (!best || !match) return null;
    return {
      registration: best,
      params: Object.fromEntries(
        best.paramNames.map((name, index) => [name, match?.[index + 1] ?? '']),
      ),
    };
  }

  async handleRpc(process: BackendProcess, message: RpcMessage): Promise<void> {
    try {
      const value = await this.executeRpc(process, message.method, message.args);
      process.safeSend({ type: 'rpcResult', requestId: message.requestId, ok: true, value });
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({ code: ErrorCodes.PLUGIN_LOAD_FAILED, cause: error });
      process.safeSend({
        type: 'rpcResult',
        requestId: message.requestId,
        ok: false,
        error: { code: appError.code, message: appError.message },
      });
    }
  }

  logWorkerOutput(pluginId: string, level: 'debug' | 'warn' | 'error', line: string): void {
    const message = `[plugin:${pluginId}:worker] ${line.slice(0, 2000)}`;
    this.ctx.logger[level](message);
  }

  logPluginMessage(pluginId: string, level: string, message: string): void {
    const safeLevel = ['debug', 'info', 'warn', 'error'].includes(level)
      ? (level as 'debug' | 'info' | 'warn' | 'error')
      : 'info';
    this.ctx.logger[safeLevel](`[plugin:${pluginId}] ${message.slice(0, 2000)}`);
  }

  /**
   * rev4 §3: register a kernel-namespaced RPC (e.g. `storage.kv.get`) served
   * for backend plugins. Handlers receive the calling process (for grant
   * checks) and the raw args object.
   */
  registerExternalRpc(
    method: string,
    handler: (process: BackendProcess, args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void {
    if (this.externalRpc.has(method)) {
      throw new AppError({ code: ErrorCodes.CONFLICT, params: { method } });
    }
    this.externalRpc.set(method, handler);
  }

  /**
   * rev4 §2 jobs: push an app-bus event into one plugin's worker over the
   * worker's existing `event.emit` channel (pluginJobs.ts due-job relay).
   * No-op when no backend process for the plugin is alive — the SSE/web
   * relay and the persisted job record survive either way.
   */
  deliverEvent(pluginId: string, event: string, payload: unknown): void {
    const process = this.processes.get(pluginId);
    process?.safeSend({ type: 'event.emit', event, payload });
  }

  private async executeRpc(
    process: BackendProcess,
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const external = this.externalRpc.get(method);
    if (external) return external(process, args);
    if (method === 'route.register') {
      requireGranted(process, 'server.routes');
      const routeId = requireString(args['routeId'], 'routeId');
      const routeMethod = requireString(args['method'], 'method').toUpperCase();
      const path = validateRoutePath(requireString(args['path'], 'path'));
      const compiled = compileRoutePath(path);
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(routeMethod)) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'METHOD_INVALID' } });
      }
      const key = routeKey(process.pluginId, routeMethod, compiled.patternKey);
      if (this.routes.has(key)) {
        throw new AppError({ code: ErrorCodes.CONFLICT, params: { path } });
      }
      let routeCount = 0;
      for (const route of this.routes.values()) {
        if (route.process === process) routeCount += 1;
      }
      if (routeCount >= MAX_PLUGIN_ROUTES) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'ROUTE_LIMIT_EXCEEDED', limit: MAX_PLUGIN_ROUTES },
        });
      }
      this.routes.set(key, {
        pluginId: process.pluginId,
        routeId,
        method: routeMethod,
        path,
        ...compiled,
        process,
      });
      return true;
    }
    if (method === 'route.unregister') {
      const routeId = requireString(args['routeId'], 'routeId');
      for (const [key, route] of this.routes) {
        if (route.process === process && route.routeId === routeId) this.routes.delete(key);
      }
      return true;
    }
    if (method === 'provider.register') {
      requireGranted(process, 'providers.register');
      const registrationId = requireRegistrationId(args['registrationId']);
      const kind = requirePluginKind(args['kind']);
      const capabilities = normalizeProviderCapabilities(args['capabilities']);
      if (this.ctx.providers.has(kind)) {
        throw new AppError({ code: ErrorCodes.CONFLICT, params: { kind } });
      }
      const cleanup = this.ctx.providers.register(
        kind,
        (config) => new PluginProviderAdapter(kind, registrationId, config, process, capabilities),
      );
      this.trackRuntimeCleanup(process, registrationId, cleanup);
      return true;
    }
    if (
      method === 'provider.unregister' ||
      method === 'tokenizer.unregister' ||
      method === 'context.unregister' ||
      method === 'postProcess.unregister'
    ) {
      this.runTrackedCleanup(process, requireRegistrationId(args['registrationId']));
      return true;
    }
    if (method === 'tokenizer.register') {
      requireGranted(process, 'providers.register');
      const registrationId = requireRegistrationId(args['registrationId']);
      const id = requirePluginKind(args['id']);
      const priority = normalizeOptionalInteger(args['priority'], -10_000, 10_000);
      if (typeof args['approximate'] !== 'boolean') {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'TOKENIZER_APPROXIMATE_INVALID' },
        });
      }
      const cleanup = this.ctx.providers.tokenizers.register({
        id,
        ...(priority === undefined ? {} : { priority }),
        approximate: args['approximate'],
        matches: async (model) => {
          const value = await process.invokeCallback(
            registrationId,
            'tokenizer.matches',
            { model },
            AbortSignal.timeout(TOKENIZER_CALLBACK_TIMEOUT_MS),
          );
          if (typeof value !== 'boolean') {
            throw invalidPluginCallback(id, 'TOKENIZER_MATCH_INVALID');
          }
          return value;
        },
        count: async (text) => {
          const value = await process.invokeCallback(
            registrationId,
            'tokenizer.count',
            { text },
            AbortSignal.timeout(TOKENIZER_CALLBACK_TIMEOUT_MS),
          );
          if (!Number.isSafeInteger(value) || (value as number) < 0) {
            throw invalidPluginCallback(id, 'TOKENIZER_COUNT_INVALID');
          }
          return value as number;
        },
      });
      this.trackRuntimeCleanup(process, registrationId, cleanup);
      return true;
    }
    if (method === 'context.register') {
      requireGranted(process, 'prompt.modify');
      const registrationId = requireRegistrationId(args['registrationId']);
      const id = requirePluginKind(args['id']);
      const priority = normalizeOptionalInteger(args['priority'], -10_000, 10_000);
      const cleanup = this.ctx.contextStrategies.register({
        id,
        ...(priority === undefined ? {} : { priority }),
        shift: async ({ messages, budgetTokens, countTokens, manualExcludedIds }) => {
          const uniqueContents = [...new Set(messages.map((message) => message.content))];
          const tokenCounts = Object.fromEntries(
            await Promise.all(
              uniqueContents.map(async (content) => [content, await countTokens(content)] as const),
            ),
          );
          const result = await process.invokeCallback(
            registrationId,
            'context.shift',
            {
              messages,
              budgetTokens,
              manualExcludedIds: [...(manualExcludedIds ?? [])],
              tokenCounts,
            },
            new AbortController().signal,
          );
          return normalizeContextShiftResult(result);
        },
      });
      this.trackRuntimeCleanup(process, registrationId, cleanup);
      return true;
    }
    if (method === 'postProcess.register') {
      // Post-processing rewrites the assistant reply, so it needs the same
      // permission as prompt modification (ТЗ §4.4, §7.4).
      requireGranted(process, 'prompt.modify');
      const registrationId = requireRegistrationId(args['registrationId']);
      const id = requirePluginKind(args['id']);
      const priority = normalizeOptionalInteger(args['priority'], -10_000, 10_000);
      const cleanup = this.ctx.postProcessors.register({
        id,
        ...(priority === undefined ? {} : { priority }),
        requiredPermission: 'prompt.modify',
        process: async (text, context) => {
          const result = await process.invokeCallback(
            registrationId,
            'postProcess.run',
            { text, context },
            new AbortController().signal,
          );
          if (typeof result !== 'string' || result.length > 200_000) {
            throw invalidPluginCallback(id, 'POST_PROCESS_RESULT_INVALID');
          }
          return result;
        },
      });
      this.trackRuntimeCleanup(process, registrationId, cleanup);
      return true;
    }
    if (method === 'fetch.request') return this.fetchRpc(process, args);
    if (method.startsWith('storage.')) return this.storageRpc(process.pluginId, method, args);
    if (method.startsWith('files.')) {
      requireGranted(process, 'files:plugin');
      return this.filesRpc(process.pluginId, method, args);
    }
    if (method === 'event.subscribe') {
      const event = requireEventName(args['event']);
      // Events carrying chat text require chat.read (ТЗ §7.4) — subscription
      // is gated here, on the trusted host, not in the plugin process.
      if (CHAT_CONTENT_EVENTS.has(event)) requireGranted(process, 'chat.read');
      const subscriptions = this.eventSubscriptions.get(process) ?? new Map<string, () => void>();
      if (!subscriptions.has(event)) {
        if (subscriptions.size >= MAX_EVENT_SUBSCRIPTIONS) {
          throw new AppError({
            code: ErrorCodes.BAD_REQUEST,
            params: {
              reason: 'PLUGIN_EVENT_SUBSCRIPTION_LIMIT',
              limit: MAX_EVENT_SUBSCRIPTIONS,
            },
          });
        }
        subscriptions.set(
          event,
          this.ctx.events.on(event, (payload) => {
            process.safeSend({ type: 'event.emit', event, payload });
          }),
        );
        this.eventSubscriptions.set(process, subscriptions);
      }
      return true;
    }
    if (method === 'event.unsubscribe') {
      const event = requireEventName(args['event']);
      const subscriptions = this.eventSubscriptions.get(process);
      subscriptions?.get(event)?.();
      subscriptions?.delete(event);
      if (subscriptions?.size === 0) this.eventSubscriptions.delete(process);
      return true;
    }
    if (method === 'event.emit') {
      const event = requireEventName(args['event']);
      if (!event.startsWith(`${process.pluginId}.`)) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
          params: { pluginId: process.pluginId, event },
        });
      }
      validateEventPayload(args['payload']);
      this.ctx.events.emit(event, args['payload']);
      return true;
    }
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'PLUGIN_RPC_METHOD_UNKNOWN', method },
    });
  }

  storageRpc(pluginId: string, method: string, args: Record<string, unknown>): unknown {
    const key = requireStorageKey(args['key']);
    const sqlite = this.ctx.database.sqlite;
    if (method === 'storage.get') {
      const row = sqlite
        .prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get(pluginId, key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as unknown) : undefined;
    }
    if (method === 'storage.set') {
      const json = JSON.stringify(args['value']);
      if (json === undefined || Buffer.byteLength(json) > MAX_STORAGE_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_STORAGE_BYTES },
        });
      }
      // Aggregate quota: per-key limits alone allow unbounded totals via key
      // count (PLUG-59 L6).
      const current = sqlite
        .prepare(
          'SELECT COALESCE(SUM(length(value)), 0) AS total FROM plugin_storage WHERE plugin_id = ?',
        )
        .get(pluginId) as { total: number };
      const replaced = sqlite
        .prepare('SELECT length(value) AS size FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .get(pluginId, key) as { size: number } | undefined;
      const projected = current.total - (replaced?.size ?? 0) + json.length;
      if (projected > MAX_STORAGE_TOTAL_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_STORAGE_TOTAL_BYTES },
        });
      }
      sqlite
        .prepare(
          `INSERT INTO plugin_storage (plugin_id, key, value)
           VALUES (?, ?, ?)
           ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(pluginId, key, json);
      return undefined;
    }
    if (method === 'storage.delete') {
      sqlite
        .prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?')
        .run(pluginId, key);
      return undefined;
    }
    if (method === 'storage.keys') {
      return (
        sqlite
          .prepare('SELECT key FROM plugin_storage WHERE plugin_id = ? ORDER BY key LIMIT 1001')
          .all(pluginId) as Array<{ key: string }>
      )
        .slice(0, 1000)
        .map((row) => row.key);
    }
    throw new AppError({ code: ErrorCodes.BAD_REQUEST });
  }

  /**
   * Host-side permission-checked fetch (ТЗ §7.3). The authoritative
   * `network:<host>` decision happens here, outside the untrusted process —
   * the worker's own check is fail-fast only and can be subverted in-realm.
   * Response bodies are size-bounded; redirects are refused (a redirect would
   * otherwise bypass the hostname allowlist).
   */
  async fetchRpc(process: BackendProcess, args: Record<string, unknown>): Promise<unknown> {
    const urlText = requireString(args['url'], 'url');
    let parsed: URL;
    try {
      parsed = new URL(urlText);
    } catch {
      throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'URL_INVALID' } });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppError({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: 'URL_SCHEME_NOT_ALLOWED' },
      });
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      !process.permissions.includes('network:*') &&
      !process.permissions.includes(`network:${hostname}`)
    ) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
        params: { pluginId: process.pluginId, permission: `network:${hostname}` },
      });
    }
    const method =
      typeof args['method'] === 'string' && args['method'].trim().length > 0
        ? args['method'].toUpperCase()
        : 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'METHOD_INVALID' } });
    }
    const headers: Record<string, string> = {};
    const rawHeaders = args['headers'];
    if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (typeof value === 'string' && key.length <= 128 && value.length <= 8192) {
          headers[key] = value;
        }
      }
    }
    // The limit is in BYTES: string.length counts UTF-16 units and would let
    // multi-byte bodies overshoot the ceiling (and reject ASCII prematurely).
    const body =
      typeof args['body'] === 'string' && Buffer.byteLength(args['body']) <= MAX_PLUGIN_FETCH_BYTES
        ? args['body']
        : undefined;

    let response: Response;
    try {
      response = await fetch(parsed, {
        method,
        headers,
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(PLUGIN_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AppError({
        code: timedOut ? ErrorCodes.TIMEOUT : ErrorCodes.BAD_REQUEST,
        params: { reason: timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', hostname },
        cause: error,
      });
    }
    const text = await readBoundedText(response.body, MAX_PLUGIN_FETCH_BYTES);
    return { ok: response.ok, status: response.status, body: text };
  }

  private trackRuntimeCleanup(
    process: BackendProcess,
    registrationId: string,
    cleanup: () => void,
  ): void {
    const cleanups = this.runtimeCleanups.get(process) ?? new Set<() => void>();
    const tracked = (): void => {
      cleanup();
      cleanups.delete(tracked);
    };
    Object.defineProperty(tracked, 'registrationId', { value: registrationId });
    cleanups.add(tracked);
    this.runtimeCleanups.set(process, cleanups);
  }

  private runTrackedCleanup(process: BackendProcess, registrationId: string): void {
    const cleanup = [...(this.runtimeCleanups.get(process) ?? [])].find(
      (candidate) =>
        (candidate as (() => void) & { registrationId?: string }).registrationId === registrationId,
    );
    cleanup?.();
  }

  private async filesRpc(
    pluginId: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const relativePath = requireString(args['path'], 'path');
    const root = join(this.ctx.paths.plugins, pluginId, 'data');
    const path = resolve(root, ...validatePackageEntryPath(relativePath));
    await mkdir(root, { recursive: true });
    if (method === 'files.read') {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) {
        throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { relativePath } });
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_FILE_BYTES },
        });
      }
      return readFile(path, 'utf8');
    }
    if (method === 'files.write') {
      const content = requireString(args['content'], 'content');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_FILE_BYTES },
        });
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.partial-${randomToken(8)}`;
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return undefined;
    }
    if (method === 'files.list') {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => !entry.isSymbolicLink())
        .slice(0, 1000)
        .map((entry) => entry.name);
    }
    if (method === 'files.delete') {
      await rm(path, { recursive: true, force: true });
      return undefined;
    }

    throw new AppError({ code: ErrorCodes.BAD_REQUEST });
  }
}

export type { BackendProcess as BackendPluginProcess };

function normalizeContextShiftResult(value: unknown): ContextShiftResult {
  if (
    !isMessage(value) ||
    !Array.isArray(value['kept']) ||
    !Array.isArray(value['excluded']) ||
    !Number.isSafeInteger(value['estimatedTokens']) ||
    (value['estimatedTokens'] as number) < 0 ||
    typeof value['truncated'] !== 'boolean' ||
    typeof value['fitsBudget'] !== 'boolean'
  ) {
    throw invalidPluginCallback('context', 'CONTEXT_RESULT_INVALID');
  }
  const kept = value['kept'].filter(isPromptMessage);
  const excluded = value['excluded'].filter(isPromptMessage);
  if (kept.length !== value['kept'].length || excluded.length !== value['excluded'].length) {
    throw invalidPluginCallback('context', 'CONTEXT_MESSAGES_INVALID');
  }
  return {
    kept,
    excluded,
    estimatedTokens: value['estimatedTokens'] as number,
    truncated: value['truncated'],
    fitsBudget: value['fitsBudget'],
  };
}

function isPromptMessage(value: unknown): value is PromptMessage {
  return (
    isMessage(value) &&
    ['system', 'user', 'assistant', 'tool', 'plugin'].includes(safeString(value['role'])) &&
    typeof value['content'] === 'string'
  );
}

function invalidPluginCallback(kind: string, reason: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_LOAD_FAILED,
    params: { kind, reason },
  });
}

function routeKey(pluginId: string, method: string, path: string): string {
  return `${pluginId}\n${method.toUpperCase()}\n${path}`;
}

function compileRoutePath(
  path: string,
): Omit<RouteRegistration, 'pluginId' | 'routeId' | 'method' | 'path' | 'process'> {
  const paramNames: string[] = [];
  let specificity = 0;
  const patternSegments = path
    .split('/')
    .slice(1)
    .map((segment) => {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (!/^[a-z][a-z0-9_]*$/iu.test(name) || paramNames.includes(name)) {
          throw new AppError({
            code: ErrorCodes.BAD_REQUEST,
            params: { reason: 'ROUTE_PARAM_INVALID', name },
          });
        }
        paramNames.push(name);
        specificity += 1;
        return '([^/]+)';
      }
      specificity += 2;
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    });
  return {
    patternKey: path.replace(/:[a-z][a-z0-9_]*/giu, ':'),
    matcher: new RegExp(`^/${patternSegments.join('/')}$`, 'u'),
    paramNames,
    specificity,
  };
}

function validateRoutePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 500 ||
    !path.startsWith('/') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'ROUTE_PATH_INVALID' } });
  }
  return path;
}

function requireGranted(process: BackendProcess, permission: string): void {
  if (!process.permissions.includes(permission)) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
      params: { pluginId: process.pluginId, permission },
    });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { field } });
  }
  return value;
}

function requireRegistrationId(value: unknown): string {
  const id = requireString(value, 'registrationId');
  if (!/^[a-z0-9._:-]{1,240}$/iu.test(id)) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'PLUGIN_REGISTRATION_ID_INVALID' },
    });
  }
  return id;
}

function requirePluginKind(value: unknown): string {
  const kind = requireString(value, 'kind');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(kind)) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'PLUGIN_REGISTRATION_KIND_INVALID' },
    });
  }
  return kind;
}

function normalizeProviderCapabilities(
  value: unknown,
): Readonly<{ assistantPrefill?: boolean; textCompletion?: boolean }> | undefined {
  if (value === undefined) return undefined;
  if (!isMessage(value)) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'CAPABILITIES_INVALID' },
    });
  }
  const assistantPrefill = value['assistantPrefill'];
  const textCompletion = value['textCompletion'];
  if (
    (assistantPrefill !== undefined && typeof assistantPrefill !== 'boolean') ||
    (textCompletion !== undefined && typeof textCompletion !== 'boolean')
  ) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'CAPABILITIES_INVALID' },
    });
  }
  return {
    ...(assistantPrefill === true ? { assistantPrefill } : {}),
    ...(textCompletion === true ? { textCompletion } : {}),
  };
}

function requireEventName(value: unknown): string {
  const event = requireString(value, 'event');
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/iu.test(event)) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'PLUGIN_EVENT_NAME_INVALID' },
    });
  }
  return event;
}

function validateEventPayload(value: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'PLUGIN_EVENT_PAYLOAD_INVALID' },
    });
  }
  if (json === undefined || Buffer.byteLength(json) > MAX_EVENT_PAYLOAD_BYTES) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: {
        reason: 'PLUGIN_EVENT_PAYLOAD_INVALID',
        limitBytes: MAX_EVENT_PAYLOAD_BYTES,
      },
    });
  }
}

function normalizeOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'INTEGER_INVALID' } });
  }
  return value as number;
}

function requireStorageKey(value: unknown): string {
  const key = requireString(value, 'key');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(key)) {
    throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'STORAGE_KEY_INVALID' } });
  }
  return key;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isMessage(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      Array.isArray(item) ? String(item[0] ?? '') : String(item ?? ''),
    ]),
  );
}

function normalizeHeaders(value: unknown): Record<string, string | undefined> {
  if (!isMessage(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      Array.isArray(item) ? item.join(', ') : item === undefined ? undefined : String(item),
    ]),
  );
}

function normalizeResponseHeaders(value: unknown): Record<string, string> {
  if (!isMessage(value)) return {};
  const forbidden = new Set(['set-cookie', 'connection', 'transfer-encoding', 'content-length']);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, item]) => !forbidden.has(name.toLowerCase()) && typeof item === 'string')
      .slice(0, 50),
  ) as Record<string, string>;
}

function normalizeStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function minimalWorkerEnvironment(
  pluginId: string,
  packageRoot: string,
  workerPath: string,
  limits?: PluginResourceLimits,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NEOTA_PLUGIN_ID: pluginId,
    NEOTA_PLUGIN_PACKAGE_ROOT: packageRoot,
    NEOTA_PLUGIN_WORKER_URL: pathToFileURL(workerPath).href,
    NEOTA_PLUGIN_WORKER_PATH: workerPath,
    NODE_NO_WARNINGS: '1',
  };
  // Versioned limits handshake (ТЗ RES-09): the worker may expose its own
  // budget in diagnostics; the payload itself carries no secrets.
  if (limits) env['NEOTA_PLUGIN_RESOURCE_LIMITS'] = JSON.stringify(limits);
  // Bare imports are only unlocked when the built-in dependency installer
  // materialized a verified node_modules (marked by .neotavern-deps.json). The
  // loader still confines every resolved path to the package root, and
  // node:/data:/http(s): specifiers stay denied either way.
  if (existsSync(join(packageRoot, 'node_modules', DEPENDENCY_MARKER_FILE))) {
    env['NEOTA_PLUGIN_ALLOW_BARE_IMPORTS'] = '1';
  }
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function consumeOutput(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  // Stream teardown can race with process exit; an unlistened 'error' here
  // would crash the host.
  stream.on('error', () => undefined);
  stream.setEncoding('utf8');
  let buffered = '';
  stream.on('data', (chunk: string) => {
    buffered = `${buffered}${chunk}`.slice(-8192);
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line) onLine(line);
  });
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check for worker→host RPC envelopes (never trust IPC shapes). */
function isRpcMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RpcMessage {
  return (
    typeof value['requestId'] === 'string' &&
    typeof value['method'] === 'string' &&
    isMessage(value['args'])
  );
}

/** Whether an object looks like a PluginResponse envelope ({status,headers,body}). */
function isResponseEnvelope(value: Record<string, unknown>): boolean {
  return 'status' in value || 'headers' in value || 'body' in value;
}

/** rev4 §D: route invocation resolved with a streamed body marker. */
function isStreamResponse(
  value: unknown,
): value is { kind: 'stream-response'; status?: unknown; headers?: unknown; pipe: PassThrough } {
  return (
    isMessage(value) && value['kind'] === 'stream-response' && value['pipe'] instanceof PassThrough
  );
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 2000) : '';
}

/** Read a response stream up to `limit` bytes; over-limit bodies fail. */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        throw new AppError({ code: ErrorCodes.FILE_TOO_LARGE, params: { limitBytes: limit } });
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
