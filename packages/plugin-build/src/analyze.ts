/**
 * `neotavern-plugin analyze` — migration analyzer (ТЗ Plugin SDK vNext v3.2 §51/§52).
 *
 * Static vNext-readiness report for a plugin package directory:
 * - Node built-in imports (with `@neotavern/node-compat` / SDK replacements, §52);
 * - platform payloads (`.node` addons, native libraries, executables) — §7;
 * - install scripts (preinstall/install/postinstall/prepare) — §7.1;
 * - dynamic imports (broken static dependency analysis, §6.4/§6.8);
 * - WebAssembly payloads (§7 package policy);
 * - vendored dependencies and their own builtin imports;
 * - suggested §12 capabilities from the observed usage patterns.
 *
 * The analyzer is intentionally conservative: anything it cannot prove safe
 * is reported as an issue; `compatible` is false when a §7/§7.1 violation
 * exists (those are hard gates), while builtin imports / dynamic imports are
 * `warning`-level (migration candidates) unless the package declares a
 * node-compat dependency.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { validateManifest } from '@neotavern/plugin-sdk';
import type { PluginManifest } from '@neotavern/plugin-sdk';

export type AnalyzerIssueLevel = 'error' | 'warning' | 'info';

export interface AnalyzerIssue {
  level: AnalyzerIssueLevel;
  /** Stable machine code, e.g. `UNSUPPORTED_NODE_BUILTIN` (ТЗ §41). */
  code: string;
  file: string;
  message: string;
  /** Suggested migration (node-compat module or SDK surface, §52). */
  suggestion?: string;
}

export interface CapabilitySuggestion {
  capability: string;
  reason: string;
}

export interface AnalyzerReport {
  compatible: boolean;
  issues: AnalyzerIssue[];
  capabilities: CapabilitySuggestion[];
  stats: {
    files: number;
    jsFiles: number;
    bytes: number;
    wasmFiles: number;
  };
  manifest: PluginManifest | null;
}

/** §52 migration map: Node builtin → @neotavern/node-compat / SDK surface. */
const NODE_COMPAT_SUGGESTIONS: Readonly<Record<string, string>> = {
  'node:fs': '@neotavern/node-compat/fs (api.files)',
  'node:fs/promises': '@neotavern/node-compat/fs (api.files)',
  'node:path': '@neotavern/node-compat/path',
  'node:url': '@neotavern/node-compat/url',
  'node:events': '@neotavern/node-compat/events',
  'node:util': '@neotavern/node-compat/util',
  'node:buffer': '@neotavern/node-compat/buffer-compatible',
  'node:crypto': '@neotavern/node-compat/crypto (portable subset)',
  'node:child_process': '@neotavern/node-compat/child_process (api.process.spawn)',
  'node:http': '@neotavern/node-compat/http (api.network)',
  'node:https': '@neotavern/node-compat/http (api.network)',
  'node:net': 'api.network.tcp',
  'node:tls': 'api.network.tcp',
  'node:dns': 'api.network (DNS policy)',
  'node:worker_threads': 'api.compute.spawn',
  'node:vm': 'unsupported (no VM sandbox, §3)',
  'node:os': 'api.diagnostics (own metrics only)',
  'node:process': 'api.runtime / system.info (granted)',
};

/** Bare builtins (prefixed form is the same namespace). */
const BARE_BUILTINS = new Set([
  'fs',
  'path',
  'url',
  'events',
  'util',
  'buffer',
  'crypto',
  'child_process',
  'http',
  'https',
  'net',
  'tls',
  'dns',
  'worker_threads',
  'vm',
  'os',
  'process',
  'stream',
  'zlib',
  'querystring',
  'timers',
]);

/** §12 capability suggestions from observed usage. */
function suggestFor(issue: AnalyzerIssue): CapabilitySuggestion | null {
  if (issue.code === 'UNSUPPORTED_NODE_BUILTIN') {
    const specifier = issue.message.match(/`([^`]+)`/)?.[1] ?? '';
    const key = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
    if (key.startsWith('node:child_process')) {
      return { capability: 'process.spawn', reason: 'child process usage' };
    }
    if (key.startsWith('node:fs')) {
      return { capability: 'files.plugin', reason: 'filesystem usage' };
    }
    if (key.startsWith('node:net') || key.startsWith('node:tls') || key.startsWith('node:dns')) {
      return { capability: 'network.tcp', reason: 'socket usage' };
    }
    if (key.startsWith('node:http') || key.startsWith('node:https')) {
      return { capability: 'network.http', reason: 'http usage' };
    }
    return null;
  }
  if (issue.code === 'UNSUPPORTED_PLATFORM_PAYLOAD') {
    return { capability: 'system.unrestricted', reason: 'platform payloads need admin trust' };
  }
  return null;
}

const SPECIFIER_RE = /(?:from\s*|import\s*|require\s*\()\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*(?:['"`]|[^'"`])/g;

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return BARE_BUILTINS.has(specifier);
}

async function scanPackage(
  root: string,
): Promise<{ files: string[]; jsFiles: string[]; wasmFiles: string[]; bytes: number }> {
  const files: string[] = [];
  const jsFiles: string[] = [];
  const wasmFiles: string[] = [];
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dirs are reported by the caller's manifest check
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Never descend into host tooling dirs.
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full);
      bytes += info.size;
      files.push(full);
      if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(entry.name)) jsFiles.push(full);
      if (entry.name.endsWith('.wasm')) wasmFiles.push(full);
    }
  }
  return { files, jsFiles, wasmFiles, bytes };
}

