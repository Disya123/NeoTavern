/**
 * Streaming generation client (SSE). Parses the event stream and forwards
 * deltas to the caller, which batches UI updates via requestAnimationFrame
 * (AGENTS.md §13: no per-token React render).
 */
import type { GenerationEvent, PromptTriggerId } from '@neotavern/contracts';
import { ErrorCodes } from '@neotavern/shared';
import { runLegacyPromptInterceptors } from '@neotavern/legacy-compat';
import { legacyRaw } from './backend.js';
import { getCsrfToken, setCsrfToken } from './client.js';
import { frontendPluginRuntime } from '../plugins/runtime.js';

export interface GenerateHandlers {
  onStart?: (requestId: string) => void;
  onDelta: (text: string) => void;
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
