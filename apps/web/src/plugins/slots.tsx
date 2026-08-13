/**
 * Declarative semantic UI slot host (ТЗ §53).
 *
 * Plugins contribute buttons to the five stable slot ids through the SDK's
 * `api.ui.slots` surface. Everything that crosses the plugin boundary is
 * re-validated here (the registry is the untrusted boundary): unknown slot
 * ids and malformed titles are dropped, denied permissions hide buttons,
 * `when()` gates visibility per render, and priority sorts the row. No
 * contribution or all-denied → `renderSlot` returns nothing and {@link
 * SlotHost} renders nothing, so hosts see zero layout change.
 *
 * Dispatch never executes plugin code in the main window: commands run
 * through the plugin's sandboxed command registration; events are emitted on
 * the shared event bus.
 */
import { useSyncExternalStore } from 'react';
import {
  type SlotAction,
  type SlotContribution,
  type SlotId,
  validateSlotContribution,
} from '@neotavern/plugin-sdk';
import { frontendPluginRuntime, usePluginRegistrations } from './runtime.js';
import styles from './slots.module.css';

export interface SlotEntry {
  pluginId: string;
  pluginName: string;
  /** Stable per-entry identity; React key and cleanup handle. */
  registrationId: string;
  /** Validated (normalized) contribution. */
  contribution: SlotContribution;
}

/** Plain, renderable descriptor returned by {@link SlotRegistry.renderSlot}. */
export interface SlotDescriptor {
  pluginId: string;
  pluginName: string;
  registrationId: string;
  title: string;
  action: SlotAction;
}

/** Permission check against the web host's grant store (v2 permissions). */
export type SlotPermissionCheck = (pluginId: string, permission: string) => boolean;

const DEFAULT_SLOT_PRIORITY = 100;

const defaultPermissionCheck: SlotPermissionCheck = (pluginId, permission) =>
  frontendPluginRuntime.hasPermission(pluginId, permission);

/**
 * Host-side slot registry. `register()` re-validates at the untrusted
 * boundary (see {@link validateSlotContribution}); invalid contributions are
 * rejected with `null` and a warning log.
 */
export class SlotRegistry {
  private readonly entries = new Map<string, SlotEntry>();
  private readonly listeners = new Set<() => void>();
  private snapshotValue: readonly SlotEntry[] = [];
  private sequence = 0;

