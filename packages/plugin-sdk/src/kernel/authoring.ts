/**
 * Plugin SDK revision-4 kernel: the typed authoring surface handed to a
 * sandboxed frontend plugin's `activate()` (rev4 §A3) and to a backend
 * plugin's worker entry.
 *
 * The concrete implementation lives in the host (`apps/web` kernel handlers
 * + `apps/server/src/plugin/sandboxRev4.ts` for the frontend, and
 * `apps/server/worker/plugin-worker.mjs` for the backend). This module only
 * declares the compile-time contract so plugin authors can write TypeScript
 * against `@neotavern/plugin-sdk` and bundle with any toolchain — the types are
 * erased at build time and the sandbox never imports this package.
 */
import type { CursorPage, Message } from '@neotavern/contracts';
import type { NotificationDef, Unregister } from '../frontend.js';
import type { CapabilityGrant, CapabilityRequest } from './capabilities.js';
import type { KernelAuthApi } from './auth.js';
import type { KernelDiagnosticsApi } from './diagnostics.js';
import type { KernelServicesApi } from './services.js';
import type { KernelWorkersApi } from './workers.js';
import type { PluginLimits } from './limits.js';

/** Key-value storage scopes (contract §2 storage.kv). */
export type KernelKvScope = 'installation' | 'user' | 'workspace' | 'chat';

/** Overlay hit-testing models (rev4 §A4 / contract §2 overlays). */
export type KernelOverlayMode = 'native' | 'proxy' | 'full' | 'none';

/** Normalized pointer packet forwarded to `proxy` overlays (contract §2). */
export interface KernelOverlayPointerPacket {
  type: 'down' | 'move' | 'up' | 'cancel';
  /** Normalized 0..1 coordinates relative to the overlay rect. */
  x: number;
  y: number;
  button: number;
  pressure: number;
  /** Browser pointer id, for gesture correlation across packets. */
  pointerId: number;
  /** Host-assigned monotonic packet counter per overlay. */
  sequence: number;
  /** Host epoch millis when the event was captured. */
  timestamp: number;
}

/**
 * Hit shape in overlay-local CSS pixels (rev4 §A4). `native` overlays render
 * these as SVG clip primitives (browser hit-testing follows the shapes);
 * `proxy` overlays point-test them before forwarding packets. Absent shapes
 * mean the whole rect is interactive. Caps: `limits.overlays.maxShapes`,
 * `maxPolygonPoints`, `maxGeometryBytes`.
 */
export type KernelOverlayShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: ReadonlyArray<readonly [number, number]> };

/** Viewport-pixel rectangle for overlay registration/updates. */
export interface KernelOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Surface kinds a kernel plugin may register (contract §2). */
export type KernelSurfaceKind =
  | 'toolbarActions'
  | 'messageActions'
  | 'contextMenuItems'
  | 'sidebarPanels'
  | 'characterTabs'
  | 'dialogs'
  | 'pages'
  | 'settingsPanels'
  | 'slash'
  | 'hotkeys'
  | 'messageRenderers'
  | 'commands';

/** Pull-based inbound byte stream (host → plugin), credit-managed (rev4 §D). */
export interface KernelInboundStream {
  readonly meta: Record<string, unknown>;
  /** Next chunk; `null` marks a clean end. Rejects when the stream failed. */
  pull(): Promise<Uint8Array | null>;
  /** Convenience: drain the whole stream into one buffer. */
  readAll(): Promise<Uint8Array>;
  /** Abort the stream and release host-side buffers. */
  cancel(): void;
}

export interface KernelOperationOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  idempotencyKey?: string;
}

// ── runtime / capabilities ──────────────────────────────────────────────────

export interface KernelRuntimeApi {
  /** Feature negotiation (rev4 §A4): true when the host supports `version`. */
  supports(feature: string, version?: number): boolean;
  /** Programmatic limits (rev4 invariant 7). */
  limits(): PluginLimits;
  readonly protocolVersion: string;
  readonly sdkVersion: string;
}

export interface KernelCapabilitiesApi {
  list(): Promise<CapabilityGrant[]>;
  granted(name: string): boolean;
  /**
   * Request a runtime capability grant (rev4 §B2). Requires a host consent
   * round-trip: the consent dialog shows the capability (and scope), the user
   * decides, and the grant is persisted server-side. Rejects with
   * `CAPABILITY_DENIED` on denial, timeout or when another consent is pending;
   * `BACKEND_UNAVAILABLE` when the server cannot be reached. Already-granted
   * capabilities resolve immediately.
   */
  request(request: CapabilityRequest): Promise<CapabilityGrant>;
  onRevoked(listener: (grant: CapabilityGrant) => void): Unregister;
}

