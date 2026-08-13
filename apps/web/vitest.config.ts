import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

/** Frontend component tests run under jsdom, reusing the Vite aliases/plugin. */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
      // Heavy component tests (list + viewer + editor flows) exceed the 5 s
      // default under full-suite parallel load on slower/Windows runners;
      // 10 s keeps failure detection tight without load-lottery flakes.
      testTimeout: 10_000,
    },
  }),
);
