/** Safe install, activation and asset delivery for declarative `.sttheme` ZIPs. */
import { createReadStream, createWriteStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Type } from '@sinclair/typebox';
import {
  ThemeActivationResultSchema,
  ThemeBootResponseSchema,
  ThemeDeleteResultSchema,
  ThemeIdSchema,
  ThemeInstallResultSchema,
  ThemeListResponseSchema,
  ThemeSettingsResponseSchema,
  type InstalledTheme,
  type ThemeBootResponse,
  type ThemeListResponse,
} from '@neotavern/contracts';
import type { ThemeRegistryEntry } from '@neotavern/db';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import {
  buildThemeVariables,
  containsForbiddenCssConstruct,
  validateThemeManifest,
  type ThemeManifest,
} from '@neotavern/theme-sdk';
import {
  DEFAULT_PACKAGE_ARCHIVE_LIMITS,
  extractPackageArchive,
  validatePackageEntryPath,
} from '../lib/packageArchive.js';
import type { AppContext, TypedApp } from '../types.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CSS_BYTES = 2 * 1024 * 1024;
const MAX_LOCALE_BYTES = 256 * 1024;
const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.ogg',
  '.wav',
  '.json',
]);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
};

function invalidTheme(reason: string, cause?: unknown): AppError {
  return new AppError({
    code: ErrorCodes.THEME_INVALID,
    params: { reason },
    message: `Invalid theme package: ${reason}`,
    cause,
  });
}

function manifestRecord(manifest: ThemeManifest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest));
}

function assetUrl(themeId: string, packagePath: string | undefined): string | null {
  if (!packagePath) return null;
  const encoded = packagePath.split('/').map(encodeURIComponent).join('/');
  return `/api/v2/themes/${encodeURIComponent(themeId)}/assets/${encoded}`;
}

function toInstalledTheme(entry: ThemeRegistryEntry): InstalledTheme {
  const validation = validateThemeManifest(entry.manifest);
  if (!validation.ok) throw invalidTheme('stored manifest failed validation', validation.error);
  const manifest = validation.value;
  const localesUrls: Record<string, string> = {};
  for (const [language, path] of Object.entries(manifest.locales ?? {})) {
    const url = assetUrl(entry.id, path);
    if (url) localesUrls[language] = url;
  }
  return {
    ...entry,
    manifest: manifestRecord(manifest),
    componentsCssUrl: assetUrl(entry.id, manifest.componentsCss),
    shellCssUrl: assetUrl(entry.id, manifest.shell),
    previewUrl: assetUrl(entry.id, manifest.preview),
    ...(Object.keys(localesUrls).length > 0 ? { localesUrls } : {}),
  };
}

/** Storage key for per-theme user setting values. */
function themeSettingsKey(themeId: string): string {
  return `theme.settings.${themeId}`;
}

const EMPTY_THEME_BOOT: ThemeBootResponse = { themeId: null, cssUrls: [], light: {}, dark: {} };

/**
 * Resolve the pre-hydration boot payload for the active theme: its resolved
 * token variables (both modes) and package stylesheet URLs. Any problem
 * (no active theme, broken extends chain, invalid manifest) degrades to an
 * empty boot — the client simply paints built-in defaults.
 */
function resolveThemeBoot(items: InstalledTheme[]): ThemeBootResponse {
  const active = items.find((item) => item.enabled);
  if (!active) return EMPTY_THEME_BOOT;
  const byId = new Map(items.map((item) => [item.id, item]));
  const parents: InstalledTheme[] = [];
  const seen = new Set<string>([active.id]);
  let parentId =
    typeof active.manifest['extends'] === 'string' ? active.manifest['extends'] : undefined;
  while (parentId) {
    if (seen.has(parentId)) return EMPTY_THEME_BOOT;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return EMPTY_THEME_BOOT;
    parents.unshift(parent);
    parentId =
      typeof parent.manifest['extends'] === 'string' ? parent.manifest['extends'] : undefined;
  }
  try {
    const manifests = [...parents, active].map((item) => {
      const result = validateThemeManifest(item.manifest);
      if (!result.ok) throw result.error;
      return result.value;
    });
    const activeManifest = manifests.at(-1);
    if (!activeManifest) return EMPTY_THEME_BOOT;
    const parentManifests = manifests.slice(0, -1);
    const cssUrls = [...parents, active].flatMap((item) =>
      [item.componentsCssUrl, item.shellCssUrl].filter(
        (href): href is string => typeof href === 'string' && href.length > 0,
      ),
    );
    return {
      themeId: active.id,
      cssUrls,
      light: buildThemeVariables(activeManifest, 'light', parentManifests),
      dark: buildThemeVariables(activeManifest, 'dark', parentManifests),
    };
  } catch {
    return EMPTY_THEME_BOOT;
  }
}