// ── commands / surfaces ─────────────────────────────────────────────────────

export interface KernelCommandDef {
  title: string;
  description?: string;
  category?: string;
}

export interface KernelCommandHandle {
  readonly commandId: string;
  dispose(): Promise<unknown>;
}

export interface KernelSurfaceHandle {
  readonly surfaceId: string;
  dispose(): Promise<unknown>;
}

export interface KernelCommandsApi {
  register(
    id: string,
    definition: KernelCommandDef,
    runner: (context: unknown) => unknown,
    options?: { kernel?: boolean },
  ): Promise<KernelCommandHandle>;
  unregister(commandId: string): Promise<unknown>;
}

export interface KernelSurfacesApi {
  register(
    kind: KernelSurfaceKind,
    definition: Record<string, unknown>,
    runner: (container: unknown, context: unknown) => unknown,
    options?: { kernel?: boolean },
  ): Promise<KernelSurfaceHandle>;
  unregister(surfaceId: string): Promise<unknown>;
}

// ── notifications ───────────────────────────────────────────────────────────

export interface KernelNotificationsApi {
  /** Show a notification; returns a function dismissing it early. */
  show(notification: NotificationDef): Unregister;
  dismiss(registrationId: string): Promise<unknown>;
}

// ── storage ─────────────────────────────────────────────────────────────────

export interface KernelKvEntry {
  value: unknown;
  revision: number;
}

