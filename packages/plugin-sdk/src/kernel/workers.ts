/**
 * Plugin SDK revision-4 kernel: isolated compute workers (rev4 §C2).
 *
 * A worker is spawned INSIDE the plugin's own opaque-origin sandbox iframe
 * from a host-verified bundle. It inherits the sandbox's
 * opaque origin (no app storage, no cookies) and the sandbox CSP
 * (`connect-src 'none'` — no direct network; `worker-src blob:` plus
 * `script-src … blob:` — the verified bundle transports). The worker
 * therefore has compute authority only: data crosses separately, via the
 * sandbox's kernel capabilities (rev4 §B3 trust matrix row "Compute worker").
 *
 * The host never executes plugin code in the app origin: the bundle bytes
 * are fetched same-origin by the HOST, integrity-checked, and handed to the
 * sandbox over a kernel stream; the sandbox merely constructs the Worker
 * from them.
 */

/** Options for {@link KernelWorkersApi.spawn}. */
export interface KernelWorkerSpawnOptions {
  /**
   * Package-relative path of the worker entry script; must be declared in
   * the manifest `workers` allowlist. The extension selects the worker
   * kind: `.js` → classic, `.mjs` → `{ type: 'module' }` (ADR-0018).
   * Bundles must be self-contained (no `import`/`importScripts` — a blob
   * URL resolves no relative imports).
  entry: string;
  /** Advisory label for diagnostics; not a security boundary. */
  name?: string;
  /** AbortSignal: aborting terminates the worker. */
  signal?: AbortSignal;
}

/** A live compute worker owned by the sandbox (rev4 §C2). */
export interface KernelWorkerHandle {
  /** Post a structured-cloneable message (transferables stay sandbox-local). */
  postMessage(message: unknown): void;
  /** Subscribe to worker messages; returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Subscribe to worker errors; returns an unsubscribe function. */
  onError(listener: (message: string) => void): () => void;
  /** Resolves when the worker terminated (explicitly or by teardown). */
  readonly closed: Promise<void>;
  /** Terminate the worker (idempotent). */
  terminate(): void;
}

/**
 * Isolated compute workers (rev4 §C2, capability `compute.worker`).
 * Bounds come from `api.limits().workers`: at most `maxInstances` live
 * workers, entry bundles up to the host-verified size cap, messages up to
 * `maxMessageBytes`.
 */
export interface KernelWorkersApi {
  /**
   * Spawn a worker from a manifest-declared entry script. The host verifies
   * the entry against the manifest allowlist, fetches and integrity-checks
   * the bundle, and delivers it to the sandbox over a kernel stream; the
   * sandbox constructs a classic Worker from it inside its own opaque
   * origin.
   */
  spawn(options: KernelWorkerSpawnOptions): Promise<KernelWorkerHandle>;
}

/** Feature name/version advertised by hosts implementing this slice. */
export const WORKERS_FEATURE = 'compute.worker' as const;
export const WORKERS_FEATURE_VERSION = 1;
