/**
 * Disposable tracking. Every registration in the Plugin SDK returns a cleanup
 * function; plugins (and the host) collect them here so that deactivation
 * leaves no handlers, timers, DOM nodes, routes or subscriptions behind
 * (AGENTS.md §17).
 */
export class Disposables {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  /** Track a cleanup function; returns it for convenience. */
  add(cleanup: () => void): () => void {
    if (this.disposed) {
      // Already torn down — run immediately so nothing leaks.
      safeRun(cleanup);
      return cleanup;
    }
    this.cleanups.push(cleanup);
    return cleanup;
  }

  /** Run all cleanups in reverse-registration order. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = this.cleanups.reverse();
    this.cleanups = [];
    for (const cleanup of cleanups) safeRun(cleanup);
  }

  get size(): number {
    return this.cleanups.length;
  }
}

function safeRun(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // A failing cleanup must not prevent the rest from running.
  }
}
