/**
 * Chat background (wallpaper) API integration tests (AGENTS.md §23).
 *
 * Covers: directory listing (including ST1-imported originals), content
 * addressed upload + dedup, MIME/content validation, asset serving with path
 * traversal protection, and delete cleanup (original + thumbnail + chat
 * reference).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createTestApp, multipartFile } from './helpers.js';

async function pngFixture(width = 640, height = 480): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 40, b: 80 } },
  })
    .png()
    .toBuffer();
}

describe('backgrounds API', () => {
  it('lists an empty catalog', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v2/backgrounds' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('rejects uploads without a multipart file', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/v2/backgrounds' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects unsupported MIME types', async () => {
    const { app } = await createTestApp();
    const { payload, headers } = multipartFile(
      Buffer.from('plain text, not an image'),
      'notes.txt',
      'text/plain',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('rejects bytes that are not a decodable image', async () => {
    const { app } = await createTestApp();
    const { payload, headers } = multipartFile(
      Buffer.from('definitely not a png despite the mimetype'),
      'fake.png',
      'image/png',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('uploads an image, serves it and lists it with a regenerable thumbnail', async () => {
    const { app, paths } = await createTestApp();
    const source = await pngFixture();
    const { payload, headers } = multipartFile(source, 'wallpaper.png', 'image/png');

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      payload,
      headers,
    });
    expect(upload.statusCode, upload.payload).toBe(200);
    const item = upload.json();
    expect(item).toMatchObject({
      originalUrl: `/api/v2/assets/backgrounds/${item.id}`,
      sizeBytes: source.byteLength,
    });
    expect(item.thumbnailUrl).toMatch(/^\/api\/v2\/assets\/thumbnails\//);

    // Original is content-addressed on disk.
    const original = await readFile(resolve(paths.backgrounds, item.id));
    expect(original.equals(source)).toBe(true);

    // Thumbnail is regenerable cache, present after upload.
    const thumbName = item.thumbnailUrl.split('/').pop();
    const thumbnail = await readFile(resolve(paths.thumbnails, String(thumbName)));
    const meta = await sharp(thumbnail).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(1280);

    // Asset endpoint streams the original back.
    const asset = await app.inject({ method: 'GET', url: item.originalUrl });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('image/png');
    expect(asset.rawPayload.equals(source)).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v2/backgrounds' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it('dedupes identical uploads to the same content hash', async () => {
    const { app } = await createTestApp();
    const source = await pngFixture(256, 256);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      ...multipartFile(source, 'a.png', 'image/png'),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      ...multipartFile(source, 'b.png', 'image/png'),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const list = await app.inject({ method: 'GET', url: '/api/v2/backgrounds' });
    expect(list.json().items).toHaveLength(1);
  });

  it('lists ST1-style imported originals placed directly in the directory', async () => {
    const { app, paths } = await createTestApp();
    const source = await pngFixture(320, 240);
    const originalPath = resolve(paths.backgrounds, 'st1-wallpaper.png');
    await import('node:fs/promises').then((fs) => fs.writeFile(originalPath, source));

    const list = await app.inject({ method: 'GET', url: '/api/v2/backgrounds' });
    expect(list.statusCode).toBe(200);
    const items = list.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('st1-wallpaper.png');
    expect(items[0].thumbnailUrl).toMatch(/^\/api\/v2\/assets\/thumbnails\//);

    // Thumbnail for imported originals is derived lazily and cache regenerable.
    const thumbName = items[0].thumbnailUrl.split('/').pop();
    await expect(readFile(resolve(paths.thumbnails, String(thumbName)))).resolves.toBeTruthy();
  });

  it('blocks path traversal in the asset route', async () => {
    const { app, paths } = await createTestApp();
    const source = await pngFixture();
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(resolve(paths.backgrounds, 'ok.png'), source),
    );

    const clean = await app.inject({ method: 'GET', url: '/api/v2/assets/backgrounds/ok.png' });
    expect(clean.statusCode).toBe(200);

    const traversal = await app.inject({
      method: 'GET',
      url: '/api/v2/assets/backgrounds/..%2F..%2Fapp.db',
    });
    expect(traversal.statusCode).toBe(404);
    expect(traversal.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });

    const encoded = await app.inject({
      method: 'GET',
      url: '/api/v2/assets/backgrounds/..%5C..%5Capp.db',
    });
    expect(encoded.statusCode).toBe(404);
  });

  it('refuses to delete a background that is not present', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/v2/backgrounds/ghost.png' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('deleting detaches the reference from chats and removes the thumbnail', async () => {
    const { app, paths } = await createTestApp();
    const source = await pngFixture();
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v2/backgrounds',
      ...multipartFile(source, 'wallpaper.png', 'image/png'),
    });
    const { id, originalUrl, thumbnailUrl } = upload.json();

    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Wallpaper chat' },
    });
    const chatId = chat.json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chatId}`,
      payload: { backgroundId: id },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(patched.json().backgroundId).toBe(id);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/backgrounds/${encodeURIComponent(id)}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: `/api/v2/chats/${chatId}` });
    expect(after.json().backgroundId).toBeNull();

    const asset = await app.inject({ method: 'GET', url: originalUrl });
    expect(asset.statusCode).toBe(404);

    const thumbName = thumbnailUrl.split('/').pop();
    await expect(
      import('node:fs/promises').then((fs) =>
        fs.access(resolve(paths.thumbnails, String(thumbName))),
      ),
    ).rejects.toBeTruthy();
  });
});
