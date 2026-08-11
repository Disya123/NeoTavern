/**
 * Plugin SDK revision-4 kernel: common operation contracts (rev4 §A2).
 *
 * - Every long-running operation accepts cancellation (`AbortSignal`).
 * - Every mutating operation accepts an idempotency key.
 * - Every registration returns a Disposable; every resource a ResourceHandle.
 * - Resource handles close automatically on disable/uninstall (the host calls
 *   `dispose()`; pending operations observe `closed`).
 */

export interface OperationOptions {
  /** Cancellation; aborting rejects with OPERATION_ABORTED. */
  signal?: AbortSignal;
  /** Wall-clock deadline in milliseconds, enforced by the host. */
  deadlineMs?: number;
  /** Replay-safe key for mutating operations (server dedupes). */
  idempotencyKey?: string;
}

export interface Disposable {
  dispose(): void;
}

export interface ResourceHandle extends Disposable {
  /** Resolves when the resource is closed (by either side or teardown). */
  readonly closed: Promise<void>;
}

/**
 * Registry that disposes everything it tracks in reverse order. The host uses
 * one per plugin instance so disable/uninstall cannot leak handlers, streams,
 * workers or subscriptions (AGENTS.md §17, rev4 invariant 6).
 */
export class Scope {
  private readonly items = new Set<Disposable>();
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Track a disposable; disposes immediately when the scope is gone. */
  track<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  /** Remove without disposing (for handles that close themselves). */
  untrack(item: Disposable): void {
    this.items.delete(item);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = [...this.items].reverse();
    this.items.clear();
    for (const item of items) {
      try {
        item.dispose();
      } catch {
        // One failing cleanup must not stop the rest (SDK cleanup contract).
      }
    }
  }
}

/** Create a Deferred-style closed promise for resource handles. */
export function closedPromise(): { promise: Promise<void>; close: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, close: resolve };
}
