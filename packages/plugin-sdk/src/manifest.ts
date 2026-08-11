/**
 * Plugin manifest (plugin.json) schema and validation (ТЗ §7.1).
 * A `.stplugin` package is a ZIP containing this manifest.
 */
import { AppError, ErrorCodes, err, ok, type Result } from '@neotavern/shared';
import {
  parseCapability,
  parseCapabilityScope,
  type CapabilityRequest,
} from './kernel/capabilities.js';
import { parseRange } from './kernel/version.js';
import { validatePermissions } from './permissions.js';

/**
 * Current Plugin SDK API version. apiVersion 3 (vNext) is accepted and
 * routed to the Node Universal Runtime (ADR-0027); rev4 (apiVersion 2)
 * stays the default until Stage A integration lands.
 */
export const CURRENT_API_VERSION = 3;

export interface PluginManifest {
  /** Reverse-DNS identifier, e.g. "author.plugin-name". */
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  engines?: { neotavern?: string; host?: string; sdk?: string; protocol?: string };
  /** Relative path to the frontend ESM entry. */
  frontend?: string;
  /** Relative path to the backend ESM entry. */
  backend?: string;
  /** Relative path to plugin styles. */
  styles?: string;
  /** Locale → relative path of translation JSON. */
  i18n?: Record<string, string>;
  /**
   * Trusted compatibility entry points for existing SillyTavern extensions.
   * Packages using either entry must request `legacy.trusted`.
   */
  legacy?: {
    frontend?: string;
    backend?: string;
  };
  /**
   * Legacy flat permission list (SDK v2). Kept for compatibility; new
   * manifests SHOULD declare scoped capabilities instead (rev4 §B1).
   */
  permissions?: string[];
  /** Scoped capabilities the plugin cannot work without (rev4 §B1). */
  requiredCapabilities?: CapabilityRequest[];
  /** Scoped capabilities the plugin can degrade without (rev4 §B1). */
  optionalCapabilities?: CapabilityRequest[];
  /**
   * Static OAuth client descriptors (rev4 §K5). v1: public clients with PKCE
   * only — no clientSecret anywhere. Changing a descriptor requires
   * reinstalling the package.
   */
  authClients?: PluginAuthClient[];
  /**
   * Package-relative entry modules the plugin may spawn as isolated compute
   * workers (rev4 §C2). Spawning an undeclared entry is rejected; requires
   * the `compute.worker` capability at runtime.
   */
  workers?: string[];
  /**
   * Package signing (ТЗ v3.2 §36): `keyId` is the `ed25519:<hex>`
   * fingerprint of the signing public key; `signature` is the base64
   * Ed25519 signature over the canonical manifest (set by `neotavern-plugin
   * sign`/`build`, never handwritten).
   */
  publisher?: { keyId: string };
  signature?: string;
}

/** A public OAuth 2.0 client descriptor (authorization-code + PKCE). */
export interface PluginAuthClient {
  /** Reverse-DNS service id, e.g. "com.example.api". */
  serviceId: string;
  /** Human-readable service name shown in the host connections UI. */
  name: string;
  /** HTTPS authorization endpoint of the service. */
  authorizationUrl: string;
  /** HTTPS token endpoint the server calls to exchange the code. */
  tokenUrl: string;
  /** OAuth client id issued to the application. */
  clientId: string;
  /** Scopes requested on connect (must be non-empty). */
  scopes: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/i;
// Full semver, anchored at both ends: "1.0.0garbage" must not pass (the value
// feeds version comparisons and cache busters).
const VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePackagePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.includes('\\') || value.startsWith('/'))
    return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function hasExtension(value: string, extensions: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
}
/**
 * Parse a manifest capability list (rev4 §B1): entries are either catalog
 * strings (`"ui.overlay"`, `"network:api.example.com"`) or `{name, scope}`
 * objects. Issues are collected; returns the parsed list or null.
 */
