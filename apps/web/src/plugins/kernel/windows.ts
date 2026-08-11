/**
 * Rev4 kernel: windows.* host handlers (contract §J3).
 *
 * Multi-window semantics: the plugin's UI instance runs in every window that
 * activates it, but background work belongs to exactly one window per
 * installation. This slice exposes the host-elected background role:
 *
 * - `windows.role` → `{role, windowId, installationId, isBackground}` —
 *   `role` is `primary` (this window owns the background singleton),
 *   `secondary` (another window of the same installation owns it) or
 *   `standalone` (no BroadcastChannel; this window is its own primary);
 * - `windows.isBackground` → `{isBackground}` — convenience bool;
 * - role transitions arrive as host-generated `evt.emit`
 *   `window.background.changed` with the same snapshot payload (listen via
 *   `api.events.on`, no capability required — it is the plugin's own window
 *   state). A plugin that becomes primary must start its background
 *   consumers; a plugin that loses the role must stop them.
 *
 * The election itself lives in `WindowRoleManager` (BroadcastChannel claims
 * + lease expiry); this slice only bridges a session to it. The change
 * listener is tracked via the session scope, so a frame reset or session
 * dispose releases the window's claim and stops the manager when no other
 * session of the installation needs it (rev4 §0 invariant 6).
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

function failNoInstallation(): KernelError {
  return new KernelError(KernelErrorCode.VALIDATION_FAILED, {
    details: { reason: 'no-installation-id', method: 'windows.*' },
  });
}

export function attachWindows(ctx: KernelHostContext): void {
  const { session, runtime } = ctx;
  const installationId = ctx.frame.installationId;

  // Defensive: the handshake declares the installation id; without it the
  // slice still answers requests (with a stable error) but cannot join the
  // election — and must not throw at attach time, which would kill every
  // kernel slice of the frame.
  if (typeof installationId === 'string' && installationId.length > 0) {
    const pushRole = (): void => {
      try {
        session.emitEvent('window.background.changed', runtime.kernelWindowRole(installationId));
      } catch {
        // Session disposed mid-flight; the listener is gone with the scope.
      }
    };
    const unsubscribe = runtime.kernelWindowRoleOnChange(installationId, pushRole);
    session.scope.track({ dispose: unsubscribe });
  }

  session.handle('windows.role', () => {
    const id = ctx.frame.installationId;
    if (!id) throw failNoInstallation();
    return runtime.kernelWindowRole(id);
  });
  session.handle('windows.isBackground', () => {
    const id = ctx.frame.installationId;
    if (!id) throw failNoInstallation();
    return { isBackground: runtime.kernelWindowRole(id).isBackground };
  });
}