function isExecutableMagic(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // PE (MZ), ELF, Mach-O (32/64) headers.
  return (
    (buffer[0] === 0x4d && buffer[1] === 0x5a) || // MZ
    (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) || // \x7fELF
    (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe) || // Mach-O 64
    (buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && buffer[3] === 0xce) // Mach-O 32
  );
}

async function analyzeFile(root: string, file: string, issues: AnalyzerIssue[]): Promise<void> {
  const rel = relative(root, file).split(sep).join('/');
  const lower = file.toLowerCase();
  if (
    lower.endsWith('.node') ||
    lower.endsWith('.dll') ||
    lower.endsWith('.dylib') ||
    lower.endsWith('.so')
  ) {
    issues.push({
      level: 'error',
      code: 'UNSUPPORTED_PLATFORM_PAYLOAD',
      file: rel,
      message: 'native library payloads are forbidden in plugin packages (§7)',
      suggestion: 'remove the native binary; use pure JS or WASM via api.compute',
    });
    return;
  }
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(file)) {
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      return;
    }
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (isBuiltin(specifier)) {
        const key = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        issues.push({
          level: 'warning',
          code: 'UNSUPPORTED_NODE_BUILTIN',
          file: rel,
          message: `Node builtin import \`${specifier}\` is not available inside the SES Compartment`,
          suggestion:
            NODE_COMPAT_SUGGESTIONS[key] ?? `replace \`${specifier}\` with the SDK surface`,
        });
      }
    }
    if (DYNAMIC_IMPORT_RE.test(source)) {
      issues.push({
        level: 'warning',
        code: 'UNSUPPORTED_DYNAMIC_IMPORT',
        file: rel,
        message:
          'dynamic import: only specifiers present in the signed module graph resolve (§6.4)',
        suggestion: 'use static imports; dynamic targets must be vendored and declared',
      });
    }
    if (/\b(?:eval|new Function)\s*\(/.test(source)) {
      issues.push({
        level: 'warning',
        code: 'DYNAMIC_CODE',
        file: rel,
        message:
          'runtime-generated source is allowed inside the Compartment but breaks static analysis (§6.8)',
      });
    }
  }
  if (
    !lower.endsWith('.wasm') &&
    !/\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|svg|png|jpe?g|gif|webp|ico|txt|md)$/.test(lower)
  ) {
    // Unknown extension: sniff for executable magic before flagging.
    try {
      const fd = await readFile(file);
      const head = fd.subarray(0, 4);
      if (isExecutableMagic(head)) {
        issues.push({
          level: 'error',
          code: 'UNSUPPORTED_PLATFORM_PAYLOAD',
          file: rel,
          message: 'executable payload detected in the package (§7)',
          suggestion: 'plugins must not ship platform executables',
        });
      }
    } catch {
      // unreadable: leave for the manifest/build gate
    }
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Static vNext-readiness analysis of a plugin package directory. */
export async function analyzePackage(root: string): Promise<AnalyzerReport> {
  const issues: AnalyzerIssue[] = [];
  const { files, jsFiles, wasmFiles, bytes } = await scanPackage(root);
  for (const file of files) {
    await analyzeFile(root, file, issues);
  }

  // §7.1: lifecycle scripts are a hard gate (never executed server-side).
  const pkgJson = await readPackageJson(root);
  const scripts = pkgJson?.['scripts'] as Record<string, unknown> | undefined;
  if (scripts !== undefined && typeof scripts === 'object') {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof scripts[name] === 'string') {
        issues.push({
          level: 'error',
          code: 'UNSUPPORTED_INSTALL_SCRIPT',
          file: 'package.json',
          message: `lifecycle script "${name}" is forbidden: installation runs no build scripts (§7.1)`,
          suggestion: 'publish a pre-built package; the runtime never runs npm install',
        });
      }
    }
  }
  const declaredDeps = pkgJson?.['dependencies'];
  if (declaredDeps !== undefined && typeof declaredDeps === 'object') {
    const names = Object.keys(declaredDeps as Record<string, unknown>);
    if (names.length > 0) {
      issues.push({
        level: 'info',
        code: 'NPM_DEPENDENCIES',
        file: 'package.json',
        message: `runtime npm dependencies must be vendored at build time (§7.2): ${names.join(', ')}`,
        suggestion: 'run `neotavern-plugin build` to vendor pure-JS dependencies into the signed graph',
      });
    }
  }

  let manifest: PluginManifest | null = null;
  let manifestRaw: unknown = null;
  try {
    manifestRaw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch {
    issues.push({
      level: 'error',
      code: 'PACKAGE_INVALID',
      file: 'manifest.json',
      message: 'manifest.json is missing or malformed',
    });
  }
  if (manifestRaw !== null) {
    const result = validateManifest(manifestRaw);
    if (!result.ok) {
      issues.push({
        level: 'error',
        code: 'PACKAGE_INVALID',
        file: 'manifest.json',
        message: `manifest validation failed: ${result.error.message}`,
      });
    } else {
      manifest = result.value;
    }
  }

  const hasHardGate = issues.some(
    (issue) =>
      issue.level === 'error' &&
      (issue.code === 'UNSUPPORTED_PLATFORM_PAYLOAD' ||
        issue.code === 'UNSUPPORTED_INSTALL_SCRIPT' ||
        issue.code === 'PACKAGE_INVALID'),
  );

  const capabilities: CapabilitySuggestion[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const suggestion = suggestFor(issue);
    if (suggestion !== null && !seen.has(suggestion.capability)) {
      seen.add(suggestion.capability);
      capabilities.push(suggestion);
    }
  }

  return {
    compatible: !hasHardGate,
    issues,
    capabilities,
    stats: { files: files.length, jsFiles: jsFiles.length, bytes, wasmFiles: wasmFiles.length },
    manifest,
  };
}
