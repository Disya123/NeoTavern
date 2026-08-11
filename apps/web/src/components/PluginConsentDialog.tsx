/**
 * rev4 §B2 consent dialog: asks the user to grant a capability a sandboxed
 * plugin requested at runtime. One dialog per plugin at a time; Allow POSTs
 * the grant to the server, Deny (or Esc) rejects the plugin request with
 * `CAPABILITY_DENIED`. The dialog is host-owned: plugins cannot style it,
 * only observe the outcome through `capabilities.request`.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent } from '@neotavern/ui';
import { frontendPluginRuntime, type PendingConsent } from '../plugins/runtime.js';

function consentScopeLabel(scope: unknown): string {
  try {
    const serialized = JSON.stringify(scope);
    if (serialized === undefined) return '';
    return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
  } catch {
    return '';
  }
}

export function PluginConsentDialog() {
  const { t } = useTranslation();
  const pending: readonly PendingConsent[] = useSyncExternalStore(
    frontendPluginRuntime.consentSubscribe,
    frontendPluginRuntime.consentGetSnapshot,
    frontendPluginRuntime.consentGetSnapshot,
  );
  const current = pending[0] ?? null;
  const scopeText = current ? consentScopeLabel(current.request.scope) : '';
  const modalLayer = useMemo(
    () => {
      // System surfaces (plugins manager, settings, …) portal their own
      // layer slot into the body after the app shell slot; dialogs opened
      // above them must target the LAST slot to sit above the surface's
      // overlay.
      const slots = document.querySelectorAll<HTMLElement>('[data-slot="modal.layer"]');
      return slots[slots.length - 1] ?? null;
    },
    // The layers are stable static slots in the app shell; one lookup per
    // dialog session is enough.
    [current === null],
  );

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && current) frontendPluginRuntime.resolveConsent(current.pluginId, false);
      }}
    >
      {current ? (
        <DialogContent
          title={t('plugins:consentTitle')}
          description={t('plugins:consentDescription', {
            name: current.pluginName,
            capability: current.request.name,
          })}
          container={modalLayer}
        >
          <div
            data-component="plugin-consent-dialog"
            data-capability={current.request.name}
            data-plugin={current.pluginId}
          >
            {scopeText ? (
              <p data-part="scope" data-role="consent-scope">
                {t('plugins:consentScopeLabel')}: <code>{scopeText}</code>
              </p>
            ) : null}
            <div data-part="actions" data-role="consent-actions">
              <Button
                variant="ghost"
                data-part="deny"
                onClick={() => frontendPluginRuntime.resolveConsent(current.pluginId, false)}
              >
                {t('plugins:consentDeny')}
              </Button>
              <Button
                variant="primary"
                data-part="allow"
                onClick={() => frontendPluginRuntime.resolveConsent(current.pluginId, true)}
              >
                {t('plugins:consentAllow')}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
