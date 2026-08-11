import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr, type Result } from '../src/result.js';
import { AppError, ErrorCodes } from '../src/error.js';

describe('constructors', () => {
  it('ok builds a success result', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
  });

  it('err builds a failure result', () => {
    expect(err('bad')).toEqual({ ok: false, error: 'bad' });
  });

  it('defaults the error type to AppError', () => {
    const result: Result<number> = err(new AppError({ code: ErrorCodes.NOT_FOUND }));
    expect(result.ok).toBe(false);
  });
});

describe('guards', () => {
  it('isOk and isErr discriminate and narrow', () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err('nope');
    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);

    if (isOk(success)) expect(success.value).toBe(1);
    if (isErr(failure)) expect(failure.error).toBe('nope');
  });
});

describe('map / mapErr', () => {
  it('map transforms successes and leaves failures untouched', () => {
    expect(map(ok(2), (value) => value * 10)).toEqual({ ok: true, value: 20 });
    const failure: Result<number, string> = err('boom');
    const mapped = map(failure, (value) => value * 10);
    expect(mapped).toBe(failure);
  });

  it('mapErr transforms failures and leaves successes untouched', () => {
    expect(mapErr(err('boom'), (error) => error.toUpperCase())).toEqual({
      ok: false,
      error: 'BOOM',
    });
    const success: Result<number, string> = ok(1);
    expect(mapErr(success, (error) => error.toUpperCase())).toBe(success);
  });
});

describe('unwrap / unwrapOr', () => {
  it('unwrap returns the success value', () => {
    expect(unwrap(ok('value'))).toBe('value');
  });

  it('unwrap throws the original Error on failure', () => {
    const error = new AppError({ code: ErrorCodes.VALIDATION, message: 'invalid' });
    expect(() => unwrap(err(error))).toThrow(error);
  });

  it('unwrap wraps non-Error failures in a new Error', () => {
    expect(() => unwrap(err('string failure'))).toThrow('string failure');
  });

  it('unwrapOr returns the value on success and the fallback on failure', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err('bad'), 99)).toBe(99);
  });
});