/** Merge manifest defaults with stored user values. */
function mergedThemeSettings(
  manifest: ThemeManifest,
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [settingId, definition] of Object.entries(manifest.settings ?? {})) {
    const candidate = stored?.[settingId];
    values[settingId] =
      candidate !== undefined && isSettingValueValid(definition, candidate)
        ? candidate
        : (definition.default ?? null);
  }
  return values;
}

/**
 * String setting values must not smuggle CSS constructs: a "color" setting is
 * interpolated into a custom property that feeds e.g. `background-image`, so
 * `red url(https://evil)` must not pass (THEME-45 L7). CSP img-src is a
 * separate layer; validation is the boundary that belongs here.
 */
const UNSAFE_SETTING_VALUE_RE = /[;{}<>]|url\s*\(|expression\s*\(|javascript:/iu;

function isSettingValueValid(
  definition: { type: string; options?: string[] },
  value: unknown,
): boolean {
  switch (definition.type) {
    case 'color':
      return (
        typeof value === 'string' && value.length <= 100 && !UNSAFE_SETTING_VALUE_RE.test(value)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'select':
      return typeof value === 'string' && (definition.options ?? []).includes(value);
    default:
      return false;
  }
}

async function findPackageRoot(extractedRoot: string): Promise<string> {
  const rootManifest = join(extractedRoot, 'theme.json');
  if (await exists(rootManifest)) return extractedRoot;
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
  if (directories.length !== 1) throw invalidTheme('theme.json must be at the package root');
  const candidate = join(extractedRoot, directories[0]?.name ?? '');
  if (!(await exists(join(candidate, 'theme.json')))) {
    throw invalidTheme('theme.json must be at the package root');
  }
  return candidate;
}

async function readManifest(packageRoot: string): Promise<ThemeManifest> {
  const path = join(packageRoot, 'theme.json');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw invalidTheme('theme.json is missing or too large');
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    throw invalidTheme('theme.json is not valid JSON', cause);
  }
  const result = validateThemeManifest(input);
  if (!result.ok) throw result.error;
  return result.value;
}

async function validateReferencedAssets(
  packageRoot: string,
  manifest: ThemeManifest,
): Promise<void> {
  for (const cssPath of [manifest.componentsCss, manifest.shell]) {
    if (!cssPath) continue;
    const path = resolve(packageRoot, ...validatePackageEntryPath(cssPath));
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_CSS_BYTES) {
      throw invalidTheme(`CSS asset is missing or exceeds ${MAX_CSS_BYTES} bytes`);
    }
    assertSafeThemeCss(await readFile(path, 'utf8'));
  }

  if (manifest.preview) {
    const extension = extname(manifest.preview).toLowerCase();
    const path = resolve(packageRoot, ...validatePackageEntryPath(manifest.preview));
    const info = await lstat(path).catch(() => null);
    if (!ALLOWED_ASSET_EXTENSIONS.has(extension) || !info?.isFile() || info.isSymbolicLink()) {
      throw invalidTheme('preview must reference a supported package asset');
    }
  }

  for (const [language, localePath] of Object.entries(manifest.locales ?? {})) {
    const path = resolve(packageRoot, ...validatePackageEntryPath(localePath));
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_LOCALE_BYTES) {
      throw invalidTheme(`locale ${language} is missing or exceeds ${MAX_LOCALE_BYTES} bytes`);
    }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw invalidTheme(`locale ${language} must be a JSON object of translations`);
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw invalidTheme(`locale ${language} is not valid JSON`, cause);
    }
  }
}

/**
 * CSS is declarative but still constrained: imports, script-capable legacy
 * features and remote resource URLs are rejected. The app CSP independently
 * restricts resources to the same origin.
 */
export function assertSafeThemeCss(css: string): void {
  if (containsForbiddenCssConstruct(css)) {
    throw invalidTheme('CSS contains a forbidden executable or remote resource construct');
  }
}

function assertActivationGraph(themeId: string, entries: ThemeRegistryEntry[]): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  let current: string | undefined = themeId;
  while (current) {
    if (seen.has(current)) throw invalidTheme('theme inheritance contains a cycle');
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) {
      throw invalidTheme('theme inheritance references an uninstalled parent');
    }
    const result = validateThemeManifest(entry.manifest);
    if (!result.ok) throw result.error;
    current = result.value.extends;
  }
}