function parseCapabilityList(
  value: unknown,
  field: string,
  issues: string[],
): CapabilityRequest[] | null {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return null;
  }
  const parsed: CapabilityRequest[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const request = parseCapability(entry);
      if (!request) issues.push(`${field}: unknown capability "${entry}"`);
      else parsed.push(request);
      continue;
    }
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      issues.push(`${field} entries must be strings or {name, scope} objects`);
      continue;
    }
    const request = parseCapability(entry['name']);
    if (!request) {
      issues.push(`${field}: unknown capability "${entry['name']}"`);
      continue;
    }
    if (entry['scope'] !== undefined) {
      if (request.scope !== undefined) {
        issues.push(`${field}: "${request.name}" scope comes from the name prefix`);
        continue;
      }
      const scope = parseCapabilityScope(entry['scope']);
      if (scope === undefined) {
        issues.push(`${field}: invalid scope for "${request.name}"`);
        continue;
      }
      parsed.push({ name: request.name, scope });
    } else {
      parsed.push(request);
    }
  }
  return parsed;
}
export function validateManifest(input: unknown): Result<PluginManifest> {
  if (!isRecord(input)) {
    return err(
      new AppError({ code: ErrorCodes.PLUGIN_INVALID, message: 'Manifest must be an object' }),
    );
  }

  const issues: string[] = [];
  const id = input['id'];
  const name = input['name'];
  const version = input['version'];
  const apiVersion = input['apiVersion'];

  if (typeof id !== 'string' || id.length > 160 || !ID_RE.test(id)) {
    issues.push('id must be a reverse-DNS identifier like "author.plugin-name"');
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    issues.push('name is required');
  }
  if (typeof version !== 'string' || version.length > 100 || !VERSION_RE.test(version)) {
    issues.push('version must be semver-like (e.g. "1.0.0")');
  }
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
    issues.push('apiVersion must be a positive integer');
  } else if (apiVersion > CURRENT_API_VERSION) {
    issues.push(`apiVersion ${apiVersion} is newer than supported (${CURRENT_API_VERSION})`);
  }

  for (const field of ['frontend', 'backend', 'styles'] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'string' || !isSafePackagePath(value))) {
      issues.push(`${field} must be a safe relative package path`);
    }
  }
  for (const field of ['frontend', 'backend'] as const) {
    const value = input[field];
    if (typeof value === 'string' && !hasExtension(value, ['.js', '.mjs', '.cjs'])) {
      issues.push(`${field} must reference a JavaScript module`);
    }
  }
  if (typeof input['styles'] === 'string' && !hasExtension(input['styles'], ['.css'])) {
    issues.push('styles must reference a CSS file');
  }

  if (input['engines'] !== undefined) {
    if (!isRecord(input['engines'])) {
      issues.push('engines must be an object');
    } else {
      for (const key of ['neotavern', 'host', 'sdk', 'protocol'] as const) {
        const value = input['engines'][key];
        if (value !== undefined && (typeof value !== 'string' || !parseRange(value))) {
          issues.push(`engines.${key} must be a valid version range`);
        }
      }
    }
  }

  if (input['i18n'] !== undefined) {
    if (!isRecord(input['i18n'])) {
      issues.push('i18n must be an object');
    } else {
      for (const [language, path] of Object.entries(input['i18n'])) {
        if (
          !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language) ||
          typeof path !== 'string' ||
          !isSafePackagePath(path) ||
          !hasExtension(path, ['.json'])
        ) {
          issues.push(`i18n.${language || '<empty>'} must be a safe relative package path`);
        }
      }
    }
  }

  let workers: string[] | undefined;
  if (input['workers'] !== undefined) {
    if (!Array.isArray(input['workers'])) {
      issues.push('workers must be an array');
    } else {
      const entries: string[] = [];
      for (const value of input['workers']) {
        if (
          typeof value !== 'string' ||
          !isSafePackagePath(value) ||
          !hasExtension(value, ['.js', '.mjs'])
        ) {
          issues.push('workers entries must be safe relative JavaScript module paths');
          continue;
        }
        entries.push(value);
      }
      if (entries.length > 0) workers = entries;
    }
  }

  let legacy: PluginManifest['legacy'];
  if (input['legacy'] !== undefined) {
    if (!isRecord(input['legacy'])) {
      issues.push('legacy must be an object');
    } else {
      const legacyFrontend = input['legacy']['frontend'];
      const legacyBackend = input['legacy']['backend'];
      for (const [field, value] of [
        ['frontend', legacyFrontend],
        ['backend', legacyBackend],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== 'string' ||
            !isSafePackagePath(value) ||
            !hasExtension(value, ['.js', '.mjs', '.cjs']))
        ) {
          issues.push(`legacy.${field} must reference a safe JavaScript module`);
        }
      }
      if (legacyFrontend === undefined && legacyBackend === undefined) {
        issues.push('legacy must define frontend or backend');
      } else {
        legacy = {
          ...(typeof legacyFrontend === 'string' ? { frontend: legacyFrontend } : {}),
          ...(typeof legacyBackend === 'string' ? { backend: legacyBackend } : {}),
        };
      }
    }
  }

  let permissions: string[] = [];
  if (input['permissions'] !== undefined) {
    if (!Array.isArray(input['permissions'])) {
      issues.push('permissions must be an array');
    } else {
      permissions = input['permissions'] as string[];
      issues.push(...validatePermissions(permissions));
    }
  }

  let requiredCapabilities: CapabilityRequest[] | undefined;
  if (input['requiredCapabilities'] !== undefined) {
    requiredCapabilities =
      parseCapabilityList(input['requiredCapabilities'], 'requiredCapabilities', issues) ??
      undefined;
  }
  let optionalCapabilities: CapabilityRequest[] | undefined;
  if (input['optionalCapabilities'] !== undefined) {
    optionalCapabilities =
      parseCapabilityList(input['optionalCapabilities'], 'optionalCapabilities', issues) ??
      undefined;
  }

  let authClients: PluginAuthClient[] | undefined;
  if (input['authClients'] !== undefined) {
    authClients = parseAuthClients(input['authClients'], issues) ?? undefined;
  }

  if (legacy && !permissions.includes('legacy.trusted')) {
    issues.push('legacy entry points require the legacy.trusted permission');
  }

  if (issues.length > 0) {
    return err(
      new AppError({
        code: ErrorCodes.PLUGIN_INVALID,
        params: { issues },
        message: `Invalid plugin manifest: ${issues.join('; ')}`,
      }),
    );
  }

  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    apiVersion: apiVersion as number,
  };
  if (isRecord(input['engines'])) manifest.engines = input['engines'] as PluginManifest['engines'];
  if (typeof input['frontend'] === 'string') manifest.frontend = input['frontend'];
  if (typeof input['backend'] === 'string') manifest.backend = input['backend'];
  if (typeof input['styles'] === 'string') manifest.styles = input['styles'];
  if (isRecord(input['i18n'])) manifest.i18n = input['i18n'] as Record<string, string>;
  if (legacy) manifest.legacy = legacy;
  if (permissions.length > 0) manifest.permissions = permissions;
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    manifest.requiredCapabilities = requiredCapabilities;
  }
  if (optionalCapabilities && optionalCapabilities.length > 0) {
    manifest.optionalCapabilities = optionalCapabilities;
  }
  if (authClients && authClients.length > 0) {
    manifest.authClients = authClients;
  }
  if (workers && workers.length > 0) {
    manifest.workers = workers;
  }
  const publisher = input['publisher'];
  if (isRecord(publisher) && typeof publisher['keyId'] === 'string') {
    manifest.publisher = { keyId: publisher['keyId'] };
  }
  if (typeof input['signature'] === 'string') {
    manifest.signature = input['signature'];
  }

  return ok(manifest);
}

