import { describe, expect, it } from 'vitest';
import { parseAdditionalParams, serializeAdditionalParams } from './additionalParams.js';

const EMPTY = { includeBody: '', excludeBody: '', includeHeaders: '' };

describe('parseAdditionalParams', () => {
  it('treats all-empty fields as "unset"', () => {
    const result = parseAdditionalParams(EMPTY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  it('parses a valid include body object', () => {
    const result = parseAdditionalParams({
      ...EMPTY,
      includeBody: '{ "top_k": 20, "repetition_penalty": 1.1 }',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customIncludeBody).toEqual({ top_k: 20, repetition_penalty: 1.1 });
    }
  });

  it('rejects a non-object include body', () => {
    const result = parseAdditionalParams({ ...EMPTY, includeBody: '[1, 2]' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.field).toBe('includeBody');
      expect(result.error[0]?.messageKey).toBe('additionalParamsBodyObjectError');
    }
  });

  it('rejects invalid JSON with a dedicated message', () => {
    const result = parseAdditionalParams({ ...EMPTY, includeBody: '{ not json' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.some((issue) => issue.messageKey === 'additionalParamsInvalidJson')).toBe(
        true,
      );
    }
  });

  it('parses a valid exclude body array', () => {
    const result = parseAdditionalParams({
      ...EMPTY,
      excludeBody: '["frequency_penalty", "presence_penalty"]',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customExcludeBody).toEqual(['frequency_penalty', 'presence_penalty']);
    }
  });

  it('rejects an exclude body that is not an array of strings', () => {
    const result = parseAdditionalParams({ ...EMPTY, excludeBody: '["ok", 1]' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.messageKey).toBe('additionalParamsExcludeArrayError');
    }
  });

  it('parses valid include headers', () => {
    const result = parseAdditionalParams({
      ...EMPTY,
      includeHeaders: '{ "X-Custom": "value" }',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customIncludeHeaders).toEqual({ 'X-Custom': 'value' });
    }
  });

  it('rejects non-string header values', () => {
    const result = parseAdditionalParams({ ...EMPTY, includeHeaders: '{ "X-Custom": 1 }' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.messageKey).toBe('additionalParamsHeadersValueError');
    }
  });

  it('rejects forbidden headers case-insensitively', () => {
    const result = parseAdditionalParams({
      ...EMPTY,
      includeHeaders: '{ "Authorization": "Bearer x" }',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.messageKey).toBe('additionalParamsForbiddenHeader');
    }
  });

  it('rejects adapter-reserved body keys in include and exclude lists', () => {
    const include = parseAdditionalParams({ ...EMPTY, includeBody: '{ "stream": false }' });
    expect(include.ok).toBe(false);
    if (!include.ok) {
      expect(include.error[0]?.field).toBe('includeBody');
      expect(include.error[0]?.messageKey).toBe('additionalParamsReservedKey');
    }

    const exclude = parseAdditionalParams({ ...EMPTY, excludeBody: '["stream"]' });
    expect(exclude.ok).toBe(false);
    if (!exclude.ok) {
      expect(exclude.error[0]?.field).toBe('excludeBody');
      expect(exclude.error[0]?.messageKey).toBe('additionalParamsReservedKey');
    }
  });

  it('collects issues from every invalid field at once', () => {
    const result = parseAdditionalParams({
      includeBody: '[]',
      excludeBody: '"nope"',
      includeHeaders: '{ bad json',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.error.map((issue) => issue.field);
      expect(fields).toContain('includeBody');
      expect(fields).toContain('excludeBody');
      expect(fields).toContain('includeHeaders');
    }
  });
});

describe('serializeAdditionalParams', () => {
  it('returns empty text for absent or empty values', () => {
    expect(serializeAdditionalParams({})).toEqual(EMPTY);
    expect(serializeAdditionalParams({ customIncludeBody: {}, customExcludeBody: [] })).toEqual(
      EMPTY,
    );
  });

  it('pretty-prints stored structured values back to JSON text', () => {
    const value = serializeAdditionalParams({
      customIncludeBody: { top_k: 20 },
      customExcludeBody: ['frequency_penalty'],
      customIncludeHeaders: { 'X-Custom': 'value' },
    });
    expect(JSON.parse(value.includeBody)).toEqual({ top_k: 20 });
    expect(JSON.parse(value.excludeBody)).toEqual(['frequency_penalty']);
    expect(JSON.parse(value.includeHeaders)).toEqual({ 'X-Custom': 'value' });
  });
});
