/**
 * Account Sections
 *
 * Renders whatever a fork registered in `lib/app/account-sections.ts` at the
 * foot of `/profile` and `/settings`. Sunrise registers nothing, so this
 * renders `null` and the pages are byte-for-byte unchanged (#595).
 *
 * Not a `'use client'` component: it does nothing interactive, and staying on
 * the server lets a registered section be an async server component that
 * fetches its own data. A section that needs interactivity marks itself
 * `'use client'` — rendering a client component from here is ordinary.
 *
 * @see lib/account-sections/registry.ts
 */

import { getRegisteredAccountSections, type AccountSurface } from '@/lib/account-sections/registry';

interface AccountSectionsProps {
  /** Which page is rendering — a section may be registered for one or both. */
  surface: AccountSurface;
  /** The signed-in user, passed to every section. */
  userId: string;
}

export function AccountSections({ surface, userId }: AccountSectionsProps) {
  const sections = getRegisteredAccountSections(surface);
  if (sections.length === 0) return null;

  return (
    <>
      {sections.map(({ id, Component }) => (
        <Component key={id} userId={userId} />
      ))}
    </>
  );
}
