/**
 * Rev4 kernel host wiring: builds the KernelHostContext for one sandbox
 * session and lets every per-slice module register its RPC handlers.
 *
 * Each slice module owns its section of the contract
 * (local://rev4-contract.md §2) and registers `session.handle(...)` methods
 * with capability checks first. Handlers die with the session —
 * `KernelSession.dispose()` clears them on frame reset.
 */
import type { kernel } from '@neotavern/plugin-sdk';
import type { FrontendPluginRuntime, RuntimeFrame } from '../runtime.js';
import type { KernelHostContext } from './types.js';
import { attachStorage } from './storage.js';
import { attachBackend } from './backend.js';
import { attachCommands } from './commands.js';
import { attachOverlays } from './overlays.js';
import { attachChat } from './chat.js';
import { attachBlocks } from './blocks.js';
import { attachJobs } from './jobs.js';
import { attachCapabilities } from './capabilities.js';
import { attachDiagnostics } from './diagnostics.js';
import { attachAuth } from './auth.js';
import { attachServices } from './services.js';
import { attachNotifications } from './notifications.js';
import { attachEvents } from './events.js';
import { attachWorkers } from './workers.js';
import { attachWindows } from './windows.js';
import { attachModels } from './models.js';

export type { KernelHostContext } from './types.js';

export function attachKernelServices(
  runtime: FrontendPluginRuntime,
  frame: RuntimeFrame,
  session: kernel.KernelSession,
): void {
  const ctx: KernelHostContext = {
    pluginId: frame.plugin.id,
    frame,
    session,
    runtime,
    hasCapability: (name, scope) => runtime.kernelHasCapability(frame, name, scope),
    currentChatId: () => runtime.getCurrentChatId(),
    currentProviderId: () => runtime.getActiveProviderConfigId(),
  };
  attachStorage(ctx);
  attachBackend(ctx);
  attachCommands(ctx);
  attachOverlays(ctx);
  attachChat(ctx);
  attachBlocks(ctx);
  attachJobs(ctx);
  attachCapabilities(ctx);
  attachDiagnostics(ctx);
  attachAuth(ctx);
  attachServices(ctx);
  attachNotifications(ctx);
  attachEvents(ctx);
  attachWorkers(ctx);
  attachWindows(ctx);
  attachModels(ctx);
}
