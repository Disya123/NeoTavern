/**
 * Theme activation rollback and last-known-good boot fallback (ТЗ §10/§83).
 *
 * Activation persists the currently working theme (id + setting values) as
 * the last-working fallback before flipping, and only after the target has
 * passed manifest + activation-graph validation — a failed activation must
 * leave the previous theme untouched. The pre-hydration boot falls back to
 * the last working theme when the stored active theme is missing, broken or
 * invalid; an empty boot (built-in defaults) remains the final resort, and
 * safe mode always boots empty.
 */
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { createTestApp, multipartFile, type TestAppHandle } from './helpers.js';

/** Mirrors LAST_WORKING_THEME_KEY in apps/server/src/plugins/themes.ts. */
const LAST_WORKING_THEME_KEY = 'theme.lastWorking';

async function zipArchive(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, contents] of Object.entries(entries)) {
    zip.addBuffer(typeof contents === 'string' ? Buffer.from(contents) : contents, path);
  }
  zip.end();
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
  zip.outputStream.on('error', reject);
  zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  return promise;
}

async function installTheme(
  handle: TestAppHandle,
  id: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const archive = await zipArchive({ 'theme.json': JSON.stringify({ id, ...manifest }) });
  const response = await handle.app.inject({
    method: 'POST',
    url: '/api/v2/themes/install',
    ...multipartFile(archive, `${id}.sttheme`, 'application/zip'),
  });
  expect(response.statusCode).toBe(200);
}

async function activateTheme(handle: TestAppHandle, id: string): Promise<void> {
  const response = await handle.app.inject({
    method: 'POST',
    url: `/api/v2/themes/${id}/activate`,
  });
  expect(response.statusCode).toBe(200);
}

