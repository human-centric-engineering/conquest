'use client';

/**
 * usePrefersReducedMotion — tracks the `(prefers-reduced-motion: reduce)` media query.
 *
 * Tailwind's `motion-reduce:` variant covers CSS transitions/animations, but some motion is driven
 * imperatively in JS (e.g. a scroll-container `scrollTop` animation, where `behavior: 'smooth'` has
 * no CSS hook) — those need to read the preference at call time. This hook exposes it reactively.
 *
 * SSR-safe: returns `false` on the server and before mount, then syncs on the client and updates if
 * the user changes the OS setting mid-session.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