export interface KernelKvApi {
  get(scope: KernelKvScope, key: string): Promise<KernelKvEntry>;
  set(
    scope: KernelKvScope,
    key: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<{ revision: number }>;
  delete(scope: KernelKvScope, key: string): Promise<{ deleted: boolean; revision: number }>;
  list(scope: KernelKvScope): Promise<{ keys: string[]; revision: number }>;
}

export interface KernelBlobMeta {
  blobId: string;
  hash: string;
  size: number;
  name: string;
  contentType: string;
  createdAt: number;
}

export interface KernelBlobsApi {
  put(
    name: string,
    contentType: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<{ blobId: string; hash: string; size: number }>;
  get(blobId: string): Promise<{ bytes: Uint8Array; contentType: string; size: number }>;
  list(): Promise<{ items: KernelBlobMeta[] }>;
  delete(blobId: string): Promise<{ deleted: boolean }>;
}

export interface KernelStorageApi {
  readonly kv: KernelKvApi;
  readonly blobs: KernelBlobsApi;
}

// ── backend bridge ──────────────────────────────────────────────────────────

export interface KernelBackendResponse {
  status: number;
  headers: Record<string, string>;
  body: KernelInboundStream;
}

export interface KernelBackendRequestOptions extends KernelOperationOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | ArrayBuffer;
}

export interface KernelBackendApi {
  /** Universal request API; streaming is a property of the response (rev4 §D1). */
  request(path: string, options?: KernelBackendRequestOptions): Promise<KernelBackendResponse>;
  /** JSON convenience over {@link request} (rev4 §D1). */
  invoke<Input, Output>(
    path: string,
    input: Input,
    options?: KernelOperationOptions & { method?: string },
  ): Promise<Output>;
}

// ── chats ───────────────────────────────────────────────────────────────────

export interface KernelChatInfo {
  chatId: string;
  title?: string;
}

/**
 * Streaming drafts (rev4 stage 3) are server-side objects: appends are
 * coalesced by the host (flush rate is an internal policy) and only `commit`
 * materializes the final `assistant` message. `commit` is retry-safe — a
 * retry after a lost response returns the same messageId.
 */
export interface KernelChatDraftApi {
  start(options?: { chatId?: string }): Promise<{ draftId: string }>;
  append(draftId: string, text: string): Promise<unknown>;
  /** Finalize the draft as an `assistant` message (idempotent). */
  commit(draftId: string): Promise<{ messageId: string }>;
  /** Discard the draft; no message is ever created. */
  abort(draftId: string): Promise<unknown>;
}

export interface KernelChatsApi {
  current(): Promise<KernelChatInfo | null>;
  listMessages(options?: {
    chatId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Pick<CursorPage<Message>, 'items' | 'nextCursor'>>;
  /**
   * Append a `plugin`-role message (capability `chats.write.plugin`).
   * `idempotencyKey` dedupes retried appends: a replay returns the original
   * message instead of duplicating it (rev4 stage 3 outbox).
   */
  append(options: {
    chatId?: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<{ messageId: string }>;
  readonly draft: KernelChatDraftApi;
}

// ── message blocks ──────────────────────────────────────────────────────────

export interface KernelBlockRendererDef {
  title?: string;
  mount(
    container: HTMLElement,
    descriptor: unknown,
  ): void | (() => void) | Promise<void | (() => void)>;
  serialize?(container: HTMLElement): unknown;
  restore?(container: HTMLElement, state: unknown): void;
}

export interface KernelBlockRendererHandle {
  readonly rendererId: string;
  dispose(): Promise<unknown>;
}

export interface KernelBlocksApi {
  registerRenderer(
    blockType: string,
    definition: KernelBlockRendererDef,
  ): Promise<KernelBlockRendererHandle>;
  attach(messageId: string, blockType: string, descriptor?: unknown): Promise<{ blockId: string }>;
}

// ── overlays ───────────────────────────────────────────────────────────────

export interface KernelOverlayHandle {
  readonly registrationId: string;
  /** Replace geometry and/or hit shapes; both optional. */
  update(rect?: KernelOverlayRect, hitShapes?: KernelOverlayShape[]): Promise<unknown>;
  dispose(): Promise<unknown>;
  /** `proxy` mode only: receive normalized pointer packets (rev4 §A4). */
  onPointer(callback: (packet: KernelOverlayPointerPacket) => void): Unregister;
}

export interface KernelOverlaysApi {
  register(
    mode: KernelOverlayMode,
    options?: { initialRect?: KernelOverlayRect; hitShapes?: KernelOverlayShape[] },
  ): Promise<KernelOverlayHandle>;
}

// ── jobs / network / actions ────────────────────────────────────────────────

export interface KernelJob {
  jobId: string;
  name: string;
  runAt?: number;
  intervalMs?: number;
  /** 5-field cron expression (rev4 stage 5). */
  cron?: string;
  payload?: unknown;
  /** 'failed' = in the DLQ (never dispatched until `retry`). */
  status: 'active' | 'failed';
  /** Consecutive failed attempts (reset on success). */
  attempts: number;
  maxRetries?: number;
  lastError?: string;
  failedAt?: number;
}

export interface KernelJobRunContext {
  jobId: string;
  name: string;
  payload?: unknown;
}

export interface KernelJobsApi {
  schedule(spec: {
    name: string;
    /** One-shot at this epoch ms (fire-and-forget unless `retries`). */
    runAt?: number;
    /** Fixed-interval schedule; fires one interval after scheduling. */
    intervalMs?: number;
    /** 5-field cron (minute hour dom month dow); exclusive with the above. */
    cron?: string;
    payload?: unknown;
    /**
     * Retry budget: after the initial failure the job may fail this many
     * more times before landing in the DLQ (0 = no retries, fire-and-forget).
     * With `retries > 0` the dispatch is held until `ack` reports the
     * outcome; a missing ack times out server-side after 5 minutes and
     * counts as a failed attempt.
     */
    retries?: number;
    /** Base backoff in ms; each retry doubles it (default 5000, cap 1h). */
    retryDelayMs?: number;
  }): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<unknown>;
  list(): Promise<{ items: KernelJob[] }>;
  /**
   * Report the outcome of a dispatch (rev4 stage 5). Idempotent: acks for
   * finished, never-dispatched or DLQ jobs are no-ops.
   */
  ack(jobId: string, outcome: { ok: boolean; error?: string }): Promise<{ acknowledged: boolean }>;
  /** Re-enqueue a DLQ job; it fires on the next runner scan. */
  retry(jobId: string): Promise<unknown>;
  /** Handle due-job dispatches; a new subscription replaces the previous. */
  onRun(callback: (context: KernelJobRunContext) => unknown): Unregister;
}

export interface KernelNetworkApi {
  /**
   * Allowlisted outbound fetch routed through the host (rev4 §M2). With
   * `connectionId` the request is signed server-side with the stored OAuth
   * token (rev4 §K5) — the sandbox never sees the token; `authSecretRef`
   * and `connectionId` are mutually exclusive.
   */
  fetch(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      authSecretRef?: string;
      connectionId?: string;
    },
  ): Promise<{ status: number; headers: Record<string, string>; bodyText: string }>;
}

export interface KernelPickedFile {
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

export interface KernelActionsApi {
  perform(action: 'clipboard.read'): Promise<{ text: string }>;
  perform(action: 'clipboard.write', params: { text: string }): Promise<Record<string, never>>;
  perform(action: 'notifications.show', params?: NotificationDef): Promise<{ shown: boolean }>;
  perform(
    action: 'files.pick',
    params?: { accept?: string; multiple?: boolean },
  ): Promise<{ files: KernelPickedFile[] }>;
}

// ── the full kernel api ─────────────────────────────────────────────────────

/**
 * The API object handed to a rev4 kernel frontend plugin's `activate()`.
 * Extends the v2 surface (`ui`, `i18n`, `slash`, `interceptors`, `events`,
 * `notify`) with the kernel namespaces (rev4 §A3).
 */
export interface KernelPluginApi {
  readonly pluginId: string;
  readonly runtime: KernelRuntimeApi;
  readonly limits: () => PluginLimits;
  readonly diagnostics: KernelDiagnosticsApi;
  readonly capabilities: KernelCapabilitiesApi;
  readonly auth: KernelAuthApi;
  readonly services: KernelServicesApi;
  readonly commands: KernelCommandsApi;
  readonly surfaces: KernelSurfacesApi;
  readonly notifications: KernelNotificationsApi;
  readonly storage: KernelStorageApi;
  readonly backend: KernelBackendApi;
  readonly chats: KernelChatsApi;
  readonly blocks: KernelBlocksApi;
  readonly overlays: KernelOverlaysApi;
  readonly jobs: KernelJobsApi;
  /** Isolated compute workers (rev4 §C2, capability `compute.worker`). */
  readonly workers: KernelWorkersApi;
  readonly network: KernelNetworkApi;
  readonly actions: KernelActionsApi;
  readonly events: {
    /**
     * Subscribe to a whitelisted app event over the kernel port (rev4 §E1).
     * Returns a promise resolving to an unsubscribe function; the host relay
     * is removed automatically on disable/frame reset.
     */
    subscribe(event: string, listener: (payload: unknown) => void): Promise<Unregister>;
    /** Explicit unsubscribe; idempotent for unknown pairs. */
    unsubscribe(event: string, listener: (payload: unknown) => void): Promise<void>;
    onKernelRevoked(listener: (grant: CapabilityGrant) => void): Unregister;
  };
  /** Show a notification; returns a function to dismiss it early. */
  notify(notification: NotificationDef): Unregister;
}

/** A rev4 kernel frontend plugin definition. */
export interface KernelPluginDefinition {
  activate(api: KernelPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * Identity helper for authoring kernel plugins with full typing:
 * ```ts
 * export default defineKernelPlugin({ activate(api) { ... } });
 * ```
 */
export function defineKernelPlugin(definition: KernelPluginDefinition): KernelPluginDefinition {
  return definition;
}

// ── backend worker authoring ────────────────────────────────────────────────

/** Request handed to a backend plugin route handler (worker runtime). */
export interface BackendRouteRequest {
  /** Path parameters extracted from the registered route pattern. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

/** Response a backend plugin route handler returns. */
export interface BackendRouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BackendRouteHandler {
  (request: BackendRouteRequest): BackendRouteResponse | Promise<BackendRouteResponse>;
}

export interface BackendRouter {
  get(path: string, handler: BackendRouteHandler): Unregister;
  post(path: string, handler: BackendRouteHandler): Unregister;
  put(path: string, handler: BackendRouteHandler): Unregister;
  delete(path: string, handler: BackendRouteHandler): Unregister;
}

export interface BackendPluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The API object handed to a backend plugin worker's `activate()`
 * (`apps/server/worker/plugin-worker.mjs`). Network, storage and events are
 * capability/permission gated by the host.
 */
export interface BackendPluginApi {
  readonly pluginId: string;
  readonly routes: BackendRouter;
  readonly storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    keys(): Promise<string[]>;
  };
  readonly events: {
    on(event: string, handler: (payload: unknown) => unknown): Unregister;
    off(event: string, handler: (payload: unknown) => unknown): void;
    emit(event: string, payload?: unknown): Promise<unknown>;
    clear(): void;
  };
  readonly logger: BackendPluginLogger;
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
  readonly files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<unknown>;
    list(path: string): Promise<string[]>;
    delete(path: string): Promise<unknown>;
  };
}

/** A backend plugin worker definition. */
export interface BackendPluginDefinition {
  activate(api: BackendPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Identity helper for authoring backend worker plugins with full typing. */
export function defineBackendPlugin(definition: BackendPluginDefinition): BackendPluginDefinition {
  return definition;
}
