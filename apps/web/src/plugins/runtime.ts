/** Browser host for sandboxed frontend plugins and serializable UI registrations. */
import { useMemo, useSyncExternalStore } from 'react';
import type { i18n } from 'i18next';
import type { InstalledPlugin } from '@neotavern/contracts';
import { randomToken } from '@neotavern/shared';
import { kernel } from '@neotavern/plugin-sdk';
import { attachKernelServices } from './kernel/index.js';
import { WindowRoleManager, type WindowRoleSnapshot } from './windows.js';
import { RUN_DEADLINE_MS } from './kernel/commands.js';
import { snapshotPluginUiTokens } from './themeTokens.js';
import { slotRegistry, slotsContributionFromDefinition } from './slots.js';

/**
 * Permissions-Policy directives denied in every plugin sandbox iframe.
 * `allow` overrides the default inheritance so the plugin can never observe
 * the user's devices, camera/microphone, location, local network, clipboard,
 * fonts, high-entropy UA data or credential flows — even if the app's own
 * policy ever broadens. Unknown directive names are ignored by browsers, so
 * the list is forward-compatible with future features (rev4 §0, §E).
 */
const PLUGIN_IFRAME_DENIED_FEATURES = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'serial',
  'hid',
  'bluetooth',
  'midi',
  'xr-spatial-tracking',
  'gyroscope',
  'accelerometer',
  'magnetometer',
  'ambient-light-sensor',
  'idle-detection',
  'window-management',
  'display-capture',
  'fullscreen',
  'clipboard-read',
  'clipboard-write',
  'battery',
  'local-fonts',
  'ch-ua-high-entropy-values',
  'browsing-topics',
  'attribution-reporting',
  'private-state-token-issuance',
  'private-state-token-redemption',
  'identity-credentials-get',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'otp-credentials',
  'storage-access',
  'local-network',
  'loopback-network',
  'screen-wake-lock',
  'speaker-selection',
  'gamepad',
  'captured-surface-control',
  'compute-pressure',
  'language-model',
  'language-detector',
  'summarizer',
  'translator',
  'on-device-speech-recognition',
  'picture-in-picture',
  'encrypted-media',
  'web-share',
]
  .map((feature) => `${feature} 'none'`)
  .join('; ');

export type PluginRegistrationKind =
  | 'messageActions'
  | 'toolbarActions'
  | 'pages'
  | 'settingsPanels'
  | 'sidebarPanels'
  | 'contextMenuItems'
  | 'messageRenderers'
  | 'characterTabs'
  | 'dialogs'
  | 'commands'
  | 'hotkeys'
  | 'slash'
  | 'interceptors'
  | 'slots'
  | 'overlays'
  | 'messageBlocks';

export interface PluginUiRegistration {
  pluginId: string;
  pluginName: string;
  registrationId: string;
  kind: PluginRegistrationKind;
  /** rev4 §A4: registered over the kernel port; host UI mounts it kernel-side. */
  kernel?: boolean;
  definition: {
    id: string;
    title: string;
    path?: string;
    slot?: string;
    context?: string;
    combo?: string;
    icon?: string;
    description?: string;
    placement?: string;
    priority?: number;
    timeoutMs?: number;
    /** Lower renders first (message actions). Default 100. */
    order?: number;
    /** Declarative slot contributions: v2 permission gate (optional). */
    permission?: string;
    /** Declarative slot contributions: what the button does (ТЗ §53). */
    action?: { type: 'command'; commandId: string } | { type: 'event'; event: string };
    /** rev4 §A4: registered via kernel `commands/surfaces.register`. */
    kernel?: boolean;
  };
}

/** One retained app event in the rev4 §J1 replay buffer. */
export interface AppEventRecord {
  /** Per-event-name monotonic sequence; the stable dedupe key. */
  seq: number;
  ts: number;
  payload: unknown;
}

/** Bounded read of the replay buffer (rev4 §J1). */
export interface AppEventHistoryWindow {
  /** Records after `afterSeq`, chronological, bounded. */
  records: AppEventRecord[];
  /** Lowest retained sequence, or null when nothing is retained. */
  lowestSeq: number | null;
  /** Highest recorded sequence, or null when nothing was recorded. */
  headSeq: number | null;
}

/** Max retained records per event name (rev4 §J1 replay window). */
export const APP_EVENT_HISTORY_PER_EVENT = 128;
/** Max retained records across all event names. */
export const APP_EVENT_HISTORY_TOTAL = 4096;
/** Retention TTL: entries older than this are dropped from replay. */
export const APP_EVENT_HISTORY_TTL_MS = 60_000;

export interface RuntimeFrame {
  /** Stable per-creation identity; chrome ownership is tracked by frame, not
   *  by plugin id, so stale flushes of replaced frames are inert. */
  frameId: string;
  plugin: InstalledPlugin;
  host: HTMLDivElement;
  iframe: HTMLIFrameElement;
  /** SVG definition shared by the iframe clip-path; never interactive. */
  clipSvg: SVGSVGElement;
  clipPath: SVGClipPathElement;
  removalTimer?: ReturnType<typeof setTimeout>;
  replacement?: InstalledPlugin;
  subscriptions: Set<string>;
  /** Set once the sandbox document finishes its initial load. */
  initialLoadDone: boolean;
  /** Independent layout observers and clip rectangles for every mounted root. */
  overlays: Map<string, MountOverlay>;
  layoutFrame: AnimationHandle | null;
  /** rev4 §A4: host hit-divs above the iframe proxy pointer packets. */
  hitLayer: HTMLDivElement | null;
  /** rev4 §A4: per-frame revision counter for `ui.overlay.layout` pushes. */
  overlayLayoutRevision: number;
  /** rev4 §A4: last pushed rect fingerprint; identical pushes are skipped. */
  lastOverlayLayoutKey: string | null;
  /** rev4 §A4: installed by kernel/overlays.ts; receives kernel overlay rects. */
  overlayLayoutSync?: (rects: OverlayLayoutRect[]) => void;
  /** rev4 §A1 kernel session; null until the sandbox ACKs the bootstrap. */
  session: kernel.KernelSession | null;
  /** rev4 §J3: sandbox-declared installation identity (from the handshake). */
  installationId?: string;
  /** rev4 §M3: liveness-probe interval handle; cleared on finalize. */
  pingTimer?: number;
  /** rev4 §B2: plugin-side revocation observers fed by the kernel port. */
  revocationListeners: Set<(name: string, revision: number) => void>;
  /** rev4 §A4: host containers bound to kernel surface registrations. */
  surfaceContainers: Map<string, HTMLElement>;
}

/** rev4 §D: a published cross-plugin service (provider side of the registry). */
export interface RuntimeServiceEntry {
  /** Host-prefixed identity: `'<providerPluginId>.<name>'`. */
  serviceId: string;
  providerPluginId: string;
  name: string;
  methods: string[];
  version?: string;
  description?: string;
  /** Normalized per-call deadline (host-capped). */
  timeoutMs: number;
}

type AnimationHandle = number | ReturnType<typeof setTimeout>;

export interface MountOverlay {
  container: HTMLElement;
  context: unknown;
  /** Mount only after the host surface has a non-zero rectangle. */
  mountSent: boolean;
  stopTracking: () => void;
  /**
   * rev4 §A4 hit policy. Absent on v2 mountPage entries; kernel overlays
   * always carry one. 'native' and 'proxy' rects join the iframe clip union
   * (native: browser hit-testing inside the shapes, visual clipped to them;
   * proxy: visuals stay visible while host hit-divs forward normalized
   * pointer packets); 'none' joins the clip with an absorbing host hit-div
   * (visible, non-interactive); one live 'full' overlay unclips the whole
   * iframe.
   */
  hitPolicy?: OverlayHitPolicy;
  /**
   * rev4 §A4: optional hit shapes in overlay-local pixels. 'native' renders
   * them as SVG clip primitives inside the union; 'proxy' point-tests them
   * before forwarding packets. Absent means the whole rect is interactive.
   */
  hitShapes?: OverlayShape[];
  /** rev4 §A4: sliding 1s window enforcing `overlays.maxUpdatesPerSecond`. */
  updateWindow?: { count: number; resetAt: number };
  /** proxy only: the host hit-div capturing pointer events for this rect. */
  hitDiv?: HTMLDivElement;
  /** proxy only: removes the hit-div and its listeners. */
  stopHitProxy?: () => void;
  /** rev4 §A4: kernel surface root rendered by the host, not the sandbox. */
  kernel?: boolean;
  /** rev4 §A4: kernel surfaces only; stops the live target rect tracking. */
  trackTarget?: () => void;
}

/** rev4 §A4: how pointer events over a kernel overlay rect reach the plugin. */
export type OverlayHitPolicy = 'native' | 'proxy' | 'full' | 'none';

/**
 * rev4 §G7: host overlay chrome — while a 'full' overlay is live the host
 * keeps a shell indicator (plugin name + host-controlled close) above every
 * plugin layer but below host modals, so the user always knows a plugin
 * overlay is active and can always dismiss it.
 */
export interface OverlayChromeState {
  active: boolean;
  pluginId: string;
  pluginName: string;
  registrationId: string;
  /** Owning frame instance; a stale layout flush from a replaced frame must
   *  never close the chrome of a newer frame from the same plugin. */
  frameId: string;
}

const INACTIVE_OVERLAY_CHROME: OverlayChromeState = {
  active: false,
  pluginId: '',
  pluginName: '',
  registrationId: '',
  frameId: '',
};

/**
 * rev4 §A4 hit shape in overlay-local CSS pixels (origin at the overlay
 * rect). Absent shapes mean the whole rect is interactive. 'native' renders
 * these as SVG clip primitives (browser hit-testing follows the shapes);
 * 'proxy' point-tests them host-side before forwarding packets.
 */
export type OverlayShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: ReadonlyArray<readonly [number, number]> };

