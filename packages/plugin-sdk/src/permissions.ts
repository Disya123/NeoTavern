/**
 * Plugin permission model (ТЗ §7.4). Permissions are strings; some carry a
 * scope (`network:<hostname>`, `files:plugin`). Adding new permissions on
 * update requires re-consent — use {@link diffPermissions} to detect them.
 */

export const Permissions = {
  chatRead: 'chat.read',
  chatWrite: 'chat.write',
  charactersRead: 'characters.read',
  charactersWrite: 'characters.write',
  lorebookRead: 'lorebook.read',
  lorebookWrite: 'lorebook.write',
  promptInspect: 'prompt.inspect',
  promptModify: 'prompt.modify',
  providersRegister: 'providers.register',
  uiToolbar: 'ui.toolbar',
  uiSidebar: 'ui.sidebar',
  uiMessageActions: 'ui.messageActions',
  uiShell: 'ui.shell',
  /** Declarative semantic UI slot contributions (ТЗ §53). */
  uiSlots: 'ui.slots',
  clipboardRead: 'clipboard.read',
  clipboardWrite: 'clipboard.write',
  notifications: 'notifications',
  serverRoutes: 'server.routes',
  /** Runs documented SillyTavern legacy code in the trusted main app context. */
  legacyTrusted: 'legacy.trusted',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

/** All permissions that do not take a scope. */
export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(Object.values(Permissions));

export interface ParsedPermission {
  kind: string;
  scope?: string;
}

/** Parse `kind:scope` permissions (e.g. `network:api.example.com`). */
export function parsePermission(permission: string): ParsedPermission {
  const index = permission.indexOf(':');
  if (index === -1) return { kind: permission };
  return { kind: permission.slice(0, index), scope: permission.slice(index + 1) };
}

/** Whether a granted set satisfies a required permission. */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true;
  const parsed = parsePermission(required);
  // A bare `network` grant is not implied by specific hosts, and vice versa —
  // require exact matches except for wildcard `network:*`.
  if (parsed.kind === 'network' && granted.includes('network:*')) return true;
  return false;
}

export interface PermissionDiff {
  added: string[];
  removed: string[];
}

/** Compute added/removed permissions between two manifest versions. */
export function diffPermissions(
  previous: readonly string[],
  next: readonly string[],
): PermissionDiff {
  const prev = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((p) => !prev.has(p)),
    removed: [...prev].filter((p) => !nextSet.has(p)),
  };
}

/** Validate that every permission string is well-formed. */
export function validatePermissions(permissions: readonly string[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const permission of permissions) {
    if (typeof permission !== 'string' || permission.trim().length === 0) {
      issues.push('empty permission');
      continue;
    }
    if (seen.has(permission)) {
      issues.push(`duplicate permission: ${permission}`);
      continue;
    }
    seen.add(permission);
    const { kind, scope } = parsePermission(permission);
    if (kind === 'network') {
      if (!scope || !isNetworkScope(scope)) {
        issues.push(`network permission requires a valid hostname: ${permission}`);
      }
      continue;
    }
    if (kind === 'files') {
      if (scope !== 'plugin' && scope !== 'user-selected') {
        issues.push(`unknown files scope: ${scope ?? '<missing>'}`);
      }
      continue;
    }
    if (scope !== undefined || !KNOWN_PERMISSIONS.has(kind)) {
      issues.push(`unknown permission: ${permission}`);
    }
  }
  return issues;
}

function isNetworkScope(scope: string): boolean {
  if (scope === '*') return true;
  if (scope.length > 253 || scope.includes('..')) return false;
  return scope
    .toLowerCase()
    .split('.')
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
}
