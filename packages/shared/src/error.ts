/**
 * Structured application errors.
 *
 * Errors cross the API boundary as a stable machine-readable `code` plus
 * `params` — never as a ready-made English string. The frontend localizes the
 * code (see AGENTS.md §5, ТЗ §4.2). Example wire format:
 *
 * ```json
 * { "code": "CHARACTER_NOT_FOUND", "params": { "characterId": "..." }, "traceId": "..." }
 * ```
 */

/**
 * The canonical set of error codes used across backend and frontend.
 *
 * Add new codes here (single source of truth). Codes are SCREAMING_SNAKE_CASE
 * and grouped by domain. Removing or renaming a code is a breaking change and
 * requires a migration guide.
 */
export const ErrorCodes = {
  // Generic
  INTERNAL: 'INTERNAL',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  VALIDATION: 'VALIDATION',

  // Characters
  CHARACTER_NOT_FOUND: 'CHARACTER_NOT_FOUND',
  CHARACTER_IMPORT_FAILED: 'CHARACTER_IMPORT_FAILED',
  CHARACTER_CARD_INVALID: 'CHARACTER_CARD_INVALID',

  // Chats / messages
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_CONFLICT: 'MESSAGE_CONFLICT',
  MESSAGE_REVISION_NOT_FOUND: 'MESSAGE_REVISION_NOT_FOUND',
  MESSAGE_DRAFT_NOT_FOUND: 'MESSAGE_DRAFT_NOT_FOUND',
  CHAT_BRANCH_NOT_FOUND: 'CHAT_BRANCH_NOT_FOUND',
  /** Regenerate target is no longer the newest assistant message in the branch. */
  REGENERATE_TARGET_MOVED: 'REGENERATE_TARGET_MOVED',

  // Personas
  PERSONA_NOT_FOUND: 'PERSONA_NOT_FOUND',

  // Lorebooks
  LOREBOOK_NOT_FOUND: 'LOREBOOK_NOT_FOUND',
  LORE_ENTRY_NOT_FOUND: 'LORE_ENTRY_NOT_FOUND',

  // Presets
  PRESET_NOT_FOUND: 'PRESET_NOT_FOUND',

  // Profiles
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_EXPORT_FAILED: 'PROFILE_EXPORT_FAILED',

  // Connection profiles
  CONNECTION_PROFILE_NOT_FOUND: 'CONNECTION_PROFILE_NOT_FOUND',
  CONNECTION_PROFILE_TARGET_REQUIRED: 'CONNECTION_PROFILE_TARGET_REQUIRED',
  CONNECTION_PROFILE_MODE_MISMATCH: 'CONNECTION_PROFILE_MODE_MISMATCH',
  CONNECTION_PROFILE_SOURCE_MISMATCH: 'CONNECTION_PROFILE_SOURCE_MISMATCH',
  CONNECTION_PROFILE_SECRET_INVALID: 'CONNECTION_PROFILE_SECRET_INVALID',
  CONNECTION_PROFILE_PREFILL_UNSUPPORTED: 'CONNECTION_PROFILE_PREFILL_UNSUPPORTED',

  // Providers / generation
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_CONFIG_INVALID: 'PROVIDER_CONFIG_INVALID',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  GENERATION_CANCELLED: 'GENERATION_CANCELLED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  TOKEN_BUDGET_EXCEEDED: 'TOKEN_BUDGET_EXCEEDED',

  // Provider secrets
  PROVIDER_SECRET_NOT_FOUND: 'PROVIDER_SECRET_NOT_FOUND',
  SECRETS_EXPOSURE_DISABLED: 'SECRETS_EXPOSURE_DISABLED',
  /** Secret exists but its backend cannot produce the value on this device
   * (machine-bound vault moved elsewhere, locked store, session ended). The
   * profile is intact — the user should re-enter the key (ТЗ §SEC-01.1). */
  SECRET_UNAVAILABLE_ON_THIS_DEVICE: 'SECRET_UNAVAILABLE_ON_THIS_DEVICE',
  /** The configured secret backend refuses writes (env store, locked). */
  SECRET_STORE_READ_ONLY: 'SECRET_STORE_READ_ONLY',

  // Plugins / themes
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_INVALID: 'PLUGIN_INVALID',
  PLUGIN_PERMISSION_DENIED: 'PLUGIN_PERMISSION_DENIED',
  PLUGIN_LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  PLUGIN_SOURCE_UNSUPPORTED: 'PLUGIN_SOURCE_UNSUPPORTED',
  PLUGIN_SOURCE_INVALID: 'PLUGIN_SOURCE_INVALID',
  PLUGIN_DEPS_UNSUPPORTED: 'PLUGIN_DEPS_UNSUPPORTED',
  PLUGIN_DEPS_CONFLICT: 'PLUGIN_DEPS_CONFLICT',
  PLUGIN_DEPS_FORBIDDEN_FILE: 'PLUGIN_DEPS_FORBIDDEN_FILE',
  PLUGIN_DEPS_FAILED: 'PLUGIN_DEPS_FAILED',
  /** Manifest `engines` range does not match the current host version (ТЗ §76). */
  ENGINE_MISMATCH: 'ENGINE_MISMATCH',
  /** Namespaced plugin state exceeds the kv quota (ТЗ §54). */
  STATE_QUOTA_EXCEEDED: 'STATE_QUOTA_EXCEEDED',
  /** Manifest apiVersion 3 requires the vNext runtime (Stage A integration). */
  PLUGIN_RUNTIME_UNAVAILABLE: 'PLUGIN_RUNTIME_UNAVAILABLE',
  /** The Plugin Runtime process died unexpectedly; workers are gone (§20.13). */
  PLUGIN_RUNTIME_CRASHED: 'PLUGIN_RUNTIME_CRASHED',
  /** Package signature/per-file digest verification failed (ТЗ §SEC-05). */
  PLUGIN_SIGNATURE_INVALID: 'PLUGIN_SIGNATURE_INVALID',
  /** Package is signed, but by a publisher outside the trusted keyring (ТЗ §SEC-05). */
  PLUGIN_SIGNATURE_UNTRUSTED: 'PLUGIN_SIGNATURE_UNTRUSTED',
  /** Install policy requires a publisher signature (ТЗ §SEC-05). */
  PLUGIN_SIGNATURE_REQUIRED: 'PLUGIN_SIGNATURE_REQUIRED',

  // Plugin resource governance (ТЗ Plugin SDK vNext §8, §19)
  RESOURCE_PRESSURE: 'RESOURCE_PRESSURE',
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
  RESOURCE_PROFILE_DENIED: 'RESOURCE_PROFILE_DENIED',

  THEME_NOT_FOUND: 'THEME_NOT_FOUND',
  THEME_INVALID: 'THEME_INVALID',

  // Files / storage
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',

  // Backup / migration
  BACKUP_FAILED: 'BACKUP_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  /** Global maintenance mode is active: mutations are paused (ТЗ §10.4). */
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',

  // Search
  SEARCH_FAILED: 'SEARCH_FAILED',
} as const;

