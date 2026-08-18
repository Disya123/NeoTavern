#!/usr/bin/env node
/**
 * Independent baseline before a BOUND debug APK for the B-exit physical
 * batch. Refuses to rebuild production `libneotavern_android_jni.so`.
 * Workspace tests may use only the already-registered kernel/schema hash.
 *
 *   node scripts/b-exit-independent-baseline.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROD_JNI = join(
  ROOT,
  'apps',
  'android',
  'app',
  'src',
  'main',
  'jniLibs',
  'arm64-v8a',
  'libneotavern_android_jni.so',
);

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function main() {
  const failures = [];
  const dirtyJni = git(['status', '--porcelain', '--', 'apps/android/app/src/main/jniLibs']);
  if ((dirtyJni.stdout || '').trim()) {
    failures.push('production jniLibs are dirty; do not rebuild libneotavern_android_jni.so');
  }
  // Prebuilt kernel .so is gitignored by contract. Presence is expected;
  // workspace tests use the already-registered schema hash. Never run
  // apps/android/scripts/build-libs.sh in this batch.
  const probe = spawnSync(
    'cargo',
    ['test', '-p', 'neotavern-presentation-perf-probe', '--features', 'gpu'],
    { cwd: join(ROOT, 'crates'), encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    failures.push(`probe tests exited ${probe.status}`);
  }
  const result = {
    ok: failures.length === 0,
    production_jni_untouched: !(dirtyJni.stdout || '').trim(),
    production_jni_present: existsSync(PROD_JNI),
    probe_tests: probe.status === 0,
    failures,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
