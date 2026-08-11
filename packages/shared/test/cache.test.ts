import { describe, expect, it, vi } from 'vitest';
import { LruCache, createLruCache } from '../src/cache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<number>({ maxSize: 4 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry over the limit', () => {
    const cache = new LruCache<number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.metrics().evictions).toBe(1);
  });

  it('treats get() as a recency touch', () => {
    const cache = new LruCache<number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' becomes most recent
    cache.set('c', 3); // evicts 'b', not 'a'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires entries after ttlMs', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruCache<number>({ maxSize: 4, ttlMs: 1000 });
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(1001);
      expect(cache.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes expired unpruned entries from metrics size', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruCache<number>({ maxSize: 4, ttlMs: 1000 });
      cache.set('a', 1);
      vi.advanceTimersByTime(1001);
      expect(cache.size).toBe(1);
      expect(cache.metrics()).toMatchObject({ size: 0, evictions: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks hit/miss/eviction metrics', () => {
    const cache = new LruCache<number>({ maxSize: 1 });
    cache.set('a', 1);
    cache.get('a'); // hit
    cache.get('b'); // miss
    cache.set('c', 3); // evicts 'a'
    const metrics = cache.metrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.evictions).toBe(1);
    expect(metrics.size).toBe(1);
  });

  it('supports explicit invalidation and clear', () => {
    const cache = new LruCache<number>({ maxSize: 4 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('getOrCompute computes once and caches', () => {
    const cache = new LruCache<number>({ maxSize: 4 });
    let calls = 0;
    const factory = (): number => {
      calls += 1;
      return 42;
    };
    expect(cache.getOrCompute('k', factory)).toBe(42);
    expect(cache.getOrCompute('k', factory)).toBe(42);
    expect(calls).toBe(1);
  });

  it('getOrComputeAsync deduplicates concurrent in-flight computations', async () => {
    const cache = new LruCache<number>({ maxSize: 4 });
    let calls = 0;
    const factory = (): Promise<number> => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve(7), 10));
    };
    const [a, b] = await Promise.all([
      cache.getOrComputeAsync('k', factory),
      cache.getOrComputeAsync('k', factory),
    ]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(calls).toBe(1);
    // Subsequent call is served from the cache.
    expect(await cache.getOrComputeAsync('k', factory)).toBe(7);
    expect(calls).toBe(1);
  });

  it('getOrComputeAsync cleans up the in-flight slot on failure', async () => {
    const cache = new LruCache<number>({ maxSize: 4 });
    let calls = 0;
    const failing = (): Promise<number> => {
      calls += 1;
      return Promise.reject(new Error('boom'));
    };
    await expect(cache.getOrComputeAsync('k', failing)).rejects.toThrow('boom');
    await expect(cache.getOrComputeAsync('k', failing)).rejects.toThrow('boom');
    expect(calls).toBe(2); // retried, not stuck on the dead in-flight promise
  });

  it('rejects invalid construction options', () => {
    expect(() => createLruCache<number>({ maxSize: 0 })).toThrow();
    expect(() => createLruCache<number>({ maxSize: 2, ttlMs: -1 })).toThrow();
  });

  it('overwriting a key refreshes its value without growing size', () => {
    const cache = new LruCache<number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });
});
