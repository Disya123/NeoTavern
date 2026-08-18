#!/usr/bin/env node
/**
 * run-e2e-parallel — runs the Playwright suite in parallel shards.
 *
 * Local (no args): auto-shards across available CPU cores, one shard per spec
 * file at most. Each shard is a separate OS process with its own server,
 * SQLite data dir, port pair and report/output dirs (playwright.config.ts
 * derives them from E2E_PORT_OFFSET / E2E_REPORT_DIR / E2E_OUTPUT_DIR), so
 * concurrent shards never share mutable state.
 *
 * CI (--shard=i/N): runs exactly that shard as one process — the GitHub
 * Actions matrix in ci.yml spawns one runner per shard.
 *
 * `--config=` / `-c` selects the Playwright config (Kernel default vs
 * `playwright.legacy.config.ts` for the Fastify quarantine).
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = resolve(root, 'node_modules/@playwright/test/cli.js');
const argv = process.argv.slice(2);

function shardArg(args) {
  const flag = args.find((a) => a.startsWith('--shard='));
  return flag ? flag.slice('--shard='.length) : null;
}

function configRel(args) {
  const flag = args.find((a) => a.startsWith('--config='));
  if (flag) return flag.slice('--config='.length);
  const long = args.indexOf('--config');
  if (long >= 0 && args[long + 1]) return args[long + 1];
  const short = args.indexOf('-c');
  if (short >= 0 && args[short + 1]) return args[short + 1];
  return process.env['E2E_PLAYWRIGHT_CONFIG'] ?? 'playwright.config.ts';
}

function runPlaywright(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`playwright exited with code ${code}${signal ? ` (${signal})` : ''}`));
      }
    });
  });
}

function walkSpecs(dir, skipNames) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipNames.has(entry.name)) continue;
      n += walkSpecs(join(dir, entry.name), skipNames);
    } else if (entry.name.endsWith('.spec.ts')) {
      n += 1;
    }
  }
  return n;
}

function specFileCount(configPath) {
  if (configPath.includes('legacy')) {
    return walkSpecs(resolve(root, 'e2e', 'legacy'), new Set());
  }
  return walkSpecs(resolve(root, 'e2e'), new Set(['legacy', 'spikes']));
}

const configPath = configRel(argv);
const configArgs = ['-c', resolve(root, configPath)];
const explicit = shardArg(argv);
if (explicit) {
  const [i, n] = explicit.split('/').map(Number);
  try {
    await runPlaywright([...configArgs, `--shard=${i}/${n}`], {
      E2E_PORT_OFFSET: String(i - 1),
      E2E_REPORT_DIR: resolve(root, 'playwright-report', `shard-${i}-of-${n}`),
      E2E_OUTPUT_DIR: resolve(root, 'test-results', `shard-${i}-of-${n}`),
    });
    console.log(`[e2e] shard ${i}/${n} passed (${configPath})`);
  } catch (error) {
    console.error(`[e2e] shard ${i}/${n} FAILED: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  const files = specFileCount(configPath);
  const cores = availableParallelism();
  const envShards = Number.parseInt(process.env['E2E_SHARDS'] ?? '', 10);
  const shards =
    envShards > 0
      ? Math.min(envShards, Math.max(files, 1))
      : Math.max(1, Math.min(files, Math.floor(cores / 2) || 1));
  console.log(
    `[e2e] running ${files} spec files in ${shards} parallel shards (${cores} cores, ${configPath})`,
  );
  const results = await Promise.allSettled(
    Array.from({ length: shards }, (_, k) => {
      const i = k + 1;
      return runPlaywright([...configArgs, `--shard=${i}/${shards}`], {
        E2E_PORT_OFFSET: String(k),
        E2E_REPORT_DIR: resolve(root, 'playwright-report', `shard-${i}-of-${shards}`),
        E2E_OUTPUT_DIR: resolve(root, 'test-results', `shard-${i}-of-${shards}`),
      });
    }),
  );
  const failed = results
    .map((r, k) => ({ result: r, shard: k + 1 }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, shard } of failed) {
    console.error(
      `[e2e] shard ${shard}/${shards} FAILED: ${result.reason?.message ?? result.reason}`,
    );
  }
  console.log(`[e2e] ${results.length - failed.length}/${results.length} shards passed`);
  if (failed.length > 0) process.exitCode = 1;
}
