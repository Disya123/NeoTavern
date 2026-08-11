/**
 * API client. All calls go to /api/v2. Errors arrive as `{ code, params,
 * traceId }` envelopes and are surfaced as {@link ApiError}; the UI localizes
 * the code (AGENTS.md §16).
 */
import type { ErrorEnvelope } from '@neotavern/contracts';
import { ErrorCodes } from '@neotavern/shared';

export class ApiError extends Error {
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly traceId?: string;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.params = envelope.params ?? {};
    this.traceId = envelope.traceId;
  }
}

export class ApiNetworkError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('API_NETWORK_ERROR');
    this.name = 'ApiNetworkError';
    this.cause = cause;
  }
}

const BASE = '/api/v2';
let csrfToken: string | null = null;

export function setCsrfToken(value: string | null): void {
  csrfToken = value;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

async function fetchApi(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiNetworkError(error);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchApi(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken
        ? { 'X-CSRF-Token': csrfToken }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let envelope: ErrorEnvelope;
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      envelope = { code: ErrorCodes.INTERNAL };
    }
    const error = new ApiError(envelope);
    if (error.code === ErrorCodes.UNAUTHORIZED) {
      setCsrfToken(null);
      globalThis.dispatchEvent?.(new Event('neotavern-auth-required'));
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function upload<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetchApi(`${BASE}${path}`, {
    method: 'POST',
    body,
    signal,
    credentials: 'same-origin',
    headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : undefined,
  });
  if (!response.ok) {
    let envelope: ErrorEnvelope;
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      envelope = { code: ErrorCodes.INTERNAL };
    }
    const error = new ApiError(envelope);
    if (error.code === ErrorCodes.UNAUTHORIZED) {
      setCsrfToken(null);
      globalThis.dispatchEvent?.(new Event('neotavern-auth-required'));
    }
    throw error;
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>('POST', path, body, signal),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
  upload: <T>(path: string, file: File, signal?: AbortSignal): Promise<T> =>
    upload<T>(path, file, signal),
};

/** Build a full URL for an SSE endpoint (used with fetch streaming). */
export function sseUrl(path: string): string {
  return `${BASE}${path}`;
}