/** One kernel overlay rectangle pushed via `ui.overlay.layout` (contract §2). */
export interface OverlayLayoutRect {
  registrationId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** rev4 §A4: validated overlay rectangle in viewport pixels. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * rev4 §A4: normalized pointer packet forwarded to the plugin (contract §2).
 * Coordinates are normalized to the overlay rect (0..1); `pointerId` and
 * `sequence` let the plugin correlate a gesture across packets. `isTrusted`
 * semantics are never promised — packets are not synthetic PointerEvents.
 */
export interface OverlayPointerPacket {
  type: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  button: number;
  pressure: number;
  pointerId: number;
  sequence: number;
  timestamp: number;
}

/** rev4 §A4: point-in-shape test for proxy overlays (overlay-local px). */
export function overlayShapeContains(shape: OverlayShape, x: number, y: number): boolean {
  switch (shape.kind) {
    case 'rect':
      return (
        x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height
      );
    case 'circle': {
      const dx = x - shape.cx;
      const dy = y - shape.cy;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case 'ellipse': {
      const dx = (x - shape.cx) / shape.rx;
      const dy = (y - shape.cy) / shape.ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'polygon': {
      // Ray casting; points on an edge count as inside.
      let inside = false;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const pi = pts[i];
        const pj = pts[j];
        if (!pi || !pj) continue;
        const [xi, yi] = pi;
        const [xj, yj] = pj;
        if (yi > y !== yj > y && x <= ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

/**
 * App events that carry chat content. Mirrors CHAT_CONTENT_EVENTS in
 * apps/server/src/plugin/backendHost.ts — subscribing to them requires the
 * `chat.read` permission (ТЗ §7.4, ADR-0007) on both hosts.
 */
const CHAT_CONTENT_EVENTS = new Set([
  'generation.started',
  'generation.delta',
  'generation.finished',
  'generation.error',
  'chat.message.created',
  'chat.message.updated',
  'chat.message.deleted',
]);

/**
 * Total time budget for the whole browser-side prompt interceptor chain.
 * Below the server broker's 2.5s rendezvous window (generate.ts) so a slow
 * plugin can never make the browser POST into an already-expired request.
 */
const INTERCEPT_CHAIN_BUDGET_MS = 2_000;

interface SandboxMessage {
  type: string;
  pluginId: string;
  registrationId?: string;
  kind?: string;
  definition?: unknown;
  language?: unknown;
  resources?: unknown;
  notification?: unknown;
  invocationId?: string;
  ok?: boolean;
  value?: unknown;
  error?: unknown;
  event?: unknown;
  payload?: unknown;
}

interface PendingInvocation {
  /** Owning plugin — results are only accepted from this plugin's frame. */
  pluginId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** rev4 §B2: a capability consent awaiting a user decision in the host UI. */
export interface PendingConsent {
  pluginId: string;
  pluginName: string;
  request: kernel.CapabilityRequest;
}

/** Internal consent queue entry (UI snapshot plus promise plumbing). */
interface PendingConsentRecord extends PendingConsent {
  resolve(grant: kernel.CapabilityGrant): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** While the consent dialog is open, further requests from the same plugin fail. */
const CONSENT_DIALOG_TIMEOUT_MS = 60_000;

const REQUIRED_PERMISSION: Partial<Record<PluginRegistrationKind, string>> = {
  messageActions: 'ui.messageActions',
  toolbarActions: 'ui.toolbar',
  pages: 'ui.shell',
  settingsPanels: 'ui.sidebar',
  sidebarPanels: 'ui.sidebar',
  contextMenuItems: 'ui.messageActions',
  messageRenderers: 'chat.read',
  characterTabs: 'characters.read',
  dialogs: 'ui.shell',
  commands: 'ui.toolbar',
  hotkeys: 'ui.toolbar',
  slash: 'chat.write',
  interceptors: 'prompt.modify',
  slots: 'ui.slots',
};

/** rev4 §A4: feature registry advertised in the host handshake. */
const HOST_SUPPORTED_FEATURES: Record<string, number> = {
  'ui.overlays': 3,
  'backend.byte-stream': 1,
  'storage.kv': 1,
  'storage.blobs': 1,
  'ui.commands': 1,
  'ui.surfaces': 1,
  'ui.messageBlock': 1,
  'chat.draft': 1,
  'chat.events': 1,
  'jobs.background': 1,
  'compute.worker': 1,
  'network.proxy': 1,
  'auth.connections': 1,
  'lifecycle.hooks': 1,
  'events.cursor': 1,
  'windows.multiwindow': 1,
  services: 1,
  'actions.host': 1,
  'ui.notifications': 1,
  'models.list': 1,
};

/** Diagnostics listing cap: mirrors `capabilities.list` (rev4 §C). */
const MAX_DIAGNOSTIC_GRANTS = 64;
/** rev4 §D: hard cap on live cross-plugin connections host-wide. */
const MAX_SERVICE_CONNECTIONS = 256;

function randomConnectionToken(): string {
  return `conn-${randomToken(16)}`;
}

export class FrontendPluginRuntime {
  private readonly frames = new Map<string, RuntimeFrame>();
  private readonly registrations = new Map<string, PluginUiRegistration>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingInvocation>();
  /** i18n bundle languages added per plugin, removed on teardown (SDK cleanup). */
  private readonly i18nLanguages = new Map<string, Set<string>>();
  private snapshot: readonly PluginUiRegistration[] = [];
  private hiddenRoot: HTMLElement | null = null;
  private i18n: i18n | null = null;
  private currentChatIdValue: string | null = null;
  private activeProviderConfigIdValue: string | null = null;
  private eventSource: EventSource | null = null;
  /** Theme-token sync to sandboxed UI (api.ui.modelMenu). */
  private themeTokenObserver: MutationObserver | null = null;
  private themeTokenPushFrame: number | null = null;
  /** rev4 §2: host-side kernel listeners for SSE-relayed app events. */
  private readonly appEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  /**
   * rev4 §J1: bounded per-event ring buffer of app events (recording happens
   * before listener dispatch). Subscriptions with a cursor replay events
   * after it; the window is bounded so memory stays flat (invariant 5).
   */
  private readonly appEventHistory = new Map<string, AppEventRecord[]>();
  private readonly appEventSeq = new Map<string, number>();
  private readonly appEventHistoryOrder: Array<{ event: string; seq: number }> = [];
  /** rev4 §B2: capability consents awaiting a user decision (one per plugin). */
  private readonly pendingConsents = new Map<string, PendingConsentRecord>();
  /** rev4 §D: host-owned cross-plugin service registry (per-provider entries). */
  private readonly serviceRegistry = new Map<string, RuntimeServiceEntry>();
  /** rev4 §D: consumer bindings; keyed by connectionId, scoped to a consumer. */
  private readonly serviceConnections = new Map<
    string,
    { connectionId: string; consumerPluginId: string; serviceId: string }
  >();
  private readonly consentListeners = new Set<() => void>();
  /** Stable snapshot cache so useSyncExternalStore never sees new identity. */
  private consentSnapshotCache: { key: string; value: readonly PendingConsent[] } | null = null;
  /** rev4 §G7: host overlay chrome (plugin name + close) while a 'full' overlay is live. */
  private readonly overlayChromeListeners = new Set<() => void>();
  private overlayChromeValue: OverlayChromeState = INACTIVE_OVERLAY_CHROME;
  private frameSeq = 0;
  /**
   * rev4 §M3: crash-isolation policy. The host pings every live session;
   * a sandbox whose main thread stops answering (hung or crashed) is
   * restarted under a budget and finally disabled (crash-loop). Tests
   * shrink the interval/deadline; defaults are calibrated for real plugins.
   */
  readonly crashPolicy: {
    pingIntervalMs: number;
    pingDeadlineMs: number;
    maxRestarts: number;
    windowMs: number;
  } = {
    pingIntervalMs: 10_000,
    pingDeadlineMs: 3_000,
    maxRestarts: 3,
    windowMs: 10 * 60_000,
  };
  /** rev4 §M3: per-plugin crash timestamps inside the restart window. */
  private readonly crashHistory = new Map<string, number[]>();
  /**
   * rev4 §J2: per-plugin in-flight lifecycle hook promises. Frame teardown
   * (update replacement, disable, uninstall) awaits the latest hook before
   * disposing the session — a `beforeUpdate`/`afterUpdate` hook's final
   * writes must not be cut off by the port closing mid-flight. The promises
   * are bounded by the hook RPC deadline (1500 ms), so the await is bounded.
   */
  private readonly lifecyclePending = new Map<string, Promise<unknown>>();
  private readonly onAppEventRevoked = (payload: unknown): void => {
    const record = payload as { pluginId?: unknown; name?: unknown; revision?: unknown };
    if (typeof record?.pluginId !== 'string' || typeof record.name !== 'string') return;
    const frame = this.frames.get(record.pluginId);
    if (!frame) return;
    const revision = typeof record.revision === 'number' ? record.revision : 0;
    frame.session?.notifyCapabilityRevoked(record.name, revision);
    frame.iframe.contentWindow?.postMessage(
      {
        type: 'neotavern.capability.revoked',
        pluginId: record.pluginId,
        name: record.name,
        revision,
      },
      '*',
    );
    // Keep the live frame grant list in sync with the server so enforcement
    // points (kernelHasCapability, capability list) stop honoring the grant
    // immediately, without waiting for a plugin-list refetch.
    const grants = frame.plugin.grantedCapabilities;
    const index = grants.findIndex((grant) => grant.name === record.name);
    if (index >= 0) grants.splice(index, 1);
    // rev4 §D: revoking the provider/consumer side stops cross-plugin
    // services immediately — no call survives a revoked grant.
    if (record.name === 'services.provide') this.kernelServiceRemoveByPlugin(record.pluginId);
    if (record.name === 'services.connect') this.kernelServiceRemoveByConsumer(record.pluginId);
    for (const listener of frame.revocationListeners) listener(record.name, revision);
  };
  private readonly onLanguageChanged = (language: string): void => {
    for (const frame of this.frames.values()) this.sendLanguage(frame, language);
    this.emitEvent('language.changed', { language });
  };
  constructor() {
    globalThis.addEventListener?.('message', (event) => this.onMessage(event as MessageEvent));
    // rev4 §J2: while the tab is hidden the host suspends every live plugin
    // sandbox (their rAF loops are throttled anyway); on return they resume.
    // The hooks are best-effort — a plugin without suspend()/resume() is
    // untouched.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.kernelSuspendAll();
        } else {
          this.kernelResumeAll();
        }
      });
    }
    // rev4 §J3: on tab close, release every background claim best-effort so
    // a surviving window takes over immediately (a killed renderer is still
    // covered by the lease expiry in WindowRoleManager).
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        for (const manager of this.windowRoleManagers.values()) manager.stop();
        this.windowRoleManagers.clear();
      });
    }
  }

  configureI18n(instance: i18n): void {
    this.i18n?.off('languageChanged', this.onLanguageChanged);
    this.i18n = instance;
    instance.on('languageChanged', this.onLanguageChanged);
  }

  sync(plugins: readonly InstalledPlugin[]): void {
    const wanted = new Map(
      plugins
        .filter((plugin) => plugin.enabled && plugin.hasFrontend)
        .map((plugin) => [plugin.id, plugin]),
    );
    for (const [pluginId, frame] of this.frames) {
      const next = wanted.get(pluginId);
      if (!next || next.version !== frame.plugin.version) this.removeFrame(pluginId, next);
    }
    for (const plugin of wanted.values()) {
      if (!this.frames.has(plugin.id)) this.createFrame(plugin);
    }
    this.syncEventStream();
  }

  clear(): void {
    for (const pluginId of [...this.frames.keys()]) this.removeFrame(pluginId);
    this.syncEventStream();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly PluginUiRegistration[] => this.snapshot;

  /** rev4 §A5: the app reports the focused chat so scope checks resolve. */
  setCurrentChatId(chatId: string | null): void {
    this.currentChatIdValue = chatId;
  }

  getCurrentChatId(): string | null {
    return this.currentChatIdValue;
  }

  /** rev4 §A5: the app reports the active provider config so `models.list`
   * resolves without an explicit providerId. */
  setActiveProviderConfigId(providerId: string | null): void {
    this.activeProviderConfigIdValue = providerId;
  }

  getActiveProviderConfigId(): string | null {
    return this.activeProviderConfigIdValue;
  }

  /** @internal rev4 kernel handlers (apps/web/src/plugins/kernel/*). */
  kernelAddRegistration(registration: PluginUiRegistration): void {
    if (this.registrations.has(registration.registrationId)) return;
    this.registrations.set(registration.registrationId, registration);
    this.publish();
  }

  /** @internal rev4 kernel handlers (apps/web/src/plugins/kernel/*). */
  kernelRemoveRegistration(registrationId: string): void {
    const registration = this.registrations.get(registrationId);
    if (registration) {
      const frame = this.frames.get(registration.pluginId);
      if (frame) {
        this.kernelUnmountSurface(frame, registrationId);
        this.removeOverlay(frame, registrationId, true);
      }
    }
    if (this.registrations.delete(registrationId)) this.publish();
  }

  /** @internal rev4 §A4: frame lookup for kernel slices and tests. */
  kernelGetFrame(pluginId: string): RuntimeFrame | undefined {
    return this.frames.get(pluginId);
  }

  /** @internal rev4 §A4: registration lookup for slice ownership checks. */
  kernelGetRegistration(registrationId: string): PluginUiRegistration | undefined {
    return this.registrations.get(registrationId);
  }

  /** rev4 §A4: feature negotiation over the host handshake registry. */
  kernelSupportedFeature(feature: string, version: number): boolean {
    return (HOST_SUPPORTED_FEATURES[feature] ?? 0) >= version;
  }

  /** @internal rev4 §C: read-only self-diagnostics snapshot. Never secrets. */
  kernelDiagnosticsSnapshot(frame: RuntimeFrame): kernel.DiagnosticsSnapshot {
    const plugin = frame.plugin;
    return {
      protocolVersion: kernel.PROTOCOL_VERSION,
      sdkVersion: kernel.KERNEL_SDK_VERSION,
      instanceId: frame.session?.instanceId ?? '',
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        apiVersion: plugin.apiVersion,
        status: plugin.status,
        lastErrorCode: plugin.lastErrorCode,
        compatibilityLevel: plugin.compatibilityLevel,
      },
      limits: kernel.mergeLimits(),
      features: { ...HOST_SUPPORTED_FEATURES },
      grants: Array.isArray(plugin.grantedCapabilities)
        ? plugin.grantedCapabilities.slice(0, MAX_DIAGNOSTIC_GRANTS).map((grant) => {
            const scope = kernel.parseCapabilityScope(grant.scope);
            return {
              name: grant.name,
              revision: grant.revision,
              grantedAt: grant.grantedAt,
              ...(scope ? { scope } : {}),
            };
          })
        : [],
      // rev4 §M3: crash-isolation state for the plugin's own diagnostics.
      crash: this.crashSnapshot(plugin.id),
    };
  }

  /** rev4 §M3: crash accounting for one plugin (never another plugin's). */
  private crashSnapshot(pluginId: string): kernel.DiagnosticsSnapshot['crash'] {
    const history = this.crashHistory.get(pluginId) ?? [];
    if (history.length === 0) return undefined;
    const now = Date.now();
    const recent = history.filter((at) => now - at <= this.crashPolicy.windowMs);
    return {
      count: history.length,
      lastAt: history[history.length - 1] ?? null,
      restartBudgetLeft: Math.max(0, this.crashPolicy.maxRestarts - recent.length),
    };
  }

  /** @internal rev4 kernel handlers: capability check over live grants. */
  kernelHasCapability(
    frame: RuntimeFrame,
    name: string,
    scope?: kernel.CapabilityRequest['scope'],
  ): boolean {
    return frame.plugin.grantedCapabilities.some((grant) =>
      kernel.grantSatisfies(
        { ...grant, scope: kernel.parseCapabilityScope(grant.scope) },
        scope === undefined ? { name } : { name, scope },
      ),
    );
  }

  /** @internal rev4 §D: publish a service; false when the id is already taken. */
  kernelServiceRegister(entry: RuntimeServiceEntry): boolean {
    if (this.serviceRegistry.has(entry.serviceId)) return false;
    this.serviceRegistry.set(entry.serviceId, entry);
    return true;
  }

  /** @internal rev4 §D: drop every service of a plugin and its connections. */
  kernelServiceRemoveByPlugin(pluginId: string): void {
    for (const [serviceId, entry] of this.serviceRegistry) {
      if (entry.providerPluginId === pluginId) this.serviceRegistry.delete(serviceId);
    }
    for (const [connectionId, connection] of this.serviceConnections) {
      const entry = this.serviceRegistry.get(connection.serviceId);
      if (entry?.providerPluginId === pluginId) {
        this.serviceConnections.delete(connectionId);
      }
    }
  }

  /** @internal rev4 §D: unregister one service (owner-only) + its connections. */
  kernelServiceRemoveService(serviceId: string, providerPluginId: string): boolean {
    const entry = this.serviceRegistry.get(serviceId);
    if (!entry) return false;
    if (entry.providerPluginId !== providerPluginId) return false;
    this.serviceRegistry.delete(serviceId);
    for (const [connectionId, connection] of this.serviceConnections) {
      if (connection.serviceId === serviceId) this.serviceConnections.delete(connectionId);
    }
    return true;
  }

  /** @internal rev4 §D: how many live connections a consumer currently holds. */
  kernelServiceConnectionCount(consumerPluginId: string): number {
    let count = 0;
    for (const connection of this.serviceConnections.values()) {
      if (connection.consumerPluginId === consumerPluginId) count += 1;
    }
    return count;
  }

  /** @internal rev4 §D: drop the consumer's own connections. */
  kernelServiceRemoveByConsumer(pluginId: string): void {
    for (const [connectionId, connection] of this.serviceConnections) {
      if (connection.consumerPluginId === pluginId) this.serviceConnections.delete(connectionId);
    }
  }

  /** @internal rev4 §D: live service descriptors (metadata only). */
  kernelServiceList(): RuntimeServiceEntry[] {
    return [...this.serviceRegistry.values()].map((entry) => ({ ...entry }));
  }

  /** @internal rev4 §D: entry lookup; undefined when absent. */
  kernelServiceGet(serviceId: string): RuntimeServiceEntry | undefined {
    return this.serviceRegistry.get(serviceId);
  }

  /** @internal rev4 §D: bind a consumer to a service; null when full. */
  kernelServiceCreateConnection(consumerPluginId: string, serviceId: string): string | null {
    if (this.serviceConnections.size >= MAX_SERVICE_CONNECTIONS) return null;
    const connectionId = randomConnectionToken();
    this.serviceConnections.set(connectionId, {
      connectionId,
      consumerPluginId,
      serviceId,
    });
    return connectionId;
  }

  /** @internal rev4 §D: connection lookup scoped to its consumer. */
  kernelServiceGetConnection(
    consumerPluginId: string,
    connectionId: string,
  ): { connectionId: string; consumerPluginId: string; serviceId: string } | undefined {
    const connection = this.serviceConnections.get(connectionId);
    if (!connection || connection.consumerPluginId !== consumerPluginId) return undefined;
    return connection;
  }

  /** @internal rev4 §D: release a consumer's connection. */
  kernelServiceRemoveConnection(consumerPluginId: string, connectionId: string): void {
    const connection = this.serviceConnections.get(connectionId);
    if (connection?.consumerPluginId === consumerPluginId) {
      this.serviceConnections.delete(connectionId);
    }
  }

  /** rev4 §B2: UI subscription for pending capability consents. */
  consentSubscribe = (listener: () => void): (() => void) => {
    this.consentListeners.add(listener);
    return () => this.consentListeners.delete(listener);
  };

  /** rev4 §B2: snapshot of consents awaiting a user decision. */
  consentGetSnapshot = (): readonly PendingConsent[] => {
    const entries = [...this.pendingConsents.values()];
    const key = entries.map((entry) => `${entry.pluginId}:${entry.request.name}`).join('\u0001');
    const cached = this.consentSnapshotCache;
    if (cached && cached.key === key) return cached.value;
    const value = entries.map(({ pluginId, pluginName, request }) => ({
      pluginId,
      pluginName,
      request,
    }));
    this.consentSnapshotCache = { key, value };
    return value;
  };

  private notifyConsentListeners(): void {
    for (const listener of this.consentListeners) {
      try {
        listener();
      } catch {
        // A failing UI listener must not break the consent queue.
      }
    }
  }

  /** rev4 §G7: external store for the host overlay chrome. */
  subscribeOverlayChrome = (listener: () => void): (() => void) => {
    this.overlayChromeListeners.add(listener);
    return () => this.overlayChromeListeners.delete(listener);
  };

  getOverlayChrome = (): OverlayChromeState => this.overlayChromeValue;

  private setOverlayChrome(next: OverlayChromeState): void {
    if (
      next.active === this.overlayChromeValue.active &&
      next.registrationId === this.overlayChromeValue.registrationId &&
      next.pluginName === this.overlayChromeValue.pluginName
    ) {
      return;
    }
    // Fresh object identity per change: useSyncExternalStore bails out of a
    // re-render when the snapshot is Object.is-equal (the shared INACTIVE
    // constant must never suppress the cleanup effects).
    this.overlayChromeValue = { ...next };
    for (const listener of this.overlayChromeListeners) {
      try {
        listener();
      } catch {
        // A failing chrome listener must not break the layout loop.
      }
    }
  }

  /**
   * rev4 §G7: host-controlled close of the live 'full' overlay (chrome
   * button or Escape). Graceful: the sandbox receives the unmount
   * notifications and disposes the overlay DOM; the host container and
   * hit proxy are removed either way.
   */
  closeFullOverlay(): void {
    const chrome = this.overlayChromeValue;
    if (!chrome.active) return;
    for (const frame of this.frames.values()) {
      if (frame.plugin.id !== chrome.pluginId) continue;
      if (!frame.overlays.has(chrome.registrationId)) break;
      if (this.registrations.has(chrome.registrationId)) {
        this.kernelRemoveRegistration(chrome.registrationId);
      } else {
        // Defensive: the kernel slice always registers overlays, but a stale
        // host entry must not keep the overlay hostage.
        this.kernelDisposeOverlay(frame, chrome.registrationId);
      }
      // Close is user-visible: the chrome disappears immediately, not on the
      // next layout flush.
      this.setOverlayChrome(INACTIVE_OVERLAY_CHROME);
      return;
    }
    // Stale chrome (frame already gone): clear it so the UI never lingers.
    this.setOverlayChrome(INACTIVE_OVERLAY_CHROME);
  }

  /**
   /** rev4 §M3: one liveness probe; a missed beat → crash handling. */
  private async probeFrame(frame: RuntimeFrame): Promise<void> {
    if (!frame.session || frame.session.isDisposed) return;
    if (this.frames.get(frame.plugin.id) !== frame) return;
    if (frame.removalTimer) return; // graceful teardown in progress
    try {
      await frame.session.call('kernel.ping', {}, { deadlineMs: this.crashPolicy.pingDeadlineMs });
    } catch {
      this.handleFrameCrash(frame);
    }
  }

  /**
   * rev4 §M3: a sandbox stopped answering heartbeats. Restart it while the
   * restart budget holds; on crash-loop (budget exhausted inside the window)
   * stop restarting, disable the plugin server-side and surface the crash.
   * The session teardown (finalizeFrameRemovalNow) closes every handle:
   * streams, workers, jobs, subscriptions, overlays and pending invokes.
   */
  private handleFrameCrash(frame: RuntimeFrame): void {
    if (this.frames.get(frame.plugin.id) !== frame) return;
    if (frame.removalTimer) return; // graceful teardown wins over crash path
    if (!frame.session || frame.session.isDisposed) return; // re-entrant
    const now = Date.now();
    const windowMs = this.crashPolicy.windowMs;
    const recent = (this.crashHistory.get(frame.plugin.id) ?? []).filter(
      (at) => now - at <= windowMs,
    );
    recent.push(now);
    this.crashHistory.set(frame.plugin.id, recent);
    // Crashes 1..maxRestarts restart the frame; the (maxRestarts + 1)-th
    // failure inside the window is the crash-loop and disables the plugin.
    // `budgetLeft` counts automatic restarts remaining AFTER this crash.
    const budgetLeft = Math.max(0, this.crashPolicy.maxRestarts - recent.length);
    const disabled = recent.length > this.crashPolicy.maxRestarts;
    const detail = {
      pluginId: frame.plugin.id,
      pluginName: frame.plugin.name,
      error: 'PLUGIN_UNRESPONSIVE',
      restartBudgetLeft: budgetLeft,
      disabled,
      crashedAt: now,
    };
    globalThis.dispatchEvent?.(new CustomEvent('neotavern-plugin-crash', { detail }));
    if (disabled) {
      // Crash-loop: no more automatic restarts. The disable call makes the
      // server revoke grants and emit plugin.disabled; the plugin-list
      // refetch then keeps the frame gone.
      this.finalizeFrameRemovalNow(frame);
      void fetch(`/api/v2/plugins/${encodeURIComponent(frame.plugin.id)}/disable`, {
        method: 'POST',
      }).catch(() => undefined);
    } else {
      // Restart with the same plugin record: the sandbox reloads and
      // re-activates, re-registering its surfaces.
      this.finalizeFrameRemovalNow(frame, frame.plugin);
    }
  }

  /**
   * @internal rev4 §M3: the sandbox process died or navigated away — the
   * port closing without a graceful removal in progress is the crash
   * signal (restart under the budget, crash-loop disable). Wired in
   * startKernelSession; exposed for tests that attach sessions directly.
   */
  kernelAttachCrashWatch(frame: RuntimeFrame): void {
    frame.session?.onPeerClose(() => this.handleFrameCrash(frame));
  }

  /**
   * rev4 §J3: per-installation background-singleton election. Managers are
   * created lazily per installation id and dispose themselves when the last
   * change listener detaches (each plugin session tracks one listener via
   * its session scope, so frame teardown releases the claim).
   */
  private readonly windowRoleManagers = new Map<string, WindowRoleManager>();

  /**
   * rev4 §J3: current background-role snapshot for an installation,
   * creating the election manager on first use.
   */
  kernelWindowRole(installationId: string): WindowRoleSnapshot {
    return this.kernelWindowRoleManager(installationId).snapshot();
  }

  /**
   * rev4 §J3: subscribe to background-role transitions for an installation.
   * The returned unsubscribe detaches the listener; the manager stops (claim
   * release, channel close) when the last listener detaches.
   */
  kernelWindowRoleOnChange(
    installationId: string,
    listener: (snapshot: WindowRoleSnapshot) => void,
  ): () => void {
    return this.kernelWindowRoleManager(installationId).onChange(listener);
  }

  private kernelWindowRoleManager(installationId: string): WindowRoleManager {
    let manager = this.windowRoleManagers.get(installationId);
    if (!manager) {
      manager = new WindowRoleManager(installationId);
      manager.start(); // claims the channel and runs the heartbeat loop
      this.windowRoleManagers.set(installationId, manager);
    }
    return manager;
  }

  /** rev4 §M3: deliver a host-driven lifecycle hook to a live plugin sandbox.
   * Best-effort by design: the hook is fire-and-forget with a short deadline;
   * a dead sandbox degrades to a resolved no-op (`handled: false`) and never
   * blocks the host state machine.
   */
  kernelLifecycleHook(
    pluginId: string,
    hook: 'suspend' | 'resume' | 'beforeUpdate' | 'afterUpdate' | 'rollback' | 'uninstall',
    detail?: unknown,
  ): Promise<{ handled: boolean }> {
    const frame = this.frames.get(pluginId);
    if (!frame?.session || frame.session.isDisposed) {
      return Promise.resolve({ handled: false });
    }
    const pending = frame.session
      .call('lifecycle.hook', { hook, detail }, { deadlineMs: 1500 })
      .then((result) => ({ handled: (result as { handled?: unknown })?.handled === true }))
      .catch(() => ({ handled: false }));
    // Latest-wins: teardown waits for the final hook (typically afterUpdate)
    // so its writes settle before the session port closes.
    this.lifecyclePending.set(pluginId, pending);
    return pending;
  }

  /** rev4 §J2: suspend every live sandbox (tab hidden, host-driven). */
  kernelSuspendAll(): void {
    for (const pluginId of this.frames.keys()) {
      void this.kernelLifecycleHook(pluginId, 'suspend');
    }
  }

  /** rev4 §J2: resume every live sandbox (tab visible again). */
  kernelResumeAll(): void {
    for (const pluginId of this.frames.keys()) {
      void this.kernelLifecycleHook(pluginId, 'resume');
    }
  }

  /**
   * rev4 §J2: route plugin lifecycle SSE events to the live sandbox hooks.
   * `plugin.updating` → beforeUpdate, `plugin.updated` → afterUpdate,
   * `plugin.rollback` → rollback, `plugin.uninstalling` → uninstall.
   */
  private applyLifecycleEvent(type: string, payload: unknown): void {
    const record = payload as { pluginId?: unknown; version?: unknown; previousVersion?: unknown };
    const pluginId = typeof record?.pluginId === 'string' ? record.pluginId : '';
    if (!pluginId) return;
    const detail =
      typeof record.version === 'string' || typeof record.previousVersion === 'string'
        ? { version: record.version, previousVersion: record.previousVersion }
        : undefined;
    switch (type) {
      case 'plugin.updating':
        void this.kernelLifecycleHook(pluginId, 'beforeUpdate', detail);
        break;
      case 'plugin.updated':
        void this.kernelLifecycleHook(pluginId, 'afterUpdate', detail);
        break;
      case 'plugin.rollback':
        void this.kernelLifecycleHook(pluginId, 'rollback', detail);
        break;
      case 'plugin.uninstalling':
        void this.kernelLifecycleHook(pluginId, 'uninstall', detail);
        break;
      default:
        break;
    }
  }

  /**
   * rev4 §B2: surface a runtime capability request to the user. An already
   * granted capability resolves immediately; otherwise exactly one consent
   * dialog per plugin is allowed at a time.
   */
  requestCapabilityConsent(
    frame: RuntimeFrame,
    request: kernel.CapabilityRequest,
  ): Promise<kernel.CapabilityGrant> {
    const granted = frame.plugin.grantedCapabilities.find((grant) => grant.name === request.name);
    if (granted) {
      return Promise.resolve({ ...granted, scope: kernel.parseCapabilityScope(granted.scope) });
    }
    const pluginId = frame.plugin.id;
    if (this.pendingConsents.has(pluginId)) {
      return Promise.reject(consentError(request.name, 'consent-pending'));
    }
    return new Promise<kernel.CapabilityGrant>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConsents.delete(pluginId);
        this.notifyConsentListeners();
        reject(consentError(request.name, 'consent-timeout'));
      }, CONSENT_DIALOG_TIMEOUT_MS);
      this.pendingConsents.set(pluginId, {
        pluginId,
        pluginName: frame.plugin.name,
        request,
        resolve,
        reject,
        timer,
      });
      this.notifyConsentListeners();
    });
  }

  /** rev4 §B2: the user answered the consent dialog (true = allow). */
  resolveConsent(pluginId: string, allowed: boolean): void {
    const pending = this.pendingConsents.get(pluginId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingConsents.delete(pluginId);
    this.notifyConsentListeners();
    if (!allowed) {
      pending.reject(consentError(pending.request.name, 'user-denied'));
      return;
    }
    const frame = this.frames.get(pluginId);
    if (!frame) {
      pending.reject(consentError(pending.request.name, 'frame-gone'));
      return;
    }
    void this.persistRuntimeGrant(frame, pending.request, pending.resolve, pending.reject);
  }

  /** rev4 §B2: POST the consent to the server and publish the grant locally. */
  private async persistRuntimeGrant(
    frame: RuntimeFrame,
    request: kernel.CapabilityRequest,
    resolve: (grant: kernel.CapabilityGrant) => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    try {
      const response = await fetch(
        `/api/v2/plugins/${encodeURIComponent(frame.plugin.id)}/capabilities`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: request.name,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
          }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      const grant =
        isRecord(body) && isRecord(body['grant'])
          ? (body['grant'] as unknown as kernel.CapabilityGrant)
          : null;
      if (!response.ok || !isValidGrant(grant)) {
        if (response.status === 400) reject(consentError(request.name, 'unknown-capability'));
        else if (response.status === 404) reject(consentError(request.name, 'plugin-gone'));
        else {
          reject(
            new kernel.KernelError(kernel.KernelErrorCode.BACKEND_UNAVAILABLE, {
              details: { status: response.status },
            }),
          );
        }
        return;
      }
      const grants = frame.plugin.grantedCapabilities;
      const index = grants.findIndex((entry) => entry.name === grant.name);
      if (index >= 0) grants.splice(index, 1);
      grants.push(grant);
      resolve(grant);
    } catch {
      reject(new kernel.KernelError(kernel.KernelErrorCode.BACKEND_UNAVAILABLE, {}));
    }
  }

  mountPage(
    registration: PluginUiRegistration,
    container: HTMLElement,
    context?: unknown,
  ): () => void {
    const frame = this.frames.get(registration.pluginId);
    if (!frame) return () => undefined;
    const registrationId = registration.registrationId;
    // The single iframe remains viewport-sized: reparenting it would reload
    // the plugin. Each registration receives its own root and rectangle via
    // postMessage, while the SVG union clip keeps every other app pixel and
    // click outside the iframe (PLUG-54).
    frame.overlays.get(registrationId)?.stopTracking();
    const entry: MountOverlay = {
      container,
      context,
      mountSent: false,
      stopTracking: trackOverlayRect(container, () => this.scheduleLayout(frame)),
    };
    frame.overlays.set(registrationId, entry);
    frame.host.hidden = false;
    this.scheduleLayout(frame);
    return () => {
      frame.iframe.contentWindow?.postMessage(
        {
          type: 'neotavern.plugin.unmount',
          pluginId: registration.pluginId,
          registrationId,
        },
        '*',
      );
      const current = frame.overlays.get(registrationId);
      if (!current) return;
      current.stopTracking();
      frame.overlays.delete(registrationId);
      if (frame.overlays.size === 0) frame.host.hidden = true;
      this.scheduleLayout(frame);
    };
  }

  /**
   * rev4 §A4: host-side root for a kernel overlay registration. The container
   * div belongs to the plugin frame but the sandbox draws into its own
   * same-rect container; the hit policy decides the interaction contract:
   * - 'native' joins the iframe clip-path union (browser hit-testing inside
   *   the shapes, or the whole rect without shapes);
   * - 'proxy' joins the clip union too (visuals stay visible and unclipped)
   *   and a host hit-div above the iframe forwards normalized pointer
   *   packets via `forward` (kernel `ui.overlay.pointer`), point-tested
   *   against `hitShapes` when present;
   * - 'full' unclips the whole iframe while active (callers enforce at most
   *   one per frame);
   * - 'none' is cut out of the clip and nothing captures the pointer.
   * Returns the cleanup: untracks the rect, stops the proxy, restores the
   * clip.
   */
  kernelMountOverlay(
    frame: RuntimeFrame,
    registrationId: string,
    container: HTMLElement,
    hitPolicy: OverlayHitPolicy,
    forward?: (packet: OverlayPointerPacket) => void,
    hitShapes?: OverlayShape[],
  ): () => void {
    const previous = frame.overlays.get(registrationId);
    if (previous) {
      previous.stopTracking();
      previous.stopHitProxy?.();
      this.removeKernelContainer(previous);
    }
    const entry: MountOverlay = {
      container,
      context: undefined,
      // The sandbox renders into its own container; no neotavern.plugin.mount.
      mountSent: true,
      // Kernel overlays must never ride the v2 layout channel (its
      // applyLayout sets pointer-events auto + zIndex on the sandbox
      // container, which would steal input from the plugin's own DOM).
      kernel: true,
      stopTracking: trackOverlayRect(container, () => this.scheduleLayout(frame)),
    };
    if (hitPolicy === 'proxy' || hitPolicy === 'none') {
      // 'proxy' forwards packets; 'none' absorbs (forward stays undefined).
      const proxy = this.startOverlayProxy(frame, registrationId, forward, hitShapes);
      entry.hitDiv = proxy.hitDiv;
      entry.stopHitProxy = proxy.stop;
    }
    entry.hitPolicy = hitPolicy;
    entry.hitShapes = hitShapes;
    frame.overlays.set(registrationId, entry);
    frame.host.hidden = false;
    this.scheduleLayout(frame);
    return () => {
      const current = frame.overlays.get(registrationId);
      if (!current) return;
      current.stopTracking();
      current.stopHitProxy?.();
      frame.overlays.delete(registrationId);
      if (frame.overlays.size === 0) frame.host.hidden = true;
      this.scheduleLayout(frame);
    };
  }

  /** rev4 §A4: resize a kernel overlay root and/or replace its hit shapes. */
  kernelUpdateOverlay(
    frame: RuntimeFrame,
    registrationId: string,
    rect?: OverlayRect,
    hitShapes?: OverlayShape[],
  ): void {
    const overlay = frame.overlays.get(registrationId);
    if (!overlay) return;
    if (rect) {
      overlay.container.style.left = `${rect.x}px`;
      overlay.container.style.top = `${rect.y}px`;
      overlay.container.style.width = `${rect.width}px`;
      overlay.container.style.height = `${rect.height}px`;
    }
    if (hitShapes !== undefined) {
      const now = Date.now();
      const windowState = overlay.updateWindow;
      if (windowState && now < windowState.resetAt) {
        windowState.count += 1;
      } else {
        overlay.updateWindow = { count: 1, resetAt: now + 1000 };
      }
      const max = kernel.DEFAULT_PLUGIN_LIMITS.overlays.maxUpdatesPerSecond;
      const current = overlay.updateWindow;
      if (current && current.count > max) {
        throw new kernel.KernelError(kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
          retryable: true,
          retryAfterMs: Math.max(0, current.resetAt - now),
          details: { limit: 'overlays.maxUpdatesPerSecond', max },
        });
      }
      overlay.hitShapes = hitShapes;
    }
    this.scheduleLayout(frame);
  }

  /** rev4 §A4: drop one kernel overlay root (clip + hit-div cleanup). */
  kernelDisposeOverlay(frame: RuntimeFrame, registrationId: string): void {
    const overlay = frame.overlays.get(registrationId);
    if (!overlay) return;
    overlay.stopTracking();
    overlay.stopHitProxy?.();
    this.removeKernelContainer(overlay);
    frame.overlays.delete(registrationId);
    if (frame.overlays.size === 0) frame.host.hidden = true;
    this.scheduleLayout(frame);
  }

  /**
   * rev4 §A4: host-side mount for a kernel surface (settings/sidebar panel).
   * The container belongs to the host component; layout rects reach the
   * sandbox via `ui.surface.layout` so the plugin runner can size itself.
   */
  kernelMountSurface(
    frame: RuntimeFrame,
    registrationId: string,
    container: HTMLElement,
    trackTarget?: () => void,
  ): () => void {
    const previous = frame.overlays.get(registrationId);
    if (previous) {
      previous.stopTracking();
      previous.stopHitProxy?.();
      previous.trackTarget?.();
      this.removeKernelContainer(previous);
    }
    frame.surfaceContainers.set(registrationId, container);
    const entry: MountOverlay = {
      container,
      context: undefined,
      mountSent: false,
      kernel: true,
      trackTarget,
      stopTracking: trackOverlayRect(container, () => this.scheduleLayout(frame)),
    };
    frame.overlays.set(registrationId, entry);
    frame.host.hidden = false;
    if (frame.session && !frame.session.isDisposed) {
      void frame.session
        .call('ui.surface.mount', { surfaceId: registrationId }, { deadlineMs: 5000 })
        .catch(() => undefined);
    }
    this.scheduleLayout(frame);
    return () => {
      this.kernelUnmountSurface(frame, registrationId);
    };
  }

  /** rev4 §A4: drop one kernel surface root and its container binding. */
  kernelUnmountSurface(frame: RuntimeFrame, registrationId: string): void {
    const overlay = frame.overlays.get(registrationId);
    if (!overlay?.kernel) return;
    overlay.stopTracking();
    overlay.trackTarget?.();
    frame.surfaceContainers.delete(registrationId);
    frame.overlays.delete(registrationId);
    // Kernel overlay containers are host-owned scaffolds (marked
    // `data-neotavern-overlay`) and must leave with the registration; kernel
    // surface containers belong to host components (unmarked) and are left
    // to their owners.
    this.removeKernelContainer(overlay);
    if (frame.session && !frame.session.isDisposed) {
      void frame.session
        .call('ui.surface.unmount', { surfaceId: registrationId }, { deadlineMs: 1000 })
        .catch(() => undefined);
    }
    if (frame.overlays.size === 0) frame.host.hidden = true;
    this.scheduleLayout(frame);
  }

  /**
   * rev4 §A4: fixed-position layer above the iframe carrying one hit-div per
   * proxy overlay; pointer-events stay 'none' so only the hit-divs capture.
   */
  private ensureOverlayHitLayer(frame: RuntimeFrame): HTMLDivElement {
    if (frame.hitLayer?.isConnected) return frame.hitLayer;
    const layer = document.createElement('div');
    layer.dataset.part = 'plugin-overlay-hit-layer';
    layer.style.position = 'fixed';
    layer.style.inset = '0';
    // Stacks above the sandbox iframe via the style contract token
    // (--st-layer-plugin-overlay), never hardcoded here (AGENTS §14).
    frame.host.append(layer);
    frame.hitLayer = layer;
    return layer;
  }

  private startOverlayProxy(
    frame: RuntimeFrame,
    registrationId: string,
    forward?: (packet: OverlayPointerPacket) => void,
    hitShapes?: OverlayShape[],
  ): { hitDiv: HTMLDivElement; stop: () => void } {
    const layer = this.ensureOverlayHitLayer(frame);
    const hitDiv = document.createElement('div');
    hitDiv.dataset.part = 'plugin-overlay-hit';
    hitDiv.dataset.registrationId = registrationId;
    hitDiv.style.position = 'fixed';
    hitDiv.style.pointerEvents = 'auto';
    layer.append(hitDiv);
    let sequence = 0;
    const onPointer = (event: PointerEvent): void => {
      if (typeof forward !== 'function') return;
      const bounds = frame.overlays.get(registrationId)?.container.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const localX = event.clientX - bounds.left;
      const localY = event.clientY - bounds.top;
      // rev4 §A4: with hitShapes, only pointers inside a shape reach the
      // plugin; without shapes the whole rect is interactive.
      const shapes = hitShapes ?? frame.overlays.get(registrationId)?.hitShapes;
      if (
        shapes &&
        shapes.length > 0 &&
        !shapes.some((shape) => overlayShapeContains(shape, localX, localY))
      ) {
        return;
      }
      const packet: OverlayPointerPacket = {
        type: POINTER_PACKET_TYPES[event.type] ?? 'move',
        x: clamp01((localX / bounds.width) as number),
        y: clamp01((localY / bounds.height) as number),
        button: typeof event.button === 'number' ? event.button : 0,
        pressure: typeof event.pressure === 'number' ? event.pressure : event.buttons > 0 ? 0.5 : 0,
        pointerId: typeof event.pointerId === 'number' ? event.pointerId : 0,
        sequence: sequence++,
        timestamp: Date.now(),
      };
      try {
        forward(packet);
      } catch {
        // A failing kernel forwarder must not break the pointer pipeline.
      }
    };
    const onDown = (event: PointerEvent): void => {
      onPointer(event);
      if (typeof hitDiv.setPointerCapture === 'function') {
        try {
          hitDiv.setPointerCapture(event.pointerId);
        } catch {
          // jsdom and older engines lack capture; moves stay inside the div.
        }
      }
    };
    hitDiv.addEventListener('pointerdown', onDown);
    hitDiv.addEventListener('pointermove', onPointer);
    hitDiv.addEventListener('pointerup', onPointer);
    hitDiv.addEventListener('pointercancel', onPointer);
    return {
      hitDiv,
      stop: () => {
        hitDiv.remove();
      },
    };
  }

  invoke(
    registration: PluginUiRegistration,
    context?: unknown,
    maxTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const frame = this.frames.get(registration.pluginId);
    if (!frame) return Promise.reject(new Error('PLUGIN_NOT_FOUND'));
    // rev4 §A4: kernel registrations run over the kernel port; the v2
    // postMessage invoke only reaches the legacy bootstrap listeners.
    if (registration.kernel && frame.session && !frame.session.isDisposed) {
      const isCommand = registration.kind === 'commands';
      const promise = frame.session.call(
        isCommand ? 'commands.run' : 'surfaces.run',
        isCommand
          ? { commandId: registration.registrationId, context }
          : { surfaceId: registration.registrationId, context },
        { deadlineMs: RUN_DEADLINE_MS },
      );
      // The AbortSignal never crosses the kernel port (not cloneable): the
      // sandbox owns its own AbortController, keyed by the invocationId the
      // caller put into the context. On abort the host only asks the sandbox
      // to abort; the RPC itself still settles on its own deadline.
      if (signal) {
        const onAbort = () => {
          void frame.session
            ?.call('surfaces.abort', {
              invocationId: (context as { invocationId?: string } | undefined)?.invocationId,
            })
            .catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      return promise;
    }
    // Unpredictable invocation ids: a sequential counter would let one plugin
    // guess another plugin's id and spoof results for its in-flight invokes
    // (the source check alone only proves which frame sent the message).
    const invocationId = `${registration.pluginId}:${randomToken(10)}`;
    // The registration's declared timeoutMs (sanitized at registration, ≤60s)
    // is honored — the SDK documents it as "max time before the hook is
    // skipped"; the default covers registrations that did not declare one.
    // Callers may cap it further (the interceptor chain deadline).
    const declaredTimeoutMs = registration.definition.timeoutMs ?? 10_000;
    const timeoutMs =
      maxTimeoutMs === undefined ? declaredTimeoutMs : Math.min(declaredTimeoutMs, maxTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invocationId);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      this.pending.set(invocationId, { pluginId: registration.pluginId, resolve, reject, timer });
      // Host-side abort: reject the pending invocation and tell the sandbox
      // to abort its own per-invocation AbortController. The sandbox's run
      // promise may still resolve afterwards; the result handler below drops
      // results for invocationIds that are no longer pending.
      if (signal) {
        const onAbort = () => {
          const entry = this.pending.get(invocationId);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(invocationId);
            entry.reject(new Error('ABORTED'));
          }
          frame.iframe.contentWindow?.postMessage(
            { type: 'neotavern.plugin.invoke.abort', invocationId },
            '*',
          );
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      frame.iframe.contentWindow?.postMessage(
        {
          type: 'neotavern.plugin.invoke',
          pluginId: registration.pluginId,
          registrationId: registration.registrationId,
          invocationId,
          context,
        },
        '*',
      );
    });
  }

  /**
   * True when the installed plugin's granted permissions include `permission`.
   * Used by host UI to gate per-plugin content (e.g. `chat.read` for message
   * snapshots) without leaking the whole frame registry.
   */
  hasPermission(pluginId: string, permission: string): boolean {
    const frame = this.frames.get(pluginId);
    return frame ? frame.plugin.grantedPermissions.includes(permission) : false;
  }

  async runPromptInterceptors(context: {
    chatId: string;
    messages: Array<{ id?: string; role: string; content: string; name?: string | null }>;
    meta: Record<string, unknown>;
  }): Promise<typeof context> {
    let current = context;
    const interceptors = this.snapshot
      .filter((registration) => registration.kind === 'interceptors')
      .sort(
        (left, right) => (left.definition.priority ?? 100) - (right.definition.priority ?? 100),
      );
    // The server broker only waits 2.5s for the intercepted prompt before it
    // continues the chain without it; the whole browser chain must stay under
    // that deadline, or the result is POSTed to an expired rendezvous and a
    // successful generation would look like a failure (PLUG-53).
    const deadline = Date.now() + INTERCEPT_CHAIN_BUDGET_MS;
    for (const interceptor of interceptors) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const result = await this.invoke(interceptor, current, remaining);
        if (isPromptInterceptorContext(result, current.chatId)) current = result;
      } catch {
        // One failed plugin does not stop the remaining interceptor chain.
      }
    }
    return current;
  }

  emitEvent(event: string, payload: unknown): void {
    for (const frame of this.frames.values()) {
      if (!frame.subscriptions.has(event)) continue;
      frame.iframe.contentWindow?.postMessage(
        { type: 'neotavern.plugin.event', pluginId: frame.plugin.id, event, payload },
        '*',
      );
    }
  }

  /**
   * rev4 §2: kernel slices subscribe to whitelisted app events relayed over
   * the SSE stream (host-side interception, not sandbox delivery). Returns
   * an unsubscribe function; slices track it via their session scope.
   */
  onAppEvent(event: string, listener: (payload: unknown) => void): () => void {
    const set = this.appEventListeners.get(event) ?? new Set<(payload: unknown) => void>();
    set.add(listener);
    this.appEventListeners.set(event, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.appEventListeners.delete(event);
    };
  }

  private dispatchAppEvent(event: string, payload: unknown): void {
    this.recordAppEvent(event, payload);
    const set = this.appEventListeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch {
        // One failing kernel listener must not break the others.
      }
    }
  }

  /**
   * rev4 §J1: append one app event to the bounded replay buffer. Ordering is
   * per event name (a monotonic sequence per name); retention is capped per
   * name (128) and globally (4096), and entries older than a minute are
   * dropped — the replay window is bounded by contract.
   */
  private recordAppEvent(event: string, payload: unknown): void {
    const seq = (this.appEventSeq.get(event) ?? 0) + 1;
    this.appEventSeq.set(event, seq);
    const records = this.appEventHistory.get(event) ?? [];
    const record: AppEventRecord = { seq, ts: Date.now(), payload };
    records.push(record);
    this.appEventHistoryOrder.push({ event, seq });
    const cutoff = Date.now() - APP_EVENT_HISTORY_TTL_MS;
    while (records.length > APP_EVENT_HISTORY_PER_EVENT || (records[0]?.ts ?? Infinity) < cutoff) {
      records.shift();
    }
    // Global cap: evict the oldest record across all names.
    while (this.appEventHistoryOrder.length > APP_EVENT_HISTORY_TOTAL) {
      const oldest = this.appEventHistoryOrder.shift();
      if (!oldest) break;
      const bucket = this.appEventHistory.get(oldest.event);
      if (bucket && bucket[0]?.seq === oldest.seq) bucket.shift();
    }
    this.appEventHistory.set(event, records);
  }

  /**
   * rev4 §J1: read the retained records of one event after `afterSeq`,
   * chronological. The window object exposes the retention bounds so the
   * events slice can reject expired (`afterSeq` older than the retained
   * window) and future cursors.
   */
  kernelAppEventHistoryAfter(event: string, afterSeq: number): AppEventHistoryWindow {
    const records = this.appEventHistory.get(event) ?? [];
    const filtered = records.filter((record) => record.seq > afterSeq);
    return {
      records: filtered,
      lowestSeq: records.length > 0 ? (records[0]?.seq ?? 0) : null,
      headSeq: records.length > 0 ? (records[records.length - 1]?.seq ?? 0) : null,
    };
  }

  private createFrame(plugin: InstalledPlugin): void {
    const host = document.createElement('div');
    host.hidden = true;
    host.dataset.part = 'plugin-frame-container';
    const clipSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clipSvg.setAttribute('aria-hidden', 'true');
    clipSvg.setAttribute('width', '0');
    clipSvg.setAttribute('height', '0');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    const clipId = `neotavern-plugin-clip-${randomToken(10)}`;
    clipPath.id = clipId;
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');
    defs.append(clipPath);
    clipSvg.append(defs);
    const iframe = document.createElement('iframe');
    iframe.src = `/api/v2/plugins/${encodeURIComponent(plugin.id)}/sandbox`;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', PLUGIN_IFRAME_DENIED_FEATURES);
    iframe.title = plugin.name;
    iframe.dataset.component = 'plugin-sandbox-frame';
    iframe.dataset.pluginId = plugin.id;
    iframe.style.clipPath = `url(#${clipId})`;
    iframe.style.setProperty('-webkit-clip-path', `url(#${clipId})`);
    const frame: RuntimeFrame = {
      frameId: `frame-${++this.frameSeq}`,
      plugin,
      host,
      iframe,
      clipSvg,
      clipPath,
      subscriptions: new Set<string>(),
      initialLoadDone: false,
      overlays: new Map<string, MountOverlay>(),
      layoutFrame: null as AnimationHandle | null,
      hitLayer: null,
      overlayLayoutRevision: 0,
      lastOverlayLayoutKey: null,
      session: null,
      revocationListeners: new Set(),
      surfaceContainers: new Map<string, HTMLElement>(),
    };
    iframe.addEventListener('load', () => {
      if (!frame.initialLoadDone) {
        frame.initialLoadDone = true;
        this.sendLanguage(frame, this.i18n?.language ?? document.documentElement.lang ?? 'en');
        this.startKernelSession(frame);
        return;
      }
      // Any later 'load' means the sandbox document was replaced — either the
      // plugin navigated itself away (sandbox="allow-scripts" permits
      // self-navigation, and the navigated page no longer has our CSP) or the
      // sandbox reloaded. Either way the previous document's session must not
      // survive: drop subscriptions/registrations so a navigated-away page can
      // neither keep receiving chat-content events nor answer invokes for
      // surfaces it no longer implements. A reloaded sandbox re-registers on
      // bootstrap.
      this.resetFrameSession(frame);
    });
    this.frames.set(plugin.id, frame);
    this.ensureThemeTokenSync();
    // rev4 §M3: liveness probe — every live frame is pinged on an interval;
    // a sandbox that never answers is hung and gets restarted (or disabled
    // on crash-loop). The probe is a no-op until the session exists.
    frame.pingTimer = window.setInterval(() => {
      void this.probeFrame(frame);
    }, this.crashPolicy.pingIntervalMs);
    host.append(clipSvg, iframe);
    this.ensureHiddenRoot().append(host);
  }

  /**
   * Invalidate the session state of a frame whose sandbox document was
   * replaced (navigation or reload). Subscriptions, UI registrations and
   * in-flight invokes belong to the previous document and must not be honored
   * for whatever is loaded now.
   */
  private resetFrameSession(frame: RuntimeFrame): void {
    // The frame may already have been crash-replaced while its old document
    // was still loading; never reset the replacement frame's session.
    if (this.frames.get(frame.plugin.id) !== frame) return;
    // rev4 §M3: the sandbox replaced its own document (self-navigation or a
    // plugin-driven reset) — the plugin's session is gone and whatever the
    // sandbox navigated to is not the plugin. Restart under the restart
    // budget; crash-looping navigations end in a disable.
    this.handleFrameCrash(frame);
    this.clearOverlays(frame);
    frame.subscriptions.clear();
    frame.session?.dispose();
    frame.session = null;
    const pluginId = frame.plugin.id;
    for (const [invocationId, pending] of this.pending) {
      if (!invocationId.startsWith(`${pluginId}:`)) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PLUGIN_NOT_FOUND'));
      this.pending.delete(invocationId);
    }
    let registrationsChanged = false;
    for (const [registrationId, registration] of this.registrations) {
      if (registration.pluginId !== pluginId) continue;
      this.registrations.delete(registrationId);
      registrationsChanged = true;
    }
    if (registrationsChanged) {
      slotRegistry.unregisterByPlugin(pluginId);
      this.publish();
    }
  }

  private removeFrame(pluginId: string, replacement?: InstalledPlugin): void {
    const frame = this.frames.get(pluginId);
    if (!frame || frame.removalTimer) return;
    frame.replacement = replacement;
    frame.iframe.contentWindow?.postMessage({ type: 'neotavern.plugin.deactivate', pluginId }, '*');
    frame.removalTimer = setTimeout(() => this.finalizeFrameRemoval(pluginId, replacement), 500);
  }

  private finalizeFrameRemoval(pluginId: string, replacement?: InstalledPlugin): void {
    const frame = this.frames.get(pluginId);
    if (!frame) return;
    // rev4 §J2: an update replacement runs beforeUpdate/afterUpdate while the
    // old sandbox is still mounted. Let the in-flight hook settle (bounded
    // by its 1500 ms RPC deadline) before closing the session port — the
    // hook's final writes must not be silently dropped mid-teardown.
    const pendingHook = this.lifecyclePending.get(pluginId);
    if (pendingHook) {
      void Promise.race([
        pendingHook,
        new Promise<void>((resolve) => setTimeout(resolve, 1600)),
      ]).then(() => {
        this.lifecyclePending.delete(pluginId);
        this.finalizeFrameRemovalNow(frame, replacement);
      });
      return;
    }
    this.finalizeFrameRemovalNow(frame, replacement);
  }

  private finalizeFrameRemovalNow(frame: RuntimeFrame, replacement?: InstalledPlugin): void {
    const pluginId = frame.plugin.id;
    // The deferred path (pending lifecycle hook) can outlive the frame map
    // entry; never tear down a replacement frame for the same plugin id.
    if (this.frames.get(pluginId) !== frame) return;
    // A deactivated/uninstalled plugin must not leave a consent dialog open
    // (cleanup guarantee, ТЗ §7.2); the plugin's request fails as frame-gone.
    const pendingConsent = this.pendingConsents.get(pluginId);
    if (pendingConsent) {
      clearTimeout(pendingConsent.timer);
      this.pendingConsents.delete(pluginId);
      pendingConsent.reject(consentError(pendingConsent.request.name, 'frame-gone'));
      this.notifyConsentListeners();
    }
    const next = replacement ?? frame.replacement;
    if (frame.removalTimer) clearTimeout(frame.removalTimer);
    if (frame.pingTimer !== undefined) {
      clearInterval(frame.pingTimer);
      frame.pingTimer = undefined;
    }
    this.clearOverlays(frame);
    frame.host.remove();
    frame.session?.dispose();
    frame.session = null;
    this.frames.delete(pluginId);
    for (const [invocationId, pending] of this.pending) {
      if (!invocationId.startsWith(`${pluginId}:`)) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('PLUGIN_NOT_FOUND'));
      this.pending.delete(invocationId);
    }
    for (const [registrationId, registration] of this.registrations) {
      if (registration.pluginId === pluginId) this.registrations.delete(registrationId);
    }
    slotRegistry.unregisterByPlugin(pluginId);
    // rev4 §D: a removed plugin takes its provided services (and the consumer
    // connections pointing at them) and its own consumer connections with it.
    this.kernelServiceRemoveByPlugin(pluginId);
    this.kernelServiceRemoveByConsumer(pluginId);
    // Full cleanup guarantee (ТЗ §7.2): the plugin's translations leave with
    // the plugin; no stale bundles survive deactivation or uninstall.
    this.removeI18nResources(pluginId);
    this.publish();
    // Let host surfaces drop anything the plugin left behind (notifications,
    // dialogs) — "no handlers, timers, DOM elements or background requests".
    globalThis.dispatchEvent?.(
      new CustomEvent('neotavern-plugin-removed', { detail: { pluginId } }),
    );
    if (next) this.createFrame(next);
    this.syncEventStream();
  }

  private ensureHiddenRoot(): HTMLElement {
    if (this.hiddenRoot?.isConnected) return this.hiddenRoot;
    const existing = document.querySelector<HTMLElement>('[data-component="plugin-runtime-layer"]');
    if (existing) {
      this.hiddenRoot = existing;
      return existing;
    }
    const root = document.createElement('div');
    root.dataset.component = 'plugin-runtime-layer';
    document.body.append(root);
    this.hiddenRoot = root;
    return root;
  }

  private onMessage(event: MessageEvent): void {
    if (!isSandboxMessage(event.data)) return;
    const message = event.data;
    const frame = this.frames.get(message.pluginId);
    if (!frame || event.source !== frame.iframe.contentWindow) return;

    if (message.type === 'neotavern.plugin.register') {
      const registration = sanitizeRegistration(frame.plugin, message);
      if (!registration || !this.permissionAllows(frame.plugin, registration.kind)) return;
      // Aggregate cap: unlike event subscriptions, UI registrations were
      // unlimited (PLUG-59 L6).
      let frameRegistrations = 0;
      for (const existing of this.registrations.values()) {
        if (existing.pluginId === frame.plugin.id) frameRegistrations += 1;
      }
      if (!this.registrations.has(registration.registrationId) && frameRegistrations >= 256) {
        return;
      }
      this.registrations.set(registration.registrationId, registration);
      if (registration.kind === 'slots') {
        // Declarative slot contributions cross the sandbox channel as plain
        // data and land in the host slot registry (ТЗ §53); `when` is a
        // function and never leaves the iframe.
        const contribution = slotsContributionFromDefinition(registration.definition);
        if (contribution !== null) {
          slotRegistry.register({
            pluginId: registration.pluginId,
            pluginName: registration.pluginName,
            registrationId: registration.registrationId,
            contribution,
          });
        }
      }
      this.publish();
      return;
    }
    if (
      message.type === 'neotavern.plugin.event.subscribe' &&
      typeof message.event === 'string' &&
      message.event.length <= 200 &&
      (frame.subscriptions.has(message.event) || frame.subscriptions.size < 128)
    ) {
      // Chat-content events require chat.read exactly like the backend host
      // (backendHost.ts CHAT_CONTENT_EVENTS gate). CSP alone is not an
      // exfiltration boundary: a sandboxed frame may navigate itself away and
      // keep this subscription from an origin without our CSP.
      if (
        CHAT_CONTENT_EVENTS.has(message.event) &&
        !frame.plugin.grantedPermissions.includes('chat.read')
      ) {
        return;
      }
      frame.subscriptions.add(message.event);
      return;
    }
    if (
      message.type === 'neotavern.plugin.event.unsubscribe' &&
      typeof message.event === 'string'
    ) {
      frame.subscriptions.delete(message.event);
      return;
    }
    if (
      message.type === 'neotavern.plugin.event.emit' &&
      typeof message.event === 'string' &&
      message.event.startsWith(`${frame.plugin.id}.`) &&
      isBoundedEventPayload(message.payload)
    ) {
      this.emitEvent(message.event, message.payload);
      return;
    }
    if (message.type === 'neotavern.plugin.unregister' && message.registrationId) {
      const removed = this.registrations.get(message.registrationId);
      this.registrations.delete(message.registrationId);
      if (removed?.kind === 'slots') {
        slotRegistry.unregister(message.registrationId);
      }
      this.removeOverlay(frame, message.registrationId, false);
      this.publish();
      return;
    }
    if (message.type === 'neotavern.plugin.i18n.add') {
      this.addI18nResources(frame.plugin, message);
      return;
    }
    if (
      message.type === 'neotavern.plugin.i18n.remove' &&
      typeof message.language === 'string' &&
      typeof message.registrationId === 'string' &&
      message.registrationId.startsWith(`${frame.plugin.id}:`)
    ) {
      this.removeI18nLanguage(frame.plugin.id, message.language);
      return;
    }
    if (message.type === 'neotavern.plugin.notify') {
      if (!frame.plugin.grantedPermissions.includes('notifications')) return;
      globalThis.dispatchEvent(
        new CustomEvent('neotavern-plugin-notification', {
          detail: {
            pluginId: frame.plugin.id,
            registrationId:
              typeof message.registrationId === 'string' ? message.registrationId : undefined,
            notification: message.notification,
          },
        }),
      );
      return;
    }
    if (
      message.type === 'neotavern.plugin.notification.dismiss' &&
      typeof message.registrationId === 'string' &&
      message.registrationId.startsWith(`${frame.plugin.id}:`)
    ) {
      globalThis.dispatchEvent(
        new CustomEvent('neotavern-plugin-notification-dismiss', {
          detail: { registrationId: message.registrationId },
        }),
      );
      return;
    }
    if (message.type === 'neotavern.plugin.invoke.result' && message.invocationId) {
      const pending = this.pending.get(message.invocationId);
      // Results are only honored from the frame that owns the invocation —
      // otherwise a plugin could answer (or fail) another plugin's invoke.
      if (!pending || pending.pluginId !== frame.plugin.id) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.invocationId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error('PLUGIN_LOAD_FAILED'));
      return;
    }
    if (message.type === 'neotavern.plugin.deactivated') {
      this.finalizeFrameRemoval(message.pluginId);
      return;
    }
    if (
      message.type === 'neotavern.plugin.error' ||
      message.type === 'neotavern.plugin.mount.error'
    ) {
      // A plugin that fails activate()/mount leaves an invisible dead iframe
      // unless surfaced: report it and tear the frame down deterministically.
      const detail = {
        pluginId: frame.plugin.id,
        pluginName: frame.plugin.name,
        error: typeof message.error === 'string' ? message.error.slice(0, 500) : 'PLUGIN_ERROR',
      };
      globalThis.dispatchEvent?.(new CustomEvent('neotavern-plugin-error', { detail }));
      this.finalizeFrameRemoval(frame.plugin.id);
    }
  }

  /**
   * App-event delivery (ТЗ §7.2 «обработчики событий»): while any plugin frame
   * is alive, subscribe to the backend event channel and relay whitelisted app
   * events into subscribed sandboxes.
   */
  private syncEventStream(): void {
    if (this.frames.size > 0 && !this.eventSource && typeof EventSource !== 'undefined') {
      const source = new EventSource('/api/v2/events');
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as {
            type?: string;
            event?: string;
            payload?: unknown;
          };
          if (data.type === 'event' && typeof data.event === 'string') {
            this.emitEvent(data.event, data.payload);
            if (data.event === 'plugin.capability.revoked') this.onAppEventRevoked(data.payload);
            // rev4 §J2: update/uninstall lifecycle events reach the live
            // sandbox as hooks.
            if (
              data.event === 'plugin.updating' ||
              data.event === 'plugin.updated' ||
              data.event === 'plugin.rollback' ||
              data.event === 'plugin.uninstalling'
            ) {
              this.applyLifecycleEvent(data.event, data.payload);
            }
            this.dispatchAppEvent(data.event, data.payload);
          }
        } catch {
          // Ignore malformed frames.
        }
      };
      source.onerror = () => {
        // EventSource retries automatically; nothing to do unless closed.
        if (source.readyState === EventSource.CLOSED) {
          if (this.eventSource === source) this.eventSource = null;
        }
      };
      this.eventSource = source;
    }
    if (this.frames.size === 0 && this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private sendLanguage(frame: RuntimeFrame, language: string): void {
    frame.iframe.contentWindow?.postMessage(
      {
        type: 'neotavern.plugin.language',
        pluginId: frame.plugin.id,
        language,
      },
      '*',
    );
  }

  /**
   * rev4 §A1: single postMessage bootstrap; afterwards all kernel traffic
   * rides the transferred MessagePort. The sandbox ACKs with its handshake
   * and receives the host handshake (grants, features, limits) on the port.
   */
  private startKernelSession(frame: RuntimeFrame): void {
    frame.session?.dispose();
    frame.session = null;
    const target = frame.iframe.contentWindow;
    if (!target) return;
    void kernel
      .hostBootstrap(
        (message, transfer) => target.postMessage(message, '*', transfer),
        () => this.buildHostHandshake(frame.plugin),
        { pluginId: frame.plugin.id, hostVersion: '2.0.0' },
      )
      .then((session) => {
        if (!this.frames.get(frame.plugin.id) || frame.iframe.contentWindow !== target) {
          session.port.close();
          return;
        }
        const ks = new kernel.KernelSession(session.port, {
          instanceId: session.handshake.instanceId,
          role: 'host',
        });
        frame.session = ks;
        frame.installationId = session.handshake.installationId;
        this.kernelAttachCrashWatch(frame);
        attachKernelServices(this, frame, ks);
        for (const [registrationId, overlay] of frame.overlays) {
          if (!overlay.kernel) continue;
          void ks
            .call('ui.surface.mount', { surfaceId: registrationId }, { deadlineMs: 5000 })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        // Handshake rejected (timeout, nonce mismatch): the plugin stays on
        // the v2 bridge; rev4 surfaces arrive on the next successful load.
      });
  }

  private buildHostHandshake(plugin: InstalledPlugin): kernel.HostHandshake {
    return {
      protocolVersion: kernel.PROTOCOL_VERSION,
      hostVersion: '2.0.0',
      grantedCapabilities: plugin.grantedCapabilities.map((grant) => ({ ...grant })),
      supportedFeatures: HOST_SUPPORTED_FEATURES,
      limits: kernel.DEFAULT_PLUGIN_LIMITS,
      themeTokens: snapshotPluginUiTokens(),
    };
  }

  /**
   * Push the current theme-token snapshot to every live sandbox frame
   * (`neotavern.plugin.tokens` → `globalThis.__neotavernThemeTokens`). The sandbox is
   * opaque-origin and cannot read host stylesheets; widgets re-style from the
   * pushed values, so a theme switch updates plugin UI live.
   */
  pushThemeTokens(): void {
    const tokens = snapshotPluginUiTokens();
    for (const frame of this.frames.values()) {
      frame.iframe.contentWindow?.postMessage(
        { type: 'neotavern.plugin.tokens', pluginId: frame.plugin.id, tokens },
        '*',
      );
    }
  }

  /**
   * Theme changes apply CSS custom properties inline on `:root` (themes,
   * dark/light, safe mode, user.css), so observing the documentElement style
   * attribute is enough to re-sync tokens after every theme mutation.
   */
  private ensureThemeTokenSync(): void {
    if (this.themeTokenObserver !== null) return;
    this.themeTokenObserver = new MutationObserver(() => {
      if (this.themeTokenPushFrame !== null) return;
      this.themeTokenPushFrame = requestAnimationFrame(() => {
        this.themeTokenPushFrame = null;
        this.pushThemeTokens();
      });
    });
    this.themeTokenObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
      subtree: false,
    });
  }

  /** Batch all geometry reads to one animation frame and update the SVG union. */
  private scheduleLayout(frame: RuntimeFrame): void {
    if (frame.layoutFrame !== null) return;
    const flush = (): void => {
      frame.layoutFrame = null;
      this.publishLayout(frame);
    };
    frame.layoutFrame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flush)
        : setTimeout(flush, 0);
  }

  /**
   * rev4 §A4: SVG clip primitives for one overlay's hitShapes, translated to
   * viewport coordinates (clipPathUnits is userSpaceOnUse). Empty array means
   * "no shapes" — the caller falls back to the whole rect.
   */
  private overlayClipPrimitives(overlay: MountOverlay, left: number, top: number): SVGElement[] {
    if (!overlay.hitShapes || overlay.hitShapes.length === 0) return [];
    const primitives: SVGElement[] = [];
    for (const shape of overlay.hitShapes) {
      let element: SVGElement | null = null;
      if (shape.kind === 'rect') {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(left + shape.x));
        rect.setAttribute('y', String(top + shape.y));
        rect.setAttribute('width', String(shape.width));
        rect.setAttribute('height', String(shape.height));
        element = rect;
      } else if (shape.kind === 'circle') {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(left + shape.cx));
        circle.setAttribute('cy', String(top + shape.cy));
        circle.setAttribute('r', String(shape.r));
        element = circle;
      } else if (shape.kind === 'ellipse') {
        const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ellipse.setAttribute('cx', String(left + shape.cx));
        ellipse.setAttribute('cy', String(top + shape.cy));
        ellipse.setAttribute('rx', String(shape.rx));
        ellipse.setAttribute('ry', String(shape.ry));
        element = ellipse;
      } else {
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute(
          'points',
          shape.points.map(([px, py]) => `${left + px},${top + py}`).join(' '),
        );
        element = polygon;
      }
      primitives.push(element);
    }
    return primitives;
  }

  private publishLayout(frame: RuntimeFrame): void {
    const allEntries = [...frame.overlays.entries()].map(([registrationId, overlay]) => ({
      registrationId,
      overlay,
      rect: overlay.container.getBoundingClientRect(),
    }));
    // rev4 §A4: kernel surfaces are host-rendered; their rects travel via
    // `ui.surface.layout`, never through the v2 mount channel.
    const layouts = allEntries
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .map(({ registrationId, overlay, rect }) => ({
        registrationId,
        overlay,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        // Plugin dialogs are mounted in an already modal host, but this keeps
        // their sandbox root above sibling plugin surfaces in the same iframe.
        zIndex: this.registrations.get(registrationId)?.kind === 'dialogs' ? 2 : 1,
      }));
    // rev4 §A4: every visible mode joins the clip union ('native' as shapes
    // or rect, 'proxy'/'none' as the whole rect), one live 'full' overlay
    // unclips the whole iframe, and v2 entries (no hitPolicy) keep the legacy
    // union behavior. Interactivity is decided by the hit layer, not the
    // clip: 'native' relies on browser hit-testing inside the shapes,
    // 'proxy' hit-divs forward normalized packets (shapes gate them), 'none'
    // hit-divs absorb without forwarding.
    // A live 'full' overlay unclips the whole iframe and suppresses the
    // proxy hit layer (rev4 §G7) — decided by the overlay entries, not the
    // measured rects (a full overlay is full-screen by contract).
    const fullActive = [...frame.overlays.values()].some((overlay) => overlay.hitPolicy === 'full');
    // rev4 §G7: while a 'full' overlay is live, the whole iframe is the
    // interactive surface — the proxy hit layer (above the iframe) must not
    // intercept pointer events meant for the full overlay.
    if (frame.hitLayer) {
      frame.hitLayer.style.display = fullActive ? 'none' : '';
    }
    // rev4 §G7: a live 'full' overlay drives the host chrome (plugin-name
    // indicator + host-controlled close). Any layout flush recomputes it;
    // other frames' full overlays are left untouched.
    const fullEntry = [...frame.overlays.entries()].find(
      ([, overlay]) => overlay.hitPolicy === 'full',
    );
    if (fullEntry) {
      this.setOverlayChrome({
        active: true,
        pluginId: frame.plugin.id,
        pluginName: frame.plugin.name,
        registrationId: fullEntry[0],
        frameId: frame.frameId,
      });
    } else if (this.overlayChromeValue.frameId === frame.frameId) {
      this.setOverlayChrome(INACTIVE_OVERLAY_CHROME);
    }
    const clipChildren: SVGElement[] = [];
    if (fullActive) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '0');
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(window.innerWidth));
      rect.setAttribute('height', String(window.innerHeight));
      clipChildren.push(rect);
    } else {
      for (const layout of layouts) {
        // 'native' clips the visual to the shapes (browser hit-testing
        // follows); 'proxy' and 'none' keep the whole rect visible — shapes
        // gate the forwarded pointer packets only (rev4 §G3).
        const primitives =
          layout.overlay.hitPolicy === 'native'
            ? this.overlayClipPrimitives(layout.overlay, layout.left, layout.top)
            : [];
        if (primitives.length > 0) {
          clipChildren.push(...primitives);
        } else {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(layout.left));
          rect.setAttribute('y', String(layout.top));
          rect.setAttribute('width', String(layout.width));
          rect.setAttribute('height', String(layout.height));
          clipChildren.push(rect);
        }
      }
    }
    frame.clipPath.replaceChildren(...clipChildren);
    for (const layout of layouts) {
      if (
        (layout.overlay.hitPolicy === 'proxy' || layout.overlay.hitPolicy === 'none') &&
        layout.overlay.hitDiv
      ) {
        layout.overlay.hitDiv.style.left = `${layout.left}px`;
        layout.overlay.hitDiv.style.top = `${layout.top}px`;
        layout.overlay.hitDiv.style.width = `${layout.width}px`;
        layout.overlay.hitDiv.style.height = `${layout.height}px`;
      }
    }
    for (const layout of layouts) {
      if (layout.overlay.kernel || layout.overlay.mountSent) continue;
      layout.overlay.mountSent = true;
      frame.iframe.contentWindow?.postMessage(
        {
          type: 'neotavern.plugin.mount',
          pluginId: frame.plugin.id,
          registrationId: layout.registrationId,
          context: layout.overlay.context,
          layout: omitOverlay(layout),
        },
        '*',
      );
    }
    frame.host.hidden = layouts.length === 0;
    const v2Layouts = layouts.filter((layout) => !layout.overlay.kernel);
    frame.iframe.contentWindow?.postMessage(
      {
        type: 'neotavern.plugin.layout',
        pluginId: frame.plugin.id,
        layouts: v2Layouts.map(omitOverlay),
      },
      '*',
    );
    this.kernelSendOverlayLayout(frame, layouts);
    this.kernelSendSurfaceLayout(
      frame,
      allEntries
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .map(({ registrationId, rect }) => ({
          registrationId,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        })),
    );
  }

  /** rev4 §A4: push kernel overlay rects to the sandbox (`ui.overlay.layout`). */
  kernelSendOverlayLayout(
    frame: RuntimeFrame,
    layouts: ReadonlyArray<{
      registrationId: string;
      overlay: MountOverlay;
      left: number;
      top: number;
      width: number;
      height: number;
    }>,
  ): void {
    const rects = layouts
      .filter((layout) => layout.overlay.hitPolicy !== undefined)
      .map((layout) => ({
        registrationId: layout.registrationId,
        x: layout.left,
        y: layout.top,
        width: layout.width,
        height: layout.height,
      }));
    if (rects.length === 0 || !frame.session || frame.session.isDisposed) return;
    const key = rects
      .map(
        (rect) =>
          `${rect.registrationId}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`,
      )
      .join('|');
    // Skip identical pushes: layout feedback (e.g. block overscan remounts)
    // must not loop host→sandbox at frame rate (resize-loop guard).
    if (frame.lastOverlayLayoutKey === key) return;
    frame.lastOverlayLayoutKey = key;
    frame.overlayLayoutRevision += 1;
    const payload = { revision: frame.overlayLayoutRevision, rects };
    frame.overlayLayoutSync?.(rects);
    void frame.session
      .call('ui.overlay.layout', payload, { deadlineMs: 1000 })
      .catch(() => undefined);
  }

  /** rev4 §A4: recompute kernel overlay rects and push `ui.overlay.layout`. */
  kernelPushOverlayLayout(frame: RuntimeFrame): void {
    const layouts = [...frame.overlays.entries()]
      .filter(([, overlay]) => overlay.hitPolicy !== undefined)
      .map(([registrationId, overlay]) => {
        const rect = overlay.container.getBoundingClientRect();
        return {
          registrationId,
          overlay,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((layout) => layout.width > 0 && layout.height > 0);
    this.kernelSendOverlayLayout(frame, layouts);
  }

  /** rev4 §A4: push kernel surface rects to the sandbox (`ui.surface.layout`). */
  kernelSendSurfaceLayout(
    frame: RuntimeFrame,
    layouts: ReadonlyArray<{
      registrationId: string;
      left: number;
      top: number;
      width: number;
      height: number;
    }>,
  ): void {
    const rects = layouts
      .filter((layout) => this.registrations.get(layout.registrationId)?.kernel === true)
      .map((layout) => ({
        registrationId: layout.registrationId,
        x: layout.left,
        y: layout.top,
        width: layout.width,
        height: layout.height,
      }));
    if (rects.length === 0 || !frame.session || frame.session.isDisposed) return;
    void frame.session
      .call('ui.surface.layout', { rects }, { deadlineMs: 1000 })
      .catch(() => undefined);
  }

  private removeOverlay(frame: RuntimeFrame, registrationId: string, notifySandbox: boolean): void {
    const overlay = frame.overlays.get(registrationId);
    if (!overlay) return;
    if (notifySandbox) {
      frame.iframe.contentWindow?.postMessage(
        { type: 'neotavern.plugin.unmount', pluginId: frame.plugin.id, registrationId },
        '*',
      );
      // rev4 §A4/G7: kernel overlays (hitPolicy path, no `kernel` flag) clean
      // their sandbox DOM through the kernel unmount RPC — the legacy
      // postMessage channel only knows v2 `definition.mount` registrations.
      if (!overlay.kernel && frame.session && !frame.session.isDisposed) {
        void frame.session
          .call('ui.surface.unmount', { surfaceId: registrationId }, { deadlineMs: 1000 })
          .catch(() => undefined);
      }
    }
    overlay.stopTracking();
    overlay.stopHitProxy?.();
    this.removeKernelContainer(overlay);
    this.kernelUnmountSurface(frame, registrationId);
    frame.overlays.delete(registrationId);
    if (frame.overlays.size === 0) frame.host.hidden = true;
    this.scheduleLayout(frame);
  }

  private clearOverlays(frame: RuntimeFrame): void {
    if (frame.layoutFrame !== null) {
      if (typeof frame.layoutFrame === 'number' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame.layoutFrame);
      } else {
        clearTimeout(frame.layoutFrame);
      }
      frame.layoutFrame = null;
    }
    for (const overlay of frame.overlays.values()) {
      overlay.stopTracking();
      overlay.stopHitProxy?.();
      overlay.trackTarget?.();
      this.removeKernelContainer(overlay);
    }
    frame.hitLayer?.replaceChildren();
    frame.overlays.clear();
    frame.surfaceContainers.clear();
    frame.clipPath.replaceChildren();
    frame.host.hidden = true;
    // rev4 §G7: the chrome must never outlive its full overlay.
    if (this.overlayChromeValue.frameId === frame.frameId) {
      this.setOverlayChrome(INACTIVE_OVERLAY_CHROME);
    }
  }

  /** Kernel slices own their containers (dataset marker); v2 containers are app-owned. */
  private removeKernelContainer(overlay: MountOverlay): void {
    if (overlay.container.dataset.neotavernOverlay) overlay.container.remove();
  }

  private permissionAllows(plugin: InstalledPlugin, kind: PluginRegistrationKind): boolean {
    const permission = REQUIRED_PERMISSION[kind];
    return permission === undefined || plugin.grantedPermissions.includes(permission);
  }

  private addI18nResources(plugin: InstalledPlugin, message: SandboxMessage): void {
    if (
      !this.i18n ||
      typeof message.language !== 'string' ||
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(message.language) ||
      !isRecord(message.resources)
    ) {
      return;
    }
    const serialized = JSON.stringify(message.resources);
    if (serialized.length > 256 * 1024) return;
    this.i18n.addResourceBundle(
      message.language,
      `plugin.${plugin.id}`,
      message.resources,
      true,
      true,
    );
    const languages = this.i18nLanguages.get(plugin.id) ?? new Set<string>();
    languages.add(message.language);
    this.i18nLanguages.set(plugin.id, languages);
  }

  private removeI18nResources(pluginId: string): void {
    const languages = this.i18nLanguages.get(pluginId);
    this.i18nLanguages.delete(pluginId);
    if (!this.i18n || !languages) return;
    for (const language of languages) {
      this.i18n.removeResourceBundle(language, `plugin.${pluginId}`);
    }
  }

  /** Drop one language bundle on SDK cleanup (neotavern.plugin.i18n.remove). */
  private removeI18nLanguage(pluginId: string, language: string): void {
    this.i18nLanguages.get(pluginId)?.delete(language);
    this.i18n?.removeResourceBundle(language, `plugin.${pluginId}`);
  }

  private publish(): void {
    this.snapshot = [...this.registrations.values()];
    for (const listener of this.listeners) listener();
  }
}

/** rev4 §A4: normalized overlay pointer coordinates stay within [0, 1]. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const POINTER_PACKET_TYPES: Record<string, OverlayPointerPacket['type']> = {
  pointerdown: 'down',
  pointermove: 'move',
  pointerup: 'up',
  pointercancel: 'cancel',
};

function trackOverlayRect(target: HTMLElement, onChange: () => void): () => void {
  const update = (): void => onChange();
  update();
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
  observer?.observe(target);
  window.addEventListener('resize', update);
  window.addEventListener('scroll', update, true);
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', update);
    window.removeEventListener('scroll', update, true);
  };
}

function omitOverlay(layout: {
  registrationId: string;
  overlay: MountOverlay;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
}): Omit<typeof layout, 'overlay'> {
  const { overlay: _overlay, ...serializable } = layout;
  return serializable;
}

function sanitizeRegistration(
  plugin: InstalledPlugin,
  message: SandboxMessage,
): PluginUiRegistration | null {
  if (
    !message.registrationId ||
    !isRegistrationKind(message.kind) ||
    !isRecord(message.definition)
  ) {
    return null;
  }
  const id = message.definition['id'];
  const title = message.definition['title'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 160 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > 200
  ) {
    return null;
  }
  const path = optionalSafeString(message.definition['path'], 300);
  if (
    message.kind === 'pages' &&
    (!path || !path.startsWith('/') || path.includes('..') || path.includes('\\'))
  ) {
    return null;
  }
  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    registrationId: message.registrationId,
    kind: message.kind,
    definition: {
      id,
      title,
      ...(path ? { path } : {}),
      ...optionalDefinitionFields(message.definition),
    },
  };
}

function optionalDefinitionFields(
  definition: Record<string, unknown>,
): Partial<PluginUiRegistration['definition']> {
  const output: Partial<PluginUiRegistration['definition']> = {};
  for (const [field, limit] of [
    ['slot', 32],
    ['context', 20],
    ['combo', 100],
    ['icon', 100],
    ['description', 500],
    ['placement', 20],
    ['permission', 64],
  ] as const) {
    const value = optionalSafeString(definition[field], limit);
    if (value) output[field] = value;
  }
  const action = definition['action'];
  if (isRecord(action)) {
    if (
      action['type'] === 'command' &&
      typeof action['commandId'] === 'string' &&
      action['commandId'].length > 0 &&
      action['commandId'].length <= 200
    ) {
      output['action'] = { type: 'command', commandId: action['commandId'] };
    } else if (
      action['type'] === 'event' &&
      typeof action['event'] === 'string' &&
      action['event'].length > 0 &&
      action['event'].length <= 200
    ) {
      output['action'] = { type: 'event', event: action['event'] };
    }
  }
  for (const [field, max] of [
    ['priority', 60_000],
    ['timeoutMs', 60_000],
    ['order', 10_000],
  ] as const) {
    const value = definition[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max) {
      output[field] = value;
    }
  }
  return output;
}

function isPromptInterceptorContext(
  value: unknown,
  expectedChatId: string,
): value is {
  chatId: string;
  messages: Array<{ id?: string; role: string; content: string; name?: string | null }>;
  meta: Record<string, unknown>;
} {
  if (
    !isRecord(value) ||
    value['chatId'] !== expectedChatId ||
    !Array.isArray(value['messages']) ||
    !isRecord(value['meta']) ||
    value['messages'].length > 500
  ) {
    return false;
  }
  return value['messages'].every(
    (message) =>
      isRecord(message) &&
      (message['id'] === undefined || typeof message['id'] === 'string') &&
      ['system', 'user', 'assistant', 'tool'].includes(String(message['role'])) &&
      typeof message['content'] === 'string' &&
      (message['name'] === undefined ||
        message['name'] === null ||
        typeof message['name'] === 'string'),
  );
}

function optionalSafeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function isRegistrationKind(value: unknown): value is PluginRegistrationKind {
  return [
    'messageActions',
    'toolbarActions',
    'pages',
    'settingsPanels',
    'sidebarPanels',
    'contextMenuItems',
    'messageRenderers',
    'characterTabs',
    'dialogs',
    'commands',
    'hotkeys',
    'slash',
    'interceptors',
    'slots',
  ].includes(String(value));
}

function isSandboxMessage(value: unknown): value is SandboxMessage {
  return (
    isRecord(value) && typeof value['type'] === 'string' && typeof value['pluginId'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedEventPayload(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return json !== undefined && json.length <= 256 * 1024;
  } catch {
    return false;
  }
}

/** rev4 §B2: stable CAPABILITY_DENIED error for the consent round-trip. */
function consentError(capability: string, reason: string): kernel.KernelError {
  return new kernel.KernelError(kernel.KernelErrorCode.CAPABILITY_DENIED, {
    details: { capability, reason },
  });
}

/** rev4 §B2: server grants must carry a name and a positive revision. */
function isValidGrant(grant: kernel.CapabilityGrant | null): grant is kernel.CapabilityGrant {
  return (
    grant !== null &&
    typeof grant['name'] === 'string' &&
    grant['name'].length > 0 &&
    typeof grant['revision'] === 'number' &&
    Number.isSafeInteger(grant['revision']) &&
    grant['revision'] >= 1
  );
}

export const frontendPluginRuntime = new FrontendPluginRuntime();

export function usePluginRegistrations(
  kind?: PluginRegistrationKind,
): readonly PluginUiRegistration[] {
  const registrations = useSyncExternalStore(
    frontendPluginRuntime.subscribe,
    frontendPluginRuntime.getSnapshot,
    frontendPluginRuntime.getSnapshot,
  );
  return useMemo(
    () =>
      kind ? registrations.filter((registration) => registration.kind === kind) : registrations,
    [kind, registrations],
  );
}
