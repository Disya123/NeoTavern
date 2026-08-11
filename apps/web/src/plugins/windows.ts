/**
 * Rev4 §J3: multi-window background singleton.
 *
 * One plugin installation may be activated in several windows at once (each
 * window gets its own UI instance). Background work, however, must run in
 * exactly one window — otherwise every tab would start its own consumer
 * (event listeners, polling, job triggers). This module elects a single
 * "primary" window per installation over BroadcastChannel (same origin ⇒
 * all tabs of the app share the channel) and exposes the role to the kernel
 * `windows.*` slice.
 *
 * Election rules:
 * - every window with a live frame of the installation posts claim +
 *   periodic heartbeats on `neotavern:rev4:windows:<installationId>`;
 * - each window keeps the peer claims map and derives the leader
 *   deterministically: the live claim with the smallest windowId wins
 *   (no contest races, self-healing);
 * - a claim expires after `leaseMs` without heartbeats, so a dead primary
 *   is taken over by the remaining windows (crash-safe);
 * - `pagehide` releases the claim best-effort; the lease covers the hard
 *   cases (killed renderer, unload without event).
 *
 * Without BroadcastChannel the manager degrades to `standalone`: the window
 * is its own primary (single-window environments keep full functionality).
 *
 * Memory/cleanup: the manager exists while at least one listener is
 * attached (the kernel slice tracks one per plugin session via the session
 * scope); when the last listener detaches it releases the claim, closes the
 * channel and clears its interval (rev4 §0 invariant 6).
 */
export type WindowRole = 'primary' | 'secondary' | 'standalone';

export interface WindowRoleSnapshot {
  role: WindowRole;
  windowId: string;
  installationId: string;
  isBackground: boolean;
}

/** Minimal BroadcastChannel subset so tests can inject a fake hub. */
export interface WindowRoleChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface WindowRoleManagerOptions {
  /** Interval between heartbeat posts and leadership recomputation. */
  heartbeatMs?: number;
  /** A claim is dead after this long without heartbeats. */
  leaseMs?: number;
  now?: () => number;
  /** Channel factory; returns null to degrade to standalone. */
  createChannel?: (name: string) => WindowRoleChannel | null;
  /** Test hook: deterministic window identity. */
  windowId?: string;
}

interface PeerClaim {
  windowId: string;
  lastSeen: number;
}

const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_LEASE_MS = 4_000;

export class WindowRoleManager {
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly windowId: string;
  private readonly channel: WindowRoleChannel | null;
  private readonly claims = new Map<string, PeerClaim>();
  private readonly listeners = new Set<(snapshot: WindowRoleSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private lastRole: WindowRole | null = null;

  constructor(
    readonly installationId: string,
    options: WindowRoleManagerOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => Date.now());
    this.windowId =
      options.windowId ?? globalThis.crypto?.randomUUID?.() ?? `w-${this.now()}-${Math.random()}`;
    this.channel = (options.createChannel ?? defaultChannelFactory)(this.channelName());
  }

  private channelName(): string {
    return `neotavern:rev4:windows:${this.installationId}`;
  }

  /** Start the heartbeat loop and announce the claim (idempotent). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.channel) return; // standalone
    this.channel.addEventListener('message', this.onMessage);
    this.post('claim');
    this.timer = setInterval(() => {
      this.post('heartbeat');
      this.recompute();
    }, this.heartbeatMs);
    this.recompute();
  }

  /** Stop heartbeats, release the claim and close the channel. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.channel) {
      this.channel.removeEventListener('message', this.onMessage);
      this.post('release');
      this.channel.close();
    }
    this.claims.clear();
    this.listeners.clear();
  }

  /** Subscribe to role transitions. Returns an unsubscribe function. */
  onChange(listener: (snapshot: WindowRoleSnapshot) => void): () => void {
    if (this.stopped) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Current role snapshot, derived from the live claims map. */
  snapshot(): WindowRoleSnapshot {
    const role = this.computeRole();
    return {
      role,
      windowId: this.windowId,
      installationId: this.installationId,
      isBackground: role !== 'secondary',
    };
  }

  private onMessage = (event: { data: unknown }): void => {
    const message = event.data as Record<string, unknown>;
    if (!message || typeof message !== 'object') return;
    if (message.kind !== 'claim' && message.kind !== 'heartbeat' && message.kind !== 'release') {
      return;
    }
    const peerWindowId = message.windowId;
    if (typeof peerWindowId !== 'string' || peerWindowId === this.windowId) return;
    if (message.kind === 'release') {
      this.claims.delete(peerWindowId);
    } else {
      const existing = this.claims.get(peerWindowId);
      this.claims.set(peerWindowId, {
        windowId: peerWindowId,
        lastSeen: existing ? Math.max(existing.lastSeen, this.now()) : this.now(),
      });
    }
    this.recompute();
  };

  private post(kind: 'claim' | 'heartbeat' | 'release'): void {
    this.channel?.postMessage({
      kind,
      windowId: this.windowId,
      installationId: this.installationId,
      ts: this.now(),
    });
  }

  /** Drop expired peer claims and fire listeners on role transitions. */
  private recompute(): void {
    if (this.stopped) return;
    const cutoff = this.now() - this.leaseMs;
    for (const [peerId, claim] of this.claims) {
      if (claim.lastSeen < cutoff) this.claims.delete(peerId);
    }
    const role = this.computeRole();
    if (this.lastRole === null) {
      // Record the initial role without firing: consumers read it via
      // `snapshot()`/`windows.role`; onChange is for transitions only.
      this.lastRole = role;
      return;
    }
    if (role === this.lastRole) return;
    this.lastRole = role;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A failing listener must not break the election loop.
      }
    }
  }

  private computeRole(): WindowRole {
    if (!this.channel || this.stopped) return 'standalone';
    const now = this.now();
    const live = [this.windowId, ...this.claims.keys()].filter((id) => {
      if (id === this.windowId) return true; // own claim is live by construction
      const claim = this.claims.get(id);
      return claim !== undefined && claim.lastSeen >= now - this.leaseMs;
    });
    if (live.length === 0) return 'primary';
    // Deterministic tie-break: the smallest window id leads.
    return live.sort()[0] === this.windowId ? 'primary' : 'secondary';
  }
}

function defaultChannelFactory(name: string): WindowRoleChannel | null {
  if (typeof globalThis.BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(name);
  return {
    postMessage: (message) => channel.postMessage(message),
    addEventListener: (type, listener) => channel.addEventListener(type, listener),
    removeEventListener: (type, listener) => channel.removeEventListener(type, listener),
    close: () => channel.close(),
  };
}
