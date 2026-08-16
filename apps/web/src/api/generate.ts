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
 * - **Legacy mode** (browser/sidecar, `LegacyBackend`): the existing SSE
 *   rendezvous (`POST /api/v2/chats/:id/generate`) persists the user message
 *   server-side and supports `plugin_intercept` prompt interceptors.
 *
 * The transport branch lives here in the API layer — React components never
 * branch on the backend kind. Legacy-only options (regeneration, prompt
 * interceptors) are not silently downgraded on the kernel: they surface an
 * honest `UnsupportedError` instead.
 */
import type { GenerationEvent, GenerationStepDto, PromptTriggerId } from '@neotavern/contracts';
import type { NeoBackend } from '@neotavern/neobackend';
import { UnsupportedError } from '@neotavern/neobackend';
import { ErrorCodes } from '@neotavern/shared';
import { runLegacyPromptInterceptors } from '@neotavern/legacy-compat';
import { ApiError } from './client.js';
import { backend, isKernelMode, legacyRaw } from './backend.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';

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
  if (isKernelMode()) {
    await streamWireGeneration(backend, chatId, body, handlers, signal);
    return;
  }
  await streamLegacyGeneration(chatId, body, handlers, signal);
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

/**
 * Legacy SSE generation (`POST /api/v2/chats/:id/generate`). Parses the
 * event stream and forwards deltas to the caller, which batches UI updates
 * via requestAnimationFrame (AGENTS.md §13: no per-token React render).
 */
async function streamLegacyGeneration(
  chatId: string,
  body: GenerateBody,
  handlers: GenerateHandlers,
  signal: AbortSignal,
): Promise<void> {
  const csrfToken = getCsrfToken();
  const response = await fetch(legacyRaw().sseUrl(`/chats/${chatId}/generate`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });

  if (!response.ok || !response.body) {
    // The endpoint answers plain JSON (error envelope) when the request fails
    // before streaming starts — e.g. REGENERATE_TARGET_MOVED (409).
    let code = 'GENERATION_FAILED';
    let message = `HTTP ${response.status}`;
    try {
      const envelope = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof envelope.code === 'string') code = envelope.code;
      if (typeof envelope.message === 'string' && envelope.message.length > 0) {
        message = envelope.message;
      }
    } catch {
      // Not JSON — keep the HTTP fallback.
    }
    if (response.status === 401) {
      setCsrfToken(null);
      window.dispatchEvent(new Event('neotavern-auth-required'));
    }
    handlers.onError(code, message);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminalEvent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload.length === 0) continue;

      let event: GenerationEvent;
      try {
        event = JSON.parse(payload) as GenerationEvent;
      } catch {
        continue;
      }
      if (event.type === 'plugin_intercept') {
        const context = await frontendPluginRuntime.runPromptInterceptors({
          chatId: event.chatId,
          messages: event.messages,
          meta: event.meta,
        });
        // Legacy prompt interceptors (ТЗ §8.1) run after sandboxed plugin
        // interceptors, on the same broker round-trip.
        const legacyMessages = await runLegacyPromptInterceptors(
          context.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
          })),
        );
        context.messages = legacyMessages.map((message) => ({
          role: message.role as (typeof context.messages)[number]['role'],
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        }));
        const interceptorResponse = await fetch(
          legacyRaw().sseUrl(`/plugin-intercepts/${encodeURIComponent(event.requestId)}`),
          {
            method: 'POST',
            headers: {
              ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            },
            body: JSON.stringify({
              responseToken: event.responseToken,
              messages: context.messages,
              meta: context.meta,
            }),
            signal,
            credentials: 'same-origin',
          },
        );
        if (!interceptorResponse.ok) {
          // The server broker expires a rendezvous (404) once it has moved on
          // without the intercepted prompt — the generation already continues
          // server-side. Throwing here would abort a stream the server
          // successfully finished (PLUG-53); one plugin's lateness must not
          // surface as a failed generation.
          continue;
        }
      } else if (event.type === 'start') handlers.onStart?.(event.requestId);
      else if (event.type === 'delta') handlers.onDelta(event.text);
      else if (event.type === 'done') {
        sawTerminalEvent = true;
        handlers.onDone(event.text);
      } else if (event.type === 'error') {
        sawTerminalEvent = true;
        handlers.onError(event.code, event.message);
      }
    }
  }

  // A connection that ends without a terminal event (dropped mid-stream,
  // server process killed) must not leave the caller stuck in the generating
  // state forever (ST1-race): surface it as a failure.
  if (!sawTerminalEvent) {
    handlers.onError(ErrorCodes.GENERATION_FAILED, 'Stream ended unexpectedly');
  }
}
