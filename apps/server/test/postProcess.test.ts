import { describe, expect, it } from 'vitest';
import { PostProcessorRegistry, runPostProcessors } from '../src/pipeline/postProcess.js';

const context = { chatId: 'chat-1', characterId: null, model: 'echo' };

describe('PostProcessorRegistry', () => {
  it('registers, orders by priority and cleans up', () => {
    const registry = new PostProcessorRegistry();
    const cleanupA = registry.register({ id: 'a', priority: 50, process: (text) => text });
    registry.register({ id: 'b', priority: 10, process: (text) => text });
    registry.register({ id: 'c', process: (text) => text }); // default 100
    expect(registry.ordered().map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(registry.size).toBe(3);
    cleanupA();
    expect(registry.ordered().map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('rejects empty ids', () => {
    const registry = new PostProcessorRegistry();
    expect(() => registry.register({ id: '  ', process: (text) => text })).toThrow();
  });
});

describe('runPostProcessors', () => {
  it('applies hooks sequentially, feeding each result into the next', async () => {
    const result = await runPostProcessors({
      text: 'hello',
      context,
      processors: [
        { id: 'exclaim', priority: 1, process: (text) => `${text}!` },
        { id: 'upper', priority: 2, process: (text) => text.toUpperCase() },
      ],
    });
    expect(result).toBe('HELLO!');
  });

  it('isolates a failing hook and keeps the previous text', async () => {
    const diagnostics: string[] = [];
    const result = await runPostProcessors({
      text: 'keep me',
      context,
      diagnostics,
      processors: [
        {
          id: 'broken',
          process: () => {
            throw new Error('boom');
          },
        },
        { id: 'suffix', process: (text) => `${text}+` },
      ],
    });
    expect(result).toBe('keep me+');
    expect(diagnostics.some((d) => d.includes('broken') && d.includes('skipped'))).toBe(true);
    expect(diagnostics.some((d) => d.includes('suffix') && d.includes('applied'))).toBe(true);
  });

  it('enforces the hook timeout', async () => {
    const diagnostics: string[] = [];
    const result = await runPostProcessors({
      text: 'original',
      context,
      diagnostics,
      processors: [
        {
          id: 'slow',
          timeoutMs: 10,
          process: () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500)),
        },
      ],
    });
    expect(result).toBe('original');
    expect(diagnostics.some((d) => d.includes('slow') && d.includes('skipped'))).toBe(true);
  });

  it('skips hooks without the required permission', async () => {
    let called = false;
    const diagnostics: string[] = [];
    await runPostProcessors({
      text: 'x',
      context,
      diagnostics,
      hasPermission: () => false,
      processors: [
        {
          id: 'guarded',
          requiredPermission: 'prompt.modify',
          process: (text) => {
            called = true;
            return text;
          },
        },
      ],
    });
    expect(called).toBe(false);
    expect(diagnostics[0]).toContain('missing permission "prompt.modify"');
  });

  it('rejects non-string and oversized results without corrupting the text', async () => {
    const result = await runPostProcessors({
      text: 'safe',
      context,
      processors: [
        { id: 'wrong-type', process: () => 42 as unknown as string },
        { id: 'huge', process: () => 'x'.repeat(200_001) },
      ],
    });
    expect(result).toBe('safe');
  });
});
