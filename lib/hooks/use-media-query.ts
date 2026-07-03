'use client';

import { useEffect, useState } from 'react';

/**
 * useMediaQuery — subscribe to a CSS media query and re-render on match changes.
 *
 * SSR-safe: returns `false` on the server and the first client render (so markup
 * matches and hydration doesn't warn), then updates to the real value after
 * mount. Prefer Tailwind responsive classes for pure show/hide; reach for this
 * only when a *value* (not styling) must vary by breakpoint — e.g. choosing a
 * shorter input placeholder on small screens.
 *
 * @example
 * const isMobile = useMediaQuery('(max-width: 639px)'); // below Tailwind `sm`
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
