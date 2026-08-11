import '@testing-library/jest-dom/vitest';

// jsdom does not implement ResizeObserver; Radix components that measure
// their content at render time (via @radix-ui/react-use-size) require it.
// A no-op stub is enough: consumers seed the size from offsetWidth/Height.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom does not implement matchMedia; theme application probes
// (prefers-reduced-motion etc.) through it.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}
