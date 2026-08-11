/**
 * Unit tests for the BoundedConsoleSink core (ТЗ v3.2 §9.1.1/§9.1.2).
 *
 * `consoleSink.mjs` is part of the trusted Worker bootstrap (ADR-0028): the
 * formatter must never invoke getters, never run unbounded serialization and
 * never throw; the ring must stay within its fixed byte budget, coalesce
 * identical consecutive records and account drops.
 */
import { describe, expect, it } from 'vitest';
import { makeBoundedFormatter, makeLogRing } from './consoleSink.mjs';

const LIMITS = {
  maxDepth: 4,
  maxKeys: 16,
  maxItems: 32,
  maxStringBytes: 512,
  maxRecordBytes: 4000,
  maxStackFrames: 32,
  maxVisits: 4096,
};

describe('bounded formatter (§9.1.2)', () => {
  const format = makeBoundedFormatter(LIMITS);

  it('formats primitives and shallow previews', () => {
    expect(format(['hello', 42, null, undefined, true])).toBe('hello 42 null undefined true');
    expect(format([{ a: 1, b: [1, 2] }])).toBe('Object {a: 1, b: Array(2)[1, 2]}');
    expect(format([() => 1])).toBe('[Function]');
  });

  it('never invokes getters (§9.1.2)', () => {
    let invoked = false;
    const hostile = {
      get secret() {
        invoked = true;
        return 'leak';
      },
      plain: 1,
    };
    expect(format([hostile])).toContain('[Getter]');
    expect(invoked).toBe(false);
  });

  it('contains proxy traps with a placeholder and does not throw', () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(() => format([proxy])).not.toThrow();
    expect(format([proxy])).toBe('[Uninspected]');
  });

  it('bounds depth, keys and items', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(format([deep])).toContain('[…]');
    const wide = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
      k: 11,
      l: 12,
      m: 13,
      n: 14,
      o: 15,
      p: 16,
      q: 17,
    };
    expect(format([wide])).toContain('…+1');
    expect(format([[1, 2, 3, 4]])).toBe('Array(4)[1, 2, 3, 4]');
  });

  it('bounds string and record bytes', () => {
    const message = format(['x'.repeat(10_000)]);
    expect(message.length).toBeLessThanOrEqual(LIMITS.maxStringBytes + 1);
    const many = format([{ a: 'x'.repeat(600), b: 'y'.repeat(600) }, 'z'.repeat(4000)]);
    expect(many.length).toBeLessThanOrEqual(LIMITS.maxRecordBytes + 1);
  });

  it('handles circular structures without hanging', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;
    expect(() => format([circular])).not.toThrow();
    expect(format([circular])).toContain('self:');
  });

  it('formats errors as name: message with bounded stack', () => {
    const error = new TypeError('boom');
    const rendered = format([error]);
    expect(rendered).toContain('TypeError: boom');
    // Stack may be censored by SES taming (errorTaming: 'safe'), but when
    // present it is bounded to maxStackFrames lines.
    if (rendered.includes('\n')) {
      expect(rendered.split('\n').length).toBeLessThanOrEqual(LIMITS.maxStackFrames + 2);
    }
  });

  it('never throws on exotic values', () => {
    expect(() => format([Symbol('x'), 1n, new Date(), new Uint8Array(4), /re/])).not.toThrow();
    expect(format([new Uint8Array(4)])).toBe('Uint8Array(4)');
  });
});

describe('log ring (§9.1.1)', () => {
  it('stays within the fixed byte budget and accounts drops', () => {
    // "msg N" ≈ 8 bytes + 96 overhead ≈ 104 bytes → 64 KiB / 104 ≈ 630.
    const ring = makeLogRing(64 * 1024, 96);
    for (let i = 0; i < 1000; i += 1) ring.push('info', `msg ${i}`, i);
    expect(ring.bytesUsed).toBeLessThanOrEqual(64 * 1024);
    expect(ring.size).toBeGreaterThan(0);
    expect(ring.dropped).toBe(1000 - ring.size);
  });

  it('coalesces identical consecutive records with a bounded count', () => {
    const ring = makeLogRing(64 * 1024, 96);
    for (let i = 0; i < 10; i += 1) ring.push('log', 'same', i);
    ring.push('log', 'other', 10);
    const drained = ring.drain(100, 64 * 1024);
    expect(drained).toEqual([
      { level: 'log', message: 'same', at: 0, count: 10 },
      { level: 'log', message: 'other', at: 10 },
    ]);
  });

  it('drains up to the batch record/byte bounds', () => {
    const ring = makeLogRing(64 * 1024, 96);
    for (let i = 0; i < 500; i += 1) ring.push('info', `msg ${i}`, i);
    const drained = ring.drain(256, 16 * 1024);
    expect(drained.length).toBeLessThanOrEqual(256);
    // Remaining records stay in the ring (the ring is the only buffer).
    expect(ring.size).toBe(500 - drained.length);
    expect(ring.dropped).toBe(0);
  });

  it('counts oversized batches as dropped via countDropped', () => {
    const ring = makeLogRing(64 * 1024, 96);
    ring.push('info', 'a', 0);
    ring.countDropped(3);
    expect(ring.dropped).toBe(3);
    expect(ring.size).toBe(1);
  });

  it('drops when the ring is full without unbounded growth', () => {
    const tiny = makeLogRing(200, 96);
    tiny.push('info', 'a', 0);
    tiny.push('info', 'b', 1);
    tiny.push('info', 'c', 2);
    expect(tiny.size).toBe(2);
    expect(tiny.dropped).toBe(1);
  });
});