/** Union of all known error codes. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AppErrorOptions {
  /** Stable machine-readable code. */
  code: ErrorCode;
  /** Structured parameters for localization/interpolation. Must be serializable. */
  params?: Record<string, unknown>;
  /** Suggested HTTP status for API responses (defaults derived from code). */
  httpStatus?: number;
  /** Developer-facing message (never shown to end users directly). */
  message?: string;
  /** Original cause for diagnostics. */
  cause?: unknown;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  [ErrorCodes.INTERNAL]: 500,
  [ErrorCodes.BAD_REQUEST]: 400,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.TIMEOUT]: 504,
  [ErrorCodes.ABORTED]: 499,
  [ErrorCodes.VALIDATION]: 422,
  [ErrorCodes.CHARACTER_NOT_FOUND]: 404,
  [ErrorCodes.CHARACTER_IMPORT_FAILED]: 422,
  [ErrorCodes.CHARACTER_CARD_INVALID]: 422,
  [ErrorCodes.CHAT_NOT_FOUND]: 404,
  [ErrorCodes.MESSAGE_NOT_FOUND]: 404,
  [ErrorCodes.MESSAGE_CONFLICT]: 409,
  [ErrorCodes.MESSAGE_REVISION_NOT_FOUND]: 404,
  [ErrorCodes.MESSAGE_DRAFT_NOT_FOUND]: 404,
  [ErrorCodes.CHAT_BRANCH_NOT_FOUND]: 404,
  [ErrorCodes.REGENERATE_TARGET_MOVED]: 409,
  [ErrorCodes.PERSONA_NOT_FOUND]: 404,
  [ErrorCodes.LOREBOOK_NOT_FOUND]: 404,
  [ErrorCodes.LORE_ENTRY_NOT_FOUND]: 404,
  [ErrorCodes.PRESET_NOT_FOUND]: 404,
  [ErrorCodes.PROFILE_NOT_FOUND]: 404,
  [ErrorCodes.PROFILE_EXPORT_FAILED]: 500,
  [ErrorCodes.CONNECTION_PROFILE_NOT_FOUND]: 404,
  [ErrorCodes.CONNECTION_PROFILE_TARGET_REQUIRED]: 422,
  [ErrorCodes.CONNECTION_PROFILE_MODE_MISMATCH]: 422,
  [ErrorCodes.CONNECTION_PROFILE_SOURCE_MISMATCH]: 409,
  [ErrorCodes.CONNECTION_PROFILE_SECRET_INVALID]: 422,
  [ErrorCodes.CONNECTION_PROFILE_PREFILL_UNSUPPORTED]: 422,
  [ErrorCodes.PROVIDER_NOT_FOUND]: 404,
  [ErrorCodes.PROVIDER_CONFIG_INVALID]: 422,
  [ErrorCodes.PROVIDER_DISABLED]: 409,
  [ErrorCodes.GENERATION_FAILED]: 502,
  [ErrorCodes.GENERATION_CANCELLED]: 499,
  [ErrorCodes.EMPTY_RESPONSE]: 502,
  [ErrorCodes.MODEL_NOT_FOUND]: 404,
  [ErrorCodes.TOKEN_BUDGET_EXCEEDED]: 422,
  [ErrorCodes.PROVIDER_SECRET_NOT_FOUND]: 404,
  [ErrorCodes.SECRETS_EXPOSURE_DISABLED]: 403,
  [ErrorCodes.SECRET_UNAVAILABLE_ON_THIS_DEVICE]: 422,
  [ErrorCodes.SECRET_STORE_READ_ONLY]: 403,
  [ErrorCodes.PLUGIN_NOT_FOUND]: 404,
  [ErrorCodes.PLUGIN_INVALID]: 422,
  [ErrorCodes.PLUGIN_PERMISSION_DENIED]: 403,
  [ErrorCodes.PLUGIN_LOAD_FAILED]: 500,
  [ErrorCodes.PLUGIN_SOURCE_UNSUPPORTED]: 422,
  [ErrorCodes.PLUGIN_SOURCE_INVALID]: 422,
  [ErrorCodes.PLUGIN_DEPS_UNSUPPORTED]: 422,
  [ErrorCodes.PLUGIN_DEPS_CONFLICT]: 409,
  [ErrorCodes.PLUGIN_DEPS_FORBIDDEN_FILE]: 422,
  [ErrorCodes.PLUGIN_DEPS_FAILED]: 422,
  [ErrorCodes.ENGINE_MISMATCH]: 422,
  [ErrorCodes.STATE_QUOTA_EXCEEDED]: 413,
  [ErrorCodes.PLUGIN_RUNTIME_UNAVAILABLE]: 503,
  [ErrorCodes.PLUGIN_RUNTIME_CRASHED]: 503,
  [ErrorCodes.PLUGIN_SIGNATURE_INVALID]: 422,
  [ErrorCodes.PLUGIN_SIGNATURE_UNTRUSTED]: 422,
  [ErrorCodes.PLUGIN_SIGNATURE_REQUIRED]: 422,
  [ErrorCodes.RESOURCE_PRESSURE]: 503,
  [ErrorCodes.RESOURCE_LIMIT_EXCEEDED]: 503,
  [ErrorCodes.RESOURCE_PROFILE_DENIED]: 403,
  [ErrorCodes.THEME_NOT_FOUND]: 404,
  [ErrorCodes.THEME_INVALID]: 422,
  [ErrorCodes.FILE_TOO_LARGE]: 413,
  [ErrorCodes.FILE_TYPE_NOT_ALLOWED]: 415,
  [ErrorCodes.FILE_NOT_FOUND]: 404,
  [ErrorCodes.STORAGE_WRITE_FAILED]: 500,
  [ErrorCodes.BACKUP_FAILED]: 500,
  [ErrorCodes.RESTORE_FAILED]: 500,
  [ErrorCodes.MIGRATION_FAILED]: 500,
  [ErrorCodes.MAINTENANCE_MODE]: 503,
  [ErrorCodes.SEARCH_FAILED]: 500,
};

