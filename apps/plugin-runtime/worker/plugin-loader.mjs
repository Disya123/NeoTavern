/**
 * ESM resolver boundary for untrusted backend plugins.
 *
 * Plugin code may import only package-local relative/file modules. Node
 * built-ins, data URLs and network modules stay unavailable; host
 * capabilities are supplied exclusively through the Plugin SDK bridge.
 *
 * Bare imports are additionally permitted when the host sets
 * NEOTA_PLUGIN_ALLOW_BARE_IMPORTS=1 — that only happens when the built-in
 * dependency installer materialized a verified node_modules inside the
 * package (.neotavern-deps.json marker). The containment check below still
 * confines every resolved path to the package root, so a bare specifier can
 * never escape into the host's own node_modules.
 */
import { realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = canonicalPath(process.env['NEOTA_PLUGIN_PACKAGE_ROOT'] ?? '');
const workerUrl = process.env['NEOTA_PLUGIN_WORKER_URL'] ?? '';
const workerPath = canonicalPath(process.env['NEOTA_PLUGIN_WORKER_PATH'] ?? '');
const allowBareImports = process.env['NEOTA_PLUGIN_ALLOW_BARE_IMPORTS'] === '1';

export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL && isWorkerSpecifier(specifier)) {
    return nextResolve(specifier, context);
  }
  if (isWorkerParent(context.parentURL)) {
    return nextResolve(specifier, context);
  }
  if (
    specifier.startsWith('node:') ||
    specifier.startsWith('data:') ||
    specifier.startsWith('http:') ||
    specifier.startsWith('https:') ||
    (!allowBareImports &&
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('file:'))
  ) {
    throw denied(specifier);
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.startsWith('file:')) {
    const path = canonicalPath(fileURLToPath(resolved.url));
    if (path !== packageRoot && !path.startsWith(`${packageRoot}${sep}`)) {
      throw denied(specifier);
    }
  }
  return resolved;
}

function isWorkerSpecifier(specifier) {
  if (specifier === workerUrl) return true;
  if (!specifier.startsWith('file:')) return false;
  try {
    return canonicalPath(fileURLToPath(specifier)) === workerPath;
  } catch {
    return false;
  }
}

function isWorkerParent(parentUrl) {
  if (parentUrl === workerUrl) return true;
  if (!parentUrl?.startsWith('file:')) return false;
  try {
    return canonicalPath(fileURLToPath(parentUrl)) === workerPath;
  } catch {
    return false;
  }
}

function canonicalPath(path) {
  const resolved = resolvePath(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function denied(specifier) {
  const error = new Error(`Plugin module import denied: ${specifier}`);
  error.code = 'PLUGIN_PERMISSION_DENIED';
  return error;
}
