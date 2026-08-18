/**
 * Product Wire client for Kernel Playwright (M7). Speaks `/rpc` against
 * `neotavern-headless` via `E2E_WIRE_URL`. Maps the legacy REST helpers
 * (`POST /characters`, …) onto wire operations so specs can move off
 * Fastify `/api/v2` without rewriting every fixture.
 *
 * Deliberately does not import workspace packages: Playwright's ESM loader
 * cannot resolve `@neotavern/*` from `e2e/` (and loading client-sdk pulls a
 * tsconfig project-reference Playwright cannot resolve). The request
 * envelope is the documented Product Wire shape; `schemaHash` is read from
 * the contracts manifest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const WIRE_PROTOCOL = { major: 1, minor: 0 } as const;

function contractSchemaHash(): string {
  const manifest = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../packages/contracts/src/wire/manifest.ts'),
    'utf8',
  );
  const match = /WIRE_SCHEMA_HASH = '([0-9a-f]{64})'/u.exec(manifest);
  if (match?.[1] === undefined) {
    throw new Error('could not read WIRE_SCHEMA_HASH from packages/contracts/src/wire/manifest.ts');
  }
  return match[1];
}

export function wireBaseUrl(): string | undefined {
  const url = process.env['E2E_WIRE_URL'];
  return url !== undefined && url.length > 0 ? url.replace(/\/+$/u, '') : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`wire result is not an object: ${JSON.stringify(value)}`);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** `providers.config.set` name: `^[a-z][a-z0-9-]{0,63}$`. */
export function slugProviderName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const named = slug.length === 0 || !/^[a-z]/u.test(slug) ? `e2e-${slug}` : slug;
  return named.slice(0, 64);
}

export function mapLegacyPost(
  path: string,
  body: Record<string, unknown>,
): { operationId: string; payload: Record<string, unknown> } {
  if (path === '/characters') {
    const name = optionalString(body, 'name');
    if (name === undefined) throw new Error('characters.create requires name');
    const payload: Record<string, unknown> = { name };
    const description = optionalString(body, 'description');
    if (description !== undefined) payload['description'] = description;
    return { operationId: 'characters.create', payload };
  }
  if (path === '/chats') {
    const characterId = optionalString(body, 'characterId');
    if (characterId === undefined) throw new Error('chats.create requires characterId');
    const payload: Record<string, unknown> = { characterId };
    const title = optionalString(body, 'title');
    if (title !== undefined) payload['title'] = title;
    return { operationId: 'chats.create', payload };
  }
  const messages = /^\/chats\/([^/]+)\/messages$/u.exec(path);
  if (messages?.[1] !== undefined) {
    const role = optionalString(body, 'role');
    const content = optionalString(body, 'content');
    if (role === undefined || content === undefined) {
      throw new Error('chats.messages.create requires role and content');
    }
    return {
      operationId: 'chats.messages.create',
      payload: { chatId: messages[1], role, content },
    };
  }
  if (path === '/personas') {
    const name = optionalString(body, 'name');
    if (name === undefined) throw new Error('personas.create requires name');
    const payload: Record<string, unknown> = { name };
    const description = optionalString(body, 'description');
    if (description !== undefined) payload['description'] = description;
    return { operationId: 'personas.create', payload };
  }
  if (path === '/lorebooks') {
    const name = optionalString(body, 'name');
    if (name === undefined) throw new Error('lorebooks.create requires name');
    const payload: Record<string, unknown> = { name };
    const description = optionalString(body, 'description');
    if (description !== undefined) payload['description'] = description;
    const characterId = optionalString(body, 'characterId');
    if (characterId !== undefined) payload['characterId'] = characterId;
    if (Array.isArray(body['entries'])) payload['entries'] = body['entries'];
    return { operationId: 'lorebooks.create', payload };
  }
  if (path === '/providers') {
    const kindRaw = optionalString(body, 'kind') ?? 'fake';
    const provider = kindRaw === 'echo' ? 'fake' : kindRaw;
    const name = slugProviderName(optionalString(body, 'name') ?? 'e2e');
    const model = optionalString(body, 'model');
    const payload: Record<string, unknown> = { provider, name };
    if (model !== undefined) payload['config'] = { model: model === 'echo' ? 'steps=8' : model };
    return { operationId: 'providers.config.set', payload };
  }
  throw new Error(`no Product Wire mapping for POST ${path}`);
}

export async function wireCall(
  operationId: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const baseUrl = wireBaseUrl();
  if (baseUrl === undefined) {
    throw new Error('E2E_WIRE_URL is not set — Kernel e2e helpers cannot call /rpc');
  }
  const envelope = {
    wireProtocol: WIRE_PROTOCOL,
    schemaHash: contractSchemaHash(),
    requestId: randomUUID(),
    operationId,
    payload,
  };
  const response = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operationId} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const record = asRecord(parsed);
  if (record['kind'] === 'error') {
    const error = asRecord(record['error'] ?? {});
    throw new Error(`${operationId} ${String(error['code'] ?? 'ERROR')}: ${text.slice(0, 400)}`);
  }
  if (record['kind'] !== 'ok') {
    throw new Error(`${operationId} unexpected envelope: ${text.slice(0, 400)}`);
  }
  return asRecord(record['result']);
}

const SETTINGS_WIRE_KEYS: Record<string, string> = {
  activeProviderConfigId: 'active-provider-config-id',
  activePersonaId: 'active-persona-id',
};

export async function wirePatchSettings(patch: Record<string, unknown>): Promise<void> {
  const settings = Object.entries(patch).flatMap(([field, value]) => {
    const key = SETTINGS_WIRE_KEYS[field];
    if (key === undefined) return [];
    const wrapped =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { value };
    return [{ key, value: wrapped }];
  });
  if (settings.length === 0) return;
  await wireCall('settings.update', { settings });
}