/**
 * Parse and validate `authClients` (rev4 §K5). Each descriptor is a public
 * OAuth client: https endpoints only, unique reverse-DNS serviceId,
 * non-empty scope list. Problems are collected; null on any issue.
 */
function parseAuthClients(value: unknown, issues: string[]): PluginAuthClient[] | null {
  if (!Array.isArray(value)) {
    issues.push('authClients must be an array');
    return null;
  }
  const clients: PluginAuthClient[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      issues.push('authClients entries must be objects');
      continue;
    }
    const serviceId = raw['serviceId'];
    const name = raw['name'];
    const authorizationUrl = raw['authorizationUrl'];
    const tokenUrl = raw['tokenUrl'];
    const clientId = raw['clientId'];
    const scopes = raw['scopes'];
    const entryIssues: string[] = [];
    if (typeof serviceId !== 'string' || !ID_RE.test(serviceId)) {
      entryIssues.push('serviceId must be a reverse-DNS identifier');
    }
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
      entryIssues.push('name must be a non-empty string up to 100 chars');
    }
    if (typeof authorizationUrl !== 'string' || !isServiceUrl(authorizationUrl)) {
      entryIssues.push('authorizationUrl must be an https URL (loopback http is allowed)');
    }
    if (typeof tokenUrl !== 'string' || !isServiceUrl(tokenUrl)) {
      entryIssues.push('tokenUrl must be an https URL (loopback http is allowed)');
    }
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 200) {
      entryIssues.push('clientId must be a non-empty string up to 200 chars');
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      entryIssues.push('scopes must be a non-empty array');
    } else {
      for (const scope of scopes) {
        if (typeof scope !== 'string' || scope.length === 0 || scope.length > 200) {
          entryIssues.push('scopes entries must be non-empty strings up to 200 chars');
          break;
        }
      }
    }
    if (typeof serviceId === 'string' && seen.has(serviceId)) {
      entryIssues.push(`duplicate authClients serviceId "${serviceId}"`);
    }
    if (entryIssues.length > 0) {
      issues.push(`authClients[${clients.length}]: ${entryIssues.join('; ')}`);
      continue;
    }
    seen.add(serviceId as string);
    clients.push({
      serviceId: serviceId as string,
      name: name as string,
      authorizationUrl: authorizationUrl as string,
      tokenUrl: tokenUrl as string,
      clientId: clientId as string,
      scopes: scopes as string[],
    });
  }
  return clients.length === value.length ? clients : null;
}

/**
 * Service endpoints are HTTPS-only, with one dev exception: plain-HTTP loopback
 * (127.0.0.1, ::1, localhost) hosts, so a local IdP or dev gateway works
 * without TLS. Everything else, including any hostname inside a private
 * network, must still be https.
 */
function isServiceUrl(value: string): boolean {
  if (value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  }
  return false;
}
