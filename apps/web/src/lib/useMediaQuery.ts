import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. SSR-safe: returns `false` when there is no
 * `window` (server render), then reconciles on the client effect. The query
 * string change re-subscribes; the listener is removed on unmount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
