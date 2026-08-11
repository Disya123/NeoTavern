/**
 * Rev4 kernel host context handed to every per-slice kernel module.
 *
 * The context is the ONLY sanctioned bridge between the kernel RPC layer
 * (apps/web/src/plugins/kernel/*) and the v2 runtime internals. Slices must
 * not reach into `FrontendPluginRuntime` privates beyond the methods exposed
 * here (rev4 §0 invariants 1–2).
 */
import type { kernel } from '@neotavern/plugin-sdk';
import type { FrontendPluginRuntime, RuntimeFrame } from '../runtime.js';

export interface KernelHostContext {
  readonly pluginId: string;
  readonly frame: RuntimeFrame;
  readonly session: kernel.KernelSession;
  readonly runtime: FrontendPluginRuntime;
  /** rev4 §B2: live capability check against the plugin's grants. */
  hasCapability(name: string, scope?: kernel.CapabilityRequest['scope']): boolean;
  /** Current focused chat id (null when no chat is open). */
  currentChatId(): string | null;
  /** Id of the active provider config (null when none is set). */
  currentProviderId(): string | null;
}
