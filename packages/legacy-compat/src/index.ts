/**
 * @neotavern/legacy-compat — compatibility layer for existing SillyTavern extensions:
 * documented window globals, the event bus, unmanaged DOM islands and the
 * `getContext()` surface.
 */
export * from './eventSource.js';
export * from './domIslands.js';
export * from './context.js';
export * from './registry.js';

// NOTE: `./globals.js` (which pulls in jQuery and touches `window`) is exposed
// as the `@neotavern/legacy-compat/globals` subpath, not the main barrel, so importing
// the core API in non-DOM environments (tests, SSR) stays side-effect free.
