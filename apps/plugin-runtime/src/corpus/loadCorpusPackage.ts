/**
 * SES Compatibility Corpus loader (ТЗ v3.2 §6.6, B25) — the first concrete
 * dependency-vendoring step of the build pipeline (§7.2, §8.9).
 *
 * Vendors a corpus package AND its transitive bare-import dependencies into
 * one flat module map shaped like a `node_modules` tree:
 *
 *   node_modules/<package>/<relative-file>
 *
 * Bare specifiers in vendored sources are rewritten to relative imports into
 * that tree (`import '@endo/harden'` → the vendored entry file), so the
 * signed graph is built ONLY from these files — no runtime node_modules
 * resolution, per §7.2. Relative imports, `node:` imports and plain Node
 * builtins are left untouched (the graph builder gates the latter).
 *
 * The rewrite is intentionally narrow (import/export-from/dynamic-import
 * specifiers only) and bounded (archive-safety caps, §8.7): the corpus gate
 * must stay deterministic across Node/SES/endo upgrades.
 */
import { createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);

/** Max source files vendored per corpus package (incl. dependencies). */
export const CORPUS_MAX_FILES = 128;
/** Max source bytes per file. */
export const CORPUS_MAX_FILE_BYTES = 512 * 1024;
/** Max total source bytes across the whole vendored tree. */
export const CORPUS_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** Max transitive dependency depth (cycle guard). */
export const CORPUS_MAX_DEPTH = 4;

export interface CorpusPackageSource {
  /** Virtual `node_modules/...` path -> source text (posix separators). */
  files: Map<string, string>;
  /** Graph entry: `node_modules/<package>/<entry>`. */
  entry: string;
}

function posix(segment: string): string {
  return segment.replaceAll('\\', '/');
}

function entryOf(manifest: { module?: unknown; main?: unknown }): string {
  const candidate = manifest.module ?? manifest.main ?? 'index.js';
  if (typeof candidate !== 'string' || candidate.length === 0) return 'index.js';
  return candidate.startsWith('./') ? candidate.slice(2) : candidate;
}

/** `@endo/x/y` -> `@endo/x` (the package part). */
function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length > 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
]);

/** True for relative, `node:` and bare Node builtin specifiers. */
function isLocalOrBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('node:') ||
    NODE_BUILTINS.has(specifier)
  );
}

/** Visit every import/export-from/dynamic-import specifier in source text. */
function forEachImportSpecifier(source: string, visit: (specifier: string) => void): void {
  // `from 'x'` | `import('x')` | `import 'x'` — the quote group is reused.
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (specifier !== undefined) visit(specifier);
  }
}

interface VendorState {
  files: Map<string, string>;
  visited: Set<string>;
  totalBytes: number;
}

/** Resolve `node_modules/<packageName>/package.json` and vendor its tree. */
async function vendorPackage(
  packageName: string,
  state: VendorState,
  depth: number,
): Promise<void> {
  if (depth > CORPUS_MAX_DEPTH) {
    throw new Error(`corpus dependency depth exceeds ${CORPUS_MAX_DEPTH} (${packageName})`);
  }
  if (state.visited.has(packageName)) return;
  state.visited.add(packageName);

  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const root = packageJsonPath.slice(0, -'/package.json'.length);
  const prefix = `node_modules/${packageName}/`;

  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!/\.(?:js|mjs|cjs|json)$/.test(dirent.name)) continue;
      if (state.files.size >= CORPUS_MAX_FILES) {
        throw new Error(`corpus vendoring exceeds ${CORPUS_MAX_FILES} files`);
      }
      const info = await stat(full);
      if (info.size > CORPUS_MAX_FILE_BYTES) {
        throw new Error(
          `corpus package ${packageName}: file ${dirent.name} exceeds ${CORPUS_MAX_FILE_BYTES} bytes`,
        );
      }
      state.totalBytes += info.size;
      if (state.totalBytes > CORPUS_MAX_TOTAL_BYTES) {
        throw new Error(`corpus vendoring exceeds ${CORPUS_MAX_TOTAL_BYTES} bytes`);
      }
      state.files.set(prefix + posix(relative(root, full)), await readFile(full, 'utf8'));
    }
  };
  await walk(root);

  // Transitively vendor every bare dependency this package imports.
  const deps = new Set<string>();
  for (const source of state.files.values()) {
    forEachImportSpecifier(source, (specifier) => {
      if (!isLocalOrBuiltin(specifier)) deps.add(packageNameOf(specifier));
    });
  }
  for (const dep of deps) {
    if (dep !== packageName) await vendorPackage(dep, state, depth + 1);
  }
}

/** Resolve every bare specifier to a vendored file path. */
async function resolveBareTargets(state: VendorState): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  const bare = new Set<string>();
  for (const source of state.files.values()) {
    forEachImportSpecifier(source, (specifier) => {
      if (!isLocalOrBuiltin(specifier)) bare.add(specifier);
    });
  }
  for (const specifier of bare) {
    const exact = `node_modules/${specifier}`;
    if (state.files.has(exact)) {
      targets.set(specifier, exact);
      continue;
    }
    if (state.files.has(`${exact}.js`)) {
      targets.set(specifier, `${exact}.js`);
      continue;
    }
    const depPackage = packageNameOf(specifier);
    if (state.visited.has(depPackage)) {
      const manifest = JSON.parse(
        await readFile(require.resolve(`${depPackage}/package.json`), 'utf8'),
      ) as { module?: unknown; main?: unknown };
      targets.set(specifier, `node_modules/${depPackage}/${entryOf(manifest)}`);
    }
    // Unknown bare specifier: leave it — the graph builder rejects it with
    // UNSUPPORTED_DEPENDENCY and the exact path (documented fail case).
  }
  return targets;
}

/** Rewrite bare imports to relative paths into the vendored tree. */
function rewriteBareImports(
  source: string,
  filePath: string,
  targets: Map<string, string>,
): string {
  const fileDir = dirname(filePath);
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g;
  return source.replace(pattern, (whole, quote: string, specifier: string) => {
    if (isLocalOrBuiltin(specifier)) return whole;
    const target = targets.get(specifier);
    if (target === undefined) return whole;
    let rel = posix(relative(fileDir, target));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${whole.slice(0, whole.indexOf(quote))}${quote}${rel}${quote}`;
  });
}

/** Vendor the corpus package and all its bare dependencies. */
export async function loadCorpusPackage(packageName: string): Promise<CorpusPackageSource> {
  const state: VendorState = {
    files: new Map(),
    visited: new Set(),
    totalBytes: 0,
  };
  await vendorPackage(packageName, state, 0);
  const targets = await resolveBareTargets(state);

  const rewritten = new Map<string, string>();
  for (const [filePath, source] of state.files) {
    rewritten.set(filePath, rewriteBareImports(source, filePath, targets));
  }

  const manifest = JSON.parse(
    await readFile(require.resolve(`${packageName}/package.json`), 'utf8'),
  ) as { module?: unknown; main?: unknown };
  const entryPath = `node_modules/${packageName}/${entryOf(manifest)}`;
  if (!rewritten.has(entryPath)) {
    throw new Error(`corpus package ${packageName}: entry ${entryPath} was not vendored`);
  }
  return { files: rewritten, entry: entryPath };
}
