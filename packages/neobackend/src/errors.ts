/**
 * The one error a host without a capability throws (ТЗ §13.1).
 *
 * The kernel plane throws it for host-only surfaces (`hostSurfaces.ts`) and a page
 * with no host throws it for every call. It lives in its own module so a backend
 * rewrite can never take the error class with it.
 */
export class UnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const;
  /** The wire surface (or host surface id) that is unavailable. */
  readonly feature: string;

  constructor(feature: string) {
    super(`Feature not supported by this host: ${feature}`);
    this.name = 'UnsupportedError';
    this.feature = feature;
  }
}
