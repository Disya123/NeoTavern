/**
 * Bounded HTTPS download to disk, shared by the Git plugin source and the
 * dependency installer. Writes atomically (temp file + rename, mode 0o600),
 * enforces a byte cap, refuses non-HTTPS URLs and honors cancellation.
 */
import { open, rename, rm } from 'node:fs/promises';
import { randomToken, AppError, ErrorCodes } from '@neotavern/shared';

export interface HttpDownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overall deadline; defaults to 120s. */
  timeoutMs?: number;
}

/** Error factory so callers can attach domain-specific codes/params. */
export type DownloadErrorFactory = (reason: string, cause?: unknown) => AppError;

const defaultError = (reason: string, cause?: unknown): AppError =>
  new AppError({
    code: ErrorCodes.BAD_REQUEST,
    params: { reason },
    message: `Download failed: ${reason}`,
    cause,
  });

/**
 * Persist an already-obtained response body to `destination` (atomic temp +
 * rename). Runs the optional `verify` hook on the temp file before renaming,
 * so callers can reject bad content without ever exposing the final path.
 */
export async function writeResponseToDisk(
  response: Response,
  destination: string,
  options: Pick<HttpDownloadOptions, 'maxBytes' | 'signal'>,
  makeError: DownloadErrorFactory = defaultError,
  verify?: (tempPath: string) => Promise<void>,
): Promise<void> {
  if (!response.ok) throw makeError(`HTTP_${response.status}`);
  if (!response.body) throw makeError('EMPTY_RESPONSE');

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw makeError('TOO_LARGE');
  }

  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const temporary = `${destination}.partial-${randomToken(8)}`;
  try {
    await streamBodyToFile(response.body, temporary, options.maxBytes, signal, makeError);
    if (verify) await verify(temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/**
 * Download `url` straight to `destination`. The URL must be HTTPS; redirects
 * are followed by fetch itself. Callers that need per-hop validation (the Git
 * archive source) drive `writeResponseToDisk` themselves instead.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: HttpDownloadOptions,
  makeError: DownloadErrorFactory = defaultError,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw makeError('URL_MALFORMED');
  }
  if (parsed.protocol !== 'https:') throw makeError('URL_INSECURE');

  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 120_000);

  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal });
  } catch (cause) {
    if (signal.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
    throw makeError('FETCH_FAILED', cause);
  }

  await writeResponseToDisk(
    response,
    destination,
    { maxBytes: options.maxBytes, signal },
    makeError,
  );
}

async function streamBodyToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  makeError: DownloadErrorFactory,
): Promise<void> {
  const reader = body.getReader();
  const handle = await open(path, 'wx', 0o600);
  let received = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw makeError('TOO_LARGE');
      await handle.write(value);
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}
