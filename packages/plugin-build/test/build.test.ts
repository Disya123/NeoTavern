/**
 * `neotavern-plugin build` tests (§8.2/§8.3/§8.4/§36): zero-build JS pass-through,
 * TS transpilation, hard-gate blocking, vendoring warnings, signed artifact.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPackage, transpileTypeScript } from '../src/build.js';
import { runBuildGate } from '../src/sesGate.js';
import { generateKeyPair, verifyManifestSignature } from '../src/signing.js';

function makePackage(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'neotavern-build-build-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const CLEAN_MANIFEST = JSON.stringify({
  id: 'author.demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: 3,
  backend: 'index.js',
});

describe('buildPackage (§8/§36)', () => {
  it('zero-builds a plain-JS package and writes the artifact', async () => {
    const root = makePackage({
      'manifest.json': CLEAN_MANIFEST,
      'index.js': 'export const x = 1;',
    });
    const artifact = await buildPackage(root);
    expect(artifact.fileDigests['index.js']).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.moduleGraphDigest).toBeNull();
    expect(artifact.manifest.id).toBe('author.demo');
    expect('signature' in artifact.manifest).toBe(false);
    const artifactPath = join(root, 'dist/backend/artifact.json');
    expect(existsSync(artifactPath)).toBe(true);
    const written = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(written.sourceDigest).toBe(artifact.sourceDigest);
    rmSync(root, { recursive: true, force: true });
  });

  it('transpiles TypeScript sources to ESM', async () => {
    const root = makePackage({
      'manifest.json': CLEAN_MANIFEST,
      'src/index.ts':
        'export const greeting: string = "hello";\nexport function add(a: number, b: number): number { return a + b; }',
    });
    const artifact = await buildPackage(root);
    expect(artifact.fileDigests['src/index.ts']).toBeDefined();
    expect(artifact.warnings.some((w) => w.includes('TypeScript transpiled'))).toBe(true);
    const emitted = readFileSync(join(root, 'dist/backend/src/index.js'), 'utf8');
    expect(emitted).toContain('export const greeting');
    expect(emitted).not.toContain(': string');
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks on hard gates unless --force', async () => {
    const root = makePackage({
      'manifest.json': CLEAN_MANIFEST,
      'index.js': 'export const x = 1;',
      'evil.node': '\u0000\u0000',
    });
    await expect(buildPackage(root)).rejects.toThrow('build blocked by analyzer hard gates');
    // force bypasses the gate but keeps the report in warnings.
    const artifact = await buildPackage(root, { force: true });
    expect(artifact.warnings.some((w) => w.includes('UNSUPPORTED_PLATFORM_PAYLOAD'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('warns about undeclared vendoring of npm dependencies (§7.2/§8.4)', async () => {
    const root = makePackage({
      'manifest.json': CLEAN_MANIFEST,
      'index.js': 'export const x = 1;',
      'package.json': JSON.stringify({ dependencies: { 'pure-js-dep': '^1.0.0' } }),
    });
    const artifact = await buildPackage(root);
    expect(artifact.warnings.some((w) => w.includes('pure-js-dep'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('signs the artifact when a private key is supplied', async () => {
    const root = makePackage({
      'manifest.json': CLEAN_MANIFEST,
      'index.js': 'export const x = 1;',
    });
    const pair = generateKeyPair();
    const artifact = await buildPackage(root, { privateKeyPem: pair.privateKeyPem });
    expect('signature' in artifact.manifest).toBe(true);
    const result = verifyManifestSignature(artifact.manifest, pair.publicKeyPem);
    expect(result).toEqual({ ok: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('transpiles TS via the pinned compiler with ESM output', () => {
    const out = transpileTypeScript('export function f<T>(x: T): T { return x; }', 'f.ts');
    expect(out).toContain('export function f');
    expect(out).not.toContain('<T>');
    expect(out).not.toContain('require(');
  });
});

describe('sesGate (§6.5/§8.10 build-time gate)', () => {
  it(
    'imports a clean plain-JS graph under the production boundary',
    { timeout: 60000 },
    async () => {
      const root = makePackage({
        'manifest.json': JSON.stringify({
          id: 'author.gate',
          name: 'Gate',
          version: '1.0.0',
          apiVersion: 3,
          backend: 'index.js',
        }),
        'index.js': 'export const greeting = "hello";',
      });
      const { outcome, report } = await runBuildGate(root);
      expect(outcome.ok).toBe(true);
      expect(outcome.kind).toBe('loaded');
      expect(outcome.exportNames).toContain('greeting');
      expect(report.compatible).toBe(true);
      rmSync(root, { recursive: true, force: true });
    },
  );

  it(
    'fails a graph that mutates frozen intrinsics with the documented code',
    { timeout: 60000 },
    async () => {
      const root = makePackage({
        'manifest.json': JSON.stringify({
          id: 'author.bad',
          name: 'Bad',
          version: '1.0.0',
          apiVersion: 3,
          backend: 'index.js',
        }),
        'index.js': 'Object.prototype.polluted = true;\nexport const x = 1;',
      });
      const { outcome } = await runBuildGate(root);
      expect(outcome.ok).toBe(false);
      expect(outcome.kind).toBe('error');
      expect(outcome.code).toBeTruthy();
      rmSync(root, { recursive: true, force: true });
    },
  );
});