  /**
   * Register a contribution. Returns a cleanup function, or `null` when the
   * contribution fails validation (untrusted input is dropped, never stored).
   */
  register(input: {
    pluginId: string;
    pluginName?: string;
    registrationId?: string;
    contribution: unknown;
  }): (() => void) | null {
    let contribution: SlotContribution;
    try {
      contribution = validateSlotContribution(input.contribution);
    } catch (error) {
      console.warn(
        `Slot contribution from ${input.pluginId} rejected`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
    const registrationId = input.registrationId ?? `${input.pluginId}:slots:${++this.sequence}`;
    this.entries.set(registrationId, {
      pluginId: input.pluginId,
      pluginName: input.pluginName ?? input.pluginId,
      registrationId,
      contribution,
    });
    this.publish();
    return () => {
      if (this.entries.delete(registrationId)) this.publish();
    };
  }

  unregister(registrationId: string): void {
    if (this.entries.delete(registrationId)) this.publish();
  }

  /**
   * Remove every entry belonging to one plugin (frame teardown — plugin
   * disable/uninstall must not leave slot buttons behind, ТЗ §7.2).
   */
  unregisterByPlugin(pluginId: string): void {
    let changed = false;
    for (const [registrationId, entry] of this.entries) {
      if (entry.pluginId === pluginId) {
        this.entries.delete(registrationId);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** All registered entries for a slot, unsorted. */
  list(slotId: SlotId): readonly SlotEntry[] {
    return this.snapshotValue.filter((entry) => entry.contribution.slot === slotId);
  }

  /**
   * Renderable descriptors for `slotId` in the given context: permission-
   * gated, `when()`-filtered, sorted by priority ascending (stable —
   * registrationId breaks ties). `hasPermission` defaults to the web host's
   * grant store.
   */
  renderSlot(
    slotId: SlotId,
    context: unknown,
    hasPermission: SlotPermissionCheck = defaultPermissionCheck,
  ): readonly SlotDescriptor[] {
    const visible: SlotEntry[] = [];
    for (const entry of this.list(slotId)) {
      const { contribution } = entry;
      if (
        contribution.permission !== undefined &&
        !hasPermission(entry.pluginId, contribution.permission)
      ) {
        continue;
      }
      if (contribution.when !== undefined) {
        try {
          if (contribution.when() === false) continue;
        } catch {
          // A failing plugin gate must never break the host UI; treat it as
          // hidden (same isolation policy as the interceptor chain).
          continue;
        }
      }
      visible.push(entry);
    }
    const priorityOf = (entry: SlotEntry): number =>
      entry.contribution.priority ?? DEFAULT_SLOT_PRIORITY;
    visible.sort(
      (left, right) =>
        priorityOf(left) - priorityOf(right) ||
        left.registrationId.localeCompare(right.registrationId),
    );
    return visible.map((entry) => ({
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      registrationId: entry.registrationId,
      title: entry.contribution.title,
      action: entry.contribution.action,
    }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly SlotEntry[] => this.snapshotValue;

  private publish(): void {
    this.snapshotValue = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}

/** App-wide slot registry instance. */
export const slotRegistry = new SlotRegistry();

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a sanitized sandbox registration definition (kind `slots`) to a slot
 * contribution. The sandbox channel serializes only the declarative fields —
 * `when` is a function and never crosses the boundary. Invalid shapes map to
 * `null` (dropped at the untrusted boundary, same policy as {@link
 * SlotRegistry.register}).
 */
export function slotsContributionFromDefinition(definition: unknown): SlotContribution | null {
  if (!isRecordLike(definition)) return null;
  const { slot, title, priority, permission, action } = definition;
  try {
    return validateSlotContribution({ slot, title, priority, permission, action });
  } catch {
    return null;
  }
}

/** Live entries for one slot (external store). */
export function useSlotContributions(slotId: SlotId): readonly SlotEntry[] {
  const entries = useSyncExternalStore(
    slotRegistry.subscribe,
    slotRegistry.getSnapshot,
    slotRegistry.getSnapshot,
  );
  return entries.filter((entry) => entry.contribution.slot === slotId);
}

export interface SlotHostProps {
  slot: SlotId;
  /** Opaque context forwarded to command dispatch and event payloads. */
  context?: unknown;
}

/**
 * Renders a slot's contributions as plain buttons. Titles are pre-validated
 * at registration and escaped by React; permission-gated and `when()`-hidden
 * contributions are filtered out, so no contribution (or all hidden) renders
 * nothing.
 */
export function SlotHost({ slot, context }: SlotHostProps) {
  // Subscribe to the registry store so new/removed contributions re-render.
  useSyncExternalStore(slotRegistry.subscribe, slotRegistry.getSnapshot, slotRegistry.getSnapshot);
  const items = slotRegistry.renderSlot(slot, context);
  const commands = usePluginRegistrations('commands');
  if (items.length === 0) return null;

  const dispatch = (item: SlotDescriptor): void => {
    const action = item.action;
    if (action.type === 'command') {
      const command = commands.find(
        (registration) =>
          registration.pluginId === item.pluginId &&
          registration.definition.id === action.commandId,
      );
      if (!command) {
        console.warn(
          `Slot ${slot}: plugin ${item.pluginName} contributed unknown command "${action.commandId}"`,
        );
        return;
      }
      void frontendPluginRuntime.invoke(command, context).catch((error: unknown) => {
        console.error(`Slot action ${item.pluginName}:${item.title} failed`, error);
      });
      return;
    }
    frontendPluginRuntime.emitEvent(action.event, context ?? {});
  };

  return (
    <div className={styles.slotRow} data-component="slot-host" data-slot={slot}>
      {items.map((item) => (
        <button
          key={item.registrationId}
          type="button"
          className={styles.button}
          data-slot-action={item.registrationId}
          title={`${item.pluginName}: ${item.title}`}
          aria-label={item.title}
          onClick={() => dispatch(item)}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
}
