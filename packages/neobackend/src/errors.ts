/**
 * The one error a host without a capability throws (ТЗ §13.1).
 *
 * It used to live in `legacyBackend.ts`. That class is on its way out with the
 * `/api/v2` contour, but the error itself is not legacy: the kernel plane throws
 * it for host-only surfaces (`hostSurfaces.ts`) and a page with no host will
 * throw it too. Keeping it in its own module means deleting a backend can never
 * take the error class with it again.
 */
export class UnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const;
  /** The wire surface (or `legacy.*` marker) that is unavailable. */
  readonly feature: string;

  constructor(feature: string) {
    super(`Feature not supported by the legacy backend: ${feature}`);
    this.name = 'UnsupportedError';
    this.feature = feature;
  }
}
