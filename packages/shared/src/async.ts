/**
 * Async helpers: timeouts, abort propagation and deferred promises.
 *
 * All long-running operations must accept an `AbortSignal` (AGENTS.md §6). These
 * helpers make it easy to combine a caller-provided signal with a timeout.
 */
import { AppError, ErrorCodes } from './error.js';

/**
 * Race a promise against a timeout. Rejects with a TIMEOUT {@link AppError} if
 * the timeout elapses first. The optional signal aborts early with an ABORTED
 * error. The underlying promise is not cancelled (callers should thread the
 * signal into the real work); this only bounds how long we wait.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError({ code: ErrorCodes.ABORTED, message: 'Aborted before start' }));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppError({ code: ErrorCodes.TIMEOUT, message: `Timed out after ${ms}ms` }));
    }, ms);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppError({ code: ErrorCodes.ABORTED, message: 'Aborted' }));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Create a new AbortSignal that aborts when ANY of the given signals aborts, or
 * after `ms` milliseconds. Returns the combined signal and a dispose function
 * that clears the timer.
 */
export function combinedSignal(
  ms: number,
  signals: ReadonlyArray<AbortSignal> = [],
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AppError({ code: ErrorCodes.TIMEOUT })), ms);

  const forwards: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const forward = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    forwards.push(() => signal.removeEventListener('abort', forward));
  }

  const dispose = (): void => {
    clearTimeout(timer);
    for (const off of forwards) off();
  };

  return { signal: controller.signal, dispose };
}

/** A promise with externally accessible resolve/reject handles. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Sleep for `ms` milliseconds, optionally abortable. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError({ code: ErrorCodes.ABORTED }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AppError({ code: ErrorCodes.ABORTED }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
