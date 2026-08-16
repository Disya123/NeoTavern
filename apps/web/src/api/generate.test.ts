/**
 * Kernel-mode generation over the Product Wire (Этап 2.10): `streamWireGeneration`.
 *
 * The wire path persists the user message through `chats.messages.create` and
 * maps canonical `generation.*` events onto the legacy handler surface. It is
 * exercised here with a stub `NeoBackend` — no Tauri runtime, no HTTP.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnsupportedError } from '@neotavern/neobackend';
import type { MessageDto, WireGenerationEvent } from '@neotavern/contracts';
import { streamWireGeneration, type GenerateHandlers } from './generate.js';

const CHAT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const RUN_ID = '6f5e4d3c-2b1a-4f0e-9d8c-7a6b5c4d3e2f';

const CREATED_USER_MESSAGE: MessageDto = {
  id: '22334455-6677-8899-aabb-ccddeeff0011',
  chatId: CHAT_ID,
  role: 'user',
  content: 'Hello there',
  createdAt: '2026-06-01T12:00:00.000Z',
  sequence: 3,
  meta: {},
};

function recordingHandlers() {
  const calls: string[] = [];
  const steps: unknown[] = [];
  const handlers: GenerateHandlers = {
    onStart: () => calls.push('start'),
    onDelta: () => calls.push('delta'),
    onStep: (step) => {
      calls.push(`step:${step.type}:${step.status}`);
      steps.push(step);
    },
    onDone: () => calls.push('done'),
    onError: () => calls.push('error'),
  };
  return { handlers, calls, steps };
}

/** Minimal backend stub: records createMessage, streams canned events. */
function stubBackend(events: WireGenerationEvent[]) {
  const createMessage = vi.fn(async () => CREATED_USER_MESSAGE);
  const generation = {
    start: vi.fn(async function* start() {
      for (const event of events) yield event;
    }),
  };
  const backend = {
    chats: { createMessage },
    generation,
  };
  return {
    backend: backend as unknown as Parameters<typeof streamWireGeneration>[0],
    createMessage,
    start: generation.start,
  };
}

describe('streamWireGeneration (kernel mode)', () => {
  it('persists the user message, starts, streams deltas and completes with the final message text', async () => {
    const { backend, createMessage, start } = stubBackend([
      { type: 'generation.delta', text: 'Hello ' },
      { type: 'generation.checkpoint', sequence: 1, partialLength: 6 },
      {
        type: 'generation.completed',
        finalMessage: {
          id: '33445566-7788-99aa-bbcc-ddeeff001122',
          chatId: CHAT_ID,
          role: 'assistant',
          content: 'Hello world.',
          createdAt: '2026-06-01T12:00:05.000Z',
          sequence: 4,
          generationRunId: RUN_ID,
          meta: {},
        },
      },
    ]);
    const { handlers, calls } = recordingHandlers();

    await streamWireGeneration(
      backend,
      CHAT_ID,
      { userMessage: 'Hello there' },
      handlers,
      new AbortController().signal,
    );

    expect(createMessage).toHaveBeenCalledWith(
      { chatId: CHAT_ID, role: 'user', content: 'Hello there' },
      { signal: expect.any(AbortSignal) },
    );
    expect(start).toHaveBeenCalledWith(
      { chatId: CHAT_ID, message: 'Hello there' },
      { signal: expect.any(AbortSignal) },
    );
    expect(calls).toEqual(['start', 'delta', 'done']);
  });

  it('maps generation.failed onto onError with the stable wire code', async () => {
    const { backend } = stubBackend([
      { type: 'generation.failed', error: { code: 'PROVIDER_ERROR', params: { attempt: '1' } } },
    ]);
    const { handlers, calls } = recordingHandlers();

    await streamWireGeneration(
      backend,
      CHAT_ID,
      { userMessage: 'Hello' },
      handlers,
      new AbortController().signal,
    );

    expect(calls).toEqual(['start', 'error']);
  });

  it('treats a stream that ends without a terminal event as a failure', async () => {
    const { backend } = stubBackend([{ type: 'generation.delta', text: 'partial' }]);
    const { handlers, calls } = recordingHandlers();

    await streamWireGeneration(
      backend,
      CHAT_ID,
      { userMessage: 'Hello' },
      handlers,
      new AbortController().signal,
    );

    expect(calls).toEqual(['start', 'delta', 'error']);
  });

  it('does not surface an error after a user-initiated abort', async () => {
    const { backend } = stubBackend([]);
    const { handlers, calls } = recordingHandlers();
    const controller = new AbortController();
    controller.abort();

    await streamWireGeneration(
      backend,
      CHAT_ID,
      { userMessage: 'Hello' },
      handlers,
      controller.signal,
    );

    expect(calls).toEqual(['start']);
  });

  it('rejects regeneration honestly instead of silently downgrading', async () => {
    const { backend, createMessage } = stubBackend([]);
    const { handlers } = recordingHandlers();

    await expect(
      streamWireGeneration(
        backend,
        CHAT_ID,
        { userMessage: 'Hello', regenerate: true },
        handlers,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty user message', async () => {
    const { backend, createMessage } = stubBackend([]);
    const { handlers } = recordingHandlers();

    await expect(
      streamWireGeneration(
        backend,
        CHAT_ID,
        { userMessage: '' },
        handlers,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('forwards durable generation.step announcements to onStep (tool lifecycle, М5 slice 41)', async () => {
    const { backend } = stubBackend([
      {
        type: 'generation.step',
        step: {
          stepId: '55667788-99aa-bbcc-ddeeff00112233',
          runId: RUN_ID,
          sequence: 0,
          type: 'provider_turn',
          status: 'completed',
          attempt: 1,
          idempotencyKey: 'turn-1',
          createdAt: '2026-06-01T12:00:02.000Z',
          updatedAt: '2026-06-01T12:00:02.000Z',
        },
      },
      {
        type: 'generation.step',
        step: {
          stepId: '66778899-aabb-ccdd-eeff0011223344',
          runId: RUN_ID,
          sequence: 1,
          type: 'tool_call',
          status: 'waiting',
          attempt: 1,
          idempotencyKey: 'tool-call-1',
          input: {
            toolCall: {
              id: '123e4567-e89b-42d3-a456-426614174000',
              name: 'search_lorebook',
              arguments: {},
            },
          },
          createdAt: '2026-06-01T12:00:02.500Z',
          updatedAt: '2026-06-01T12:00:02.500Z',
        },
      },
      { type: 'generation.delta', text: 'Found it: ' },
      {
        type: 'generation.completed',
        finalMessage: {
          id: '33445566-7788-99aa-bbcc-ddeeff001122',
          chatId: CHAT_ID,
          role: 'assistant',
          content: 'Found it: done.',
          createdAt: '2026-06-01T12:00:05.000Z',
          sequence: 4,
          meta: {},
        },
      },
    ]);
    const { handlers, calls, steps } = recordingHandlers();

    await streamWireGeneration(
      backend,
      CHAT_ID,
      { userMessage: 'Search now' },
      handlers,
      new AbortController().signal,
    );

    expect(calls).toEqual([
      'start',
      'step:provider_turn:completed',
      'step:tool_call:waiting',
      'delta',
      'done',
    ]);
    expect(steps[1]).toMatchObject({
      type: 'tool_call',
      status: 'waiting',
      input: { toolCall: { name: 'search_lorebook' } },
    });
  });
});