export async function registerThemeRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.themes;

  app.get(
    '/api/v2/themes',
    { schema: { response: { 200: ThemeListResponseSchema } } },
    async (): Promise<ThemeListResponse> => {
      const items = repo.list().map(toInstalledTheme);
      return {
        items,
        activeThemeId: items.find((item) => item.enabled)?.id ?? null,
      };
    },
  );

  // Pre-hydration bootstrap (THEME-44): an inline script in index.html fetches
  // this before React mounts so the active theme paints on the first frame
  // instead of flashing the built-in one. No active/valid theme → empty boot;
  // the client falls back to defaults exactly like before.
  app.get(
    '/api/v2/themes/boot',
    { schema: { response: { 200: ThemeBootResponseSchema } } },
    async (): Promise<ThemeBootResponse> => {
      const items = repo.list().map(toInstalledTheme);
      return resolveThemeBoot(items);
    },
  );

  app.post(
    '/api/v2/themes/install',
    { schema: { response: { 200: ThemeInstallResultSchema } } },
    async (request) => {
      const upload = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: DEFAULT_PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes },
      });
      if (!upload) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'FILE_REQUIRED' } });
      }

      const temporaryRoot = await mkdtemp(join(ctx.paths.themes, '.install-'));
      const archivePath = join(temporaryRoot, 'source.zip');
      const extractedRoot = join(temporaryRoot, 'extracted');
      let rollbackPath: string | null = null;
      let finalPath: string | null = null;
      try {
        await pipeline(upload.file, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
        if (upload.file.truncated) {
          throw new AppError({
            code: ErrorCodes.FILE_TOO_LARGE,
            params: { limitBytes: DEFAULT_PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes },
          });
        }
        await extractPackageArchive(archivePath, extractedRoot);
        const packageRoot = await findPackageRoot(extractedRoot);
        const manifest = await readManifest(packageRoot);
        await validateReferencedAssets(packageRoot, manifest);

        finalPath = join(ctx.paths.themes, manifest.id);
        const incomingPath = join(ctx.paths.themes, `.incoming-${randomToken(10)}`);
        await rename(packageRoot, incomingPath);
        if (await exists(finalPath)) {
          rollbackPath = join(ctx.paths.themes, `.rollback-${randomToken(10)}`);
          await rename(finalPath, rollbackPath);
        }
        try {
          await rename(incomingPath, finalPath);
          const installed = repo.install({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            manifest: manifestRecord(manifest),
          });
          if (rollbackPath) {
            await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
          }
          return { theme: toInstalledTheme(installed.theme), replaced: installed.replaced };
        } catch (cause) {
          await rm(finalPath, { recursive: true, force: true });
          if (rollbackPath) await rename(rollbackPath, finalPath);
          await rm(incomingPath, { recursive: true, force: true });
          throw cause;
        }
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  app.post(
    '/api/v2/themes/:id/activate',
    {
      schema: {
        params: Type.Object({ id: ThemeIdSchema }),
        response: { 200: ThemeActivationResultSchema },
      },
    },
    async (request) => {
      if (!repo.getById(request.params.id)) {
        throw new AppError({
          code: ErrorCodes.THEME_NOT_FOUND,
          params: { themeId: request.params.id },
        });
      }
      assertActivationGraph(request.params.id, repo.list());
      const active = repo.activate(request.params.id);
      if (!active) {
        throw new AppError({
          code: ErrorCodes.THEME_NOT_FOUND,
          params: { themeId: request.params.id },
        });
      }
      return { activeThemeId: active.id };
    },
  );

  app.delete(
    '/api/v2/themes/active',
    { schema: { response: { 200: ThemeActivationResultSchema } } },
    async () => {
      repo.resetActive();
      return { activeThemeId: null };
    },
  );

  // Per-theme user settings (ТЗ §6.5: «тема может иметь собственные
  // настройки»). Values are validated against the manifest definitions; the
  // host emits each setting's `variable` as a CSS custom property.
  app.get(
    '/api/v2/themes/:id/settings',
    {
      schema: {
        params: Type.Object({ id: ThemeIdSchema }),
        response: { 200: ThemeSettingsResponseSchema },
      },
    },
    async (request) => {
      const entry = repo.getById(request.params.id);
      if (!entry) {
        throw new AppError({
          code: ErrorCodes.THEME_NOT_FOUND,
          params: { themeId: request.params.id },
        });
      }
      const validation = validateThemeManifest(entry.manifest);
      if (!validation.ok) throw validation.error;
      const stored = (await ctx.database.repos.settings.get(themeSettingsKey(entry.id))) as
        Record<string, unknown> | null | undefined;
      return { values: mergedThemeSettings(validation.value, stored) };
    },
  );

  app.patch(
    '/api/v2/themes/:id/settings',
    {
      schema: {
        params: Type.Object({ id: ThemeIdSchema }),
        body: Type.Record(Type.String({ minLength: 1, maxLength: 160 }), Type.Unknown()),
        response: { 200: ThemeSettingsResponseSchema },
      },
    },
    async (request) => {
      const entry = repo.getById(request.params.id);
      if (!entry) {
        throw new AppError({
          code: ErrorCodes.THEME_NOT_FOUND,
          params: { themeId: request.params.id },
        });
      }
      const validation = validateThemeManifest(entry.manifest);
      if (!validation.ok) throw validation.error;
      const definitions = validation.value.settings ?? {};
      const stored =
        ((await ctx.database.repos.settings.get(themeSettingsKey(entry.id))) as
          Record<string, unknown> | null | undefined) ?? {};
      for (const [settingId, value] of Object.entries(request.body)) {
        const definition = definitions[settingId];
        if (!definition || !isSettingValueValid(definition, value)) {
          throw new AppError({
            code: ErrorCodes.VALIDATION,
            params: { path: settingId, value },
            message: 'Invalid theme setting value',
          });
        }
        stored[settingId] = value;
      }
      await ctx.database.repos.settings.set(themeSettingsKey(entry.id), stored);
      return { values: mergedThemeSettings(validation.value, stored) };
    },
  );

  app.delete(
    '/api/v2/themes/:id',
    {
      schema: {
        params: Type.Object({ id: ThemeIdSchema }),
        response: { 200: ThemeDeleteResultSchema },
      },
    },
    async (request) => {
      const themePath = join(ctx.paths.themes, request.params.id);
      const removalPath = join(ctx.paths.themes, `.remove-${randomToken(10)}`);
      const hadFiles = await exists(themePath);
      if (hadFiles) await rename(themePath, removalPath);
      let result: ReturnType<typeof repo.delete>;
      try {
        result = repo.delete(request.params.id);
      } catch (cause) {
        if (hadFiles && (await exists(removalPath))) await rename(removalPath, themePath);
        throw cause;
      }
      if (result.deleted || hadFiles) {
        await rm(removalPath, { recursive: true, force: true }).catch(() => undefined);
        // The theme's user setting values leave with the theme.
        await ctx.database.repos.settings.delete(themeSettingsKey(request.params.id));
      }
      const activeThemeId = repo.list().find((item) => item.enabled)?.id ?? null;
      return { deleted: result.deleted, activeThemeId };
    },
  );

  app.get(
    '/api/v2/themes/:id/assets/*',
    {
      schema: {
        params: Type.Object({ id: ThemeIdSchema, '*': Type.String({ minLength: 1 }) }),
      },
    },
    async (request, reply) => {
      if (!repo.getById(request.params.id)) {
        throw new AppError({
          code: ErrorCodes.THEME_NOT_FOUND,
          params: { themeId: request.params.id },
        });
      }
      const relativePath = request.params['*'];
      const extension = extname(relativePath).toLowerCase();
      if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
        throw new AppError({
          code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
          params: { extension },
        });
      }
      const path = resolve(
        ctx.paths.themes,
        request.params.id,
        ...validatePackageEntryPath(relativePath),
      );
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { relativePath } });
      }
      if (extension === '.css' && info.size > MAX_CSS_BYTES) {
        throw new AppError({
          code: ErrorCodes.FILE_TOO_LARGE,
          params: { limitBytes: MAX_CSS_BYTES },
        });
      }
      // Content-addressed caching: theme ids are stable and reinstalling
      // rewrites files (mtime changes), so a weak size/mtime ETag is safe and
      // spares the browser from re-downloading CSS on every mode toggle.
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      const base = reply
        .type(CONTENT_TYPES[extension] ?? 'application/octet-stream')
        .header('Cache-Control', 'private, max-age=3600')
        .header('ETag', etag);
      if (extension === '.css') {
        // Serve package CSS wrapped in the `theme` cascade layer so the
        // declared hierarchy (user above theme) is guaranteed instead of
        // relying on theme authors to wrap their stylesheets (THEME-45 L8).
        const source = await readFile(path, 'utf8');
        return base.send(`@layer theme {\n${source}\n}\n`);
      }
      return base.send(createReadStream(path));
    },
  );

  // Optional user stylesheet (docs/theme-sdk «user.css грузится последним»):
  // a local power-user escape hatch served wrapped in the `user` layer, which
  // layers.css orders above `theme`. Absent file → 404, client skips it.
  app.get('/api/v2/user.css', async (request, reply) => {
    const path = resolve(ctx.paths.root, 'user.css');
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_CSS_BYTES) {
      throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { relativePath: 'user.css' } });
    }
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    const source = await readFile(path, 'utf8');
    return reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'private, max-age=300')
      .header('ETag', etag)
      .send(`@layer user {\n${source}\n}\n`);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
