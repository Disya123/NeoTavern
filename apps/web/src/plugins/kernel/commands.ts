/**
 * Rev4 kernel: commands.* + surfaces.* host handlers (contract §2).
 *
 * Registrations are bridged into the v2 runtime registry
 * (`runtime.kernelAddRegistration`) with stable ids: commands use the
 * plugin-chosen id (`cmd:<id>`), surfaces get a host-generated token
 * (`surf:<token>`) because the plugin never names them. Host→plugin
 * invocations go through `session.call('commands.run' | 'surfaces.run')`
 * via the exported helpers consumed later by host UI.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { PluginRegistrationKind, PluginUiRegistration } from '../runtime.js';
import type { KernelHostContext } from './types.js';
export const RUN_DEADLINE_MS = 5000;
const { KernelError, KernelErrorCode } = kernel;

/** Surface kinds plugins may register (contract §2; interceptors is host-only). */
const SURFACE_KINDS: readonly PluginRegistrationKind[] = [
  'toolbarActions',
  'messageActions',
  'contextMenuItems',
  'sidebarPanels',
  'characterTabs',
  'dialogs',
  'pages',
  'settingsPanels',
  'slash',
  'hotkeys',
  'messageRenderers',
  'commands',
];

function failParams(method: string, reason: string, extra?: Record<string, unknown>): never {
  throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
    details: { method, reason, ...extra },
  });
}

function paramsRecord(method: string, params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return failParams(method, 'params-not-object');
}

function requiredString(record: Record<string, unknown>, key: string, method: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    return failParams(method, 'invalid-field', { field: key });
  }
  return value;
}

function requireCapability(ctx: KernelHostContext, capability: string, method: string): void {
  if (!ctx.hasCapability(capability)) {
    throw new KernelError(KernelErrorCode.CAPABILITY_DENIED, {
      details: { capability, method },
    });
  }
}

function randomToken(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().replaceAll('-', '');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Definition fields the v2 registry understands; unknown fields are dropped. */
function surfaceDefinition(
  surfaceId: string,
  raw: Record<string, unknown>,
): PluginUiRegistration['definition'] {
  const definition: PluginUiRegistration['definition'] = {
    id: surfaceId,
    title: typeof raw['title'] === 'string' && raw['title'].length > 0 ? raw['title'] : surfaceId,
  };
  const stringFields = [
    'path',
    'slot',
    'context',
    'combo',
    'icon',
    'description',
    'placement',
  ] as const;
  for (const field of stringFields) {
    const value = raw[field];
    if (typeof value === 'string') definition[field] = value;
  }
  if (typeof raw['priority'] === 'number' && Number.isFinite(raw['priority'])) {
    definition.priority = raw['priority'];
  }
  if (typeof raw['timeoutMs'] === 'number' && Number.isFinite(raw['timeoutMs'])) {
    definition.timeoutMs = raw['timeoutMs'];
  }
  if (
    typeof raw['order'] === 'number' &&
    Number.isSafeInteger(raw['order']) &&
    raw['order'] >= 0 &&
    raw['order'] <= 10_000
  ) {
    definition.order = raw['order'];
  }
  return definition;
}

export function attachCommands(ctx: KernelHostContext): void {
  ctx.session.handle('commands.register', ({ params }) => {
    const method = 'commands.register';
    requireCapability(ctx, 'ui.commands', method);
    const record = paramsRecord(method, params);
    const id = requiredString(record, 'id', method);
    const title = requiredString(record, 'title', method);
    const kernelFlag = record['kernel'] === true;
    const description = record['description'];
    const category = record['category'];
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return failParams(method, 'invalid-field', { field: 'description' });
    }
    if (category !== undefined && category !== null && typeof category !== 'string') {
      return failParams(method, 'invalid-field', { field: 'category' });
    }
    const registrationId = `cmd:${id}`;
    const definition: PluginUiRegistration['definition'] = { id, title };
    if (typeof description === 'string' && description.length > 0)
      definition.description = description;
    ctx.runtime.kernelAddRegistration({
      pluginId: ctx.pluginId,
      pluginName: ctx.frame.plugin.name,
      registrationId,
      kind: 'commands',
      definition,
      kernel: kernelFlag,
    });
    return { commandId: registrationId };
  });

  ctx.session.handle('commands.unregister', ({ params }) => {
    const method = 'commands.unregister';
    requireCapability(ctx, 'ui.commands', method);
    const record = paramsRecord(method, params);
    const commandId = requiredString(record, 'commandId', method);
    ctx.runtime.kernelRemoveRegistration(commandId);
    return {};
  });

  ctx.session.handle('surfaces.register', ({ params }) => {
    const method = 'surfaces.register';
    requireCapability(ctx, 'ui.surfaces', method);
    const record = paramsRecord(method, params);
    const kind = record['kind'];
    if (typeof kind !== 'string' || !SURFACE_KINDS.includes(kind as PluginRegistrationKind)) {
      return failParams(method, 'invalid-field', { field: 'kind' });
    }
    const raw = record['definition'];
    const kernelFlag = record['kernel'] === true;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return failParams(method, 'invalid-field', { field: 'definition' });
    }
    const registrationId = `surf:${randomToken()}`;
    ctx.runtime.kernelAddRegistration({
      pluginId: ctx.pluginId,
      pluginName: ctx.frame.plugin.name,
      kernel: kernelFlag,
      registrationId,
      kind: kind as PluginRegistrationKind,
      definition: surfaceDefinition(registrationId, raw as Record<string, unknown>),
    });
    return { surfaceId: registrationId, registrationId };
  });

  ctx.session.handle('surfaces.unregister', ({ params }) => {
    const method = 'surfaces.unregister';
    requireCapability(ctx, 'ui.surfaces', method);
    const record = paramsRecord(method, params);
    const surfaceId = requiredString(record, 'surfaceId', method);
    ctx.runtime.kernelRemoveRegistration(surfaceId);
    return {};
  });
}

/**
 * Host UI entry point: run a plugin command in its sandbox. Resolves with the
 * plugin's runner result; rejects with a KernelError on denial/timeout.
 */
export function runPluginCommand(
  ctx: KernelHostContext,
  commandId: string,
  context: unknown,
): Promise<unknown> {
  return ctx.session.call('commands.run', { commandId, context }, { deadlineMs: RUN_DEADLINE_MS });
}

/** Host UI entry point: run a registered surface's runner in its sandbox. */
export function runPluginSurface(
  ctx: KernelHostContext,
  surfaceId: string,
  context: unknown,
): Promise<unknown> {
  return ctx.session.call('surfaces.run', { surfaceId, context }, { deadlineMs: RUN_DEADLINE_MS });
}
