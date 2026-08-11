import { PuzzlePiece, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '@neotavern/ui';
import { randomToken } from '@neotavern/shared';
import {
  frontendPluginRuntime,
  usePluginRegistrations,
  type PluginUiRegistration,
} from '../plugins/runtime.js';
import styles from './PluginRuntimeUi.module.css';

interface RuntimeNotification {
  id: string;
  pluginId: string;
  title: string;
  description?: string;
  variant: 'info' | 'success' | 'warning' | 'error';
  timeoutMs: number;
  /**
   * Optional action button rendered under the description. Clicking it
   * dispatches `action.event` (with the whole notification as detail) and
   * dismisses the notice — used by host checkpoint/branch snapshots.
   */
  action?: { label: string; event: string };
  /** Opaque payload carried through the action event (e.g. a child chat id). */
  chatId?: string;
}

export function PluginRuntimeUi() {
  const { t } = useTranslation();
  const hotkeys = usePluginRegistrations('hotkeys');
  const [notifications, setNotifications] = useState<RuntimeNotification[]>([]);
  const [activeDialog, setActiveDialog] = useState<PluginUiRegistration | null>(null);
  const [dialogHost, setDialogHost] = useState<HTMLDivElement | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const dismissTimers = useRef(new Map<string, number>());
  // rev4 §G7: host overlay chrome — plugin-name indicator + close for the
  // live 'full' overlay. Rendered by the host so a plugin can never cover
  // or fake it (it lives in the host DOM above every plugin layer).
  const overlayChrome = useSyncExternalStore(
    frontendPluginRuntime.subscribeOverlayChrome,
    frontendPluginRuntime.getOverlayChrome,
    frontendPluginRuntime.getOverlayChrome,
  );
  const chromeReturnFocus = useRef<HTMLElement | null>(null);

  const dismissNotification = (id: string): void => {
    const timer = dismissTimers.current.get(id);
    if (timer) clearTimeout(timer);
    dismissTimers.current.delete(id);
    setNotifications((current) => current.filter((item) => item.id !== id));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || isEditableTarget(event.target)) return;
      // The newest active registration wins a collision so an updated/reloaded
      // plugin is not shadowed by an older registration using the same combo.
      const action = hotkeys.findLast((item) => matchesHotkey(item.definition.combo, event));
      if (!action) return;
      event.preventDefault();
      void frontendPluginRuntime.invoke(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys]);

  useEffect(() => {
    const onNotification = (event: Event): void => {
      const detail = (event as CustomEvent).detail as {
        pluginId?: unknown;
        registrationId?: unknown;
        notification?: unknown;
      };
      const notification = normalizeNotification(
        detail.pluginId,
        detail.registrationId,
        detail.notification,
      );
      if (!notification) return;
      setNotifications((current) => [...current.slice(-4), notification]);
      const timer = window.setTimeout(
        () => dismissNotification(notification.id),
        notification.timeoutMs,
      );
      dismissTimers.current.set(notification.id, timer);
    };
    // SDK contract (PLUG-55): the cleanup returned by notify() dismisses the
    // notification early through this channel.
    const onDismiss = (event: Event): void => {
      const registrationId = (event as CustomEvent).detail?.registrationId;
      if (typeof registrationId === 'string') dismissNotification(registrationId);
    };
    window.addEventListener('neotavern-plugin-notification', onNotification);
    window.addEventListener('neotavern-plugin-notification-dismiss', onDismiss);
    return () => {
      window.removeEventListener('neotavern-plugin-notification', onNotification);
      window.removeEventListener('neotavern-plugin-notification-dismiss', onDismiss);
    };
  }, []);

  // rev4 §M3: a sandbox stopped answering heartbeats. The host restarts it
  // under the restart budget or disables it on crash-loop; either way the
  // user sees a host-owned (not plugin-owned) notification so the teardown
  // of the crashed frame cannot sweep the warning away.
  useEffect(() => {
    const onCrash = (event: Event): void => {
      const detail = (event as CustomEvent).detail as {
        pluginName?: unknown;
        disabled?: unknown;
        restartBudgetLeft?: unknown;
      };
      const pluginName = typeof detail.pluginName === 'string' ? detail.pluginName : 'plugin';
      const disabled = detail.disabled === true;
      const budgetLeft =
        typeof detail.restartBudgetLeft === 'number' ? detail.restartBudgetLeft : 0;
      const notification: RuntimeNotification = {
        id: `host-crash-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        pluginId: 'host',
        title: t(disabled ? 'plugins:pluginCrashLoopDisabled' : 'plugins:pluginCrashed', {
          plugin: pluginName,
        }),
        description: disabled
          ? undefined
          : t('plugins:pluginCrashedRestart', { count: String(budgetLeft) }),
        variant: 'error',
        timeoutMs: 12_000,
      };
      setNotifications((current) => [...current.slice(-4), notification]);
      const timer = window.setTimeout(
        () => dismissNotification(notification.id),
        notification.timeoutMs,
      );
      dismissTimers.current.set(notification.id, timer);
    };
    window.addEventListener('neotavern-plugin-crash', onCrash);
    return () => window.removeEventListener('neotavern-plugin-crash', onCrash);
  }, [t]);

  // When a plugin is deactivated/uninstalled, everything it left on screen —
  // notifications, open dialog — goes with it (ТЗ §7.2 cleanup guarantee).
  useEffect(() => {
    const onRemoved = (event: Event): void => {
      const pluginId = (event as CustomEvent).detail?.pluginId;
      if (typeof pluginId !== 'string') return;
      setNotifications((current) => {
        for (const item of current) {
          if (item.pluginId === pluginId) {
            const timer = dismissTimers.current.get(item.id);
            if (timer) clearTimeout(timer);
            dismissTimers.current.delete(item.id);
          }
        }
        return current.filter((item) => item.pluginId !== pluginId);
      });
      setActiveDialog((dialog) => (dialog?.pluginId === pluginId ? null : dialog));
    };
    window.addEventListener('neotavern-plugin-removed', onRemoved);
    return () => window.removeEventListener('neotavern-plugin-removed', onRemoved);
  }, []);

  // Clear pending auto-dismiss timers on unmount (no setState after death).
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const openDialog = (event: Event): void => {
      const registration = (event as CustomEvent).detail as PluginUiRegistration | undefined;
      if (registration?.kind === 'dialogs') {
        dialogReturnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setActiveDialog(registration);
      }
    };
    window.addEventListener('neotavern-open-plugin-dialog', openDialog);
    return () => window.removeEventListener('neotavern-open-plugin-dialog', openDialog);
  }, []);

  useEffect(() => {
    if (!activeDialog || !dialogHost) return;
    return frontendPluginRuntime.mountPage(activeDialog, dialogHost);
  }, [activeDialog, dialogHost]);

  // rev4 §G7: while a 'full' overlay is live the host (1) remembers focus,
  // (2) makes the app background inert so keyboard/pointer stay out of the
  // background, (3) closes the overlay on Escape. Focus restore happens on
  // cleanup so both the close button and Escape restore it.
  useEffect(() => {
    if (!overlayChrome.active) return;
    chromeReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.querySelectorAll(
      '[data-component="main-area"], [data-component="navigation-rail"], [data-component="navigation-panel"], [data-component="legacy-island-layer"], [data-slot="status.area"]',
    );
    const previousInert = new Map<Element, boolean>();
    background.forEach((element) => {
      const host = element as HTMLElement;
      previousInert.set(element, host.inert);
      host.inert = true;
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      frontendPluginRuntime.closeFullOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      background.forEach((element) => {
        (element as HTMLElement).inert = previousInert.get(element) ?? false;
      });
      const returnFocus = chromeReturnFocus.current;
      chromeReturnFocus.current = null;
      queueMicrotask(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      });
    };
  }, [overlayChrome.active]);

  if (notifications.length === 0 && !activeDialog && !overlayChrome.active) return null;
  return (
    <>
      {overlayChrome.active ? (
        <aside
          className={styles.chrome}
          data-component="plugin-overlay-chrome"
          data-plugin-id={overlayChrome.pluginId}
          role="status"
        >
          <span className={styles.chromeLabel} data-part="overlay-chrome-label">
            {t('plugins:overlayActiveLabel', { plugin: overlayChrome.pluginName })}
          </span>
          <button
            type="button"
            className={styles.chromeClose}
            data-part="overlay-chrome-close"
            aria-label={t('plugins:closeOverlay')}
            title={t('plugins:closeOverlay')}
            onClick={() => frontendPluginRuntime.closeFullOverlay()}
          >
            <X aria-hidden="true" />
          </button>
        </aside>
      ) : null}
      {notifications.length > 0 ? (
        <section
          className={styles.layer}
          data-component="plugin-notification-layer"
          data-slot="notification.layer"
          aria-label={t('plugins:notifications')}
        >
          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={styles.notice}
              data-state={notification.variant}
              role={notification.variant === 'error' ? 'alert' : 'status'}
            >
              <PuzzlePiece aria-hidden="true" />
              <div>
                <strong>{notification.title}</strong>
                {notification.description ? <p>{notification.description}</p> : null}
                {notification.action ? (
                  <button
                    type="button"
                    className={styles.noticeAction}
                    data-part="notification-action"
                    onClick={() => {
                      // The action event carries the whole notification as
                      // detail so listeners can read opaque payload fields
                      // (e.g. `chatId` for host checkpoint navigation).
                      const action = notification.action;
                      if (!action) return;
                      window.dispatchEvent(
                        new CustomEvent(action.event, {
                          detail: notification,
                        }),
                      );
                      dismissNotification(notification.id);
                    }}
                  >
                    {notification.action.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={t('plugins:dismissNotification', { title: notification.title })}
                onClick={() => dismissNotification(notification.id)}
              >
                <X aria-hidden="true" />
              </button>
            </article>
          ))}
        </section>
      ) : null}
      <Dialog
        open={Boolean(activeDialog)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog(null);
            const returnFocus = dialogReturnFocus.current;
            dialogReturnFocus.current = null;
            queueMicrotask(() => {
              if (returnFocus?.isConnected) returnFocus.focus();
            });
          }
        }}
      >
        {activeDialog ? (
          <DialogContent
            title={activeDialog.definition.title}
            description={
              activeDialog.definition.description ??
              t('plugins:dialogFrom', { name: activeDialog.pluginName })
            }
          >
            <div ref={setDialogHost} className={styles.dialogHost} data-component="plugin-dialog" />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function normalizeNotification(
  pluginId: unknown,
  registrationId: unknown,
  value: unknown,
): RuntimeNotification | null {
  if (
    typeof pluginId !== 'string' ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const notification = value as Record<string, unknown>;
  if (typeof notification['title'] !== 'string' || notification['title'].length > 200) return null;
  const description =
    typeof notification['description'] === 'string' && notification['description'].length <= 1000
      ? notification['description']
      : undefined;
  const variant = ['info', 'success', 'warning', 'error'].includes(String(notification['variant']))
    ? (notification['variant'] as RuntimeNotification['variant'])
    : 'info';
  const requestedTimeout = notification['timeoutMs'];
  const timeoutMs =
    typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
      ? Math.max(2000, Math.min(30_000, requestedTimeout))
      : 6000;
  // Optional action: { label ≤ 60, event matching /^[a-z][a-z0-9-]*$/ ≤ 100 }.
  const actionValue = notification['action'];
  let action: RuntimeNotification['action'];
  if (typeof actionValue === 'object' && actionValue !== null && !Array.isArray(actionValue)) {
    const actionRecord = actionValue as Record<string, unknown>;
    const label = actionRecord['label'];
    const eventName = actionRecord['event'];
    if (
      typeof label === 'string' &&
      label.length > 0 &&
      label.length <= 60 &&
      typeof eventName === 'string' &&
      eventName.length > 0 &&
      eventName.length <= 100 &&
      /^[a-z][a-z0-9-]*$/u.test(eventName)
    ) {
      action = { label, event: eventName };
    }
  }
  const chatIdValue = notification['chatId'];
  const chatId =
    typeof chatIdValue === 'string' && chatIdValue.length > 0 && chatIdValue.length <= 200
      ? chatIdValue
      : undefined;
  return {
    // The host-assigned registration id IS the dismissal handle (PLUG-55);
    // a CSPRNG token covers the no-id legacy path instead of Math.random.
    id:
      typeof registrationId === 'string' && registrationId.startsWith(`${pluginId}:`)
        ? registrationId
        : `${pluginId}:notification:${randomToken(8)}`,
    pluginId,
    title: notification['title'],
    description,
    variant,
    timeoutMs,
    ...(action ? { action } : {}),
    ...(chatId ? { chatId } : {}),
  };
}

function matchesHotkey(combo: string | undefined, event: KeyboardEvent): boolean {
  if (!combo) return false;
  const parts = combo.toLowerCase().split('+');
  const key = parts.at(-1);
  const mod = navigator.platform.toLowerCase().includes('mac') ? event.metaKey : event.ctrlKey;
  return (
    key === event.key.toLowerCase() &&
    event.altKey === parts.includes('alt') &&
    event.shiftKey === parts.includes('shift') &&
    mod === parts.includes('mod')
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
