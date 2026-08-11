import { useLayoutEffect, useState } from 'react';
import { readTokenMs } from './readTokenMs.js';

const TOKEN = '--st-scrollbar-hide-delay';
const FALLBACK_MS = 1000;

/** Radix ScrollArea hide delay driven by the theme token `scrollbar-hide-delay`. */
export function useScrollbarHideDelay(): number {
  const [delay, setDelay] = useState(() => readTokenMs(TOKEN, FALLBACK_MS));

  useLayoutEffect(() => {
    const root = document.documentElement;
    const sync = (): void => setDelay(readTokenMs(TOKEN, FALLBACK_MS));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['style', 'data-theme-mode', 'data-ui-motion'],
    });
    return () => observer.disconnect();
  }, []);

  return delay;
}
