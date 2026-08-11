/**
 * Git repository sources for plugin installation (ТЗ plugin install v1).
 *
 * Plugins are installed from a repository archive downloaded over HTTPS —
 * the server never shells out to a `git` binary (AGENTS.md §4, §21: no
 * mandatory external processes). Supported hosts: GitHub and GitLab.
 *
 * Supply-chain notes:
 * - only `https:` URLs are accepted, for the request and every redirect;
 * - redirects are followed manually (≤5) so each hop is validated;
 * - the download size is bounded and the result must be gzip.
 */
import { open } from 'node:fs/promises';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { writeResponseToDisk } from '../lib/httpDownload.js';

/** Hosts that can serve repository archives without a git binary. */
export type GitHost = 'github.com' | 'gitlab.com';

export interface GitRepoRef {
  host: GitHost;
  owner: string;
  repo: string;
  /** Branch/tag/commit; undefined = the host default branch. */
  ref?: string;
}

export const GIT_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const GIT_ARCHIVE_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
/** git-ref characters that survive URL path encoding. */
const SAFE_REF_PATTERN = /^[\w./-]+$/u;
const MAX_REF_LENGTH = 200;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function sourceUnsupported(reason: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_SOURCE_UNSUPPORTED,
    params: { reason },
    message: `Unsupported plugin git source: ${reason}`,
  });
}

function sourceInvalid(reason: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_SOURCE_INVALID,
    params: { reason },
    message: `Invalid plugin git source: ${reason}`,
  });
}

/**
 * Parse a repository URL the user may paste into the plugin manager.
 *
 * Accepts `https://{github.com|gitlab.com}/{owner}/{repo}` with an optional
 * `.git` suffix, trailing slash and `/tree/{ref}` path. Everything else
 * (other hosts, SSH, plain http, malformed shapes) is rejected.
 */
export function parseGitRepoUrl(input: string): GitRepoRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw sourceInvalid('REPO_URL_REQUIRED');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw sourceInvalid('REPO_URL_MALFORMED');
  }

  if (url.protocol !== 'https:') {
    throw url.protocol === 'http:'
      ? sourceInvalid('REPO_URL_INSECURE')
      : sourceUnsupported('REPO_URL_SCHEME');
  }

  const host = normalizeHost(url.hostname);
  if (!host) throw sourceUnsupported('REPO_HOST');

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) throw sourceInvalid('REPO_PATH_INCOMPLETE');

  const owner = decodeURIComponent(segments[0] ?? '');
  let repo = decodeURIComponent(segments[1] ?? '');
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    throw sourceInvalid('REPO_PATH_INVALID');
  }

  const ref = extractRef(segments.slice(2));
  if (ref !== undefined && !isValidRef(ref)) throw sourceInvalid('REPO_REF_INVALID');

  return ref === undefined ? { host, owner, repo } : { host, owner, repo, ref };
}

function normalizeHost(hostname: string): GitHost | null {
  const lowered = hostname.toLowerCase();
  const bare = lowered.startsWith('www.') ? lowered.slice(4) : lowered;
  return bare === 'github.com' || bare === 'gitlab.com' ? bare : null;
}

function isValidRepoSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 200 && /^[\w.-]+$/u.test(segment);
}

/** `/tree/{ref...}` carries an explicit ref; anything else is rejected. */
function extractRef(rest: readonly string[]): string | undefined {
  if (rest.length === 0) return undefined;
  const [kind, ...refSegments] = rest;
  if (kind === 'tree' && refSegments.length > 0) {
    return refSegments.map((segment) => decodeURIComponent(segment)).join('/');
  }
  throw sourceUnsupported('REPO_URL_SHAPE');
}

function isValidRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= MAX_REF_LENGTH && SAFE_REF_PATTERN.test(ref);
}

/** Encode a ref for use inside a URL path (slashes become %2F). */
function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

/**
 * Build the HTTPS archive download URL for a parsed repository.
 * GitHub serves `HEAD` (default branch) via codeload; GitLab's archive API
 * requires an explicit ref.
 */
