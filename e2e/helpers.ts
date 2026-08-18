/**
 * Shared helpers for the Playwright suites: a minimal store-only ZIP writer
 * (the installed `zipBuffer` from release.spec.ts, generalized to bytes),
 * a typed JSON POST helper and an axe accessibility check.
 *
 * When `E2E_WIRE_URL` is set (Kernel / neotavern-headless), POSTs map onto
 * Product Wire `/rpc` instead of Fastify `/api/v2`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { mapLegacyPost, wireBaseUrl, wireCall, wirePatchSettings } from './wire.js';

export async function postJson(
  page: Page,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (wireBaseUrl() !== undefined) {
    const record =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const mapped = mapLegacyPost(path, record);
    return wireCall(mapped.operationId, mapped.payload);
  }
  const response = await page.request.post(`/api/v2${path}`, { data: body });
  expect(response.ok(), `POST ${path} -> ${response.status()}: ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as Record<string, unknown>;
}

export async function patchSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  if (wireBaseUrl() !== undefined) {
    await wirePatchSettings(patch);
    return;
  }
  const response = await page.request.patch('/api/v2/settings', { data: patch });
  expect(response.ok(), `PATCH settings -> ${response.status()}: ${await response.text()}`).toBe(
    true,
  );
}

/**
 * Permanently remove every chat. Home-page screenshots must be independent of
 * chat state mutated by sibling tests (character card clicks create an
 * unstarted chat for the pinned character), so visual tests call this before
 * navigating so the captured hero is deterministic.
 */
export async function clearChats(page: Page): Promise<void> {
  if (wireBaseUrl() !== undefined) {
    const listed = await wireCall('chats.list', { limit: 100 });
    const items = listed['items'];
    if (!Array.isArray(items)) return;
    for (const chat of items) {
      if (chat !== null && typeof chat === 'object' && 'id' in chat) {
        await wireCall('chats.delete', { chatId: String((chat as { id: unknown }).id) });
      }
    }
    return;
  }
  const response = await page.request.get('/api/v2/chats?limit=100');
  expect(response.ok(), `GET chats -> ${response.status()}`).toBe(true);
  const body = (await response.json()) as { items: Array<{ id: string }> };
  for (const chat of body.items) {
    const deleted = await page.request.delete(`/api/v2/chats/${chat.id}?purge=true`);
    expect(deleted.ok(), `DELETE chat ${chat.id} -> ${deleted.status()}`).toBe(true);
  }
}

export async function expectNoA11yViolations(page: Page, scope?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']);
  if (scope) builder = builder.include(scope);
  const results = await builder.analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.nodes.length} node(s)`)
      .join('\n'),
  ).toEqual([]);
}

export function zipBuffer(entries: Record<string, string | Uint8Array>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text as Buffer);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
