/** Unit tests for the prompt pipeline stages. */
import { describe, it, expect } from 'vitest';
import {
  exportInstructFormat,
  getInstructFormat,
  importInstructFormat,
  listInstructFormats,
  renderInstruct,
} from '../src/pipeline/instruct.js';
import {
  ContextStrategyRegistry,
  shiftContext,
  type PromptMessage,
} from '../src/pipeline/contextShift.js';
import { runPromptPipeline } from '../src/pipeline/promptPipeline.js';
import { DEFAULT_PROMPT_TEMPLATE, type Character, type Message } from '@neotavern/contracts';
import { ErrorCodes } from '@neotavern/shared';

const character: Character = {
  id: 'c1',
  name: 'Alice',
  avatar: null,
  description: '{{char}} is curious.',
  personality: 'brave',
  scenario: 'Wonderland',
  firstMessage: 'Hello {{user}}!',
  exampleDialogues: '',
  systemPrompt: null,
  postHistoryInstructions: null,
  creator: null,
  creatorNotes: null,
  tags: [],
  ext: {},
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

describe('instruct formats', () => {
  it('renders chatml with role wrappers', () => {
    const format = getInstructFormat('chatml');
    const rendered = renderInstruct(format, [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
    expect(rendered).toContain('system');
    expect(rendered).toContain('be nice');
    expect(rendered).toContain('hi');
  });

  it('does not HTML-escape content', () => {
    const format = getInstructFormat('chatml');
    const rendered = renderInstruct(format, [{ role: 'user', content: '<b>&' }]);
    expect(rendered).toContain('<b>&');
  });

  it('imports a custom format preset', () => {
    const format = importInstructFormat({
      id: 'custom',
      system: 'S:{{{content}}}',
      user: 'U:{{{content}}}',
      assistant: 'A:{{{content}}}',
      tool: 'T:{{{content}}}',
      promptSuffix: 'A:',
      stopStrings: ['S:'],
    });
    expect(format.id).toBe('custom');
    expect(renderInstruct(format, [{ role: 'user', content: 'hey' }])).toContain('U:hey');
  });

  it('provides Mistral and Command-R built-in formats', () => {
    expect(listInstructFormats().map((format) => format.id)).toEqual(
      expect.arrayContaining(['chatml', 'llama3', 'alpaca', 'mistral', 'command-r']),
    );
    expect(renderInstruct(getInstructFormat('mistral'), [{ role: 'user', content: 'hello' }])).toBe(
      '[INST]hello[/INST]',
    );
    expect(
      renderInstruct(getInstructFormat('command-r'), [{ role: 'user', content: 'hello' }]),
    ).toContain('<|USER_TOKEN|>hello<|END_OF_TURN_TOKEN|>');
  });

  it('exports a detached versioned preset that round-trips through import', () => {
    const source = getInstructFormat('command-r');
    const exported = exportInstructFormat(source);
    expect(exported).not.toBe(source);
    expect(exported.stopStrings).not.toBe(source.stopStrings);
    expect(importInstructFormat(JSON.parse(JSON.stringify(exported)))).toEqual(source);
  });
});

describe('context shifting', () => {
  const msg = (content: string, role: PromptMessage['role'] = 'user'): PromptMessage => ({
    role,
    content,
  });

  it('drops oldest messages to fit the budget, protecting system', async () => {
    const messages: PromptMessage[] = [
      { role: 'system', content: 'SYSTEM '.repeat(10) },
      msg('one '.repeat(20)),
      msg('two '.repeat(20)),
      msg('three '.repeat(20)),
    ];
    const result = await shiftContext(messages, (text) => Math.ceil(text.length / 4), 60);
    expect(result.truncated).toBe(true);
    // System always survives.
    expect(result.kept.some((m) => m.role === 'system')).toBe(true);
    // Newest survives.
    expect(result.kept.some((m) => m.content.startsWith('three'))).toBe(true);
    // Oldest dropped.
    expect(result.kept.some((m) => m.content.startsWith('one'))).toBe(false);
  });

  it('protects pinned messages', async () => {
    const messages: PromptMessage[] = [
      { role: 'user', content: 'pinned '.repeat(10), pinned: true },
      msg('filler '.repeat(30)),
      msg('recent'),
    ];
    const result = await shiftContext(messages, (text) => Math.ceil(text.length / 4), 25);
    expect(result.kept.some((m) => m.pinned === true)).toBe(true);
  });

  it('removes tool-call/result pairs together', async () => {
    const messages: PromptMessage[] = [
      { role: 'assistant', content: 'calling tool '.repeat(10) },
      { role: 'tool', content: 'tool result '.repeat(10) },
      msg('recent question'),
    ];
    const result = await shiftContext(messages, (text) => Math.ceil(text.length / 4), 12);
    const hasAssistant = result.kept.some((m) => m.role === 'assistant');
    const hasTool = result.kept.some((m) => m.role === 'tool');
    // Both removed together or both kept — never orphaned.
    expect(hasAssistant).toBe(hasTool);
  });

  it('removes non-adjacent tool-call/result messages linked by pair id', async () => {
    const messages: PromptMessage[] = [
      { id: 'call', role: 'assistant', content: 'call '.repeat(20), pairId: 'pair-1' },
      { id: 'other', role: 'user', content: 'other '.repeat(20) },
      { id: 'result', role: 'tool', content: 'result '.repeat(20), pairId: 'pair-1' },
      { id: 'recent', role: 'user', content: 'recent' },
    ];
    const result = await shiftContext(messages, (text) => Math.ceil(text.length / 4), 15);
    expect(result.kept.some((message) => message.id === 'call')).toBe(false);
    expect(result.kept.some((message) => message.id === 'result')).toBe(false);
  });

  it('reports when protected context alone exceeds the budget', async () => {
    const result = await shiftContext(
      [{ role: 'system', content: 'protected '.repeat(20), pinned: true }],
      (text) => Math.ceil(text.length / 4),
      5,
    );
    expect(result.fitsBudget).toBe(false);
    expect(result.excluded).toHaveLength(0);
  });
});

describe('context strategy registry', () => {
  const countTokens = (text: string): number => Math.ceil(text.length / 4);

  it('registers every required built-in strategy', () => {
    expect(new ContextStrategyRegistry().ids()).toEqual([
      'manual',
      'summarize',
      'truncate',
      'vector-recall',
    ]);
  });

  it('summarizes excluded history and still fits the final budget', async () => {
    const registry = new ContextStrategyRegistry();
    const messages: PromptMessage[] = [
      { id: 'old-1', role: 'user', content: 'first detail '.repeat(20), source: 'history' },
      {
        id: 'old-2',
        role: 'assistant',
        content: 'second detail '.repeat(20),
        source: 'history',
      },
      { id: 'recent', role: 'user', content: 'continue', source: 'user', pinned: true },
    ];
    const result = await registry.resolve('summarize').shift({
      messages,
      countTokens,
      budgetTokens: 50,
    });
    expect(result.strategy).toBe('summarize');
    expect(result.summaryCreated).toBe(true);
    expect(result.kept.some((item) => item.id === 'core.context-summary')).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);
    expect(result.excluded.map((item) => item.id)).toEqual(
      expect.arrayContaining(['old-1', 'old-2']),
    );
  });

  it('vector recall removes lower-relevance memory first', async () => {
    const registry = new ContextStrategyRegistry();
    const messages: PromptMessage[] = [
      {
        id: 'low',
        role: 'system',
        content: 'low relevance '.repeat(10),
        source: 'memory',
        relevance: 0.1,
      },
      {
        id: 'high',
        role: 'system',
        content: 'high relevance '.repeat(10),
        source: 'memory',
        relevance: 0.95,
      },
      { id: 'recent', role: 'user', content: 'continue', source: 'user', pinned: true },
    ];
    const result = await registry.resolve('vector-recall').shift({
      messages,
      countTokens,
      budgetTokens: 50,
    });
    expect(result.excluded.some((item) => item.id === 'low')).toBe(true);
    expect(result.kept.some((item) => item.id === 'high')).toBe(true);
  });

  it('manual mode removes selected tool pairs and safely truncates if needed', async () => {
    const registry = new ContextStrategyRegistry();
    const messages: PromptMessage[] = [
      {
        id: 'call',
        role: 'assistant',
        content: 'tool call '.repeat(10),
        source: 'history',
      },
      {
        id: 'result',
        role: 'tool',
        content: 'tool result '.repeat(10),
        source: 'history',
      },
      {
        id: 'old',
        role: 'user',
        content: 'old context '.repeat(20),
        source: 'history',
      },
      { id: 'recent', role: 'user', content: 'continue', source: 'user', pinned: true },
    ];
    const result = await registry.resolve('manual').shift({
      messages,
      countTokens,
      budgetTokens: 20,
      manualExcludedIds: new Set(['call']),
    });
    expect(result.excluded.map((item) => item.id)).toEqual(
      expect.arrayContaining(['call', 'result']),
    );
    expect(result.manualFallback).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(20);
  });

  it('restores the previous strategy after plugin cleanup', () => {
    const registry = new ContextStrategyRegistry();
    const builtin = registry.resolve('truncate');
    const remove = registry.register({
      id: 'truncate',
      priority: 100,
      shift: ({ messages }) => ({
        kept: messages,
        excluded: [],
        estimatedTokens: 0,
        truncated: false,
        fitsBudget: true,
      }),
    });
    expect(registry.resolve('truncate')).not.toBe(builtin);
    remove();
    expect(registry.resolve('truncate')).toBe(builtin);
  });
});

describe('runPromptPipeline', () => {
  it('assembles messages, applies macros, and builds a request', async () => {
    const result = await runPromptPipeline({
      character,
      persona: {
        id: 'p1',
        name: 'Bob',
        description: '',
        avatar: null,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      },
      history: [],
      userInput: 'Hello {{char}}',
      model: 'echo',
    });
    // Ordered system blocks preserve the character description and macro expansion.
    const system = result.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain('Alice is curious');
    // User message macros resolved.
    const user = result.messages.find((m) => m.role === 'user');
    expect(user?.content).toBe('Hello Alice');
    expect(result.request.model).toBe('echo');
    expect(result.request.stream).toBe(true);
    expect(result.request.messages).toEqual(result.messages);
    expect(result.request.stop).toBeUndefined();
    expect(result.diagnostics).toContain('native chat message serialization applied');
  });

  it('reorders and hides text-completion blocks before explicit serialization', async () => {
    const priority = new Map([
      ['scenario', 0],
      ['character-description', 1],
      ['chat-history', 2],
    ]);
    const blocks = DEFAULT_PROMPT_TEMPLATE.blocks
      .map((block) => ({ ...block, enabled: block.id !== 'main-prompt' }))
      .sort((left, right) => (priority.get(left.id) ?? 99) - (priority.get(right.id) ?? 99));
    const result = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'echo',
      promptTemplate: {
        mode: 'text',
        blocks,
        postHistoryInstructions: 'Keep moving forward.',
      },
    });

    expect(result.request.messages).toHaveLength(1);
    const serialized = result.request.messages[0]?.content ?? '';
    expect(serialized.indexOf('Wonderland')).toBeLessThan(serialized.indexOf('Alice is curious'));
    expect(serialized).not.toContain('Stay in character at all times');
    expect(serialized).toContain('Keep moving forward.');
    expect(serialized.indexOf('hello')).toBeLessThan(serialized.indexOf('Keep moving forward.'));
    expect(result.diagnostics).toContain('ordered text-completion prompt template applied');
    expect(result.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'core.main-prompt',
          included: false,
          exclusionReason: 'disabled',
          content: expect.stringContaining("Write Alice's next reply"),
        }),
        expect.objectContaining({
          identifier: 'core.current-user-input',
          included: true,
          exclusionReason: 'none',
          content: 'hello',
        }),
      ]),
    );
    const currentInputOrder = result.auditEntries.find(
      (entry) => entry.identifier === 'core.current-user-input',
    )?.order;
    const postHistoryOrder = result.auditEntries.find(
      (entry) => entry.identifier === 'core.template-post-history-instructions',
    )?.order;
    expect(currentInputOrder).toBeLessThan(postHistoryOrder ?? -1);
  });

  it('applies custom prompt roles, macros, triggers, and in-chat depth', async () => {
    const coreBlocks = DEFAULT_PROMPT_TEMPLATE.blocks.map((block) => ({
      ...block,
      enabled: block.id === 'chat-history',
    }));
    const result = await runPromptPipeline({
      character,
      persona: null,
      history: [
        message('old-user', 'First turn', 'user'),
        message('new-assistant', 'Newest reply', 'assistant'),
      ],
      model: 'echo',
      generationType: 'regenerate',
      promptTemplate: {
        mode: 'text',
        blocks: [
          ...coreBlocks,
          {
            id: 'custom-emotion',
            name: 'Emotion cue',
            enabled: true,
            role: 'system',
            content: 'Show {{char}} feeling conflicted.',
            injectionPosition: 'in-chat',
            injectionDepth: 1,
            injectionOrder: 80,
            triggers: ['regenerate'],
          },
          {
            id: 'custom-normal-only',
            name: 'Normal only',
            enabled: true,
            role: 'user',
            content: 'This must not run.',
            injectionPosition: 'relative',
            triggers: ['normal'],
          },
        ],
        postHistoryInstructions: '',
      },
    });

    expect(result.messages.map((entry) => [entry.role, entry.content])).toEqual([
      ['user', 'First turn'],
      ['system', 'Show Alice feeling conflicted.'],
      ['assistant', 'Newest reply'],
    ]);
    expect(result.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'template.custom-emotion',
          included: true,
          name: 'Emotion cue',
          source: 'template',
        }),
        expect.objectContaining({
          identifier: 'template.custom-normal-only',
          included: false,
          exclusionReason: 'disabled',
        }),
      ]),
    );
  });

  it('excludes blocks bound to a different model and keeps matching ones', async () => {
    const blocks = [
      ...DEFAULT_PROMPT_TEMPLATE.blocks.map((block) => ({
        ...block,
        enabled: block.id === 'main-prompt',
        ...(block.id === 'main-prompt' ? { model: 'gpt-4o' } : {}),
      })),
      {
        id: 'custom-echo-only',
        name: 'Echo only',
        enabled: true,
        role: 'system',
        content: 'Echo-bound block.',
        model: 'echo',
      },
    ];
    const forEcho = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'echo',
      promptTemplate: { mode: 'text', blocks, postHistoryInstructions: '' },
    });

    expect(
      forEcho.messages.some((message) => message.content.includes("Write Alice's next reply")),
    ).toBe(false);
    expect(forEcho.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'core.main-prompt',
          included: false,
          exclusionReason: 'model-mismatch',
        }),
        expect.objectContaining({
          identifier: 'template.custom-echo-only',
          included: true,
          exclusionReason: 'none',
        }),
      ]),
    );

    const forGpt = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'gpt-4o',
      promptTemplate: { mode: 'text', blocks, postHistoryInstructions: '' },
    });
    expect(
      forGpt.messages.some((message) => message.content.includes("Write Alice's next reply")),
    ).toBe(true);
    expect(forGpt.messages.some((message) => message.content.includes('Echo-bound block'))).toBe(
      false,
    );
  });

  it('serializes a selected built-in chat template explicitly', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'echo',
      instructFormatId: 'llama3',
    });
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0]?.content).toContain('<|start_header|>user');
    expect(result.diagnostics).toContain('built-in instruct format "llama3" applied');
  });

  it('forces text serialization for text-completion providers and skips post-processing', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'test-model',
      providerKind: 'text-completion',
      promptPostProcessing: 'merge',
    });
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0]?.role).toBe('user');
    expect(result.request.messages[0]?.content).toContain('hello');
    expect(result.diagnostics).toContain(
      'text-completion provider serialized the instruct prompt as text',
    );
    expect(result.diagnostics.some((d) => d.includes('prompt post-processing'))).toBe(false);
  });

  it('applies prompt post-processing to chat messages before serialization', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [message('h1', 'first')],
      userInput: 'second',
      model: 'echo',
      providerKind: 'openai-compatible',
      promptPostProcessing: 'merge',
    });
    // Canonical messages keep the two consecutive user turns...
    const canonicalUsers = result.messages.filter((m) => m.role === 'user');
    expect(canonicalUsers.map((m) => m.content)).toEqual(['first', 'second']);
    // ...but the provider request merges them.
    const requestUsers = result.request.messages.filter((m) => m.role === 'user');
    expect(requestUsers).toHaveLength(1);
    expect(requestUsers[0]?.content).toBe('first\n\nsecond');
    expect(result.diagnostics).toContain('prompt post-processing "merge" applied');
    expect(result.diagnostics).toContain('native chat message serialization applied');
  });

  it('isolates a failing interceptor', async () => {
    const result = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hi',
      model: 'echo',
      interceptors: [
        {
          id: 'broken',
          intercept: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    expect(result.diagnostics.some((d) => d.includes('broken') && d.includes('skipped'))).toBe(
      true,
    );
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('skips interceptors whose required permission is not granted', async () => {
    let called = false;
    const result = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hi',
      model: 'echo',
      hasPermission: (permission) => permission !== 'prompt.modify',
      interceptors: [
        {
          id: 'unprivileged',
          requiredPermission: 'prompt.modify',
          intercept: ({ messages }) => {
            called = true;
            return { messages };
          },
        },
      ],
    });
    expect(called).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.includes('unprivileged') && d.includes('missing permission "prompt.modify"'),
      ),
    ).toBe(true);
  });

  it('runs interceptors whose required permission is granted', async () => {
    let called = false;
    await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'hi',
      model: 'echo',
      hasPermission: () => true,
      interceptors: [
        {
          id: 'privileged',
          requiredPermission: 'prompt.modify',
          intercept: ({ messages }) => {
            called = true;
            return { messages };
          },
        },
      ],
    });
    expect(called).toBe(true);
  });

  it('restores protected host messages removed by an interceptor', async () => {
    const result = await runPromptPipeline({
      character,
      persona: null,
      history: [],
      userInput: 'protected user input',
      model: 'echo',
      interceptors: [
        {
          id: 'drops-everything',
          intercept: () => ({ messages: [] }),
        },
      ],
    });
    expect(result.messages.some((message) => message.role === 'system')).toBe(true);
    expect(result.messages.some((message) => message.content === 'protected user input')).toBe(
      true,
    );
  });

  it('assembles lorebook, memory and post-history instructions with macros', async () => {
    const result = await runPromptPipeline({
      character: { ...character, postHistoryInstructions: 'Remember {{user}}.' },
      persona: {
        id: 'p1',
        name: 'Bob',
        description: '',
        avatar: null,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      },
      contextBlocks: [
        { id: 'lore-1', source: 'lorebook', content: '{{char}} owns a map.', required: true },
        { id: 'memory-1', source: 'memory', content: '{{user}} likes tea.' },
      ],
      history: [],
      userInput: 'Continue',
      model: 'echo',
    });
    const content = result.messages.map((message) => message.content);
    expect(content).toContain('Alice owns a map.');
    expect(content).toContain('Bob likes tea.');
    expect(content).toContain('Remember Bob.');
  });

  it('shifts before interceptors and enforces the budget again afterwards', async () => {
    const history: Message[] = [message('old', 'old '.repeat(80)), message('recent', 'recent')];
    let interceptorSawOldMessage = true;
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history,
      userInput: 'now',
      model: 'echo',
      maxContextTokens: 40,
      reserveForReply: 10,
      countTokens: (text) => Math.ceil(text.length / 4),
      tokenizerProfile: 'test-exact',
      tokenizerApproximate: false,
      interceptors: [
        {
          id: 'expander',
          intercept: ({ messages }) => {
            interceptorSawOldMessage = messages.some((item) => item.id === 'old');
            return {
              messages: [
                ...messages,
                {
                  id: 'plugin-large',
                  role: 'system',
                  content: 'plugin '.repeat(80),
                  pinned: true,
                  source: 'system',
                },
              ],
            };
          },
        },
      ],
    });
    expect(interceptorSawOldMessage).toBe(false);
    expect(result.messages.some((item) => item.content.startsWith('plugin'))).toBe(false);
    expect(result.tokenBudget).toMatchObject({
      profile: 'test-exact',
      approximate: false,
      contextLimit: 40,
      reservedForReply: 10,
    });
    expect(result.tokenBudget.promptTokens).toBeLessThanOrEqual(30);
  });

  it('runs the selected context strategy through the complete pipeline', async () => {
    const registry = new ContextStrategyRegistry();
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [
        message('old-1', 'remember the red door '.repeat(20)),
        message('old-2', 'remember the blue key '.repeat(20)),
      ],
      userInput: 'continue',
      model: 'echo',
      maxContextTokens: 70,
      reserveForReply: 20,
      countTokens: (text) => Math.ceil(text.length / 4),
      tokenizerProfile: 'test-exact',
      tokenizerApproximate: false,
      contextStrategy: registry.resolve('summarize'),
    });
    expect(result.contextStrategy).toBe('summarize');
    expect(
      result.messages.some((item) => item.content.includes('Summary of earlier context')),
    ).toBe(true);
    expect(result.diagnostics).toContain('context summary created');
    expect(result.tokenBudget.promptTokens).toBeLessThanOrEqual(50);
  });

  it('rejects a plugin strategy that removes protected context', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [message('old', 'old history')],
      userInput: 'protected current input',
      model: 'echo',
      countTokens: (text) => Math.ceil(text.length / 4),
      tokenizerProfile: 'test-exact',
      tokenizerApproximate: false,
      contextStrategy: {
        id: 'unsafe-plugin',
        shift: () => ({
          kept: [],
          excluded: [],
          estimatedTokens: 0,
          truncated: false,
          fitsBudget: true,
          strategy: 'unsafe-plugin',
        }),
      },
    });
    expect(result.messages.some((item) => item.content === 'protected current input')).toBe(true);
    expect(result.contextStrategy).toBe('truncate');
    expect(result.diagnostics.some((item) => item.includes('rejected'))).toBe(true);
  });

  it('fails with a stable code when protected context cannot fit', async () => {
    await expect(
      runPromptPipeline({
        character: null,
        persona: null,
        contextBlocks: [
          {
            id: 'required-lore',
            source: 'lorebook',
            content: 'required '.repeat(100),
            required: true,
          },
        ],
        history: [],
        userInput: 'now',
        model: 'echo',
        maxContextTokens: 20,
        reserveForReply: 10,
        countTokens: (text) => Math.ceil(text.length / 4),
        tokenizerProfile: 'test-exact',
        tokenizerApproximate: false,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.TOKEN_BUDGET_EXCEEDED,
      params: {
        contextLimit: 20,
        reservedForReply: 10,
      },
    });
  });

  it('reserves the actual overridden response size', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [message('older', 'older '.repeat(30))],
      userInput: 'now',
      model: 'echo',
      maxContextTokens: 60,
      reserveForReply: 10,
      generationOverrides: { maxTokens: 30 },
      countTokens: (text) => Math.ceil(text.length / 4),
      tokenizerProfile: 'test-exact',
      tokenizerApproximate: false,
    });
    expect(result.request.maxTokens).toBe(30);
    expect(result.tokenBudget.reservedForReply).toBe(30);
    expect(result.tokenBudget.promptTokens).toBeLessThanOrEqual(30);
  });

  it('forwards generation parameters and applies a custom instruct format', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'local-model',
      instructFormat: {
        id: 'custom-test',
        version: 1,
        system: 'S:{{{content}}}\n',
        user: 'U:{{{content}}}\n',
        assistant: 'A:{{{content}}}\n',
        tool: 'T:{{{content}}}\n',
        promptSuffix: 'A:',
        stopStrings: ['STOP'],
      },
      generationOverrides: {
        maxTokens: 256,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        topA: 0.1,
        repetitionPenalty: 1.1,
        frequencyPenalty: 0.2,
        presencePenalty: 0.3,
        seed: 42,
        reasoning: true,
        reasoningEffort: 'low',
        stream: false,
      },
    });

    expect(result.request).toMatchObject({
      maxTokens: 256,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      topA: 0.1,
      repetitionPenalty: 1.1,
      frequencyPenalty: 0.2,
      presencePenalty: 0.3,
      seed: 42,
      reasoning: true,
      reasoningEffort: 'low',
      stream: false,
      stop: ['STOP'],
    });
    expect(result.request.messages).toEqual([{ role: 'user', content: 'U:hello\nA:' }]);
    expect(result.diagnostics).toContain('custom instruct format "custom-test" applied');
  });

  it('protects the newest persisted user message when userInput is already in history', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [
        message('old', 'old '.repeat(80)),
        message('current', 'the current request must survive'),
      ],
      model: 'echo',
      maxContextTokens: 35,
      reserveForReply: 15,
      countTokens: (text) => Math.ceil(text.length / 4),
      tokenizerProfile: 'test-exact',
      tokenizerApproximate: false,
    });
    expect(
      result.messages.some((item) => item.content === 'the current request must survive'),
    ).toBe(true);
    expect(result.messages.some((item) => item.content.startsWith('old'))).toBe(false);
  });

  it('surfaces the approximate tokenizer fallback', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'echo',
    });
    expect(result.tokenBudget.approximate).toBe(true);
    expect(result.diagnostics).toContain('tokenizer "approximate-character-v1" is approximate');
  });

  it('merges connection stop strings with format and explicit overrides without duplicates', async () => {
    const result = await runPromptPipeline({
      character: null,
      persona: null,
      history: [],
      userInput: 'hello',
      model: 'echo',
      instructFormatId: 'chatml',
      connectionStopStrings: ['<|im_end|>', 'profile-stop'],
      assistantPrefill: 'Answer: ',
      generationOverrides: { stop: ['profile-stop', 'manual-stop'] },
    });
    expect(result.request.stop).toEqual(['<|im_end|>', 'profile-stop', 'manual-stop']);
    expect(result.request.assistantPrefill).toBe('Answer: ');
  });
});

function message(id: string, content: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    chatId: 'chat-1',
    branchId: 'branch-1',
    parentId: null,
    role,
    content,
    name: null,
    meta: {},
    createdAt: 0,
  };
}
