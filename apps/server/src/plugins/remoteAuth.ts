/**
 * Explicit remote-mode authentication.
 *
 * Local loopback mode remains frictionless. Remote mode uses a bootstrap token
 * only to mint a bounded server-side session. The browser receives an opaque
 * HttpOnly cookie and keeps the synchronized CSRF token in memory.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AuthLoginSchema, AuthSessionSchema, type AuthSession } from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';
import { isLoopbackHost, type ServerConfig } from '../config.js';
import type { TypedApp } from '../types.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 128;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 5;
const MAX_FAILURE_BUCKETS = 256;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_API_PATHS = new Set(['/api/v2/health', '/api/v2/version', '/api/v2/auth/session']);

interface SessionRecord {
  id: string;
  csrfToken: string;
  expiresAt: number;
  createdAt: number;
}

interface FailureBucket {
  count: number;
  expiresAt: number;
}

class RemoteSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly failures = new Map<string, FailureBucket>();
  readonly metrics = { hits: 0, misses: 0 };

  constructor(private readonly tokenHash: string) {}

  create(): SessionRecord {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const now = Date.now();
    const session: SessionRecord = {
      id: randomBytes(32).toString('base64url'),
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): SessionRecord | null {
    if (!id) {
      this.metrics.misses += 1;
      return null;
    }
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(id);
      this.metrics.misses += 1;
      return null;
    }
    this.metrics.hits += 1;
    return session;
  }

  delete(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  tokenMatches(candidate: string): boolean {
    const actual = createHash('sha256').update(candidate).digest();
    const expected = Buffer.from(this.tokenHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  assertLoginAllowed(key: string): void {
    this.sweep();
    const bucket = this.failures.get(key);
    if (bucket && bucket.count >= MAX_FAILURES_PER_WINDOW) {
      throw new AppError({
        code: ErrorCodes.RATE_LIMITED,
        params: {
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - Date.now()) / 1000)),
        },
      });
    }
  }

  recordFailure(key: string): void {
    this.sweep();
    const now = Date.now();
    const current = this.failures.get(key);
    if (current && current.expiresAt > now) {
      current.count += 1;
      return;
    }
    while (this.failures.size >= MAX_FAILURE_BUCKETS) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.failures.delete(oldest);
    }
    this.failures.set(key, { count: 1, expiresAt: now + FAILURE_WINDOW_MS });
  }

  clearFailures(key: string): void {
    this.failures.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [key, bucket] of this.failures) {
      if (bucket.expiresAt <= now) this.failures.delete(key);
    }
  }
}

/** Register public session routes and the global remote API guard. */
export async function registerRemoteAuth(app: TypedApp, config: ServerConfig): Promise<void> {
  const expectedOrigin = new URL(config.publicOrigin).origin;
  const cookieName = config.secureSessionCookies ? '__Host-neotavern_session' : 'neotavern_session';
  const store = config.remoteTokenHash ? new RemoteSessionStore(config.remoteTokenHash) : null;

  const sessionFromRequest = (request: FastifyRequest): SessionRecord | null =>
    store?.get(parseCookies(request.headers.cookie)[cookieName]) ?? null;

  app.get(
    '/api/v2/auth/session',
    { schema: { response: { 200: AuthSessionSchema } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!config.remoteAccess || !store) {
        return { required: false, authenticated: true };
      }
      const session = sessionFromRequest(request);
      return sessionResponse(true, session);
    },
  );

  app.post(
    '/api/v2/auth/session',
    {
      schema: {
        body: AuthLoginSchema,
        response: { 200: AuthSessionSchema },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!config.remoteAccess || !store) {
        throw new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'REMOTE_ACCESS_DISABLED' },
        });
      }
      assertTrustedOrigin(request, expectedOrigin);
      store.assertLoginAllowed(request.ip);
      if (!store.tokenMatches(request.body.token)) {
        store.recordFailure(request.ip);
        throw new AppError({
          code: ErrorCodes.UNAUTHORIZED,
          params: { reason: 'INVALID_ACCESS_TOKEN' },
        });
      }
      store.clearFailures(request.ip);
      const session = store.create();
      reply.header(
        'Set-Cookie',
        serializeSessionCookie(cookieName, session.id, config.secureSessionCookies),
      );
      return sessionResponse(true, session);
    },
  );

  app.delete(
    '/api/v2/auth/session',
    { schema: { response: { 200: AuthSessionSchema } } },
    async (request, reply) => {
      const sessionId = parseCookies(request.headers.cookie)[cookieName];
      if (config.remoteAccess) {
        const session = store?.get(sessionId) ?? null;
        if (!session) {
          throw new AppError({
            code: ErrorCodes.UNAUTHORIZED,
            params: { reason: 'AUTHENTICATION_REQUIRED' },
          });
        }
        assertTrustedOrigin(request, expectedOrigin);
        const csrf = request.headers['x-csrf-token'];
        if (typeof csrf !== 'string' || !constantTimeTextEqual(csrf, session.csrfToken)) {
          throw new AppError({
            code: ErrorCodes.FORBIDDEN,
            params: { reason: 'CSRF_TOKEN_INVALID' },
          });
        }
      }
      store?.delete(sessionId);
      reply.header('Set-Cookie', clearSessionCookie(cookieName, config.secureSessionCookies));
      reply.header('Cache-Control', 'no-store');
      reply.header('Clear-Site-Data', '"cache", "cookies", "storage"');
      return { required: config.remoteAccess, authenticated: !config.remoteAccess };
    },
  );

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;

    // Origin validation for state-changing requests in ALL modes (ТЗ §13).
    // Browsers always send Origin on cross-origin POST/PATCH/DELETE; a present
    // but untrusted Origin means a CSRF/DNS-rebinding attempt. An absent Origin
    // means a non-browser client (curl, CLI) — those are loopback-only unless
    // remote access is explicitly enabled (enforced below / by the bind host).
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== undefined) {
      assertTrustedOrigin(request, expectedOrigin);
    }

    if (!config.remoteAccess) return;
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (PUBLIC_API_PATHS.has(path)) {
      if (request.method === 'POST') assertTrustedOrigin(request, expectedOrigin);
      return;
    }

    const bearer = bearerToken(request.headers.authorization);
    if (bearer && store?.tokenMatches(bearer)) return;

    const session = sessionFromRequest(request);
    if (!session) {
      throw new AppError({
        code: ErrorCodes.UNAUTHORIZED,
        params: { reason: 'AUTHENTICATION_REQUIRED' },
      });
    }
    if (!SAFE_METHODS.has(request.method)) {
      assertTrustedOrigin(request, expectedOrigin);
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !constantTimeTextEqual(csrf, session.csrfToken)) {
        throw new AppError({
          code: ErrorCodes.FORBIDDEN,
          params: { reason: 'CSRF_TOKEN_INVALID' },
        });
      }
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // API responses are dynamic — no-store unless the route explicitly opted
    // into caching (content-addressed assets set `immutable`, ТЗ §11.4;
    // blanketing those here used to defeat browser asset caching entirely).
    if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}

function sessionResponse(required: boolean, session: SessionRecord | null): AuthSession {
  return session
    ? {
        required,
        authenticated: true,
        expiresAt: session.expiresAt,
        csrfToken: session.csrfToken,
      }
    : { required, authenticated: false };
}

export function isTrustedOrigin(origin: string, expectedOrigin: string): boolean {
  if (origin === expectedOrigin) return true;
  try {
    const o = new URL(origin);
    const e = new URL(expectedOrigin);
    return (
      o.protocol === e.protocol &&
      o.port === e.port &&
      isLoopbackHost(o.hostname) &&
      isLoopbackHost(e.hostname)
    );
  } catch {
    return false;
  }
}

function assertTrustedOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (!origin || !isTrustedOrigin(origin, expectedOrigin)) {
    throw new AppError({
      code: ErrorCodes.FORBIDDEN,
      params: { reason: 'ORIGIN_NOT_ALLOWED' },
    });
  }
}

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) continue;
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      // Ignore malformed cookies instead of accepting an ambiguous value.
    }
  }
  return result;
}

function serializeSessionCookie(name: string, value: string, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function clearSessionCookie(name: string, secure: boolean): string {
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
