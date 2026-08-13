/**
 * Remote access API over Tauri IPC (Phase 9 desktop remote access).
 *
 * Thin typed wrapper around the desktop shell's `kernel_remote_*` commands
 * (crates/adapters/tauri-local `remote` feature). Command errors arrive as
 * `Result<T, String>` rejections shaped `"REMOTE_*: message"`; they map to
 * {@link RemoteAccessError} with a stable machine-readable code so the UI can
 * localize it (AGENTS.md §16). Unknown rejection shapes degrade to
 * `REMOTE_INTERNAL`.
 */

import { invoke } from '@tauri-apps/api/core';

export interface RemoteCredential {
  id: string;
  label: string | null;
  revoked: boolean;
  /** Unix epoch milliseconds (wire DTO shape). */
  createdAt: number;
}

export interface RemoteStatus {
  running: boolean;
  bind: string | null;
  port: number | null;
  streams: number;
  authEnabled: boolean;
  credentials: RemoteCredential[];
  auditEvents: number;
  lastError: string | null;
}

export interface RemoteStartPayload {
  bind?: string;
  port?: number;
  authEnabled?: boolean;
  allowedOrigins?: string[];
}

/** `CODE: message` shape produced by the desktop command error convention. */
const COMMAND_ERROR = /^([A-Z][A-Z0-9_]*): (.*)$/s;

/** Command rejection whose message does not carry a machine-readable code. */
export const REMOTE_INTERNAL_CODE = 'REMOTE_INTERNAL';

export class RemoteAccessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteAccessError';
    this.code = code;
  }
}

/** Parse a `CODE: message` command message into its parts (null if foreign). */
export function parseRemoteError(message: string): { code: string; message: string } | null {
  const match = COMMAND_ERROR.exec(message);
  if (!match) return null;
  return { code: match[1] ?? '', message: match[2] ?? '' };
}

function toRemoteAccessError(reason: unknown): RemoteAccessError {
  const text =
    typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  const parsed = parseRemoteError(text);
  if (parsed) return new RemoteAccessError(parsed.code, parsed.message);
  return new RemoteAccessError(REMOTE_INTERNAL_CODE, text || 'Remote access request failed');
}

export async function remoteStatus(): Promise<RemoteStatus> {
  try {
    return await invoke<RemoteStatus>('kernel_remote_status');
  } catch (reason) {
    throw toRemoteAccessError(reason);
  }
}

export async function remoteStart(payload: RemoteStartPayload): Promise<RemoteStatus> {
  try {
    return await invoke<RemoteStatus>('kernel_remote_start', {
      bind: payload.bind ?? null,
      port: payload.port ?? null,
      authEnabled: payload.authEnabled ?? null,
      allowedOrigins: payload.allowedOrigins ?? null,
    });
  } catch (reason) {
    throw toRemoteAccessError(reason);
  }
}

export async function remoteStop(): Promise<void> {
  try {
    await invoke<void>('kernel_remote_stop');
  } catch (reason) {
    throw toRemoteAccessError(reason);
  }
}

export async function remotePair(label?: string): Promise<{ id: string; token: string }> {
  try {
    return await invoke<{ id: string; token: string }>('kernel_remote_pair', {
      label: label ?? null,
    });
  } catch (reason) {
    throw toRemoteAccessError(reason);
  }
}

export async function remoteRevoke(id: string): Promise<boolean> {
  try {
    return await invoke<boolean>('kernel_remote_revoke', { id });
  } catch (reason) {
    throw toRemoteAccessError(reason);
  }
}
