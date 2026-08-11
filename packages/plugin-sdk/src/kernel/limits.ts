/**
 * Plugin SDK revision-4 kernel: programmatic limits (invariant 7).
 *
 * Every limit is a policy default the host can lower per installation; the
 * SDK never hardcodes a number in docs alone — plugins read `api.limits`.
 */

export interface WorkerLimits {
  maxInstances: number;
  memoryMiB: number;
  maxMessageBytes: number;
  /** Entry bundle cap enforced on the host asset fetch and in the sandbox. */
  maxBundleBytes: number;
  /**
   * Cap for `.mjs` worker bundles, which ride `data:` URLs inside the opaque
   * sandbox (blob: module workers cannot resolve their entry across opaque
   * origins; ADR-0018). Chromium rejects data: scripts above ~2 MiB, so the
   * module cap sits at 1.5 MiB while classic `.js` entries keep the full
   * `maxBundleBytes` over blob:.
   */
  maxModuleDataUrlBytes: number;
}

export interface StreamLimits {
  maxConcurrent: number;
  maxInFlightBytes: number;
  maxBufferedBytesPerStream: number;
  maxBufferedBytesPerPlugin: number;
  idleDeadlineMs: number;
  totalDeadlineMs: number;
  maxTotalBytes: number;
  consumerIdleTimeoutMs: number;
}

export interface OverlayLimits {
  maxShapes: number;
  maxPolygonPoints: number;
  maxGeometryBytes: number;
  maxUpdatesPerSecond: number;
}

export interface StorageLimits {
  kvBytes: number;
  kvKeys: number;
  blobBytes: number;
  maxBlobFileBytes: number;
}

export interface MessageBlockLimits {
  maxBlocksPerMessage: number;
  maxMountedPerChat: number;
}

export interface ChatLimits {
  maxDraftBytes: number;
  maxDraftDeltaBytes: number;
  draftCoalesceHz: number;
  maxContentBytes: number;
}

export interface PluginLimits {
  workers: WorkerLimits;
  streams: StreamLimits;
  overlays: OverlayLimits;
  storage: StorageLimits;
  messageBlocks: MessageBlockLimits;
  chat: ChatLimits;
}

/** The defaults every host starts from (rev4 §G6, §M2). */
export const DEFAULT_PLUGIN_LIMITS: PluginLimits = {
  workers: {
    maxInstances: 2,
    memoryMiB: 256,
    maxMessageBytes: 4 * 1024 * 1024,
    maxBundleBytes: 2 * 1024 * 1024,
    maxModuleDataUrlBytes: 1.5 * 1024 * 1024,
  },
  streams: {
    maxConcurrent: 4,
    maxInFlightBytes: 1024 * 1024,
    maxBufferedBytesPerStream: 2 * 1024 * 1024,
    maxBufferedBytesPerPlugin: 8 * 1024 * 1024,
    idleDeadlineMs: 30_000,
    totalDeadlineMs: 10 * 60_000,
    maxTotalBytes: 512 * 1024 * 1024,
    consumerIdleTimeoutMs: 15_000,
  },
  overlays: {
    maxShapes: 32,
    maxPolygonPoints: 256,
    maxGeometryBytes: 16_384,
    maxUpdatesPerSecond: 60,
  },
  storage: {
    kvBytes: 1024 * 1024,
    kvKeys: 4096,
    blobBytes: 1024 * 1024 * 1024,
    maxBlobFileBytes: 64 * 1024 * 1024,
  },
  messageBlocks: {
    maxBlocksPerMessage: 4,
    maxMountedPerChat: 32,
  },
  chat: {
    maxDraftBytes: 1024 * 1024,
    maxDraftDeltaBytes: 64 * 1024,
    draftCoalesceHz: 10,
    maxContentBytes: 256 * 1024,
  },
};

/** Flatten a limit path (`storage.blobs.maxFileBytes`) into its value. */
export function getLimit(limits: PluginLimits, path: string): number | undefined {
  const segments = path.split('.');
  let current: unknown = limits;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

/** Merge host overrides over the defaults (shallow per section). */
export function mergeLimits(overrides?: Partial<PluginLimits>): PluginLimits {
  return {
    workers: { ...DEFAULT_PLUGIN_LIMITS.workers, ...overrides?.workers },
    streams: { ...DEFAULT_PLUGIN_LIMITS.streams, ...overrides?.streams },
    overlays: { ...DEFAULT_PLUGIN_LIMITS.overlays, ...overrides?.overlays },
    storage: { ...DEFAULT_PLUGIN_LIMITS.storage, ...overrides?.storage },
    messageBlocks: { ...DEFAULT_PLUGIN_LIMITS.messageBlocks, ...overrides?.messageBlocks },
    chat: { ...DEFAULT_PLUGIN_LIMITS.chat, ...overrides?.chat },
  };
}
