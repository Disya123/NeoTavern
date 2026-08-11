/**
 * Unit tests for the SillyTavern-style prompt post-processing stage
 * (merge/semi/strict/single and their `_tools` variants).
 */
import { describe, it, expect } from 'vitest';
import type { GenerationMessage } from '@neotavern/contracts';
import {
  DEFAULT_PROMPT_PLACEHOLDER,
  mergeMessages,
  postProcessMessages,
} from '../src/pipeline/promptPostProcessing.js';

const msg = (role: GenerationMessage['role'], content: string, name?: string): GenerationMessage =>
  name === undefined ? { role, content } : { role, content, name };

describe('prompt post-processing', () => {
  it('returns messages unchanged for the empty/unknown mode', () => {
    const messages = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')];
    expect(postProcessMessages(messages, '')).toEqual(messages);
    expect(postProcessMessages(messages, undefined)).toEqual(messages);
  });

  it('merge squashes consecutive same-role messages', () => {
    const result = postProcessMessages(
      [msg('user', 'a'), msg('user', 'b'), msg('assistant', 'x'), msg('assistant', 'y')],
      'merge',
    );
    expect(result).toEqual([msg('user', 'a\n\nb'), msg('assistant', 'x\n\ny')]);
  });

  it('merge rewrites tool turns to user and folds them in', () => {
    const result = postProcessMessages(
      [msg('user', 'a'), msg('tool', 'b'), msg('user', 'c')],
      'merge',
    );
    expect(result).toEqual([msg('user', 'a\n\nb\n\nc')]);
  });

  it('merge_tools keeps tool turns intact and unmerged', () => {
    const result = postProcessMessages(
      [msg('user', 'a'), msg('tool', 'b'), msg('user', 'c')],
      'merge_tools',
    );
    expect(result).toEqual([msg('user', 'a'), msg('tool', 'b'), msg('user', 'c')]);
  });

  it('semi turns mid-prompt system messages into user and re-squashes', () => {
    const result = postProcessMessages(
      [msg('assistant', 'a'), msg('system', 'mid'), msg('user', 'u')],
      'semi',
    );
    expect(result).toEqual([msg('assistant', 'a'), msg('user', 'mid\n\nu')]);
  });

  it('strict inserts a user placeholder so the prompt is user-first', () => {
    const result = postProcessMessages([msg('assistant', 'hello')], 'strict');
    expect(result).toEqual([msg('user', DEFAULT_PROMPT_PLACEHOLDER), msg('assistant', 'hello')]);
  });

  it('strict adds a placeholder after a lone leading system message', () => {
    const result = postProcessMessages([msg('system', 'sys')], 'strict');
    expect(result).toEqual([msg('system', 'sys'), msg('user', DEFAULT_PROMPT_PLACEHOLDER)]);
  });

  it('single folds everything into one user message with name prefixes', () => {
    const result = postProcessMessages([msg('user', 'hi'), msg('assistant', 'hello')], 'single', {
      charName: 'Bot',
      userName: 'Al',
    });
    expect(result).toEqual([msg('user', 'Al: hi\n\nBot: hello')]);
  });

  it('prefixes named messages and example roles before folding', () => {
    const result = mergeMessages(
      [msg('system', 'example line', 'example_assistant'), msg('assistant', 'hey', 'Bot')],
      { charName: 'Bot' },
      { strict: false },
    );
    expect(result[0]).toEqual(msg('system', 'Bot: example line'));
    expect(result[1]).toEqual(msg('assistant', 'Bot: hey'));
  });

  it('never squashes tool turns even with matching neighbours', () => {
    const result = mergeMessages([msg('tool', 'one'), msg('tool', 'two')], {}, { tools: true });
    expect(result).toEqual([msg('tool', 'one'), msg('tool', 'two')]);
  });

  it('guards against an empty input with a user placeholder', () => {
    expect(postProcessMessages([], 'merge')).toEqual([msg('user', DEFAULT_PROMPT_PLACEHOLDER)]);
  });
});
