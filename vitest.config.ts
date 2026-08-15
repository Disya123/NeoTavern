import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
const dbRequire = createRequire(resolve(root, 'packages/db/package.json'));
const workspaceSqlite = dbRequire.resolve('better-sqlite3');
const sqliteProbe = spawnSync(
  process.execPath,
  [
    '-e',
    "const Database=require(process.argv[1]);const db=new Database(':memory:');db.close()",
    workspaceSqlite,
  ],
  { stdio: 'ignore' },
);

if (sqliteProbe.status !== 0) {
  const bundledSqlite = resolve(
    root,
    'apps/desktop/src-tauri/resources/native/node_modules/better-sqlite3/lib/index.js',
  );
  if (existsSync(bundledSqlite)) process.env['NEOTA_SQLITE_MODULE'] = bundledSqlite;
}

export default defineConfig({
  resolve: {
    alias: {
      // Frontend packages are consumed from source; the alias keeps root
      // vitest (packages/ui, packages/gestures tests) independent of a prior
      // `tsc -b` build (apps/web derives its own aliases from tsconfig paths).
      '@neotavern/gestures': resolve(root, 'packages/gestures/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // SES/worker and integration suites exceed the 5 s default under full
    // parallel load on slower runners; 10 s widens the margin without
    // masking genuine hangs.
    testTimeout: 10_000,
    // Memory containment (plan rev 2.2 Layer B): two workers max and a
    // bounded Node heap so parallel suites cannot exhaust host memory.
    maxWorkers: 2,
    execArgv: ['--max-old-space-size=2048'],
    include: [
      'packages/**/*.test.{ts,tsx}',
      'apps/**/*.test.ts',
      'packages/**/*.spec.{ts,tsx}',
      'apps/**/*.spec.ts',
      // Node script gates (docs-sync closed-tree mirror, check-ui-api, ...).
      'scripts/**/*.test.mjs',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.vite/**',
      // Frontend component tests run under jsdom (see apps/web/vitest.config.ts).
      'apps/web/**',
      // packages/ui tests run under this config; they opt into jsdom per file
      // via the `// @vitest-environment jsdom` pragma.
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    },
  },
});
