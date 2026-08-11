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
    },
  }),
);
