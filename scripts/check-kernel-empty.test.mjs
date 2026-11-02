/**
 * The kernel-plane "no silent fallbacks" gate must classify branches, not lines.
 *
 * Fixtures pin the four ways a textual scan goes wrong: a negated guard, a
 * ternary, a branch whose work lives in a returned closure, and a branch that
 * throws via `new UnsupportedError(...)` (a NewExpression, not a CallExpression).
 */
import { describe, expect, it } from 'vitest';
import { findKernelEmptyBranches } from './check-kernel-empty.mjs';

describe('findKernelEmptyBranches', () => {
  it('flags an unmarked branch that fabricates a value', () => {
    const source = [
      'function f() {',
      '  if (isKernelMode()) {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toHaveLength(1);
  });

  it('accepts a marked branch (marker inside the block)', () => {
    const source = [
      'function f() {',
      '  if (isKernelMode()) {',
      '    // kernel-empty: the kernel has no URL surface',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('accepts a marker above a single-line guard', () => {
    const source = [
      'function f() {',
      '  // kernel-empty: no URL surface',
      '  if (isKernelMode()) return null;',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('accepts a branch that calls the backend', () => {
    const source = [
      'async function f() {',
      '  if (isKernelMode()) {',
      '    const page = await backend.assets.list({ limit: 1 });',
      '    return page;',
      '  }',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('accepts a branch that fails closed with UnsupportedError', () => {
    const source = [
      'function f() {',
      '  if (isKernelMode()) {',
      "    throw new UnsupportedError('plugins.install.host-verify');",
      '  }',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('accepts a branch whose returned closures throw', () => {
    const source = [
      'function f() {',
      '  if (isKernelMode()) {',
      '    return {',
      '      request: () => {',
      "        throw new UnsupportedError('legacy.raw');",
      '      },',
      '    };',
      '  }',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('ignores negated guards and ternaries (not kernel fallbacks)', () => {
    const source = [
      'function f(mode, items) {',
      '  if (!isKernelMode()) return null;',
      '  const x = isKernelMode() ? items.some((i) => i === 1) : false;',
      '  return x;',
      '}',
    ].join('\n');
    expect(findKernelEmptyBranches(source, 'a.ts')).toEqual([]);
  });

  it('reports the 1-based line of the guard', () => {
    const source = [
      '',
      'function f() {',
      '  if (isKernelMode()) {',
      '    return [];',
      '  }',
      '}',
    ].join('\n');
    const hits = findKernelEmptyBranches(source, 'a.tsx');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
  });
});
