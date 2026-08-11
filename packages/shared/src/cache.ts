/**
 * Bounded LRU cache with optional TTL and hit/miss metrics (ТЗ §11.2, AGENTS.md
 * §20). Every in-memory cache in the application MUST have: a size limit, a TTL
 * when data can go stale, explicit invalidation and hit/miss statistics.
 * Unbounded module-level `Map`s are forbidden.
 *
 * Versioned keys are the caller's responsibility: include a format revision or
 * content hash in the key string (e.g. `${format.id}:${format.version}`) so a
 * format change implicitly invalidates stale entries.
 *
 * Isomorphic: no `node:` imports, safe for frontend use.
 */

/** Observable cache statistics (ТЗ §11.2 «статистику hit/miss»). */
export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  /** Current number of live entries (expired-but-unpruned entries excluded). */
  size: number;
}

export interface LruCacheOptions {
  /** Maximum number of entries. The least-recently-used entry is evicted first. */
  maxSize: number;
  /** Entry lifetime in milliseconds. Omit for entries that never expire. */
  ttlMs?: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number | null;
}

/**
 * A synchronous LRU cache. `Map` iteration order is insertion order, so touching
 * an entry re-inserts it to keep the least-recently-used entry first.
 */
export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number | undefined;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: LruCacheOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
      throw new Error('LruCache maxSize must be a positive integer');
    }
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new Error('LruCache ttlMs must be a positive number');
    }
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  /** Read an entry, marking it most-recently-used. Returns undefined on miss or expiry. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.map.delete(key);
      this.evictions += 1;
      this.misses += 1;
      return undefined;
    }
    // Re-insert to refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** Insert or overwrite an entry, evicting least-recently-used entries over the limit. */
  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, {
      value,
      expiresAt: this.ttlMs === undefined ? null : Date.now() + this.ttlMs,
    });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /**
   * Return the cached value or compute, store and return it. The factory runs
   * at most once per missing key (see {@link getOrComputeAsync} for async work).
   */
  getOrCompute(key: string, factory: () => V): V {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = factory();
    this.set(key, value);
    return value;
  }

  /**
   * Async variant of {@link getOrCompute}. Concurrent calls for the same
   * missing key share a single in-flight computation; the in-flight slot is
   * always cleaned up, so it never accumulates.
   */
  async getOrComputeAsync(key: string, factory: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const pending = factory()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private readonly inFlight = new Map<string, Promise<V>>();

  /** Explicit invalidation of a single key (ТЗ §11.2 «явную invalidation»). */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Drop every entry. */
  clear(): void {
    this.map.clear();
    this.inFlight.clear();
  }

  /** Number of stored entries (may include not-yet-pruned expired entries). */
  get size(): number {
    return this.map.size;
  }

  private liveSize(): number {
    if (this.ttlMs === undefined) return this.map.size;
    const now = Date.now();
    let size = 0;
    for (const entry of this.map.values()) {
      if (entry.expiresAt === null || now < entry.expiresAt) size += 1;
    }
    return size;
  }

  metrics(): CacheMetrics {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.liveSize(),
    };
  }

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }
}

/** Convenience factory mirroring the class name used across the codebase. */
export function createLruCache<V>(options: LruCacheOptions): LruCache<V> {
  return new LruCache<V>(options);
}
