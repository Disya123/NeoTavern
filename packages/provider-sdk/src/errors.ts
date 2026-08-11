/**
 * Provider error normalization (ТЗ §4.3). Provider failures are mapped to
 * stable {@link AppError} codes so the pipeline and UI can react consistently.
 * Upstream HTTP statuses are differentiated (auth vs rate-limit vs bad model
 * vs server error); raw upstream bodies are never forwarded to clients — only
 * a parsed, capped `error.message` when the provider sent structured JSON.
 */
import { AppError, ErrorCodes, isAppError, type ErrorCode } from '@neotavern/shared';

function isAbortError(value: unknown): boolean {
  return (
    (value instanceof Error && value.name === 'AbortError') ||
    (typeof value === 'object' && value !== null && 'type' in value && value.type === 'abort')
  );
}

/** Normalize any provider/network error into a stable AppError. */
export function normalizeProviderError(value: unknown, context = 'generation'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error && value.name === 'TimeoutError') {
    return new AppError({
      code: ErrorCodes.TIMEOUT,
      message: `${context} timed out`,
      cause: value,
    });
  }
  if (isAbortError(value)) {
    return new AppError({
      code: ErrorCodes.GENERATION_CANCELLED,
      message: `${context} aborted`,
      cause: value,
    });
  }
  if (value instanceof TypeError) {
    // fetch throws TypeError on network failure / DNS / connection refused.
    return new AppError({
      code: ErrorCodes.GENERATION_FAILED,
      message: `Network error during ${context}`,
      cause: value,
    });
  }
  if (value instanceof Error) {
    return new AppError({
      code: ErrorCodes.GENERATION_FAILED,
      message: value.message,
      cause: value,
    });
  }
  return new AppError({
    code: ErrorCodes.GENERATION_FAILED,
    message: `Unknown provider error during ${context}`,
    cause: value,
  });
}

/**
 * Extract a short, client-safe detail from a provider error body. Only the
 * structured `error.message` (or top-level `message`) string is surfaced,
 * capped at 200 chars; anything else (HTML pages, stack traces, raw dumps)
 * is discarded so upstream text never reaches the client verbatim.
 */
export function parseProviderErrorDetail(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const candidate =
      typeof parsed?.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed?.message === 'string'
          ? parsed.message
          : null;
    if (!candidate) return null;
    const clean = candidate.replace(/\s+/g, ' ').trim();
    return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
  } catch {
    return null;
  }
}

/** Map an upstream HTTP status to a stable code (ТЗ §4.3 normalization). */
export function classifyHttpStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return ErrorCodes.UNAUTHORIZED;
  if (status === 404) return ErrorCodes.MODEL_NOT_FOUND;
  if (status === 408) return ErrorCodes.TIMEOUT;
  if (status === 429) return ErrorCodes.RATE_LIMITED;
  return ErrorCodes.GENERATION_FAILED;
}

/** Build a normalized AppError for a non-2xx provider response. */
export function httpProviderError(
  status: number,
  context: string,
  bodyText = '',
  params: Record<string, unknown> = {},
): AppError {
  const code = classifyHttpStatus(status);
  const detail = parseProviderErrorDetail(bodyText);
  const base =
    code === ErrorCodes.UNAUTHORIZED
      ? `Provider rejected authentication (HTTP ${status}) during ${context}`
      : code === ErrorCodes.RATE_LIMITED
        ? `Provider rate-limited the request (HTTP 429) during ${context}`
        : code === ErrorCodes.MODEL_NOT_FOUND
          ? `Provider does not serve the requested model or endpoint (HTTP 404) during ${context}`
          : code === ErrorCodes.TIMEOUT
            ? `Provider timed out (HTTP 408) during ${context}`
            : `Provider returned HTTP ${status} during ${context}`;
  return new AppError({
    code,
    params,
    message: detail ? `${base}: ${detail}` : base,
  });
}

export interface BaseUrlIssue {
  path: string;
  message: string;
}

/**
 * Shared http(s) baseUrl validation for adapters (single source instead of
 * four drifted copies). Embedded credentials (https://user:pass@host/) are
 * rejected: they leak into logs/errors and bypass the write-only secret
 * model (PROV-33 L8).
 */
export function validateHttpBaseUrl(
  baseUrl: string | null | undefined,
  options: { required: boolean },
): BaseUrlIssue[] {
  const issues: BaseUrlIssue[] = [];
  if (!baseUrl || baseUrl.trim().length === 0) {
    if (options.required) issues.push({ path: 'baseUrl', message: 'baseUrl is required' });
    return issues;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    issues.push({ path: 'baseUrl', message: 'baseUrl must start with http:// or https://' });
    return issues;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.username !== '' || parsed.password !== '') {
      issues.push({
        path: 'baseUrl',
        message: 'baseUrl must not embed credentials (userinfo)',
      });
    }
  } catch {
    issues.push({ path: 'baseUrl', message: 'baseUrl is not a valid URL' });
  }
  return issues;
}
