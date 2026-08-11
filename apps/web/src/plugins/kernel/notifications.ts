/**
 * Kernel slice: notifications (rev4 §A3 `api.notifications`).
 *
 * Kernel-port path for `api.notify` / `api.notifications.dismiss`: the host
 * validates the payload against the same bounds as the v2 CustomEvent path
 * (PluginRuntimeUi `normalizeNotification`) and re-emits the identical
 * `neotavern-plugin-notification` / `neotavern-plugin-notification-dismiss` events, so the
 * render layer stays single-sourced.
 */
import { kernel } from '@neotavern/plugin-sdk';

import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const MAX_REGISTRATION_ID = 200;
const VARIANTS = ['info', 'success', 'warning', 'error'];

function paramsRecord(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
      details: { method, reason: 'params-object-required' },
    });
  }
  return params as Record<string, unknown>;
}

export function attachNotifications(ctx: KernelHostContext): void {
  ctx.session.handle('notifications.show', ({ params }) => {
    const method = 'notifications.show';
    if (!ctx.hasCapability('notifications.show')) {
      throw new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { method } });
    }
    const record = paramsRecord(params, method);
    const title = record['title'];
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) {
      throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
        details: { method, field: 'title' },
      });
    }
    const rawDescription = record['description'];
    const description =
      typeof rawDescription === 'string' && rawDescription.length <= MAX_DESCRIPTION
        ? rawDescription
        : undefined;
    const rawVariant = record['variant'];
    const variant =
      typeof rawVariant === 'string' && VARIANTS.includes(rawVariant) ? rawVariant : 'info';
    const rawTimeout = record['timeoutMs'];
    const timeoutMs =
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
        ? Math.max(2000, Math.min(30_000, rawTimeout))
        : undefined;
    const detail: Record<string, unknown> = {
      pluginId: ctx.pluginId,
      notification: { title, description, variant, timeoutMs },
    };
    const registrationId = record['registrationId'];
    if (
      typeof registrationId === 'string' &&
      registrationId.length > 0 &&
      registrationId.length <= MAX_REGISTRATION_ID
    ) {
      detail['registrationId'] = registrationId;
    }
    window.dispatchEvent(new CustomEvent('neotavern-plugin-notification', { detail }));
    return {};
  });

  ctx.session.handle('notifications.dismiss', ({ params }) => {
    const method = 'notifications.dismiss';
    const record = paramsRecord(params, method);
    const registrationId = record['registrationId'];
    if (
      typeof registrationId !== 'string' ||
      registrationId.length === 0 ||
      registrationId.length > MAX_REGISTRATION_ID
    ) {
      throw new KernelError(KernelErrorCode.VALIDATION_FAILED, {
        details: { method, field: 'registrationId' },
      });
    }
    window.dispatchEvent(
      new CustomEvent('neotavern-plugin-notification-dismiss', { detail: { registrationId } }),
    );
    return {};
  });
}
