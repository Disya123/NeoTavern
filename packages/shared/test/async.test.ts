import { afterEach, describe, expect, it, vi } from 'vitest';
import { combinedSignal, createDeferred, sleep, withTimeout } from '../src/async.js';
import { AppError, ErrorCodes, isAppError } from '../src/error.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with the promise value when it settles first', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });

  it('propagates the underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a TIMEOUT AppError when the deadline elapses', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 250);
    const assertion = expect(pending).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
      message: 'Timed out after 250ms',
    });
    await vi.advanceTimersByTimeAsync(251);
    await assertion;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTimeout(new Promise<string>(() => {}), 1000, controller.signal),
    ).rejects.toMatchObject({ code: ErrorCodes.ABORTED, message: 'Aborted before start' });
  });

  it('rejects with an ABORTED AppError when aborted while waiting', async () => {
    const controller = new AbortController();
    const pending = withTimeout(new Promise<string>(() => {}), 60_000, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.ABORTED });
    controller.abort();
    await assertion;
  });

  it('rejects with the produced error type', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 10);
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    const error = await caught;
    expect(isAppError(error)).toBe(true);
  });
});

describe('combinedSignal', () => {
  it('is not aborted before the deadline', () => {
    vi.useFakeTimers();
    const { signal, dispose } = combinedSignal(500);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(499);
    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('aborts with a TIMEOUT AppError after the deadline', () => {
    vi.useFakeTimers();
    const { signal, dispose } = combinedSignal(500);
    vi.advanceTimersByTime(500);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(AppError);
    expect((signal.reason as AppError).code).toBe(ErrorCodes.TIMEOUT);
    dispose();
  });

  it('dispose clears the timer so the signal never aborts', () => {
    vi.useFakeTimers();
    const { signal, dispose } = combinedSignal(500);
    dispose();
    vi.advanceTimersByTime(10_000);
    expect(signal.aborted).toBe(false);
  });

  it('forwards aborts from wrapped signals with their reason', () => {
    const controller = new AbortController();
    const { signal, dispose } = combinedSignal(60_000, [controller.signal]);
    controller.abort('user-stop');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('user-stop');
    dispose();
  });

  it('starts aborted when a wrapped signal is already aborted', () => {
    const { signal, dispose } = combinedSignal(60_000, [AbortSignal.abort('pre-aborted')]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('pre-aborted');
    dispose();
  });

  it('dispose detaches wrapped signal listeners', () => {
    const controller = new AbortController();
    const { signal, dispose } = combinedSignal(60_000, [controller.signal]);
    dispose();
    controller.abort('too late');
    expect(signal.aborted).toBe(false);
  });
});

describe('createDeferred', () => {
  it('resolves through the external handle', async () => {
    const deferred = createDeferred<number>();
    deferred.resolve(7);
    await expect(deferred.promise).resolves.toBe(7);
  });

  it('rejects through the external handle', async () => {
    const deferred = createDeferred<number>();
    const assertion = expect(deferred.promise).rejects.toThrow('later');
    deferred.reject(new Error('later'));
    await assertion;
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    const pending = sleep(100);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(100, controller.signal)).rejects.toMatchObject({
      code: ErrorCodes.ABORTED,
    });
  });

  it('rejects with an ABORTED AppError when aborted while sleeping', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.ABORTED });
    controller.abort();
    await assertion;
  });
});
