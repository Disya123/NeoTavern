#!/usr/bin/env node
// Dependency-direction / forbidden-import gate (ТЗ §79 merge-blocking, §6
// dependency rule, §87 "явно запрещено").
//
// Enforces:
//  1. Runtime Kernel does not depend on host/adapter/transport crates —
//     Kernel is host-neutral (§6: "Runtime Kernel не импортирует Android,
//     iOS, Desktop, Fastify, HTTP, React, Node Plugin Runtime").
//  2. Runtime Kernel contains no platform branching
//     (`is_server`/`is_android`/`serverMode`, §87).
//  3. Adapters may depend on the Kernel, never the other way around.
//  4. Public TS packages never import from `crates/` (Rust internals) or
//     from other apps — Public SDK не импортирует Rust internal crates (§6).
//
// Exit code 0 = clean, 1 = violation (CI fails).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const violations = [];
const report = (file, rule, detail) =>
  violations.push(`${relative(root, file)}: ${rule} — ${detail}`);

// --- 1. Kernel dependency denylist ---------------------------------------
// Transport/UI/server crates that must never appear in the Kernel workspace
// crate. Any crate that starts with these names is rejected.
const KERNEL_DEP_DENYLIST = [
  'tiny_http',
  'tokio',
  'axum',
  'actix',
  'warp',
  'hyper',
  'rocket',
  'tauri',
  'wry',
  'fastify',
  'express',
  'node',
  'android',
  'ndk',
  'jni',
  'react',
  'yew',
  'dioxus',
];

const kernelCargo = readFileSync(join(root, 'crates', 'runtime-kernel', 'Cargo.toml'), 'utf8');
const inDeps = (section) => {
  const start = kernelCargo.indexOf(`[${section}]`);
  if (start === -1) return [];
  const end = kernelCargo.indexOf('\n[', start + 1);
  const block = kernelCargo.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]);
};
const kernelDeps = [...inDeps('dependencies'), ...inDeps('dev-dependencies')];
for (const dep of kernelDeps) {
  if (KERNEL_DEP_DENYLIST.some((bad) => dep === bad || dep.startsWith(`${bad}-`))) {
    report('crates/runtime-kernel/Cargo.toml', 'kernel-forbidden-dependency', dep);
  }
}

// --- 2. Kernel platform branching (§87) -----------------------------------
const kernelSrc = join(root, 'crates', 'runtime-kernel', 'src');
const BRANCH_PATTERN = /is_server|is_android|server_mode|isServer|isAndroid|serverMode/;
const scanDir = (dir, ext) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) scanDir(path, ext);
    else if (path.endsWith(ext)) {
      const content = readFileSync(path, 'utf8');
      const line = content.split('\n').findIndex((l) => BRANCH_PATTERN.test(l));
      if (line !== -1) {
        report(path, 'kernel-platform-branching', `line ${line + 1}`);
      }
    }
  }
};
scanDir(kernelSrc, '.rs');

// --- 3. Adapter → Kernel direction (never Kernel → adapter) ---------------
const adaptersDir = join(root, 'crates', 'adapters');
const adapterCrates = readdirSync(adaptersDir).filter((n) =>
  statSync(join(adaptersDir, n)).isDirectory(),
);
for (const dep of kernelDeps) {
  if (adapterCrates.includes(dep)) {
    report('crates/runtime-kernel/Cargo.toml', 'kernel-depends-on-adapter', dep);
  }
}

// --- 4. TS packages must not import Rust internals or other apps ----------
const packagesDir = join(root, 'packages');
const FORBIDDEN_IMPORT = /crates\/|\.\.\/\.\.\/\.\.\/crates|apps\//;
const scanTs = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
      scanTs(path);
    } else if (/(\.ts|\.tsx)$/.test(path)) {
      const content = readFileSync(path, 'utf8');
      for (const [i, line] of content.split('\n').entries()) {
        if (/^\s*(import|export)\s.*from\s/.test(line) && FORBIDDEN_IMPORT.test(line)) {
          report(path, 'ts-imports-rust-or-app', `line ${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
};
scanTs(packagesDir);

if (violations.length > 0) {
  console.error(`[dependency-rules] FAIL — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  '[dependency-rules] OK — Kernel host-neutral, no platform branching, no Rust/app imports from packages.',
);
