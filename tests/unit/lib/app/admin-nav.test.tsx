/**
 * Tests: `initAppNav()` alpha-gated nav entry.
 *
 * The "Session refs" item under Questionnaires is registered only while the product is in the alpha
 * release stage (`IS_ALPHA`). The stage is resolved at module load, so each case re-imports the nav
 * module with a fresh `release-stage` mock and inspects the real registry.
 *
 * FORK NOTE — this reads the REAL `lib/app/admin-nav.ts`, not a mock, so it
 * measures whatever ConQuest has registered there. If you add or rename a nav
 * entry, or change the alpha gate on "Session refs", these cases move with it
 * and are meant to: they are a pin on this fork's nav, not on Sunrise's empty
 * seam. Update the expectations rather than deleting the cases. A downstream
 * fork of ConQuest should expect to rewrite this file wholesale, or mock
 * `@/lib/app/admin-nav` and assert the registration mechanics instead.
 *
 * @see lib/app/admin-nav.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NavSection } from '@/lib/admin-nav/registry';

async function loadNav(isAlpha: boolean): Promise<NavSection[]> {
  vi.resetModules();
  vi.doMock('@/lib/app/release-stage', () => ({ IS_ALPHA: isAlpha }));
  const registry = await import('@/lib/admin-nav/registry');
  registry.__resetNavRegistryForTests();
  const { initAppNav } = await import('@/lib/app/admin-nav');
  initAppNav();
  return registry.getRegisteredNavSections();
}

function sessionRefsItem(sections: NavSection[]) {
  const questionnaires = sections.find((s) => s.title === 'Questionnaires');
  return questionnaires?.items?.find((i) => i.href === '/admin/questionnaires/sessions');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/release-stage');
});

describe('initAppNav — alpha session-ref entry', () => {
  it('registers the Sessions item in the alpha stage', async () => {
    const item = sessionRefsItem(await loadNav(true));
    expect(item).toBeDefined();
    expect(item?.label).toBe('Sessions');
  });

  it('omits the Sessions item outside the alpha stage', async () => {
    expect(sessionRefsItem(await loadNav(false))).toBeUndefined();
  });

  it('always registers the stable Questionnaires items regardless of stage', async () => {
    for (const isAlpha of [true, false]) {
      const sections = await loadNav(isAlpha);
      const hrefs = sections.find((s) => s.title === 'Questionnaires')?.items?.map((i) => i.href);
      expect(hrefs).toContain('/admin/questionnaires');
      // Turn evaluations is no longer a top-level menu item — it lives within a session (the drawer).
      expect(hrefs).not.toContain('/admin/questionnaires/turn-evaluations');
    }
  });
});
