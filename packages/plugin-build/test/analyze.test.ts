/**
 * `neotavern-plugin analyze` tests (ТЗ §51/§52): builtin-import detection with
 * node-compat suggestions, platform payload hard gates, install scripts,
 * dynamic imports, WASM counting, capability suggestions.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzePackage } from '../src/analyze.js';

function makePackage(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'neotavern-build-analyze-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('analyzePackage (§51/§52)', () => {
  it('flags Node builtin imports with node-compat suggestions', async () => {
    const root = makePackage({
      'manifest.json': JSON.stringify({
        id: 'author.demo',
        name: 'Demo',
        version: '1.0.0',
        apiVersion: 3,
      }),
      'index.js':
        "import { readFile } from 'node:fs';\nimport http from 'http';\nexport const x = 1;",
    });
    const report = await analyzePackage(root);
    const builtins = report.issues.filter((issue) => issue.code === 'UNSUPPORTED_NODE_BUILTIN');
    expect(builtins.map((issue) => issue.file)).toEqual(['index.js', 'index.js']);
    expect(builtins[0]?.suggestion).toContain('api.files');
    expect(builtins[1]?.suggestion).toContain('api.network');
    // Hard gates absent → compatible.
    expect(report.compatible).toBe(true);
    // Capability suggestions from the usage.
    expect(report.capabilities.map((c) => c.capability)).toEqual(
      expect.arrayContaining(['files.plugin', 'network.http']),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('hard-gates platform payloads and install scripts (§7/§7.1)', async () => {
    const root = makePackage({
      'manifest.json': JSON.stringify({
        id: 'author.demo',
        name: 'Demo',
        version: '1.0.0',
        apiVersion: 3,
      }),
      'index.js': 'export const x = 1;',
      'native/helper.node': Buffer.from([0, 1, 2, 3]),
      'package.json': JSON.stringify({ scripts: { postinstall: 'curl evil' } }),
    });
    const report = await analyzePackage(root);
    expect(report.compatible).toBe(false);
    const codes = report.issues.filter((issue) => issue.level === 'error').map((i) => i.code);
    expect(codes).toContain('UNSUPPORTED_PLATFORM_PAYLOAD');
    expect(codes).toContain('UNSUPPORTED_INSTALL_SCRIPT');
    rmSync(root, { recursive: true, force: true });
  });

  it('flags dynamic imports and counts wasm payloads', async () => {
    const root = makePackage({
      'manifest.json': JSON.stringify({
        id: 'author.demo',
        name: 'Demo',
        version: '1.0.0',
        apiVersion: 3,
      }),
      'index.js': "export async function load(name) { return import('./chunks/' + name + '.js'); }",
      'wasm/engine.wasm': Buffer.from([0, 97, 115, 109]), // \0asm
    });
    const report = await analyzePackage(root);
    expect(report.issues.some((issue) => issue.code === 'UNSUPPORTED_DYNAMIC_IMPORT')).toBe(true);
    expect(report.stats.wasmFiles).toBe(1);
    expect(report.compatible).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports invalid or missing manifests as PACKAGE_INVALID', async () => {
    const root = makePackage({ 'index.js': 'export const x = 1;' });
    const report = await analyzePackage(root);
    expect(report.issues.some((issue) => issue.code === 'PACKAGE_INVALID')).toBe(true);
    expect(report.compatible).toBe(false);
    expect(report.manifest).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a clean plain-JS package and parses the manifest', async () => {
    const root = makePackage({
      'manifest.json': JSON.stringify({
        id: 'author.clean',
        name: 'Clean',
        version: '1.0.0',
        apiVersion: 3,
        backend: 'index.js',
        requiredCapabilities: [{ name: 'storage.kv', ops: ['get', 'set'] }],
      }),
      'index.js': 'export const x = 1;',
    });
    const report = await analyzePackage(root);
    expect(report.compatible).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.manifest?.id).toBe('author.clean');
    expect(report.manifest?.requiredCapabilities?.[0]?.name).toBe('storage.kv');
    rmSync(root, { recursive: true, force: true });
  });
});