describe('theme activation rollback and boot fallback', () => {
  it('keeps the previous theme active when activation fails', async () => {
    const handle = await createTestApp();
    const { app, database } = handle;
    await installTheme(handle, 'test.rollback-a', {
      name: 'Rollback A',
      version: '1.0.0',
    });
    await activateTheme(handle, 'test.rollback-a');

    // An orphan child installs (its own manifest is valid) but must fail
    // activation: its extends chain references a missing parent.
    await installTheme(handle, 'test.rollback-orphan', {
      name: 'Rollback orphan',
      version: '1.0.0',
      extends: 'test.missing-parent',
    });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/test.rollback-orphan/activate',
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().code).toBe('THEME_INVALID');

    // The previous theme is untouched: still active and still boots.
    expect((await app.inject({ method: 'GET', url: '/api/v2/themes' })).json().activeThemeId).toBe(
      'test.rollback-a',
    );
    expect((await app.inject({ method: 'GET', url: '/api/v2/themes/boot' })).json().themeId).toBe(
      'test.rollback-a',
    );

    // A failed activation must not have touched the last-working snapshot.
    await expect(database.repos.settings.get(LAST_WORKING_THEME_KEY)).resolves.toEqual({
      themeId: null,
      settings: null,
    });
  });

  it('persists the last working theme (id + settings) before flipping and boots it when the active theme breaks', async () => {
    const handle = await createTestApp();
    const { app, database } = handle;
    await installTheme(handle, 'test.lw-a', {
      name: 'LW A',
      version: '1.0.0',
      settings: {
        accent: {
          type: 'color',
          label: 'Accent',
          variable: '--theme-accent',
          default: '#ff0000',
        },
      },
    });
    await activateTheme(handle, 'test.lw-a');
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v2/themes/test.lw-a/settings',
      payload: { accent: '#123456' },
    });
    expect(patched.statusCode).toBe(200);

    await installTheme(handle, 'test.lw-parent', { name: 'LW parent', version: '1.0.0' });
    await installTheme(handle, 'test.lw-b', {
      name: 'LW B',
      version: '1.0.0',
      extends: 'test.lw-parent',
    });
    await activateTheme(handle, 'test.lw-b');

    // The previous working theme (id + its setting values) is the fallback.
    await expect(database.repos.settings.get(LAST_WORKING_THEME_KEY)).resolves.toEqual({
      themeId: 'test.lw-a',
      settings: { accent: '#123456' },
    });

    // Break the active theme by removing its parent: the boot falls back to
    // the last working theme instead of an empty boot.
    await app.inject({ method: 'DELETE', url: '/api/v2/themes/test.lw-parent' });
    const boot = await app.inject({ method: 'GET', url: '/api/v2/themes/boot' });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({ themeId: 'test.lw-a', cssUrls: [] });
  });

  it('boots the last working theme when the stored active manifest is corrupted', async () => {
    const handle = await createTestApp();
    const { app, database } = handle;
    await installTheme(handle, 'test.corrupt-a', { name: 'Corrupt A', version: '1.0.0' });
    await activateTheme(handle, 'test.corrupt-a');
    await installTheme(handle, 'test.corrupt-b', { name: 'Corrupt B', version: '1.0.0' });
    await activateTheme(handle, 'test.corrupt-b');

    // Corrupt the stored active manifest directly in the registry (bypassing
    // route validation, keeping the enabled flag) — as if a stricter SDK
    // version rejected a manifest that used to install.
    database.repos.themes.install({
      id: 'test.corrupt-b',
      name: 'Corrupt B',
      version: '1.0.0',
      manifest: { id: 'test.corrupt-b', name: '', version: '1.0.0' },
    });

    // The boot must neither 500 nor paint the broken theme.
    const boot = await app.inject({ method: 'GET', url: '/api/v2/themes/boot' });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().themeId).toBe('test.corrupt-a');
  });

  it('boots empty when both the active theme and the last working theme are broken', async () => {
    const handle = await createTestApp();
    const { app } = handle;
    await installTheme(handle, 'test.both-a', { name: 'Both A', version: '1.0.0' });
    await activateTheme(handle, 'test.both-a');
    await installTheme(handle, 'test.both-parent', { name: 'Both parent', version: '1.0.0' });
    await installTheme(handle, 'test.both-b', {
      name: 'Both B',
      version: '1.0.0',
      extends: 'test.both-parent',
    });
    await activateTheme(handle, 'test.both-b');

    // Break the active theme's chain AND remove the last working theme.
    await app.inject({ method: 'DELETE', url: '/api/v2/themes/test.both-a' });
    await app.inject({ method: 'DELETE', url: '/api/v2/themes/test.both-parent' });

    const boot = await app.inject({ method: 'GET', url: '/api/v2/themes/boot' });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toEqual({ themeId: null, cssUrls: [], light: {}, dark: {} });
  });

  it('an explicit reset drops the fallback, and safe mode always boots empty', async () => {
    const handle = await createTestApp();
    const { app, database } = handle;
    await installTheme(handle, 'test.reset-a', { name: 'Reset A', version: '1.0.0' });
    await activateTheme(handle, 'test.reset-a');
    await installTheme(handle, 'test.reset-b', { name: 'Reset B', version: '1.0.0' });
    await activateTheme(handle, 'test.reset-b');

    // Resetting to the built-in theme must stick: the last-working fallback
    // is dropped so the next boot does not resurrect the previous theme.
    const reset = await app.inject({ method: 'DELETE', url: '/api/v2/themes/active' });
    expect(reset.json()).toEqual({ activeThemeId: null });
    await expect(database.repos.settings.get(LAST_WORKING_THEME_KEY)).resolves.toEqual({
      themeId: null,
      settings: null,
    });
    expect((await app.inject({ method: 'GET', url: '/api/v2/themes/boot' })).json()).toEqual({
      themeId: null,
      cssUrls: [],
      light: {},
      dark: {},
    });

    // Safe mode (NEOTA_SAFE_MODE): even with an installed, active theme the
    // boot must stay empty — third-party themes are disabled entirely.
    const safeHandle = await createTestApp({ safeMode: true });
    await installTheme(safeHandle, 'test.safe-a', { name: 'Safe A', version: '1.0.0' });
    await activateTheme(safeHandle, 'test.safe-a');
    const safeBoot = await safeHandle.app.inject({ method: 'GET', url: '/api/v2/themes/boot' });
    expect(safeBoot.statusCode).toBe(200);
    expect(safeBoot.json()).toEqual({ themeId: null, cssUrls: [], light: {}, dark: {} });
  });
});
