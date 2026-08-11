/**
 * `neotavern-plugin build` — zero-build packaging for plain-JS plugins (§8.2),
 * TypeScript transpilation mode (§8.3) and dependency vendoring validation
 * (§8.4). The canonical package stays SOURCE (manifest + modules + vendored
 * pure-JS deps); Endo/SES compiled records are never the plugin ABI (§8.1).
 *
 * `buildPackage`:
 * 1. runs the static analyzer (hard gates: platform payloads, install
 *    scripts, invalid manifest);
 * 2. transpiles `.ts/.tsx` sources to ESM (TypeScript `transpileModule`,
 *    no platform toolchain), plain JS is copied as-is;
 * 3. computes per-file SHA-256 digests and the package source digest (§36);
 * 4. writes the artifact to `dist/backend/artifact.json`
 *    (`{ manifest (signed), fileDigests, sourceDigest, moduleGraphDigest }`)
 *    when a private key is supplied, otherwise the unsigned variant.
 *
 * The runtime never executes `npm install`: `dependencies` in package.json
 * must be vendored under `vendor/`; build reports any gap as a warning.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { transpileModule, ModuleKind, ScriptTarget, JsxEmit } from 'typescript';
import { analyzePackage, type AnalyzerReport } from './analyze.js';
import { signManifest, type SignedManifest } from './signing.js';
import type { PluginManifest } from '@neotavern/plugin-sdk';

export interface BuildArtifact {
  manifest: SignedManifest | PluginManifest;
  /** sha256 per package file (relative posix path → hex). */
  fileDigests: Record<string, string>;
  /** sha256 over the sorted file-digest entries (package source digest). */
  sourceDigest: string;
  /** Set by the marketplace/runtime pipeline; null here (source-first, §8.1). */
  moduleGraphDigest: string | null;
  warnings: string[];
}

export interface BuildOptions {
  /** Ed25519 private key PEM; signs the artifact manifest when given. */
  privateKeyPem?: string;
  /** Output directory for the artifact (default `dist/backend`). */
  outDir?: string;
  /** Skip the hard-gate analyzer failure (explicit opt-in for debugging). */
  force?: boolean;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function posixRel(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

async function collectTree(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

/**
 * Transpile a TypeScript source to ESM JavaScript via the pinned
 * `typescript` catalog version — the same compiler the repo builds with, so
 * no platform-specific toolchain enters the plugin build (§8.3).
 */
export function transpileTypeScript(source: string, fileName: string): string {
  const output = transpileModule(source, {
    fileName,
    reportDiagnostics: false,
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
      jsx: JsxEmit.ReactJSX,
      sourceMap: false,
    },
  });
  return output.outputText;
}

/** Copy/transpile the tree; returns per-source-file digests. */
async function emitTree(
  root: string,
  files: string[],
  outRoot: string,
  warnings: string[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const file of files) {
    const rel = posixRel(root, file);
    const lower = rel.toLowerCase();
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
      if (lower.endsWith('.d.ts')) continue;
      const source = await readFile(file, 'utf8');
      const js = transpileTypeScript(source, rel);
      const outFile = join(outRoot, rel.replace(/\.tsx?$/, '.js'));
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, js, 'utf8');
      digests[rel] = sha256Hex(Buffer.from(source, 'utf8'));
      warnings.push(
        `${rel}: TypeScript transpiled to ${relative(root, outFile).split(sep).join('/')}`,
      );
    } else if (/\.(js|mjs|cjs|json|css|html|svg|png|jpe?g|gif|webp|ico|txt|md|wasm)$/.test(lower)) {
      const data = await readFile(file);
      digests[rel] = sha256Hex(data);
      const outFile = join(outRoot, rel);
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, data);
    }
  }
  return digests;
}

/** Build a plugin package directory into a signed/unsigned artifact. */
export async function buildPackage(
  root: string,
  options: BuildOptions = {},
): Promise<BuildArtifact> {
  const report: AnalyzerReport = await analyzePackage(root);
  const hardFailures = report.issues.filter(
    (issue) =>
      issue.level === 'error' &&
      (issue.code === 'UNSUPPORTED_PLATFORM_PAYLOAD' ||
        issue.code === 'UNSUPPORTED_INSTALL_SCRIPT' ||
        issue.code === 'PACKAGE_INVALID'),
  );
  if (hardFailures.length > 0 && options.force !== true) {
    const codes = hardFailures.map((issue) => `${issue.file}: ${issue.code}`).join('; ');
    throw new Error(`build blocked by analyzer hard gates: ${codes}`);
  }
  if (report.manifest === null) {
    throw new Error('build requires a valid manifest.json (§37 apiVersion 3)');
  }

  const warnings = [
    ...report.issues
      .filter((issue) => (options.force === true ? true : issue.level === 'warning'))
      .map((issue) => `${issue.file}: ${issue.code}: ${issue.message}`),
  ];

  // §8.4: declared npm dependencies must already be vendored in-tree.
  let pkgJson: Record<string, unknown> = {};
  try {
    pkgJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // package.json is optional for plain-JS plugins (§8.2).
  }
  const declared = pkgJson['dependencies'];
  if (declared !== undefined && typeof declared === 'object') {
    const names = Object.keys(declared as Record<string, unknown>);
    let vendorEntries: Dirent[] = [];
    try {
      vendorEntries = await readdir(join(root, 'vendor'), { withFileTypes: true });
    } catch {
      // no vendor dir
    }
    const vendored = new Set(vendorEntries.map((entry) => entry.name));
    for (const name of names) {
      if (!vendored.has(name)) {
        warnings.push(
          `dependency "${name}" is not vendored under vendor/ (§7.2) — the runtime will not resolve node_modules`,
        );
      }
    }
  }

  const files = await collectTree(root);
  const outDir = options.outDir ?? join(root, 'dist/backend');
  const digests = await emitTree(root, files, outDir, warnings);
  const sortedEntries = Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : 1));
  const sourceDigest = sha256Hex(
    Buffer.from(sortedEntries.map(([path, digest]) => `${path}:${digest}`).join('\n'), 'utf8'),
  );

  // §36: file-tree digests ride the manifest so the signature covers them.
  const withDigest = {
    ...report.manifest,
    fileDigests: sortedEntries.map(([path, sha256]) => ({ path, sha256 })),
  } as PluginManifest & { fileDigests: Array<{ path: string; sha256: string }> };

  const manifest: SignedManifest | PluginManifest =
    options.privateKeyPem !== undefined
      ? signManifest(withDigest, options.privateKeyPem)
      : withDigest;

  const artifact: BuildArtifact = {
    manifest,
    fileDigests: digests,
    sourceDigest,
    moduleGraphDigest: null,
    warnings,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}
