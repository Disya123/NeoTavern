/**
 * Theme manifest (theme.json) schema and validation (ТЗ §6.5). A `.sttheme`
 * package is a directory/ZIP containing this manifest plus assets.
 */
import { AppError, ErrorCodes, err, ok, type Result } from '@neotavern/shared';
import { TOKEN_NAMES, type TokenSet } from './tokens.js';
import {
  NAVIGATION_RAIL_ITEM_IDS,
  type NavigationRailItemId,
  type ThemeShellLayout,
} from './shell.js';

export type ThemeMode = 'light' | 'dark';
export const CURRENT_THEME_API_VERSION = 1;

export interface ThemeSettingDef {
  type: 'color' | 'boolean' | 'number' | 'select';
  label: string;
  default?: unknown;
  options?: string[];
  /**
   * CSS custom property the setting value is emitted to (e.g.
   * `--theme-accent`). The host applies it on the document root when the
   * theme is active — this is how settings drive component skins.
   */
  variable?: string;
}

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  apiVersion?: number;
  /** Parent theme id — this theme inherits its tokens/skin/shell. */
  extends?: string;
  modes?: ThemeMode[];
  tokens?: { light?: TokenSet; dark?: TokenSet };
  /** Relative path to component-skin CSS (theme level 2). */
  componentsCss?: string;
  /**
   * Relative path to declarative shell CSS (theme level 3).
   * Executable JavaScript is deliberately not part of the Theme SDK.
   */
  shell?: string;
  /** Declarative host-controlled shell composition (no executable code). */
  shellLayout?: ThemeShellLayout;
  settings?: Record<string, ThemeSettingDef>;
  preview?: string;
  iconPack?: string;
  soundPack?: string;
  /** Translation resources: language code → relative path to a JSON file. */
  locales?: Record<string, string>;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+/;
const TOKEN_NAME_SET: ReadonlySet<string> = new Set(TOKEN_NAMES);
const THEME_MODES: ReadonlySet<string> = new Set(['light', 'dark']);
const NAVIGATION_RAIL_ITEM_ID_SET: ReadonlySet<string> = new Set(NAVIGATION_RAIL_ITEM_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePackagePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isCssPackagePath(value: string): boolean {
  return isSafePackagePath(value) && value.toLowerCase().endsWith('.css');
}

function validateTokenSet(value: unknown, mode: ThemeMode, issues: string[]): value is TokenSet {
  if (!isRecord(value)) {
    issues.push(`tokens.${mode} must be an object`);
    return false;
  }

  let valid = true;
  for (const [name, tokenValue] of Object.entries(value)) {
    if (!TOKEN_NAME_SET.has(name)) {
      issues.push(`unknown token: ${name}`);
      valid = false;
    }
    if (
      typeof tokenValue !== 'string' ||
      tokenValue.length === 0 ||
      tokenValue.length > 1024 ||
      containsUnsafeCssCharacter(tokenValue) ||
      containsUnsafeTokenUrl(tokenValue)
    ) {
      issues.push(`token ${name} must be a safe non-empty CSS value`);
      valid = false;
    }
  }
  return valid;
}

function containsUnsafeCssCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || character === '{' || character === '}' || character === ';';
  });
}

/**
 * CSS constructs that must never appear in theme package stylesheets or in
 * manifest token values — executable legacy hooks, remote resources and
 * cascade escapes. Single source of truth for both the manifest validator
 * and the server-side package CSS assertion (apps/server themes.ts).
 */
export const FORBIDDEN_CSS_CONSTRUCTS = [
  '@import',
  'javascript:',
  'expression(',
  '-moz-binding',
  'behavior:',
  'url(http:',
  'url(https:',
  'url(//',
  'data:text/html',
  '!important',
] as const;