export function buildArchiveUrl(repo: GitRepoRef): string {
  const owner = encodeURIComponent(repo.owner);
  const repository = encodeURIComponent(repo.repo);
  if (repo.host === 'github.com') {
    const ref = repo.ref ? encodeRef(repo.ref) : 'HEAD';
    return `https://codeload.github.com/${owner}/${repository}/tar.gz/${ref}`;
  }
  if (!repo.ref) throw sourceInvalid('GITLAB_REF_REQUIRED');
  const ref = encodeRef(repo.ref);
  // GitLab requires the trailing file name to follow `{repo}-{ref}.tar.gz`
  // with slashes in the ref replaced by dashes.
  const fileName = `${repo.repo}-${repo.ref.replaceAll('/', '-')}.tar.gz`;
  return `https://gitlab.com/${owner}/${repository}/-/archive/${ref}/${encodeURIComponent(fileName)}`;
}

export interface DownloadRepoArchiveOptions {
  /** Total download cap; defaults to {@link GIT_ARCHIVE_MAX_BYTES}. */
  maxBytes?: number;
  /** Caller cancellation; combined with the built-in 120s timeout. */
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Download a repository archive to `archivePath` (atomic temp + rename).
 * Enforces HTTPS on the request and every redirect, caps redirects and
 * bytes, and verifies the gzip magic before returning.
 */
export async function downloadRepoArchive(
  archiveUrl: string,
  archivePath: string,
  options: DownloadRepoArchiveOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? GIT_ARCHIVE_MAX_BYTES;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(GIT_ARCHIVE_TIMEOUT_MS)])
    : AbortSignal.timeout(GIT_ARCHIVE_TIMEOUT_MS);

  const response = await fetchFollowingRedirects(fetchImpl, archiveUrl, signal);
  await writeResponseToDisk(
    response,
    archivePath,
    { maxBytes, signal },
    archiveDownloadError,
    assertGzipMagic,
  );
}

/** Map generic download failure reasons onto plugin-source error codes. */
function archiveDownloadError(reason: string): AppError {
  if (reason.startsWith('HTTP_')) {
    const status = Number(reason.slice(5));
    return new AppError({
      code: ErrorCodes.PLUGIN_SOURCE_INVALID,
      params: { reason: 'REPO_ARCHIVE_UNAVAILABLE', status },
      message: `Invalid plugin git source: REPO_ARCHIVE_UNAVAILABLE (status ${status})`,
    });
  }
  if (reason === 'TOO_LARGE') return sourceInvalid('REPO_ARCHIVE_TOO_LARGE');
  if (reason === 'EMPTY_RESPONSE') return sourceInvalid('REPO_EMPTY_RESPONSE');
  return sourceInvalid(`REPO_${reason}`);
}

/**
 * Fetch with manual redirect handling: every hop is validated as HTTPS and
 * the hop count is capped. Returns the first non-redirect response.
 */
async function fetchFollowingRedirects(
  fetchImpl: FetchLike,
  archiveUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = assertHttpsUrl(archiveUrl);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, { redirect: 'manual', signal });
    } catch (cause) {
      if (signal.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
      throw new AppError({
        code: ErrorCodes.PLUGIN_SOURCE_INVALID,
        params: { reason: 'REPO_FETCH_FAILED' },
        cause,
      });
    }

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw sourceInvalid('REPO_BAD_REDIRECT');
    if (hop >= MAX_REDIRECTS) throw sourceInvalid('REPO_TOO_MANY_REDIRECTS');
    currentUrl = assertHttpsUrl(new URL(location, currentUrl).toString());
  }
}

function assertHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw sourceInvalid('REPO_URL_MALFORMED');
  }
  if (url.protocol !== 'https:') throw sourceInvalid('REPO_URL_INSECURE');
  return url.toString();
}

async function assertGzipMagic(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      throw sourceInvalid('REPO_NOT_GZIP');
    }
  } finally {
    await handle.close();
  }
}
