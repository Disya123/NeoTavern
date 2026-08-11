/**
 * Rev4 worker example: pure compute worker (rev4 §C2).
 *
 * Runs inside the plugin's opaque-origin sandbox realm under
 * `connect-src 'none'` — no imports, no network, no app data. The plugin
 * side posts plain structured-cloneable messages and receives the result.
 */
self.onmessage = (event) => {
  const data = event.data ?? {};
  const value = Number(data.value ?? 0);
  self.postMessage({ doubled: value * 2 });
};
