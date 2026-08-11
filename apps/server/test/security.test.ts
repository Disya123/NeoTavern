/**
 * Content-Security-Policy contract (ТЗ §13): scripts stay same-origin, but
 * chat/character-card image links must load from remote hosts (ST1 parity) —
 * a regression here silently breaks every external image in single-process
 * mode while dev mode (Vite serves the page without this CSP) keeps working.
 */
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/lib/security.js';

function directive(name: string): string[] {
  const entry = CONTENT_SECURITY_POLICY.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  if (!entry) throw new Error(`CSP directive ${name} missing`);
  return entry.slice(name.length + 1).split(/\s+/);
}

describe('Content-Security-Policy (ТЗ §13)', () => {
  it('allows remote http(s) images for markdown image links', () => {
    expect(directive('img-src')).toEqual(expect.arrayContaining(['http:', 'https:']));
  });

  it('keeps scripts strictly same-origin', () => {
    expect(directive('script-src')).toEqual(["'self'"]);
  });

  it('does not allow remote objects or frames', () => {
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('frame-ancestors')).toEqual(["'self'"]);
  });
});
