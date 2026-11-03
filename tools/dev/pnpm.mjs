#!/usr/bin/env node
/**
 * pnpm launcher that survives the Windows/MSYS shell.
 *
 * Problem this solves: on this box `pnpm` on PATH is the corepack shim, and
 * under bash/MSYS the shim is passed an MSYS path (`/c/Program Files/...`)
 * which Node resolves against the current drive (`E:\c\Program Files\...`),
 * so every `pnpm` call dies with MODULE_NOT_FOUND. The shim also refuses to
 * run in a non-tty context ("stdin is not a tty"), which makes it useless for
 * background jobs and subagents.
 *
 * This launcher resolves corepack's `pnpm.js` from the RUNNING node's own
 * directory (so it works for any Node install), passes it a native path, and
 * forwards stdout/stderr/stdin unchanged. No pnpm logic is reimplemented.
 *
 *   node tools/dev/pnpm.mjs install --frozen-lockfile
 *   node tools/dev/pnpm.mjs --filter @neotavern/web test
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const nodeDir = dirname(process.execPath);
const candidates = [
  // Windows: <node>/node_modules/corepack/dist/pnpm.js
  join(nodeDir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  // POSIX/corepack layouts
  join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  resolve(nodeDir, '..', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
];

const pnpmJs = candidates.find((candidate) => existsSync(candidate));
if (pnpmJs === undefined) {
  console.error(
    '[dev/pnpm] corepack pnpm.js not found next to the running node:\n' +
      candidates.map((candidate) => `  - ${candidate}`).join('\n') +
      '\nInstall corepack (`corepack enable`) or run pnpm directly.',
  );
  process.exit(127);
}

const result = spawnSync(process.execPath, [pnpmJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // A real path, not an MSYS one: Node must be able to open it.
  env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
});
if (result.error) {
  console.error(`[dev/pnpm] failed to launch pnpm: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
