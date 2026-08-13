/**
 * Kernel-mode Content-Security-Policy contract (ТЗ §10/§51/§86, §92): the
 * Tauri shell's `tauri.conf.json` CSP is the script boundary of the default
 * kernel mode (window over `tauri://localhost`, no HTTP server). Scripts
 * must stay strictly same-origin — no `'unsafe-eval'`, no remote origins,
 * no `data:`/`blob:` script sources — and objects and frame embedding stay
 * locked down. A regression here would let third-party script reach the
 * kernel-mode WebView (the legacy sidecar mode, which serves the SPA over
 * HTTP, is governed by the server's own CSP in `src/lib/security.ts`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tauriConfig = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../desktop/src-tauri/tauri.conf.json'),
    'utf8',
  ),
) as { app: { security: { csp: string } } };

const csp: string = tauriConfig.app.security.csp;

function directive(name: string): string[] {
  const entry = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  if (!entry) throw new Error(`CSP directive ${name} missing`);
  return entry.slice(name.length + 1).split(/\s+/);
}

describe('kernel-mode Content-Security-Policy (tauri.conf.json)', () => {
  it('keeps scripts strictly same-origin with no dynamic code sources', () => {
    const sources = directive('script-src');
    expect(sources).toEqual(["'self'"]);
    // Explicit negatives for the exact forbidden sources, so a relaxation
    // fails loudly with a readable message even if it is not a full equality.
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain('data:');
    expect(sources).not.toContain('blob:');
    for (const source of sources) {
      expect(source).not.toMatch(/^https?:/);
    }
  });

  it('forbids objects and frame embedding outside the shell', () => {
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('frame-ancestors')).toEqual(["'self'"]);
  });
});
