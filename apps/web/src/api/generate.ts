/**
 * Streaming generation client.
 *
 * Two transports share one handler surface (ТЗ §13.1, Этап 2.10):
 *
 * - **Kernel mode** (desktop, `LocalBackend`): the user message is persisted
 *   durably via `chats.messages.create`, then `generation.start` streams
 *   canonical wire events (`generation.delta` / `generation.completed` /
 *   `generation.failed` / `generation.cancelled`). The transport never
 *   touches `/api/v2`.
 * There is no second transport: the legacy SSE rendezvous belonged to the Fastify
 * contour and was deleted with it (round 60b).
 *
 * The transport branch lives here in the API layer — React components never
 * branch on the backend kind. Legacy-only options (regeneration, prompt
 * interceptors) are not silently downgraded on the kernel: they surface an
 * honest `UnsupportedError` instead.
 */
import type { GenerationStepDto, PromptTriggerId } from '@neotavern/contracts';
import type { NeoBackend } from '@neotavern/neobackend';
import { UnsupportedError } from '@neotavern/neobackend';
import { ErrorCodes } from '@neotavern/shared';
import { backend } from './backend.js';
import { ApiError } from './client.js';

export interface GenerateHandlers {
  onStart?: (requestId: string) => void;
  onDelta: (text: string) => void;
  /** Durable step announcement (`generation.step`, ТЗ §13.2): lets the UI
   * distinguish streaming from tool execution / waiting-for-tool. */
  onStep?: (step: GenerationStepDto) => void;
  onDone: (fullText: string) => void;
  onError: (code: string, message: string) => void;
}

export interface GenerateBody {
  userMessage?: string;
  regenerate?: boolean;
  /** Rewrite this message in place (the server validates it is still the last assistant message). */
  regenerateMessageId?: string;
  generationType?: PromptTriggerId;
  providerConfigId?: string;
  frontendInterceptors?: boolean;
}

export async function streamGeneration(
  chatId: string,
  body: GenerateBody,
  handlers: GenerateHandlers,
  signal: AbortSignal,
): Promise<void> {
  // The kernel plane is the only transport: the legacy SSE rendezvous was deleted
  // with the Fastify contour (round 60b). Legacy-only options (regenerate, prompt
  // interceptors) surface an honest UnsupportedError inside the wire path rather
  // than silently downgrading.
  await streamWireGeneration(backend, chatId, body, handlers, signal);
}

/**
 * Kernel-mode generation over the Product Wire (Этап 2.10).
 *
 * Persists the user message first (the kernel does not create it during
 * `generation.start`), then streams the canonical wire events. Product
 * failures arrive as `generation.failed` with a stable machine-readable
 * code; a stream that ends without a terminal event is surfaced as a
 * failure, mirroring the legacy SSE path (ST1-race).
 *
 * Not supported on the kernel yet — honest errors, no silent downgrade:
 * - regeneration (`regenerate` / `regenerateMessageId`) is Этап 4 (variants);
 * - frontend prompt interceptors have no kernel rendezvous yet (the kernel
 *   prompt pipeline is the single prompt owner; see release-manifest notes);
 * - `providerConfigId` selects the kernel-side provider config (М5 slice 48):
 *   the wire id is resolved through `providers.config.list` into the
 *   `provider`/`model` pair handed to `generation.start` — a missing config
 *   is an honest `PROVIDER_CONFIG_NOT_FOUND`, never a silent fallback; when
 *   no config id is supplied the kernel selects its own provider/model.
 *
 * @param backendImpl Injectable backend for tests.
 */
export async function streamWireGeneration(
  backendImpl: NeoBackend,
  chatId: string,
  body: GenerateBody,
  handlers: GenerateHandlers,
  signal: AbortSignal,
): Promise<void> {
  if (body.regenerate || body.regenerateMessageId) {
    throw new UnsupportedError('generation.regenerate');
  }
  const userMessage = body.userMessage;
  if (userMessage === undefined || userMessage.length === 0) {
    throw new UnsupportedError('generation.emptyMessage');
  }

  await backendImpl.chats.createMessage({ chatId, role: 'user', content: userMessage }, { signal });
  handlers.onStart?.('wire');

  // М5 slice 48: when the caller selected a provider config, resolve the wire
  // config id into the provider/model pair for `generation.start`. A config
  // that disappeared is an honest error — never a silent fake fallback.
  const startRequest: { chatId: string; message: string; provider?: string; model?: string } = {
    chatId,
    message: userMessage,
  };
  if (body.providerConfigId !== undefined) {
    const { items } = await backendImpl.providers.config.list({}, { signal });
    const config = items.find((item) => item.id === body.providerConfigId);
    if (!config) {
      throw new ApiError({
        code: 'PROVIDER_CONFIG_NOT_FOUND',
        params: { id: body.providerConfigId },
      });
    }
    startRequest.provider = config.provider;
    const configBlob = config.config as unknown as Record<string, unknown>;
    const model = typeof configBlob['model'] === 'string' ? configBlob['model'] : undefined;
    if (model !== undefined) startRequest.model = model;
  }

  const stream = backendImpl.generation.start(startRequest, { signal });

  let sawTerminalEvent = false;
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'generation.delta':
          handlers.onDelta(event.text);
          break;
        case 'generation.completed':
          sawTerminalEvent = true;
          handlers.onDone(event.finalMessage.content);
          break;
        case 'generation.failed':
          sawTerminalEvent = true;
          handlers.onError(event.error.code, formatProductError(event.error));
          break;
        case 'generation.cancelled':
          sawTerminalEvent = true;
          if (!signal.aborted) {
            handlers.onError(ErrorCodes.GENERATION_CANCELLED, 'Generation cancelled');
          }
          break;
        case 'generation.step':
          // Durable step announcements: provider turns, tool calls and tool
          // results (§8.3). The UI keeps batching text deltas; step data
          // drives the tool-execution indicator (ТЗ §13.2).
          handlers.onStep?.(event.step);
          break;
        case 'generation.checkpoint':
        case 'consumer_lagged':
          // Checkpoint announcements / consumer lag — the UI batches text
          // deltas only.
          break;
      }
    }
  } catch (err) {
    if (signal.aborted) {
      // User-initiated stop: the transport aborted the durable run; the
      // caller already reset its streaming state.
      return;
    }
    throw err;
  }

  if (!sawTerminalEvent && !signal.aborted) {
    handlers.onError(ErrorCodes.GENERATION_FAILED, 'Stream ended unexpectedly');
  }
}

/** Short stable message from a wire `ProductErrorDto` (`code key=value …`). */
function formatProductError(error: { code: string; params?: Record<string, unknown> }): string {
  const params = Object.entries(error.params ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return params.length > 0 ? `${error.code} ${params}` : error.code;
}
