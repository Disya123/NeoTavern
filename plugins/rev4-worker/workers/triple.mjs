/**
 * Rev4 worker example: ES-module compute worker (rev4 §C2, ADR-0018).
 *
 * `.mjs` entries are constructed as `new Worker(dataUrl, { type: 'module' })`
 * inside the plugin's opaque-origin sandbox realm (`worker-src blob: data:`,
 * `connect-src 'none'`): blob: module workers cannot resolve their entry
 * across opaque origins, so module bundles ride data: URLs (capped at
 * `limits.workers.maxModuleDataUrlBytes`; ADR-0018). The bundle is
 * self-contained (no imports) so the data: URL needs no import resolution;
 * module syntax is exercised by the top-level `const` binding below.
 */
const factor = 3;
self.onmessage = (event) => {
  const data = event.data ?? {};
  const value = Number(data.value ?? 0);
  self.postMessage({ tripled: value * factor });
};
