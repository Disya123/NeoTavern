/**
 * The backend a page gets when it has no host at all: no Tauri shell, no mobile
 * bridge, no saved remote session.
 *
 * It is not an error to *construct* it — the UI must render and explain the
 * state instead of throwing during module import. Every property is a closed
 * node, and every call rejects with `UnsupportedError` naming the surface it
 * asked for, so the failure is typed and points at the missing host rather than
 * at a legacy route that no longer exists.
 *
 * Nodes are memoized per path: `backend.characters` must be the same object on
 * every access, otherwise a test (or a caller) that patches one method would
 * patch an instance nobody calls.
 */
import { UnsupportedError } from './errors.js';
import type { NeoBackend } from './neobackend.js';

/** Default reason recorded in the thrown `UnsupportedError`. */
export const NO_HOST_REASON = 'no-host' as const;

/**
 * Brand on every closed node, so a proxy layer can tell "a method of a closed
 * backend" from "a real method that needs binding" instead of calling `.bind`
 * and turning the error into `…:chats.bind`.
 */
export const CLOSED_NODE = Symbol.for('neotavern.closed-node');

function buildClosedNode(root: string, path: string, cache: Map<string, unknown>): unknown {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  const feature = () => (path.length === 0 ? root : `${root}:${path}`);
  const target = function closedBackendNode(): void {
    /* never called: `apply` rejects */
  };
  const node = new Proxy(target, {
    get(target, prop) {
      // Keep the node from looking like a promise to `await`/`Promise.resolve`.
      if (prop === 'then') return undefined;
      if (prop === CLOSED_NODE) return true;
      if (typeof prop === 'symbol') return undefined;
      // Materialize the child as an own, writable property. `vi.spyOn` (and any
      // caller that patches a method) needs a real property to replace; a trap
      // that answers with a fresh object on every access would hand the patch to
      // an instance nobody calls.
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      if (own) return own.value;
      const next = path.length === 0 ? String(prop) : `${path}.${prop}`;
      const child = buildClosedNode(root, next, cache);
      Object.defineProperty(target, prop, {
        value: child,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      return child;
    },
    // `vi.spyOn` (and `Object.defineProperty`-based patching in general) asks for
    // the descriptor before replacing a method; answer with the materialized node
    // instead of `undefined`, or every patch is refused with "property is not
    // defined on the function".
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'then' || prop === CLOSED_NODE || typeof prop === 'symbol') return undefined;
      const t = target as unknown as Record<string | symbol, unknown>;
      if (!(prop in t)) {
        const next = path.length === 0 ? String(prop) : `${path}.${prop}`;
        Object.defineProperty(t, prop, {
          value: buildClosedNode(root, next, cache),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return { value: t[prop], configurable: true, enumerable: true, writable: true };
    },
    apply() {
      // Rejected promise, not a throw: the facade is async, and a caller that
      // forgot `await` still gets a typed error instead of an unhandled throw at
      // property-access time.
      return Promise.reject(new UnsupportedError(feature()));
    },
    construct() {
      throw new UnsupportedError(feature());
    },
  });
  cache.set(path, node);
  return node;
}

/**
 * Build the closed backend. `reason` prefixes the error feature string, e.g.
 * `no-host:chats.get`.
 */
export function createClosedBackend(reason: string = NO_HOST_REASON): NeoBackend {
  return buildClosedNode(reason, '', new Map()) as NeoBackend;
}
