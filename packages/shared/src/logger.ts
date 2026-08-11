/**
 * Structured logger with automatic secret redaction.
 *
 * API keys, tokens, passwords and authorization headers must never reach logs
 * or diagnostic exports (AGENTS.md §4). Any object key whose name matches a
 * sensitive pattern is recursively replaced with a redaction marker. Secret
 * material embedded in free-form strings is redacted as well: provider and
 * plugin errors frequently contain request URLs or authorization values where
 * there is no object key to inspect.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys whose values are always redacted in logs and diagnostics. */
const SENSITIVE_KEY_RE =
  /(api[_-]?key|apikey|secret|token|password|passwd|authorization|auth|credential|private[_-]?key|access[_-]?key|session|cookie)/i;

const REDACTED = '[REDACTED]';

const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]{4,}/gi;
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|authorization|credential|private[_-]?key|access[_-]?key)\b(\s*[:=]\s*)(?!Bearer\b|Basic\b)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PROVIDER_KEY_RE =
  /\b(?:sk(?:-[a-z0-9]+)*|rk|pk|gh[pousr]|xox[aboprs]|AIza)[-_][A-Za-z0-9_-]{6,}\b/gi;
const URL_USER_INFO_RE = /\b(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/**
 * Redact credentials embedded in an otherwise unstructured string.
 *
 * This is a last line of defence for third-party error messages and plugin
 * output; callers should still prefer structured metadata with secret-bearing
 * fields named explicitly.
 */
export function redactSecretText(value: string): string {
  return value
    .replace(URL_USER_INFO_RE, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_VALUE_RE, `$1 ${REDACTED}`)
    .replace(
      SECRET_ASSIGNMENT_RE,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
    .replace(PROVIDER_KEY_RE, REDACTED);
}

/**
 * Recursively redact sensitive keys from a value for safe logging. Returns a
 * new structure; the input is not mutated. Depth-bounded to avoid pathological
 * cycles/perf on huge objects.
 */
export function redactSecrets<T>(value: T, maxDepth = 6): T {
  return redactInner(value, 0, maxDepth) as T;
}

function redactInner(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactSecretText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretText(value.message),
      ...(value.stack ? { stack: redactSecretText(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, depth + 1, maxDepth));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactInner(val, depth + 1, maxDepth);
    }
  }
  return out;
}

export interface LogEntry {
  level: LogLevel;
  time: string;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Minimum level to emit (default: info). */
  level?: LogLevel;
  /** Named scope, e.g. "server:characters". */
  scope?: string;
  /** ISO timestamp provider; injectable for deterministic tests. */
  now?: () => string;
  /** Sink for serialized entries (default: console). */
  sink?: (line: string) => void;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Create a child logger with an appended scope. */
  child(scope: string): Logger;
}

/** Create a structured logger that redacts secrets before emitting. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = options.level ?? 'info';
  const scope = options.scope ?? 'app';
  const now = options.now ?? ((): string => new Date().toISOString());
  const sink = options.sink ?? ((line: string): void => console.log(line));

  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const entry: LogEntry = {
      level,
      time: now(),
      scope,
      message: redactSecretText(message),
    };
    if (meta) {
      entry.meta = redactSecrets(meta);
    }
    sink(JSON.stringify(entry));
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (childScope) =>
      createLogger({
        level: minLevel,
        scope: `${scope}:${childScope}`,
        now,
        sink,
      }),
  };
}
