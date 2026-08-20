/**
 * Tests: lib/app/surface.ts
 *
 * `classifySurface` is the single predicate shared by proxy.ts (server, sets
 * `x-surface`) and SurfaceSync (client, keeps `<html data-surface>` synced). It
 * must agree with itself across both, so the behaviour is pinned here.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — these cases assert the SHIPPED classifier, and you are expected
 * to change it
 * ---------------------------------------------------------------------------
 * `lib/app/surface.ts` is the one seam that ships real logic rather than an
 * empty value, so "registers nothing" is not its contract and it has no row in
 * `SEAM_DEFAULTS`. This file is its contract instead — which means adding a
 * third surface, or moving your admin area off `/admin`, is expected to fail
 * cases here. Adjust them to match your classifier rather than deleting them:
 * the property worth keeping is that server and client agree, and that is what
 * these assertions are for.
 *
 * @see lib/app/surface.ts · .context/ui/surface-theming.md
 */

import { describe, it, expect } from 'vitest';

import { classifySurface } from '@/lib/app/surface';
describe('classifySurface', () => {
  it('classifies /admin and its descendants as admin', () => {
    expect(classifySurface('/admin')).toBe('admin');
    expect(classifySurface('/admin/')).toBe('admin');
    expect(classifySurface('/admin/users')).toBe('admin');
    expect(classifySurface('/admin/orchestration/agents/123/edit')).toBe('admin');
  });

  it('classifies everything else as consumer', () => {
    expect(classifySurface('/')).toBe('consumer');
    expect(classifySurface('/login')).toBe('consumer');
    expect(classifySurface('/signup')).toBe('consumer');
    expect(classifySurface('/dashboard')).toBe('consumer');
    expect(classifySurface('/settings')).toBe('consumer');
  });

  it('does NOT match a /admin-prefixed sibling (e.g. /administrators)', () => {
    expect(classifySurface('/administrators')).toBe('consumer');
    expect(classifySurface('/admin-tools')).toBe('consumer');
  });
});
