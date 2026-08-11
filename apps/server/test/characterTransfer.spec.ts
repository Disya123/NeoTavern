/**
 * Integration tests for the character transfer routes
 * (src/plugins/characterTransfer.ts): PNG/JSON card import, V2 export and
 * content-addressed avatar/thumbnail delivery. Boots the real app against an
 * in-memory database; PNG fixtures are hand-built (valid CRCs, real zlib
 * IDAT) so sharp can decode them on the import path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deflateSync } from 'node:zlib';
import { parseCharacterCard } from '../src/lib/characterCards.js';
import type { TypedApp } from '../src/types.js';
import { createTestApp, multipartFile } from './helpers.js';

let app: TypedApp;

// --- minimal PNG construction -------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A solid-color RGBA image that sharp decodes without complaints. */
function pngImage(width: number, height: number, pixel: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  const row = Buffer.alloc(1 + width * 4); // filter byte 0 + RGBA pixels
  for (let x = 0; x < width; x++) row.set(pixel, 1 + x * 4);
  const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
  ]);
}

/** PNG with a base64 `chara` tEXt chunk (the SillyTavern card convention). */
function pngCard(card: unknown): Buffer {
  const encoded = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const text = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(encoded, 'latin1'),
  ]);
  return Buffer.concat([
    pngImage(8, 8, [124, 92, 255, 255]),
    pngChunk('tEXt', text),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function barePng(): Buffer {
  return Buffer.concat([pngImage(4, 4, [16, 16, 16, 255]), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- tests --------------------------------------------------------------------

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'PNG Explorer',
    description: 'Embedded in a PNG tEXt chunk',
    personality: 'Methodical',
    scenario: 'A pixelated horizon.',
    first_mes: 'Eight pixels wide and still exploring.',
    mes_example: '',
    creator_notes: 'Transfer route fixture',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['Still eight pixels wide.'],
    tags: ['png'],
    creator: 'ST2 tests',
    character_version: '1.0',
    extensions: { pngTool: { depth: 8 } },
  },
};

// createTestApp tracks the app/database/temp dir and tears them down in its
// registered afterEach, so each test boots a fresh app.
beforeEach(async () => {
  ({ app } = await createTestApp());
});

describe('character transfer', () => {
  it('imports a PNG card, stores immutable assets and is idempotent by content hash', async () => {
    const bytes = pngCard(V2_CARD);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(bytes, 'explorer.png', 'image/png'),
    });
    expect(first.statusCode, first.payload).toBe(200);
    const body = first.json();
    expect(body.created).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.character.name).toBe('PNG Explorer');
    expect(body.character.avatar).toBe(
      `/api/v2/assets/thumbnails/${body.sourceHash as string}-256-v1.webp`,
    );
    const characterId = body.character.id as string;

    // Thumbnail is generated and served. Content-addressed assets carry
    // long-lived immutable caching (ТЗ §11.4); the remoteAuth no-store hook
    // must not override an explicit route Cache-Control.
    const thumbnail = await app.inject({ method: 'GET', url: body.character.avatar as string });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers['content-type']).toContain('image/webp');
    expect(String(thumbnail.headers['cache-control'])).toContain('immutable');

    // The original bytes are stored unmodified under the content hash.
    const original = await app.inject({
      method: 'GET',
      url: `/api/v2/assets/avatars/${body.sourceHash as string}.png`,
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(original.rawPayload, bytes)).toBe(0);

    // Re-importing the identical bytes resolves to the same character.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(bytes, 'explorer-copy.png', 'image/png'),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false, character: { id: characterId } });
  });

  it('exports the imported card as a V2 download without internal metadata', async () => {
    const bytes = pngCard({ ...V2_CARD, data: { ...V2_CARD.data, name: 'PNG Exporter' } });
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(bytes, 'exporter.png', 'image/png'),
    });
    const characterId = imported.json().character.id as string;

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${characterId}/export`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toBe(
      `attachment; filename="character-${characterId}.json"`,
    );
    const card = exported.json();
    expect(card.spec).toBe('chara_card_v2');
    expect(card.spec_version).toBe('2.0');
    expect(card.data).toMatchObject({
      name: 'PNG Exporter',
      first_mes: 'Eight pixels wide and still exploring.',
      alternate_greetings: ['Still eight pixels wide.'],
      character_version: '1.0',
    });
    expect(card.data.extensions.pngTool).toEqual({ depth: 8 });
    // Import bookkeeping (_st2) must not leak into exported cards.
    expect(card.data.extensions._st2).toBeUndefined();

    const exportedPng = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${characterId}/export?format=png`,
    });
    expect(exportedPng.statusCode).toBe(200);
    expect(exportedPng.headers['content-type']).toContain('image/png');
    expect(exportedPng.headers['content-disposition']).toBe(
      `attachment; filename="character-${characterId}.png"`,
    );
    const parsedPng = parseCharacterCard(exportedPng.rawPayload, 'png');
    expect(parsedPng.character).toMatchObject({
      name: 'PNG Exporter',
      firstMessage: 'Eight pixels wide and still exploring.',
      ext: {
        alternateGreetings: ['Still eight pixels wide.'],
        characterVersion: '1.0',
        pngTool: { depth: 8 },
      },
    });
  });

  it('imports a JSON V1 card with a legacy warning', async () => {
    const upload = multipartFile(
      Buffer.from(JSON.stringify({ name: 'JSON Legacy', creatorcomment: 'old card' }), 'utf8'),
      'legacy.json',
      'application/json',
    );
    const res = await app.inject({ method: 'POST', url: '/api/v2/characters/import', ...upload });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().created).toBe(true);
    expect(res.json().warnings).toContain('LEGACY_CHARACTER_CARD_V1');
    expect(res.json().character.name).toBe('JSON Legacy');
  });

  it('rejects invalid cards with error envelopes and creates no data', async () => {
    const charactersBefore = (await app.inject({ method: 'GET', url: '/api/v2/characters' })).json()
      .items.length as number;

    // Non-card content type.
    const textFile = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(Buffer.from('plain text, not a card'), 'card.txt', 'text/plain'),
    });
    expect(textFile.statusCode).toBe(415);
    expect(textFile.json().code).toBe('FILE_TYPE_NOT_ALLOWED');

    // Valid PNG, no card metadata.
    const noMetadata = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(barePng(), 'empty.png', 'image/png'),
    });
    expect(noMetadata.statusCode).toBe(422);
    expect(noMetadata.json()).toMatchObject({
      code: 'CHARACTER_CARD_INVALID',
      params: { reason: 'PNG_CARD_METADATA_MISSING' },
    });

    // PNG card without a name.
    const nameless = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(pngCard({ description: 'nameless' }), 'nameless.png', 'image/png'),
    });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.json()).toMatchObject({
      code: 'CHARACTER_CARD_INVALID',
      params: { reason: 'NAME_REQUIRED' },
    });

    // JSON-shaped payload that is not valid JSON.
    const brokenJson = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...multipartFile(Buffer.from('{"name": nope', 'utf8'), 'broken.json', 'application/json'),
    });
    expect(brokenJson.statusCode).toBe(422);
    expect(brokenJson.json()).toMatchObject({
      code: 'CHARACTER_CARD_INVALID',
      params: { reason: 'INVALID_JSON' },
    });

    // A multipart body without any file part reaches the route's own guard.
    const boundary = `neotavern-empty-${Date.now().toString(16)}`;
    const noFile = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      payload: `--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json()).toMatchObject({
      code: 'BAD_REQUEST',
      params: { reason: 'FILE_REQUIRED' },
    });

    // A non-multipart body is rejected by the multipart layer itself.
    const notMultipart = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      payload: { note: 'no file attached' },
    });
    expect(notMultipart.statusCode).toBe(406);
    expect(notMultipart.json()).toMatchObject({
      code: 'BAD_REQUEST',
      params: { reason: 'FST_INVALID_MULTIPART_CONTENT_TYPE' },
    });

    const charactersAfter = (await app.inject({ method: 'GET', url: '/api/v2/characters' })).json()
      .items.length as number;
    expect(charactersAfter).toBe(charactersBefore);
  });

  it('returns CHARACTER_NOT_FOUND when exporting a missing character', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/characters/does-not-exist/export',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      code: 'CHARACTER_NOT_FOUND',
      params: { characterId: 'does-not-exist' },
    });
  });

  it('stores, lists, serves and removes character gallery images without duplicating bytes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Gallery Owner' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const characterId = created.json().id as string;
    const empty = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${characterId}/gallery`,
    });
    expect(empty.statusCode, empty.payload).toBe(200);
    expect(empty.json()).toEqual({ items: [] });

    const bytes = barePng();
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v2/characters/${characterId}/gallery`,
      ...multipartFile(bytes, 'forest.png', 'image/png'),
    });
    expect(uploaded.statusCode, uploaded.payload).toBe(200);
    expect(uploaded.json()).toMatchObject({
      characterId,
      name: 'forest.png',
      mime: 'image/png',
      sizeBytes: bytes.byteLength,
    });
    expect(uploaded.json().originalUrl).toMatch(/^\/api\/v2\/assets\/avatars\//);
    expect(uploaded.json().thumbnailUrl).toMatch(/^\/api\/v2\/assets\/thumbnails\//);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v2/characters/${characterId}/gallery`,
      ...multipartFile(bytes, 'forest-copy.png', 'image/png'),
    });
    expect(duplicate.statusCode, duplicate.payload).toBe(200);
    expect(duplicate.json().id).toBe(uploaded.json().id);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${characterId}/gallery?sort=newest`,
    });
    expect(listed.statusCode, listed.payload).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0].id).toBe(uploaded.json().id);

    const original = await app.inject({
      method: 'GET',
      url: uploaded.json().originalUrl as string,
    });
    expect(original.statusCode).toBe(200);
    expect(Buffer.compare(original.rawPayload, bytes)).toBe(0);

    const avatarUpdated = await app.inject({
      method: 'PATCH',
      url: `/api/v2/characters/${characterId}`,
      payload: { avatar: uploaded.json().thumbnailUrl },
    });
    expect(avatarUpdated.statusCode, avatarUpdated.payload).toBe(200);
    const originalAvatar = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${characterId}/avatar-original`,
    });
    expect(originalAvatar.statusCode).toBe(302);
    expect(originalAvatar.headers.location).toBe(uploaded.json().originalUrl);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/characters/${characterId}/gallery/${uploaded.json().id as string}`,
    });
    expect(removed.statusCode, removed.payload).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v2/characters/${characterId}/gallery`,
        })
      ).json(),
    ).toEqual({ items: [] });

    // Metadata deletion is intentionally recoverable: immutable content-addressed
    // originals are retained for dedupe/data safety.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: uploaded.json().originalUrl as string,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rejects gallery operations for missing owners and images', async () => {
    const missingOwner = await app.inject({
      method: 'GET',
      url: '/api/v2/characters/missing/gallery',
    });
    expect(missingOwner.statusCode).toBe(404);
    expect(missingOwner.json().code).toBe('CHARACTER_NOT_FOUND');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Empty Gallery' },
    });
    const missingImage = await app.inject({
      method: 'DELETE',
      url: `/api/v2/characters/${created.json().id as string}/gallery/missing`,
    });
    expect(missingImage.statusCode).toBe(404);
    expect(missingImage.json().code).toBe('FILE_NOT_FOUND');
  });

  it('guards the asset routes against unsafe and missing filenames', async () => {
    // Not content-addressed → rejected before any filesystem access.
    const unsafeName = await app.inject({
      method: 'GET',
      url: '/api/v2/assets/avatars/not-a-content-hash.png',
    });
    expect(unsafeName.statusCode).toBe(404);
    expect(unsafeName.json().code).toBe('FILE_NOT_FOUND');

    // Thumbnails are webp-only.
    const wrongExtension = await app.inject({
      method: 'GET',
      url: `/api/v2/assets/thumbnails/${'a'.repeat(64)}.png`,
    });
    expect(wrongExtension.statusCode).toBe(404);
    expect(wrongExtension.json().code).toBe('FILE_NOT_FOUND');

    // Well-formed but absent content hash.
    const absent = await app.inject({
      method: 'GET',
      url: `/api/v2/assets/avatars/${'b'.repeat(64)}.png`,
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json().code).toBe('FILE_NOT_FOUND');
  });
});