/**
 * The single error type used throughout the application. Carries a stable code,
 * serializable params, and an optional HTTP status. Safe to serialize onto the
 * wire (see {@link AppError.toJSON}).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(options: AppErrorOptions) {
    super(options.message ?? options.code, {
      cause: options.cause,
    });
    this.name = 'AppError';
    this.code = options.code;
    this.params = options.params ?? {};
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[options.code];
  }

  /** Serializable wire representation (without traceId; the API layer adds it). */
  toJSON(): { code: ErrorCode; params: Record<string, unknown> } {
    return { code: this.code, params: this.params };
  }
}

/** Type guard narrowing an unknown value to {@link AppError}. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * A message safe to send to clients (e.g. inside SSE error events).
 *
 * {@link AppError} messages are authored in application code and contain no
 * secrets, so they pass through. Messages of arbitrary errors can carry SQL
 * text, filesystem paths or provider internals and are replaced by a generic
 * fallback (ТЗ §4.2 machine-readable codes, §13 secret hygiene). Check the
 * *original* thrown value — `toAppError` wraps unknown errors into an
 * AppError whose message is the unsafe original text.
 */
export function safeErrorMessage(value: unknown, fallback = 'Internal error'): string {
  return isAppError(value) ? value.message : fallback;
}

/**
 * Normalize any thrown value into an {@link AppError}. Unknown values become an
 * INTERNAL error; the original is preserved as `cause`.
 */
export function toAppError(value: unknown, fallbackMessage?: string): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError({
      code: ErrorCodes.INTERNAL,
      message: fallbackMessage ?? value.message,
      cause: value,
    });
  }
  return new AppError({
    code: ErrorCodes.INTERNAL,
    message: fallbackMessage ?? 'Unknown error',
    cause: value,
  });
}
