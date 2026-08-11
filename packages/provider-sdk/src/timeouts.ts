/**
 * Provider timeouts (ТЗ §4.3 «таймауты подключения и чтения»).
 *
 * Adapters must not rely on the caller's AbortSignal alone: a hung connection
 * or a streaming response that stops sending chunks needs its own deadline.
 * {@link DeadlineController} combines the caller signal with re-armable
 * deadlines and aborts with a TIMEOUT {@link AppError}, which
 * {@link normalizeProviderError} passes through unchanged.
 */
import { AppError, ErrorCodes } from '@neotavern/shared';

export interface ProviderTimeouts {
  /** Deadline for the connection + response headers. */
  connectMs: number;
  /** Maximum silence between streaming chunks. */
  idleMs: number;
  /** Deadline for whole-response reads (model lists, non-streaming completions). */
  readMs: number;
}

export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  connectMs: 30_000,
  idleMs: 60_000,
  readMs: 30_000,
};

/** Merge partial overrides onto the defaults. */
export function resolveTimeouts(overrides?: Partial<ProviderTimeouts>): ProviderTimeouts {
  return { ...DEFAULT_PROVIDER_TIMEOUTS, ...overrides };
}

/**
 * An AbortSignal that fires on the caller's abort OR on a re-armable deadline.
 * Deadline aborts carry a TIMEOUT AppError as the abort reason, so fetch
 * rejections propagate a structured error instead of a bare AbortError.
 */
export class DeadlineController {
  /** Signal to hand to fetch / stream readers. */
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly caller: AbortSignal) {
    if (caller.aborted) {
      this.controller.abort(caller.reason);
    } else {
      caller.addEventListener('abort', this.onCallerAbort, { once: true });
    }
    this.signal = this.controller.signal;
  }

  /** (Re)start a deadline. Any previous deadline is cleared first. */
  arm(ms: number, message: string): void {
    this.disarm();
    if (this.controller.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.controller.abort(new AppError({ code: ErrorCodes.TIMEOUT, message }));
    }, ms);
  }

  /** Clear the current deadline without aborting. */
  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Clear the deadline and detach from the caller signal. */
  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.caller.removeEventListener('abort', this.onCallerAbort);
  }

  private onCallerAbort = (): void => {
    if (this.disposed) return;
    this.disarm();
    this.controller.abort(this.caller.reason);
  };
}