/** True when the value contains any {@link FORBIDDEN_CSS_CONSTRUCTS} entry. */
export function containsForbiddenCssConstruct(value: string): boolean {
  // Compact whitespace/quotes/escapes so `java\tscript:` style obfuscation
  // cannot slip between the tokens.
  const compact = value.toLowerCase().replaceAll(/[\s"'\\]+/gu, '');
  return FORBIDDEN_CSS_CONSTRUCTS.some((construct) => compact.includes(construct));
}

function containsUnsafeTokenUrl(value: string): boolean {
  return containsForbiddenCssConstruct(value);
}

export function validateThemeManifest(input: unknown): Result<ThemeManifest> {
  if (!isRecord(input)) {
    return err(
      new AppError({ code: ErrorCodes.THEME_INVALID, message: 'Manifest must be an object' }),
    );
  }
  const issues: string[] = [];
  const id = input['id'];
  const name = input['name'];
  const version = input['version'];

  if (typeof id !== 'string' || id.length > 160 || !ID_RE.test(id)) issues.push('id is invalid');
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200)
    issues.push('name is required and must not exceed 200 characters');
  if (typeof version !== 'string' || version.length > 100 || !VERSION_RE.test(version))
    issues.push('version must be semver-like');
  if (
    input['extends'] !== undefined &&
    (typeof input['extends'] !== 'string' || !ID_RE.test(input['extends']))
  ) {
    issues.push('extends must be a valid theme id');
  }

  const apiVersion = input['apiVersion'];
  if (apiVersion !== undefined) {
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
      issues.push('apiVersion must be a positive integer');
    } else if (apiVersion > CURRENT_THEME_API_VERSION) {
      issues.push(
        `apiVersion ${apiVersion} is newer than supported (${CURRENT_THEME_API_VERSION})`,
      );
    }
  }

  if (input['modes'] !== undefined) {
    if (
      !Array.isArray(input['modes']) ||
      input['modes'].some((mode) => typeof mode !== 'string' || !THEME_MODES.has(mode))
    ) {
      issues.push('modes may contain only "light" and "dark"');
    }
  }

  if (input['settings'] !== undefined) {
    if (!isRecord(input['settings'])) {
      issues.push('settings must be an object');
    } else {
      for (const [settingId, definition] of Object.entries(input['settings'])) {
        if (!ID_RE.test(settingId) || !isRecord(definition)) {
          issues.push(`setting ${settingId} is invalid`);
          continue;
        }
        const type = definition['type'];
        const label = definition['label'];
        if (
          !['color', 'boolean', 'number', 'select'].includes(String(type)) ||
          typeof label !== 'string' ||
          label.length === 0 ||
          label.length > 200
        ) {
          issues.push(`setting ${settingId} has an invalid type or label`);
        }
        if (
          definition['options'] !== undefined &&
          (!Array.isArray(definition['options']) ||
            definition['options'].some(
              (option) => typeof option !== 'string' || option.length === 0 || option.length > 200,
            ))
        ) {
          issues.push(`setting ${settingId} options must be strings`);
        }
        if (type === 'select' && !Array.isArray(definition['options'])) {
          issues.push(`select setting ${settingId} requires options`);
        }
        if (
          definition['variable'] !== undefined &&
          (typeof definition['variable'] !== 'string' ||
            !/^--[a-zA-Z0-9-]{1,100}$/u.test(definition['variable']))
        ) {
          issues.push(`setting ${settingId} variable must be a CSS custom property name`);
        }
      }
    }
  }

  if (input['shellLayout'] !== undefined) {
    const shellLayout = input['shellLayout'];
    if (!isRecord(shellLayout)) {
      issues.push('shellLayout must be an object');
    } else {
      if (shellLayout['navigationRail'] !== undefined && !isRecord(shellLayout['navigationRail'])) {
        issues.push('shellLayout.navigationRail must be an object');
      } else if (isRecord(shellLayout['navigationRail'])) {
        const navigationRail = shellLayout['navigationRail'];
        const seen = new Set<string>();
        for (const group of ['main', 'bottom'] as const) {
          const items = navigationRail[group];
          if (items === undefined) continue;
          if (
            !Array.isArray(items) ||
            items.length > NAVIGATION_RAIL_ITEM_IDS.length ||
            items.some((item) => typeof item !== 'string' || !NAVIGATION_RAIL_ITEM_ID_SET.has(item))
          ) {
            issues.push(
              `shellLayout.navigationRail.${group} must contain only known navigation item ids`,
            );
            continue;
          }
          for (const item of items) {
            if (seen.has(item)) {
              issues.push(`shellLayout.navigationRail item ${item} must appear only once`);
            }
            seen.add(item);
          }
        }
      }

      const managementTabs = shellLayout['managementTabs'];
      if (managementTabs !== undefined && !isRecord(managementTabs)) {
        issues.push('shellLayout.managementTabs must be an object');
      } else if (
        isRecord(managementTabs) &&
        managementTabs['pinned'] !== undefined &&
        typeof managementTabs['pinned'] !== 'boolean'
      ) {
        issues.push('shellLayout.managementTabs.pinned must be a boolean');
      }
    }
  }

  if (input['locales'] !== undefined) {
    if (!isRecord(input['locales'])) {
      issues.push('locales must be an object');
    } else {
      for (const [language, path] of Object.entries(input['locales'])) {
        if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)) {
          issues.push(`locale language "${language}" is invalid`);
        }
        if (
          typeof path !== 'string' ||
          !isSafePackagePath(path) ||
          !path.toLowerCase().endsWith('.json')
        ) {
          issues.push(`locale ${language} must reference a JSON package file`);
        }
      }
    }
  }

  const tokens = input['tokens'];
  if (tokens !== undefined) {
    if (!isRecord(tokens)) {
      issues.push('tokens must be an object');
    } else {
      for (const mode of Object.keys(tokens)) {
        if (!THEME_MODES.has(mode)) issues.push(`unknown token mode: ${mode}`);
      }
      if (tokens['light'] !== undefined) validateTokenSet(tokens['light'], 'light', issues);
      if (tokens['dark'] !== undefined) validateTokenSet(tokens['dark'], 'dark', issues);
    }
  }

  for (const field of ['componentsCss', 'shell', 'preview', 'iconPack', 'soundPack'] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'string' || !isSafePackagePath(value))) {
      issues.push(`${field} must be a safe relative package path`);
    }
  }
  for (const field of ['componentsCss', 'shell'] as const) {
    const value = input[field];
    if (typeof value === 'string' && !isCssPackagePath(value)) {
      issues.push(`${field} must reference a CSS file`);
    }
  }

  if (issues.length > 0) {
    return err(
      new AppError({
        code: ErrorCodes.THEME_INVALID,
        params: { issues },
        message: `Invalid theme manifest: ${issues.join('; ')}`,
      }),
    );
  }

  const manifest: ThemeManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
  };
  if (typeof apiVersion === 'number') manifest.apiVersion = apiVersion;
  if (typeof input['extends'] === 'string') manifest.extends = input['extends'];
  if (Array.isArray(input['modes'])) manifest.modes = input['modes'] as ThemeMode[];
  if (isRecord(input['tokens'])) {
    const tokens = input['tokens'];
    manifest.tokens = {};
    if (isRecord(tokens['light'])) manifest.tokens.light = tokens['light'] as TokenSet;
    if (isRecord(tokens['dark'])) manifest.tokens.dark = tokens['dark'] as TokenSet;
  }
  if (typeof input['componentsCss'] === 'string') manifest.componentsCss = input['componentsCss'];
  if (typeof input['shell'] === 'string') manifest.shell = input['shell'];
  if (isRecord(input['shellLayout'])) {
    const navigationRail = input['shellLayout']['navigationRail'];
    const managementTabs = input['shellLayout']['managementTabs'];
    manifest.shellLayout = {};
    if (isRecord(navigationRail)) {
      manifest.shellLayout.navigationRail = {};
      if (Array.isArray(navigationRail['main'])) {
        manifest.shellLayout.navigationRail.main = navigationRail['main'] as NavigationRailItemId[];
      }
      if (Array.isArray(navigationRail['bottom'])) {
        manifest.shellLayout.navigationRail.bottom = navigationRail[
          'bottom'
        ] as NavigationRailItemId[];
      }
    }
    if (isRecord(managementTabs) && typeof managementTabs['pinned'] === 'boolean') {
      manifest.shellLayout.managementTabs = { pinned: managementTabs['pinned'] };
    }
  }
  if (isRecord(input['settings']))
    manifest.settings = input['settings'] as Record<string, ThemeSettingDef>;
  if (typeof input['preview'] === 'string') manifest.preview = input['preview'];
  if (typeof input['iconPack'] === 'string') manifest.iconPack = input['iconPack'];
  if (typeof input['soundPack'] === 'string') manifest.soundPack = input['soundPack'];
  if (isRecord(input['locales'])) {
    manifest.locales = Object.fromEntries(
      Object.entries(input['locales']).filter(([, path]) => typeof path === 'string'),
    ) as Record<string, string>;
  }

  return ok(manifest);
}
