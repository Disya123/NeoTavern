import { describe, expect, it } from 'vitest';
import { AppError, ErrorCodes, isAppError, safeErrorMessage, toAppError } from '../src/error.js';

describe('AppError', () => {
  it('carries code, params and defaults the message to the code', () => {
    const error = new AppError({ code: ErrorCodes.BAD_REQUEST });
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.params).toEqual({});
    expect(error.message).toBe('BAD_REQUEST');
    expect(error.name).toBe('AppError');
    expect(error).toBeInstanceOf(Error);
  });

  it('keeps an authored message, params and cause', () => {
    const cause = new Error('root');
    const error = new AppError({
      code: ErrorCodes.CHARACTER_NOT_FOUND,
      message: 'Character missing',
      params: { characterId: 'c1' },
      cause,
    });
    expect(error.message).toBe('Character missing');
    expect(error.params).toEqual({ characterId: 'c1' });
    expect(error.cause).toBe(cause);
  });

  it('derives the default HTTP status from the code', () => {
    expect(new AppError({ code: ErrorCodes.INTERNAL }).httpStatus).toBe(500);
    expect(new AppError({ code: ErrorCodes.NOT_FOUND }).httpStatus).toBe(404);
    expect(new AppError({ code: ErrorCodes.TIMEOUT }).httpStatus).toBe(504);
    expect(new AppError({ code: ErrorCodes.ABORTED }).httpStatus).toBe(499);
    expect(new AppError({ code: ErrorCodes.FILE_TOO_LARGE }).httpStatus).toBe(413);
    expect(new AppError({ code: ErrorCodes.VALIDATION }).httpStatus).toBe(422);
  });

  it('allows overriding the HTTP status', () => {
    const error = new AppError({ code: ErrorCodes.NOT_FOUND, httpStatus: 410 });
    expect(error.httpStatus).toBe(410);
  });

  it('serializes to the wire format without the message', () => {
    const error = new AppError({
      code: ErrorCodes.PRESET_NOT_FOUND,
      params: { id: 'p1' },
      message: 'developer-only text',
    });
    expect(error.toJSON()).toEqual({ code: 'PRESET_NOT_FOUND', params: { id: 'p1' } });
  });
});

describe('isAppError', () => {
  it('narrows AppError instances only', () => {
    expect(isAppError(new AppError({ code: ErrorCodes.INTERNAL }))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError({ code: 'INTERNAL' })).toBe(false);
    expect(isAppError('INTERNAL')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('safeErrorMessage', () => {
  it('passes authored AppError messages through', () => {
    const error = new AppError({ code: ErrorCodes.NOT_FOUND, message: 'Character not found' });
    expect(safeErrorMessage(error)).toBe('Character not found');
  });

  it('replaces plain Error messages with the fallback', () => {
    const error = new Error('SQLITE_ERROR: no such table: secrets');
    expect(safeErrorMessage(error)).toBe('Internal error');
    expect(safeErrorMessage(error, 'Something went wrong')).toBe('Something went wrong');
  });

  it('replaces non-error values with the fallback', () => {
    expect(safeErrorMessage('string failure')).toBe('Internal error');
    expect(safeErrorMessage(undefined)).toBe('Internal error');
    expect(safeErrorMessage(42, 'fallback')).toBe('fallback');
  });

  it('uses the fallback for the ORIGINAL value wrapped by toAppError', () => {
    // toAppError copies the unsafe original message into the AppError it
    // returns, so checking the wrapped value would leak it. Callers must check
    // the original thrown value.
    const original = new Error('provider internals: key=sk-leaked');
    const wrapped = toAppError(original);
    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.message).toBe('provider internals: key=sk-leaked');
    expect(safeErrorMessage(original)).toBe('Internal error');
    expect(safeErrorMessage(original, 'Generation failed')).toBe('Generation failed');
  });

  it('passes through toAppError output when a safe fallbackMessage was supplied', () => {
    const wrapped = toAppError(new Error('unsafe internals'), 'Import failed');
    expect(safeErrorMessage(wrapped)).toBe('Import failed');
  });
});

describe('toAppError', () => {
  it('returns AppError inputs unchanged', () => {
    const error = new AppError({ code: ErrorCodes.CONFLICT, message: 'duplicate' });
    expect(toAppError(error)).toBe(error);
  });

  it('wraps plain Errors as INTERNAL, preserving the cause', () => {
    const cause = new Error('disk full');
    const error = toAppError(cause);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('disk full');
    expect(error.cause).toBe(cause);
    expect(error.httpStatus).toBe(500);
  });

  it('prefers an explicit fallback message over the Error message', () => {
    const error = toAppError(new Error('unsafe'), 'Safe fallback');
    expect(error.message).toBe('Safe fallback');
  });

  it('wraps unknown non-Error values with a generic message', () => {
    const error = toAppError('weird');
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('Unknown error');
    expect(error.cause).toBe('weird');

    const withFallback = toAppError(undefined, 'Fallback text');
    expect(withFallback.message).toBe('Fallback text');
    expect(withFallback.cause).toBeUndefined();
  });
});
