import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLegacyRegistrations,
  findLegacySlashCommand,
  hasLegacyPromptInterceptors,
  listLegacySlashCommands,
  registerLegacyPromptInterceptor,
  registerLegacySlashCommand,
  runLegacyPromptInterceptors,
} from '../src/index.js';

afterEach(() => {
  clearLegacyRegistrations();
  vi.restoreAllMocks();
});

describe('slash command registry', () => {
  it('registers and finds commands case-insensitively', () => {
    registerLegacySlashCommand({ name: 'Roll', handler: () => 6 });
    expect(findLegacySlashCommand('roll')?.name).toBe('Roll');
    expect(findLegacySlashCommand('ROLL')?.name).toBe('Roll');
    expect(findLegacySlashCommand('missing')).toBeUndefined();
  });

  it('returns an unregister function', () => {
    const unregister = registerLegacySlashCommand({ name: 'temp', handler: () => undefined });
    expect(findLegacySlashCommand('temp')).toBeDefined();
    unregister();
    expect(findLegacySlashCommand('temp')).toBeUndefined();
  });

  it('re-registering the same name replaces the command', () => {
    registerLegacySlashCommand({ name: 'x', handler: () => 'first' });
    const second = { name: 'X', handler: (): string => 'second' };
    registerLegacySlashCommand(second);
    expect(findLegacySlashCommand('x')?.handler('')).toBe('second');
    expect(listLegacySlashCommands()).toHaveLength(1);
  });

  it('unregistering a replaced command does not remove its replacement', () => {
    const unregisterFirst = registerLegacySlashCommand({ name: 'dup', handler: () => 'first' });
    registerLegacySlashCommand({ name: 'dup', handler: () => 'second' });
    unregisterFirst();
    expect(findLegacySlashCommand('dup')?.handler('')).toBe('second');
  });

  it('lists all registered commands', () => {
    registerLegacySlashCommand({ name: 'a', handler: () => undefined });
    registerLegacySlashCommand({ name: 'b', description: 'second', handler: () => undefined });
    expect(
      listLegacySlashCommands()
        .map((command) => command.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('prompt interceptor registry', () => {
  it('tracks whether any interceptors are registered', () => {
    expect(hasLegacyPromptInterceptors()).toBe(false);
    const unregister = registerLegacyPromptInterceptor((messages) => messages);
    expect(hasLegacyPromptInterceptors()).toBe(true);
    unregister();
    expect(hasLegacyPromptInterceptors()).toBe(false);
  });

  it('runs interceptors in registration order, threading the result', async () => {
    registerLegacyPromptInterceptor((messages) => [
      ...messages,
      { role: 'system', content: 'first' },
    ]);
    registerLegacyPromptInterceptor((messages) => [
      ...messages,
      { role: 'system', content: 'second' },
    ]);
    const result = await runLegacyPromptInterceptors([{ role: 'user', content: 'hi' }]);
    expect(result.map((message) => message.content)).toEqual(['hi', 'first', 'second']);
  });

  it('awaits async interceptors', async () => {
    registerLegacyPromptInterceptor(async (messages) => [
      ...messages,
      { role: 'system', content: 'async' },
    ]);
    const result = await runLegacyPromptInterceptors([{ role: 'user', content: 'hi' }]);
    expect(result).toHaveLength(2);
  });

  it('isolates a throwing interceptor and keeps generating', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerLegacyPromptInterceptor(() => {
      throw new Error('broken legacy interceptor');
    });
    registerLegacyPromptInterceptor((messages) => [
      ...messages,
      { role: 'system', content: 'survived' },
    ]);
    const result = await runLegacyPromptInterceptors([{ role: 'user', content: 'hi' }]);
    expect(result.map((message) => message.content)).toEqual(['hi', 'survived']);
    expect(console.error).toHaveBeenCalled();
  });

  it('ignores empty-array and non-array interceptor results', async () => {
    const original = [{ role: 'user', content: 'hi' }];
    registerLegacyPromptInterceptor(() => []);
    registerLegacyPromptInterceptor(() => undefined as never);
    const result = await runLegacyPromptInterceptors(original);
    expect(result).toBe(original);
  });

  it('clearLegacyRegistrations removes interceptors and commands', () => {
    registerLegacySlashCommand({ name: 'gone', handler: () => undefined });
    registerLegacyPromptInterceptor((messages) => messages);
    clearLegacyRegistrations();
    expect(listLegacySlashCommands()).toEqual([]);
    expect(hasLegacyPromptInterceptors()).toBe(false);
  });
});
