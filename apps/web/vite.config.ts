import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite is used strictly as a bundler and dev-server for the React SPA.
 * It is NOT the application's Plugin API (see @neotavern/plugin-sdk for that).
 *
 * Workspace packages are consumed from source via aliases so the web app does
 * not require a prior `tsc -b` of the frontend packages during development.
 * The alias list is derived from tsconfig.json `paths` (DUP-25): TypeScript
 * and the bundler can no longer disagree about where a package resolves.
 */
function aliasesFromTsconfig(): Array<{ find: string; replacement: string }> {
  const tsconfig = JSON.parse(
    readFileSync(fileURLToPath(new URL('./tsconfig.json', import.meta.url)), 'utf8'),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  const paths = tsconfig.compilerOptions?.paths ?? {};
  return (
    Object.entries(paths)
      .map(([find, targets]) => ({
        find,
        replacement: fileURLToPath(new URL(targets[0] ?? '', import.meta.url)),
      }))
      // More specific subpaths first so they aren't shadowed by base aliases.
      .sort((a, b) => b.find.length - a.find.length)
  );
}

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the bundled UI loads from
  // `file:///android_asset/web/index.html` (M6 Android host). The Vite
  // dev server and Playwright http origins still resolve `./` correctly.
  base: './',
  resolve: {
    alias: aliasesFromTsconfig(),
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Backend API and SSE generation are served by the Fastify server.
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
        configure: (proxy) => {
          // In local development the browser talks to Vite, not directly to
          // Fastify. Do not forward the browser Origin to the local API: a
          // fallback Vite port must not turn an internal proxy hop into a CORS
          // failure. Remote mode keeps the Origin header for its exact checks.
          if (process.env['NEOTA_REMOTE_ACCESS'] === 'true') return;
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Long-lived caching for hashed assets; HTML shell stays no-cache.
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
