'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { classifySurface } from '@/lib/app/surface';

/**
 * Keeps `<html data-surface>` in sync with the current route on client-side
 * navigation.
 *
 * The root layout sets the attribute once from the proxy's `x-surface` header —
 * correct on a hard load and for first-paint portal theming. But the root
 * `<html>` persists across App Router navigations (the root layout does not
 * re-render), so without this the attribute would stay stuck at whatever the
 * first-loaded page was — e.g. a consumer page's ConQuest theme bleeding into
 * `/admin`. This re-derives the surface from the pathname after each navigation
 * and updates the attribute. Renders nothing.
 */
export function SurfaceSync(): null {
  const pathname = usePathname();

  useEffect(() => {
    document.documentElement.dataset.surface = classifySurface(pathname);
  }, [pathname]);

  return null;
}
