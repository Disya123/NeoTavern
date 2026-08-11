/**
 * Kernel slice: plugin self-diagnostics (rev4 §C).
 *
 * `diagnostics.get` returns a read-only snapshot of the plugin's own runtime
 * state — protocol/sdk versions, sandbox instance, limits, host feature
 * registry and active grants. The host builds it from public registry fields
 * only, so it never leaks secrets or another plugin's state. Like
 * `capabilities.list`, it requires an active session but no extra capability:
 * the data is the plugin's own.
 */
import type { KernelHostContext } from './types.js';

export function attachDiagnostics(ctx: KernelHostContext): void {
  ctx.session.handle('diagnostics.get', () => {
    return { snapshot: ctx.runtime.kernelDiagnosticsSnapshot(ctx.frame) };
  });
}
