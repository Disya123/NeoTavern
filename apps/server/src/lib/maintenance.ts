/**
 * Global maintenance lock (ТЗ §10.4, Wave 1 «maintenance lock для restore»).
 *
 * Restore must run under an exclusive global maintenance mode: while it is
 * held, new product mutations are rejected with the stable `MAINTENANCE_MODE`
 * error and no second maintenance holder can enter. The lock is synchronous —
 * Node's single-threaded event loop makes check-and-set atomic, so restore
 * never observes a concurrent mutation slipping in between the check and the
 * set.
 *
 * Full stop-the-world semantics for the kernel plane (killing in-flight
 * generations, suspending background jobs, staged data-root activation) are
 * part of the M3 DATA-ACTIVATE slice; this controller is the legacy contour's
 * boundary guard.
 */
import { AppError, ErrorCodes } from '@neotavern/shared';

export class MaintenanceController {
  private active = false;

  /** True while global maintenance mode is held. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Enter global maintenance mode exclusively. Throws `MAINTENANCE_MODE` when
   * another holder is already inside. Returns the release function; the lock
   * is released exactly once (repeat releases are no-ops).
   */
  acquire(): () => void {
    if (this.active) {
      throw new AppError({
        code: ErrorCodes.MAINTENANCE_MODE,
        params: { reason: 'RESTORE_IN_PROGRESS' },
        message: 'another maintenance operation is already running',
      });
    }
    this.active = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = false;
    };
  }
}
