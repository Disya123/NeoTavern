import { describe, it, expect } from 'vitest';
import { createLogger, redactSecrets, redactSecretText, type LogEntry } from '../src/logger.js';

function collect(): { lines: string[]; entries: () => LogEntry[] } {
  const lines: string[] = [];
  return {
    lines,
    entries: () => lines.map((l) => JSON.parse(l) as LogEntry),
  };
}

describe('redactSecrets', () => {
  it('redacts sensitive keys recursively', () => {
    const input = {
      apiKey: 'sk-123',
      nested: { authorization: 'Bearer x', safe: 'ok', deeper: { password: 'p' } },
      list: [{ token: 't' }, { keep: 1 }],
    };
    const out = redactSecrets(input) as typeof input;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.nested.authorization).toBe('[REDACTED]');
    expect(out.nested.safe).toBe('ok');
    expect(out.nested.deeper.password).toBe('[REDACTED]');
    expect((out.list[0] as { token: string }).token).toBe('[REDACTED]');
    expect((out.list[1] as { keep: number }).keep).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = { apiKey: 'sk-123' };
    redactSecrets(input);
    expect(input.apiKey).toBe('sk-123');
  });

  it('redacts secrets in primitive strings and Error details', () => {
    const out = redactSecrets({
      detail: 'Authorization: Bearer token-value-1234',
      url: 'https://alice:p%40ss@example.test/v1',
      error: new Error('provider rejected api_key=sk-live-secret123'),
      values: ['sk-ant-api03-secret123'],
    }) as {
      detail: string;
      url: string;
      error: { message: string; stack?: string };
      values: string[];
    };

    expect(out.detail).toBe('Authorization: Bearer [REDACTED]');
    expect(out.url).toBe('https://[REDACTED]@example.test/v1');
    expect(out.error.message).not.toContain('sk-live-secret123');
    expect(out.error.stack).not.toContain('sk-live-secret123');
    expect(out.values[0]).toBe('[REDACTED]');
  });
});

describe('redactSecretText', () => {
  it('redacts common credential forms without changing benign text', () => {
    expect(redactSecretText('token = "super-secret-value"')).toBe('token = [REDACTED]');
    expect(redactSecretText('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic [REDACTED]');
    expect(redactSecretText('model gpt-4.1 returned 429')).toBe('model gpt-4.1 returned 429');
  });
});

describe('createLogger', () => {
  it('respects the minimum level', () => {
    const sink = collect();
    const log = createLogger({
      level: 'warn',
      now: () => 't0',
      sink: (l) => sink.lines.push(l),
    });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(sink.lines).toHaveLength(2);
  });

  it('redacts secrets in meta before emitting', () => {
    const sink = collect();
    const log = createLogger({ level: 'debug', now: () => 't0', sink: (l) => sink.lines.push(l) });
    log.info('hello', { apiKey: 'sk-secret', ok: true });
    const entry = sink.entries()[0];
    expect(entry?.meta?.['apiKey']).toBe('[REDACTED]');
    expect(entry?.meta?.['ok']).toBe(true);
  });

  it('redacts secrets embedded in the log message', () => {
    const sink = collect();
    const log = createLogger({ now: () => 't0', sink: (line) => sink.lines.push(line) });
    log.error('provider failed with Bearer secret-token-1234');
    expect(sink.entries()[0]?.message).toBe('provider failed with Bearer [REDACTED]');
  });

  it('creates scoped children', () => {
    const sink = collect();
    const log = createLogger({ scope: 'server', now: () => 't0', sink: (l) => sink.lines.push(l) });
    log.child('characters').info('msg');
    expect(sink.entries()[0]?.scope).toBe('server:characters');
  });
});
