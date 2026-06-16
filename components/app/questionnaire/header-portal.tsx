'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders its children into the admin header's `#admin-header-slot` (defined in
 * `components/admin/admin-header.tsx`), beside the theme toggle.
 *
 * The header is a sibling of the page content — both are rendered by
 * `app/admin/layout.tsx` — so a page can't reach it through props. This portal
 * bridges that gap (sibling pattern to `BreadcrumbLabel`), letting a route
 * subtree place a brand mark in the header without consuming page vertical
 * space and without the platform header importing app code.
 *
 * Resolves the target on mount, so it renders nothing on the server and on the
 * first client frame; if the slot is absent (non-admin shell) it stays inert.
 */
export function HeaderPortal({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById('admin-header-slot'));
  }, []);

  return slot ? createPortal(children, slot) : null;
}
